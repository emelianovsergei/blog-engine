---
type: "module"
title: "Links"
description: "Outbound-link policy and liveness checking for generated blog content. Why this exists: the 2026-07-25 weekly run generated a perfectly good post that cited `energy.gov/energysaver/` and `energystar.gov/campaign/`. Both trees had been retired days earlier, a downstream Playwright denylist caught them, and the whole run was discarded — post and all. The generator had no way to know: citation validation was `new URL(...)`, which happily accepts a 404. So links are validated at *generation* time against two independent signals: 1. Policy — a repo-owned list of known-dead URL fragments and banned domains, shared verbatim with the consumer repo's tests so a rule added in one place reaches the generator immediately. 2. Liveness — an actual HTTP fetch with a real browser User-Agent, including soft-404 detection for the very common \"deep path now 302s to the homepage\" retirement pattern. A link that cannot be *proven* dead (network flake, 403 bot-block, rate limit) is reported as `unverified`, never as dead. Deleting a good citation because a CI runner got throttled would be its own kind of failure."
tags: ["module"]
timestamp: "2026-07-27"
sources: ["src/links.ts"]
source_hash: "39e2246b2993d051"
---
# Links

Outbound-link policy and liveness checking for generated blog content. Why this exists: the 2026-07-25 weekly run generated a perfectly good post that cited `energy.gov/energysaver/` and `energystar.gov/campaign/`. Both trees had been retired days earlier, a downstream Playwright denylist caught them, and the whole run was discarded — post and all. The generator had no way to know: citation validation was `new URL(...)`, which happily accepts a 404. So links are validated at *generation* time against two independent signals: 1. Policy — a repo-owned list of known-dead URL fragments and banned domains, shared verbatim with the consumer repo's tests so a rule added in one place reaches the generator immediately. 2. Liveness — an actual HTTP fetch with a real browser User-Agent, including soft-404 detection for the very common "deep path now 302s to the homepage" retirement pattern. A link that cannot be *proven* dead (network flake, 403 bot-block, rate limit) is reported as `unverified`, never as dead. Deleting a good citation because a CI runner got throttled would be its own kind of failure.

**Source File**: [src/links.ts](file:///home/jaysonlee/Projects/blog-engine/src/links.ts)

## API Interface

### `LinkPolicy`
Repo-owned constraints on which outbound URLs may appear in content.

### `EMPTY_LINK_POLICY`
*No description provided.*

### `parseLinkPolicy`
Parse a raw policy document (JSON) into a `LinkPolicy`, tolerating junk.

### `policyViolation`
Return a human-readable reason when `url` breaks the policy, else undefined. Purely textual — no network access, so it is safe to run on every candidate.

### `extractLinks`
Extract every absolute http(s) URL from raw MDX — frontmatter citations and body links alike. The 2026-07 sweep found dead links in post *bodies* that a frontmatter-only scan missed, so this deliberately scans the whole file.

### `LinkCheckResult`
*No description provided.*

### `FetchImpl`
*No description provided.*

### `CheckLinkOptions`
*No description provided.*

### `checkLink`
Fetch one URL and decide whether it is live, dead, or unverifiable.

### `CheckLinksOptions`
*No description provided.*

### `checkLinks`
Check many URLs with bounded concurrency; each unique URL is fetched once.

### `citationGuidance`
Prompt text that hands the policy to the planning model, so dead domains are avoided at the source instead of being cleaned up afterwards.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
