import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVerifiedFacts,
  parseReviewResult,
  renderReviewMarkdown,
  reviewBlogPost,
} from "../review.js";
import type { ReviewDimension } from "../review.js";
import type { BlogPostFrontmatter } from "../review.js";
import { makeFakeGemini, sampleConfig } from "./fakes.js";
import type { GenerateContentCall } from "./fakes.js";

const goodFrontmatter: BlogPostFrontmatter = {
  title: "How to Prep Your Sacramento HVAC for a Heat Wave",
  description:
    "A practical Sacramento homeowner's guide to readying your AC, ducts, and thermostat before the next heat wave rolls in.",
  slug: "prep-hvac-for-heat-wave",
  tags: ["cooling", "heat wave"],
  category: "hvac",
  date: "2026-06-01",
};

const goodMarkdown = `# How to Prep Your Sacramento HVAC for a Heat Wave\n\nA solid intro paragraph about what to do.\n\n## Step 1\n\nDetails here.\n\n## Conclusion\n\nWrap up.`;

/** A GeminiLike returning a scripted sequence of generateContent texts. */
function sequencedGemini(texts: string[]): {
  gemini: { models: { generateContent: (req: unknown) => Promise<{ text: string }>; embedContent: () => Promise<{ embeddings: [] }> } };
  calls: () => number;
} {
  let i = 0;
  return {
    gemini: {
      models: {
        async generateContent() {
          const text = texts[Math.min(i, texts.length - 1)]!;
          i += 1;
          return { text };
        },
        async embedContent() {
          return { embeddings: [] };
        },
      },
    },
    calls: () => i,
  };
}

// The model must return every dimension, so fixtures fill any the test does
// not care about with a neutral passing score.
const ALL_TEST_DIMENSIONS: ReviewDimension[] = [
  "contentQuality",
  "seoMetadata",
  "brandVoiceFit",
  "humanVoice",
];

function scoreEntries(
  values: Partial<Record<ReviewDimension, number>>,
): Array<{ dimension: ReviewDimension; score: number; reasoning: string }> {
  return ALL_TEST_DIMENSIONS.map((d) => ({
    dimension: d,
    score: values[d] ?? 8,
    reasoning: `r-${d}`,
  }));
}

test("the review rubric instructs the model on GEO / keyword-targeting criteria", async () => {
  const capture: GenerateContentCall[] = [];
  const gemini = makeFakeGemini({
    capture,
    candidatesJson: {
      scores: scoreEntries({ contentQuality: 8, seoMetadata: 8, brandVoiceFit: 8 }),
      issues: [],
      suggestions: [],
      summary: "ok",
    },
  });
  await reviewBlogPost({ gemini, config: sampleConfig, frontmatter: goodFrontmatter, markdown: goodMarkdown });

  const prompt = String(capture[0]!.contents).toLowerCase();
  assert.ok(prompt.includes("answer-first"), "rubric should reward answer-first structure");
  assert.ok(prompt.includes("faq"), "rubric should check for an FAQ / FAQPage");
  assert.ok(prompt.includes("targetkeyword") || prompt.includes("target keyword") || prompt.includes("primary keyword"), "rubric should check primary-keyword placement");
  assert.ok(prompt.includes("stuff"), "rubric should penalise keyword stuffing");
});

test("passes a well-formed post when all scores are above the floor", async () => {
  const gemini = makeFakeGemini({
    candidatesJson: {
      scores: scoreEntries({ contentQuality: 8, seoMetadata: 9, brandVoiceFit: 8 }),
      issues: [],
      suggestions: ["add a CTA at the end"],
      summary: "Solid, on-brand, ready to publish.",
    },
  });
  const result = await reviewBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter: goodFrontmatter,
    markdown: goodMarkdown,
  });

  assert.equal(result.pass, true);
  assert.ok(result.overallScore > 8 && result.overallScore < 9);
  assert.equal(result.scores.length, 4);
  assert.match(result.thresholdReasoning, /Passed/);
  assert.equal(result.modelUsed, "grok-4.6");
});

test("fails when any dimension drops below the per-dimension floor", async () => {
  const gemini = makeFakeGemini({
    candidatesJson: {
      scores: scoreEntries({ contentQuality: 9, seoMetadata: 9, brandVoiceFit: 5 }),
      issues: [],
      suggestions: [],
      summary: "Off brand.",
    },
  });
  const result = await reviewBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter: goodFrontmatter,
    markdown: goodMarkdown,
  });

  assert.equal(result.pass, false);
  assert.match(result.thresholdReasoning, /brandVoiceFit=5\.0 below floor 6\.0/);
});

