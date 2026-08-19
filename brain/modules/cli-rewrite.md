---
type: "module"
title: "Cli Rewrite"
description: "blog-engine-rewrite — apply a previous review's feedback to revise a post. Reads a markdown post and a prior ReviewResult JSON; writes the revised markdown back to the same post path. Invoked from CI two ways: the review workflow's automatic fix-on-failure steps (bounded by a CI-side attempt cap), and the user-initiated `/autoblog rewrite` slash-command workflow. Exit codes: 0  Revised post written. 1  ERROR — unexpected failure."
tags: ["module"]
timestamp: "2026-08-19"
sources: ["src/cli/rewrite.ts"]
source_hash: "5a70f2d9ef3ede6c"
---
# Cli Rewrite

blog-engine-rewrite — apply a previous review's feedback to revise a post. Reads a markdown post and a prior ReviewResult JSON; writes the revised markdown back to the same post path. Invoked from CI two ways: the review workflow's automatic fix-on-failure steps (bounded by a CI-side attempt cap), and the user-initiated `/autoblog rewrite` slash-command workflow. Exit codes: 0  Revised post written. 1  ERROR — unexpected failure.

**Source File**: [src/cli/rewrite.ts](file:///home/jaysonlee/Projects/blog-engine/src/cli/rewrite.ts)

## Related

- [[modules/rewrite]]
- [[modules/link-audit]]
- [[modules/links]]
- [[modules/review]]
- [[modules/cli-frontmatter]]
- [[modules/cli-shared]]

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
