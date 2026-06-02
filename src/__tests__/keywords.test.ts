import assert from "node:assert/strict";
import test from "node:test";
import { researchKeywords } from "../keywords.js";
import type { FetchLike } from "../suggest.js";
import { makeFakeGemini } from "./fakes.js";
import type { GenerateContentCall } from "./fakes.js";

const SUGGESTIONS = [
  "furnace blowing cold air",
  "furnace blowing cold air no heat",
  "why is my furnace blowing cold air",
  "furnace blowing cold air sacramento",
  "cost to fix furnace blowing cold air",
];

function stubFetch(suggestions: string[]): FetchLike {
  return async () => ({
    ok: true,
    text: async () => JSON.stringify(["seed", suggestions]),
  });
}

const KEYWORD_JSON = {
  primaryKeyword: "furnace blowing cold air",
  secondaryKeywords: ["furnace no heat", "furnace cold air fix"],
  questionKeywords: [
    "Why is my furnace blowing cold air?",
    "How much does it cost to fix a furnace blowing cold air?",
  ],
  localModifiers: ["Sacramento"],
  searchIntent: "informational",
};

test("researchKeywords clusters real suggestions into structured keyword data", async () => {
  const capture: GenerateContentCall[] = [];
  const gemini = makeFakeGemini({ candidatesJson: KEYWORD_JSON, capture });

  const result = await researchKeywords({
    gemini,
    seedTopic: "Why a furnace blows cold air",
    categoryKeywords: ["furnace", "heating"],
    serviceAreas: ["Sacramento", "Roseville"],
    fetchImpl: stubFetch(SUGGESTIONS),
  });

  assert.equal(result.available, true);
  assert.equal(result.primaryKeyword, "furnace blowing cold air");
  assert.equal(result.secondaryKeywords.length, 2);
  assert.equal(result.questionKeywords.length, 2);
  assert.deepEqual(result.localModifiers, ["Sacramento"]);
  assert.equal(result.searchIntent, "informational");
  assert.ok(result.rawSuggestions.length > 0, "real suggestions are retained");
  // The clustering prompt must actually see the harvested suggestions.
  const prompt = String(capture[0]!.contents);
  assert.ok(prompt.includes("furnace blowing cold air no heat"));
});

test("researchKeywords degrades to LLM ideation when no suggestions are available", async () => {
  const emptyFetch: FetchLike = async () => ({ ok: true, text: async () => JSON.stringify(["s", []]) });
  const gemini = makeFakeGemini({ candidatesJson: KEYWORD_JSON });

  const result = await researchKeywords({
    gemini,
    seedTopic: "Why a furnace blows cold air",
    serviceAreas: ["Sacramento"],
    fetchImpl: emptyFetch,
  });

  // Still returns usable keywords, but flags that there was no real demand data.
  assert.equal(result.available, false);
  assert.equal(result.primaryKeyword, "furnace blowing cold air");
  assert.equal(result.rawSuggestions.length, 0);
});

test("researchKeywords falls back to a minimal struct when the LLM call fails", async () => {
  const gemini = makeFakeGemini({ failGenerate: true });

  const result = await researchKeywords({
    gemini,
    seedTopic: "Furnace blowing cold air",
    serviceAreas: ["Sacramento"],
    fetchImpl: stubFetch(SUGGESTIONS),
  });

  // We had real demand data even though clustering failed — use it directly.
  assert.equal(result.available, true);
  assert.ok(result.primaryKeyword.length > 0, "primary keyword falls back to topic/suggestion");
  assert.ok(
    result.questionKeywords.some((q) => q.toLowerCase().startsWith("why")),
    "question-like suggestions are salvaged for the FAQ",
  );
  assert.ok(result.rawSuggestions.length > 0);
});

test("researchKeywords never throws even when both fetch and LLM fail", async () => {
  const fetchImpl: FetchLike = async () => {
    throw new Error("network down");
  };
  const gemini = makeFakeGemini({ failGenerate: true });

  const result = await researchKeywords({
    gemini,
    seedTopic: "Heat pump maintenance",
    serviceAreas: ["Sacramento"],
    fetchImpl,
  });

  assert.equal(result.available, false);
  assert.equal(result.primaryKeyword, "Heat pump maintenance");
  assert.deepEqual(result.rawSuggestions, []);
});
