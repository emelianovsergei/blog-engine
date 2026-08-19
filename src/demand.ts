/**
 * Search-demand scoring for topic candidates. Uses the free Google Autocomplete
 * signal (via suggest.ts) to estimate how much real search interest a candidate
 * topic has, so ranking can bias toward topics people actually search for.
 *
 * Like dedup, this is additive and never throws — on any failure it returns
 * all-zero scores with `available: false`, and ranking simply ignores the
 * (uniformly zero) demand term.
 */
import {
  buildSeedQueries,
  fetchAutocompleteResult,
  isRelevantSuggestion,
} from "./suggest.js";
import type { FetchLike } from "./suggest.js";
import type { CandidateTopic } from "./types.js";

/** Suggestions returned for a candidate's core query, normalised against this. */
const DEFAULT_MAX_SUGGESTIONS = 8;

// Low-signal words to drop when turning a topic sentence into a search query.
// Question words (why/how/what/when) are kept — they mirror real search intent.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "at", "by", "for", "from",
  "with", "as", "is", "are", "be", "was", "were", "your", "my", "our", "its", "their",
  "that", "this", "these", "those", "it", "you", "i", "we", "they",
]);

export interface DemandResult {
  /** Index-aligned with the input candidates; each in 0-1 (higher = more demand). */
  scores: number[];
  /** True only when EVERY candidate obtained a signal (see perCandidate). */
  available: boolean;
  /** Per-row detail, so a partial signal is visible instead of silently zeroed. */
  perCandidate: CandidateDemand[];
}

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

/** Reduces a topic sentence to a short keyword query suitable for autocomplete. */
export function toSearchQuery(text: string, maxWords = 5): string {
  return contentWords(text).slice(0, maxWords).join(" ");
}

export interface ScoreDemandArgs {
  candidates: CandidateTopic[];
  fetchImpl?: FetchLike;
  maxSuggestions?: number;
  serviceAreas?: readonly string[];
  categoryKeywords?: readonly string[];
}

export interface CandidateDemand {
  score: number;
  /** True when at least one seed for THIS candidate returned completions. */
  available: boolean;
  blocked: boolean;
  queriesTried: number;
  suggestionsSeen: number;
  relevantSuggestions: string[];
}

/**
 * Scores each candidate by how many relevant autocomplete completions its
 * prefix-shaped seed queries yield.
 *
 * Availability is tracked PER CANDIDATE. It used to be a single global OR: if
 * one candidate out of six got completions, every candidate was treated as
 * having a demand signal, and the five whose queries returned nothing scored
 * zero — an arbitrary penalty indistinguishable from genuinely low demand.
 */
export async function scoreDemand(args: ScoreDemandArgs): Promise<DemandResult> {
  const { candidates, fetchImpl } = args;
  const norm = args.maxSuggestions ?? DEFAULT_MAX_SUGGESTIONS;
  if (candidates.length === 0) return { scores: [], available: true, perCandidate: [] };

  const perCandidate = await Promise.all(
    candidates.map(async (candidate): Promise<CandidateDemand> => {
      const seeds = buildSeedQueries({
        topic: candidate.topic,
        ...(args.categoryKeywords ? { categoryKeywords: args.categoryKeywords } : {}),
        ...(args.serviceAreas ? { serviceAreas: args.serviceAreas } : {}),
        maxSeeds: 6,
      });
      if (seeds.length === 0) {
        return {
          score: 0,
          available: false,
          blocked: false,
          queriesTried: 0,
          suggestionsSeen: 0,
          relevantSuggestions: [],
        };
      }

      const outcomes = await Promise.all(
        seeds.map(async (seed) => ({
          seed,
          outcome: await fetchAutocompleteResult(seed.query, {
            ...(fetchImpl ? { fetchImpl } : {}),
          }),
        })),
      );

      const relevant = new Set<string>();
      let seen = 0;
      let ok = false;
      let blocked = false;
      for (const { seed, outcome } of outcomes) {
        if (outcome.status === "blocked") blocked = true;
        if (outcome.status !== "ok") continue;
        ok = true;
        seen += outcome.suggestions.length;
        for (const suggestion of outcome.suggestions) {
          if (
            isRelevantSuggestion(suggestion, seed.head, {
              ...(args.serviceAreas ? { serviceAreas: args.serviceAreas } : {}),
            })
          ) {
            relevant.add(suggestion);
          }
        }
      }

      return {
        score: Math.min(relevant.size / norm, 1),
        available: ok,
        blocked,
        queriesTried: seeds.length,
        suggestionsSeen: seen,
        relevantSuggestions: [...relevant],
      };
    }),
  );

  return {
    scores: perCandidate.map((c) => c.score),
    // Every candidate must have a real signal before the ranker treats the
    // demand column as comparable across rows.
    available: perCandidate.every((c) => c.available),
    perCandidate,
  };
}
