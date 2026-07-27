---
type: "module"
title: "Topic Selection Orchestrator"
description: "Orchestrates the selection of weekly blog topics using seasonal, weather, and keyword demand signals."
tags: ["orchestrator", "topic-selection", "pipeline"]
timestamp: "2026-07-27"
sources: ["src/orchestrator.ts"]
source_hash: "9600be70dff63497"
---
# Topic Selection Orchestrator

Ties the engine modules together into the public `selectWeeklyTopic` entry point.

**Source File**: [src/orchestrator.ts](file:///home/jaysonlee/Projects/blog-engine/src/orchestrator.ts)

## Related

- [[modules/candidates]]
- [[modules/categories]]
- [[modules/demand]]
- [[modules/dedup]]
- [[modules/rank]]
- [[modules/season]]
- [[modules/weather]]
- [[modules/types]]

## API Interface

### `selectWeeklyTopic`
Selects the topic for this week's blog post: pulls live weather, generates candidate topics aligned to season + weather, rejects semantic near-duplicates, and ranks the survivors. Returns a topic that maps directly onto the existing per-repo `planPost` seed shape.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
