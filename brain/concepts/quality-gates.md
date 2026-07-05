---
type: "concept"
title: "Quality Gates & AI Review Rubric"
description: "Standard checklist for AI reviews before draft posts are merged."
tags: ["concepts", "review", "rubric"]
timestamp: "2026-07-02"
sources: []
---
# Quality Gates & AI Review Rubric

All automatically generated posts must pass a structured review block:
1. **Local Relevance**: Focuses on geographical keywords and area-specific advice.
2. **Factual Accuracy**: Rubric bars hallucinating metrics or local codes.
3. **Completeness**: Evaluates formatting, structure, and readability scores.

The gate itself is computed deterministically in code (`computeGate()`): fail
if any dimension scores below 6.0, any blocker-severity issue exists, or the
overall mean is below 7.0. To keep the model from hallucinating structural
blockers (miscounted FAQ arrays, "malformed" citations that are fine), the
prompt includes a `VERIFIED STRUCTURAL FACTS` block computed by
`buildVerifiedFacts()` that the reviewer must not contradict.

Posts failing the gate are routed to the rewriter automatically by the review
workflow — a bounded loop (default 2 attempts, counted via
`[autoblog-autofix]` marker commits) that rewrites, re-builds, pushes, and
re-reviews before handing off to a human. See [[concepts/autofix-loop]] for
the state machine and loop-prevention invariants.

See [[modules/review]] and [[modules/rewrite]] for details.
