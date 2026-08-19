---
type: "module"
title: "Keyword Researcher"
description: "Extracts and clusters search query suggestions into structured keyword profiles."
tags: ["seo", "keywords", "clustering"]
timestamp: "2026-08-19"
sources: ["src/keywords.ts"]
source_hash: "677028c0a0ac160a"
---
# Keyword Researcher

Keyword research: turns the selected topic into a real search-demand signal (via Google Autocomplete) and clusters it with the LLM into the keyword set that drives metadata, body copy, and the generated FAQ. Like dedup, this is additive and never throws — it always returns a usable `KeywordResearch`, degrading from "real demand + LLM clustering" down to "topic-only ideation" or "raw-suggestion salvage" as inputs fail.

**Source File**: [src/keywords.ts](file:///home/jaysonlee/Projects/blog-engine/src/keywords.ts)

## Related

- [[modules/suggest]]
- [[modules/types]]

## API Interface

### `DEFAULT_KEYWORD_MODEL`
*No description provided.*

### `SearchIntent`
*No description provided.*

### `DemandSignal`
*No description provided.*

### `KeywordProvenance`
*No description provided.*

### `KeywordResearch`
*No description provided.*

### `ResearchKeywordsArgs`
*No description provided.*

### `researchKeywords`
*No description provided.*

### `keywordGuidance`
The keyword block injected into the planner and writer prompts. Lives here rather than in each consumer because the consumer copies said "real Google Autocomplete demand" unconditionally — including when zero suggestions had been fetched and every phrase was model-invented.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
