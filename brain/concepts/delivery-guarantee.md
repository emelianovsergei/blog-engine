---
type: "concept"
title: "Delivery Guarantee (Consumer Workflow Set + Watchdog)"
description: "The workflow set a consumer repo runs (nine since Codex heal), why examples/ must carry all of them, and the out-of-band watchdog that proves a post actually shipped."
tags: ["concepts", "ci", "workflows", "reliability", "examples"]
timestamp: "2026-09-21"
sources: []
---
# Delivery Guarantee (Consumer Workflow Set + Watchdog)

blog-engine ships the CLI; the *pipeline* lives in the consumer repo
(pulse-website, promax-website) as GitHub Actions workflows. `examples/` is the
provisioning source for that pipeline, so a hole in `examples/` is a hole in
every repo provisioned from it.

## The workflow set

| Workflow | Role |
|---|---|
| `generate-blog-post.yml` | Hourly tick. Due-check reads `AUTOBLOG_INTERVAL` (`1h`/`1d`/`7d`/`30d`, default `1d`) and `AUTOBLOG_HOUR_PT` (default 1 AM Pacific). Skips when a `blog/auto-*` PR is already open, or the last new-post PR's **createdAt** is inside the interval (not mergedAt — merge lag would skip the next 1 AM slot). Closed unmerged drafts count as that day's attempt; retry is `workflow_dispatch`. For `>=1d`, generate on the first tick **at or after** `AUTOBLOG_HOUR_PT` (exact `==` skipped Pulse 2026-09-17 when GitHub fired at 2:06 AM PT). If a late tick crosses Pacific midnight and calendar days already exceed the interval, catch up. `RUN_KEY` keys branch, report, recovery ref and PR title. Downloads posts from open autoblog PRs into `data/blog-pending/` for dedup, seeds the planner from Search Console, opens a draft PR. |
| `autoblog-review.yml` | AI review gate; on fail runs the bounded auto-fix loop ([[concepts/autofix-loop]]). |
| `autoblog-codex-heal.yml` | Unresolved Codex P0/P1 on an approved autoblog PR: bounded rewrite ([[concepts/codex-heal]]), then wait for Codex to re-review the new head before resolving old threads. |
| `autoblog-merge-pending.yml` | Hourly tick at :20 over `autoblog-approved-pending`. Age gate is `AUTOBLOG_MERGE_DELAY` (default `1h`). Unresolved Codex P0 always skips. Unresolved Codex P1 skips when `AUTOBLOG_HOLD_ON_CODEX_P1` is true. P2 nits ship. |
| `autoblog-rewrite.yml` | `/autoblog rewrite` — the manual escape hatch when the automated loop hands off. |
| `autoblog-watchdog.yml` | Daily proof that a post actually shipped. Window / expected count / stale days are derived from `AUTOBLOG_INTERVAL` (override with `AUTOBLOG_EXPECTED_POSTS_PER_WEEK` if set). |
| `autoblog-ci-heal.yml` | Reacts to red CI on `blog/auto-*`, `blog/refresh-*` and `blog/backfill-*` PRs so a failing check does not strand a finished post. |
| `blog-refresh.yml` | Monday: `blog-engine-refresh --mode refresh` on the post with the most page-two Search Console impressions outside a 120-day cooldown ([[concepts/refresh-mode]]). Serialized with backfill via the `autoblog-mutate-existing` concurrency group. |
| `autoblog-backfill.yml` | `workflow_dispatch`: brings up to N older posts onto the current template, one PR each, body kept, autofix skipped (label `autoblog-backfill`). |

Until 2026-08-02 `examples/` carried only three of the five, and the two missing
ones were *the delivery guarantee and the thing being guaranteed* — provisioning
from `examples/` produced a pipeline that could lose a week of content silently.
The templates had also drifted ~3 weeks behind the copies actually running in
production, so `autoblog-merge-pending.yml` shipped without the CI gate, the
head-SHA pin, the label re-read, the `autoblog-link-repair-needed` skip, or the
`actions: read` permission. Resynced verbatim from pulse-website in #20, which
remains the convention (the templates carry pulse's real `--site`/`--business`
values as the worked example).

## Persist before you gate

