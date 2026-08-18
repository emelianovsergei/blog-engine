---
type: "module"
title: "Unified Model Client"
description: "Abstract client interface managing fallback routing, retries, and multi-model configuration."
tags: ["llm-client", "retry", "fallback"]
timestamp: "2026-08-18"
sources: ["src/client.ts"]
source_hash: "f3ac63d7e4022e79"
---
# Unified Model Client

Composite `GeminiLike` client: Grok or Claude primary (with retry), Gemini fallback. Provider is chosen by the per-call model-id prefix, so every existing call site keeps passing its own model string: - "grok-*"    → Grok (transient-retry); on any failure, fall back to Claude (if configured, remapped to `claudeFallbackModel`) then Gemini (`geminiFallbackModel`). Missing Grok uses the same chain so a 0.10.0 upgrade without XAI_API_KEY still hits Claude instead of silently downgrading to Flash. - "claude-*"  → Claude (transient-retry); same Gemini fallback. - "gemini-*"  → Gemini directly (same transient-retry). - embeddings  → always Gemini (neither Grok nor Claude has an embedding API). `@google/genai` 503 "high demand" outages, `@anthropic-ai/sdk` hiccups, and xAI HTTP blips are absorbed: transient errors retry with exponential backoff, and a dead primary degrades to the other provider rather than failing the run.

**Source File**: [src/client.ts](file:///home/jaysonlee/Projects/blog-engine/src/client.ts)

## Related

- [[modules/anthropic]]
- [[modules/xai]]
- [[modules/types]]

## API Interface

### `isTransientError`
True for retryable upstream errors (rate limits, 5xx, model-overload signals).

### `CompositeClientOptions`
*No description provided.*

### `createCompositeClient`
*No description provided.*

### `createModelClient`
Build the composite client from credentials. Grok is included when an xAI key is supplied; Claude when an Anthropic key is supplied. Otherwise the client degrades to Gemini-only (embeddings still require Gemini).

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