test("fails on any blocker issue regardless of scores", async () => {
  const gemini = makeFakeGemini({
    candidatesJson: {
      scores: scoreEntries({ contentQuality: 9, seoMetadata: 9, brandVoiceFit: 9 }),
      issues: [
        {
          dimension: "seoMetadata",
          severity: "blocker",
          message: "Missing description.",
          suggestion: "Add a 120-160 char description.",
        },
      ],
      suggestions: [],
      summary: "Body is great, metadata broken.",
    },
  });
  const result = await reviewBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter: goodFrontmatter,
    markdown: goodMarkdown,
  });

  assert.equal(result.pass, false);
  assert.match(result.thresholdReasoning, /blocker/);
  assert.equal(result.issues[0]?.severity, "blocker");
});

test("fails when the overall score is below threshold even with no failing dimension", async () => {
  const gemini = makeFakeGemini({
    candidatesJson: {
      scores: scoreEntries({ contentQuality: 6.5, seoMetadata: 6.5, brandVoiceFit: 6.5 }),
      issues: [],
      suggestions: [],
      summary: "Mediocre.",
    },
  });
  const result = await reviewBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter: goodFrontmatter,
    markdown: goodMarkdown,
  });

  assert.equal(result.pass, false);
  assert.match(result.thresholdReasoning, /overall 6\.5 below threshold 7\.0/);
});

test("throws when Gemini returns an empty response", async () => {
  const gemini = makeFakeGemini({ generateText: "" });
  await assert.rejects(
    reviewBlogPost({
      gemini,
      config: sampleConfig,
      frontmatter: goodFrontmatter,
      markdown: goodMarkdown,
    }),
    /Empty review response/,
  );
});

test("throws when the response is not valid JSON", async () => {
  const gemini = makeFakeGemini({ generateText: "not json {" });
  await assert.rejects(
    reviewBlogPost({
      gemini,
      config: sampleConfig,
      frontmatter: goodFrontmatter,
      markdown: goodMarkdown,
    }),
    /not valid JSON/,
  );
});

test("throws when a required dimension score is missing", async () => {
  const gemini = makeFakeGemini({
    candidatesJson: {
      scores: [
        { dimension: "contentQuality", score: 8, reasoning: "ok" },
        { dimension: "seoMetadata", score: 8, reasoning: "ok" },
      ],
      issues: [],
      suggestions: [],
      summary: "Missing the third dim.",
    },
  });
  await assert.rejects(
    reviewBlogPost({
      gemini,
      config: sampleConfig,
      frontmatter: goodFrontmatter,
      markdown: goodMarkdown,
    }),
    /brandVoiceFit/,
  );
});

test("clamps out-of-range scores to [0, 10]", async () => {
  const gemini = makeFakeGemini({
    candidatesJson: {
      scores: [
        { dimension: "contentQuality", score: 12, reasoning: "" },
        { dimension: "seoMetadata", score: -3, reasoning: "" },
        { dimension: "brandVoiceFit", score: 7, reasoning: "" },
        { dimension: "humanVoice", score: 8, reasoning: "" },
      ],
      issues: [],
      suggestions: [],
      summary: "Edge values.",
    },
  });
  const result = await reviewBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter: goodFrontmatter,
    markdown: goodMarkdown,
  });
  const byDim = new Map(result.scores.map((s) => [s.dimension, s.score]));
  assert.equal(byDim.get("contentQuality"), 10);
  assert.equal(byDim.get("seoMetadata"), 0);
  assert.equal(byDim.get("brandVoiceFit"), 7);
});

test("prompt includes business name, every category id, and a service area", async () => {
  const capture: GenerateContentCall[] = [];
  const gemini = makeFakeGemini({
    capture,
    candidatesJson: {
      scores: scoreEntries({ contentQuality: 8, seoMetadata: 8, brandVoiceFit: 8 }),
      issues: [],
      suggestions: [],
      summary: "ok",
    },
  });
  await reviewBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter: goodFrontmatter,
    markdown: goodMarkdown,
  });
  assert.equal(capture.length, 1);
  const prompt = capture[0]?.contents as string;
  assert.match(prompt, new RegExp(sampleConfig.businessName));
  for (const cat of sampleConfig.categories) {
    assert.ok(prompt.includes(cat.id), `prompt should mention category ${cat.id}`);
  }
  assert.ok(prompt.includes(sampleConfig.serviceAreas[0]!));
});

test("respects a custom strict gate", async () => {
  const gemini = makeFakeGemini({
    candidatesJson: {
      scores: scoreEntries({ contentQuality: 8, seoMetadata: 8, brandVoiceFit: 8 }),
      issues: [],
      suggestions: [],
      summary: "Decent but not strict-grade.",
    },
  });
  const result = await reviewBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter: goodFrontmatter,
    markdown: goodMarkdown,
    gate: { minOverall: 9, minPerDimension: 9, blockOnAnyBlocker: true },
  });
  assert.equal(result.pass, false);
});

