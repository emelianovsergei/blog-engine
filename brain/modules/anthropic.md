---
type: "module"
title: "Anthropic Provider Adapter"
description: "Connects the blog-engine to Anthropic Claude models for review and rewriting tasks."
tags: ["llm-client", "claude", "adapter"]
timestamp: "2026-07-02"
sources: ["src/anthropic.ts"]
---
# Anthropic Provider Adapter

Anthropic Claude adapter that satisfies the structural `GeminiLike` interface, so it drops into every existing call site (candidates, review, rewrite) and the consumer generators without touching their code. Text generation maps to `messages.create`. JSON-mode requests — those passing `config.responseMimeType: "application/json"` + `config.responseSchema` (a plain JSON Schema) — are satisfied with a forced single-tool call, so Claude returns structured output validated against the same schema Gemini's `responseSchema` enforced. Embeddings are not a Claude capability and are routed to Gemini by the composite client (see client.ts); calling `embedContent` here throws.

**Source File**: [anthropic.ts](file:///home/jaysonlee/Projects/blog-engine/src/anthropic.ts)

## API Interface

### `AnthropicContentBlock` (interface)
A content block in an Anthropic message response. */

### `AnthropicMessage` (interface)
*No description provided.*

### `AnthropicCreateRequest` (interface)
*No description provided.*

### `AnthropicLike` (interface)
Minimal structural view of the `@anthropic-ai/sdk` client we use. */

### `ClaudeAdapterOptions` (interface)
*No description provided.*

### `claudeAdapter` (function)
Wrap an injected Anthropic client as a `GeminiLike`. */

### `createClaudeClient` (async function)
Build a Claude-backed `GeminiLike` from an API key. Dynamically imports `@anthropic-ai/sdk` so the library keeps no hard runtime dependency on it.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
