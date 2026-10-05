#!/usr/bin/env tsx
/**
 * Unit tests for the held-post rules behind `autoblog:claude revise`. Offline:
 *   npx tsx scripts/autoblog/test-revise.ts
 */
import assert from "node:assert/strict";
import {
  MAX_REVISIONS,
  REVISION_MARKER,
  ciSummary,
  classifyPr,
  codexOnHead,
  headRequestComments,
  isClaudePostPr,
  isClaudeRefreshPr,
  isRoutineMarker,
  publishVerdict,
  codexSeverity,
  reportFindings,
  revisionCount,
  codexTitle,
  revisionPlan,
  withoutAutoLinks,
  type CcrThread,
  type OpenPr,
  type ReviewComment,
} from "./revise";
import { offLimitsTopic } from "./shared";

const badge = (p: string) =>
  `**<sub><sub>![${p} Badge](https://img.shields.io/badge/${p}-orange?style=flat)</sub></sub>  Fix the thing**\n\nWhy it matters.\n\nUseful? React with 👍 / 👎.`;

// ── codexSeverity / codexTitle ──────────────────────────────────────────────
assert.equal(codexSeverity(badge("P0")), "P0");
assert.equal(codexSeverity(badge("P1")), "P1");
assert.equal(codexSeverity("![P2 Badge](x)"), "P2", "alt-text form");
assert.equal(codexSeverity("just a comment"), undefined);
assert.equal(codexTitle(badge("P1")), "**  Fix the thing**\n\nWhy it matters.");

// ── classifyPr ──────────────────────────────────────────────────────────────
const pr = (labels: string[], ref = "blog/claude-2026-09-26"): OpenPr => ({
  number: 7,
  title: "Blog: post",
  head: { ref, sha: "a".repeat(40) },
  labels: ["autoblog", "autoblog-claude-reviewed", ...labels].map((name) => ({ name })),
});
const codex = (id: number, p: string): ReviewComment => ({ id, body: badge(p), user: { login: "chatgpt-codex-connector[bot]" } });
const thread = (id: number, over: Partial<CcrThread> = {}): CcrThread => ({
  resolved: false,
  outdated: false,
  path: "content/blog/x.mdx",
  line: 10,
  comment_ids: [id],
  ...over,
});

assert.equal(classifyPr(pr([]), [], [], []), undefined, "nothing holds a clean PR");
assert.equal(classifyPr(pr([], "claude/some-branch"), [thread(1)], [codex(1, "P1")], []), undefined, "only blog/claude-* PRs");
assert.equal(
  classifyPr({ ...pr([]), labels: [{ name: "autoblog" }] }, [thread(1)], [codex(1, "P1")], []),
  undefined,
  "only Claude-reviewed PRs",
);
// The weekly refresh merges through the same gates, but is never revised.
const refreshPr = pr([], "blog/refresh-2026-09-28-some-post");
assert.equal(isClaudeRefreshPr(refreshPr), true);
assert.equal(isClaudePostPr(refreshPr), false, "revise --list never picks up a refresh");
assert.equal(isClaudeRefreshPr({ ...refreshPr, labels: [{ name: "autoblog" }, { name: "autoblog-refresh" }] }), false, "an API-key refresh is not the session's");
assert.deepEqual(classifyPr(refreshPr, [thread(1)], [codex(1, "P1")], [])?.reasons, ["Codex P1"], "a Codex P1 holds a refresh");
assert.equal(classifyPr(refreshPr, [], [], []), undefined, "a clean refresh is not held");

let held = classifyPr(pr([]), [thread(1)], [codex(1, "P1")], []);
assert.deepEqual(held?.reasons, ["Codex P1"], "a current P1 holds");
assert.equal(held?.findings[0].commentId, 1);
assert.equal(held?.blocked, undefined);

