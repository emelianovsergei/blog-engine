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
# The deliberate cost: a 👍 that predates the watcher is NOT trusted, because
# nothing can tell it apart from one earned by a previous head. Such a run
# declines and exits 4 rather than guessing. Set WATCH_MERGE_TRUST_EXISTING=1 to
# accept a pre-existing approval when you have checked it yourself.
TRUST_EXISTING="${WATCH_MERGE_TRUST_EXISTING:-0}"
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
  NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  FIRST_POLL=0; [ -z "$SEEN_HEAD" ] && FIRST_POLL=1

  HEAD_CHANGED=0
  [ "$FIRST_POLL" = "0" ] && [ "$HEAD" != "$SEEN_HEAD" ] && HEAD_CHANGED=1

  # A force-push newer than the window means the head moved between polls — the
  # A -> B -> A case, where both samples read A and the change is invisible.
  HIDDEN_CHANGE=0
  if [ "$FIRST_POLL" = "0" ] && [ -n "$FORCE_PUSHED" ] && [[ "$FORCE_PUSHED" > "$SEEN_SINCE" ]]; then
    HIDDEN_CHANGE=1
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

  SEEN_HEAD="$HEAD"

  # ------------------------------------------------------------ DECISION PHASE
  APPROVED=false
  # A review object carries commit_id, so it proves WHICH head was reviewed.
  [ "$REVIEWED" -gt 0 ] && APPROVED=true

  # A clean pass posts no review object, only a 👍, and a reaction carries no
  # SHA — it is bound solely by when it appeared.
  if [ -n "$APPROVE_TIME" ] && [[ "$APPROVE_TIME" > "$SEEN_SINCE" ]]; then
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

  say "  -> approved, no findings on this head, checks green: merging"
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
