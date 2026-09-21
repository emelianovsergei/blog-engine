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

const faqSet = [
  { question: "Should I book same-day?", answer: "Use same-day if you smell burning." },
  { question: "How much does AC cost to fix?", answer: "It depends on the part." },
];

const faqReview: ReviewResult = {
  ...failingReview,
  issues: [
    {
      dimension: "contentQuality",
      severity: "blocker",
      message: "The FAQ answer for a burning smell only says to book same-day.",
      suggestion: "Tell the reader to shut the system off at the breaker, and to leave and call 911 if they see smoke.",
      location: "frontmatter.faqs",
    },
  ],
  summary: "The FAQ answer is missing the shutoff line.",
};

test("a FAQ-answer issue updates that answer and keeps the questions", async () => {
  const gemini = makeFakeGemini({
    candidatesJson: {
      frontmatter: {
        title: frontmatter.title,
        faqs: [
          {
            question: "Should I book same-day?",
            answer:
              "If you smell burning and see no smoke, shut the system off at the breaker. If you see smoke, leave and call 911.",
          },
          { question: "How much does AC cost to fix?", answer: "It depends on the part." },
        ],
      },
      markdown,
      changeNotes: "Updated the burning-smell FAQ answer.",
    },
  });
  const result = await rewriteBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter: { ...frontmatter, faqs: faqSet },
    markdown,
    reviewFeedback: faqReview,
  });
  const out = result.frontmatter.faqs as Array<{ question: string; answer: string }>;
  assert.equal(out[0]?.question, "Should I book same-day?");
  assert.match(out[0]?.answer ?? "", /breaker/);
  assert.match(out[0]?.answer ?? "", /911/);
  assert.equal(out[1]?.question, "How much does AC cost to fix?");
  assert.equal(out[1]?.answer, "It depends on the part.");
  assert.doesNotMatch(result.markdown, /Frequently Asked Questions/i);
});

test("an issue that does not mention FAQs leaves faqs untouched", async () => {
  const gemini = makeFakeGemini({
    candidatesJson: {
      frontmatter: {
        title: "New title that is long enough for the schema",
        faqs: [{ question: "Changed?", answer: "Changed." }],
      },
      markdown: "# New\n\nBody.",
      changeNotes: "Expanded the description only.",
    },
  });
  const result = await rewriteBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter: { ...frontmatter, faqs: faqSet },
    markdown,
    reviewFeedback: failingReview,
  });
  assert.deepEqual(result.frontmatter.faqs, faqSet);
  assert.equal(result.frontmatter.title, "New title that is long enough for the schema");
});

test("a FAQ issue that changes the question text is rejected", async () => {
  const gemini = makeFakeGemini({
    candidatesJson: {
      frontmatter: {
        title: frontmatter.title,
        faqs: [{ question: "A different question?", answer: "Shut the breaker off and call 911 if you see smoke." }],
      },
      markdown,
      changeNotes: "Rewrote the FAQ question.",
    },
  });
  await assert.rejects(
    rewriteBlogPost({
      gemini,
      config: sampleConfig,
      frontmatter: { ...frontmatter, faqs: faqSet },
      markdown,
      reviewFeedback: faqReview,
    }),
    /FAQ answer change/,
  );
});

test("a FAQ issue can fill an empty answer and keeps extra entry fields", async () => {
  const gemini = makeFakeGemini({
    candidatesJson: {
      frontmatter: {
        title: frontmatter.title,
        faqs: [
          { question: "Should I book same-day?", answer: "Shut the system off at the breaker. Call 911 if you see smoke." },
          { question: "How much does AC cost to fix?", answer: "It depends on the part." },
        ],
      },
      markdown,
      changeNotes: "Filled the empty FAQ answer.",
    },
  });
  const result = await rewriteBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter: {
      ...frontmatter,
      faqs: [
        { question: "Should I book same-day?", answer: "  ", id: "same-day" },
        { question: "How much does AC cost to fix?", answer: "It depends on the part.", id: "cost" },
      ],
    },
    markdown,
    reviewFeedback: faqReview,
  });
  const out = result.frontmatter.faqs as Array<{ question: string; answer: string; id: string }>;
  assert.equal(out[0]?.id, "same-day");
  assert.match(out[0]?.answer ?? "", /breaker/);
  assert.equal(out[1]?.id, "cost");
});

test("an issue that only tells the rewriter to fix the body does not change faqs", async () => {
  const gemini = makeFakeGemini({
    candidatesJson: {
      frontmatter: {
        title: frontmatter.title,
        faqs: [{ question: "Changed?", answer: "Changed." }],
      },
      markdown: "# New\n\nBody aligned with the FAQ.",
      changeNotes: "Fixed the body so it matches the FAQ.",
    },
  });
  const review: ReviewResult = {
    ...failingReview,
    issues: [
      {
        dimension: "contentQuality",
        severity: "blocker",
        message: "The body contradicts the FAQ answer.",
        suggestion: "Correct the body. Do not change the FAQ.",
        location: "markdown",
      },
    ],
    summary: "Body and FAQ disagree.",
  };
  const result = await rewriteBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter: { ...frontmatter, faqs: faqSet },
    markdown,
    reviewFeedback: review,
  });
  assert.deepEqual(result.frontmatter.faqs, faqSet);
});

