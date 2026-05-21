import assert from "node:assert/strict";
import test from "node:test";
import { cosineSimilarity, scoreDuplication } from "../dedup.js";
import type { CandidateTopic } from "../types.js";
import { makeFakeGemini, samplePosts } from "./fakes.js";

test("cosineSimilarity is 1 for identical vectors and 0 for orthogonal ones", () => {
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
});

test("scoreDuplication flags a candidate that duplicates an existing post", async () => {
  const dupOfPost0: CandidateTopic = {
    // Identical text to samplePosts[0] -> hashed embedding is identical -> cosine 1.
    topic: samplePosts[0]!.title,
    notes: samplePosts[0]!.description!,
    categoryId: "hvac",
  };
  const fresh: CandidateTopic = {
    topic: "Why your furnace short cycles on cold Sacramento mornings",
    notes: "Diagnosing rapid furnace on-off cycling and what it costs.",
    categoryId: "hvac",
  };

  const { scores, available } = await scoreDuplication({
    gemini: makeFakeGemini(),
    candidates: [dupOfPost0, fresh],
    existingPosts: samplePosts,
  });

  assert.equal(available, true);
  assert.ok(scores[0]!.maxSimilarity > 0.99, "duplicate should score near 1");
  assert.equal(scores[0]!.nearestSlug, "ac-not-blowing-cold");
  assert.ok(scores[1]!.maxSimilarity < 0.9, "fresh topic should be clearly distinct");
});

test("scoreDuplication degrades gracefully when embeddings fail", async () => {
  const { scores, available } = await scoreDuplication({
    gemini: makeFakeGemini({ failEmbed: true }),
    candidates: [{ topic: "x", notes: "y", categoryId: "hvac" }],
    existingPosts: samplePosts,
  });
  assert.equal(available, false);
  assert.equal(scores[0]!.maxSimilarity, 0);
});

test("scoreDuplication returns zero scores when there are no existing posts", async () => {
  const { scores, available } = await scoreDuplication({
    gemini: makeFakeGemini(),
    candidates: [{ topic: "x", notes: "y", categoryId: "hvac" }],
    existingPosts: [],
  });
  assert.equal(available, true);
  assert.equal(scores[0]!.maxSimilarity, 0);
});
