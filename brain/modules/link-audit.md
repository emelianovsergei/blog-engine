---
type: "module"
title: "Link Audit"
description: "Outbound-link auditing and repair, shared by every path that writes a post. Generation had this logic inline in the consumer repos; the rewrite path had none at all. That asymmetry is not cosmetic: on 2026-08-18 generation stripped a denylisted DOE URL, the reviewer asked for a cited statistic, and the auto-fix rewrite — which had never heard of the link policy — put the exact same URL back. The post failed `@smoke` and could never merge. Policy is evaluated before the network because it is free, deterministic and authoritative. Only survivors cost a request. A link that cannot be verified (403 bot-block, 429, network flake) is NEVER treated as dead — deleting a good citation because a runner got throttled is its own bug."
tags: ["module"]
timestamp: "2026-08-19"
sources: ["src/link-audit.ts"]
source_hash: "ecb1cd82f8b04911"
---
# Link Audit

Outbound-link auditing and repair, shared by every path that writes a post. Generation had this logic inline in the consumer repos; the rewrite path had none at all. That asymmetry is not cosmetic: on 2026-08-18 generation stripped a denylisted DOE URL, the reviewer asked for a cited statistic, and the auto-fix rewrite — which had never heard of the link policy — put the exact same URL back. The post failed `@smoke` and could never merge. Policy is evaluated before the network because it is free, deterministic and authoritative. Only survivors cost a request. A link that cannot be verified (403 bot-block, 429, network flake) is NEVER treated as dead — deleting a good citation because a runner got throttled is its own bug.

**Source File**: [src/link-audit.ts](file:///home/jaysonlee/Projects/blog-engine/src/link-audit.ts)

## Related

- [[modules/links]]
- [[modules/link-repair]]

## API Interface

### `LinkAuditResult`
*No description provided.*

### `AuditLinksOptions`
*No description provided.*

### `auditLinks`
*No description provided.*

### `unlinkDeadUrls`
Unlink every dead URL in `text`, keeping the surrounding prose intact.

### `FileAudit`
*No description provided.*

### `auditAndRepairFile`
Audit and repair a serialized post (frontmatter + body) in one pass. Built on `repairContent` rather than a second repair implementation: that function already edits frontmatter through the YAML document and is conservative in prose. Survivors are recomputed from the repaired text, so `unresolved` reflects the file as it will actually be written.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