assert.equal(classifyPr(pr([]), [thread(1, { outdated: true })], [codex(1, "P1")], []), undefined, "an outdated P1 does not hold");
assert.equal(classifyPr(pr([]), [thread(1)], [codex(1, "P1")], [], false), undefined, "a current P1 does not hold when the site lets P1s ship");
assert.equal(
  classifyPr(pr([]), [thread(1), thread(2)], [codex(1, "P0"), codex(2, "P1")], [], false)?.findings.find((f) => f.severity === "P1")?.blocking,
  false,
  "with the P1 hold off, a P1 rides along as a non-blocking finding",
);
assert.deepEqual(
  classifyPr(pr([]), [thread(1, { outdated: true })], [codex(1, "P0")], [])?.reasons,
  ["Codex P0"],
  "an outdated P0 still holds (merge-pending rule)",
);
assert.equal(classifyPr(pr([]), [thread(1, { resolved: true })], [codex(1, "P0")], []), undefined, "resolved threads do not hold");
assert.equal(classifyPr(pr([]), [thread(1)], [codex(1, "P2")], []), undefined, "a P2 alone does not hold");
assert.equal(
  classifyPr(pr([]), [thread(1)], [{ id: 1, body: badge("P1"), user: { login: "someone" } }], []),
  undefined,
  "only Codex comments count",
);
assert.equal(classifyPr(pr([]), [thread(1)], [], []), undefined, "a thread whose comment is missing is ignored");

held = classifyPr(pr([]), [thread(1), thread(2), thread(3, { outdated: true })], [codex(1, "P1"), codex(2, "P2"), codex(3, "P2")], []);
assert.deepEqual(held?.findings.map((f) => f.severity), ["P1", "P2"], "current P2s ride along; outdated ones do not");

assert.deepEqual(classifyPr(pr(["autoblog-review-failed"]), [], [], [])?.reasons, ["session review failed"]);
assert.deepEqual(classifyPr(pr(["autoblog-link-repair-needed"]), [], [], [])?.reasons, ["dead link"]);
assert.deepEqual(
  classifyPr(pr([]), [thread(1), thread(2)], [codex(1, "P1"), codex(2, "P1")], [])?.reasons,
  ["Codex P1"],
  "reasons are de-duplicated",
);

assert.match(classifyPr(pr(["autoblog-hold"]), [thread(1)], [codex(1, "P1")], [])?.blocked ?? "", /autoblog-hold/);
assert.match(classifyPr(pr(["autoblog-human-approved"]), [thread(1)], [codex(1, "P1")], [])?.blocked ?? "", /human approved/);
assert.match(
  classifyPr(pr(["autoblog-review-failed-overridden"]), [thread(1)], [codex(1, "P1")], [])?.blocked ?? "",
  /human approved/,
);
const marks = Array.from({ length: MAX_REVISIONS }, (_, i) => ({
  body: `${REVISION_MARKER}\n**Autoblog revision ${i + 1} of ${MAX_REVISIONS}**`,
  author_association: "OWNER",
}));
held = classifyPr(pr([]), [thread(1)], [codex(1, "P1")], marks);
assert.equal(held?.revisions, MAX_REVISIONS);
assert.match(held?.blocked ?? "", /already revised/, "capped after MAX_REVISIONS");
assert.equal(held?.capped, true, "a capped post is closed by `revise --list`");
assert.equal(classifyPr(pr([]), [thread(1)], [codex(1, "P1")], marks.slice(1))?.blocked, undefined, "one revision is not the cap");
assert.equal(classifyPr(pr([]), [thread(1)], [codex(1, "P1")], marks.slice(1))?.capped, false);
assert.equal(classifyPr(pr(["autoblog-hold"]), [thread(1)], [codex(1, "P1")], marks)?.capped, false, "a human pause is never closed");
assert.equal(classifyPr(pr(["autoblog-human-approved"]), [thread(1)], [codex(1, "P1")], marks)?.capped, false);
assert.equal(classifyPr(pr([]), [], [], marks), undefined, "a capped post with nothing blocking is not held, so not closed");