The original 2026-07-25 outage was structural: the quality gates sat *between*
generation and PR creation, so a failed guard deleted the post. The post is now
committed to a branch and a PR is opened **first**; gates then label, block or
fix — they never destroy. A blocked post is visible and recoverable; a deleted
one is a silent missing week.

## The watchdog

`autoblog-watchdog.yml` runs daily ~10-11 AM PT and asks the only question that
matters: did a post actually reach `main`? It is pure API (no checkout), so it
sets `GH_REPO` explicitly; without a working tree `gh` cannot infer the
repository and every call dies with "not a git repository." `autoblog-ci-heal.yml`
sets the same `GH_REPO` on the job: the report step runs with no checkout
unless the failure is a dead link.

For a window longer than one day, the cutoff is the start of that UTC day,
not `now` minus N days. The 18:00Z cron often starts after 20:00Z. On
2026-09-20 it started at 20:19Z and a rolling cutoff dropped Promax's 19:02Z
merge from three days earlier, so one real miss looked like two. A one-day
hourly window stays a rolling 24 hours, so yesterday's posts cannot hide a
silent day.

Window, expected count and stale days are **derived from `AUTOBLOG_INTERVAL`**
in the assess step and exported via `GITHUB_ENV`, so the alert text cannot
drift from the assessment. `AUTOBLOG_EXPECTED_POSTS_PER_WEEK` remains an
optional override.

| Interval | Window | Expected `blog/auto-*` merges | Stale days |
|---|---|---|---|
| `1h` | 1 day | 10 | 2 |
| `1d` (default) | 3 days | 2 | 3 |
| `7d` | 7 days | 1 | 10 |
| `30d`+ | interval days | 1 | interval + 10 |

Daily uses a 3-day window so a twice-weekly → daily cutover does not
false-alarm **once two daily posts have merged**. The first daily watchdog
(2026-09-16, ~3h after the cadence merge) still opened stall issues on both
consumers: history was weekly, so 1 merge in 3 days < expected 2. They close
when the count catches up. Refresh and backfill PRs are excluded from the
count.

`STRANDED_PR_DAYS: 21` is still a constant: a post can sit through a slow
review, and alarming at the delivery cadence would make an ordinary unhurried
review look like a fault.

**Delivery is measured by merged PRs, not by commits to `content/blog`.** They
look equivalent and are not: any maintenance edit resets a commit-based signal.
The Ahrefs link repair on 07-22 did exactly that while the last real post was
07-19, and the weekly link-health sweep would have made that blind spot
permanent. Three markers are accepted, because the repo has two routes to
publication and a watchdog that knows only one raises a false outage on the
other: the `autoblog` label, the `autoblog-approved-pending` label, and an
`autoblog/*` / `blog/auto-*` head ref (review accepts a PR by head-ref alone, so
a post can ship with neither label). Merge dates are not returned in order —
take the max, not row one.

The watchdog needs `actions: read` for its `gh run list` fallback. Without it
every outage issue silently loses the generation-run history it exists to
surface — the evidence that distinguishes "generation failed" from "generation
never fired." That omission would be an instance of
[[concepts/unreachable-success-path]] inside the watchdog itself.

## Babysitting a PR to merge

`scripts/watch-merge.sh` is the dev-side counterpart: poll a PR until Codex has
reviewed and CI is green, then merge. It is not published (`files` is
`["dist", "examples"]`).

**It does not auto-merge a clean first pass by default.** A clean Codex pass
emits no review object — only a 👍 — and a reaction carries no SHA, so nothing
observable ties that verdict to the head it judged. `WATCH_MERGE_TRUST_REACTION`
therefore defaults to off: the script confirms the PR is clean and green and
then **exits 8** — "ready, but not machine-verifiable" — rather than merging.

Merging on the default path needs a review object whose `commit_id` equals the
current head, and Codex emits a review object only when it has something to say
about *that* head. Fixing findings moves the head, and the clean pass on the new
head is a bare 👍 again — so "findings, then a clean re-review" does **not**
satisfy it. In practice a PR that ends clean exits 8, and
`WATCH_MERGE_TRUST_REACTION=1` — which rests on timing rather than proof — is
what completes the merge. An operator expecting the bare invocation to finish
the job will find it deliberately refusing.

Its approval binding, the proxies it rejects and its fail-closed behaviour are
documented in [[concepts/unreachable-success-path]].
