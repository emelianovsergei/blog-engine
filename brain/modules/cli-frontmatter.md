---
type: "module"
title: "Cli Frontmatter"
description: "YAML frontmatter reader/writer for the CLI tools, backed by the `yaml` package. This replaced a hand-rolled \"minimal subset\" parser that silently mangled nested structures: a `faqs:` array of {question, answer} mappings parsed as a single string, which fed the reviewer corrupted frontmatter (the #227 \"only one FAQ\" false blocker) and made the rewriter serialize `[object Object]` entries that crashed the consumer site's prerender. Frontmatter must round-trip whatever YAML the consumer sites' own loaders accept, so a real parser is a correctness requirement, not a convenience."
tags: ["module"]
timestamp: "2026-07-27"
sources: ["src/cli/frontmatter.ts"]
source_hash: "8b6d61fb8891cafe"
---
# Cli Frontmatter

YAML frontmatter reader/writer for the CLI tools, backed by the `yaml` package. This replaced a hand-rolled "minimal subset" parser that silently mangled nested structures: a `faqs:` array of {question, answer} mappings parsed as a single string, which fed the reviewer corrupted frontmatter (the #227 "only one FAQ" false blocker) and made the rewriter serialize `[object Object]` entries that crashed the consumer site's prerender. Frontmatter must round-trip whatever YAML the consumer sites' own loaders accept, so a real parser is a correctness requirement, not a convenience.

**Source File**: [src/cli/frontmatter.ts](file:///home/jaysonlee/Projects/blog-engine/src/cli/frontmatter.ts)

## Related

- [[modules/review]]

## API Interface

### `ParsedDoc`
*No description provided.*

### `parseDocument`
*No description provided.*

### `serializeDocument`
*No description provided.*

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
