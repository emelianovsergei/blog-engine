---
type: "module"
title: "Cli Shared"
description: "Shared CLI helpers — argv parsing, config composition, Gemini client construction."
tags: ["module"]
timestamp: "2026-07-27"
sources: ["src/cli/shared.ts"]
source_hash: "50a0524783c3e25f"
---
# Cli Shared

Shared CLI helpers — argv parsing, config composition, Gemini client construction.

**Source File**: [src/cli/shared.ts](file:///home/jaysonlee/Projects/blog-engine/src/cli/shared.ts)

## Related

- [[modules/config]]
- [[modules/client]]
- [[modules/types]]

## API Interface

### `SiteKey`
*No description provided.*

### `CliArgs`
*No description provided.*

### `parseArgs`
*No description provided.*

### `requireFlag`
*No description provided.*

### `optionalFlag`
*No description provided.*

### `composeConfig`
*No description provided.*

### `makeGeminiClient`
Dynamically loads `@google/genai` and constructs a client. Kept dynamic so the library has no hard runtime dep on it — peer dep only.

### `makeReviewClient`
Build the composite client the review/rewrite CLIs use: Claude primary (when `ANTHROPIC_API_KEY` is set) with a Gemini fallback (when a Gemini key is set). Embeddings always route to Gemini. At least one key must be present.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
