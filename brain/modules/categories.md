---
type: "module"
title: "Category Classifier"
description: "Classifies blog posts into categories and analyzes category distribution history."
tags: ["classification", "taxonomy", "history"]
timestamp: "2026-07-27"
sources: ["src/categories.ts"]
source_hash: "4b1a6f132d6b1888"
---
# Category Classifier

Config-driven topic categorization and recent-mix analysis.

**Source File**: [src/categories.ts](file:///home/jaysonlee/Projects/blog-engine/src/categories.ts)

## Related

- [[modules/types]]

## API Interface

### `RecentMix`
*No description provided.*

### `categorizeText`
Returns the id of the first category whose keywords match. When nothing matches, falls back to the LAST category — presets are ordered so the last entry is the broad catch-all (e.g. `hvac` for the HVAC + appliance set).

### `categorizePost`
*No description provided.*

### `summarizeRecentCategories`
Summarizes the categories of the most recent posts. `posts` must be ordered newest-first.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
