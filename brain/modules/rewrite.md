---
type: "module"
title: "Blog Post Rewriter"
description: "Rewrites blog posts using LLMs to fix issues highlighted in the review rubric."
tags: ["rewrite", "llm-generation", "seo"]
timestamp: "2026-07-27"
sources: ["src/rewrite.ts"]
source_hash: "85552eb680f7d0ba"
---
# Blog Post Rewriter

Revision of a failed-review blog post against the review's findings. Invoked two ways in consumer repos: automatically by the review workflow when the gate fails (autoblog-review.yml auto-fix steps), and manually via the `/autoblog rewrite` slash-command workflow as the escape hatch once auto-fix gives up. One call produces one revision; the revised post goes back through normal review like any other commit. Loop-safety lives in CI, not here: the review workflow counts `[autoblog-autofix]` marker commits on the PR branch and stops at AUTOBLOG_MAX_AUTOFIX attempts (default 2). There is deliberately no `--max-attempts` flag — the cap is only derivable from branch state, which CI owns.

**Source File**: [src/rewrite.ts](file:///home/jaysonlee/Projects/blog-engine/src/rewrite.ts)

## Related

- [[modules/types]]
- [[modules/review]]

## API Interface

### `DEFAULT_REWRITE_MODEL`
*No description provided.*

### `RewriteBlogPostArgs`
*No description provided.*

### `RewriteResult`
*No description provided.*

### `rewriteBlogPost`
Asks Gemini to revise the post to address review feedback. Throws on empty response, invalid JSON, or missing required output fields — the workflow surfaces the error and the user decides whether to retry.

## Custom Notes

- Since v0.7.0 the rewrite is ALSO triggered automatically by the review
  workflow on a genuine gate failure (exit 2) — not just by the manual
  `/autoblog rewrite` comment. Loop safety is CI-owned: `[autoblog-autofix]`
  marker commits are the attempt counter, capped by `AUTOBLOG_MAX_AUTOFIX`
  (default 2). See [[concepts/autofix-loop]].
- Auto-fix invokes it with `--model claude-sonnet-5`; deployed pulse pins
  opus for the manual rewrite path — keep those distinct when syncing
  templates to consumer repos.
