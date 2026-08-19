/**
 * Free, keyless search-demand signal via the Google Autocomplete/Suggest
 * endpoint. Returns the real phrases people type. Every call degrades to an
 * empty array on any error — this is an additive SEO signal and must never
 * break a generation run.
 */

/**
 * Minimal structural subset of the global `fetch` we depend on.
 *
 * The second parameter is optional so existing single-argument test stubs stay
 * assignable, while real calls can finally send a browser User-Agent — the
 * absence of one is what makes an endpoint answer 403 to a CI runner.
 */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{ ok: boolean; status?: number; text(): Promise<string> }>;

/**
 * Why a query returned nothing. Collapsing all of these into `[]` is what let
 * a 50%-of-runs failure sit unnoticed: a bot-block, a rate limit and genuine
 * zero demand were indistinguishable.
 */
export type SuggestOutcome =
  | { status: "ok"; suggestions: string[] }
  | { status: "empty"; suggestions: [] }
  | { status: "blocked"; httpStatus: number }
  | { status: "error"; message: string };

export interface AutocompleteOptions {
  /** Injectable for tests; defaults to the global `fetch` (Node 18+). */
  fetchImpl?: FetchLike;
  /** Language hint passed to the endpoint. */
  hl?: string;
  /** Country bias. Without it results follow the runner's IP, not the market. */
  gl?: string;
}

const SUGGEST_ENDPOINT = "https://suggestqueries.google.com/complete/search";

// Some Google endpoints answer 403 to anything that does not look like a
// browser. links.ts already learned this; suggest.ts never did.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * Fetches autocomplete suggestions for a single query. The `client=firefox`
 * variant returns a clean JSON array: `["query", ["sugg1", "sugg2", ...]]`.
 */
export async function fetchAutocompleteResult(
  query: string,
  options: AutocompleteOptions = {},
): Promise<SuggestOutcome> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetchImpl) return { status: "error", message: "no fetch implementation available" };
  const hl = options.hl ?? "en";
  const gl = options.gl ?? "us";
  const url = `${SUGGEST_ENDPOINT}?client=firefox&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}&q=${encodeURIComponent(query)}`;

  try {
    const response = await fetchImpl(url, { headers: { "User-Agent": BROWSER_USER_AGENT } });
    if (!response.ok) {
      const status = response.status ?? 0;
      return status === 403 || status === 429
        ? { status: "blocked", httpStatus: status }
        : { status: "error", message: `HTTP ${status || "error"}` };
    }
    const body = await response.text();
    const parsed = JSON.parse(body) as unknown;
    if (!Array.isArray(parsed) || !Array.isArray(parsed[1])) {
      return { status: "error", message: "unexpected response shape" };
    }
    const suggestions = (parsed[1] as unknown[]).filter((s): s is string => typeof s === "string");
    return suggestions.length > 0 ? { status: "ok", suggestions } : { status: "empty", suggestions: [] };
  } catch (error) {
    return { status: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

/** Back-compatible wrapper: suggestions only, empty on any failure. */
export async function fetchAutocomplete(
  query: string,
  options: AutocompleteOptions = {},
): Promise<string[]> {
  const outcome = await fetchAutocompleteResult(query, options);
  return outcome.status === "ok" ? outcome.suggestions : [];
}

const HEAD_STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "for", "with", "without", "your", "you",
  "my", "our", "their", "its", "it", "is", "are", "was", "were", "be", "been",
  "do", "does", "did", "can", "could", "should", "would", "will", "of", "on",
  "in", "to", "from", "at", "by", "as", "that", "this", "these", "those",
  "how", "why", "what", "when", "where", "which", "who", "if", "then", "than",
  "during", "after", "before", "into", "over", "under", "about", "vs", "versus",
  "sacramento", "california", "ca", "area", "near", "me", "local",
]);

/**
 * Reduce a topic sentence to the 2-4 word head term people actually type.
 *
 * Word ORDER is preserved because Autocomplete is a prefix API: "furnace
 * blowing cold air" completes, the same words in any other order do not. The
 * previous implementation stripped stopwords and took the first five tokens of
 * the resulting bag, producing strings that are not a prefix of any real query
 * — which is why the demand signal was unavailable in half of all production
 * runs.
 */
export function headTerm(topic: string, maxWords = 4): string {
  const words = topic
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    // Two-letter words are kept: "ac" is the single most searched noun in this
    // domain, and a length>2 filter silently deleted it from every query.
    .filter((w) => w.length >= 2 && !HEAD_STOPWORDS.has(w));
  return words.slice(0, maxWords).join(" ");
}

export type SeedKind = "head" | "question" | "intent" | "local" | "modifier";

export interface SeedQuery {
  query: string;
  kind: SeedKind;
  head: string;
}

export interface BuildSeedQueriesArgs {
  topic: string;
  categoryKeywords?: readonly string[];
  serviceAreas?: readonly string[];
  maxSeeds?: number;
}