test("renderReviewMarkdown produces a PASS-tagged comment with all sections", async () => {
  const gemini = makeFakeGemini({
    candidatesJson: {
      scores: scoreEntries({ contentQuality: 8, seoMetadata: 9, brandVoiceFit: 8 }),
      issues: [
        {
          dimension: "seoMetadata",
          severity: "minor",
          message: "Title is at the upper bound.",
          suggestion: "Shorten by 5 chars.",
          location: "frontmatter.title",
        },
      ],
      suggestions: ["Add a CTA"],
      summary: "Good.",
    },
  });
  const result = await reviewBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter: goodFrontmatter,
    markdown: goodMarkdown,
  });
  const md = renderReviewMarkdown(result);
  assert.match(md, /Autoblog AI Review — PASS/);
  assert.match(md, /Content Quality/);
  assert.match(md, /SEO & Metadata/);
  assert.match(md, /Brand Voice & Fit/);
  assert.match(md, /\*\*MINOR\*\* \(seoMetadata\)/);
  assert.match(md, /Add a CTA/);
});

test("retries when the model returns a response missing the scores array, then succeeds", async () => {
  const good = JSON.stringify({
    scores: scoreEntries({ contentQuality: 8, seoMetadata: 8, brandVoiceFit: 8 }),
    issues: [],
    suggestions: [],
    summary: "Solid and on-brand.",
  });
  // First response omits `scores` (observed intermittently from Claude tool-use);
  // the review should re-roll rather than fail the whole run.
  const missingScores = JSON.stringify({ issues: [], suggestions: [], summary: "no scores" });
  const { gemini, calls } = sequencedGemini([missingScores, good]);

  const result = await reviewBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter: goodFrontmatter,
    markdown: goodMarkdown,
  });

  assert.equal(calls(), 2, "should retry once after the scores-less response");
  assert.equal(result.pass, true);
  assert.equal(result.scores.length, 4);
});

test("throws after exhausting retries when scores never appears", async () => {
  const missingScores = JSON.stringify({ issues: [], suggestions: [], summary: "no scores" });
  const { gemini, calls } = sequencedGemini([missingScores]);

  await assert.rejects(
    reviewBlogPost({
      gemini,
      config: sampleConfig,
      frontmatter: goodFrontmatter,
      markdown: goodMarkdown,
    }),
    /missing 'scores'/,
  );
  assert.ok(calls() >= 3, "should have retried before giving up");
});

test("buildVerifiedFacts reports well-formed faqs and citations with counts", () => {
  const facts = buildVerifiedFacts({
    ...goodFrontmatter,
    faqs: [
      { question: "How often should I service my AC?", answer: "Once a year." },
      { question: "What SEER rating do I need?", answer: "14.3+ in Sacramento." },
      { question: "Do heat pumps work in heat waves?", answer: "Yes." },
      { question: "When should I replace ducts?", answer: "Every 20-25 years." },
      { question: "Does SMUD offer rebates?", answer: "Yes, check smud.org." },
    ],
    citations: [
      { name: "ENERGY STAR", url: "https://www.energystar.gov/" },
      { name: "SMUD", url: "https://www.smud.org/" },
    ],
  });

  assert.match(facts, /frontmatter\.faqs: 5 entries, all well-formed \{question, answer\}/);
  assert.match(facts, /frontmatter\.citations: 2 entries, all well-formed \{name, url\}/);
  assert.match(facts, new RegExp(`title: ${goodFrontmatter.title.length} chars`));
});

test("buildVerifiedFacts flags malformed faq and citation entries by index", () => {
  const facts = buildVerifiedFacts({
    ...goodFrontmatter,
    faqs: [
      { question: "Fine?", answer: "Yes." },
      { question: "Missing answer?" },
      { question: "   ", answer: "blank question" },
    ],
    citations: [
      { name: "Bad URL", url: "not a url" },
      { url: "https://example.com/" },
    ],
  });

  assert.match(facts, /frontmatter\.faqs: 3 entries; malformed .* at index\(es\) 1, 2/);
  assert.match(facts, /frontmatter\.citations: 2 entries; malformed .* at index\(es\) 0, 1/);
});

test("buildVerifiedFacts handles absent faqs/citations and missing lengths", () => {
  const facts = buildVerifiedFacts({ title: "Just a title" });

  assert.match(facts, /frontmatter\.faqs: not present/);
  assert.match(facts, /frontmatter\.citations: not present/);
  assert.match(facts, /title: 12 chars; description: missing; slug: missing/);
});

