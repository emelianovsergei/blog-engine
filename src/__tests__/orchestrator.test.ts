import assert from "node:assert/strict";
import test from "node:test";
import { HVAC_CATEGORIES, SACRAMENTO_LOCATION } from "../config.js";
import { selectWeeklyTopic } from "../orchestrator.js";
import type { EngineConfig } from "../types.js";
import type { FetchLike } from "../suggest.js";
import { makeFakeGemini, makeFakeWeather, sampleConfig, samplePosts } from "./fakes.js";

/** Autocomplete stub: returns a suggestion list keyed by the decoded query. */
function stubFetch(byTerm: Record<string, string[]>): FetchLike {
  return async (url) => {
    const q = decodeURIComponent(new URL(url).searchParams.get("q") ?? "").toLowerCase();
    const key = Object.keys(byTerm).find((term) => q.includes(term));
    return { ok: true, text: async () => JSON.stringify([q, key ? byTerm[key]! : []]) };
  };
}

test("selectWeeklyTopic returns a usable topic from the candidate set", async () => {
  const candidatesJson = {
    candidates: [
      {
        topic: "How to size a whole-house fan for a Sacramento home",
        notes: "A sizing guide for homeowners considering a whole-house fan.",
        categoryId: "hvac",
      },
      {
        topic: "Dishwasher not draining: the quick fixes to try first",
        notes: "Drain-trap and filter troubleshooting before calling a pro.",
        categoryId: "appliance",
      },
    ],
  };

  const result = await selectWeeklyTopic({
    config: sampleConfig,
    existingPosts: samplePosts,
    now: new Date("2026-07-15T19:00:00Z"),
    gemini: makeFakeGemini({ candidatesJson }),
    weatherClient: makeFakeWeather({ anomaly: "heat-wave" }),
  });

  assert.ok(
    candidatesJson.candidates.some((candidate) => candidate.topic === result.topic),
    "winner must be one of the generated candidates",
  );
  assert.ok(result.notes.length > 0);
  assert.equal(result.weather.anomaly, "heat-wave");
  assert.ok(result.rationale.length > 0);
});

test("selectWeeklyTopic rejects a candidate that duplicates an existing post", async () => {
  const candidatesJson = {
    candidates: [
      {
        // Exact text of samplePosts[0] -> embedded identically -> rejected as a duplicate.
        topic: samplePosts[0]!.title,
        notes: samplePosts[0]!.description,
        categoryId: "hvac",
      },
      {
        topic: "Why your furnace short cycles on cold Sacramento mornings",
        notes: "Diagnosing rapid furnace on-off cycling and what it costs.",
        categoryId: "hvac",
      },
    ],
  };

  const result = await selectWeeklyTopic({
    config: sampleConfig,
    existingPosts: samplePosts,
    now: new Date("2026-01-15T19:00:00Z"),
    gemini: makeFakeGemini({ candidatesJson }),
    weatherClient: makeFakeWeather(),
  });

  assert.equal(result.topic, "Why your furnace short cycles on cold Sacramento mornings");
});

test("selectWeeklyTopic biases toward search demand when a fetchImpl is provided", async () => {
  const candidatesJson = {
    candidates: [
      { topic: "Zone damper actuator replacement guide", notes: "Niche repair walkthrough.", categoryId: "hvac" },
      { topic: "Furnace blowing cold air fixes", notes: "Common homeowner problem.", categoryId: "hvac" },
    ],
  };
  // No existing posts -> dedup is identical (1.0) for both, so demand decides.
  const demandFetch = stubFetch({
    furnace: [
      "furnace blowing cold air",
      "furnace blowing cold air no heat",
      "furnace blowing cold air in winter",
      "furnace blowing cold air thermostat",
      "furnace blowing cold air filter",
      "furnace blowing cold air reset",
    ],
    damper: ["damper actuator cost"],
  });

  const result = await selectWeeklyTopic({
    config: sampleConfig,
    existingPosts: [],
    now: new Date("2026-07-15T19:00:00Z"),
    gemini: makeFakeGemini({ candidatesJson }),
    weatherClient: makeFakeWeather(),
    fetchImpl: demandFetch,
  });

  assert.equal(result.topic, "Furnace blowing cold air fixes");
  assert.ok(/demand/i.test(result.rationale), "rationale should reflect the demand signal");
});

test("selectWeeklyTopic works with the HVAC-only (PULSE) category config", async () => {
  const pulseConfig: EngineConfig = {
    businessName: "PULSE HVAC",
    serviceAreas: ["Sacramento"],
    location: SACRAMENTO_LOCATION,
    categories: HVAC_CATEGORIES,
  };
  const result = await selectWeeklyTopic({
    config: pulseConfig,
    existingPosts: [],
    now: new Date("2026-12-15T19:00:00Z"),
    gemini: makeFakeGemini({
      candidatesJson: {
        candidates: [
          { topic: "Furnace warning signs before winter", notes: "What to watch for.", categoryId: "heating" },
        ],
      },
    }),
    weatherClient: makeFakeWeather({ anomaly: "cold-snap" }),
  });
  assert.equal(result.topic, "Furnace warning signs before winter");
  assert.equal(result.category, "heating");
});
