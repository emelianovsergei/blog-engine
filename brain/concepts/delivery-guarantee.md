---
type: "concept"
title: "Delivery Guarantee (Consumer Workflow Set + Watchdog)"
description: "The five workflows a consumer repo runs, why examples/ must carry all of them, and the out-of-band watchdog that proves a post actually shipped."
tags: ["concepts", "ci", "workflows", "reliability", "examples"]
timestamp: "2026-08-02"
sources: []
---
# Delivery Guarantee (Consumer Workflow Set + Watchdog)

blog-engine ships the CLI; the *pipeline* lives in the consumer repo
(pulse-website, promax-website) as GitHub Actions workflows. `examples/` is the
provisioning source for that pipeline, so a hole in `examples/` is a hole in
every repo provisioned from it.

## The five workflows

| Workflow | Role |
|---|---|
| `generate-blog-post.yml` | Saturday 1 AM PT (dual cron + Pacific schedule-guard). Generates the post and opens a draft PR. |
| `autoblog-review.yml` | AI review gate; on fail runs the bounded auto-fix loop ([[concepts/autofix-loop]]). |
| `autoblog-merge-pending.yml` | Daily merge cron over `autoblog-approved-pending`, behind label + age + head-SHA-pinned CI gates. |
| `autoblog-rewrite.yml` | `/autoblog rewrite` — the manual escape hatch when the automated loop hands off. |
| `autoblog-watchdog.yml` | Out-of-band proof that a post actually shipped. |

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

`autoblog-watchdog.yml` runs Monday ~10-11 AM PT — after Saturday generation and
the 24h merge window — and asks the only question that matters: did a post
actually reach `main`? It is pure API (no checkout), so it sets `GH_REPO`
explicitly; without a working tree `gh` cannot infer the repository and every
call dies with "not a git repository."

Two thresholds, two questions, both job-level `env` so the alert text, the
assessment and the close-comment title cannot drift apart:

- `DELIVERY_STALE_DAYS: 10` — "is the pipeline still producing?" Tracks the
  weekly cadence plus the merge window plus one skipped week.
- `STRANDED_PR_DAYS: 21` — "is a finished post stuck?" Deliberately longer,
  because a post can legitimately sit through a slow review or an auto-fix
  cycle, and alarming at the delivery cadence would make an ordinary unhurried
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
