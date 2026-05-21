/** Ties the engine modules together into the public `selectWeeklyTopic` entry point. */
import { generateCandidates } from "./candidates.js";
import { summarizeRecentCategories } from "./categories.js";
import { scoreDuplication } from "./dedup.js";
import { pickBest, rankCandidates } from "./rank.js";
import { getSeasonContext } from "./season.js";
import { openMeteoWeatherClient } from "./weather.js";
import type { SelectedTopic, SelectWeeklyTopicArgs } from "./types.js";

const DEFAULT_CANDIDATE_COUNT = 6;

/**
 * Selects the topic for this week's blog post: pulls live weather, generates
 * candidate topics aligned to season + weather, rejects semantic near-duplicates,
 * and ranks the survivors. Returns a topic that maps directly onto the existing
 * per-repo `planPost` seed shape.
 */
export async function selectWeeklyTopic(args: SelectWeeklyTopicArgs): Promise<SelectedTopic> {
  const { config, now, gemini } = args;
  const weatherClient = args.weatherClient ?? openMeteoWeatherClient;
  const count = args.candidateCount ?? DEFAULT_CANDIDATE_COUNT;

  // Recency-sensitive logic below depends on newest-first ordering.
  const existingPosts = [...args.existingPosts].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );

  const season = getSeasonContext(now, config.location.timezone);
  const weather = await weatherClient.fetchWeather(config.location, now);
  const recentMix = summarizeRecentCategories(config.categories, existingPosts);

  console.log(
    `[blog-engine] ${season.monthName} (${season.season}); weather anomaly: ${weather.anomaly}; ` +
      `recent categories: ${recentMix.ordered.join(", ") || "none"}`,
  );

  const candidates = await generateCandidates({
    gemini,
    config,
    season,
    weather,
    existingPosts,
    recentMix,
    count,
    model: args.models?.generation,
  });

  const { scores, available } = await scoreDuplication({
    gemini,
    candidates,
    existingPosts,
    model: args.models?.embedding,
  });
  if (!available) {
    console.warn(
      "[blog-engine] semantic dedup unavailable (embedding call failed) — " +
        "relying on slug + prompt-level dedup only.",
    );
  }

  const ranked = rankCandidates({ candidates, duplication: scores, recentMix, weather });
  const { winner, relaxedDuplicateFilter } = pickBest(ranked);
  if (relaxedDuplicateFilter) {
    console.warn(
      "[blog-engine] every candidate was near an existing post — picked the most distinct one.",
    );
  }

  const dupNote = winner.duplication.nearestSlug
    ? ` Closest existing post: ${winner.duplication.nearestSlug} ` +
      `(similarity ${winner.duplication.maxSimilarity.toFixed(2)}).`
    : "";

  console.log(
    `[blog-engine] selected topic (${winner.candidate.categoryId}): "${winner.candidate.topic}"`,
  );

  return {
    topic: winner.candidate.topic,
    notes: winner.candidate.notes,
    category: winner.candidate.categoryId,
    rationale: `${winner.rationale}.${dupNote}`,
    weather,
  };
}
