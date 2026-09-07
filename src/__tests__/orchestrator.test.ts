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

// ─── Search Console hints (v0.17) ────────────────────────────────────────────

import type { GscSignal } from "../gsc.js";
import type { GenerateContentCall } from "./fakes.js";

const gscSignal = (rows: Array<{ query: string; impressions: number; position: number }>): GscSignal => {
  const full = rows.map((r) => ({ ...r, clicks: 0, ctr: 0 }));
  return { status: "ok", rows: full, byQuery: new Map(full.map((r) => [r.query.toLowerCase(), r])) };
};

test("selectWeeklyTopic feeds Search Console opportunities into candidate generation and prefers a hinted candidate", async () => {
  const capture: GenerateContentCall[] = [];
  const candidatesJson = {
    candidates: [
      { topic: "Zone damper actuator replacement guide", notes: "Niche repair walkthrough.", categoryId: "hvac" },
      {
        topic: "AC installation in Citrus Heights: what it costs and what to expect",
        notes: "Answers the query the site already ranks on page two for.",
        categoryId: "hvac",
        hintQuery: "ac installation citrus heights",
      },
    ],
  };
  const signal = gscSignal([
    { query: "ac installation citrus heights", impressions: 2630, position: 9.4 },
    { query: "furnace repair roseville", impressions: 400, position: 14 },
    { query: "already ranking well", impressions: 900, position: 2 },
  ]);

  const result = await selectWeeklyTopic({
    config: sampleConfig,
    existingPosts: [],
    now: new Date("2026-07-15T19:00:00Z"),
    gemini: makeFakeGemini({ candidatesJson, capture }),
    weatherClient: makeFakeWeather(),
    gscSignal: signal,
  });

  const prompt = String(capture[0]?.contents ?? "");
  assert.match(prompt, /Search Console/i, "prompt carries the opportunities block");
  assert.match(prompt, /ac installation citrus heights/, "the page-two query is listed as a hint");
  assert.match(prompt, /2,?630/, "impressions are shown");
  assert.doesNotMatch(prompt, /already ranking well/, "queries already on page one are not opportunities");

  assert.equal(result.topic, candidatesJson.candidates[1]!.topic, "the hinted candidate wins");
  assert.equal(result.gsc?.status, "ok");
  assert.equal(result.gsc?.hintQuery, "ac installation citrus heights");
  assert.equal(result.gsc?.impressions, 2630);
  assert.match(result.rationale, /search console|gsc/i);
});

test("selectWeeklyTopic degrades to today's behaviour when the signal is absent or unauthorized", async () => {
  const candidatesJson = {
    candidates: [{ topic: "Furnace warning signs before winter", notes: "What to watch for.", categoryId: "hvac" }],
  };
  for (const status of ["absent", "unauthorized"] as const) {
    const capture: GenerateContentCall[] = [];
    const result = await selectWeeklyTopic({
      config: sampleConfig,
      existingPosts: [],
      now: new Date("2026-12-15T19:00:00Z"),
      gemini: makeFakeGemini({ candidatesJson, capture }),
      weatherClient: makeFakeWeather(),
      gscSignal: { status, rows: [], byQuery: new Map(), message: "HTTP 403" },
    });
    assert.doesNotMatch(String(capture[0]?.contents ?? ""), /Search Console/i);
    assert.equal(result.topic, "Furnace warning signs before winter");
    assert.equal(result.gsc?.status, status);
  }
  const noSignal = await selectWeeklyTopic({
    config: sampleConfig,
    existingPosts: [],
    now: new Date("2026-12-15T19:00:00Z"),
    gemini: makeFakeGemini({ candidatesJson }),
    weatherClient: makeFakeWeather(),
  });
  assert.equal(noSignal.gsc, undefined);
});

test("selectWeeklyTopic drops hints whose head term an existing post title already carries", async () => {
  const capture: GenerateContentCall[] = [];
  await selectWeeklyTopic({
    config: sampleConfig,
    existingPosts: samplePosts, // includes "Refrigerator Not Cooling"
    now: new Date("2026-07-15T19:00:00Z"),
    gemini: makeFakeGemini({
      candidatesJson: { candidates: [{ topic: "Something new", notes: "n", categoryId: "hvac" }] },
      capture,
    }),
    weatherClient: makeFakeWeather(),
    gscSignal: gscSignal([
      { query: "refrigerator not cooling", impressions: 800, position: 12 },
      { query: "dryer not heating", impressions: 300, position: 15 },
    ]),
  });
  const prompt = String(capture[0]?.contents ?? "");
  assert.match(prompt, /dryer not heating/);
  assert.doesNotMatch(prompt, /- "?refrigerator not cooling"? — /i, "a query an existing post already targets is not re-suggested");
});

test("selectWeeklyTopic carries the winner's supportsSlug through", async () => {
  const result = await selectWeeklyTopic({
    config: sampleConfig,
    existingPosts: samplePosts,
    now: new Date("2026-07-15T19:00:00Z"),
    gemini: makeFakeGemini({
      candidatesJson: {
        candidates: [
          { topic: "Deeper dive on fridge compressors", notes: "n", categoryId: "appliance", supportsSlug: "refrigerator-not-cooling" },
        ],
      },
    }),
    weatherClient: makeFakeWeather(),
  });
  assert.equal(result.supportsSlug, "refrigerator-not-cooling");
});

test("selectWeeklyTopic logs a malformed credential as an error and continues", async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(" "));
  try {
    const result = await selectWeeklyTopic({
      config: sampleConfig,
      existingPosts: [],
      now: new Date("2026-12-15T19:00:00Z"),
      gemini: makeFakeGemini({
        candidatesJson: { candidates: [{ topic: "Furnace warning signs before winter", notes: "n", categoryId: "hvac" }] },
      }),
      weatherClient: makeFakeWeather(),
      gscSignal: { status: "malformed", rows: [], byQuery: new Map(), message: "GSC_SERVICE_ACCOUNT_JSON is set but is not valid" },
    });
    assert.equal(result.topic, "Furnace warning signs before winter");
    assert.equal(result.gsc?.status, "malformed");
    assert.ok(errors.some((line) => /malformed/.test(line) && /GSC_SERVICE_ACCOUNT_JSON/.test(line)), `expected a loud error, got: ${errors.join(" | ")}`);
  } finally {
    console.error = original;
  }
});
