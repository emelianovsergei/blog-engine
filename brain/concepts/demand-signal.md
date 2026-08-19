---
type: "concept"
title: "Search-Demand Signal"
description: "How topic demand is measured, why the first implementation was theater, and what the numbers actually mean."
tags: ["concepts", "seo", "keywords", "demand"]
timestamp: "2026-08-19"
sources: []
---
# Search-Demand Signal

Two independent signals feed topic selection. They answer different questions
and are deliberately **not** averaged into one number.

| Signal | Source | Knows | Blind to |
|---|---|---|---|
| **Breadth** | Google Autocomplete ([[modules/suggest]], [[modules/demand]]) | how wide the query space is around a topic | whether this site ranks for any of it |
| **Volume** | Search Console ([[modules/gsc]]) | proven impressions, clicks, position for THIS property | anything the site does not already rank for |

`mergeDemand` keeps both and blends only when both exist.

## The first implementation was theater

Measured across ten archived production runs before 2026-08-19:

- The demand signal was **unavailable in 5 of 10 runs**, emitting one
  `console.warn` and nothing else. Never noticed in git history or this wiki.
- **~27% of the harvested "real search demand" was junk** — `how to furnace in
  minecraft`, `best furnace pals palworld`, `hvac sacramento salary`.
  `demand.ts` filtered by relevance; `keywords.ts` never did.
- `primaryKeyword` was **model-invented in 4 of 9 runs** and `questionKeywords`
  were ~0/6 verbatim in 5 of 9 — yet the writer prompt called them "REAL
  searched questions", and they shipped as public `FAQPage` schema.
- Demand was capped at 25% of ranking weight while `dedupScore` (0.4-0.5)
  rewarded distance from *everything* published — the opposite of topic-cluster
  SEO.

**Root cause was query shape, not networking.** Autocomplete is a **prefix**
API. The old code stripped stopwords and joined the first five surviving tokens,
producing strings nobody types.

## What actually works (measured, not assumed)

`scripts/demand-smoke.ts` gates changes here on live measurement. Baseline 18%
of seeds productive with 2/5 topics covered; after the rebuild, **70% with 5/5
topics covered**.

Two findings only measurement could have produced:

- A two-word slice of a title is often a **verb fragment**. `furnace blowing`
  completes to nothing; `furnace` completes richly. Cost/replacement/local
  frames therefore use the **category noun**, question frames use the
  descriptive head.
- `headTerm` filtered words of two characters or fewer, silently deleting
  **"ac"** — the most-searched noun in this domain.

Question frames only complete for symptom-shaped topics; a "should you X"
decision post returns nothing however the head is cut. They are kept anyway,
because when they *do* hit they return ten long-tail phrases that become the
FAQ. Hence the acceptance bar is "every topic yields a usable signal", not a
flat percentage.

## Honesty invariants

- **Never claim data you do not have.** `keywordGuidance` states plainly when
  the signal is `partial` or `none`. The consumer copies it replaced said "real
  Google Autocomplete demand" unconditionally, including on runs that fetched
  zero suggestions.
- **`available` is not provenance.** It only ever meant "at least one suggestion
  was fetched". `demandSignal` + `provenance` record whether the returned
  keywords actually derive from search data.
- **Availability is per candidate.** A global OR let one working query mark five
  others as zero-demand — indistinguishable from genuinely low demand.
- **A blocked response is not zero demand.** `SuggestOutcome` separates
  `ok | empty | blocked | error`.

## Known gap (next step)

`generateCandidates` still receives **no demand input**. Topics are invented
blind and demand only re-sorts them, so a high-volume query the model never
proposed can never surface. The intended fix is to feed
`findOpportunities()` — queries at positions 8-25 with real impressions — into
candidate *generation* as hints. Deferred deliberately so the first fully
autonomous cron run tests the shipped state first.

See [[concepts/topic-deduplication]] for how dedup interacts with clustering.
