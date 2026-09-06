---
type: "module"
title: "Cli Refresh"
description: "blog-engine-refresh — refresh a published post against the Search Console queries it ranks for, or backfill its GEO frontmatter fields. blog-engine-refresh --post content/blog/x.mdx --site pulse|promax \\ --business \"<Business Name>\" --service-areas \"Sacramento,Roseville\" \\ --mode refresh|backfill [--queries queries.json] [--fields summary,faqs,…] \\ [--howto-shape steps|nested] [--now YYYY-MM-DD] [--link-policy policy.json] \\ [--audit-out audit.json] [--notes-out notes.md] [--result-out result.json] \\ [--required-headings \"A|B\"] [--faq-policy appended-by-code|written-by-model] \\ [--model grok-4.6] [--no-link-audit] `--queries` is a JSON array of {query, impressions, position} (the page's rows from loadGscPageSignal). `--howto-shape` picks how HowTo is written: \"steps\" → howToName + howToSteps (hvacpulse.com), \"nested\" → howTo {name, step[]} (promaxhvac.com); the default follows --site. Exit codes: 0 written (or nothing to change, see result-out), 1 error."
tags: ["module"]
timestamp: "2026-09-06"
sources: ["src/cli/refresh.ts"]
source_hash: "72230b2f944bc7e1"
---
# Cli Refresh

blog-engine-refresh — refresh a published post against the Search Console queries it ranks for, or backfill its GEO frontmatter fields. blog-engine-refresh --post content/blog/x.mdx --site pulse|promax \ --business "<Business Name>" --service-areas "Sacramento,Roseville" \ --mode refresh|backfill [--queries queries.json] [--fields summary,faqs,…] \ [--howto-shape steps|nested] [--now YYYY-MM-DD] [--link-policy policy.json] \ [--audit-out audit.json] [--notes-out notes.md] [--result-out result.json] \ [--required-headings "A|B"] [--faq-policy appended-by-code|written-by-model] \ [--model grok-4.6] [--no-link-audit] `--queries` is a JSON array of {query, impressions, position} (the page's rows from loadGscPageSignal). `--howto-shape` picks how HowTo is written: "steps" → howToName + howToSteps (hvacpulse.com), "nested" → howTo {name, step[]} (promaxhvac.com); the default follows --site. Exit codes: 0 written (or nothing to change, see result-out), 1 error.

**Source File**: [src/cli/refresh.ts](file:///home/jaysonlee/Projects/blog-engine/src/cli/refresh.ts)

## Related

- [[modules/link-audit]]
- [[modules/links]]
- [[modules/refresh]]
- [[modules/rubric]]
- [[modules/cli-frontmatter]]
- [[modules/cli-shared]]

## API Interface

### `rubricFromFlags`
*No description provided.*

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
