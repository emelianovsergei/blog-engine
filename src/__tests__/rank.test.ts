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

test("rankCandidates rewards higher search demand when a demand signal is provided", () => {
  const ranked = rankCandidates({
    candidates: [candidate("low demand topic"), candidate("high demand topic")],
    duplication: [dup(0.2), dup(0.2)],
    recentMix: NO_MIX,
    weather: CALM_WEATHER,
    demand: [0.1, 0.9],
  });
  assert.ok(ranked[1]!.score > ranked[0]!.score, "the higher-demand candidate should win all else equal");
  assert.ok(/demand/i.test(ranked[1]!.rationale), "rationale should mention the demand signal");
});

test("rankCandidates ignores the demand term when no demand signal is provided", () => {
  // All-equal candidates with no demand arg: scores stay equal (back-compat path).
  const ranked = rankCandidates({
    candidates: [candidate("a"), candidate("b")],
    duplication: [dup(0.2), dup(0.2)],
    recentMix: NO_MIX,
    weather: CALM_WEATHER,
  });
  assert.equal(ranked[0]!.score, ranked[1]!.score);
  assert.ok(!/demand/i.test(ranked[0]!.rationale), "rationale omits demand when unscored");
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

test("a measured GSC candidate is not outranked by an unmeasured one on scale alone", () => {
  // Same dedup, same rotation, neither weather-fit: the only difference is
  // that one candidate has a real (positive) demand score and the other has
  // none. Mixing demand-free and demand weights used to score the unmeasured
  // row higher, inverting the point of the GSC stage.
  const candidates = [
    { topic: "Measured topic", notes: "n", categoryId: "hvac" },
    { topic: "Unmeasured topic", notes: "n", categoryId: "hvac" },
  ];
  const duplication = candidates.map(() => ({ maxSimilarity: 0, nearest: undefined }));
  const ranked = rankCandidates({
    candidates,
    duplication,
    recentMix: { overrepresented: [], counts: {} },
    weather: { anomaly: "none", summary: "", maxTempF: 80, minTempF: 50, maxAqi: 20, available: true },
    demand: [0.5, null],
  });
  const measured = ranked.find((r) => r.candidate.topic === "Measured topic")!;
  const unmeasured = ranked.find((r) => r.candidate.topic === "Unmeasured topic")!;
  assert.ok(
    measured.score >= unmeasured.score,
    `measured ${measured.score.toFixed(3)} must not lose to unmeasured ${unmeasured.score.toFixed(3)}`,
  );
});
