---
type: "module"
title: "Search Demand Scorer"
description: "Scores candidate blog topics against real search suggest frequency signals."
tags: ["demand", "ranking", "seo"]
timestamp: "2026-07-05"
sources: ["src/demand.ts"]
---
# Search Demand Scorer

Search-demand scoring for topic candidates. Uses the free Google Autocomplete signal (via suggest.ts) to estimate how much real search interest a candidate topic has, so ranking can bias toward topics people actually search for. Like dedup, this is additive and never throws — on any failure it returns all-zero scores with `available: false`, and ranking simply ignores the (uniformly zero) demand term.

**Source File**: [demand.ts](file:///home/jaysonlee/Projects/blog-engine/src/demand.ts)

## API Interface

### `DemandResult` (interface)
*No description provided.*

### `toSearchQuery` (function)
Reduces a topic sentence to a short keyword query suitable for autocomplete. */

### `ScoreDemandArgs` (interface)
*No description provided.*

### `scoreDemand` (async function)
Scores each candidate by how many real autocomplete suggestions its core query yields that are actually relevant to the topic (share a content word). More relevant completions => more demonstrated search demand.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
