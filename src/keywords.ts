/**
 * Keyword research: turns the selected topic into a real search-demand signal
 * (via Google Autocomplete) and clusters it with the LLM into the keyword set
 * that drives metadata, body copy, and the generated FAQ.
 *
 * Like dedup, this is additive and never throws — it always returns a usable
 * `KeywordResearch`, degrading from "real demand + LLM clustering" down to
 * "topic-only ideation" or "raw-suggestion salvage" as inputs fail.
 */
import {
  buildSeedQueries,
  fetchAutocompleteResult,
  isRelevantSuggestion,
} from "./suggest.js";
import type { FetchLike } from "./suggest.js";
import type { GeminiLike } from "./types.js";

export const DEFAULT_KEYWORD_MODEL = "grok-4.6";

export type SearchIntent = "informational" | "commercial" | "local";

export type DemandSignal = "real" | "partial" | "none";

export interface KeywordProvenance {
  /** True when primaryKeyword is a phrase real searchers actually typed. */
  primaryKeywordVerbatim: boolean;
  /** How many questionKeywords came verbatim from harvested suggestions. */
  questionKeywordsVerbatim: number;
  source: "autocomplete" | "llm-only";
  /** Junk removed by the relevance filter (games, jobs, schooling). */
  filteredOut: number;
}

export interface KeywordResearch {
  /** True when real autocomplete demand data was harvested (not just ideation). */
  available: boolean;
  /**
   * How much of this actually came from search data. `available` only ever
   * meant "at least one suggestion was fetched" — it said nothing about
   * whether the returned keywords derived from it, and downstream prompts
   * claimed "real Google Autocomplete demand" unconditionally.
   */
  demandSignal: DemandSignal;
  provenance: KeywordProvenance;
  /** Set when the clustering call failed, so a total outage is observable. */
  llmError?: string;
  /** The single best keyword to front-load in title/H1/description. */
  primaryKeyword: string;
  /** 3-5 supporting keywords to weave in naturally. */
  secondaryKeywords: string[];
  /** Real homeowner questions — become the FAQ section + FAQPage schema. */
  questionKeywords: string[];
  /** Local qualifiers worth naming (city/neighborhood modifiers). */
  localModifiers: string[];
  searchIntent: SearchIntent;
  /** The raw autocomplete phrases, kept for observability/debugging. */
  rawSuggestions: string[];
}

export interface ResearchKeywordsArgs {
  gemini: GeminiLike;
  seedTopic: string;
  serviceAreas: string[];
  /** Keywords from the chosen category, used to widen the seed queries. */
  categoryKeywords?: string[];
  /** Optional human-readable season/context label woven into the prompt. */
  seasonLabel?: string;
  fetchImpl?: FetchLike;
  model?: string;
}

const keywordSchema = {
  type: "object",
  properties: {
    primaryKeyword: {
      type: "string",
      description: "The single highest-value keyword/phrase to target — what searchers actually type",
    },
    secondaryKeywords: {
      type: "array",
      items: { type: "string" },
      description: "3-5 supporting keywords/variants to weave in naturally (no stuffing)",
    },
    questionKeywords: {
      type: "array",
      items: { type: "string" },
      description: "3-6 real homeowner questions phrased as questions, for an FAQ section",
    },
    localModifiers: {
      type: "array",
      items: { type: "string" },
      description: "Local qualifiers worth naming (cities/neighborhoods from the service areas)",
    },
    searchIntent: {
      type: "string",
      description: 'One of: "informational", "commercial", "local"',
    },
  },
  required: ["primaryKeyword", "secondaryKeywords", "questionKeywords", "localModifiers", "searchIntent"],
};

interface RawKeywords {
  primaryKeyword?: unknown;
  secondaryKeywords?: unknown;
  questionKeywords?: unknown;
  localModifiers?: unknown;
  searchIntent?: unknown;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
}

function normalizeIntent(value: unknown): SearchIntent {
  return value === "commercial" || value === "local" ? value : "informational";
}

/** Heuristic question detector for salvaging the FAQ when the LLM is unavailable. */
function looksLikeQuestion(text: string): boolean {
  return /\?$/.test(text.trim()) || /^(why|how|what|when|where|which|can|do|does|is|should)\b/i.test(text.trim());
}

