---
type: "module"
title: "Google Autocomplete Client"
description: "Retrieves autocomplete suggestions from Google's search suggest API."
tags: ["google-suggest", "seo", "api-client"]
timestamp: "2026-07-05"
sources: ["src/suggest.ts"]
---
# Google Autocomplete Client

Free, keyless search-demand signal via the Google Autocomplete/Suggest endpoint. Returns the real phrases people type. Every call degrades to an empty array on any error — this is an additive SEO signal and must never break a generation run.

**Source File**: [suggest.ts](file:///home/jaysonlee/Projects/blog-engine/src/suggest.ts)

## API Interface

### `FetchLike` (type)
Minimal structural subset of the global `fetch` we depend on. */

### `AutocompleteOptions` (interface)
*No description provided.*

### `fetchAutocomplete` (async function)
Fetches autocomplete suggestions for a single query. The `client=firefox` variant returns a clean JSON array: `["query", ["sugg1", "sugg2", ...]]`.

### `expandSeedQueries` (function)
Builds a small, deduplicated set of seed queries from the topic, the category's keywords, and the top service area. Capped so the number of outbound fetches stays bounded.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