// ── revisionPlan ────────────────────────────────────────────────────────────
const reportPlan = { title: "Old", faqs: [{ question: "q", answer: "old" }], tags: ["a"], imagePrompt: "p", angle: "x" };
const plan = revisionPlan(reportPlan, {
  title: "New",
  faqs: [{ question: "q", answer: "fixed on the PR" }],
  tags: "not-an-array",
  author: "Someone",
  angle: null,
});
assert.equal(plan.title, "New", "frontmatter wins for a field the post carries");
assert.deepEqual(plan.faqs, [{ question: "q", answer: "fixed on the PR" }]);
assert.deepEqual(plan.tags, ["a"], "a field of another shape is not taken");
assert.equal(plan.imagePrompt, "p", "plan-only fields stay");
assert.equal(plan.angle, "x", "a null frontmatter value is ignored");
assert.equal("author" in plan, false, "frontmatter-only fields are not added");

// ── withoutAutoLinks ────────────────────────────────────────────────────────
const linked = [
  "Call about your [refrigerator](/services/refrigerator-repair) today.",
  "",
  "Homes in [Sacramento](/areas/sacramento) see this.",
  "",
  "An old [refrigerator](/blog/gasket-post) leaks.",
  "",
  "",
  "",
  "## When to Call a Pro",
  "",
  "See our [contact page](/contact).",
  "",
].join("\n");
const inline = {
  service: { href: "/services/refrigerator-repair", anchor: "refrigerator", strategy: "inline" },
  area: { href: "/areas/sacramento", anchor: "Sacramento", strategy: "inline" },
  related: { href: "/blog/gasket-post", anchor: "refrigerator", strategy: "inline" },
};
const stripped = withoutAutoLinks(linked, inline);
assert.ok(!stripped.includes("](/services/") && !stripped.includes("](/areas/") && !stripped.includes("](/blog/"), "inline auto-links removed");
assert.ok(stripped.includes("[contact page](/contact)"), "the writer's own links stay");
assert.ok(!/\n{3,}/.test(stripped), "extra blank lines collapse");

const fallback = [
  "Body text.",
  "",
  "## Related Resources",
  "",
  "- [Refrigerator Repair](/services/refrigerator-repair)",
  "- [Sacramento](/areas/sacramento)",
  "",
  "## When to Call a Pro",
  "",
  "Call us.",
  "",
].join("\n");
const noBlock = withoutAutoLinks(fallback, {
  service: { href: "/services/refrigerator-repair", anchor: "Refrigerator Repair", strategy: "fallback" },
  area: { href: "/areas/sacramento", anchor: "Sacramento", strategy: "fallback" },
});
assert.ok(!noBlock.includes("Related Resources"), "an emptied Related Resources block goes");
assert.ok(noBlock.includes("## When to Call a Pro"));
const partBlock = withoutAutoLinks(fallback, {
  service: { href: "/services/refrigerator-repair", anchor: "Refrigerator Repair", strategy: "fallback" },
});
assert.ok(partBlock.includes("## Related Resources") && partBlock.includes("- [Sacramento](/areas/sacramento)"), "a block with entries left stays");
assert.equal(withoutAutoLinks("Plain.\n", undefined), "Plain.\n", "no auto-links recorded: body unchanged");
assert.equal(
  withoutAutoLinks("A [x](/a(b)) link.\n", { service: { href: "/a(b)", anchor: "x", strategy: "fallback" } }),
  "A [x](/a(b)) link.\n",
  "regex characters in an href are escaped; an inline link is not a fallback entry",
);

// ── blocking flag on Codex findings ─────────────────────────────────────────
held = classifyPr(pr([]), [thread(1), thread(2)], [codex(1, "P1"), codex(2, "P2")], []);
assert.deepEqual(held?.findings.map((f) => [f.severity, f.blocking]), [["P1", true], ["P2", false]], "only P0/P1 are blocking; resolve leaves P2 open");

