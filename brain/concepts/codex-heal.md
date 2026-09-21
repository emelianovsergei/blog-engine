---
type: "concept"
title: "Codex P0/P1 Self-Heal"
description: "Bounded rewrite loop that clears unresolved Codex P0/P1 comments on an otherwise approved autoblog PR so merge-pending can ship."
tags: ["concepts", "ci", "automation", "codex", "review"]
timestamp: "2026-09-21"
sources: []
---
# Codex P0/P1 Self-Heal

[[concepts/autofix-loop]] recovers from a failing **AI review**. [[concepts/ci-heal]]
recovers from red **CI**. Neither sees the state that actually stranded Pulse
#381 and Promax #299: AI review PASS, CI green, `autoblog-approved-pending`,
and an unresolved Codex **P1** that `autoblog-merge-pending` skip-logs while
the job stays green. Generate's in-flight lock then drops the next daily slot.

`examples/autoblog-codex-heal.yml` is the net for that state.

## State machine

```
unresolved Codex P0/P1 on current HEAD
    no AUTOBLOG_PAT ──────────────► skip + comment
    [autoblog-codexfix] count ≥ cap ► autoblog-codex-p1 + handoff
    else ─► map comments to ReviewResult (P2 dropped) ► blog-engine-rewrite
            ► blog:check ► npm run build ► commit [autoblog-codexfix]
            ► reply in each P0/P1 thread ► push with PAT ► `@codex review`

unresolved Codex P0/P1 only on an older SHA
    Codex has not judged current HEAD ► wait
    Codex judged HEAD with no new P0/P1 ► resolve old P0/P1 threads (leave P2)

no unresolved P0/P1 ► noop (merge-pending may ship)
```

P0 always holds in merge-pending. P1 holds when `AUTOBLOG_HOLD_ON_CODEX_P1`
is true. P2 never heals and never holds.

Do **not** comment `@codex address that feedback`. That path also rewrites
P2s, has no attempt cap, and has no build gate.

## Loop-prevention

- Attempt counter = PR comments containing `<!-- autoblog-codex-heal-run -->`,
  posted at the start of every rewrite (including no-diff and failed
  builds). Successful pushes still use `[autoblog-codexfix]` in the commit
  message. Cap is `AUTOBLOG_MAX_CODEXFIX` (default 2). `autoblog-codex-p1`
  is terminal: eligibility skips it. Separate from `[autoblog-autofix]` /
  `[autoblog-cifix]`.
- A clean Codex pass is a review whose `commit_id` equals HEAD, or a 👍 on
  the `@codex review` comment that embeds that SHA. Issue-level 👍 is ignored.
- Do not resolve P0/P1 threads on the push. Merge-pending holds on any
  unresolved P1; resolving immediately would let it squash a head Codex has
  not seen. Resolve only after Codex has judged the new HEAD (review
  `commit_id == HEAD`, or a 👍 whose `created_at` is after the HEAD commit).
- Codex does not re-review on `synchronize`. The healer comments
  `@codex review` after the PAT push.
- Trigger is `pull_request_review` from `chatgpt-codex-connector[bot]`, plus
  an hourly `:25` scan and `workflow_dispatch`. Not `synchronize`, so the
  PAT push cannot cancel the job that just pushed.
- Backfill PRs are skipped (do not rewrite old bodies).

Mapper: `examples/scripts/codex-comments-to-review.sh`. Consumers copy it to
`.github/scripts/`. No engine pin bump — Promax stays on v0.15.0.

See [[concepts/delivery-guarantee]], [[concepts/autofix-loop]],
[[concepts/unreachable-success-path]].
