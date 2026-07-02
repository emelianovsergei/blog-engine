---
type: "module"
title: "Blog Post Rewriter"
description: "Rewrites blog posts using LLMs to fix issues highlighted in the review rubric."
tags: ["rewrite", "llm-generation", "seo"]
timestamp: "2026-07-02"
sources: ["src/rewrite.ts"]
---
# Blog Post Rewriter

User-initiated revision of a failed-review blog post. Loop-safety: this is only called from the `/autoblog rewrite` slash-command workflow in consumer repos. It is never triggered automatically by a failed review. One call produces one revision; the revised post goes back through normal review like any other commit.

**Source File**: [rewrite.ts](file:///home/jaysonlee/Projects/blog-engine/src/rewrite.ts)

## API Interface

### `DEFAULT_REWRITE_MODEL` (const)
*No description provided.*

### `RewriteBlogPostArgs` (interface)
*No description provided.*

### `RewriteResult` (interface)
*No description provided.*

### `rewriteBlogPost` (async function)
Asks Gemini to revise the post to address review feedback. Throws on empty response, invalid JSON, or missing required output fields — the workflow surfaces the error and the user decides whether to retry.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
