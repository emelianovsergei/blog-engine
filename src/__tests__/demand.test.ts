import assert from "node:assert/strict";
import test from "node:test";
import { scoreDemand, toSearchQuery } from "../demand.js";
import type { FetchLike } from "../suggest.js";
import type { CandidateTopic } from "../types.js";

function candidate(topic: string): CandidateTopic {
  return { topic, notes: "", categoryId: "hvac" };
}

/** Stub that returns a suggestion list chosen by the decoded `q` param. */
function stubFetch(byTerm: Record<string, string[]>): FetchLike {
  return async (url) => {
    const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "").toLowerCase();
    const key = Object.keys(byTerm).find((term) => q.includes(term));
    const suggestions = key ? byTerm[key]! : [];
    return { ok: true, text: async () => JSON.stringify([q, suggestions]) };
  };
}

test("toSearchQuery strips stopwords/possessives and caps length", () => {
  const q = toSearchQuery("Why your furnace is blowing cold air and how to fix it", 5);
  const words = q.split(" ");
  assert.ok(words.includes("furnace") && words.includes("blowing") && words.includes("cold"));
  assert.ok(!words.includes("your") && !words.includes("is") && !words.includes("and") && !words.includes("to"));
  assert.ok(words.length <= 5, "query is capped to maxWords");
});

test("scoreDemand ranks a high-demand topic above a low-demand one", async () => {
  const fetchImpl = stubFetch({
    furnace: [
      "furnace blowing cold air",
      "furnace blowing cold air no heat",
      "furnace blowing cold air after power outage",
      "furnace blowing cold air in winter",
      "furnace blowing cold air thermostat",
      "furnace blowing cold air filter",
      "furnace blowing cold air reset",
      "furnace blowing cold air pilot",
    ],
    damper: ["damper actuator cost"],
  });

  const { scores, available } = await scoreDemand({
    candidates: [candidate("Furnace blowing cold air fixes"), candidate("Zone damper actuator replacement")],
    fetchImpl,
  });

  assert.equal(available, true);
  assert.ok(scores[0]! > scores[1]!, "the topic with more real autocomplete demand scores higher");
  assert.ok(scores[0]! <= 1 && scores[1]! >= 0, "scores are normalised to 0-1");
});

test("scoreDemand only counts suggestions relevant to the candidate", async () => {
  const fetchImpl = stubFetch({
    "heat pump": [
      "heat pump maintenance",
      "heat pump cost",
      "pizza near me",
      "weather today",
      "stock market",
    ],
  });

  const { scores } = await scoreDemand({
    candidates: [candidate("Heat pump maintenance checklist")],
    fetchImpl,
    maxSuggestions: 8,
  });

  // Only 2 of the 5 suggestions share a candidate term -> 2/8 = 0.25.
  assert.ok(Math.abs(scores[0]! - 0.25) < 1e-9, `expected 0.25, got ${scores[0]}`);
});

test("scoreDemand degrades gracefully when autocomplete is unavailable", async () => {
  const fetchImpl: FetchLike = async () => {
    throw new Error("network down");
  };
  const { scores, available } = await scoreDemand({
    candidates: [candidate("Furnace tune-up timing"), candidate("AC compressor noise")],
    fetchImpl,
  });
  assert.equal(available, false);
  assert.deepEqual(scores, [0, 0]);
});

test("scoreDemand returns an empty result for no candidates", async () => {
  const { scores, available } = await scoreDemand({ candidates: [], fetchImpl: stubFetch({}) });
  assert.deepEqual(scores, []);
  assert.equal(available, true);
});
