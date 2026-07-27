---
type: "module"
title: "Configuration Store"
description: "Contains category definitions, location defaults, and taxonomy profiles."
tags: ["config", "constants", "taxonomy"]
timestamp: "2026-07-27"
sources: ["src/config.ts"]
source_hash: "8f09eda46c61eb46"
---
# Configuration Store

Shared presets. Each consuming site composes an `EngineConfig` from its own business constants plus one of the category presets below — the category set is the single intended difference between the PRO MAX and PULSE sites.

**Source File**: [src/config.ts](file:///home/jaysonlee/Projects/blog-engine/src/config.ts)

## Related

- [[modules/types]]

## API Interface

### `SACRAMENTO_LOCATION`
Downtown Sacramento — both sites serve the same metro.

### `HVAC_CATEGORIES`
HVAC-only category set (PULSE). Four sub-buckets give the rotation logic enough variety to spread topics across the heating/cooling/air/efficiency space without ever leaving HVAC.

### `HVAC_APPLIANCE_CATEGORIES`
HVAC + appliance + rebate category set (PRO MAX). Order matters: `rebate` is checked first because rebate posts often also mention HVAC keywords.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
