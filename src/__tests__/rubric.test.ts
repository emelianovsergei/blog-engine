import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_RUBRIC_CONSTRAINTS,
  RUBRIC_RULES,
  checkArticleBody,
  plannerRubricRules,
  reviewerRubric,
  writerRubricRules,
  type RubricConstraints,
} from "../rubric.js";
import { DIMENSION_LABELS } from "../review.js";

const C = DEFAULT_RUBRIC_CONSTRAINTS;
const reviewer = (c: RubricConstraints = C): string =>
  reviewerRubric(c, { dimensionLabels: DIMENSION_LABELS });

test("every writer rule reaches the writer block", () => {
  const rendered = writerRubricRules();
  for (const rule of RUBRIC_RULES) {
    if (!rule.audience.includes("writer")) continue;
    const line = rule.instruction(C);
    if (!line.trim()) continue;
    assert.ok(rendered.includes(line), `writer block missing rule "${rule.id}"`);
  }
});

test("every dimension the reviewer grades has at least one criterion", () => {
  const rendered = reviewer();
  for (const dimension of ["contentQuality", "seoMetadata", "brandVoiceFit"]) {
    assert.match(rendered, new RegExp(`\\(${dimension}\\)`));
  }
});

// The drift that caused this module: the writer was told "only ##" while the
// reviewer rewarded "logical H2/H3 structure", so posts lost points for a rule
// they were forbidden to satisfy.
test("h2-only sites never have the reviewer demand H3 nesting", () => {
  const rendered = reviewer();
  assert.doesNotMatch(rendered, /H2\/H3/);
  assert.match(rendered, /do NOT penalise the absence of H3/i);
  assert.match(writerRubricRules(), /Use only ## headings/);
});

test("h2-h3 sites flip both surfaces together", () => {
  const c: RubricConstraints = { ...C, headingPolicy: "h2-h3" };
  assert.match(reviewer(c), /H2\/H3/);
  assert.match(writerRubricRules(c), /### only where/);
});

// Second contradiction: writer forbidden to write an FAQ, reviewer grading its
// presence in the body.
test("code-appended FAQ tells the writer not to write one and the reviewer not to expect one", () => {
  assert.match(writerRubricRules(), /Do NOT write a "Frequently Asked Questions" section/);
  assert.match(reviewer(), /appended by the build.*must not be penalised/is);
  assert.match(reviewer(), /frontmatter\.faqs/);
});

test("constraints propagate to writer, reviewer and checker in lockstep", () => {
  const c: RubricConstraints = { ...C, minWords: 1200, maxWords: 1500 };

  assert.match(writerRubricRules(c), /between 1200 and 1500 words/);
  assert.match(reviewer(c), /roughly 1200-1500 words/);
  assert.deepEqual(
    checkArticleBody("word ".repeat(900), c).filter((v) => v.rule === "word-count").length,
    1,
  );
});

test("planner rules carry the title minimum and slug ceiling the reviewer grades", () => {
  const rendered = plannerRubricRules();
  assert.match(rendered, /40-65 characters/);
  assert.match(rendered, /under 60 characters/);
});

test("checkArticleBody catches banned words, openers and stray H3", () => {
  const body = [
    "## Intro",
    "In today's world, homeowners delve into HVAC choices.",
    "### Sub heading",
    "Short one.",
  ].join("\n\n");

  const ids = checkArticleBody(body).map((v) => v.rule);

  assert.ok(ids.includes("banned-word"));
  assert.ok(ids.includes("banned-opener"));
  assert.ok(ids.includes("heading-structure"));
});

test("checkArticleBody flags em-dash density and uniform paragraph rhythm", () => {
  const uniform = Array.from({ length: 6 }, () => `${"word ".repeat(30)}— and more —.`).join("\n\n");
  const ids = checkArticleBody(uniform).map((v) => v.rule);

  assert.ok(ids.includes("em-dash-density"));
  assert.ok(ids.includes("paragraph-rhythm"));
});

test("varied human-shaped prose passes the rhythm and density checks", () => {
  const varied = [
    "Short answer: no.",
    "word ".repeat(60),
    "word ".repeat(12),
    "word ".repeat(95),
    "word ".repeat(25),
    "It depends on the ductwork, and that is worth measuring before you spend anything.",
  ].join("\n\n");

  const ids = checkArticleBody(varied).map((v) => v.rule);

  assert.ok(!ids.includes("paragraph-rhythm"));
  assert.ok(!ids.includes("em-dash-density"));
});

test("required headings are enforced deterministically", () => {
  const c: RubricConstraints = { ...C, requiredHeadings: ["When to Call HVAC Pulse"] };

  assert.ok(checkArticleBody("## Something", c).some((v) => v.rule === "required-headings"));
  assert.ok(
    !checkArticleBody("## When to Call HVAC Pulse\n\nText.", c).some(
      (v) => v.rule === "required-headings",
    ),
  );
});

test("an FAQ written into the body is caught when FAQs are code-appended", () => {
  const violations = checkArticleBody("## Frequently Asked Questions\n\nQ?");
  assert.ok(violations.some((v) => v.rule === "faq-authorship"));
});