// ── reportFindings ──────────────────────────────────────────────────────────
const failedReport = {
  planViolations: ["metaDescription is 170 characters"],
  bodyViolations: [],
  structuralViolations: [{ rule: "cta-heading", message: "missing" }],
  claudeReview: {
    result: {
      pass: false,
      overallScore: 6.4,
      scores: [
        { dimension: "contentQuality", score: 5.5, reasoning: "thin" },
        { dimension: "seoMetadata", score: 7, reasoning: "ok" },
        { dimension: "brandVoiceFit", score: 6.5, reasoning: "ok" },
        { dimension: "humanVoice", score: 4, reasoning: "advisory" },
      ],
      thresholdReasoning: "contentQuality under the floor",
      issues: [
        { severity: "minor", message: "nit" },
        { severity: "major", message: "thin section", suggestion: "expand", location: "## Why" },
      ],
    },
  },
  linkAudit: { unresolved: ["https://dead.example/x"] },
};
let rf = reportFindings(failedReport, ["session review failed"]);
assert.deepEqual(rf.map((f) => f.kind), ["rule", "rule", "review", "gate"], "rule violations, non-minor issues and the gate");
assert.ok(rf.every((f) => f.blocking));
assert.match(rf[1].text, /structuralViolations: .*cta-heading/, "object violations are stringified");
assert.match(rf[3].text, /contentQuality 5\.5/, "score below the floor is named");
assert.ok(!rf[3].text.includes("humanVoice"), "humanVoice is advisory");
assert.match(rf[3].text, /overall 6\.4 is below 7\.0/);
rf = reportFindings(
  { claudeReview: { result: { pass: false, overallScore: 6.8, scores: { contentQuality: 7 }, issues: [] } } },
  ["session review failed"],
);
assert.deepEqual(rf.map((f) => f.kind), ["gate"], "a score-only failure still yields a finding");
assert.match(
  reportFindings({ claudeReview: { result: { pass: false, scores: { contentQuality: 5 }, issues: [] } } }, ["session review failed"])[0].text,
  /contentQuality 5/,
  "a keyed scores object is read too",
);
assert.deepEqual(reportFindings(failedReport, ["dead link"]).map((f) => f.kind), ["link"], "dead link reason: links only");
assert.deepEqual(reportFindings(failedReport, ["Codex P1"]), [], "a Codex-only hold adds nothing from the report");
assert.deepEqual(
  reportFindings({ claudeReview: { result: { pass: true, issues: [{ severity: "major", message: "x" }] } } }, ["session review failed"]).map((f) => f.kind),
  ["review"],
  "a passing review adds no gate finding",
);

// ── revisionCount ───────────────────────────────────────────────────────────
assert.equal(
  revisionCount([
    { body: `${REVISION_MARKER}\n**Autoblog revision 1 of 2 did not land.**`, author_association: "OWNER" },
    { body: `${REVISION_MARKER}\n**Autoblog revision 1 of 2** (abc1234).`, author_association: "OWNER" },
    { body: `${REVISION_MARKER}\n**Autoblog revision 1 of 2** (abc1234).`, author_association: "OWNER" },
    { body: "unrelated", author_association: "OWNER" },
  ]),
  1,
  "a timeout note, the landed revision and a retry are one revision",
);
assert.equal(
  revisionCount([
    { body: `${REVISION_MARKER} revision 1 of 2`, author_association: "OWNER" },
    { body: `${REVISION_MARKER} revision 2 of 2`, author_association: "OWNER" },
  ]),
  2,
);
assert.equal(
  revisionCount([
    { body: `${REVISION_MARKER} revision 1 of 2`, author_association: "NONE" },
    { body: `${REVISION_MARKER} revision 2 of 2`, author_association: "CONTRIBUTOR" },
    { body: `${REVISION_MARKER} revision 3 of 2` },
  ]),
  0,
  "markers from commenters without write access are not counted",
);
assert.equal(
  revisionCount([
    { body: `${REVISION_MARKER} revision 1 of 2`, author_association: "MEMBER", user: { login: "someone" } },
    { body: `${REVISION_MARKER} revision 2 of 2`, author_association: "COLLABORATOR", user: { login: "someone" } },
  ]),
  0,
  "MEMBER and COLLABORATOR do not prove write access",
);
assert.equal(
  revisionCount(
    [
      { body: `${REVISION_MARKER} revision 1 of 2`, author_association: "OWNER", user: { login: "routine" } },
      { body: `${REVISION_MARKER} revision 2 of 2`, author_association: "OWNER", user: { login: "someone" } },
    ],
    "routine",
  ),
  1,
  "with the routine's login known, only its own markers count",
);
assert.equal(isRoutineMarker({ body: `${REVISION_MARKER} revision 1 of 2`, user: { login: "routine" } }, "routine"), true);
assert.equal(isRoutineMarker({ body: `${REVISION_MARKER} revision 1 of 2`, user: { login: "someone" } }, "routine"), false);
assert.equal(isRoutineMarker({ body: "revision 1 of 2", user: { login: "routine" } }, "routine"), false, "no marker, no match");

