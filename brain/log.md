---
type: "log"
title: "Developer Wiki Change Log"
description: "Track of major modifications and releases."
tags: ["log", "changelog"]
timestamp: "2026-08-18"
sources: []
---
# Developer Wiki Change Log

## [2026-08-18] ingest | 2 module page(s) updated

- [[modules/client|Unified Model Client]] — Abstract client interface managing fallback routing, retries, and multi-model configuration.
- [[modules/xai|Xai]] — xAI Grok adapter that satisfies the structural `GeminiLike` interface, so it drops into every existing call site (candidates, review, rewrite) and the consumer 

## [2026-08-18] ingest | 6 module page(s) updated

- [[modules/candidates|Topic Candidate Generator]] — Generates a list of candidate weekly blog topics matching seasonal and weather conditions.
- [[modules/client|Unified Model Client]] — Abstract client interface managing fallback routing, retries, and multi-model configuration.
- [[modules/review|Blog Post Reviewer]] — Evaluates blog post drafts against SEO, keyword target, and quality rubric criteria.
- [[modules/rewrite|Blog Post Rewriter]] — Rewrites blog posts using LLMs to fix issues highlighted in the review rubric.
- [[modules/types|Type Definitions]] — Centralized TypeScript interfaces and type definitions used throughout the engine.
- [[modules/xai|Xai]] — xAI Grok adapter that satisfies the structural `GeminiLike` interface, so it drops into every existing call site (candidates, review, rewrite) and the consumer 

## [2026-08-18] ingest | 10 module page(s) updated

- [[modules/candidates|Topic Candidate Generator]] — Generates a list of candidate weekly blog topics matching seasonal and weather conditions.
- [[modules/client|Unified Model Client]] — Abstract client interface managing fallback routing, retries, and multi-model configuration.
- [[modules/index|Index]] — Public API of the blog topic-selection engine.
- [[modules/keywords|Keyword Researcher]] — Extracts and clusters search query suggestions into structured keyword profiles.
- [[modules/review|Blog Post Reviewer]] — Evaluates blog post drafts against SEO, keyword target, and quality rubric criteria.
- [[modules/rewrite|Blog Post Rewriter]] — Rewrites blog posts using LLMs to fix issues highlighted in the review rubric.
- [[modules/xai|Xai]] — xAI Grok adapter that satisfies the structural `GeminiLike` interface, so it drops into every existing call site (candidates, review, rewrite) and the consumer 
- [[modules/cli-review|Cli Review]] — blog-engine-review — AI quality review for a draft blog post.
- [[modules/cli-rewrite|Cli Rewrite]] — blog-engine-rewrite — apply a previous review's feedback to revise a post.
- [[modules/cli-shared|Cli Shared]] — Shared CLI helpers — argv parsing, config composition, Gemini client construction.

## [2026-08-02] Delivery guarantee: examples/ resync, watchdog, watch-merge (#20, #21, #22)

- No `src/` changes today — all three PRs are workflow/tooling. `wiki:ingest` is
  hash-gated on `src/*.ts`, so it correctly reported "no pages updated"; the
  wiki gap was at the concept level, documented here by hand. (That gap is
  itself an instance of [[concepts/unreachable-success-path]]: the guard passed
  because it cannot see this class of change.)
- **#20** — resynced `examples/` with the copies running in pulse/promax (the
  templates had drifted ~3 weeks and shipped a merge gate missing the CI gate,
  head-SHA pin, label re-read, link-repair skip and `actions: read`), and added
  the two missing workflows: `autoblog-watchdog.yml` and
  `generate-blog-post.yml`. Rewrite moved to Sonnet 5. New concept page:
  [[concepts/delivery-guarantee]].
- **#21** — `/autoblog rewrite` posted a "revision landed" comment gated on
  `hashFiles('change-notes.md')` alone, so a byte-identical model response
  produced a green run and a sticky comment describing revisions that were
  never committed. Now gated on the commit; the no-op path reuses the same
  sticky header so it replaces a stale success comment.
