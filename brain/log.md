---
type: "log"
title: "Developer Wiki Change Log"
description: "Track of major modifications and releases."
tags: ["log", "changelog"]
timestamp: "2026-08-19"
sources: []
---
# Developer Wiki Change Log

## [2026-08-19] Grok migration + six-phase quality rework

Moved the whole pipeline to Grok, then fixed the quality machinery underneath
it. Engine v0.11.0 -> v0.16.0, tests 204 -> 256, every phase verified on live
production runs rather than in tests alone.

- **Grok everywhere.** Text on `grok-4.6` (topic selection, planning, keyword
  research, writing, review, rewrite); images on `grok-imagine-image-2.0` via
  `generateGrokImage()`. Embeddings stay on Gemini — xAI has none. Fallback
  chain grok -> claude -> gemini is unchanged. `reasoning_effort` is gated by a
  behavioural probe rather than a hardcoded model list, because the xAI models
  API exposes no capability flags: send it, and on a 4xx naming the parameter,
  strip, memoise and retry. Confirmed live that `grok-4.20-0309-non-reasoning`
  rejects it while grok-4.6 accepts it.
- **Image generation had been silently broken.** `imagen-4.0-ultra-generate-001`
  was retired upstream and returned 404 on every run, so every recent post
  quietly used Pexels stock art. Now live AI images again.
- **Rewrite-path parity.** The auto-fix rewrite had no link policy and no audit,
  and reintroduced a denylisted URL that generation had stripped — leaving the
  post permanently red. See [[concepts/ci-heal]].
- **One rubric.** Writer, planner, reviewer and the deterministic checker now
  render from a single rule array. See [[concepts/shared-rubric]].
- **`humanVoice` dimension**, shipped advisory: scored and reported, excluded
  from the gate until there are enough real scores to calibrate. `overall` is an
  unweighted mean, so enforcing a cold dimension would move the bar for every
  post at once. Clear `DEFAULT_GATE.advisoryDimensions` to enforce. Scoring
  8.0-8.5 on every post so far.
- **Real demand signal.** See [[concepts/demand-signal]] — the previous one was
  unavailable in half of all runs and ~27% junk.
- **Search Console wired in.** [[modules/gsc]]. Note for future confusion: GSC
  was already set up in the *lead-scout* repo (SA granted 2026-07-16); it had
  simply never been connected to this pipeline. The service account with actual
  property access on both sites is `visibility-fetcher@pulse-hvac-automation`,
  NOT the similarly-named `google-search-console-mcp`, which has none.

**Deferred to next week:** feed `findOpportunities()` into candidate
*generation*. Topics are still invented blind and demand only re-sorts them, so
a near-miss like `ac installation citrus heights` (2,630 impressions at position
9.4) cannot surface unless the model happens to propose it. Held back so the
first fully autonomous cron run tests the shipped state on its own.

## [2026-08-19] ingest | 2 module page(s) updated

- [[modules/gsc|Gsc]] — Google Search Console — the only first-party demand signal available.
- [[modules/index|Index]] — Public API of the blog topic-selection engine.

## [2026-08-19] ingest | 5 module page(s) updated

- [[modules/demand|Search Demand Scorer]] — Scores candidate blog topics against real search suggest frequency signals.
- [[modules/index|Index]] — Public API of the blog topic-selection engine.
- [[modules/keywords|Keyword Researcher]] — Extracts and clusters search query suggestions into structured keyword profiles.
- [[modules/rank|Topic Ranker]] — Ranks candidate topics by combining category mix, weather anomaly, and demand scores.
- [[modules/suggest|Google Autocomplete Client]] — Retrieves autocomplete suggestions from Google's search suggest API.

## [2026-08-19] ingest | 4 module page(s) updated

- [[modules/index|Index]] — Public API of the blog topic-selection engine.
- [[modules/review|Blog Post Reviewer]] — Evaluates blog post drafts against SEO, keyword target, and quality rubric criteria.
- [[modules/rubric|Rubric]] — The single source of truth for what a good post is.
- [[modules/cli-rewrite|Cli Rewrite]] — blog-engine-rewrite — apply a previous review's feedback to revise a post.

## [2026-08-19] ingest | 4 module page(s) updated

- [[modules/index|Index]] — Public API of the blog topic-selection engine.
- [[modules/review|Blog Post Reviewer]] — Evaluates blog post drafts against SEO, keyword target, and quality rubric criteria.
- [[modules/rubric|Rubric]] — The single source of truth for what a good post is.
- [[modules/cli-review|Cli Review]] — blog-engine-review — AI quality review for a draft blog post.

## [2026-08-19] ingest | 9 module page(s) updated

- [[modules/candidates|Topic Candidate Generator]] — Generates a list of candidate weekly blog topics matching seasonal and weather conditions.
- [[modules/index|Index]] — Public API of the blog topic-selection engine.
- [[modules/link-audit|Link Audit]] — Outbound-link auditing and repair, shared by every path that writes a post.
- [[modules/links|Links]] — Outbound-link policy and liveness checking for generated blog content.
- [[modules/review|Blog Post Reviewer]] — Evaluates blog post drafts against SEO, keyword target, and quality rubric criteria.
- [[modules/rewrite|Blog Post Rewriter]] — Rewrites blog posts using LLMs to fix issues highlighted in the review rubric.
- [[modules/xai|Xai]] — xAI Grok adapter that satisfies the structural `GeminiLike` interface, so it drops into every existing call site (candidates, review, rewrite) and the consumer 
- [[modules/cli-repair|Cli Repair]] — blog-engine-repair — deterministically strip dead/denylisted links from a post.
- [[modules/cli-rewrite|Cli Rewrite]] — blog-engine-rewrite — apply a previous review's feedback to revise a post.

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
