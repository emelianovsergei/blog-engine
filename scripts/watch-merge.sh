#!/usr/bin/env bash
#
# Poll a PR until the Codex reviewer has cleared the CURRENT head, then squash-merge it.
#
#   scripts/watch-merge.sh <owner/repo> <pr-number> [max-polls] [interval-seconds]
#
# Exit codes:
#   0  merged (verified by re-reading the PR, not by trusting the merge command)
#   3  Codex left findings on the current head — needs a human, nothing merged
#   4  timed out waiting for a review — nothing merged
#   5  PR is not in a mergeable state (closed, draft)
#   6  merge was attempted and did NOT take effect
#   7  merge outcome could not be verified (distinct from 6: unknown, not failed)
#   8  clean and green, but approval is not commit-bound — merge it yourself
#
# DESIGN NOTE — why the obvious version of this is broken
#
# The natural predicate, "the SHA in Codex's review body equals the PR head", is
# not merely imprecise: it is unsatisfiable exactly when the PR is fine. Codex
# only produces a review when it HAS suggestions. A clean pass posts nothing and
# swaps its reaction from 👀 to 👍. A SHA-matching watcher therefore fires only on
# rejection; on approval it spins to its timeout and reports the PR as still
# waiting while the PR sits approved and green.
#
# Every rule below exists because some "unknown" state was previously collapsed
# into a definite one. That collapse — treating "could not tell" as "fine" — is
# the bug family this repo's autoblog pipeline kept shipping, so this script
# fails CLOSED everywhere: any read it cannot complete ends the poll and retries,
# rather than feeding a default into the merge decision.

set -uo pipefail

REPO="${1:?usage: watch-merge.sh <owner/repo> <pr-number> [max-polls] [interval-seconds]}"
PR="${2:?usage: watch-merge.sh <owner/repo> <pr-number> [max-polls] [interval-seconds]}"
MAX_POLLS="${3:-24}"
INTERVAL="${4:-90}"

# Exact actor identity, never a substring. `test("codex";"i")` matches ANY login
# containing "codex", so on a public repo an unrelated account could add a 👍 and
# satisfy the approval predicate for a PR the real reviewer never looked at.
# The numeric account id is immutable and is what REST comparisons use; GraphQL
# reports the bot without its "[bot]" suffix, hence the bare form too.
BOT_ID="${WATCH_MERGE_BOT_ID:-199175422}"
BOT_LOGIN_BARE="${WATCH_MERGE_BOT_LOGIN:-chatgpt-codex-connector}"
say() { printf '%s\n' "$*"; }

