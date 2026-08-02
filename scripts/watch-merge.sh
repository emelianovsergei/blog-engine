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

CODEX_RE='codex'
say() { printf '%s\n' "$*"; }

# When did this SHA become the PR head?
#
# NOT the commit's own committer date. A force-push or reset can make an OLDER
# existing commit the head, and its committer date can predate an approval that
# was given for a different SHA — which would let a stale 👍 clear code Codex
# never saw. CI is triggered by the push that makes a SHA the head, so the
# earliest check-run start for this SHA tracks the head-change event itself.
# Take the later of the two so neither a back-dated commit nor a missing check
# run can move the cutoff backwards.
head_active_time() {
  local sha="$1" commit_time checks_time
  commit_time=$(gh api "repos/$REPO/commits/$sha" -q '.commit.committer.date' 2>/dev/null) || return 1
  [ -n "$commit_time" ] || return 1
  checks_time=$(gh api "repos/$REPO/commits/$sha/check-runs" \
    -q '[.check_runs[].started_at]|sort|first // empty' 2>/dev/null)
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
      -q "[.[]|select(.user.login|test(\"$CODEX_RE\";\"i\"))|select(.commit_id==\"$HEAD\")]|length" 2>/dev/null); then
    say "[poll $i] could not read reviews; retrying"; continue
  fi
  REVIEWED=$(printf '%s\n' "$REVIEWED" | awk '{s+=$1} END {print s+0}')

  # Signal 2 — the 👍. Reactions carry no SHA, so freshness is judged against
  # the head-change time computed above.
  if ! REACTIONS=$(gh api "repos/$REPO/issues/$PR/reactions" --paginate 2>/dev/null); then
    say "[poll $i] could not read reactions; retrying"; continue
  fi
  APPROVE_TIME=$(printf '%s' "$REACTIONS" | jq -r "[.[]|select(.user.login|test(\"$CODEX_RE\";\"i\"))|select(.content==\"+1\")|.created_at]|sort|last // empty" 2>/dev/null)

  # Findings are matched by commit_id, not by timestamp: a review of the PREVIOUS
  # head can land after the new head is pushed, and judging by created_at would
  # count those against the new head and abort a PR that is actually clean.
  #
  # commit_id alone is not enough either. GitHub re-anchors a still-applicable
  # comment to the current head, so a finding that was raised earlier AND already
  # answered keeps reappearing as a finding "on this head" forever — which would
  # block every PR whose review was resolved by replying in-thread. A finding
  # counts as outstanding only while nobody has replied to it.
  if ! COMMENTS=$(gh api "repos/$REPO/pulls/$PR/comments?per_page=100" --paginate -q '.[]' 2>/dev/null); then
    # Never default this to 0. A PR whose findings could not be read is not a PR
    # without findings, and signal 1 alone could otherwise merge it.
    say "[poll $i] could not read review comments; retrying rather than assuming none"; continue
  fi
  if ! FINDINGS=$(printf '%s' "$COMMENTS" | jq -s --arg head "$HEAD" --arg re "$CODEX_RE" '
        ([.[] | select(.in_reply_to_id != null) | .in_reply_to_id]) as $answered
        | [ .[]
            | select(.user.login | test($re; "i"))
            | select(.in_reply_to_id == null)
            | select(.commit_id == $head)
            | . as $c | select(($answered | index($c.id)) == null)
          ] | length' 2>/dev/null); then
    say "[poll $i] could not evaluate review comments; retrying"; continue
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
