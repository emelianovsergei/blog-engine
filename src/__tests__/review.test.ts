import assert from "node:assert/strict";
import test from "node:test";
import { reviewBlogPost, renderReviewMarkdown } from "../review.js";
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

function scoreEntries(
  values: Record<ReviewDimension, number>,
): Array<{ dimension: ReviewDimension; score: number; reasoning: string }> {
  return (Object.keys(values) as ReviewDimension[]).map((d) => ({
    dimension: d,
    score: values[d],
    reasoning: `r-${d}`,
  }));
}

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
  assert.equal(result.scores.length, 3);
  assert.match(result.thresholdReasoning, /Passed/);
  assert.equal(result.modelUsed, "claude-sonnet-4-6");
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
