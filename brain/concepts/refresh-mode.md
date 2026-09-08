---
type: "concept"
title: "Refresh and Backfill Mode"
description: "Regenerating a published post's GEO fields (and lightly its body) against the Search Console queries it already ranks for; the engine half of the weekly refresh job and the backfill."
tags: ["concepts", "refresh", "backfill", "gsc", "geo"]
timestamp: "2026-09-06"
sources: []
---
# Refresh and Backfill Mode

Until v0.17 every write path in the engine was new-post-shaped: the URLs
Google already liked never got a freshness bump, and the older half of each
consumer's library never received the summary / FAQ / citations template.
[[modules/refresh]] and the `blog-engine-refresh` CLI close both gaps.

## Two modes, one function

`refreshBlogPost({ mode, fields, rankingQueries, … })`

| Mode | Body | Fields | Used by |
|---|---|---|---|
| `refresh` | Lightly revised: every existing H2 kept verbatim, at most **one** new H2 answering the top uncovered ranking query, length within ±20% | all requested (default all) | the weekly refresh workflow |
| `backfill` | Untouched, returned verbatim | only `--fields` | the one-time backfill of older posts |

Fields: `summary` (50-70 words, answer-first), `faqs` (3-5), `targetKeyword`,
`keywords`, `citations` (policy-checked, 2-3), `howTo` (procedural topics
only; the CLI maps it to the site's shape with `--howto-shape steps|nested`).

## Invariants (throw → CLI exit 1 → no PR)

- The body never contains an FAQ heading in any form MDX renders as a heading
  (ATX, Setext, raw HTML) — FAQs render from frontmatter on both sites.
- Required headings (`--required-headings "A|B"`) survive as exact H2 lines.
- No existing H2 is dropped; at most one is added.
- `targetKeyword` passes `topicAlignmentIssue` against the title.
- `category` is never model-chosen (`categorizeText` when missing).
- `updated` is set to the run date **only when something changed**; `date`,
  `slug`, `title` are never touched.

## Choosing what to refresh

`loadGscPageSignal({ pathPrefix: "/blog/" })` fetches page+query rows;
`pickRefreshTarget()` returns the post with the most impressions sitting at
positions 4-20 that has not been published or updated inside the cooldown
(120 days), skipping slugs with an open autoblog PR. Nothing qualifies →
`undefined` → the workflow no-ops without a PR.

## Custom Notes

- ChatGPT cites pages touched in the last 30 days roughly 3× more often; the
  point of `updated` is an honest, explicit freshness signal that
  `dateModified` and sitemap lastmod both carry.
