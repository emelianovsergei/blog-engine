---
type: "concept"
title: "Red-CI Self-Heal"
description: "Why a green review was never enough, and what the healer is deliberately not allowed to do."
tags: ["concepts", "ci", "automation", "links"]
timestamp: "2026-08-19"
sources: []
---
# Red-CI Self-Heal

[[concepts/autofix-loop]] recovers from a failing **review**. Nothing recovered
from failing **CI** — and `autoblog-merge-pending` refuses a PR whose checks are
not green. `autoblog-watchdog` documented "Red CI" as a known stuck state
without clearing it, so a finished post sat unpublishable until a human noticed.

## The failure that proved it

On 2026-08-18 generation stripped a denylisted DOE URL before writing. The
reviewer then asked for a cited statistic, and the auto-fix rewrite — the one
prompt in the pipeline that had never heard of the link policy — supplied that
exact URL again (`a99f27b`). `@smoke` went red and the post could never merge.

Two fixes came out of it:

1. The rewrite path now shares the link policy and audits after writing
   ([[modules/link-audit]]), so the cause is largely removed.
2. `autoblog-ci-heal.yml` is the net for what still gets through.

## Design constraints

- **Act on a contract, not on logs.** `tests/seo.spec.ts` writes
  `link-violations.json` and CI uploads it. Scraping job output to work out
  which URL failed is brittle.
- **Deterministic repair only.** Dead links are fixed by `blog-engine-repair` —
  no model, no cost, no new prose. Asking an LLM to "fix the link" lets it
  rewrite the paragraph around the URL, which is a fresh hallucination surface
  for a purely mechanical problem.
- **Never guess.** Anything that is not a link failure is labelled
  `autoblog-ci-failed` and commented. A URL surviving in running prose exits 2
  and raises `autoblog-link-repair-needed` rather than being silently rewritten.
- **One shared attempt budget.** CI fixes carry `[autoblog-cifix]`, capped at 1
  per branch, and the review gate counts **both** marker types against
  `AUTOBLOG_MAX_AUTOFIX`. Without that, the two healers each spend their own cap
  and re-trigger one another indefinitely.

See [[concepts/delivery-guarantee]] for the wider "a post must actually ship"
invariant.
