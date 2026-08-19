---
type: "module"
title: "Rubric"
description: "The single source of truth for what a good post is. Writer, planner, reviewer and the deterministic checker used to carry their own hand-written copies of these rules, which drifted badly: the writer was told \"use only ## headings\" while the reviewer rewarded H2/H3 nesting, and told \"do NOT write an FAQ section\" while the reviewer graded FAQ presence. A post was routinely marked down for rules it had never been shown — 6.7 on one site versus 8.2 on the other, whose prompt happened to include two of the missing rules. So the rules live here ONCE, as data. Each rule declares which audiences see it, an imperative form (for the writer/planner), an evaluative form (for the reviewer), and optionally a deterministic check. Adding a rule updates every surface in one edit; a contradiction between two surfaces is unrepresentable."
tags: ["module"]
timestamp: "2026-08-19"
sources: ["src/rubric.ts"]
source_hash: "3c17bd76b0757b70"
---
# Rubric

The single source of truth for what a good post is. Writer, planner, reviewer and the deterministic checker used to carry their own hand-written copies of these rules, which drifted badly: the writer was told "use only ## headings" while the reviewer rewarded H2/H3 nesting, and told "do NOT write an FAQ section" while the reviewer graded FAQ presence. A post was routinely marked down for rules it had never been shown — 6.7 on one site versus 8.2 on the other, whose prompt happened to include two of the missing rules. So the rules live here ONCE, as data. Each rule declares which audiences see it, an imperative form (for the writer/planner), an evaluative form (for the reviewer), and optionally a deterministic check. Adding a rule updates every surface in one edit; a contradiction between two surfaces is unrepresentable.

**Source File**: [src/rubric.ts](file:///home/jaysonlee/Projects/blog-engine/src/rubric.ts)

## Related

- [[modules/review]]

## API Interface

### `RubricConstraints`
*No description provided.*

### `DEFAULT_RUBRIC_CONSTRAINTS`
*No description provided.*

### `RubricAudience`
*No description provided.*

### `RubricRule`
*No description provided.*

### `RUBRIC_RULES`
*No description provided.*

### `writerRubricRules`
Rules the article writer must follow, as an imperative block.

### `plannerRubricRules`
Rules the planner must follow when producing frontmatter.

### `reviewerRubric`
The reviewer's rubric, grouped by dimension.

### `RubricViolation`
*No description provided.*

### `checkArticleBody`
Deterministic checks the writer's own retry loop can act on, so a mechanical miss costs a local regeneration rather than a full review round-trip.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
