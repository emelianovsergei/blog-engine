---
type: "module"
title: "Gsc"
description: "Google Search Console — the only first-party demand signal available. Autocomplete tells you the shape of the query space; it cannot tell you what this site already gets impressions for, at what position, or which queries are one push from page one. GSC can, for free, and no keyword tool can reproduce it because it is your own property's data. Hand-rolled JWT rather than pulling in `googleapis`: this library's only runtime dependency is `yaml`, and the auth flow here is one signed assertion plus one token exchange. Every entry point degrades instead of throwing. An absent credential is a normal state (the pipeline predates this signal); an EXPIRED or revoked one is not, and must be loud — a key silently rotating the pipeline back to blindness is precisely the failure mode this whole rework exists to remove."
tags: ["module"]
timestamp: "2026-09-06"
sources: ["src/gsc.ts"]
source_hash: "d5d3dd1e20daabb9"
---
# Gsc

Google Search Console — the only first-party demand signal available. Autocomplete tells you the shape of the query space; it cannot tell you what this site already gets impressions for, at what position, or which queries are one push from page one. GSC can, for free, and no keyword tool can reproduce it because it is your own property's data. Hand-rolled JWT rather than pulling in `googleapis`: this library's only runtime dependency is `yaml`, and the auth flow here is one signed assertion plus one token exchange. Every entry point degrades instead of throwing. An absent credential is a normal state (the pipeline predates this signal); an EXPIRED or revoked one is not, and must be loud — a key silently rotating the pipeline back to blindness is precisely the failure mode this whole rework exists to remove.

**Source File**: [src/gsc.ts](file:///home/jaysonlee/Projects/blog-engine/src/gsc.ts)

## Related

- [[modules/links]]

## API Interface

### `GscCredentials`
*No description provided.*

### `parseServiceAccountJson`
Tolerant parse of a service-account JSON blob (usually from an env var).

### `buildJwtAssertion`
Signed JWT assertion for the OAuth2 service-account flow.

### `GscQueryRow`
*No description provided.*

### `FetchSearchAnalyticsArgs`
*No description provided.*

### `fetchSearchAnalytics`
*No description provided.*

### `GscStatus`
*No description provided.*

### `GscSignal`
*No description provided.*

### `LoadGscSignalArgs`
*No description provided.*

### `loadGscSignal`
The one function consumers call. Never throws. `absent` (no credential) is a normal, quiet state. `unauthorized` is not — it means a key that used to work no longer does, and callers are expected to surface it rather than silently fall back to autocomplete-only.

### `OpportunityQuery`
*No description provided.*

### `OpportunityOptions`
*No description provided.*

### `findOpportunities`
Queries the site already ranks for, just not well enough to get clicks. Positions 8-25 with real impression volume are the ones a dedicated post can realistically move onto page one. This is the highest-value output of the whole GSC integration: it is specific, first-party, and no keyword tool can produce it.

### `MergedDemand`
*No description provided.*

### `mergeDemand`
Combine the two signals without averaging away what each one knows. GSC measures proven impressions but is blind to anything the site does not already rank for. Autocomplete measures breadth of the query space including the unranked. Collapsing them into a single number too early would hide both facts, so each is kept and the blend only happens when both exist.

### `GscPageSignal`
*No description provided.*

### `LoadGscPageSignalArgs`
*No description provided.*

### `loadGscPageSignal`
Like `loadGscSignal`, but with the `page` dimension so each row knows the URL it ranked. This is the input for choosing which existing post to refresh: the queries a page already earns impressions for are the ones a refreshed summary, FAQ and section can win outright.

### `RefreshablePost`
*No description provided.*

### `PickRefreshTargetArgs`
*No description provided.*

### `RefreshTarget`
*No description provided.*

### `pickRefreshTarget`
The single best post to refresh this week: the page with the most impressions sitting in the position window, that has not been touched inside the cooldown. Returns undefined when nothing qualifies, so the caller can no-op cleanly.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
