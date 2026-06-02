/**
 * Free, keyless search-demand signal via the Google Autocomplete/Suggest
 * endpoint. Returns the real phrases people type. Every call degrades to an
 * empty array on any error — this is an additive SEO signal and must never
 * break a generation run.
 */

/** Minimal structural subset of the global `fetch` we depend on. */
export type FetchLike = (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>;

export interface AutocompleteOptions {
  /** Injectable for tests; defaults to the global `fetch` (Node 18+). */
  fetchImpl?: FetchLike;
  /** Language hint passed to the endpoint. */
  hl?: string;
}

const SUGGEST_ENDPOINT = "https://suggestqueries.google.com/complete/search";

/**
 * Fetches autocomplete suggestions for a single query. The `client=firefox`
 * variant returns a clean JSON array: `["query", ["sugg1", "sugg2", ...]]`.
 */
export async function fetchAutocomplete(
  query: string,
  options: AutocompleteOptions = {},
): Promise<string[]> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetchImpl) return [];
  const hl = options.hl ?? "en";
  const url = `${SUGGEST_ENDPOINT}?client=firefox&hl=${encodeURIComponent(hl)}&q=${encodeURIComponent(query)}`;

  try {
    const response = await fetchImpl(url);
    if (!response.ok) return [];
    const body = await response.text();
    const parsed = JSON.parse(body) as unknown;
    if (!Array.isArray(parsed) || !Array.isArray(parsed[1])) return [];
    return (parsed[1] as unknown[]).filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

const INTENT_PREFIXES = ["why is my", "how to", "cost to", "when to replace", "best"];

/**
 * Builds a small, deduplicated set of seed queries from the topic, the
 * category's keywords, and the top service area. Capped so the number of
 * outbound fetches stays bounded.
 */
export function expandSeedQueries(
  topic: string,
  categoryKeywords: string[],
  topArea: string,
): string[] {
  const base = topic.trim();
  const keyword = (categoryKeywords[0] ?? base).trim();
  const seeds: string[] = [base];

  if (topArea.trim()) seeds.push(`${keyword} ${topArea.trim()}`);
  for (const prefix of INTENT_PREFIXES) {
    seeds.push(`${prefix} ${keyword}`);
  }

  const deduped = Array.from(new Set(seeds.map((s) => s.trim()).filter(Boolean)));
  return deduped.slice(0, 8);
}
