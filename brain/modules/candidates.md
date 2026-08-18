---
type: "module"
title: "Topic Candidate Generator"
description: "Generates a list of candidate weekly blog topics matching seasonal and weather conditions."
tags: ["generation", "llm", "candidates"]
timestamp: "2026-08-18"
sources: ["src/candidates.ts"]
source_hash: "aa78b7e8ad13f483"
---
# Topic Candidate Generator

Gemini-backed generation of weekly topic candidates.

**Source File**: [src/candidates.ts](file:///home/jaysonlee/Projects/blog-engine/src/candidates.ts)

## Related

- [[modules/categories]]
- [[modules/season]]
- [[modules/types]]

## API Interface

### `DEFAULT_GENERATION_MODEL`
*No description provided.*

### `GenerateCandidatesArgs`
*No description provided.*

### `generateCandidates`
Asks Gemini for `count` candidate topics. Throws if the response is empty or unparseable — the orchestrator treats that as a hard failure of the run.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
