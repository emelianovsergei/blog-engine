/** Ties the engine modules together into the public `selectWeeklyTopic` entry point. */
import { generateCandidates } from "./candidates.js";
import { summarizeRecentCategories } from "./categories.js";
import { scoreDemand } from "./demand.js";
import { scoreDuplication } from "./dedup.js";
import { pickBest, rankCandidates } from "./rank.js";
import { getSeasonContext } from "./season.js";
import { openMeteoWeatherClient } from "./weather.js";
import { findOpportunities, mergeDemand, type OpportunityQuery } from "./gsc.js";
import { headTerm } from "./suggest.js";
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

  // Search Console opportunities: page-two queries with real impressions,
  // minus the ones an existing post title already targets (a supporting post
  // is the planner's call via supportsSlug, but the head query itself is not
  // a new topic). Any status other than "ok" is loud but never fatal — the
  // run then behaves exactly as it did before the signal existed.
  const signal = args.gscSignal;
  let hints: OpportunityQuery[] = [];
  if (signal) {
    if (signal.status === "ok") {
      const titles = existingPosts.map((p) => p.title.toLowerCase());
      hints = findOpportunities(signal, { limit: 12 }).filter((h) => {
        const head = headTerm(h.query).toLowerCase();
        return head.length > 0 && !titles.some((title) => title.includes(head));
      });
      console.log(`[blog-engine] search console: ${signal.rows.length} rows, ${hints.length} opportunities offered.`);
    } else if (signal.status === "unauthorized") {
      console.error(
        `[blog-engine] search console signal unauthorized (${signal.message ?? "no detail"}) — check the service account's property access; continuing without it.`,
      );
    } else if (signal.status === "error") {
      console.warn(`[blog-engine] search console signal errored (${signal.message ?? "no detail"}) — continuing without it.`);
    }
  }

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
    ...(hints.length > 0 && { hints }),
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

  // Optional search-demand signal — only when a fetch impl is supplied.
  let breadth: number[] | undefined;
  if (args.fetchImpl) {
    const demandResult = await scoreDemand({ candidates, fetchImpl: args.fetchImpl });
    if (demandResult.available) {
      breadth = demandResult.scores;
      console.log("[blog-engine] search-demand signal applied to ranking.");
    } else {
      console.warn("[blog-engine] search-demand signal unavailable — ranking without it.");
    }
  }

  // Blend Search Console volume (proven impressions on queries the site
  // already ranks for) with autocomplete breadth per candidate. A row with
  // neither signal stays `null`, which rankCandidates treats as "no demand
  // signal for this candidate" rather than zero demand.
  const gscOk = signal?.status === "ok";
  let demand: Array<number | null> | undefined;
  if (breadth || gscOk) {
    demand = candidates.map((candidate, index) =>
      mergeDemand({
        head: candidate.hintQuery ?? headTerm(candidate.topic),
        breadthScore: breadth?.[index] ?? null,
        ...(gscOk && signal ? { signal } : {}),
      }).score,
    );
  }

  const ranked = rankCandidates({ candidates, duplication: scores, recentMix, weather, demand });
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

  const hintRow =
    gscOk && signal && winner.candidate.hintQuery
      ? signal.byQuery.get(winner.candidate.hintQuery.toLowerCase())
      : undefined;
  const gscNote = hintRow
    ? ` Targets the Search Console query "${hintRow.query}" (${hintRow.impressions.toLocaleString("en-US")} impressions, position ${hintRow.position.toFixed(1)}).`
    : "";

  console.log(
    `[blog-engine] selected topic (${winner.candidate.categoryId}): "${winner.candidate.topic}"`,
  );

  return {
    topic: winner.candidate.topic,
    notes: winner.candidate.notes,
    category: winner.candidate.categoryId,
    rationale: `${winner.rationale}.${dupNote}${gscNote}`,
    weather,
    ...(signal && {
      gsc: {
        status: signal.status,
        opportunitiesOffered: hints.length,
        ...(hintRow && { hintQuery: hintRow.query, impressions: hintRow.impressions }),
      },
    }),
  };
}
