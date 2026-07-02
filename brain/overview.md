---
type: "summary"
title: "Blog Engine Overview"
description: "Architecture overview of the blog topic selection and review library."
tags: ["overview", "architecture"]
timestamp: "2026-07-02"
sources: ["README.md"]
---
# Blog Engine Overview

Welcome to the **blog-engine** Developer Knowledge Base. 

This repository provides an automated pipeline to help HVAC websites select relevant topics, review drafted posts, and execute stylistic/SEO rewrites before publishing.

## High-Level Architecture
- **Orchestration**: [[modules/orchestrator]] selects weekly topics based on current signals.
- **External Signals**: Fetches weather extremes via [[modules/weather]] and autocomplete suggestions via [[modules/suggest]].
- **Review Rubric**: Standardizes automated quality inspections via [[modules/review]].