// ── publish ─────────────────────────────────────────────────────────────────
const run = (name: string, conclusion: string | null, started: string, status = "completed") => ({ name, status, conclusion, started_at: started });
assert.deepEqual(
  ciSummary([run("tests", "success", "1"), run("review", "skipped", "1")], [{ context: "Vercel", state: "success" }]),
  { pending: [], failing: [] },
  "green and skipped checks pass",
);
assert.deepEqual(
  ciSummary([run("claude-reviewed", "cancelled", "1"), run("claude-reviewed", "success", "2")], []).failing,
  [],
  "a cancelled run superseded by a later pass does not fail",
);
assert.deepEqual(ciSummary([run("tests", null, "1", "in_progress")], []).pending, ["tests"]);
assert.deepEqual(
  ciSummary([run("tests", "success", "1"), { name: "tests", status: "queued", conclusion: null, started_at: null }], []).pending,
  ["tests"],
  "a queued rerun (no started_at yet) is newer than the finished run it replaces",
);
assert.deepEqual(
  ciSummary([run("tests", "failure", "1"), run("tests", "success", "2")], []).failing,
  ["tests"],
  "a failure stays a failure after a passing rerun, as in merge-pending's gate",
);
assert.deepEqual(
  ciSummary([run("tests", "success", "1"), run("tests", "cancelled", "2")], []).failing,
  ["tests"],
  "a cancellation after the pass is not superseded",
);
assert.deepEqual(ciSummary([run("tests", "failure", "1")], []).failing, ["tests"]);
assert.deepEqual(
  ciSummary([run("tests", "success", "1")], [{ context: "Vercel", state: "success" }, { context: "Vercel", state: "pending" }]).pending,
  [],
  "only the newest status per context counts",
);
assert.deepEqual(ciSummary([], []).pending, ["CI (no checks yet)"], "no checks means CI has not started, not that it passed");
assert.deepEqual(
  ciSummary([], [{ context: "ci/status-only", state: "success" }]),
  { pending: [], failing: [] },
  "CI reported only through commit statuses counts, as in merge-pending's rollup",
);
assert.deepEqual(ciSummary([run("Heal PR 12", "failure", "1"), run("tests", "success", "1")], []), { pending: [], failing: [] }, "Codex Heal helpers are ignored");
assert.deepEqual(
  ciSummary([{ ...run("review", "cancelled", "1"), workflow: "Autoblog Review" }, { ...run("review", "success", "2"), workflow: "CI" }], []).failing,
  ["review"],
  "a pass in another workflow with the same job name does not supersede a cancelled run",
);
assert.deepEqual(
  ciSummary([{ ...run("review", "cancelled", "1"), workflow: "CI" }, { ...run("review", "success", "2"), workflow: "CI" }], []).failing,
  [],
);
assert.deepEqual(ciSummary([{ ...run("heal", "failure", "1"), workflow: "Autoblog Codex Heal" }, run("tests", "success", "1")], []).failing, []);
assert.deepEqual(
  ciSummary([{ ...run("tests", "cancelled", "1"), started_at: null, completed_at: "2026-09-28T09:01:00Z" }, { ...run("tests", "success", "1"), started_at: "2026-09-28T09:02:00Z" }], []).failing,
  [],
  "a run cancelled while queued is dated by its completion time",
);

