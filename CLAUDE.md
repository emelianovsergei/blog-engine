# Claude Code Guidelines

## Build & Test Command
- Build the project: `npm run build`
- Run tests: `npm test`
- Ingest wiki: `npm run wiki:ingest`
- Lint wiki: `npm run wiki:lint`

## Git Workflow
- NEVER push code directly to the `main` or `master` branch.
- ALWAYS create a new branch from `main`/`master` and open a Pull Request (PR).

## Developer Wiki
- ALWAYS consult the developer wiki in `brain/` before writing code or proposing changes to the codebase. The entry point is [brain/index.md](file:///home/jaysonlee/Projects/blog-engine/brain/index.md).
- Strive to update relevant modules or concepts in the wiki when adding new features, APIs, or changing architectural design decisions.
- Maintain human developer notes in the `## Custom Notes` section of the respective page in `brain/modules/` or `brain/concepts/` (these are preserved by `npm run wiki:ingest`).
- Run `npm run wiki:ingest` and `npm run wiki:lint` before opening a Pull Request to keep the graph healthy.

### How `wiki:ingest` works (LLM-driven, Karpathy "LLM wiki")
- Ingest is **LLM-driven**: for each changed `src/*.ts` / `src/cli/*.ts` it asks Claude (via the project's `makeReviewClient`) to write the module page — prose summary, per-export explanations, and `[[wikilink]]` cross-references. Core logic lives in [`src/wiki/ingest.ts`](file:///home/jaysonlee/Projects/blog-engine/src/wiki/ingest.ts); the orchestrator is [`scripts/wiki-ingest.ts`](file:///home/jaysonlee/Projects/blog-engine/scripts/wiki-ingest.ts).
- Set **`ANTHROPIC_API_KEY`** (Gemini fallback via `GEMINI_API_KEY`) for LLM enrichment. With no key it degrades gracefully to deterministic JSDoc-based generation, so CI/offline ingest still works.
- **Incremental**: each page stores a `source_hash`; unchanged files are skipped (no LLM call, no diff). Use `npm run wiki:ingest -- --force` to re-generate every page (e.g. to re-enrich with a better model). Override the model with `WIKI_INGEST_MODEL` (default `claude-sonnet-5`).
- Each run that changes pages appends a `## [YYYY-MM-DD] ingest | …` entry to `brain/log.md` and regenerates `brain/index.md`. Suggested `[[links]]` are validated against real pages, so `wiki:lint` stays green.
- Scope note: this is slice 1 (LLM-driven **Ingest** + index/log). Query and LLM-synthesized concept/overview pages are planned follow-ups.
