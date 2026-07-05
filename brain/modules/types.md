---
type: "module"
title: "Type Definitions"
description: "Centralized TypeScript interfaces and type definitions used throughout the engine."
tags: ["types", "typescript", "interfaces"]
timestamp: "2026-07-05"
sources: ["src/types.ts"]
---
# Type Definitions

Public types for the blog topic-selection engine. The engine has zero hard dependency on `@google/genai`: it accepts an injected `GeminiLike` client described structurally below, so a real `GoogleGenAI` instance satisfies it and tests can pass lightweight fakes.

**Source File**: [types.ts](file:///home/jaysonlee/Projects/blog-engine/src/types.ts)

## API Interface

### `GeminiLike` (interface)
Minimal structural view of the `@google/genai` client the engine uses. */

### `ExistingPostLike` (interface)
A previously published post — used for category rotation and dedup. */

### `CategoryDef` (interface)
One topic bucket. Order matters: categorization picks the first match. */

### `GeoLocation` (interface)
*No description provided.*

### `EngineConfig` (interface)
*No description provided.*

### `WeatherAnomaly` (type)
*No description provided.*

### `WeatherContext` (interface)
*No description provided.*

### `WeatherClient` (interface)
*No description provided.*

### `CandidateTopic` (interface)
*No description provided.*

### `SelectedTopic` (interface)
*No description provided.*

### `SelectWeeklyTopicArgs` (interface)
*No description provided.*

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
