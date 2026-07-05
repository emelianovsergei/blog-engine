---
type: "module"
title: "Topic Candidate Generator"
description: "Generates a list of candidate weekly blog topics matching seasonal and weather conditions."
tags: ["generation", "llm", "candidates"]
timestamp: "2026-07-05"
sources: ["src/candidates.ts"]
---
# Topic Candidate Generator

Gemini-backed generation of weekly topic candidates.

**Source File**: [candidates.ts](file:///home/jaysonlee/Projects/blog-engine/src/candidates.ts)

## API Interface

### `DEFAULT_GENERATION_MODEL` (const)
*No description provided.*

### `GenerateCandidatesArgs` (interface)
*No description provided.*

### `generateCandidates` (async function)
Asks Gemini for `count` candidate topics. Throws if the response is empty or unparseable — the orchestrator treats that as a hard failure of the run.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
