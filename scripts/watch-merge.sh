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
#   5  PR is not in a mergeable state (closed, draft, conflicted)
#   6  merge was attempted and did NOT take effect
#
# WHY THIS IS FIDDLIER THAN IT LOOKS
#
# The obvious predicate — "the SHA in Codex's review body equals the PR head" — is
# WRONG, and wrong in the worst direction: it is unsatisfiable exactly when the PR
# is fine. Codex only posts a review body (which carries `Reviewed commit: <sha>`)
# when it HAS suggestions. A clean pass leaves no review body at all; it swaps its
# reaction from 👀 to 👍 and says nothing. So a SHA-matching watcher can only ever
# fire on rejection, and on approval it spins until it times out and reports the PR
# as "still waiting" while the PR sits approved and green.
#
# That is the same shape as the bug this repo's autoblog pipeline kept hitting: an
# automated check whose success path cannot be reached, failing in a way that looks
# like patience rather than breakage. Hence the two independent approval signals
# below, and the post-merge read-back at the end.

set -uo pipefail

REPO="${1:?usage: watch-merge.sh <owner/repo> <pr-number> [max-polls] [interval-seconds]}"
PR="${2:?usage: watch-merge.sh <owner/repo> <pr-number> [max-polls] [interval-seconds]}"
MAX_POLLS="${3:-24}"
INTERVAL="${4:-90}"

CODEX_RE='codex'

say() { printf '%s\n' "$*"; }

# Timestamp of the current head commit. Every "is this signal about the code as it
# stands now?" question is answered against this, so a stale 👍 or a finding from a
# previous revision can never be mistaken for a verdict on the current head.
head_commit_time() {
  gh api "repos/$REPO/commits/$1" -q '.commit.committer.date' 2>/dev/null
}

for i in $(seq 1 "$MAX_POLLS"); do
  [ "$i" -gt 1 ] && sleep "$INTERVAL"

  read -r STATE IS_DRAFT HEAD <<<"$(gh pr view "$PR" --repo "$REPO" \
    --json state,isDraft,headRefOid -q '"\(.state) \(.isDraft) \(.headRefOid)"' 2>/dev/null)"

  if [ "$STATE" = "MERGED" ]; then
    say "already merged — nothing to do"; exit 0
  fi
  if [ "$STATE" != "OPEN" ]; then
    say "PR is $STATE, not OPEN — refusing to act"; exit 5
  fi
  if [ "$IS_DRAFT" = "true" ]; then
    say "PR is still a draft — mark it ready first"; exit 5
  fi

  HEAD_TIME=$(head_commit_time "$HEAD")
  if [ -z "$HEAD_TIME" ]; then
    say "[poll $i] could not read head commit time; retrying"; continue
  fi

  # Signal 1 — an explicit review body naming this exact SHA. Only produced when
  # Codex HAS something to say, so on its own it is not an approval.
  REVIEWED_SHA=$(gh api "repos/$REPO/pulls/$PR/reviews" \
    -q "[.[]|select(.user.login|test(\"$CODEX_RE\";\"i\"))]|last|.body" 2>/dev/null \
    | grep -oE '`[0-9a-f]{7,40}`' | tr -d '`' | tail -1)

  # Signal 2 — the reaction. 👀 = mid-review, 👍 = reviewed with nothing to say.
  # Codex swaps the reaction rather than accumulating them, so created_at is fresh
  # on each pass; a 👍 older than the head commit is about superseded code.
  APPROVE_TIME=$(gh api "repos/$REPO/issues/$PR/reactions" \
    -q "[.[]|select(.user.login|test(\"$CODEX_RE\";\"i\"))|select(.content==\"+1\")]|last|.created_at" 2>/dev/null)
  REVIEWING=$(gh api "repos/$REPO/issues/$PR/reactions" \
    -q "[.[]|select(.user.login|test(\"$CODEX_RE\";\"i\"))|select(.content==\"eyes\")]|length" 2>/dev/null)

  # Top-level findings (replies excluded) raised against the current head.
  FINDINGS=$(gh api "repos/$REPO/pulls/$PR/comments" --paginate \
    -q "[.[]|select(.user.login|test(\"$CODEX_RE\";\"i\"))|select(.in_reply_to_id==null)|select(.created_at > \"$HEAD_TIME\")]|length" 2>/dev/null)
  FINDINGS="${FINDINGS:-0}"
  # --paginate concatenates one count per page; sum them.
  FINDINGS=$(printf '%s\n' "$FINDINGS" | awk '{s+=$1} END {print s+0}')

  gh pr checks "$PR" --repo "$REPO" >/dev/null 2>&1; CHECKS_RC=$?

  APPROVED=false
  case "$HEAD" in "$REVIEWED_SHA"*) [ -n "$REVIEWED_SHA" ] && APPROVED=true ;; esac
  if [ -n "$APPROVE_TIME" ] && [[ "$APPROVE_TIME" > "$HEAD_TIME" ]]; then APPROVED=true; fi

  say "[poll $i] head=${HEAD:0:10} head_time=$HEAD_TIME reviewed_sha=${REVIEWED_SHA:0:10} thumbs_up=${APPROVE_TIME:-none} eyes=${REVIEWING:-0} findings_on_head=$FINDINGS checks_rc=$CHECKS_RC approved=$APPROVED"

  if [ "$APPROVED" != "true" ]; then continue; fi

  if [ "$FINDINGS" -gt 0 ]; then
    say "  -> Codex reviewed this head and left $FINDINGS finding(s). Not merging; a human decides."
    exit 3
  fi

  # rc 8 = still pending. Keep waiting rather than treating "unknown" as "fine" —
  # conflating those is precisely the bug that stranded two posts for a week.
  if [ "$CHECKS_RC" -ne 0 ]; then
    say "  -> approved but checks rc=$CHECKS_RC (8=pending, 1=failing); waiting"
    continue
  fi

  say "  -> approved, no findings on this head, checks green: merging"
  if ! gh pr merge "$PR" --repo "$REPO" --squash --delete-branch --match-head-commit "$HEAD" >/dev/null 2>&1; then
    # `gh pr merge` reads projectCards, which 404s on repos still carrying
    # Projects-classic. The REST endpoint does not.
    say "  -> gh pr merge failed; trying the REST endpoint"
    gh api -X PUT "repos/$REPO/pulls/$PR/merge" \
      -f merge_method=squash -f sha="$HEAD" >/dev/null 2>&1 || true
  fi

  # Assert the outcome. A merge command that exits 0 is not evidence the PR merged.
  sleep 5
  FINAL=$(gh pr view "$PR" --repo "$REPO" --json state,mergedAt -q '"\(.state) \(.mergedAt // "")"' 2>/dev/null)
  case "$FINAL" in
    MERGED*) say "MERGED $REPO#$PR — $FINAL"; exit 0 ;;
    *)       say "MERGE DID NOT TAKE EFFECT — PR is: $FINAL"; exit 6 ;;
  esac
done

say "TIMEOUT after $MAX_POLLS polls — Codex never cleared head ${HEAD:0:10}. Nothing merged."
exit 4
