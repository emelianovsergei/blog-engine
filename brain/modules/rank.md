---
type: "module"
title: "Topic Ranker"
description: "Ranks candidate topics by combining category mix, weather anomaly, and demand scores."
tags: ["ranking", "candidates", "pipeline"]
timestamp: "2026-07-27"
sources: ["src/rank.ts"]
source_hash: "7aa36392cce526e8"
---
# Topic Ranker

Scoring and selection of the winning topic candidate.

**Source File**: [src/rank.ts](file:///home/jaysonlee/Projects/blog-engine/src/rank.ts)

## Related

- [[modules/categories]]
- [[modules/dedup]]
- [[modules/types]]

## API Interface

### `RankedCandidate`
*No description provided.*

### `RankArgs`
*No description provided.*

### `rankCandidates`
*No description provided.*

### `PickResult`
*No description provided.*

### `pickBest`
Picks the highest-scoring non-duplicate candidate. If every candidate is a near-duplicate, relaxes the filter and picks the most distinct one rather than failing the run.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
