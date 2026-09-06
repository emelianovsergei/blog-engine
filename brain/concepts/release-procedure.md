---
type: "concept"
title: "Release Procedure"
description: "How a blog-engine version is cut and how the two consumer sites pick it up (git tag, no registry)."
tags: ["concepts", "release", "versioning", "consumers"]
timestamp: "2026-09-06"
sources: []
---
# Release Procedure

The package is installed straight from GitHub (`github:emelianovsergei/blog-engine#vX.Y.Z`);
`dist/` is not committed and is built on install by the `prepare` script.
There is no registry publish.

## Cutting a release

1. On a branch: `npm test`, `npm run build`, `npm run wiki:ingest && npm run wiki:lint`.
2. Bump `version` in `package.json` (semver: new CLI or new exported API → minor).
3. Open the PR; wait for Codex 👍 / no findings; merge.
4. On `main` after the merge: `git tag vX.Y.Z && git push origin vX.Y.Z`
   (tags are the only artefact consumers can pin).

## Consumers

For each of `pulse-website` and `promax-website`:

1. Edit `package.json`: `"blog-engine": "github:emelianovsergei/blog-engine#vX.Y.Z"`.
2. `npm install` (re-locks and rebuilds `dist/` via `prepare`).
3. `npm run blog:test-fixtures` — the offline generator harness catches API drift.
4. Branch + draft PR + `gh pr ready`, as always.

Check `examples/*.yml` against the consumers' `.github/workflows/` in the same
release when a workflow contract changed — a hole in `examples/` is a hole in
every repo provisioned from it.

## History

| Version | Date | Consumers | Notes |
|---|---|---|---|
| 0.15.0 | 2026-08 | both | search-demand signal made real |
| 0.16.0 | 2026-08-19 | — (never pinned) | `gsc.ts` client, unused by consumers |
| 0.17.0 | 2026-09-06 | pending | GSC-seeded candidates, refresh/backfill mode, rubric-aware rewrite guard, broad FAQ-heading + exact-H2 checks |

## Custom Notes

- v0.16.0 was tagged but never pinned by a consumer, which is why the GSC
  client sat unused for three weeks; the release table above exists so that
  gap is visible next time.
