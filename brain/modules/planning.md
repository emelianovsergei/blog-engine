---
type: "module"
title: "Topic Alignment Guard"
description: "Ensures post topics align to planned keywords, target areas, and accuracy guidelines."
tags: ["alignment", "guard", "validation"]
timestamp: "2026-07-02"
sources: ["src/planning.ts"]
---
# Topic Alignment Guard

Shared generation-time guardrails that keep an auto-generated post on a single, accurately-targeted topic. These exist because the failure mode in production was never weak prose — it was a *brief* that contradicted itself: the keyword-research stage ranks a `primaryKeyword` purely by search demand, so it can hand the planner a phrase about a different subject than the locked seed topic (e.g. a "whole-house fan vs attic fan" post handed "best thermostat setting for summer"). The planner then front-loads the off-topic keyword and the writer dutifully produces a two-topic article — which fails the SEO gate and dilutes ranking. Two layers defend against that: 1. Prompt fragments (`topicLockPlannerRules`, `writerAccuracyRules`) that tell the models to stay on one topic and to ground every figure. 2. A deterministic guard (`assertTopicAligned`) that rejects a plan whose targetKeyword shares no content word with its title — catching the mismatch cheaply, before a single token is written or built.

**Source File**: [planning.ts](file:///home/jaysonlee/Projects/blog-engine/src/planning.ts)

## API Interface

### `topicAlignmentIssue` (function)
Return a human-readable problem string when `targetKeyword` is topically disconnected from `title` (zero shared content words), or `null` when they are aligned. Non-throwing companion to {@link assertTopicAligned}. Deliberately conservative: it only flags a *total* mismatch, the real-world failure mode, so it won't false-positive on partial overlaps.

### `assertTopicAligned` (function)
Throw when `targetKeyword` is topically disconnected from `title`. Call from a plan-validation step so a mismatch triggers a regenerate instead of shipping a split-focus post.

### `topicLockPlannerRules` (function)
Planner-prompt rules that lock the post to one subject and bind the targetKeyword to that subject. Splice into the planning prompt's rule list.

### `writerAccuracyRules` (function)
Writer-prompt rules that prevent fabricated figures and keep the body on one topic. Pass the plan's citations so the writer can ground (and link) claims.

## Custom Notes

*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*
