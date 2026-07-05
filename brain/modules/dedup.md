---
type: "module"
title: "Semantic Deduplicator"
description: "Uses vector embeddings to filter out candidate topics that overlap with existing posts."
tags: ["dedup", "embeddings", "vector"]
timestamp: "2026-07-05"
sources: ["src/dedup.ts"]
---
# Semantic Deduplicator

Semantic duplicate detection via Gemini embeddings + cosine similarity.

**Source File**: [dedup.ts](file:///home/jaysonlee/Projects/blog-engine/src/dedup.ts)

## API Interface

### `DEFAULT_EMBEDDING_MODEL` (const)
*No description provided.*

### `DEFAULT_SIMILARITY_THRESHOLD` (const)
Candidates at or above this cosine similarity to an existing post are rejected. */

### `DuplicationScore` (interface)
*No description provided.*

### `DuplicationResult` (interface)
*No description provided.*

### `cosineSimilarity` (function)
Cosine similarity of two equal-length-ish vectors. */

### `ScoreDuplicationArgs` (interface)
*No description provided.*

### `scoreDuplication` (async function)
Scores every candidate by its nearest existing post. If the embedding call fails, returns all-zero scores with `available: false` so the run continues on slug-only + prompt-level dedup rather than failing.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
