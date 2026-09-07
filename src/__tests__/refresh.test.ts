import assert from "node:assert/strict";
import test from "node:test";
import { applyHowToShape, refreshBlogPost } from "../refresh.js";
import type { BlogPostFrontmatter } from "../review.js";
import { parseLinkPolicy } from "../links.js";
import { DEFAULT_RUBRIC_CONSTRAINTS } from "../rubric.js";
import { makeFakeGemini, sampleConfig } from "./fakes.js";
import type { GenerateContentCall } from "./fakes.js";

const RUBRIC = { ...DEFAULT_RUBRIC_CONSTRAINTS, requiredHeadings: ["When to Call a Pro"] };

const frontmatter: BlogPostFrontmatter = {
  title: "Dryer Takes Two Cycles to Dry in Sacramento Summers",
  description: "Why a dryer needs two cycles after a Sacramento heat wave and what to check first.",
  slug: "dryer-takes-two-cycles",
  tags: ["Dryer", "Sacramento"],
  category: "appliance",
  date: "2026-06-01",
  faqs: [{ question: "Old Q?", answer: "Old A." }],
};

const filler = Array.from({ length: 60 }, (_, i) => `Sentence ${i} about dryer vents and heat.`).join(" ");
const markdown = `Intro paragraph about a dryer that needs two cycles. ${filler}\n\n## Why the vent matters\n\n${filler}\n\n## Clean the lint path\n\n${filler}\n\n## When to Call a Pro\n\nCall us. ${filler}`;

const queries = [
  { query: "dryer takes two cycles to dry", impressions: 900, position: 9.2 },
  { query: "dryer not drying in one cycle", impressions: 300, position: 14 },
];

function modelOutput(overrides: Record<string, unknown> = {}) {
  return {
    frontmatter: {
      summary:
        "A dryer that needs two cycles almost always has a restricted exhaust path, not a weak heater. Clean the lint screen, the vent hose and the outside hood, then run a load; if it still takes two cycles the thermostat or heating element needs a technician rather than another reset or a longer cycle.",
      faqs: [
        { question: "Why does my dryer take two cycles to dry?", answer: "Restricted exhaust is the usual cause." },
        { question: "Is a dryer that takes two cycles dangerous?", answer: "Lint buildup is a fire risk; clean the vent." },
        { question: "How do I fix a dryer not drying in one cycle?", answer: "Clear the vent path end to end, then test." },
      ],
      targetKeyword: "dryer takes two cycles to dry",
      keywords: ["dryer not drying in one cycle", "dryer vent cleaning"],
      citations: [
        { name: "U.S. Fire Administration — clothes dryer safety", url: "https://www.usfa.fema.gov/" },
        { name: "Retired page", url: "https://www.energy.gov/energysaver/dead" },
      ],
    },
    markdown: `${markdown}\n\n## Dryer not drying in one cycle: the quick test\n\nRun one load with the vent hose disconnected; if it dries, the vent is the problem.`,
    changeNotes: "Added summary, FAQs answering the ranking queries, a section for the second query.",
    ...overrides,
  };
}

const policy = parseLinkPolicy({ deniedUrlFragments: ["energy.gov/energysaver/"] });