/**
 * Natural, prefix-shaped queries built around the topic's head term.
 *
 * Every seed must read like something a person would actually type, because
 * anything else returns zero completions. The raw topic sentence is never
 * sent: long sentences have no autocomplete entries at all.
 */
export function buildSeedQueries(args: BuildSeedQueriesArgs): SeedQuery[] {
  // Two head lengths, because prefix productivity falls off a cliff with
  // specificity. Measured against the live endpoint: "furnace blowing cold
  // air" returns 10 completions, while "attic insulation ventilation effects"
  // returns none — but its two-word core, "attic insulation", is a real query.
  // Long heads carry the question frames; short heads carry everything else.
  const headLong = headTerm(args.topic, 3);
  const headShort = headTerm(args.topic, 2);
  if (!headShort) return [];
  // Cost, replacement and local frames need a SUBJECT NOUN. A two-word slice
  // of a topic sentence is often a verb fragment — "furnace blowing" — which
  // completes to nothing, while "furnace" completes richly. The category
  // keyword is already that noun ("furnace", "ac", "duct", "thermostat"), so
  // prefer it and fall back to the first content word.
  const nounHead =
    args.categoryKeywords?.[0]?.trim().toLowerCase() || headTerm(args.topic, 1) || headShort;
  const topArea = args.serviceAreas?.[0]?.trim().toLowerCase();

  const seeds: SeedQuery[] = [];
  const push = (query: string, kind: SeedKind, head: string): void => {
    seeds.push({ query, kind, head });
  };

  push(headShort, "head", headShort);
  if (headLong !== headShort) push(headLong, "head", headLong);

  // Question frames read naturally with the longer, more descriptive head.
  push(`why is my ${headLong}`, "question", headLong);
  push(`how to fix ${headLong}`, "question", headLong);
  push(`what causes ${headLong}`, "question", headLong);

  // Noun frames.
  push(`how much does ${nounHead} cost`, "intent", nounHead);
  push(`when to replace ${nounHead}`, "intent", nounHead);
  push(`${nounHead} cost`, "modifier", nounHead);
  push(`${headLong} when`, "modifier", headLong);

  if (topArea) push(`${nounHead} ${topArea}`, "local", nounHead);

  const seen = new Set<string>();
  const unique = seeds.filter((s) => {
    const q = s.query.trim();
    // Beyond eight words a string stops behaving like a prefix.
    if (!q || q.split(/\s+/).length > 8 || seen.has(q)) return false;
    seen.add(q);
    return true;
  });
  return unique.slice(0, args.maxSeeds ?? 12);
}

/**
 * Phrases that share a category word but belong to an unrelated intent —
 * video games, job seekers, schooling. Roughly a quarter of the harvested
 * corpus was this: "how to furnace in minecraft", "hvac sacramento salary".
 */
export const DEFAULT_SUGGESTION_DENYLIST: readonly string[] = [
  "minecraft", "palworld", "terraria", "roblox", "stardew", "fortnite", "valheim",
  "jobs", "job", "salary", "hiring", "career", "careers", "apprentice",
  "apprenticeship", "school", "schools", "training", "certification", "course",
  "classes", "degree", "union", "reddit", "lyrics", "meaning", "for sale",
  "resume", "interview", "quiz", "definition", "wikipedia",
];

export interface RelevanceOptions {
  serviceAreas?: readonly string[];
  denylist?: readonly string[];
  /** Cities the business does not serve make a phrase irrelevant. */
  knownCities?: readonly string[];
}

/**
 * True when a suggestion is plausibly the same subject as `head`.
 *
 * demand.ts always filtered by shared content word; keywords.ts never did,
 * which is how game and job queries reached the strategist prompt labelled
 * "Real autocomplete phrases people search".
 */
export function isRelevantSuggestion(
  suggestion: string,
  head: string,
  options: RelevanceOptions = {},
): boolean {
  const lower = suggestion.toLowerCase();
  const denylist = options.denylist ?? DEFAULT_SUGGESTION_DENYLIST;
  if (denylist.some((term) => new RegExp(`\\b${term}\\b`).test(lower))) return false;

  const headWords = head.toLowerCase().split(/\s+/).filter(Boolean);
  if (headWords.length > 0 && !headWords.some((w) => lower.includes(w))) return false;

  const areas = (options.serviceAreas ?? []).map((a) => a.toLowerCase());
  const cities = (options.knownCities ?? []).map((c) => c.toLowerCase());
  const namedOutside = cities.find((c) => lower.includes(c) && !areas.includes(c));
  return !namedOutside;
}

const INTENT_PREFIXES = ["why is my", "how to", "cost to", "when to replace", "best"];

/**
 * @deprecated Category-keyword-shaped seeds that ignore the chosen topic.
 * Use {@link buildSeedQueries}, which is prefix-shaped and topic-led.
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
