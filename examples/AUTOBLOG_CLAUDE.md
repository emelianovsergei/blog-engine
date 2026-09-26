# Autoblog — Claude session runbook

You are the scheduled Claude session that writes today's blog post for this
site. The Routine that started you says: *"Clone <repo>, follow
AUTOBLOG_CLAUDE.md for today's post."* This file is the whole job. Work through
it top to bottom, without asking questions: nobody is watching live.

## What happens around you

```
blog-brief.yml (GitHub Action, ~1:03 AM PT)   → branch autoblog-brief: brief.json
YOU (scheduled Claude session, ~1:37 AM PT)   → branch blog/claude-<date>: data/blog-claude-inbox/
blog-finalize.yml (on your push)              → image, link audit, frontmatter, report → draft PR
                                                labels: autoblog, autoblog-claude-reviewed
autoblog-review.yml                           → skips Grok, applies autoblog-approved-pending
ci.yml + autoblog-merge-pending.yml           → green CI + 1h window → squash-merge
autoblog-watchdog.yml                         → alerts if fewer than 7 posts merged in 7 days
```

Your deliverable is **one pushed branch** holding `data/blog-claude-inbox/`
(plan, body, meta, review). You never open the PR, never touch `main`, never
merge.

## Hard rules

- **Never discard a post.** If the review still fails after 2 fix rounds, hand
  it off anyway: finalize labels it `autoblog-review-failed` and a human decides.
- **One post per run.** If `blog/claude-<today>` already exists on origin, stop
  and report — today is done.
- **Commit only `data/blog-claude-inbox/`.** No other file in the repo changes.
  Finalize runs `main`'s code and takes only the four inbox files from your
  branch; any other change you push is dropped.
  Preview files from `check` are removed by `handoff`.
- **Your network reaches GitHub and npm only.** Weather, Search Console, the
  sibling site and Autocomplete come from the brief; the live link audit and
  the image run in `blog-finalize.yml`. Do not call xAI, Gemini or any other
  API, and do not try to work around a blocked host.
- **The reviewer is a different agent.** You write; a fresh subagent that never
  saw your drafts grades. Never grade your own post and never edit the
  reviewer's answer.
- Follow `CLAUDE.md` (branch + PR only, persist before gate). This file adds to
  it; it does not override it.

All commands below run from the repo root. `npm run autoblog:claude -- <cmd>`
is `scripts/autoblog/claude.ts`; its scratch space is `.autoblog/` (ignored).

## 0. Set up

```bash
npm ci
# ImageMagick makes the preview image like finalize does. Optional: without it
# `check` uses a committed 1200x675 hero as-is (finalize makes the real image).
command -v convert >/dev/null || { apt-get update -qq && apt-get install -y -qq imagemagick; } \
  || { sudo apt-get update -qq && sudo apt-get install -y -qq imagemagick; } || true
TODAY=$(TZ=America/Los_Angeles date +%F)
git fetch origin main autoblog-brief
```

## 0b. Fix posts held on their PRs (before today's post)

A finished post can sit on its PR and never merge: a Codex P0/P1 comment, a
failed session review (`autoblog-review-failed`), or a dead link finalize
could not unlink (`autoblog-link-repair-needed`). Nothing else fixes those,
so do it first.

```bash
npm run -s autoblog:claude -- revise --list     # last line: REVISE: <PR numbers>
```

For each number on the `REVISE:` line (at most two per run):

```bash
git checkout -q -f --detach origin/main        # check/handoff pin the generator to HEAD
npm run autoblog:claude -- revise --pr <N>     # rebuilds .autoblog/ from the PR; prints .autoblog/findings.md
```

Fix every P0/P1, blocker and major finding in `.autoblog/plan.json` (the
frontmatter: FAQs, HowTo steps, summary, citations) and/or `.autoblog/body.md`;
fix a P2 when it is cheap and plainly right. Change nothing else: same topic,
same slug, same date. Then steps 7 and 8 exactly as for a new post (`check`,
build, `review` with a **new** subagent, the fix loop). Then:

```bash
npm run autoblog:claude -- handoff               # meta.json names the PR branch (revisionOf)
BR=$(node -p 'require("./.autoblog/revise.json").branch')
git add data/blog-claude-inbox
git commit -qm "autoblog: revise $BR for held findings"
git push origin "HEAD:refs/heads/autoblog-revise/${BR#blog/}"   # finalize rebuilds the post and updates the same PR
npm run autoblog:claude -- revise --resolve     # waits for finalize to replace the PR head, then resolves the Codex threads
git checkout -q -f --detach origin/main && rm -rf .autoblog data/blog-claude-inbox
```

`revise --resolve` waits up to 20 minutes for finalize to put its finalized
commit on the PR, and only then replies to and resolves the Codex threads:
until then the old head is still approved, and a resolved thread would let
merge-pending publish the unfixed post. Exit 3 means finalize did not land in
time: the threads stay open (the post stays held); name it in the report.

