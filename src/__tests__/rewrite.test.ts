import assert from "node:assert/strict";
import test from "node:test";
import { rewriteBlogPost } from "../rewrite.js";
import type { BlogPostFrontmatter, ReviewResult } from "../review.js";
import { parseLinkPolicy } from "../links.js";
import { makeFakeGemini, sampleConfig } from "./fakes.js";
import type { GenerateContentCall } from "./fakes.js";

const frontmatter: BlogPostFrontmatter = {
  title: "Title with twenty-something chars",
  description: "An overly short description.",
  slug: "title-too-short",
  tags: ["hvac"],
  category: "hvac",
  date: "2026-06-01",
};

const markdown = `# Title with twenty-something chars\n\nIntro paragraph that needs more depth.\n\n## Section\n\nBody.`;

const failingReview: ReviewResult = {
  pass: false,
  overallScore: 6.2,
  scores: [
    { dimension: "contentQuality", score: 7, reasoning: "Thin." },
    { dimension: "seoMetadata", score: 5, reasoning: "Description too short." },
    { dimension: "brandVoiceFit", score: 6, reasoning: "Could be more local." },
  ],
  issues: [
    {
      dimension: "seoMetadata",
      severity: "blocker",
      message: "Description is below 120 chars.",
      suggestion: "Rewrite to 120-160 chars with primary keyword.",
      location: "frontmatter.description",
    },
  ],
  suggestions: ["Mention SMUD"],
  summary: "Needs metadata work.",
  thresholdReasoning: "Failed: seoMetadata=5.0 below floor 6.0.",
  modelUsed: "gemini-2.5-flash",
};

test("returns a revised post and merges revised fields into frontmatter", async () => {
  const gemini = makeFakeGemini({
    candidatesJson: {
      frontmatter: {
        title: "Sacramento HVAC Heat-Wave Prep: A Homeowner Checklist",
        description:
          "A practical Sacramento homeowner's guide to readying your AC, ducts, and thermostat before the next heat wave rolls in this summer.",
        slug: "sacramento-hvac-heat-wave-prep",
        category: "hvac",
        tags: ["hvac", "cooling", "heat wave"],
      },
      markdown: "# Sacramento HVAC Heat-Wave Prep\n\nNew, more detailed body...",
      changeNotes: "Expanded description to 150 chars and tightened intro.",
    },
  });

  const result = await rewriteBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter,
    markdown,
    reviewFeedback: failingReview,
  });

  assert.equal(result.frontmatter.title, "Sacramento HVAC Heat-Wave Prep: A Homeowner Checklist");
  assert.ok(result.frontmatter.description && result.frontmatter.description.length >= 120);
  assert.equal(result.frontmatter.slug, "sacramento-hvac-heat-wave-prep");
  // Preserves the original date — not touched by the rewrite.
  assert.equal(result.frontmatter.date, "2026-06-01");
  assert.match(result.markdown, /Heat-Wave Prep/);
  assert.match(result.changeNotes, /Expanded description/);
  assert.equal(result.modelUsed, "grok-4.6");
});

test("throws when the rewrite response is empty", async () => {
  const gemini = makeFakeGemini({ generateText: "" });
  await assert.rejects(
    rewriteBlogPost({
      gemini,
      config: sampleConfig,
      frontmatter,
      markdown,
      reviewFeedback: failingReview,
    }),
    /Empty rewrite response/,
  );
});

test("throws when required fields are missing from the rewrite payload", async () => {
  const gemini = makeFakeGemini({
    candidatesJson: {
      frontmatter: { title: "x" },
      markdown: "",
      changeNotes: "",
    },
  });
  await assert.rejects(
    rewriteBlogPost({
      gemini,
      config: sampleConfig,
      frontmatter,
      markdown,
      reviewFeedback: failingReview,
    }),
    /missing required/,
  );
});

test("prompt embeds the failing review's issues and dimension scores", async () => {
  const capture: GenerateContentCall[] = [];
  const gemini = makeFakeGemini({
    capture,
    candidatesJson: {
      frontmatter: { title: "ok" },
      markdown: "# ok\n\nBody.",
      changeNotes: "minor",
    },
  });
  await rewriteBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter,
    markdown,
    reviewFeedback: failingReview,
  });
  const prompt = capture[0]?.contents as string;
  assert.match(prompt, /Description is below 120 chars/);
  assert.match(prompt, /seoMetadata: 5\.0/);
  assert.match(prompt, /Mention SMUD/);
  // Includes site context.
  assert.match(prompt, new RegExp(sampleConfig.businessName));
});

