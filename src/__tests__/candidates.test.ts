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

test("generateCandidates lists each existing post's slug so supportsSlug can be exact", async () => {
  const capture: GenerateContentCall[] = [];
  await generateCandidates({
    ...base(),
    existingPosts: [{ title: "AC Not Blowing Cold Air", slug: "ac-not-blowing-cold-citrus-heights", tags: ["AC"], date: "2026-05-01" }],
    gemini: makeFakeGemini({ candidatesJson: { candidates: [{ topic: "A", notes: "a", categoryId: "hvac" }] }, capture }),
  });
  const prompt = String(capture[0]?.contents);
  assert.match(prompt, /ac-not-blowing-cold-citrus-heights/, "the slug the model must echo back is in the prompt");
});

test("generateCandidates retries once when the response ignores the offered hints", async () => {
  const hints = [
    { query: "ac installation citrus heights", impressions: 2630, clicks: 12, ctr: 0.004, position: 9.4, opportunity: 2400 },
    { query: "furnace tune up folsom", impressions: 900, clicks: 3, ctr: 0.003, position: 12.1, opportunity: 700 },
  ];
  const blind = {
    candidates: [
      { topic: "A", notes: "a", categoryId: "hvac" },
      { topic: "B", notes: "b", categoryId: "appliance" },
      { topic: "C", notes: "c", categoryId: "hvac", hintQuery: "a query never offered" },
    ],
  };
  const targeted = {
    candidates: [
      { topic: "AC installation in Citrus Heights", notes: "a", categoryId: "hvac", hintQuery: "ac installation citrus heights" },
      { topic: "Furnace tune up in Folsom", notes: "b", categoryId: "hvac", hintQuery: "furnace tune up folsom" },
      { topic: "C", notes: "c", categoryId: "appliance" },
    ],
  };
  const capture: GenerateContentCall[] = [];
  let call = 0;
  const gemini = {
    models: {
      generateContent: async (req: { contents?: unknown; config?: unknown; model?: string }) => {
        capture.push(req as GenerateContentCall);
        call += 1;
        return { text: JSON.stringify(call === 1 ? blind : targeted) };
      },
    },
  };
  const out = await generateCandidates({ ...base(), gemini: gemini as never, hints });
  assert.equal(call, 2, "a response with no recognized hint is retried once");
  assert.match(String(capture[1]?.contents), /PREVIOUS RESPONSE IS REJECTED/, "the retry states the shortfall");
  assert.equal(out.filter((c) => c.hintQuery).length, 2, "the retry's hinted candidates are used");
});

test("generateCandidates continues after a failed retry rather than losing the run", async () => {
  const hints = [
    { query: "ac installation citrus heights", impressions: 2630, clicks: 12, ctr: 0.004, position: 9.4, opportunity: 2400 },
  ];
  const errors: string[] = [];
  const original = console.error;
  console.error = (...parts: unknown[]) => errors.push(parts.map(String).join(" "));
  try {
    const out = await generateCandidates({
      ...base(),
      gemini: makeFakeGemini({ candidatesJson: { candidates: [{ topic: "A", notes: "a", categoryId: "hvac" }] } }),
      hints,
    });
    // Losing a week's post over a ranking preference is worse than the
    // preference going unmet, but it must be loud.
    assert.equal(out.length, 1, "the run continues with the candidates it has");
    assert.ok(
      errors.some((line) => /ignored the Search Console hints after a retry/.test(line)),
      `expected a loud error, got: ${errors.join(" | ")}`,
    );
  } finally {
    console.error = original;
  }
});
