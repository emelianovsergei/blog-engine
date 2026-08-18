---
type: "module"
title: "Type Definitions"
description: "Centralized TypeScript interfaces and type definitions used throughout the engine."
tags: ["types", "typescript", "interfaces"]
timestamp: "2026-08-18"
sources: ["src/types.ts"]
source_hash: "45274b2139bce10d"
---
# Type Definitions

Public types for the blog topic-selection engine. The engine has zero hard dependency on `@google/genai`: it accepts an injected `GeminiLike` client described structurally below, so a real `GoogleGenAI` instance satisfies it and tests can pass lightweight fakes.

**Source File**: [src/types.ts](file:///home/jaysonlee/Projects/blog-engine/src/types.ts)

## Related

- [[modules/suggest]]

## API Interface

### `GeminiLike`
Minimal structural view of the `@google/genai` client the engine uses.

### `ExistingPostLike`
A previously published post — used for category rotation and dedup.

### `CategoryDef`
One topic bucket. Order matters: categorization picks the first match.

### `GeoLocation`
*No description provided.*

### `EngineConfig`
*No description provided.*

### `WeatherAnomaly`
*No description provided.*

### `WeatherContext`
*No description provided.*

### `WeatherClient`
*No description provided.*

### `CandidateTopic`
*No description provided.*

### `SelectedTopic`
*No description provided.*

### `SelectWeeklyTopicArgs`
*No description provided.*

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
