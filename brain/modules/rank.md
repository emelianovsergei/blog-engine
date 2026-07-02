---
type: "module"
title: "Topic Ranker"
description: "Ranks candidate topics by combining category mix, weather anomaly, and demand scores."
tags: ["ranking", "candidates", "pipeline"]
timestamp: "2026-07-02"
sources: ["src/rank.ts"]
---
# Topic Ranker

Scoring and selection of the winning topic candidate.

**Source File**: [rank.ts](file:///home/jaysonlee/Projects/blog-engine/src/rank.ts)

## API Interface

### `RankedCandidate` (interface)
*No description provided.*

### `RankArgs` (interface)
*No description provided.*

### `rankCandidates` (function)
*No description provided.*

### `PickResult` (interface)
*No description provided.*

### `pickBest` (function)
Picks the highest-scoring non-duplicate candidate. If every candidate is a near-duplicate, relaxes the filter and picks the most distinct one rather than failing the run.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
