---
type: "module"
title: "Topic Selection Orchestrator"
description: "Orchestrates the selection of weekly blog topics using seasonal, weather, and keyword demand signals."
tags: ["orchestrator", "topic-selection", "pipeline"]
timestamp: "2026-07-02"
sources: ["src/orchestrator.ts"]
---
# Topic Selection Orchestrator

Ties the engine modules together into the public `selectWeeklyTopic` entry point.

**Source File**: [orchestrator.ts](file:///home/jaysonlee/Projects/blog-engine/src/orchestrator.ts)

## API Interface

### `selectWeeklyTopic` (async function)
Selects the topic for this week's blog post: pulls live weather, generates candidate topics aligned to season + weather, rejects semantic near-duplicates, and ranks the survivors. Returns a topic that maps directly onto the existing per-repo `planPost` seed shape.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
