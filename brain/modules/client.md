---
type: "module"
title: "Unified Model Client"
description: "Abstract client interface managing fallback routing, retries, and multi-model configuration."
tags: ["llm-client", "retry", "fallback"]
timestamp: "2026-07-02"
sources: ["src/client.ts"]
---
# Unified Model Client

Composite `GeminiLike` client: Claude primary (with retry), Gemini fallback. Provider is chosen by the per-call model-id prefix, so every existing call site keeps passing its own model string: - "claude-*"  → Claude (transient-retry); on any failure, fall back to Gemini using `geminiFallbackModel`. If no Claude client is configured, go straight to the Gemini fallback. - "gemini-*"  → Gemini directly (same transient-retry). - embeddings  → always Gemini (Claude has no embedding API). Both `@google/genai` 503 "high demand" outages and `@anthropic-ai/sdk` hiccups are absorbed: transient errors retry with exponential backoff, and a dead primary degrades to the other provider rather than failing the run.

**Source File**: [client.ts](file:///home/jaysonlee/Projects/blog-engine/src/client.ts)

## API Interface

### `isTransientError` (function)
True for retryable upstream errors (rate limits, 5xx, model-overload signals). */

### `CompositeClientOptions` (interface)
*No description provided.*

### `createCompositeClient` (function)
*No description provided.*

### `createModelClient` (async function)
Build the composite client from credentials. Claude is included only when an Anthropic key is supplied; otherwise the client degrades to Gemini-only.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
