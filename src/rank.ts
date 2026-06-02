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

// Weights without a demand signal — dedup dominates, rotation next, weather a nudge.
const WEIGHT_DEDUP = 0.5;
const WEIGHT_ROTATION = 0.3;
const WEIGHT_WEATHER = 0.2;

// Rebalanced weights when a search-demand signal is supplied. Dedup still leads;
// demand becomes the second-strongest pull so the engine favours topics people
// actually search for, with rotation and weather as lighter nudges.
const DEMAND_WEIGHTS = { dedup: 0.4, demand: 0.25, rotation: 0.2, weather: 0.15 };

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
  /** Optional, index-aligned search-demand scores in 0-1. When present, the
   * weights rebalance to factor demand in; when absent, behaviour is unchanged. */
  demand?: number[];
  threshold?: number;
}

export function rankCandidates(args: RankArgs): RankedCandidate[] {
  const { candidates, duplication, recentMix, weather, demand } = args;
  const threshold = args.threshold ?? DEFAULT_SIMILARITY_THRESHOLD;
  const anomalyWords = ANOMALY_KEYWORDS[weather.anomaly];
  const useDemand = Array.isArray(demand);

  return candidates.map((candidate, index) => {
    const dup = duplication[index] ?? { maxSimilarity: 0, nearestSlug: null };
    const dedupScore = 1 - dup.maxSimilarity;
    const overrepresented = recentMix.overrepresented.includes(candidate.categoryId);
    const rotationScore = overrepresented ? 0 : 1;
    const text = `${candidate.topic} ${candidate.notes}`.toLowerCase();
    const weatherFit =
      anomalyWords.length > 0 && anomalyWords.some((word) => text.includes(word)) ? 1 : 0;
    const demandScore = useDemand ? (demand[index] ?? 0) : 0;

    const score = useDemand
      ? dedupScore * DEMAND_WEIGHTS.dedup +
        demandScore * DEMAND_WEIGHTS.demand +
        rotationScore * DEMAND_WEIGHTS.rotation +
        weatherFit * DEMAND_WEIGHTS.weather
      : dedupScore * WEIGHT_DEDUP +
        rotationScore * WEIGHT_ROTATION +
        weatherFit * WEIGHT_WEATHER;

    const rationale = [
      `dedup distance ${dedupScore.toFixed(2)}`,
      useDemand ? `search demand ${demandScore.toFixed(2)}` : null,
      overrepresented
        ? `category "${candidate.categoryId}" is over-represented`
        : `category "${candidate.categoryId}" keeps rotation balanced`,
      weatherFit ? `aligned with ${weather.anomaly} conditions` : "seasonally appropriate",
    ]
      .filter((part): part is string => part !== null)
      .join("; ");

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
