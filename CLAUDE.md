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
