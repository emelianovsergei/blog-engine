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

# When did this SHA become the PR head?
#
# NOT the commit's own committer date. A force-push or reset can make an OLDER
# existing commit the head, and its committer date can predate an approval that
# was given for a different SHA — which would let a stale 👍 clear code Codex
# never saw. CI is triggered by the push that makes a SHA the head, so check-run
# starts for this SHA track its activations. Take the later of that and the
# commit date, so neither a back-dated commit nor a missing check run can move
# the cutoff backwards.
head_active_time() {
  local sha="$1" commit_time checks_time
  commit_time=$(gh api "repos/$REPO/commits/$sha" -q '.commit.committer.date' 2>/dev/null) || return 1
  [ -n "$commit_time" ] || return 1
  # LAST check-run start, not the first. If a PR is reset to a SHA that was
  # already built once, this endpoint holds runs from BOTH activations; taking
  # the earliest deliberately picks the stale one, so an approval earned by a
  # different head in between would be accepted as current. The reset triggers
  # fresh runs, so the latest start tracks the current activation. A manual
  # re-run can push this later than strictly necessary, which only costs a wait.
  if ! checks_time=$(gh api "repos/$REPO/commits/$sha/check-runs" \
      -q '[.check_runs[].started_at]|sort|last // empty' 2>/dev/null); then
    return 1   # fail closed: never silently fall back to the commit date
  fi
  if [ -n "$checks_time" ] && [[ "$checks_time" > "$commit_time" ]]; then
    printf '%s\n' "$checks_time"
  else
    printf '%s\n' "$commit_time"
  fi
}

for i in $(seq 1 "$MAX_POLLS"); do
  [ "$i" -gt 1 ] && sleep "$INTERVAL"

  # A failed read must not be classified. Without capturing the status, a
  # transient API error yields empty fields and the state checks below would
  # declare a perfectly open PR "not OPEN" and abort on the first blip.
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

  if ! CUTOFF=$(head_active_time "$HEAD"); then
    say "[poll $i] could not determine when $HEAD became head; retrying"; continue
  fi

  # Signal 1 — a review object whose commit_id IS this head. Read from the API
  # field, not scraped from the rendered body: the body is prose that can change
  # format, commit_id is the reviewed SHA itself.
  if ! REVIEWED=$(gh api "repos/$REPO/pulls/$PR/reviews" --paginate \
      -q "[.[]|select(.user.id==$BOT_ID)|select(.commit_id==\"$HEAD\")]|length" 2>/dev/null); then
    say "[poll $i] could not read reviews; retrying"; continue
  fi
  REVIEWED=$(printf '%s\n' "$REVIEWED" | awk '{s+=$1} END {print s+0}')

  # Signal 2 — the 👍. Reactions carry no SHA, so freshness is judged against
  # the head-change time computed above.
  if ! REACTIONS=$(gh api "repos/$REPO/issues/$PR/reactions" --paginate 2>/dev/null); then
    say "[poll $i] could not read reactions; retrying"; continue
  fi
  APPROVE_TIME=$(printf '%s' "$REACTIONS" | jq -r "[.[]|select(.user.id==$BOT_ID)|select(.content==\"+1\")|.created_at]|sort|last // empty" 2>/dev/null)

  # Outstanding findings come from the review-thread state, not from timestamps,
  # not from commit_id, and not from "has someone replied".
  #
  # A reply is not a resolution: an acknowledgement, a disagreement, or a promise
  # to fix later all create a reply while the finding stands. Counting replies
  # would let a re-run merge an unchanged head carrying a known defect.
  #
  # GitHub tracks the two states that actually matter. `isOutdated` means the
  # diff moved past the comment, so it no longer describes this code.
  # `isResolved` means a human explicitly closed the thread. Anything neither
  # outdated nor resolved is still open against this head. Note this makes
  # resolving a thread part of the workflow — replying alone will not clear it,
  # which is the point.
  if ! THREADS=$(gh api graphql -F owner="${REPO%%/*}" -F name="${REPO##*/}" -F pr="$PR" -f query='
        query($owner:String!,$name:String!,$pr:Int!){
          repository(owner:$owner,name:$name){
            pullRequest(number:$pr){
              reviewThreads(first:100){
                nodes{ isResolved isOutdated comments(first:1){ nodes{ author{ login } } } }
              }
            }
          }
        }' 2>/dev/null); then
    # Never default this to zero. A PR whose findings could not be read is not a
    # PR without findings, and the review signal alone could otherwise merge it.
    say "[poll $i] could not read review threads; retrying rather than assuming none"; continue
  fi
  if ! FINDINGS=$(printf '%s' "$THREADS" | jq -r --arg bot "$BOT_LOGIN_BARE" '
        [ .data.repository.pullRequest.reviewThreads.nodes[]
          | select(.comments.nodes[0].author.login == $bot)
          | select(.isResolved == false and .isOutdated == false) ] | length' 2>/dev/null); then
    say "[poll $i] could not evaluate review threads; retrying"; continue
  fi

  gh pr checks "$PR" --repo "$REPO" >/dev/null 2>&1; CHECKS_RC=$?

  APPROVED=false
  [ "$REVIEWED" -gt 0 ] && APPROVED=true
  if [ -n "$APPROVE_TIME" ] && [[ "$APPROVE_TIME" > "$CUTOFF" ]]; then APPROVED=true; fi

  say "[poll $i] head=${HEAD:0:10} head_active=$CUTOFF reviews_on_head=$REVIEWED thumbs_up=${APPROVE_TIME:-none} findings_on_head=$FINDINGS checks_rc=$CHECKS_RC approved=$APPROVED"

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
  sleep 5
  FINAL=$(gh pr view "$PR" --repo "$REPO" --json state,mergedAt -q '"\(.state) \(.mergedAt // "")"' 2>/dev/null)
  case "$FINAL" in
    MERGED*) say "MERGED $REPO#$PR — $FINAL"; exit 0 ;;
    *)       say "MERGE DID NOT TAKE EFFECT — PR is: $FINAL"; exit 6 ;;
  esac
done

say "TIMEOUT after $MAX_POLLS polls — Codex never cleared the head. Nothing merged."
exit 4
