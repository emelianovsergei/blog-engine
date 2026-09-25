---
type: "concept"
title: "Claude Writer (Scheduled Session)"
description: "Daily posts written by a scheduled Claude session from a no-LLM brief, reviewed by a separate Claude subagent, finalized by the consumer's generator in external-plan mode."
tags: ["concepts", "autoblog", "claude", "consumers", "review"]
timestamp: "2026-09-25"
sources: ["examples/blog-brief.yml", "examples/blog-finalize.yml", "examples/AUTOBLOG_CLAUDE.md", "examples/scripts/autoblog/claude.ts"]
---
# Claude Writer (Scheduled Session)

From 2026-09-25 the consumer sites stop asking Grok to write. A scheduled
Claude session (Opus 5.5) writes one post a day per site. Pulse runs at about
5 AM PT and PRO MAX an hour later. Images stay on Grok Imagine (one call per
post, Pexels fallback). Grok generate stays as a `workflow_dispatch` fallback.

The engine's own code still does every deterministic step. The session only
supplies the judgment: topics, prose, and the review verdict.

## Pipeline

| Step | Where | What |
|---|---|---|
| Brief | `blog-brief.yml` (GitHub Action, no LLM) | `brief.json` on the side branch `autoblog-brief`. It holds `getSeasonContext`, `openMeteoWeatherClient` (weather and AQI), `loadGscSignal` plus `findOpportunities` (filtered the way the orchestrator filters them), both sites' published and pending posts, `summarizeRecentCategories`, the text of `writerRubricRules`, `plannerRubricRules` and `reviewerRubric`, the link policy, and an Autocomplete cache. |
| Candidates + rank | session, `claude.ts rank` | About 6 candidates, at least half answering a GSC opportunity. Scored with the [[modules/rank]] weights: demand 0.45, dedup 0.25, rotation 0.15, weather 0.15. Demand is `scoreDemand` and `mergeDemand`. Similarity is the session's judgment across **both** sites, not embeddings. |
| Keywords | session, `claude.ts keywords` | [[modules/keywords]] `researchKeywords` with `buildSeedQueries` and `fetchAutocompleteResult`. The clustering call goes through a relay client that Claude answers. |
| Plan + body | session, `claude.ts prompt planner|writer` | The consumer generator's own planner and writer prompts (`buildPlannerPrompt` and `buildWriterPrompt`, exported for this). |
| Check | session, `claude.ts check` | `assertPlan`, the topic lock, `checkArticleBody`, the link policy offline, then an offline run of the real generator and `blog:check --strict`. |
| Second-pass review | a separate subagent | [[modules/review]] `reviewBlogPost` through the relay client. The subagent answers the exact prompt, and the engine parses the answer and applies `computeGate()`: every gating dimension ≥ 6.0, no blockers, overall ≥ 7.0, `humanVoice` advisory ([[concepts/quality-gates]]). Up to 2 fix rounds. A post that still fails is never discarded. |
| Handoff | session | Pushes `data/blog-claude-inbox/{plan.json, body.md, meta.json, review.md}` to `blog/claude-<date>`. If its git proxy allows only the session's own `claude/*` branch, it pushes there. |
| Finalize | `blog-finalize.yml` | Checks out `main` and takes only the four inbox files from the handoff branch, so no code from that branch runs and the finalized branch is `main` plus one commit. The generator in external-plan mode. Image, [[modules/link-audit]] and unlink, frontmatter, `checkBlogPostSource` and the run report are unchanged. A `claude/*` handoff reuses `blog/claude-<date>` only when that branch was finalized from the same source branch (recorded in the `autoblog/finalized` status); otherwise it gets its own suffixed branch. Opens a draft PR labelled `autoblog` and `autoblog-claude-reviewed`, plus `autoblog-review-failed` when the review or the rule checks failed. |
| Review gate | `autoblog-review.yml` | The `claude-reviewed` job applies `autoblog-approved-pending` on a pass, but only while the post's files are unchanged since the finalize commit (the one carrying the `autoblog/finalized` status that finalize sets), except for `[autoblog-cifix]` repairs. The wiki pages and run report finalize wrote are bound the same way (commits that came from main aside). Any other edit waits for a human to add `autoblog-human-approved`, which approves the exact head it is applied to. A `[autoblog-cifix]` commit counts only if it deleted link syntax and nothing else: a link's brackets and destination, a whole image, a URL alone in parentheses, or whole citation entries. The Grok review and [[concepts/autofix-loop]] skip these PRs, and so does [[concepts/codex-heal]]. [[concepts/ci-heal]] still applies. |

## Consumer contract

The consumer generator (`scripts/generate-blog-post.ts`) must provide:

- env `BLOG_EXTERNAL_PLAN`, `BLOG_EXTERNAL_BODY` and `BLOG_EXTERNAL_META`. These skip `selectWeeklyTopic`, `researchKeywords`, `planPost` and `writeArticle`.
- env `BLOG_EXTERNAL_OFFLINE=1`: stock image, no link fetch, no IndexNow.
- Plan and body rule failures are reported in the run report (`planViolations`, `bodyViolations`), never thrown. An unsafe or already-taken slug still throws.
- exports `buildPlannerPrompt`, `buildWriterPrompt`, `checkExternalPlan`, `bodyViolations`, `loadLinkPolicy`, `RUBRIC` and `postPlanSchema`, behind a `require.main` guard so an import does not generate.
- `BLOG_PENDING_DIR` support for posts in open autoblog PRs.

`examples/scripts/autoblog/` carries the session CLI and brief builder, with
Pulse's `site.ts` as the worked example. `examples/AUTOBLOG_CLAUDE.md` is the
runbook the Routine follows.

`claude.ts` mirrors `rankCandidates` and `pickBest` because [[modules/rank]]
does not export them. Change the weights in both places, or export them.

## Trust boundary

The second-pass review runs inside the writing session, and its verdict travels in `meta.json` beside the content. The digest catches an edit made after the review. It cannot catch a session that forges its own verdict. Only a reviewer running outside the session could, which would mean an API-key review in CI. The session is trusted to run the review honestly; CI, the link audit and the human override are the backstops.

## Network

The cloud session reaches GitHub and npm only. Everything that needs the open
web is in the brief, or runs in finalize (the image and the live link audit).
Autocomplete falls back to the brief's cache: it pre-fetches both seed shapes
for every GSC opportunity and category keyword. A cache miss reads as
`blocked`, never as zero demand. Allowing `suggestqueries.google.com` in the
environment makes it live.

## Watchdog

`AUTOBLOG_EXPECTED_POSTS_PER_WEEK` now defaults to 7 in the consumer watchdog.
When set, the window is 7 days and delivery is stale after `ceil(14 / N)` days,
so 2 days at 7 a week. `blog/claude-*` heads count as delivery. The alert lists
the recent brief and finalize runs, and any `blog/claude-*` branch that never
got a PR. See [[concepts/delivery-guarantee]].
