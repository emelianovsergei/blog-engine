---
type: "module"
title: "Google Autocomplete Client"
description: "Retrieves autocomplete suggestions from Google's search suggest API."
tags: ["google-suggest", "seo", "api-client"]
timestamp: "2026-08-19"
sources: ["src/suggest.ts"]
source_hash: "914c52c59e864b70"
---
# Google Autocomplete Client

Free, keyless search-demand signal via the Google Autocomplete/Suggest endpoint. Returns the real phrases people type. Every call degrades to an empty array on any error — this is an additive SEO signal and must never break a generation run.

**Source File**: [src/suggest.ts](file:///home/jaysonlee/Projects/blog-engine/src/suggest.ts)

## API Interface

### `FetchLike`
Minimal structural subset of the global `fetch` we depend on. The second parameter is optional so existing single-argument test stubs stay assignable, while real calls can finally send a browser User-Agent — the absence of one is what makes an endpoint answer 403 to a CI runner.

### `SuggestOutcome`
Why a query returned nothing. Collapsing all of these into `[]` is what let a 50%-of-runs failure sit unnoticed: a bot-block, a rate limit and genuine zero demand were indistinguishable.

### `AutocompleteOptions`
*No description provided.*

### `fetchAutocompleteResult`
Fetches autocomplete suggestions for a single query. The `client=firefox` variant returns a clean JSON array: `["query", ["sugg1", "sugg2", ...]]`.

### `fetchAutocomplete`
Back-compatible wrapper: suggestions only, empty on any failure.

### `headTerm`
Reduce a topic sentence to the 2-4 word head term people actually type. Word ORDER is preserved because Autocomplete is a prefix API: "furnace blowing cold air" completes, the same words in any other order do not. The previous implementation stripped stopwords and took the first five tokens of the resulting bag, producing strings that are not a prefix of any real query — which is why the demand signal was unavailable in half of all production runs.

### `SeedKind`
*No description provided.*

### `SeedQuery`
*No description provided.*

### `BuildSeedQueriesArgs`
*No description provided.*

### `buildSeedQueries`
Natural, prefix-shaped queries built around the topic's head term. Every seed must read like something a person would actually type, because anything else returns zero completions. The raw topic sentence is never sent: long sentences have no autocomplete entries at all.

### `DEFAULT_SUGGESTION_DENYLIST`
Phrases that share a category word but belong to an unrelated intent — video games, job seekers, schooling. Roughly a quarter of the harvested corpus was this: "how to furnace in minecraft", "hvac sacramento salary".

### `RelevanceOptions`
*No description provided.*

### `isRelevantSuggestion`
True when a suggestion is plausibly the same subject as `head`. demand.ts always filtered by shared content word; keywords.ts never did, which is how game and job queries reached the strategist prompt labelled "Real autocomplete phrases people search".

### `expandSeedQueries`
@deprecated Category-keyword-shaped seeds that ignore the chosen topic. Use {@link buildSeedQueries}, which is prefix-shaped and topic-led.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
