---
type: "module"
title: "Xai"
description: "xAI Grok adapter that satisfies the structural `GeminiLike` interface, so it drops into every existing call site (candidates, review, rewrite) and the consumer generators without touching their code. Text generation maps to Chat Completions. JSON-mode requests — those passing `config.responseMimeType: \"application/json\"` + `config.responseSchema` — are satisfied with `response_format.json_schema`. Embeddings are not an xAI capability and are routed to Gemini by the composite client (see client.ts); calling `embedContent` here throws."
tags: ["module"]
timestamp: "2026-08-19"
sources: ["src/xai.ts"]
source_hash: "e2c4768f491db9a2"
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

### `XaiHttpError`
HTTP failure from the xAI endpoint. The message keeps the established `xAI HTTP <status>: <detail>` shape (truncated, matched by isTransientError in client.ts); `body` carries the untruncated response so the adapter can inspect what the API actually rejected.

### `GrokAdapterOptions`
*No description provided.*

### `grokAdapter`
Wrap an injected xAI client as a `GeminiLike`.

### `createGrokClient`
Build a Grok-backed `GeminiLike` from an API key. Uses stdlib `fetch` (injectable for tests) so the library keeps no hard runtime dependency on an xAI SDK.

### `GrokImageOptions`
xAI Grok Imagine image generation. Separate endpoint and model family from chat (`/v1/images/generations`, `grok-imagine-*`), so this is a standalone helper rather than part of the `GeminiLike` adapter — that interface only covers text + embeddings. Returns raw bytes: `response_format: "b64_json"` avoids a second round-trip to a signed URL that expires, which is what the caller wants when the image is about to be written to disk and committed.

### `generateGrokImage`
*No description provided.*

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
