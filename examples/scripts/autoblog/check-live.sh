#!/usr/bin/env bash
# Asserts that every new autoblog post merged in the last LIVE_CHECK_DAYS days
# answers 200 on the production site.
#
# A merge is not a publication. On 2026-10-04 pulse-website#431 merged, but
# Vercel's production deploy failed after 18 seconds, and the post returned 404
# for hours while every GitHub check was green. Nothing looked at the live site.
#
# When a post is missing and the VERCEL_DEPLOY_HOOK secret is set (Vercel →
# Project → Settings → Git → Deploy Hooks, branch main), this triggers one
# production redeploy and waits for the post to appear. Otherwise, or if the
# post is still missing after that, it exits 1 so the run goes red.
#
# Env: GH_TOKEN, GITHUB_REPOSITORY (set in Actions), AUTOBLOG_SITE_URL
# (optional; default: SITE_URL in lib/constants.ts), LIVE_CHECK_DAYS
# (default 2), VERCEL_DEPLOY_HOOK (optional), LIVE_CHECK_BUDGET_SECONDS
# (default 900: one wall-clock budget for every check and the redeploy wait,
# so the run ends inside its workflow's timeout however many posts it checks).
set -euo pipefail

DAYS="${LIVE_CHECK_DAYS:-2}"
DEADLINE=$(( $(date +%s) + ${LIVE_CHECK_BUDGET_SECONDS:-900} ))
SITE="${AUTOBLOG_SITE_URL:-}"
if [ -z "$SITE" ] && [ -f lib/constants.ts ]; then
  SITE=$(grep -A3 'export const SITE_URL' lib/constants.ts | grep -oE 'https://[A-Za-z0-9.-]+' | head -1 || true)
fi
if [ -z "$SITE" ]; then
  echo "::error::Could not work out the site URL. Set the AUTOBLOG_SITE_URL repository variable."
  exit 1
fi
SITE="${SITE%/}"
SINCE=$(date -u -d "$DAYS days ago" +%Y-%m-%dT%H:%M:%SZ)

# Every publication route the watchdog counts: the autoblog labels or an
# autoblog head. Only files the PR added under content/blog are checked, so a
# refresh or backfill PR (which edits live posts) adds nothing here.
# Closed PRs newest-updated first, page by page, until a page reaches PRs last
# updated before SINCE: a PR merged since then was updated since then too.
PRS=""
for page in $(seq 1 20); do
  if ! BATCH=$(gh api "repos/${GITHUB_REPOSITORY}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}"); then
    echo "::error::Could not list merged posts."
    exit 1
  fi
  PRS="$PRS $(jq -r --arg s "$SINCE" '.[]
      | select(.merged_at != null and .merged_at >= $s)
      | select(
          ([.labels[].name] | any(. == "autoblog" or . == "autoblog-approved-pending"))
          or (.head.ref | startswith("autoblog/") or startswith("blog/auto-") or startswith("blog/claude-"))
        )
      | .number' <<<"$BATCH")"
  OLDEST=$(jq -r 'if length < 100 then "" else .[-1].updated_at end' <<<"$BATCH")
  if [ -z "$OLDEST" ] || [[ "$OLDEST" < "$SINCE" ]]; then
    break
  fi
done

URLS=()
for n in $PRS; do
  if ! FILES=$(gh api "repos/${GITHUB_REPOSITORY}/pulls/${n}/files?per_page=100" \
      --jq '.[] | select(.status == "added" and (.filename | test("^content/blog/[^/]+\\.mdx$"))) | .filename'); then
    echo "::error::Could not list the files of #$n."
    exit 1
  fi
  for f in $FILES; do
    # Read the post from main: a post renamed or removed since is not checked.
    if ! BODY=$(gh api "repos/${GITHUB_REPOSITORY}/contents/${f}?ref=main" --jq .content 2>/dev/null | base64 -d 2>/dev/null); then
      echo "#$n: $f is no longer on main; skipped."
      continue
    fi
    SLUG=$(printf '%s\n' "$BODY" | awk 'NR == 1 && $0 != "---" { exit } NR > 1 && $0 == "---" { exit } /^slug:/ { print; exit }' \
      | sed -E "s/^slug:[[:space:]]*['\"]?([^'\"[:space:]]+)['\"]?[[:space:]]*$/\1/")
    [ -n "$SLUG" ] || SLUG=$(basename "$f" .mdx)
    URLS+=("$SITE/blog/$SLUG")
  done
done

if [ "${#URLS[@]}" -eq 0 ]; then
  echo "No new post merged in the last $DAYS day(s); nothing to check."
  exit 0
fi

# One status per URL. A network error (000) is retried once before it counts.
# curl already writes 000 when it fails, so its exit status is ignored rather
# than appending a second 000.
status() {
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 20 "$1") || true
  echo "${code:-000}"
}
missing() {
  local u code
  for u in "${URLS[@]}"; do
    if [ "$(date +%s)" -ge "$DEADLINE" ]; then
      echo "$u (not checked: time budget spent)"
      continue
    fi
    code=$(status "$u")
    if [ "$code" = 000 ]; then
      sleep 5
      code=$(status "$u")
    fi
    [ "$code" = 200 ] || echo "$u ($code)"
  done
}

MISSING=$(missing)
if [ -z "$MISSING" ]; then
  echo "✅ ${#URLS[@]} new post(s) live:"
  printf '  %s\n' "${URLS[@]}"
  exit 0
fi
echo "::warning::Not live on $SITE:"
printf '%s\n' "$MISSING"

# The hook request is bounded too: a stalled endpoint must not outlive the budget.
LEFT=$(( DEADLINE - $(date +%s) ))
if [ -n "${VERCEL_DEPLOY_HOOK:-}" ] && [ "$LEFT" -gt 0 ]; then
  if curl -fsS --max-time "$(( LEFT < 30 ? LEFT : 30 ))" -X POST "$VERCEL_DEPLOY_HOOK" >/dev/null; then
    echo "Triggered a production redeploy through the Vercel deploy hook; waiting until the time budget runs out."
    while [ "$(date +%s)" -lt "$DEADLINE" ]; do
      sleep 30
      MISSING=$(missing)
      if [ -z "$MISSING" ]; then
        echo "✅ Live after the redeploy:"
        printf '  %s\n' "${URLS[@]}"
        exit 0
      fi
    done
  else
    echo "::warning::The Vercel deploy hook request failed."
  fi
  echo "::error::Still not live after a redeploy: $(printf '%s' "$MISSING" | tr '\n' ' '). Check the latest production deployment in Vercel."
elif [ -n "${VERCEL_DEPLOY_HOOK:-}" ]; then
  echo "::error::Not live, and the time budget ran out before a redeploy: $(printf '%s' "$MISSING" | tr '\n' ' '). Redeploy main in Vercel."
else
  echo "::error::Not live: $(printf '%s' "$MISSING" | tr '\n' ' '). Redeploy main in Vercel. Add a VERCEL_DEPLOY_HOOK secret (Vercel → Settings → Git → Deploy Hooks, branch main) to let this check redeploy on its own."
fi
exit 1
