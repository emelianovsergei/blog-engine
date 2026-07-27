---
type: "module"
title: "Link Repair"
description: "The edits a link sweep makes to published MDX once `links.ts` has decided a URL is dead. Split from the crawling and file-writing in the consumer repos so the rewriting rules can be tested directly, and kept HERE rather than in each consumer because it was duplicated in two of them for exactly as long as it took to accumulate six defects — a stray `!` from a removed image, an empty `[](target)` link, a destination chopped at a nested paren, orphaned `****` emphasis, and two argument-shape bugs. Every one existed in both copies simultaneously, and each was found in whichever repo happened to be reviewed first. One implementation, one set of tests, one place to fix. These run unattended against live content — a bug here ships to production prose."
tags: ["module"]
timestamp: "2026-07-27"
sources: ["src/link-repair.ts"]
source_hash: "07709366d0178c45"
---
# Link Repair

The edits a link sweep makes to published MDX once `links.ts` has decided a URL is dead. Split from the crawling and file-writing in the consumer repos so the rewriting rules can be tested directly, and kept HERE rather than in each consumer because it was duplicated in two of them for exactly as long as it took to accumulate six defects — a stray `!` from a removed image, an empty `[](target)` link, a destination chopped at a nested paren, orphaned `****` emphasis, and two argument-shape bugs. Every one existed in both copies simultaneously, and each was found in whichever repo happened to be reviewed first. One implementation, one set of tests, one place to fix. These run unattended against live content — a bug here ships to production prose.

**Source File**: [src/link-repair.ts](file:///home/jaysonlee/Projects/blog-engine/src/link-repair.ts)

## API Interface

### `unlinkUrl`
Remove a dead URL where doing so cannot damage the sentence around it. Two forms are safe to rewrite unattended: - `[anchor text](dead)` -> `anchor text`. The anchor survives, so whatever grammatical role the link played is still filled. - a URL alone inside parentheses -> gone with its parens, the way any parenthetical aside can be lifted out. A **bare or autolinked URL in running prose is deliberately left alone**, because deleting it changes what the sentence says. Real examples from this repo's content: `— see https://…` becomes `— see .`; `Sources: URL, and …` becomes `Sources:, and …`; a link-only list item becomes a naked `-`. The sweep detects the survivor, reports it, and withholds the policy denial so a human repairs the prose rather than publishing a broken sentence. `siblings` is every URL in the same file. A dead URL is very often a prefix of a healthy one (`/page` retired, `/page/details` alive), so the destination has to match exactly — otherwise the repair guts a link that was never broken.

### `stripDeadCitations`
Drop whole `citations:` entries whose `url` is dead. Text-replacing the URL inside frontmatter would leave `{ name: "…", url: "" }` behind, and a consumer that renders citations into JSON-LD emits that empty string straight into the structured data — trading a dead link for malformed markup. The entry has to go as a unit, which means editing the YAML as YAML. `parseDocument` keeps comments and scalar styles on untouched nodes, so the repair diff stays limited to the entries actually removed.

### `repairContent`
Repair one MDX file: citations structurally, prose textually. The split is not cosmetic. `unlinkUrl` collapses runs of spaces, which is right for a sentence and catastrophic for YAML — letting it near the frontmatter flattens every citation entry's indentation and corrupts the block. Frontmatter is only ever edited through the YAML document. A dead URL living in some *other* frontmatter field is deliberately left alone: blanking an arbitrary YAML value is the same class of mistake as leaving `url: ""` behind. The caller detects the leftover and flags it for a human instead.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
