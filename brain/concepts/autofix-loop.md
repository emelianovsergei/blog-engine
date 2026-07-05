---
type: "concept"
title: "Auto-Fix Loop (Review Failure Recovery)"
description: "Bounded CI loop that rewrites a failed-review post with Claude Sonnet and re-reviews it, capped by marker commits."
tags: ["concepts", "review", "rewrite", "ci", "workflows"]
timestamp: "2026-07-05"
sources: []
---
# Auto-Fix Loop (Review Failure Recovery)

When the AI review gate fails a generated post PR, `examples/autoblog-review.yml`
no longer stops at labeling it `autoblog-review-failed` — it runs a bounded
auto-fix loop before handing off to a human.

## State machine

```
review exit 0 (pass) ──► ready + approve + `autoblog-approved-pending` ──► daily merge cron
review exit 1 (error) ─► `autoblog-review-failed` only (transient — no auto-fix)
review exit 2 (fail) ──► `autoblog-review-failed` + eligibility gate:
    no ReviewResult JSON / pass!=false ─► skip (exit-1-like anomaly)
    AUTOBLOG_PAT missing ──────────────► skip + comment (push couldn't retrigger review)
    attempts ≥ cap ────────────────────► "gave up" comment; human takes over
    branch tip moved (force-push race) ► skip (newer run owns the tip)
    else ─► blog-engine-rewrite (Claude Sonnet) ► npm run build gate ► commit
            with `[autoblog-autofix]` marker ► change-notes comment ► push
            with AUTOBLOG_PAT ► `synchronize` re-fires review ► loop
```

## Loop-prevention invariants

- **Attempt counter = marker commits.** The gate counts commits on
  `origin/<base>..<head>` whose message contains `[autoblog-autofix]`
  (`git log --fixed-strings --grep` — the brackets are regex chars). Cap is
  `AUTOBLOG_MAX_AUTOFIX` (repo var, default 2). Stateless: no labels to race,
  and the weekly generate `git push --force` wiping the branch intentionally
  resets the budget (new content = new attempts). Weekly worst case with cap
  2: three review calls + two rewrite calls.
- **Exit 1 never auto-fixes.** A review that could not run (no key, model
  outage) produces no trustworthy findings; the gate requires
  `review-result.json` with `pass == false`.
- **Push is the job's last step.** The PAT push retriggers this same workflow,
  whose per-PR `cancel-in-progress` concurrency group cancels the running one
  — so everything of value (artifact, comments, commit) happens before the
  push, and cancellation can only hit an empty tail.
- **GITHUB_TOKEN stays read-only.** `permissions: contents: read`; the push
  authenticates via the `AUTOBLOG_PAT` persisted at checkout. A push made with
  the built-in token would not emit workflow events anyway (GitHub loop
  suppression) — the gate skips with a comment if the PAT is absent.
- **Build gate before commit.** `npm run build` must pass on the rewritten
  post; a red job pushes nothing, which terminates the loop for that round.
- **Manual `/autoblog rewrite` is the escape hatch** (see
  `examples/autoblog-rewrite.yml`). Its commit carries no marker, so it never
  consumes the auto-fix budget — but if its re-review fails and budget
  remains, the automated loop resumes.

## False-blocker defense

The loop makes reviewer hallucinations expensive (each one burns an attempt),
so [[modules/review]] injects a `VERIFIED STRUCTURAL FACTS` block into the
prompt — `buildVerifiedFacts()` deterministically counts and shape-checks
`frontmatter.faqs`, `frontmatter.citations`, and title/description/slug
lengths, and instructs the model not to contradict them. Motivated by a real
incident: a five-entry `faqs` array misread as one entry raised a false
blocker that failed an 8.0/10 post.

See [[concepts/quality-gates]], [[modules/review]], [[modules/rewrite]].
