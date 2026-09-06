---
type: "module"
title: "Refresh"
description: "Refresh an existing post against the Search Console queries it already ranks for. Two modes: - \"refresh\": regenerate the GEO fields (summary, faqs, targetKeyword, keywords, citations, howTo) AND lightly revise the body — keep every existing H2, add at most one new H2 that answers the top uncovered query, stay within ±20% of the length. Used by the weekly refresh job. - \"backfill\": regenerate only the requested fields; the body is kept verbatim. Used to bring older posts up to the current template. `updated` is set to the run date only when something actually changed. The body may never contain an FAQ section; required headings must survive with exact case; `targetKeyword` must be on-topic for the title; category is never model-chosen. Any of those failing throws — the caller (CLI) exits non-zero and the workflow opens no PR."
tags: ["module"]
timestamp: "2026-09-06"
sources: ["src/refresh.ts"]
source_hash: "dcb926ceda8f75cb"
---
# Refresh

Refresh an existing post against the Search Console queries it already ranks for. Two modes: - "refresh": regenerate the GEO fields (summary, faqs, targetKeyword, keywords, citations, howTo) AND lightly revise the body — keep every existing H2, add at most one new H2 that answers the top uncovered query, stay within ±20% of the length. Used by the weekly refresh job. - "backfill": regenerate only the requested fields; the body is kept verbatim. Used to bring older posts up to the current template. `updated` is set to the run date only when something actually changed. The body may never contain an FAQ section; required headings must survive with exact case; `targetKeyword` must be on-topic for the title; category is never model-chosen. Any of those failing throws — the caller (CLI) exits non-zero and the workflow opens no PR.

**Source File**: [src/refresh.ts](file:///home/jaysonlee/Projects/blog-engine/src/refresh.ts)

## Related

- [[modules/categories]]
- [[modules/links]]
- [[modules/planning]]
- [[modules/review]]
- [[modules/rubric]]
- [[modules/types]]

## API Interface

### `DEFAULT_REFRESH_MODEL`
*No description provided.*

### `RefreshField`
*No description provided.*

### `ALL_REFRESH_FIELDS`
*No description provided.*

### `RankingQuery`
*No description provided.*

### `RefreshBlogPostArgs`
*No description provided.*

### `RefreshHowTo`
*No description provided.*

### `RefreshResult`
*No description provided.*

### `refreshBlogPost`
*No description provided.*

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