async function harvestSuggestions(
  args: ResearchKeywordsArgs,
): Promise<{ suggestions: string[]; filteredOut: number }> {
  const seeds = buildSeedQueries({
    topic: args.seedTopic,
    ...(args.categoryKeywords ? { categoryKeywords: args.categoryKeywords } : {}),
    ...(args.serviceAreas ? { serviceAreas: args.serviceAreas } : {}),
  });
  const batches = await Promise.all(
    seeds.map(async (seed) => ({
      seed,
      outcome: await fetchAutocompleteResult(seed.query, {
        ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
      }),
    })),
  );

  const kept = new Set<string>();
  let filteredOut = 0;
  for (const { seed, outcome } of batches) {
    if (outcome.status !== "ok") continue;
    for (const suggestion of outcome.suggestions) {
      const trimmed = suggestion.trim();
      if (!trimmed) continue;
      // demand.ts always filtered by relevance; this path never did, which is
      // how "how to furnace in minecraft" and "hvac sacramento salary" reached
      // the strategist prompt labelled as real search demand.
      if (
        isRelevantSuggestion(trimmed, seed.head, {
          ...(args.serviceAreas ? { serviceAreas: args.serviceAreas } : {}),
        })
      ) {
        kept.add(trimmed);
      } else {
        filteredOut += 1;
      }
    }
  }
  return { suggestions: [...kept], filteredOut };
}

/** Loose token-set match so "ac not cooling" matches "ac not cooling house". */
function normalizePhrase(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean).join(" ");
}

function isVerbatim(phrase: string, suggestions: readonly string[]): boolean {
  const target = normalizePhrase(phrase);
  if (!target) return false;
  return suggestions.some((s) => {
    const candidate = normalizePhrase(s);
    return candidate === target || candidate.includes(target) || target.includes(candidate);
  });
}

/**
 * Prefer a real searched phrase over an invented one.
 *
 * The prompt only ever said "prefer a phrase that real searchers type", and
 * measurement showed primaryKeyword was LLM-invented in 4 of 9 production runs
 * while still being presented to the writer as real demand.
 */
function snapToSuggestion(phrase: string, suggestions: readonly string[]): string {
  if (suggestions.length === 0 || isVerbatim(phrase, suggestions)) return phrase;
  const target = new Set(normalizePhrase(phrase).split(" "));
  let best: { phrase: string; overlap: number } | undefined;
  for (const suggestion of suggestions) {
    const words = new Set(normalizePhrase(suggestion).split(" "));
    let overlap = 0;
    for (const w of words) if (target.has(w)) overlap += 1;
    if (!best || overlap > best.overlap) best = { phrase: suggestion, overlap };
  }
  // Require real overlap; otherwise keep the model's phrase and mark it.
  return best && best.overlap >= 2 ? best.phrase : phrase;
}

function buildPrompt(args: ResearchKeywordsArgs, suggestions: string[]): string {
  const suggestionBlock =
    suggestions.length > 0
      ? suggestions.map((s) => `- ${s}`).join("\n")
      : "(no live autocomplete data available — infer likely searches from the topic)";
  const season = args.seasonLabel ? `\nSeasonal context: ${args.seasonLabel}.` : "";
  return `You are an SEO/GEO strategist for a Sacramento-area home-services company. Cluster the real Google Autocomplete phrases below into the keyword set for ONE blog post.

Blog topic: ${args.seedTopic}
Service areas (only these cities may be used as local modifiers): ${args.serviceAreas.slice(0, 8).join(", ")}.${season}

Real autocomplete phrases people search:
${suggestionBlock}

Return:
- primaryKeyword: the single highest-value phrase to target (front-loaded in the title). Prefer a phrase that real searchers type.
- secondaryKeywords: 3-5 supporting variants to weave in naturally. Do NOT keyword-stuff.
- questionKeywords: 3-6 genuine homeowner questions (phrased as questions) suitable for an FAQ that AI search engines can cite.
- localModifiers: local qualifiers worth naming, drawn ONLY from the service areas above.
- searchIntent: one of "informational", "commercial", "local".`;
}

/** Salvage a usable struct from raw suggestions when the LLM call fails. */
function fallbackFromSuggestions(
  args: ResearchKeywordsArgs,
  suggestions: string[],
  filteredOut: number,
  llmError: string,
): KeywordResearch {
  const questions = suggestions.filter(looksLikeQuestion).slice(0, 6);
  const secondary = suggestions.filter((s) => !looksLikeQuestion(s)).slice(0, 5);
  const primaryKeyword = suggestions[0] ?? args.seedTopic;
  return {
    available: suggestions.length > 0,
    demandSignal: suggestions.length > 0 ? "partial" : "none",
    provenance: {
      primaryKeywordVerbatim: suggestions.length > 0,
      questionKeywordsVerbatim: questions.length,
      source: suggestions.length > 0 ? "autocomplete" : "llm-only",
      filteredOut,
    },
    llmError,
    primaryKeyword,
    secondaryKeywords: secondary,
    questionKeywords: questions,
    localModifiers: [],
    searchIntent: "informational",
    rawSuggestions: suggestions,
  };
}

