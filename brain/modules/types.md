---
type: "module"
title: "Type Definitions"
description: "Centralized TypeScript interfaces and type definitions used throughout the engine."
tags: ["types", "typescript", "interfaces"]
timestamp: "2026-09-06"
sources: ["src/types.ts"]
source_hash: "8d760807bcd91419"
---
# Type Definitions

*No summary available.*

**Source File**: [src/types.ts](file:///home/jaysonlee/Projects/blog-engine/src/types.ts)

## Related

- [[modules/gsc]]
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