# APPROVAL BINDING — why there is no timestamp heuristic here any more
#
# A clean Codex pass produces no review object; it only swaps its reaction to 👍.
# Reactions carry no SHA, so binding one to a commit means inferring "when did
# this SHA become the head" — and every available proxy leaks:
#
#   commit committer date   — a reset/fast-forward to an older or existing commit
#                             predates the push that made it the head
#   check-run starts        — absent in the window right after a reset, and a
#                             delayed matrix job or a manual re-run on an
#                             unchanged SHA pushes the cutoff PAST a valid 👍,
#                             so a correct approval is rejected forever
#   force-push events       — miss ordinary synchronize and fast-forward pushes
#
# Patching one proxy moved the hole to another, and the last two reports were in
# direct tension: tracking more activations makes false-rejection worse, and
# loosening it makes false-acceptance worse.
#
# So the script no longer infers activation. It WITNESSES it. Each poll records
# the head it sees; when the head changes, the clock restarts. A 👍 counts only
# if it arrived after this process saw the current head in place — which is
# SHA-bound by construction rather than by inference, and needs no GitHub
# timestamp at all.
#
# TWO DELIBERATE COSTS, both chosen so the script declines rather than guesses:
#
#   * A 👍 that predates the watcher is not trusted — nothing distinguishes it
#     from one earned by a previous head. WATCH_MERGE_TRUST_EXISTING=1 accepts a
#     pre-existing approval when you have checked it yourself.
#
#   * Bare 👍 approval is disabled for the rest of a run once the verdict can no
#     longer be attributed — either the head moved, or a review was already
#     running when the watch began. Only a commit-bound review object will do. A review can be queued against the old head and only show 👀
#     after the new head is observed, so no snapshot of the reactions can tell
#     the two apart. This is a limit of the signal, not of the implementation:
#     Codex emits no review object for a clean pass, so a clean verdict is
#     genuinely unattributable once more than one head is in play.
#
# In normal use — push, then start the watcher — the head does not move and
# neither cost applies.
TRUST_EXISTING="${WATCH_MERGE_TRUST_EXISTING:-0}"
# Off by default. A clean Codex pass emits no review object — only a 👍 — and a
# reaction carries no SHA, so there is NO observable fact tying a clean verdict
# to the head it judged. Five separate reports found five different routes to
# that same gap (head moved mid-watch; review in flight at start; review queued
# pre-watch whose 👀 appears later; review straddling a change; A->B->A between
# polls), and each timing rule that closed one opened another, because the
# missing information does not exist to be recovered.
#
# So the default is to require a review object, which carries commit_id and
# therefore proves which head was judged. A PR that is clean but has only a 👍
# exits 8: ready, but not machine-verifiable. Set WATCH_MERGE_TRUST_REACTION=1
# to accept bare reactions, understanding that it rests on timing rather than
# proof.
TRUST_REACTION="${WATCH_MERGE_TRUST_REACTION:-0}"
SEEN_HEAD=""
SEEN_SINCE=""
# Set when the head changes while a review is already in flight (👀 present).
# That review is about the OLD head, so the 👍 it eventually posts is a verdict
# on code that is no longer here and must not approve the new head.
STALE_VERDICT_PENDING=0
# 👀 as of the PREVIOUS poll. The head is read before the reactions are, so a
# review that finishes in between would already show 👀=0 by the time we look,
# and an in-flight review straddling a head change would go unnoticed.
PREV_EYES=0
# Set when a bare 👍 can no longer be attributed to a specific head. From then on
# only a review object, which carries commit_id, can approve. Two triggers:
#   * the head moved at any point during this watch
#   * a review was ALREADY in flight when the watch began — its verdict may
#     belong to a head that existed before we were looking
REACTION_UNTRUSTED=0
# Latest force-push seen so far. Compared against itself rather than against
# SEEN_SINCE: with WATCH_MERGE_TRUST_EXISTING the window starts at the epoch, so
# every historical force-push would look newer than it and a PR that had ever
# been force-pushed would be treated as having moved mid-watch — defeating the
# override it was asked to honour.
FORCE_BASELINE=""

