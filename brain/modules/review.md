---
type: "module"
title: "Blog Post Reviewer"
description: "Evaluates blog post drafts against SEO, keyword target, and quality rubric criteria."
tags: ["review", "rubric", "quality-gate"]
timestamp: "2026-07-02"
sources: ["src/review.ts"]
---
# Blog Post Reviewer

AI-powered quality review of a draft blog post. Mirrors the structured-JSON pattern used by `candidates.ts`: the model is asked to emit a JSON object matching `reviewSchema`, we parse it, then compute the pass/fail gate ourselves so the verdict is deterministic and never just trusted from the model.

**Source File**: [review.ts](file:///home/jaysonlee/Projects/blog-engine/src/review.ts)

## API Interface

### `DEFAULT_REVIEW_MODEL` (const)
*No description provided.*

### `ReviewDimension` (type)
*No description provided.*

### `DimensionScore` (interface)
*No description provided.*

### `ReviewIssue` (interface)
*No description provided.*

### `ReviewGate` (interface)
*No description provided.*

### `DEFAULT_GATE` (const)
*No description provided.*

### `ReviewResult` (interface)
*No description provided.*

### `BlogPostFrontmatter` (interface)
*No description provided.*

### `ReviewBlogPostArgs` (interface)
*No description provided.*

### `reviewBlogPost` (async function)
Reviews a draft blog post. Throws if the model returned an empty response, invalid JSON, or a body missing the required dimension scores. All other shape oddities are clamped/defaulted so we always emit a usable result.

### `renderReviewMarkdown` (function)
Renders a `ReviewResult` as a Markdown summary suitable for posting as a sticky PR comment. Deterministic — used by the CLI.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
