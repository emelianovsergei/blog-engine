---
type: "concept"
title: "Topic Deduplication"
description: "How blog-engine avoids repeating identical or semantically similar topics."
tags: ["concepts", "embeddings", "dedup"]
timestamp: "2026-07-02"
sources: []
---
# Topic Deduplication

The engine employs a hybrid approach to guarantee that suggested blog topics remain distinct:
1. **Slug Matching**: Rejects direct string overlaps in topic slug identifiers.
2. **Semantic Comparison**: Computes vector embeddings of candidate topics using Gemini models and filters candidates that exceed a similarity threshold (e.g., 0.85) against existing published posts.

See [[modules/dedup]] for implementation details.
