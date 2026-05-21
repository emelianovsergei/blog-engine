import assert from "node:assert/strict";
import test from "node:test";
import type { RecentMix } from "../categories.js";
import type { DuplicationScore } from "../dedup.js";
import { pickBest, rankCandidates } from "../rank.js";
import type { CandidateTopic, WeatherContext } from "../types.js";

const NO_MIX: RecentMix = { counts: {}, ordered: [], overrepresented: [] };

const CALM_WEATHER: WeatherContext = {
  anomaly: "none",
  summary: "calm",
  maxTempF: 80,
  minTempF: 55,
  maxAqi: 30,
  available: true,
};

function candidate(topic: string, categoryId = "hvac"): CandidateTopic {
  return { topic, notes: "", categoryId };
}

function dup(maxSimilarity: number): DuplicationScore {
  return { maxSimilarity, nearestSlug: maxSimilarity > 0 ? "some-post" : null };
}

test("rankCandidates rewards distinct topics over near-duplicates", () => {
  const ranked = rankCandidates({
    candidates: [candidate("a"), candidate("b")],
    duplication: [dup(0.2), dup(0.8)],
    recentMix: NO_MIX,
    weather: CALM_WEATHER,
  });
  assert.ok(ranked[0]!.score > ranked[1]!.score);
});

test("rankCandidates rejects candidates above the similarity threshold", () => {
  const ranked = rankCandidates({
    candidates: [candidate("a"), candidate("b")],
    duplication: [dup(0.5), dup(0.9)],
    recentMix: NO_MIX,
    weather: CALM_WEATHER,
  });
  assert.equal(ranked[0]!.rejectedAsDuplicate, false);
  assert.equal(ranked[1]!.rejectedAsDuplicate, true);
});

test("rankCandidates penalises an over-represented category", () => {
  const mix: RecentMix = { counts: { hvac: 2 }, ordered: ["hvac", "hvac"], overrepresented: ["hvac"] };
  const ranked = rankCandidates({
    candidates: [candidate("hvac topic", "hvac"), candidate("appliance topic", "appliance")],
    duplication: [dup(0.2), dup(0.2)],
    recentMix: mix,
    weather: CALM_WEATHER,
  });
  assert.ok(ranked[1]!.score > ranked[0]!.score, "non-blocked category should outscore blocked one");
});

test("rankCandidates rewards weather-aligned topics during an anomaly", () => {
  const smoke: WeatherContext = { ...CALM_WEATHER, anomaly: "wildfire-smoke" };
  const ranked = rankCandidates({
    candidates: [
      candidate("Upgrading to a MERV 13 filter for wildfire smoke"),
      candidate("Choosing a thermostat schedule"),
    ],
    duplication: [dup(0.2), dup(0.2)],
    recentMix: NO_MIX,
    weather: smoke,
  });
  assert.ok(ranked[0]!.score > ranked[1]!.score, "smoke-relevant topic should win during smoke");
});

test("pickBest chooses the highest-scoring survivor", () => {
  const ranked = rankCandidates({
    candidates: [candidate("low"), candidate("high")],
    duplication: [dup(0.7), dup(0.1)],
    recentMix: NO_MIX,
    weather: CALM_WEATHER,
  });
  const { winner, relaxedDuplicateFilter } = pickBest(ranked);
  assert.equal(winner.candidate.topic, "high");
  assert.equal(relaxedDuplicateFilter, false);
});

test("pickBest relaxes the filter when every candidate is a duplicate", () => {
  const ranked = rankCandidates({
    candidates: [candidate("a"), candidate("b")],
    duplication: [dup(0.95), dup(0.88)],
    recentMix: NO_MIX,
    weather: CALM_WEATHER,
  });
  const { winner, relaxedDuplicateFilter } = pickBest(ranked);
  assert.equal(relaxedDuplicateFilter, true);
  // 0.88 is the more distinct of the two, so it wins.
  assert.equal(winner.candidate.topic, "b");
});
