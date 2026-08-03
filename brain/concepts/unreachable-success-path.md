---
type: "concept"
title: "Unreachable Success Paths (Silent Green)"
description: "The recurring autoblog bug shape: an automated check whose success branch cannot be reached, failing in a way that looks like patience or approval."
tags: ["concepts", "ci", "workflows", "reliability"]
timestamp: "2026-08-02"
sources: []
---
# Unreachable Success Paths (Silent Green)

Nearly every autoblog delivery failure to date has had the same shape, and it is
not "the code was wrong." It is:

> A guard reported success without being able to observe the thing it guards.

The failures do not look like failures. A skipped job renders a green check. A
watcher that can never fire looks like it is still waiting. A comment that says
a fix landed looks like a fix landed. So run-level green is never evidence of
delivery — see [[concepts/delivery-guarantee]] for the check that is.

## Known instances

**Permission missing → gate skips everything, forever.**
`gh pr checks` does not stop at the status rollup; it resolves
`checkSuite.workflowRun`, a field gated behind `actions: read`. Without that
permission the GraphQL query is rejected outright, `gh` exits 1, and
`autoblog-merge-pending.yml` treats every PR as "checks not passing" and skips
it — while the job itself exits 0. The merge gate was off for weeks and the
Actions tab was solid green. Fixed in `examples/autoblog-merge-pending.yml`
(#20), which now declares `checks: read` **and** `actions: read`.

**Predicate only satisfiable on rejection.**
`scripts/watch-merge.sh` originally detected Codex approval by matching the SHA
in Codex's review body against the PR head. But Codex posts a review body only
when it *has* suggestions; a clean pass posts nothing and instead swaps its
reaction from 👀 to 👍. The watcher could therefore fire only on rejection — on
approval it spun to its timeout and reported the PR as still waiting, while the
PR sat approved and green. Fixed in #22: read `commit_id` off the review object
rather than scraping the rendered prose, and treat the reaction as the clean-pass
signal — under the binding rules below.

**Unknown collapsed into definite.**
A failed review-comments fetch defaulted to zero findings, so a transient API
error could merge precisely the PR whose findings could not be read. Same shape
one level down, inside the tool written to catch it. Every unreadable state now
retries the poll instead of feeding a default into the decision (#22).

**Stale signal read as current — and the proxies that cannot fix it.**
An approval older than the current head is a verdict on superseded code, so a 👍
has to be bound to the SHA it judged. A reaction carries no SHA, so binding one
means inferring "when did this SHA become head" — and every available proxy
leaks: the committer date predates the push whenever a reset or fast-forward
makes an older commit the head; check-run starts are absent right after a reset
and a delayed matrix job or a manual re-run on an unchanged SHA shoves the
cutoff *past* a valid 👍, rejecting a correct approval forever; force-push events
miss ordinary synchronize pushes. Patching one proxy moved the hole to another,
and the reports were in direct tension — tracking more activations worsens false
rejection, loosening worsens false acceptance.

So `scripts/watch-merge.sh` stopped inferring activation and **witnesses** it:
each poll records the head it sees, the approval window restarts when the head
changes, and a 👍 counts only if it arrived after this process saw the current
head in place. SHA-bound by construction rather than by inference, using no
GitHub timestamp at all. Two costs, both chosen so the script declines rather
than guesses — a 👍 predating the watcher is not trusted
(`WATCH_MERGE_TRUST_EXISTING=1` to override), and bare-reaction approval is
disabled for the rest of a run once the verdict can no longer be attributed
(head moved, or a review was already in flight at start), leaving only a
commit-bound review object. Neither applies in normal use: push, then watch.

**Success reported for work never committed.**
`/autoblog rewrite` posted its change-notes comment gated on
`hashFiles('change-notes.md') != ''` alone. `blog-engine-rewrite` always writes
`--notes-out` and always exits 0, including when the model returns the post
byte-identical (an ordinary success in [[modules/rewrite]]). The result: a green
run and a sticky comment listing revisions that exist only in the model's reply,
while the branch is unchanged, `autoblog-review-failed` is still attached, no
`synchronize` fires, and review never re-runs. Fixed in #21 by gating on the
commit, not the artifact — and by setting `changed=true` *before* the push, so a
failed push cannot leave the output unset (unset equals neither `true` nor
`false`, which would make both comment steps skip and the run say nothing —
the same bug in a new place).

## The rule that falls out

1. **A guard must fail loudly when it cannot observe.** Never default an
   unreadable state to the permissive value. Retry, or abort.
2. **Ask whether the success branch is reachable at all.** Write down the exact
   observable that fires it and confirm it occurs on the happy path. "It has
   never fired" is a finding, not a quiet quarter.
3. **Gate on the effect, not on the attempt.** A written file, a zero exit and a
   posted comment are attempts. A commit, a merge, a re-read of the resulting
   state are effects. `scripts/watch-merge.sh` re-reads the PR after merging and
   fails loudly if the merge did not take, because a merge command exiting 0 is
   not evidence the PR merged.
4. **Derive thresholds and cutoffs from data, not constants.** Hardcoded windows
   drift out of agreement with the text that quotes them.

This concept is the reason the pipeline has a watchdog at all
([[concepts/delivery-guarantee]]) and why the auto-fix loop counts marker
commits rather than trusting a step's exit code
([[concepts/autofix-loop]]).