Never push a revision onto the PR's own branch: the PR head must only move to
a finalized commit (Codex reviews whatever the head is). If the push is refused
because this session may only push its own branch, push the same commit to
that `claude/...` branch instead; `revisionOf` still points finalize at the PR.

`revise --list` skips a PR a human paused (`autoblog-hold`) or approved
(`autoblog-human-approved`), and one already revised twice: those need a
human, so name them in your report. A revision whose review still fails is
handed off anyway, like a new post.

Then today's post:

```bash
git checkout -q -f --detach origin/main
git ls-remote --exit-code origin "refs/heads/blog/claude-${TODAY}*" && echo "ALREADY DONE" # → report and stop
```

## 1. Read the brief

GitHub starts scheduled workflows late, sometimes by hours (on 2026-09-26 the
08:03 UTC brief ran at 12:51). If the brief on the branch is not today's, ask
for a fresh one and wait up to 10 minutes for it. This is best-effort: if the
request fails, carry on with the brief that is there (`init` warns).

```bash
briefDate() { git show origin/autoblog-brief:brief.json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).runDate)}catch{}})'; }
if [ "$(briefDate)" != "$TODAY" ]; then
  REPO=$(git remote get-url origin | sed -E 's#(\.git)?/?$##; s#.*[/:]([^/]+/[^/]+)$#\1#')
  TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
  if curl -fsS -X POST ${TOKEN:+-H "Authorization: Bearer $TOKEN"} \
      -H "Accept: application/vnd.github+json" -H "Content-Type: application/json" \
      "https://api.github.com/repos/$REPO/actions/workflows/blog-brief.yml/dispatches" -d '{"ref":"main"}'; then
    for i in $(seq 20); do
      sleep 30; git fetch -q origin autoblog-brief
      [ "$(briefDate)" = "$TODAY" ] && echo "Fresh brief for $TODAY." && break
    done
  else
    echo "Could not request a fresh brief; using the one on the branch."
  fi
fi
git show origin/autoblog-brief:brief.json > /tmp/brief.json \
  || npm run autoblog:brief -- --out /tmp/brief.json   # degraded: no GSC, weather, sibling or autocomplete
npm run autoblog:claude -- init --brief /tmp/brief.json
```

`init` prints the season, weather/AQI, Search Console opportunities, the
recent category mix, and how many posts it knows on **both** sites (published,
open autoblog PRs, and unmerged `blog/*` branches it scanned with git). It also
tries to clone the sibling repo; if this session cannot read it, the brief's
list is used. Read `.autoblog/context.json` (`ownPosts`, `siblingPosts`) before
proposing anything — dedup is against both sites.

## 2. Propose ~6 candidates

Write `.autoblog/candidates.json`, an array of:

```json
{
  "topic": "One concrete sentence: subject + angle",
  "notes": "1-2 sentences of guidance for the planner",
  "categoryId": "one of the ids init printed",
  "hintQuery": "exact Search Console query this answers (copy it verbatim), or omit",
  "supportsSlug": "slug of an existing post this deepens, or omit",
  "similarity": 0.35,
  "nearestSlug": "closest existing post on either site"
}
```

- **At least half** answer a Search Console opportunity from `init` (set
  `hintQuery` verbatim). With no opportunities, use real homeowner problems.
