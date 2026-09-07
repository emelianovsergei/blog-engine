import assert from "node:assert/strict";
import test from "node:test";
import { generateCandidates } from "../candidates.js";
import { getSeasonContext } from "../season.js";
import { summarizeRecentCategories } from "../categories.js";
import { makeFakeGemini, sampleConfig } from "./fakes.js";
import type { GenerateContentCall } from "./fakes.js";

const base = () => ({
  config: sampleConfig,
  season: getSeasonContext(new Date("2026-07-15T19:00:00Z"), sampleConfig.location.timezone),
  weather: { anomaly: "none" as const, summary: "fake", maxTempF: 80, minTempF: 50, maxAqi: 30, available: true },
  existingPosts: [],
  recentMix: summarizeRecentCategories(sampleConfig.categories, []),
  count: 3,
});

test("generateCandidates passes hintQuery and supportsSlug through and asks for them when hints exist", async () => {
  const capture: GenerateContentCall[] = [];
  const gemini = makeFakeGemini({
    candidatesJson: {
      candidates: [
        { topic: "A", notes: "a", categoryId: "hvac", hintQuery: "ac installation citrus heights", supportsSlug: "ac-not-blowing-cold" },
        { topic: "B", notes: "b", categoryId: "appliance" },
      ],
    },
    capture,
  });
  const out = await generateCandidates({
    ...base(),
    existingPosts: [{ title: "AC Not Blowing Cold Air", slug: "ac-not-blowing-cold", tags: [], date: "2026-05-01" }],
    gemini,
    hints: [{ query: "ac installation citrus heights", impressions: 2630, clicks: 12, ctr: 0.004, position: 9.4, opportunity: 2400 }],
  });
  assert.equal(out[0]?.hintQuery, "ac installation citrus heights");
  assert.equal(out[0]?.supportsSlug, "ac-not-blowing-cold");
  assert.equal(out[1]?.hintQuery, undefined);
  const prompt = String(capture[0]?.contents);
  assert.match(prompt, /at least 2 of the 3 candidates/i, "half the candidates (rounded up) must target a hint");
  assert.match(prompt, /hintQuery/);
  const schema = JSON.stringify(capture[0]?.config);
  assert.match(schema, /hintQuery/);
  assert.match(schema, /supportsSlug/);
});

test("generateCandidates prompt has no hint block without hints", async () => {
  const capture: GenerateContentCall[] = [];
  await generateCandidates({
    ...base(),
    gemini: makeFakeGemini({ candidatesJson: { candidates: [{ topic: "A", notes: "a", categoryId: "hvac" }] }, capture }),
  });
  assert.doesNotMatch(String(capture[0]?.contents), /Search Console/i);
});

test("generateCandidates drops a hintQuery that was not offered and a supportsSlug that does not exist", async () => {
  const hints = [{ query: "ac installation citrus heights", impressions: 2630, clicks: 12, ctr: 0.004, position: 9.4, opportunity: 2400 }];
  const out = await generateCandidates({
    ...base(),
    existingPosts: [{ title: "AC Not Blowing Cold Air", slug: "ac-not-blowing-cold", tags: [], date: "2026-05-01" }],
    gemini: makeFakeGemini({
      candidatesJson: {
        candidates: [
          { topic: "A", notes: "a", categoryId: "hvac", hintQuery: "AC Installation Citrus Heights", supportsSlug: "ac-not-blowing-cold" },
          { topic: "B", notes: "b", categoryId: "hvac", hintQuery: "furnace repair roseville", supportsSlug: "made-up-slug" },
        ],
      },
    }),
    hints,
  });
  assert.equal(out[0]?.hintQuery, "ac installation citrus heights", "offered query, normalized to the offered spelling");
  assert.equal(out[0]?.supportsSlug, "ac-not-blowing-cold");
  assert.equal(out[1]?.hintQuery, undefined, "a query that was not offered is dropped");
  assert.equal(out[1]?.supportsSlug, undefined, "an unknown slug is dropped");
});