test("a FAQ issue that returns the same answers is rejected", async () => {
  const gemini = makeFakeGemini({
    candidatesJson: {
      frontmatter: { title: frontmatter.title, faqs: faqSet },
      markdown: "# New\n\nUnrelated body edit.",
      changeNotes: "Edited the body only.",
    },
  });
  await assert.rejects(
    rewriteBlogPost({
      gemini,
      config: sampleConfig,
      frontmatter: { ...frontmatter, faqs: faqSet },
      markdown,
      reviewFeedback: faqReview,
    }),
    /FAQ answer change/,
  );
});

test("a location of frontmatter.faqs[0].answer requests an FAQ edit without the word answer in the prose", async () => {
  const gemini = makeFakeGemini({
    candidatesJson: {
      frontmatter: {
        title: frontmatter.title,
        faqs: [
          { question: "Should I book same-day?", answer: "Shut the system off at the breaker. Call 911 if you see smoke." },
          { question: "How much does AC cost to fix?", answer: "It depends on the part." },
        ],
      },
      markdown,
      changeNotes: "Added the shutoff sentence.",
    },
  });
  const review: ReviewResult = {
    ...failingReview,
    issues: [
      {
        dimension: "contentQuality",
        severity: "blocker",
        message: "The emergency guidance is incomplete.",
        suggestion: "Add the shutoff sentence.",
        location: "frontmatter.faqs[0].answer",
      },
    ],
  };
  const result = await rewriteBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter: { ...frontmatter, faqs: faqSet },
    markdown,
    reviewFeedback: review,
  });
  const out = result.frontmatter.faqs as Array<{ answer: string }>;
  assert.match(out[0]?.answer ?? "", /breaker/);
});

test("a file:line location plus FAQ-answer prose still updates the answer", async () => {
  const gemini = makeFakeGemini({
    candidatesJson: {
      frontmatter: {
        title: frontmatter.title,
        faqs: [
          { question: "Should I book same-day?", answer: "Shut the system off at the breaker. Call 911 if you see smoke." },
          { question: "How much does AC cost to fix?", answer: "It depends on the part." },
        ],
      },
      markdown,
      changeNotes: "Added the breaker instruction.",
    },
  });
  const review: ReviewResult = {
    ...failingReview,
    issues: [
      {
        dimension: "contentQuality",
        severity: "blocker",
        message: "Fix the unsafe FAQ answer.",
        suggestion: "Add the breaker instruction.",
        location: "content/blog/post.mdx:40",
      },
    ],
  };
  const result = await rewriteBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter: { ...frontmatter, faqs: faqSet },
    markdown,
    reviewFeedback: review,
  });
  const out = result.frontmatter.faqs as Array<{ answer: string }>;
  assert.match(out[0]?.answer ?? "", /breaker/);
});

test("an issue with no location that names the FAQ answer still updates it", async () => {
  const gemini = makeFakeGemini({
    candidatesJson: {
      frontmatter: {
        title: frontmatter.title,
        faqs: [
          { question: "Should I book same-day?", answer: "Shut the system off at the breaker." },
          { question: "How much does AC cost to fix?", answer: "It depends on the part." },
        ],
      },
      markdown,
      changeNotes: "Expanded the FAQ answer.",
    },
  });
  const review: ReviewResult = {
    ...failingReview,
    issues: [
      {
        dimension: "contentQuality",
        severity: "blocker",
        message: "The FAQ answer is incomplete.",
        suggestion: "Add the shutoff sentence.",
      },
    ],
  };
  const result = await rewriteBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter: { ...frontmatter, faqs: faqSet },
    markdown,
    reviewFeedback: review,
  });
  const out = result.frontmatter.faqs as Array<{ answer: string }>;
  assert.match(out[0]?.answer ?? "", /breaker/);
});

test("a single FAQ index does not let the model rewrite the other answers", async () => {
  const gemini = makeFakeGemini({
    candidatesJson: {
      frontmatter: {
        title: frontmatter.title,
        faqs: [
          { question: "Should I book same-day?", answer: "Shut the system off at the breaker. Call 911 if you see smoke." },
          { question: "How much does AC cost to fix?", answer: "A hallucinated price of exactly $50." },
        ],
      },
      markdown,
      changeNotes: "Fixed the first FAQ and rewrote the second.",
    },
  });
  const review: ReviewResult = {
    ...failingReview,
    issues: [
      {
        dimension: "contentQuality",
        severity: "blocker",
        message: "Missing breaker guidance.",
        suggestion: "Add the shutoff sentence.",
        location: "frontmatter.faqs[0].answer",
      },
    ],
  };
  const result = await rewriteBlogPost({
    gemini,
    config: sampleConfig,
    frontmatter: { ...frontmatter, faqs: faqSet },
    markdown,
    reviewFeedback: review,
  });
  const out = result.frontmatter.faqs as Array<{ answer: string }>;
  assert.match(out[0]?.answer ?? "", /breaker/);
  assert.equal(out[1]?.answer, "It depends on the part.");
});
