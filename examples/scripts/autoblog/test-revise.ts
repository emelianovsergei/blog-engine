#!/usr/bin/env tsx
/**
 * Unit tests for the held-post rules behind `autoblog:claude revise`. Offline:
 *   npx tsx scripts/autoblog/test-revise.ts
 */
import assert from "node:assert/strict";
import {
  MAX_REVISIONS,
  REVISION_MARKER,
  classifyPr,
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

let held = classifyPr(pr([]), [thread(1)], [codex(1, "P1")], []);
assert.deepEqual(held?.reasons, ["Codex P1"], "a current P1 holds");
assert.equal(held?.findings[0].commentId, 1);
assert.equal(held?.blocked, undefined);

assert.equal(classifyPr(pr([]), [thread(1, { outdated: true })], [codex(1, "P1")], []), undefined, "an outdated P1 does not hold");
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
const marks = Array.from({ length: MAX_REVISIONS }, (_, i) => ({ body: `${REVISION_MARKER}\n**Autoblog revision ${i + 1} of ${MAX_REVISIONS}**` }));
held = classifyPr(pr([]), [thread(1)], [codex(1, "P1")], marks);
assert.equal(held?.revisions, MAX_REVISIONS);
assert.match(held?.blocked ?? "", /needs a human/, "capped after MAX_REVISIONS");
assert.equal(classifyPr(pr([]), [thread(1)], [codex(1, "P1")], marks.slice(1))?.blocked, undefined, "one revision is not the cap");

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
    { body: `${REVISION_MARKER}\n**Autoblog revision 1 of 2 did not land.**` },
    { body: `${REVISION_MARKER}\n**Autoblog revision 1 of 2** (abc1234).` },
    { body: `${REVISION_MARKER}\n**Autoblog revision 1 of 2** (abc1234).` },
    { body: "unrelated" },
  ]),
  1,
  "a timeout note, the landed revision and a retry are one revision",
);
assert.equal(revisionCount([{ body: `${REVISION_MARKER} revision 1 of 2` }, { body: `${REVISION_MARKER} revision 2 of 2` }]), 2);

console.log("✔ revise helper tests passed");