export async function researchKeywords(args: ResearchKeywordsArgs): Promise<KeywordResearch> {
  const { suggestions, filteredOut } = await harvestSuggestions(args);
  const model = args.model ?? DEFAULT_KEYWORD_MODEL;

  let parsed: RawKeywords;
  try {
    const response = await args.gemini.models.generateContent({
      model,
      contents: buildPrompt(args, suggestions),
      config: { responseMimeType: "application/json", responseSchema: keywordSchema },
    });
    const text = response.text;
    if (!text) throw new Error("Empty keyword-research response");
    parsed = JSON.parse(text) as RawKeywords;
  } catch (error) {
    // Previously a bare `catch {}` — an LLM outage still reported
    // `available: true` whenever autocomplete had worked, so total failure of
    // this stage was unobservable.
    return fallbackFromSuggestions(
      args,
      suggestions,
      filteredOut,
      error instanceof Error ? error.message : String(error),
    );
  }

  const rawPrimary =
    typeof parsed.primaryKeyword === "string" && parsed.primaryKeyword.trim().length > 0
      ? parsed.primaryKeyword.trim()
      : suggestions[0] ?? args.seedTopic;
  const primaryKeyword = snapToSuggestion(rawPrimary, suggestions);
  const questionKeywords = asStringArray(parsed.questionKeywords);
  const questionKeywordsVerbatim = questionKeywords.filter((q) =>
    isVerbatim(q, suggestions),
  ).length;
  const primaryKeywordVerbatim = isVerbatim(primaryKeyword, suggestions);

  const demandSignal: DemandSignal =
    suggestions.length === 0
      ? "none"
      : primaryKeywordVerbatim && questionKeywordsVerbatim > 0
        ? "real"
        : "partial";

  return {
    available: suggestions.length > 0,
    demandSignal,
    provenance: {
      primaryKeywordVerbatim,
      questionKeywordsVerbatim,
      source: suggestions.length > 0 ? "autocomplete" : "llm-only",
      filteredOut,
    },
    primaryKeyword,
    secondaryKeywords: asStringArray(parsed.secondaryKeywords),
    questionKeywords,
    localModifiers: asStringArray(parsed.localModifiers),
    searchIntent: normalizeIntent(parsed.searchIntent),
    rawSuggestions: suggestions,
  };
}

/**
 * The keyword block injected into the planner and writer prompts.
 *
 * Lives here rather than in each consumer because the consumer copies said
 * "real Google Autocomplete demand" unconditionally — including when zero
 * suggestions had been fetched and every phrase was model-invented.
 */
export function keywordGuidance(research: KeywordResearch | undefined): string {
  if (!research) return "";
  const lines: string[] = [];
  const inferred = (verbatim: boolean): string => (verbatim ? "" : " (inferred, not a verified search)");

  lines.push(
    `Primary keyword (front-load it in the title, metaTitle, and first sentence): ${research.primaryKeyword}${inferred(research.provenance.primaryKeywordVerbatim)}`,
  );
  if (research.secondaryKeywords.length > 0) {
    lines.push(
      `Secondary keywords to weave in NATURALLY (never keyword-stuff): ${research.secondaryKeywords.join(", ")}`,
    );
  }
  if (research.localModifiers.length > 0) {
    lines.push(`Local qualifiers worth naming: ${research.localModifiers.join(", ")}`);
  }
  if (research.questionKeywords.length > 0) {
    const label =
      research.provenance.questionKeywordsVerbatim > 0
        ? `Use these questions as the FAQ (answer each one, answer-first) — ${research.provenance.questionKeywordsVerbatim} of ${research.questionKeywords.length} are verified searches`
        : "Use these questions as the FAQ (answer each one, answer-first) — these are inferred, NOT verified searches";
    lines.push(`${label}: \n${research.questionKeywords.map((q) => `  - ${q}`).join("\n")}`);
  }

  const header =
    research.demandSignal === "real"
      ? "SEO/GEO keyword research (real Google Autocomplete demand) — use it to target what people actually search:"
      : research.demandSignal === "partial"
        ? "SEO/GEO keyword research (PARTIAL live demand — phrases marked inferred are not verified searches):"
        : "SEO/GEO keyword ideas (NO live demand data was available — these are model-inferred. Do not treat them as searched phrases):";

  return `\n${header}\n${lines.join("\n")}\n`;
}
