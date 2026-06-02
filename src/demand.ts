/**
 * Search-demand scoring for topic candidates. Uses the free Google Autocomplete
 * signal (via suggest.ts) to estimate how much real search interest a candidate
 * topic has, so ranking can bias toward topics people actually search for.
 *
 * Like dedup, this is additive and never throws — on any failure it returns
 * all-zero scores with `available: false`, and ranking simply ignores the
 * (uniformly zero) demand term.
 */
import { fetchAutocomplete } from "./suggest.js";
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
  /** False when no autocomplete data could be fetched (network/blocked). */
  available: boolean;
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
}

/**
 * Scores each candidate by how many real autocomplete suggestions its core
 * query yields that are actually relevant to the topic (share a content word).
 * More relevant completions => more demonstrated search demand.
 */
export async function scoreDemand(args: ScoreDemandArgs): Promise<DemandResult> {
  const { candidates, fetchImpl } = args;
  const norm = args.maxSuggestions ?? DEFAULT_MAX_SUGGESTIONS;
  if (candidates.length === 0) return { scores: [], available: true };

  let anySuggestions = false;
  const scores = await Promise.all(
    candidates.map(async (candidate) => {
      const terms = contentWords(candidate.topic);
      const query = terms.slice(0, 5).join(" ");
      if (!query) return 0;
      const suggestions = await fetchAutocomplete(query, { fetchImpl });
      if (suggestions.length > 0) anySuggestions = true;
      const relevant = suggestions.filter((s) => {
        const lower = s.toLowerCase();
        return terms.some((term) => lower.includes(term));
      });
      return Math.min(relevant.length / norm, 1);
    }),
  );

  return { scores, available: anySuggestions };
}
