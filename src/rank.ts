/** Scoring and selection of the winning topic candidate. */
import type { RecentMix } from "./categories.js";
import { DEFAULT_SIMILARITY_THRESHOLD } from "./dedup.js";
import type { DuplicationScore } from "./dedup.js";
import type { CandidateTopic, WeatherAnomaly, WeatherContext } from "./types.js";

export interface RankedCandidate {
  candidate: CandidateTopic;
  /** Combined score in 0-1; higher is better. */
  score: number;
  duplication: DuplicationScore;
  /** True when too similar to an existing post to publish as-is. */
  rejectedAsDuplicate: boolean;
  rationale: string;
}

// Weights — dedup distance dominates, rotation next, weather fit a light nudge.
const WEIGHT_DEDUP = 0.5;
const WEIGHT_ROTATION = 0.3;
const WEIGHT_WEATHER = 0.2;

const ANOMALY_KEYWORDS: Record<WeatherAnomaly, string[]> = {
  "wildfire-smoke": ["smoke", "air quality", "filter", "merv", "hepa", "iaq", "ventilation"],
  "heat-wave": ["heat", "cooling", "cool", "ac", "air conditioner", "condenser", "overheat"],
  "cold-snap": ["cold", "heat", "furnace", "heating", "freeze", "no heat"],
  storm: ["storm", "rain", "flood", "power", "surge", "wind"],
  none: [],
};

export interface RankArgs {
  candidates: CandidateTopic[];
  /** Index-aligned with `candidates`. */
  duplication: DuplicationScore[];
  recentMix: RecentMix;
  weather: WeatherContext;
  threshold?: number;
}

export function rankCandidates(args: RankArgs): RankedCandidate[] {
  const { candidates, duplication, recentMix, weather } = args;
  const threshold = args.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const anomalyWords = ANOMALY_KEYWORDS[weather.anomaly];

  return candidates.map((candidate, index) => {
    const dup = duplication[index] ?? { maxSimilarity: 0, nearestSlug: null };
    const dedupScore = 1 - dup.maxSimilarity;
    const overrepresented = recentMix.overrepresented.includes(candidate.categoryId);
    const rotationScore = overrepresented ? 0 : 1;
    const text = `${candidate.topic} ${candidate.notes}`.toLowerCase();
    const weatherFit =
      anomalyWords.length > 0 && anomalyWords.some((word) => text.includes(word)) ? 1 : 0;

    const score =
      dedupScore * WEIGHT_DEDUP +
      rotationScore * WEIGHT_ROTATION +
      weatherFit * WEIGHT_WEATHER;

    const rationale = [
      `dedup distance ${dedupScore.toFixed(2)}`,
      overrepresented
        ? `category "${candidate.categoryId}" is over-represented`
        : `category "${candidate.categoryId}" keeps rotation balanced`,
      weatherFit ? `aligned with ${weather.anomaly} conditions` : "seasonally appropriate",
    ].join("; ");

    return {
      candidate,
      score,
      duplication: dup,
      rejectedAsDuplicate: dup.maxSimilarity >= threshold,
      rationale,
    };
  });
}

export interface PickResult {
  winner: RankedCandidate;
  /** True when every candidate was a near-duplicate and the filter was relaxed. */
  relaxedDuplicateFilter: boolean;
}

/**
 * Picks the highest-scoring non-duplicate candidate. If every candidate is a
 * near-duplicate, relaxes the filter and picks the most distinct one rather
 * than failing the run.
 */
export function pickBest(ranked: RankedCandidate[]): PickResult {
  if (ranked.length === 0) throw new Error("No candidates to rank");
  const survivors = ranked.filter((entry) => !entry.rejectedAsDuplicate);
  const relaxedDuplicateFilter = survivors.length === 0;
  const pool = relaxedDuplicateFilter ? ranked : survivors;
  const winner = [...pool].sort((a, b) => b.score - a.score)[0]!;
  return { winner, relaxedDuplicateFilter };
}
