import assert from "node:assert/strict";
import test from "node:test";
import { HVAC_CATEGORIES, SACRAMENTO_LOCATION } from "../config.js";
import { selectWeeklyTopic } from "../orchestrator.js";
import type { EngineConfig } from "../types.js";
import { makeFakeGemini, makeFakeWeather, sampleConfig, samplePosts } from "./fakes.js";

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