// Regression: on 2026-08-18 generation stripped a denylisted DOE URL, the
// reviewer asked for a cited statistic, and the auto-fix rewrite put the same
// URL straight back — because the rewrite prompt had never heard of the link
// policy. The post failed @smoke and could never merge (pulse a99f27b).
test("rewrite prompt carries the dead-link policy when one is supplied", async () => {
  const calls: GenerateContentCall[] = [];
  const gemini = makeFakeGemini({
    generateText: JSON.stringify({
      frontmatter: { ...frontmatter, description: "x".repeat(130) },
      markdown,
      changeNotes: "Lengthened the description.",
    }),
    capture: calls,
  });

  await rewriteBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter,
    markdown,
    reviewFeedback: failingReview,
    linkPolicy: parseLinkPolicy({ deniedUrlFragments: ["energy.gov/energysaver/"] }),
  });

  const prompt = String(calls[0]!.contents);
  assert.match(prompt, /energy\.gov\/energysaver\//);
  assert.match(prompt, /NEVER reintroduce/i);
});

test("rewrite prompt still includes accuracy rules and citable sources", async () => {
  const calls: GenerateContentCall[] = [];
  const gemini = makeFakeGemini({
    generateText: JSON.stringify({ frontmatter, markdown, changeNotes: "No change." }),
    capture: calls,
  });

  await rewriteBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter: {
      ...frontmatter,
      citations: [{ name: "ASHRAE", url: "https://www.ashrae.org" }],
    },
    markdown,
    reviewFeedback: failingReview,
  });

  const prompt = String(calls[0]!.contents);
  assert.match(prompt, /Do NOT invent statistics/);
  assert.match(prompt, /ASHRAE: https:\/\/www\.ashrae\.org/);
});

test("without a policy the rewrite prompt gains no link section", async () => {
  const calls: GenerateContentCall[] = [];
  const gemini = makeFakeGemini({
    generateText: JSON.stringify({ frontmatter, markdown, changeNotes: "No change." }),
    capture: calls,
  });

  await rewriteBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter,
    markdown,
    reviewFeedback: failingReview,
  });

  assert.doesNotMatch(String(calls[0]!.contents), /Outbound links/);
});

// ─── rubric guard (v0.17) ────────────────────────────────────────────────────

import { DEFAULT_RUBRIC_CONSTRAINTS } from "../rubric.js";

const guardedRubric = { ...DEFAULT_RUBRIC_CONSTRAINTS, requiredHeadings: ["When to Call a Pro"] };
const guardedMarkdown = `# Title\n\nIntro.\n\n## Section\n\nBody.\n\n## When to Call a Pro\n\nCall us.`;

function guardedGemini(revisedMarkdown: string) {
  return makeFakeGemini({
    candidatesJson: {
      frontmatter: { title: frontmatter.title },
      markdown: revisedMarkdown,
      changeNotes: "Revised.",
    },
  });
}

test("rewrite prompt names the required headings and the no-body-FAQ rule when a rubric is given", async () => {
  const capture: GenerateContentCall[] = [];
  const gemini = makeFakeGemini({
    candidatesJson: { frontmatter: { title: frontmatter.title }, markdown: guardedMarkdown, changeNotes: "ok" },
    capture,
  });
  await rewriteBlogPost({ gemini, config: sampleConfig, frontmatter, markdown: guardedMarkdown, reviewFeedback: failingReview, rubric: guardedRubric });
  const prompt = String(capture[0]?.contents);
  assert.match(prompt, /"## When to Call a Pro"/);
  assert.match(prompt, /verbatim/i);
  assert.match(prompt, /Frequently Asked Questions/i);
});

test("rewrite throws when the revision drops or re-cases a required heading", async () => {
  await assert.rejects(
    rewriteBlogPost({
      gemini: guardedGemini(guardedMarkdown.replace("## When to Call a Pro", "## When to call a pro")),
      config: sampleConfig,
      frontmatter,
      markdown: guardedMarkdown,
      reviewFeedback: failingReview,
      rubric: guardedRubric,
    }),
    /When to Call a Pro/,
  );
});

test("rewrite throws when the revision adds an FAQ section to the body", async () => {
  await assert.rejects(
    rewriteBlogPost({
      gemini: guardedGemini(`${guardedMarkdown}\n\n   ## FAQs\n\n**Q?**\n\nA.`),
      config: sampleConfig,
      frontmatter,
      markdown: guardedMarkdown,
      reviewFeedback: failingReview,
      rubric: guardedRubric,
    }),
    /FAQ/,
  );
});

test("rewrite without a rubric keeps the pre-0.17 behaviour", async () => {
  const result = await rewriteBlogPost({
    gemini: guardedGemini(guardedMarkdown.replace("## When to Call a Pro", "## When to call a pro")),
    config: sampleConfig,
    frontmatter,
    markdown: guardedMarkdown,
    reviewFeedback: failingReview,
  });
  assert.match(result.markdown, /When to call a pro/);
});