- **#22** — added `scripts/watch-merge.sh` (dev tool, not published). Codex
  posts a review body only when it *has* findings, so the obvious
  "review-body SHA == head" approval predicate is unsatisfiable exactly when
  the PR is fine. It reads `commit_id` off the review object instead of the
  prose, and binds a bare 👍 to a head by *witnessing* the head each poll rather
  than inferring activation from committer dates or check-run starts (both
  rejected as leaky). Bare-reaction merges are off by default — a clean, green
  PR with only a 👍 exits 8 rather than merging. Fails closed on any unreadable
  state and re-reads the PR after merging.
- New concept pages: [[concepts/delivery-guarantee]],
  [[concepts/unreachable-success-path]].

## [2026-07-27] ingest | 1 module page(s) updated

- [[modules/link-repair|Link Repair]] — The edits a link sweep makes to published MDX once `links.ts` has decided a URL is dead.

## [2026-07-27] ingest | 2 module page(s) updated

- [[modules/index|Index]] — Public API of the blog topic-selection engine.
- [[modules/link-repair|Link Repair]] — The edits a link sweep makes to published MDX once `links.ts` has decided a URL is dead.

## [2026-07-27] ingest | 1 module page(s) updated

- [[modules/links|Links]] — Outbound-link policy and liveness checking for generated blog content.

## [2026-07-27] ingest | 1 module page(s) updated

- [[modules/links|Links]] — Outbound-link policy and liveness checking for generated blog content.

## [2026-07-27] ingest | 1 module page(s) updated

- [[modules/links|Links]] — Outbound-link policy and liveness checking for generated blog content.

## [2026-07-27] ingest | 23 module page(s) updated

- [[modules/anthropic|Anthropic Provider Adapter]] — Connects the blog-engine to Anthropic Claude models for review and rewriting tasks.
- [[modules/candidates|Topic Candidate Generator]] — Generates a list of candidate weekly blog topics matching seasonal and weather conditions.
- [[modules/categories|Category Classifier]] — Classifies blog posts into categories and analyzes category distribution history.
- [[modules/client|Unified Model Client]] — Abstract client interface managing fallback routing, retries, and multi-model configuration.
- [[modules/config|Configuration Store]] — Contains category definitions, location defaults, and taxonomy profiles.
- [[modules/dedup|Semantic Deduplicator]] — Uses vector embeddings to filter out candidate topics that overlap with existing posts.
- [[modules/demand|Search Demand Scorer]] — Scores candidate blog topics against real search suggest frequency signals.
- [[modules/index|Index]] — Public API of the blog topic-selection engine.
- [[modules/keywords|Keyword Researcher]] — Extracts and clusters search query suggestions into structured keyword profiles.
- [[modules/links|Links]] — Outbound-link policy and liveness checking for generated blog content.
- [[modules/orchestrator|Topic Selection Orchestrator]] — Orchestrates the selection of weekly blog topics using seasonal, weather, and keyword demand signals.
- [[modules/planning|Topic Alignment Guard]] — Ensures post topics align to planned keywords, target areas, and accuracy guidelines.
- [[modules/rank|Topic Ranker]] — Ranks candidate topics by combining category mix, weather anomaly, and demand scores.
- [[modules/review|Blog Post Reviewer]] — Evaluates blog post drafts against SEO, keyword target, and quality rubric criteria.
- [[modules/rewrite|Blog Post Rewriter]] — Rewrites blog posts using LLMs to fix issues highlighted in the review rubric.
- [[modules/season|Season Context Mapper]] — Maps calendar dates and time zones to seasons and microclimate profiles.
- [[modules/suggest|Google Autocomplete Client]] — Retrieves autocomplete suggestions from Google's search suggest API.
- [[modules/types|Type Definitions]] — Centralized TypeScript interfaces and type definitions used throughout the engine.
- [[modules/weather|Weather Client]] — Fetches regional weather data and detects anomalies like heat waves or cold snaps.
- [[modules/cli-frontmatter|Cli Frontmatter]] — YAML frontmatter reader/writer for the CLI tools, backed by the `yaml` package.
- [[modules/cli-review|Cli Review]] — blog-engine-review — AI quality review for a draft blog post.
- [[modules/cli-rewrite|Cli Rewrite]] — blog-engine-rewrite — apply a previous review's feedback to revise a post.
- [[modules/cli-shared|Cli Shared]] — Shared CLI helpers — argv parsing, config composition, Gemini client construction.

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