test("review prompt includes the verified structural facts block", async () => {
  const good = JSON.stringify({
    scores: [
      { dimension: "contentQuality", score: 8, reasoning: "solid" },
      { dimension: "seoMetadata", score: 8, reasoning: "solid" },
      { dimension: "brandVoiceFit", score: 8, reasoning: "solid" },
      { dimension: "humanVoice", score: 8, reasoning: "solid" },
    ],
    issues: [],
    suggestions: [],
    summary: "good",
  });
  const captured: string[] = [];
  const gemini = {
    models: {
      async generateContent(req: { contents: string }) {
        captured.push(req.contents);
        return { text: good };
      },
      async embedContent() {
        return { embeddings: [] };
      },
    },
  };

  await reviewBlogPost({
    gemini: gemini as never,
    config: sampleConfig,
    frontmatter: { ...goodFrontmatter, faqs: [{ question: "Q", answer: "A" }] },
    markdown: goodMarkdown,
  });

  assert.match(captured[0]!, /VERIFIED STRUCTURAL FACTS/);
  assert.match(captured[0]!, /frontmatter\.faqs: 1 entries, all well-formed/);
});

test("an advisory dimension is scored but excluded from the mean and the floor", async () => {
  const gemini = makeFakeGemini({
    candidatesJson: {
      // humanVoice below the 6.0 floor and far below the mean — it must not
      // fail the post while it is advisory.
      scores: scoreEntries({ contentQuality: 8, seoMetadata: 8, brandVoiceFit: 8, humanVoice: 3 }),
      issues: [],
      suggestions: [],
      summary: "ok",
    },
  });

  const result = await reviewBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter: goodFrontmatter,
    markdown: goodMarkdown,
  });

  assert.equal(result.pass, true);
  assert.equal(result.overallScore, 8, "advisory dimension excluded from the mean");
  assert.equal(result.scores.length, 4, "but still scored and reported");
  assert.equal(result.scores.find((s) => s.dimension === "humanVoice")?.score, 3);
});

test("a blocker raised on an advisory dimension does not fail the post", async () => {
  const gemini = makeFakeGemini({
    candidatesJson: {
      scores: scoreEntries({ contentQuality: 8, seoMetadata: 8, brandVoiceFit: 8, humanVoice: 4 }),
      issues: [
        {
          dimension: "humanVoice",
          severity: "blocker",
          message: "Reads as generated.",
          suggestion: "Vary the rhythm.",
        },
      ],
      suggestions: [],
      summary: "ok",
    },
  });

  const result = await reviewBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter: goodFrontmatter,
    markdown: goodMarkdown,
  });

  assert.equal(result.pass, true);
});

test("clearing advisoryDimensions makes humanVoice gate immediately", async () => {
  const gemini = makeFakeGemini({
    candidatesJson: {
      scores: scoreEntries({ contentQuality: 8, seoMetadata: 8, brandVoiceFit: 8, humanVoice: 3 }),
      issues: [],
      suggestions: [],
      summary: "ok",
    },
  });

  const result = await reviewBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter: goodFrontmatter,
    markdown: goodMarkdown,
    gate: { minOverall: 7, minPerDimension: 6, blockOnAnyBlocker: true, advisoryDimensions: [] },
  });

  assert.equal(result.pass, false);
  assert.match(result.thresholdReasoning, /humanVoice=3\.0 below floor/);
});

test("parseReviewResult accepts a legacy three-dimension result written on disk", () => {
  const legacy = {
    pass: false,
    overallScore: 6.7,
    scores: [
      { dimension: "contentQuality", score: 7, reasoning: "a" },
      { dimension: "seoMetadata", score: 6, reasoning: "b" },
      { dimension: "brandVoiceFit", score: 7, reasoning: "c" },
    ],
    issues: [],
    suggestions: [],
    summary: "s",
    thresholdReasoning: "t",
    modelUsed: "grok-4.6",
  };

  const parsed = parseReviewResult(legacy);

  assert.equal(parsed.scores.length, 3, "no humanVoice, and that is fine for rewrite input");
  assert.equal(parsed.overallScore, 6.7);
  assert.equal(parsed.modelUsed, "grok-4.6");
});

test("parseReviewResult tolerates junk fields rather than throwing", () => {
  const parsed = parseReviewResult({ scores: [{ dimension: "nope", score: "x" }] });

  assert.equal(parsed.scores.length, 0);
  assert.equal(parsed.pass, false);
  assert.equal(parsed.modelUsed, "unknown");
});

test("the rendered report tags advisory dimensions", () => {
  const md = renderReviewMarkdown({
    pass: true,
    overallScore: 8,
    scores: scoreEntries({ contentQuality: 8, seoMetadata: 8, brandVoiceFit: 8, humanVoice: 5 }),
    issues: [],
    suggestions: [],
    summary: "ok",
    thresholdReasoning: "Passed.",
    modelUsed: "grok-4.6",
  });

  assert.match(md, /Human Voice _\(advisory — not gated\)_/);
  assert.doesNotMatch(md, /Content Quality _\(advisory/);
});
