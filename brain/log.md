---
type: "log"
title: "Developer Wiki Change Log"
description: "Track of major modifications and releases."
tags: ["log", "changelog"]
timestamp: "2026-07-02"
sources: []
---
# Developer Wiki Change Log

## [2026-07-05] Real YAML frontmatter parser (v0.7.1)
- E2E testing of the auto-fix loop exposed the true root cause of the #227
  false blocker: `src/cli/frontmatter.ts`'s hand-rolled "minimal YAML" parser
  mangled nested `faqs`/`citations` arrays into single strings — the reviewer
  was fed corrupted frontmatter (it never miscounted), and the rewriter
  serialized `[object Object]` entries that crashed the consumer prerender
  (caught by the auto-fix build gate, exactly as designed).
- Replaced with the `yaml` package (new runtime dependency); nested
  structures now round-trip losslessly. Empty `tags:` still normalizes to [].

## [2026-07-05] Auto-fix loop on review failure (v0.7.0)
- `examples/autoblog-review.yml`: on a genuine gate fail (exit 2), automatically
  rewrite the post with Claude Sonnet (`blog-engine-rewrite`), build-validate,
  commit with an `[autoblog-autofix]` marker, and push with `AUTOBLOG_PAT` so
  review re-fires — capped at `AUTOBLOG_MAX_AUTOFIX` attempts (default 2),
  then human handoff. New concept page: [[concepts/autofix-loop]].
- `src/review.ts`: `buildVerifiedFacts()` injects deterministic faqs/citations/
  length facts into the review prompt to prevent false structural blockers.
- Default models bumped `claude-sonnet-4-6` → `claude-sonnet-5` (review,
  rewrite, keywords).

## [2026-07-01] Wiki Implementation
- Initialized Karpathy-style Obsidian wiki structure inside the repository.
- Created `scripts/wiki-ingest.ts` to parse exports and JSDocs.
- Set up `scripts/wiki-lint.ts` for graph integrity checks.
