---
type: "module"
title: "Xai"
description: "xAI Grok adapter that satisfies the structural `GeminiLike` interface, so it drops into every existing call site (candidates, review, rewrite) and the consumer generators without touching their code. Text generation maps to Chat Completions. JSON-mode requests — those passing `config.responseMimeType: \"application/json\"` + `config.responseSchema` — are satisfied with `response_format.json_schema`. Embeddings are not an xAI capability and are routed to Gemini by the composite client (see client.ts); calling `embedContent` here throws."
tags: ["module"]
timestamp: "2026-08-18"
sources: ["src/xai.ts"]
source_hash: "7e167236957844b2"
---
# Xai

xAI Grok adapter that satisfies the structural `GeminiLike` interface, so it drops into every existing call site (candidates, review, rewrite) and the consumer generators without touching their code. Text generation maps to Chat Completions. JSON-mode requests — those passing `config.responseMimeType: "application/json"` + `config.responseSchema` — are satisfied with `response_format.json_schema`. Embeddings are not an xAI capability and are routed to Gemini by the composite client (see client.ts); calling `embedContent` here throws.

**Source File**: [src/xai.ts](file:///home/jaysonlee/Projects/blog-engine/src/xai.ts)

## Related

- [[modules/types]]

## API Interface

### `XaiChatRequest`
*No description provided.*

### `XaiChatResponse`
*No description provided.*

### `XaiLike`
Minimal structural view of the xAI chat client we use.

### `GrokAdapterOptions`
*No description provided.*

### `grokAdapter`
Wrap an injected xAI client as a `GeminiLike`.

### `createGrokClient`
Build a Grok-backed `GeminiLike` from an API key. Uses stdlib `fetch` (injectable for tests) so the library keeps no hard runtime dependency on an xAI SDK.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