- Start each `topic` with the noun phrase people type ("furnace short cycling
  …", "heat pump defrost …"): autocomplete is a prefix API.
- Avoid over-represented categories. Favor the weather anomaly if there is one.
- One homeowner problem per candidate, for this site's service areas only.
- `similarity` is your honest judgment (0-1) against the closest post on
  **either** site, published or pending: ≥ 0.86 same topic (rejected), 0.6-0.86
  adjacent (penalized), < 0.6 distinct. A different angle on the same question
  is still ≥ 0.86.

## 3. Rank

```bash
npm run autoblog:claude -- rank
```

Same weights as the engine's `rank.ts` (demand 0.45, dedup 0.25, rotation
0.15, weather 0.15; without any demand signal 0.5/0.3/0.2). Demand is
Autocomplete breadth (live if reachable, else the brief's cache) blended with
Search Console impressions. The winner goes to `.autoblog/selection.json`. If
every candidate is a duplicate, propose new ones instead of accepting the
relaxed pick.

## 4. Keywords (Autocomplete for the winner)

```bash
npm run autoblog:claude -- keywords
```

This runs the engine's `researchKeywords` for the winner: `buildSeedQueries`
+ `fetchAutocompleteResult`, live or from the brief cache. It stops at the
clustering prompt (`.autoblog/keywords.prompt.md`). Answer it yourself as the
JSON it asks for in `.autoblog/keywords.answer.json`, then:

```bash
npm run autoblog:claude -- keywords --answer .autoblog/keywords.answer.json
```

The engine then decides what is verified demand and what is inferred.

## 5. Plan

```bash
npm run autoblog:claude -- prompt planner
```

`.autoblog/planner.prompt.md` is the exact prompt the Grok writer used, with
this topic, the keyword research and both sites' posts. Follow every rule in
it. Write `.autoblog/plan.json` with the keys listed at the end of the prompt.
Count characters (`metaTitle` ≤ 60, `metaDescription` 140-155, `title` 40-65,
`description` 120-160). Citations: 2-3 stable, top-level authority pages that
are not on the policy's dead-fragment list.

## 6. Write

```bash
npm run autoblog:claude -- prompt writer
```

Write the article to `.autoblog/body.md` exactly as `.autoblog/writer.prompt.md`
asks: markdown body only, no frontmatter, no FAQ section, the required
heading, the CTA. Write like the company's senior tech talking to a neighbor:
specific, local, plain.

The prompt asks for a concrete, lived-in scenario. Never present an invented
job as one the company did: no dated call, named neighborhood customer or
meter reading told as fact ("last October we found..."), unless it comes from
`content/our-work/`. Frame it as the pattern it is ("a typical first-cold-morning
call: the house is a 1970s ranch, the trap is full of algae..."). Codex holds
a post that states a made-up job as fact (P1, 2026-09-26).

## 7. Check and build

```bash
npm run autoblog:claude -- check
npm run build
```

`check` validates the plan (the generator's `assertPlan` and topic lock), the
body (`checkArticleBody`: word band, headings, banned words, rhythm), the link
policy offline, and writes an offline preview of the real MDX (stock image)
that it runs through `npm run blog:check --strict`. Fix every problem it lists
and re-run until it is clean. Then build: a build failure caused by the post is
yours to fix; one caused by a blocked host (fonts, remote images) is not —
note it in your final report and continue, CI builds the PR.

## 8. Second-pass review (a separate subagent)

```bash
npm run autoblog:claude -- review --round 1
```

This writes `.autoblog/review-1.prompt.md`: the engine's own `reviewBlogPost`
prompt (`reviewerRubric`, verified structural facts, the preview frontmatter
and body, recent titles) plus the JSON schema.

Spawn a **new** subagent (Agent tool, general-purpose). Give it only this:

> Read `.autoblog/review-1.prompt.md` in `<repo path>`. You are the editor it
> describes; you did not write this post. Grade it strictly and honestly. Write
> only the JSON object it asks for to `.autoblog/review-1.answer.json`. Do not
> edit any other file.

Do not pass it your drafts, reasoning or the candidates. Then:

```bash
npm run autoblog:claude -- review --round 1 --answer .autoblog/review-1.answer.json
```

The engine parses the answer and applies `computeGate()`: every gating
dimension ≥ 6.0, no blocker, overall ≥ 7.0; `humanVoice` is scored and
reported but advisory. Exit 0 = pass, 2 = fail.

**Fix loop (at most 2 rounds).** On a fail, revise `.autoblog/plan.json` and/or
`.autoblog/body.md` to address every blocker and major issue (and minor ones
that are cheap), re-run `check` until clean, then `review --round 2` with **a
new subagent** (same instructions, round 2 files). Round 3 is the last. After
round 3, hand off whatever the result.

## 9. Hand off and push

`handoff` refuses a plan or body that changed after the last review, and
finalize re-checks the same digest. If you touch either file after the
verdict, run `check` and a new `review` round first. `handoff` also refuses if
HEAD moved since `check`: finalize regenerates the post with that exact commit
of `main`, so do not pull or switch commits between `check` and `handoff`.

```bash
npm run autoblog:claude -- handoff
git status --short          # only data/blog-claude-inbox/ may be new
git checkout -b "blog/claude-${TODAY}"
git add data/blog-claude-inbox
git commit -m "autoblog: Claude post for ${TODAY}"
git push -u origin "blog/claude-${TODAY}"
```

If the push is refused because this session may only push its own branch,
push the same commit to the branch your session instructions name (a
`claude/...` branch): `git push -u origin HEAD:<that branch>`.
`blog-finalize.yml` accepts both and moves the post to `blog/claude-${TODAY}`.
Retry a network failure up to 4 times (2s, 4s, 8s, 16s).

## 10. Report

End with a short summary: title, slug, category, the GSC query it targets (if
any), review verdict and score, fix rounds used, branch pushed, and anything
degraded (stale brief, no autocomplete, build blocked by a host). Add each
held post you revised (PR, findings fixed, review verdict) and each one
`revise --list` skipped. Stop there.

## When something goes wrong

| Situation | Do |
| --- | --- |
| No brief on `autoblog-brief` | Build a local one (step 1). Say so in the report. |
| Brief is for another date | `init` warns. Continue; post lists are refreshed from git. |
| `check` keeps failing | Fix what it names. A slug clash means a new slug (or a new topic if the post exists). |
| Build fails because of the post | Fix it. Never hand off a post you know breaks the build. |
| Review fails 3 times | Hand off anyway. Finalize labels `autoblog-review-failed`. |
| `revise --list` cannot reach GitHub | It prints an empty `REVISE:` line. Skip revisions, write today's post, say so in the report. |
| Push refused twice after retries | Report the exact git error. The post is lost only if you skip this: paste `plan.json` and `body.md` into the report. |
