---
type: "module"
title: "Cli Repair"
description: "blog-engine-repair — deterministically strip dead/denylisted links from a post. No model, no cost, no new prose. This exists so a red CI caused by a link violation can be healed automatically: an LLM asked to \"fix the link\" is free to rewrite the paragraph around it, which is a fresh hallucination surface for a problem that is purely mechanical. Exit codes: 0  Post is clean, or was repaired to clean. 2  Repaired, but a URL survives in prose and needs a human. 1  ERROR — unexpected failure."
tags: ["module"]
timestamp: "2026-08-19"
sources: ["src/cli/repair.ts"]
source_hash: "2231e45d78166b3d"
---
# Cli Repair

blog-engine-repair — deterministically strip dead/denylisted links from a post. No model, no cost, no new prose. This exists so a red CI caused by a link violation can be healed automatically: an LLM asked to "fix the link" is free to rewrite the paragraph around it, which is a fresh hallucination surface for a problem that is purely mechanical. Exit codes: 0  Post is clean, or was repaired to clean. 2  Repaired, but a URL survives in prose and needs a human. 1  ERROR — unexpected failure.

**Source File**: [src/cli/repair.ts](file:///home/jaysonlee/Projects/blog-engine/src/cli/repair.ts)

## Related

- [[modules/link-audit]]
- [[modules/links]]
- [[modules/cli-shared]]

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