const bot = { login: "chatgpt-codex-connector[bot]" };
const none = { request: [], pr: [], soleHead: true };
const at = "2026-09-28T09:00:00Z";
const up = (created_at: string) => ({ user: bot, content: "+1", created_at });
assert.equal(codexOnHead("h1", at, [{ user: bot, commit_id: "h1" }], none, []), "reviewed");
assert.equal(codexOnHead("h1", at, [{ user: bot, commit_id: "h0" }], none, []), "pending", "a review of an older head does not count");
assert.equal(
  codexOnHead("h1", at, [], { ...none, request: [up("2026-09-28T09:05:00Z")] }, []),
  "reviewed",
  "a 👍 on the request naming this head means Codex found nothing",
);
assert.equal(
  codexOnHead("h1", at, [], { ...none, pr: [up("2026-09-28T09:05:00Z")] }, []),
  "reviewed",
  "a 👍 on a PR that never had another head is about this head",
);
assert.equal(
  codexOnHead("h1", at, [], { ...none, pr: [up("2026-09-28T09:05:00Z")], soleHead: false }, []),
  "pending",
  "a PR-level 👍 cannot prove which head it was for once the head changed",
);
assert.equal(codexOnHead("h1", at, [], { ...none, pr: [up("2026-09-27T09:05:00Z")] }, []), "pending");
assert.equal(
  codexOnHead("h1", at, [], none, [{ user: bot, body: "You have reached your Codex usage limits", created_at: "2026-09-28T09:03:00Z" }]),
  "limited",
);
const clean = (sha: string) => ({
  user: bot,
  body: `Codex Review: Didn't find any major issues. Bravo.\n\n**Reviewed commit:** \`${sha}\``,
  created_at: "2026-10-03T08:57:28Z",
});
assert.equal(
  codexOnHead("ceb0a22b128727b881d2727fa6c7e9b26d132f26", at, [], { ...none, soleHead: false }, [clean("ceb0a22b12")]),
  "reviewed",
  "a clean-review comment naming this head counts (pulse-website#426)",
);
assert.equal(
  codexOnHead("ceb0a22b128727b881d2727fa6c7e9b26d132f26", at, [], { ...none, soleHead: false }, [clean("bb56d49a11")]),
  "pending",
  "a clean-review comment about an older head does not count",
);
assert.equal(
  codexOnHead("ceb0a22b128727b881d2727fa6c7e9b26d132f26", at, [], none, [{ ...clean("ceb0a22b12"), user: { login: "someone" } }]),
  "pending",
  "only Codex's own comment counts",
);
assert.deepEqual(
  headRequestComments([{ id: 1, body: "@codex review" }, { id: 2, body: "@codex review\n\n<!-- autoblog-codex-heal-head: h1 -->" }, { id: 3, body: "<!-- autoblog-codex-heal-head: h0 -->" }], "h1").map((c) => c.id),
  [2],
);

const green = { finalized: true, approvedOnHead: true, pendingLabel: true, ci: { pending: [], failing: [] }, codex: "reviewed" as const };
assert.equal(publishVerdict(green), "ready");
assert.equal(publishVerdict({ ...green, codex: "limited" }), "delayed");
assert.equal(publishVerdict({ ...green, codex: "pending" }), "wait");
assert.equal(publishVerdict({ ...green, codex: "pending", approvedMinutes: 61 }), "ready", "past the merge delay, a silent Codex does not hold the post");
assert.equal(publishVerdict({ ...green, codex: "limited", approvedMinutes: 30 }), "delayed");
assert.equal(publishVerdict({ ...green, codex: "limited", approvedMinutes: 60 }), "ready");
assert.equal(publishVerdict({ ...green, finalized: false }), "wait");
assert.equal(publishVerdict({ ...green, ci: { pending: [], failing: ["tests"] } }), "broken");
held = classifyPr(pr([]), [thread(1)], [codex(1, "P1")], []);
assert.equal(publishVerdict({ ...green, held }), "held", "a Codex P1 sends it back to step 0b");
assert.equal(publishVerdict({ ...green, held: held && { ...held, blocked: "autoblog-hold" } }), "blocked");
assert.equal(publishVerdict({ ...green, paused: true }), "blocked", "autoblog-hold alone blocks a ready post");

