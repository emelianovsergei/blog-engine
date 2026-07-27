---
type: "module"
title: "Semantic Deduplicator"
description: "Uses vector embeddings to filter out candidate topics that overlap with existing posts."
tags: ["dedup", "embeddings", "vector"]
timestamp: "2026-07-27"
sources: ["src/dedup.ts"]
source_hash: "74fa3e1830e42bac"
---
# Semantic Deduplicator

Semantic duplicate detection via Gemini embeddings + cosine similarity.

**Source File**: [src/dedup.ts](file:///home/jaysonlee/Projects/blog-engine/src/dedup.ts)

## Related

- [[modules/types]]

## API Interface

### `DEFAULT_EMBEDDING_MODEL`
*No description provided.*

### `DEFAULT_SIMILARITY_THRESHOLD`
Candidates at or above this cosine similarity to an existing post are rejected.

### `DuplicationScore`
*No description provided.*

### `DuplicationResult`
*No description provided.*

### `cosineSimilarity`
Cosine similarity of two equal-length-ish vectors.

### `ScoreDuplicationArgs`
*No description provided.*

### `scoreDuplication`
Scores every candidate by its nearest existing post. If the embedding call fails, returns all-zero scores with `available: false` so the run continues on slug-only + prompt-level dedup rather than failing.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
