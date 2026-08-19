---
type: "concept"
title: "One Rubric, Many Prompts"
description: "Why the writer, planner, reviewer and deterministic checker all render from a single rule array."
tags: ["concepts", "review", "rubric", "prompts"]
timestamp: "2026-08-19"
sources: []
---
# One Rubric, Many Prompts

The writer prompt (in each consumer repo) and the reviewer rubric (in
`src/review.ts`) used to be independent blocks of prose. They drifted, and by
2026-08-18 they contradicted each other outright:

| Writer was told | Reviewer graded |
|---|---|
| "Use only `##` headings" | "logical H2/**H3** structure" |
| "Do NOT write a Frequently Asked Questions section" | rewards/penalises FAQ presence |
| 800-1100 words | 600-1500 words (validator said 750-1300) |
| — | "at least one cited statistic early on" |
| — | "first sentence under each H2 answers the question" |
| — | `frontmatter.category` — which the pipeline sets, not the model |

Posts were losing points for rules they had been forbidden to satisfy, which is
why a first draft almost always needed an auto-fix round.

**The natural A/B was already in the data.** promax's writer prompt happened to
contain the answer-first and cited-statistic rules; pulse's did not. promax
scored 8.2 first try; pulse scored 6.7 and needed two auto-fix rounds.

## The fix

[[modules/rubric]] holds the rules **once, as data**. Each `RubricRule` declares
its audiences, an imperative form (writer/planner), an evaluative form
(reviewer), and an optional deterministic `check`. Four renderers read that one
array: `writerRubricRules`, `plannerRubricRules`, `reviewerRubric`,
`checkArticleBody`.

A contradiction between surfaces is therefore **unrepresentable**:
`headingPolicy: "h2-only"` makes the reviewer say *"this site renders H2 only —
do NOT penalise the absence of H3"*, and `faqPolicy: "appended-by-code"` makes
it grade `frontmatter.faqs` rather than body text.

## Invariants worth preserving

- **Never grade a field the model cannot author.** `frontmatter.category` is set
  by the pipeline, so it moved out of the rubric and into `buildVerifiedFacts`
  as ground truth.
- **The word-count target and the enforcement band are deliberately different
  numbers.** Aim tight (800-1100), tolerate wider (750-1300). Collapsing them
  made the checker reject a 1,108-word body — a full regeneration for eight
  words. `minWords`/`maxWords` vs `hardMinWords`/`hardMaxWords`.
- **Sharing rules must level the weaker prompt UP.** promax's prompt was richer
  than pulse's (anti-hedging, citation format); those rules moved into the
  engine rather than being lost in the migration.
- Deterministic tells (banned openers, em-dash density, paragraph rhythm) belong
  in `checkArticleBody`, where the writer's own retry loop fixes them for free
  instead of burning a review round-trip.

See [[concepts/quality-gates]] for the gate itself and [[modules/rubric]] for
the rule set.
