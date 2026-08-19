import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSeedQueries,
  headTerm,
  isRelevantSuggestion,
  fetchAutocompleteResult,
  DEFAULT_SUGGESTION_DENYLIST,
} from "../suggest.js";
import { scoreDemand } from "../demand.js";
import { researchKeywords, keywordGuidance } from "../keywords.js";
import { makeFakeGemini } from "./fakes.js";

const okResponse = (suggestions: string[]) =>
  ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(["q", suggestions]),
  }) as const;

test("headTerm preserves word order and keeps two-letter domain nouns", () => {
  // Order matters: autocomplete is a prefix API.
  assert.equal(headTerm("Why is my furnace blowing cold air"), "furnace blowing cold air");
  // "ac" must survive — a length>2 filter used to delete the most-searched noun.
  assert.ok(headTerm("Why the AC keeps short cycling").includes("ac"));
});

test("seed queries are prefix-shaped, bounded, and never the raw topic sentence", () => {
  const topic = "Should you run the AC on a timer overnight during a multi-day Sacramento heat wave?";
  const seeds = buildSeedQueries({ topic, serviceAreas: ["Sacramento"], categoryKeywords: ["ac"] });

  assert.ok(seeds.length > 0);
  assert.ok(!seeds.some((s) => s.query === topic.toLowerCase()), "raw sentence is never sent");
  for (const seed of seeds) {
    assert.ok(seed.query.split(/\s+/).length <= 8, `seed too long: ${seed.query}`);
  }
  assert.ok(seeds.some((s) => s.kind === "question"));
  assert.ok(seeds.some((s) => s.kind === "local"));
});

test("cost and local frames use the category noun, not a verb fragment", () => {
  const seeds = buildSeedQueries({
    topic: "Why your furnace is blowing cold air",
    categoryKeywords: ["furnace"],
    serviceAreas: ["Sacramento"],
  });
  const queries = seeds.map((s) => s.query);

  // "furnace sacramento" completes; "furnace blowing sacramento" does not.
  assert.ok(queries.includes("furnace sacramento"));
  assert.ok(queries.includes("how much does furnace cost"));
});

test("irrelevant completions are rejected, on-topic ones kept", () => {
  assert.ok(!isRelevantSuggestion("how to furnace in minecraft", "furnace"));
  assert.ok(!isRelevantSuggestion("hvac sacramento salary", "hvac"));
  assert.ok(!isRelevantSuggestion("furnace repair jobs", "furnace"));
  assert.ok(isRelevantSuggestion("furnace blowing cold air fix", "furnace"));
  assert.ok(DEFAULT_SUGGESTION_DENYLIST.includes("minecraft"));
});

test("a suggestion naming an unserved city is rejected", () => {
  const opts = { serviceAreas: ["Sacramento"], knownCities: ["fresno", "sacramento"] };
  assert.ok(!isRelevantSuggestion("furnace repair fresno", "furnace", opts));
  assert.ok(isRelevantSuggestion("furnace repair sacramento", "furnace", opts));
});

test("a blocked response is distinguishable from genuine zero demand", async () => {
  const blocked = await fetchAutocompleteResult("x", {
    fetchImpl: async () => ({ ok: false, status: 429, text: async () => "" }),
  });
  assert.equal(blocked.status, "blocked");

  const empty = await fetchAutocompleteResult("x", {
    fetchImpl: async () => okResponse([]),
  });
  assert.equal(empty.status, "empty");
});

test("demand availability is tracked per candidate, not globally", async () => {
  // Only the furnace candidate's queries return anything.
  const fetchImpl = async (url: string) =>
    decodeURIComponent(url).includes("furnace")
      ? okResponse(["furnace blowing cold air", "furnace short cycling", "furnace cost"])
      : okResponse([]);

  const result = await scoreDemand({
    candidates: [
      { topic: "Furnace blowing cold air", notes: "", categoryId: "heating" },
      { topic: "Thermostat wiring colours", notes: "", categoryId: "controls" },
    ],
    fetchImpl,
  });

  assert.equal(result.perCandidate[0]!.available, true);
  assert.equal(result.perCandidate[1]!.available, false);
  // The old global OR would have reported true here and scored row 2 as
  // zero-demand rather than no-signal.
  assert.equal(result.available, false);
});

test("keyword research reports provenance and snaps the primary to a real phrase", async () => {
  const fetchImpl = async () =>
    okResponse(["furnace blowing cold air", "furnace blowing cold air fix", "furnace cost"]);

  const research = await researchKeywords({
    gemini: makeFakeGemini({
      generateText: JSON.stringify({
        primaryKeyword: "furnace blowing cold air",
        secondaryKeywords: ["furnace cost"],
        questionKeywords: ["furnace blowing cold air fix"],
        localModifiers: [],
        searchIntent: "informational",
      }),
    }),
    seedTopic: "Why your furnace is blowing cold air",
    serviceAreas: ["Sacramento"],
    categoryKeywords: ["furnace"],
    fetchImpl,
  });

  assert.equal(research.demandSignal, "real");
  assert.equal(research.provenance.primaryKeywordVerbatim, true);
  assert.ok(research.provenance.questionKeywordsVerbatim > 0);
});

test("with no live data the guidance says so instead of claiming real demand", async () => {
  const research = await researchKeywords({
    gemini: makeFakeGemini({
      generateText: JSON.stringify({
        primaryKeyword: "invented phrase nobody searched",
        secondaryKeywords: [],
        questionKeywords: ["also invented"],
        localModifiers: [],
        searchIntent: "informational",
      }),
    }),
    seedTopic: "Some topic",
    serviceAreas: ["Sacramento"],
    fetchImpl: async () => okResponse([]),
  });

  assert.equal(research.demandSignal, "none");
  assert.equal(research.provenance.source, "llm-only");

  const guidance = keywordGuidance(research);
  assert.match(guidance, /NO live demand data/);
  assert.doesNotMatch(guidance, /real Google Autocomplete demand/);
  assert.match(guidance, /inferred, NOT verified searches/);
});

test("an LLM outage is recorded rather than silently reported as available", async () => {
  const research = await researchKeywords({
    gemini: makeFakeGemini({ failGenerate: true }),
    seedTopic: "Why your furnace is blowing cold air",
    serviceAreas: ["Sacramento"],
    categoryKeywords: ["furnace"],
    fetchImpl: async () => okResponse(["furnace blowing cold air"]),
  });

  assert.ok(research.llmError, "the failure must be visible");
  assert.notEqual(research.demandSignal, "real");
});