// Emergency, hazard and health topics are out of scope; everyday ones are not.
for (const topic of [
  "24-hour AC repair during a Sacramento heat wave",
  "emergency furnace repair on a holiday",
  "carbon monoxide detector placement for furnace season",
  "gas leak signs near a water heater",
  "Is it safe to run the AC with ice on the coil?",
  "dryer vent fire risk in older homes",
  "heat stroke and a broken AC",
  "24/7 HVAC service near me",
  "AC repair open 24 hours in Sacramento",
  "after-hours furnace repair cost",
  "smoke coming from a furnace vent",
  "sparks from an AC disconnect",
  "microwave sparking inside",
  "why is my AC unit smoking",
  "emergency heating repair on a holiday",
  "emergency heater repair near me",
  "emergency heat repair",
  "24 hour heating and air conditioning repair",
  "furnace smells like smoke",
  "smoke odor from AC",
  "outlet sparking behind the fridge",
  "emergency heat pump repair",
  "furnace fire causes",
  "what to do if an AC unit catches fire",
  "can air conditioning trigger asthma?",
  "is my AC making me sick",
  "HVAC company that is open 24 hours",
  "furnace smells like gas",
  "gas odor from furnace",
  "emergency heat pump replacement",
  "emergency heat pump installation",
  "emergency heat system repair",
  "can air conditioning cause headaches?",
  "why does AC make me dizzy?",
  "HVAC and nausea",
  "burning odor from furnace",
  "fire coming from a furnace",
  "what to do after an oven caught fire",
  "why is my furnace leaking gas?",
  "gas leaking from a water heater",
]) {
  assert.ok(offLimitsTopic(topic), `off limits: ${topic}`);
}
for (const topic of [
  "furnace short cycling after a filter change",
  "SMUD rebate for a smart thermostat: is it worth it?",
  "heat pump defrost mode explained",
  "heat pump emergency heat mode: when to use it",
  "emergency heat vs aux heat on a heat pump",
  "what is emergency heat?",
  "gas range spark igniter not working",
  "oven spark electrode replacement",
  "igniter keeps sparking on a gas stove",
  "condensate safety switch keeps tripping",
  "furnace limit safety switch troubleshooting",
  "AC runs 24/7: when to call for repair",
  "wildfire smoke smell inside the house",
  "smoke smell in the house after wildfire smoke days",
  "refrigerator still warm after 24 hours",
  "emergency heat on a heat pump",
  "using emergency heat during a cold snap",
  "emergency heat costs",
  "furnace spark ignitor replacement",
  "furnace fires up then shuts off",
  "HVAC tips for allergy sufferers",
  "AC ran 24 hours before needing repair",
  "after 24 hours the refrigerator needs service",
  "AC runs 24/7 and needs service",
  "gas furnace vs heat pump",
  "allergy-safe furnace filters",
  "AC runs nonstop 24/7 and needs service",
  "AC runs nearly 24/7 in a heat wave",
  "gas fireplace pilot light basics",
  "AC refrigerant leak signs",
  "wildfire smoke and MERV 13 filters",
  "fireplace draft and your thermostat",
  "dryer vent cleaning cost in Sacramento",
  "AC sticker shock: what a new system costs",
  "how to safely clean condenser coils",
  "why does my AC run 24/7?",
  "should I run the HVAC fan 24 hours a day?",
  "smoke from wildfires and your HVAC filter",
  "wildfire smoke from the outside air intake",
]) {
  assert.equal(offLimitsTopic(topic), undefined, `in scope: ${topic}`);
}
assert.equal(offLimitsTopic(undefined, "furnace filter sizes", "co alarm beeping"), "co alarm", "every text is checked");

console.log("✔ revise helper tests passed");