for i in $(seq 1 "$MAX_POLLS"); do
  [ "$i" -gt 1 ] && sleep "$INTERVAL"

  # ---------------------------------------------------------------- READ PHASE
  # Every read happens before ANY state is mutated, and a failed read abandons
  # the poll without touching state. Mutating as we went meant a later read
  # failing could leave the head recorded but its transition unprocessed — the
  # next poll then saw "no change" and the pending stale verdict was lost.
  if ! PRJSON=$(gh pr view "$PR" --repo "$REPO" --json state,isDraft,headRefOid 2>/dev/null); then
    say "[poll $i] could not read PR; retrying"; continue
  fi
  STATE=$(printf '%s' "$PRJSON" | jq -r '.state')
  IS_DRAFT=$(printf '%s' "$PRJSON" | jq -r '.isDraft')
  HEAD=$(printf '%s' "$PRJSON" | jq -r '.headRefOid')
  # Stamped HERE, when the head was actually observed — not later in the
  # transition phase. Several API calls happen in between, and a clean review
  # completing during them would produce a 👍 older than a cutoff taken after
  # the fact. That 👍 would be rejected forever, and since a clean pass emits no
  # review object and no second verdict, the watcher would time out on a good PR.
  OBSERVED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  if [ -z "$STATE" ] || [ "$STATE" = "null" ] || [ -z "$HEAD" ] || [ "$HEAD" = "null" ]; then
    say "[poll $i] PR read came back incomplete; retrying"; continue
  fi

  case "$STATE" in
    MERGED) say "already merged — nothing to do"; exit 0 ;;
    OPEN)   ;;
    *)      say "PR is $STATE, not OPEN — refusing to act"; exit 5 ;;
  esac
  [ "$IS_DRAFT" = "true" ] && { say "PR is still a draft — mark it ready first"; exit 5; }

  if ! REVIEWED=$(gh api "repos/$REPO/pulls/$PR/reviews" --paginate \
      -q "[.[]|select(.user.id==$BOT_ID)|select(.commit_id==\"$HEAD\")]|length" 2>/dev/null); then
    say "[poll $i] could not read reviews; retrying"; continue
  fi
  REVIEWED=$(printf '%s\n' "$REVIEWED" | awk '{s+=$1} END {print s+0}')

  if ! REACTIONS=$(gh api "repos/$REPO/issues/$PR/reactions" --paginate 2>/dev/null); then
    say "[poll $i] could not read reactions; retrying"; continue
  fi
  APPROVE_TIME=$(printf '%s' "$REACTIONS" | jq -s -r "[.[][]|select(.user.id==$BOT_ID)|select(.content==\"+1\")|.created_at]|sort|last // empty" 2>/dev/null)
  if ! EYES=$(printf '%s' "$REACTIONS" | jq -s -r "[.[][]|select(.user.id==$BOT_ID)|select(.content==\"eyes\")]|length" 2>/dev/null); then
    say "[poll $i] could not evaluate reactions; retrying"; continue
  fi
  case "$EYES" in (*[!0-9]*|"") say "[poll $i] reaction count unreadable; retrying"; continue ;; esac

  if ! THREADS=$(gh api graphql --paginate -F owner="${REPO%%/*}" -F name="${REPO##*/}" -F pr="$PR" -f query='
        query($owner:String!,$name:String!,$pr:Int!,$endCursor:String){
          repository(owner:$owner,name:$name){
            pullRequest(number:$pr){
              reviewThreads(first:100, after:$endCursor){
                pageInfo{ hasNextPage endCursor }
                nodes{ isResolved isOutdated comments(first:1){ nodes{ author{ login } } } }
              }
            }
          }
        }' 2>/dev/null); then
    say "[poll $i] could not read review threads; retrying rather than assuming none"; continue
  fi
  if ! FINDINGS=$(printf '%s' "$THREADS" | jq -s -r --arg bot "$BOT_LOGIN_BARE" '
        [ .[].data.repository.pullRequest.reviewThreads.nodes[]
          | select(.comments.nodes[0].author.login == $bot)
          | select(.isResolved == false and .isOutdated == false) ] | length' 2>/dev/null); then
    say "[poll $i] could not evaluate review threads; retrying"; continue
  fi

  if ! FORCE_PUSHED=$(gh api graphql -F owner="${REPO%%/*}" -F name="${REPO##*/}" -F pr="$PR" -f query='
        query($owner:String!,$name:String!,$pr:Int!){
          repository(owner:$owner,name:$name){
            pullRequest(number:$pr){
              timelineItems(last:100, itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT]){
                nodes{ ... on HeadRefForcePushedEvent { createdAt } }
              }
            }
          }
        }' -q '[.data.repository.pullRequest.timelineItems.nodes[].createdAt]|sort|last // empty' 2>/dev/null); then
    say "[poll $i] could not read force-push history; retrying"; continue
  fi

  gh pr checks "$PR" --repo "$REPO" >/dev/null 2>&1; CHECKS_RC=$?

  # ---------------------------------------------------------- TRANSITION PHASE
  NOW="$OBSERVED_AT"
  FIRST_POLL=0; [ -z "$SEEN_HEAD" ] && FIRST_POLL=1

  HEAD_CHANGED=0
  [ "$FIRST_POLL" = "0" ] && [ "$HEAD" != "$SEEN_HEAD" ] && HEAD_CHANGED=1

  # A force-push newer than the window means the head moved between polls — the
  # A -> B -> A case, where both samples read A and the change is invisible.
  HIDDEN_CHANGE=0
  if [ "$FIRST_POLL" = "1" ]; then
    FORCE_BASELINE="$FORCE_PUSHED"          # history before the watch is not a change
  elif [ "$FORCE_PUSHED" != "$FORCE_BASELINE" ]; then
    HIDDEN_CHANGE=1
    FORCE_BASELINE="$FORCE_PUSHED"
  fi

  if [ "$FIRST_POLL" = "1" ]; then
    SEEN_SINCE="$NOW"
    [ "$TRUST_EXISTING" = "1" ] && SEEN_SINCE="1970-01-01T00:00:00Z"
    say "[poll $i] observing head ${HEAD:0:10} since $SEEN_SINCE"
  elif [ "$HEAD_CHANGED" = "1" ]; then
    SEEN_SINCE="$NOW"
    say "[poll $i] head changed to ${HEAD:0:10}; approval window restarted"
  elif [ "$HIDDEN_CHANGE" = "1" ]; then
    SEEN_SINCE="$FORCE_PUSHED"
    say "[poll $i] head moved between polls (force-push at $FORCE_PUSHED); approval window restarted"
  fi

  # A review already running when the head moved is reviewing the OLD head, so
  # the 👍 it posts next is a verdict on code that is no longer here. Both an
  # observed change and a hidden one count. The first poll is NOT a transition:
  # treating it as one consumed the only verdict a clean review will ever emit
  # and left the watcher timing out on a perfectly good PR.
  if [ "$FIRST_POLL" = "0" ] && { [ "$HEAD_CHANGED" = "1" ] || [ "$HIDDEN_CHANGE" = "1" ]; } \
     && { [ "$EYES" -gt 0 ] || [ "$PREV_EYES" -gt 0 ]; }; then
    STALE_VERDICT_PENDING=1
    say "[poll $i] a review was in flight across that change — its next 👍 belongs to the old head"
  fi

  if [ "$HEAD_CHANGED" = "1" ] || [ "$HIDDEN_CHANGE" = "1" ]; then
    REACTION_UNTRUSTED=1
  fi
  # A review already running when the watch STARTS has no provenance: it may be
  # judging this head or one that preceded it, and nothing observable
  # distinguishes them. Marking its verdict stale would consume the only verdict
  # a clean review ever emits and hang a good PR; accepting it would approve a
  # head nothing reviewed. Both are wrong, so the bare reaction is simply not
  # trusted for this run and a commit-bound review object is required instead.
  if [ "$FIRST_POLL" = "1" ] && [ "$EYES" -gt 0 ]; then
    REACTION_UNTRUSTED=1
    say "[poll $i] a review was already running when this watch began — its verdict cannot be attributed, so a commit-bound review is required"
  fi
  SEEN_HEAD="$HEAD"

  # ------------------------------------------------------------ DECISION PHASE
  APPROVED=false
  # A review object carries commit_id, so it proves WHICH head was reviewed.
  [ "$REVIEWED" -gt 0 ] && APPROVED=true

  # A clean pass posts no review object, only a 👍, and a reaction carries no
  # SHA — it is bound solely by when it appeared.
  # The 👍 must fall inside the CURRENT approval window. Without that test this
  # fired on a reaction left from an earlier head — typically right after a push,
  # before Codex has begun reviewing the new one — and told the operator the PR
  # was clean and ready to merge by hand when nothing had reviewed it. Reporting
  # readiness off a stale signal is the same error as merging off one, only with
  # a human as the actuator.
  if [ "$TRUST_REACTION" != "1" ] && [ "$REVIEWED" -eq 0 ] && [ -n "$APPROVE_TIME" ] \
     && [[ ! "$APPROVE_TIME" < "$SEEN_SINCE" ]] && [ "$REACTION_UNTRUSTED" -eq 0 ] \
     && [ "$FINDINGS" -eq 0 ] && [ "$CHECKS_RC" -eq 0 ] && [ "$EYES" -eq 0 ]; then
    say "  -> $REPO#$PR looks clean and green, but the only approval is a bare 👍."
    say "     A clean pass emits no review object, so nothing ties that verdict to ${HEAD:0:10}."
    say "     Merge it yourself, or re-run with WATCH_MERGE_TRUST_REACTION=1."
    exit 8
  fi

  if [ "$REACTION_UNTRUSTED" = "1" ] && [ -n "$APPROVE_TIME" ] && [ "$REVIEWED" -eq 0 ]; then
    # More than one head has existed during this watch, so a reaction — which
    # carries no SHA — cannot be attributed to any particular one. Timing
    # heuristics do not resolve it: a review can be queued against the old head
    # and only show 👀 after the new head was observed, so no snapshot of the
    # reactions distinguishes the two cases. Rather than guess, this run stops
    # trusting reactions entirely and waits for a review object, which carries
    # commit_id. If none arrives the watch times out and merges nothing.
    say "[poll $i] 👍 cannot be attributed to this head; holding out for a commit-bound review"
  # `>=`, not `>`. Both sides carry only second precision, so a review finishing
  # later in the SAME second as the observation compares equal — and a strict
  # comparison would reject it permanently, with no second verdict ever coming.
  # The cost is a sub-second window; the alternative is a good PR timing out.
  elif [ -n "$APPROVE_TIME" ] && [[ ! "$APPROVE_TIME" < "$SEEN_SINCE" ]]; then
    if [ "$STALE_VERDICT_PENDING" = "1" ]; then
      say "[poll $i] ignoring 👍 at $APPROVE_TIME — verdict of the review that predates this head"
      STALE_VERDICT_PENDING=0
      SEEN_SINCE="$APPROVE_TIME"
    else
      APPROVED=true
    fi
  fi

  say "[poll $i] head=${HEAD:0:10} observed_since=$SEEN_SINCE reviews_on_head=$REVIEWED thumbs_up=${APPROVE_TIME:-none} eyes=$EYES stale_verdict=$STALE_VERDICT_PENDING findings_on_head=$FINDINGS checks_rc=$CHECKS_RC approved=$APPROVED"

  PREV_EYES="$EYES"

  # Never merge while a review is actively running on this head. After findings
  # are resolved and a rereview is requested, the EARLIER review object still
  # satisfies REVIEWED>0 and the resolved threads leave FINDINGS==0 — so with
  # green checks the gate would open on the strength of a superseded verdict,
  # moments before the running review posts its new findings. 👀 means a verdict
  # is pending; wait for it.
  if [ "$EYES" -gt 0 ]; then
    say "  -> a review is in flight on this head (👀); waiting for it to finish before acting on any approval"
    continue
  fi

  [ "$APPROVED" = "true" ] || continue

  if [ "$FINDINGS" -gt 0 ]; then
    say "  -> Codex reviewed this head and left $FINDINGS finding(s). Not merging; a human decides."
    exit 3
  fi

  # rc 8 = pending. Keep waiting rather than reading "unknown" as "fine" — that
  # conflation is what stranded two posts for a week.
  if [ "$CHECKS_RC" -ne 0 ]; then
    say "  -> approved but checks rc=$CHECKS_RC (8=pending, 1=failing); waiting"
    continue
  fi

  # Revalidate at the boundary. Everything above is a snapshot: the reactions
  # were read before the thread, force-push and check requests, so a rereview
  # that starts during those calls still shows 👀=0 in the snapshot. Re-read the
  # reviewer state immediately before acting, so the decision is made on the
  # state that exists at the moment of merging rather than seconds earlier.
  if ! RECHECK=$(gh api "repos/$REPO/issues/$PR/reactions" --paginate 2>/dev/null); then
    say "  -> could not revalidate reviewer state; not merging this round"; continue
  fi
  EYES_NOW=$(printf '%s' "$RECHECK" | jq -s -r "[.[][]|select(.user.id==$BOT_ID)|select(.content==\"eyes\")]|length" 2>/dev/null)
  case "$EYES_NOW" in (*[!0-9]*|"") say "  -> reviewer state unreadable at the merge boundary; not merging"; continue ;; esac
  if [ "$EYES_NOW" -gt 0 ]; then
    say "  -> a review started while this poll was gathering state; standing down"
    continue
  fi
  if ! THREADS_NOW=$(gh api graphql --paginate -F owner="${REPO%%/*}" -F name="${REPO##*/}" -F pr="$PR" -f query='
        query($owner:String!,$name:String!,$pr:Int!,$endCursor:String){
          repository(owner:$owner,name:$name){
            pullRequest(number:$pr){
              reviewThreads(first:100, after:$endCursor){
                pageInfo{ hasNextPage endCursor }
                nodes{ isResolved isOutdated comments(first:1){ nodes{ author{ login } } } }
              }
            }
          }
        }' 2>/dev/null); then
    say "  -> could not revalidate findings; not merging this round"; continue
  fi
  FINDINGS_NOW=$(printf '%s' "$THREADS_NOW" | jq -s -r --arg bot "$BOT_LOGIN_BARE" '
        [ .[].data.repository.pullRequest.reviewThreads.nodes[]
          | select(.comments.nodes[0].author.login == $bot)
          | select(.isResolved == false and .isOutdated == false) ] | length' 2>/dev/null)
  case "$FINDINGS_NOW" in (*[!0-9]*|"") say "  -> findings unreadable at the merge boundary; not merging"; continue ;; esac
  if [ "$FINDINGS_NOW" -gt 0 ]; then
    say "  -> $FINDINGS_NOW finding(s) appeared while this poll was gathering state; not merging"
    exit 3
  fi

  say "  -> approved, no findings on this head, checks green, revalidated: merging"
  if ! gh pr merge "$PR" --repo "$REPO" --squash --delete-branch --match-head-commit "$HEAD" >/dev/null 2>&1; then
    # `gh pr merge` reads projectCards, which errors on repos still carrying
    # Projects-classic. The REST endpoint does not.
    say "  -> gh pr merge failed; trying the REST endpoint"
    gh api -X PUT "repos/$REPO/pulls/$PR/merge" -f merge_method=squash -f sha="$HEAD" >/dev/null 2>&1 || true
  fi

  # Assert the outcome. A merge command exiting 0 is not evidence the PR merged.
  #
  # This read gets its own retry loop, and an unreadable result exits 7, not 6.
  # Reporting "the merge did not take effect" because the status could not be
  # READ is the same unknown-as-definite collapse this script exists to avoid,
  # merely pointing the other way — and it is worse here, because it would send
  # someone to re-merge a PR that already merged.
  # A PR still OPEN right after the command is not proof of failure. If the base
  # branch uses a merge queue, `gh pr merge` succeeds by ENQUEUEING it and the
  # state stays OPEN until the queue lands it. Treating the first OPEN reading as
  # "did not take effect" would report failure for a merge that was accepted, and
  # send someone to re-merge it. So keep watching for a bounded period, and if it
  # is still open at the end, say the outcome is unverified rather than failed.
  LAST_SEEN=""
  for attempt in $(seq 1 24); do
    sleep 5
    if FINAL=$(gh pr view "$PR" --repo "$REPO" --json state,mergedAt \
        -q '"\(.state) \(.mergedAt // "")"' 2>/dev/null) && [ -n "$FINAL" ]; then
      LAST_SEEN="$FINAL"
      case "$FINAL" in
        MERGED*) say "MERGED $REPO#$PR — $FINAL"; exit 0 ;;
        CLOSED*) say "MERGE DID NOT TAKE EFFECT — PR is: $FINAL"; exit 6 ;;
      esac
    fi
  done
  say "MERGE OUTCOME UNVERIFIED after 2m — last seen: ${LAST_SEEN:-unreadable}."
  say "The merge was issued and may be queued. Check $REPO#$PR by hand before retrying."
  exit 7
done

say "TIMEOUT after $MAX_POLLS polls — Codex never cleared the head. Nothing merged."
exit 4
