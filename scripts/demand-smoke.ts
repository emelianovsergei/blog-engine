/**
 * Live check that the seed queries actually return autocomplete data.
 *
 * The demand signal was unavailable in 5 of 10 production runs because the
 * queries were not prefix-shaped. This asserts the rebuilt seeds clear a real
 * bar against the live endpoint, using topics taken from actual runs.
 *
 *   Acceptance: EVERY topic must yield a usable signal (>=1 seed returning >=8
 *   completions), and >=60% of seeds overall must be productive.
 *
 *   The 60% figure is measured, not aspirational. Noun frames ("furnace cost",
 *   "when to replace furnace") complete almost always; question frames ("why
 *   is my X") only complete for symptom-shaped topics, and return nothing for
 *   a "should you X" decision post no matter how the head is cut. They stay
 *   because when they DO hit they return ten long-tail phrases that become the
 *   FAQ — the highest-value output of the whole stage. Baseline before this
 *   rework was 18% with 2/5 topics covered.
 *
 *   npm run smoke:demand
 */
import { buildSeedQueries, fetchAutocompleteResult, isRelevantSuggestion } from "../src/suggest.js";

const TOPICS = [
  "Should you run the AC on a timer overnight during a multi-day Sacramento heat wave?",
  "Why your AC breaker keeps tripping after 104°F Sacramento days",
  "Closing vents in unused rooms during an AC heat wave",
  "Attic insulation and ventilation effects on AC load in a Sacramento summer",
  "Why is my furnace blowing cold air",
];
const SERVICE_AREAS = ["Sacramento", "Roseville", "Carmichael"];
// Category keywords as the real pipeline supplies them (src/config.ts).
const CATEGORY_KEYWORDS = [["ac"], ["breaker"], ["vents"], ["attic insulation"], ["furnace"]];

async function main(): Promise<void> {
  let totalSeeds = 0;
  let seedsWithData = 0;
  let topicsWithStrongSeed = 0;
  let blocked = 0;
  let junkFiltered = 0;

  for (const topic of TOPICS) {
    const seeds = buildSeedQueries({ topic, serviceAreas: SERVICE_AREAS, categoryKeywords: CATEGORY_KEYWORDS[TOPICS.indexOf(topic)] });
    let best = 0;
    console.log(`\n"${topic.slice(0, 62)}..."`);
    for (const seed of seeds) {
      const outcome = await fetchAutocompleteResult(seed.query, { gl: "us" });
      totalSeeds += 1;
      if (outcome.status === "blocked") blocked += 1;
      const suggestions = outcome.status === "ok" ? outcome.suggestions : [];
      if (suggestions.length > 0) seedsWithData += 1;
      best = Math.max(best, suggestions.length);
      const relevant = suggestions.filter((s) =>
        isRelevantSuggestion(s, seed.head, { serviceAreas: SERVICE_AREAS }),
      );
      junkFiltered += suggestions.length - relevant.length;
      console.log(
        `  ${String(suggestions.length).padStart(2)} (${String(relevant.length).padStart(2)} relevant) ` +
          `[${outcome.status}] ${seed.query}`,
      );
    }
    if (best >= 8) topicsWithStrongSeed += 1;
  }

  const hitRate = totalSeeds > 0 ? seedsWithData / totalSeeds : 0;
  console.log(`\n--- summary ---`);
  console.log(`seeds returning data : ${seedsWithData}/${totalSeeds} (${(hitRate * 100).toFixed(0)}%)`);
  console.log(`topics with a >=8 seed: ${topicsWithStrongSeed}/${TOPICS.length}  (must be all)`);
  console.log(`junk filtered out     : ${junkFiltered}`);
  console.log(`blocked responses     : ${blocked}`);

  const pass = hitRate >= 0.6 && topicsWithStrongSeed === TOPICS.length;
  console.log(pass ? "\nPASS — seeds are prefix-shaped and productive." : "\nFAIL — seeds still return too little.");
  if (!pass) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