test("refresh mode regenerates the requested fields, adds one section, sets updated, keeps routing keys", async () => {
  const capture: GenerateContentCall[] = [];
  const result = await refreshBlogPost({
    gemini: makeFakeGemini({ candidatesJson: modelOutput(), capture }),
    config: sampleConfig,
    frontmatter,
    markdown,
    rankingQueries: queries,
    now: new Date("2026-09-08T09:00:00-07:00"),
    mode: "refresh",
    rubric: RUBRIC,
    linkPolicy: policy,
  });

  const prompt = String(capture[0]?.contents);
  assert.match(prompt, /dryer takes two cycles to dry/, "ranking queries are in the prompt");
  assert.match(prompt, /900/, "impressions are shown");
  assert.match(prompt, /When to Call a Pro/, "required headings are named");
  assert.match(prompt, /Frequently Asked Questions/i, "the no-body-FAQ rule is stated");

  assert.equal(result.frontmatter.slug, "dryer-takes-two-cycles");
  assert.equal(result.frontmatter.date, "2026-06-01");
  assert.equal(result.frontmatter.title, frontmatter.title);
  assert.equal(result.frontmatter.category, "appliance");
  assert.equal(result.frontmatter.updated, "2026-09-08");
  assert.equal(typeof result.frontmatter.summary, "string");
  assert.equal((result.frontmatter.faqs as unknown[]).length, 3);
  assert.equal(result.frontmatter.targetKeyword, "dryer takes two cycles to dry");
  assert.deepEqual(result.frontmatter.citations, [
    { name: "U.S. Fire Administration — clothes dryer safety", url: "https://www.usfa.fema.gov/" },
  ]);
  assert.match(result.markdown, /## Dryer not drying in one cycle/);
  assert.ok(result.changedFields.includes("summary"));
  assert.ok(result.changedFields.includes("markdown"));
});

test("backfill mode keeps the body verbatim and only fills the requested fields", async () => {
  const result = await refreshBlogPost({
    gemini: makeFakeGemini({ candidatesJson: modelOutput() }),
    config: sampleConfig,
    frontmatter,
    markdown,
    rankingQueries: [],
    now: new Date("2026-09-08T09:00:00-07:00"),
    mode: "backfill",
    fields: ["summary", "citations"],
    rubric: RUBRIC,
    linkPolicy: policy,
  });
  assert.equal(result.markdown, markdown, "body untouched");
  assert.equal(typeof result.frontmatter.summary, "string");
  assert.deepEqual(result.frontmatter.faqs, frontmatter.faqs, "faqs not requested → unchanged");
  assert.equal(result.frontmatter.targetKeyword, undefined, "targetKeyword not requested → not added");
  assert.deepEqual(result.changedFields.sort(), ["citations", "summary"]);
  assert.equal(result.frontmatter.updated, "2026-09-08");
});

test("refresh rejects a body FAQ section, a dropped required heading, and a misaligned keyword", async () => {
  const run = (overrides: Record<string, unknown>) =>
    refreshBlogPost({
      gemini: makeFakeGemini({ candidatesJson: modelOutput(overrides) }),
      config: sampleConfig,
      frontmatter,
      markdown,
      rankingQueries: queries,
      now: new Date("2026-09-08T09:00:00-07:00"),
      mode: "refresh",
      rubric: RUBRIC,
      linkPolicy: policy,
    });

  await assert.rejects(run({ markdown: `${markdown}\n\n## FAQ\n\n**Q?**\n\nA.` }), /FAQ/);
  await assert.rejects(run({ markdown: markdown.replace("## When to Call a Pro", "## When to call a pro") }), /When to Call a Pro/);
  await assert.rejects(run({ markdown: markdown.replace("## Clean the lint path", "## Something else entirely") }), /Clean the lint path/);
  await assert.rejects(
    run({ frontmatter: { ...modelOutput().frontmatter, targetKeyword: "furnace ignition failure" } }),
    /keyword/i,
  );
});

test("refresh leaves updated unset and reports no changes when the model returns the same content", async () => {
  const same = {
    frontmatter: { faqs: frontmatter.faqs },
    markdown,
    changeNotes: "Nothing to change.",
  };
  const result = await refreshBlogPost({
    gemini: makeFakeGemini({ candidatesJson: same }),
    config: sampleConfig,
    frontmatter,
    markdown,
    rankingQueries: queries,
    now: new Date("2026-09-08T09:00:00-07:00"),
    mode: "refresh",
    fields: ["faqs"],
    rubric: RUBRIC,
  });
  assert.deepEqual(result.changedFields, []);
  assert.equal(result.frontmatter.updated, undefined);
});

// ─── Codex round 1 on #36 ────────────────────────────────────────────────────

test("refresh rejects reordered existing headings but allows one new one", async () => {
  const reordered = markdown.replace("## Why the vent matters", "## TMP").replace("## Clean the lint path", "## Why the vent matters").replace("## TMP", "## Clean the lint path");
  await assert.rejects(
    refreshBlogPost({
      gemini: makeFakeGemini({ candidatesJson: modelOutput({ markdown: reordered }) }),
      config: sampleConfig,
      frontmatter,
      markdown,
      rankingQueries: queries,
      now: new Date("2026-09-08T09:00:00-07:00"),
      mode: "refresh",
      rubric: RUBRIC,
      linkPolicy: policy,
    }),
    /order/i,
  );
});

test("refresh honours a written-by-model FAQ policy", async () => {
  const withFaq = `${markdown}\n\n## Frequently Asked Questions\n\n**Q?**\n\nA.`;
  const result = await refreshBlogPost({
    gemini: makeFakeGemini({ candidatesJson: modelOutput({ markdown: withFaq }) }),
    config: sampleConfig,
    frontmatter,
    markdown: withFaq,
    rankingQueries: queries,
    now: new Date("2026-09-08T09:00:00-07:00"),
    mode: "refresh",
    rubric: { ...RUBRIC, faqPolicy: "written-by-model" },
    linkPolicy: policy,
  });
  assert.match(result.markdown, /Frequently Asked Questions/);
});

test("refresh does not mark an identical HowTo as changed, in either site shape", async () => {
  const howTo = { name: "Clean the lint path", steps: [{ name: "a", text: "A" }, { name: "b", text: "B" }, { name: "c", text: "C" }] };
  const nested = { ...frontmatter, howTo: { name: howTo.name, step: howTo.steps } };
  const flat = { ...frontmatter, howToName: howTo.name, howToSteps: howTo.steps };
  for (const fm of [nested, flat]) {
    const result = await refreshBlogPost({
      gemini: makeFakeGemini({ candidatesJson: { frontmatter: { howTo }, markdown, changeNotes: "same" } }),
      config: sampleConfig,
      frontmatter: fm,
      markdown,
      rankingQueries: [],
      now: new Date("2026-09-08T09:00:00-07:00"),
      mode: "backfill",
      fields: ["howTo"],
      rubric: RUBRIC,
    });
    assert.deepEqual(result.changedFields, [], "identical HowTo is not a change");
    assert.equal(result.frontmatter.updated, undefined);
  }
});

test("refresh stamps updated in the site's timezone, not UTC", async () => {
  const result = await refreshBlogPost({
    gemini: makeFakeGemini({ candidatesJson: modelOutput() }),
    config: sampleConfig, // America/Los_Angeles
    frontmatter,
    markdown,
    rankingQueries: queries,
    now: new Date("2026-09-09T01:30:00Z"), // 6:30 PM PDT on Sept 8
    mode: "refresh",
    rubric: RUBRIC,
    linkPolicy: policy,
  });
  assert.equal(result.frontmatter.updated, "2026-09-08");
});

// ─── Codex round 2 on #36 ────────────────────────────────────────────────────

test("refresh prompt forbids a body FAQ only under appended-by-code", async () => {
  for (const faqPolicy of ["appended-by-code", "written-by-model"] as const) {
    const capture: GenerateContentCall[] = [];
    await refreshBlogPost({
      gemini: makeFakeGemini({ candidatesJson: modelOutput(), capture }),
      config: sampleConfig,
      frontmatter,
      markdown,
      rankingQueries: queries,
      now: new Date("2026-09-08T09:00:00-07:00"),
      mode: "refresh",
      rubric: { ...RUBRIC, faqPolicy },
      linkPolicy: policy,
    });
    const prompt = String(capture[0]?.contents);
    if (faqPolicy === "appended-by-code") assert.match(prompt, /Do NOT write a "Frequently Asked Questions"/);
    else assert.doesNotMatch(prompt, /Do NOT write a "Frequently Asked Questions"/);
  }
});

test("refresh ignores trailing-whitespace differences when deciding whether the body changed", async () => {
  const withNewline = `${markdown}\n`;
  const result = await refreshBlogPost({
    gemini: makeFakeGemini({ candidatesJson: { frontmatter: { faqs: frontmatter.faqs }, markdown, changeNotes: "same" } }),
    config: sampleConfig,
    frontmatter,
    markdown: withNewline,
    rankingQueries: queries,
    now: new Date("2026-09-08T09:00:00-07:00"),
    mode: "refresh",
    fields: ["faqs"],
    rubric: RUBRIC,
  });
  assert.deepEqual(result.changedFields, []);
  assert.equal(result.markdown, withNewline, "original whitespace kept when nothing substantive changed");
  assert.equal(result.frontmatter.updated, undefined);
});

test("refresh removes stale HowTo metadata when the model omits a requested howTo", async () => {
  const steps = [{ name: "a", text: "A" }, { name: "b", text: "B" }, { name: "c", text: "C" }];
  for (const fm of [
    { ...frontmatter, howTo: { name: "Old", step: steps } },
    { ...frontmatter, howToName: "Old", howToSteps: steps },
  ]) {
    const result = await refreshBlogPost({
      gemini: makeFakeGemini({ candidatesJson: { frontmatter: {}, markdown, changeNotes: "not procedural" } }),
      config: sampleConfig,
      frontmatter: fm,
      markdown,
      rankingQueries: [],
      now: new Date("2026-09-08T09:00:00-07:00"),
      mode: "backfill",
      fields: ["howTo"],
      rubric: RUBRIC,
    });
    assert.ok(result.changedFields.includes("howTo"), "removal is a change");
    assert.equal(result.frontmatter.howTo, undefined);
    assert.equal(result.frontmatter.howToName, undefined);
    assert.equal(result.frontmatter.howToSteps, undefined);
    assert.equal(result.frontmatter.updated, "2026-09-08");
  }
  // A post that never had a HowTo and gets none back: no change.
  const none = await refreshBlogPost({
    gemini: makeFakeGemini({ candidatesJson: { frontmatter: {}, markdown, changeNotes: "n/a" } }),
    config: sampleConfig,
    frontmatter,
    markdown,
    rankingQueries: [],
    now: new Date("2026-09-08T09:00:00-07:00"),
    mode: "backfill",
    fields: ["howTo"],
    rubric: RUBRIC,
  });
  assert.deepEqual(none.changedFields, []);
});

// ─── Codex round 3 on #36 ────────────────────────────────────────────────────

test("refresh rejects a response that omits a requested required field", async () => {
  for (const [field, output] of [
    ["summary", { frontmatter: {}, markdown, changeNotes: "n" }],
    ["faqs", { frontmatter: { faqs: "not a list" }, markdown, changeNotes: "n" }],
    ["targetKeyword", { frontmatter: { targetKeyword: 42 }, markdown, changeNotes: "n" }],
    ["citations", { frontmatter: { citations: [] }, markdown, changeNotes: "n" }],
  ] as const) {
    await assert.rejects(
      refreshBlogPost({
        gemini: makeFakeGemini({ candidatesJson: output }),
        config: sampleConfig,
        frontmatter,
        markdown,
        rankingQueries: [],
        now: new Date("2026-09-08T09:00:00-07:00"),
        mode: "backfill",
        fields: [field],
        rubric: RUBRIC,
        linkPolicy: policy,
      }),
      new RegExp(field),
      `${field} missing must reject`,
    );
  }
  // Optional fields (howTo, keywords) may be omitted without rejection.
  const ok = await refreshBlogPost({
    gemini: makeFakeGemini({ candidatesJson: { frontmatter: {}, markdown, changeNotes: "n" } }),
    config: sampleConfig,
    frontmatter,
    markdown,
    rankingQueries: [],
    now: new Date("2026-09-08T09:00:00-07:00"),
    mode: "backfill",
    fields: ["howTo", "keywords"],
    rubric: RUBRIC,
  });
  assert.deepEqual(ok.changedFields, []);
});

test("applyHowToShape converts the opposite site shape and counts the conversion as a change", () => {
  const howTo = { name: "Clean the lint path", steps: [{ name: "Unplug", text: "Unplug the dryer." }] };
  const flat: BlogPostFrontmatter = { ...frontmatter, howToName: howTo.name, howToSteps: howTo.steps };

  const nested = applyHowToShape(flat, howTo, "nested");
  assert.deepEqual(nested.frontmatter.howTo, { name: howTo.name, step: howTo.steps });
  assert.equal("howToName" in nested.frontmatter, false, "the flat keys come off");
  assert.equal("howToSteps" in nested.frontmatter, false);
  assert.equal(nested.changed, true, "a shape conversion must be persisted");

  const same = applyHowToShape(flat, howTo, "steps");
  assert.equal(same.changed, false, "identical data in the site's own shape is not a change");
  assert.deepEqual(same.frontmatter, flat);

  const none = applyHowToShape(flat, undefined, "nested");
  assert.equal(none.changed, false);
  assert.deepEqual(none.frontmatter, flat, "no HowTo from the model leaves the frontmatter alone");
});
