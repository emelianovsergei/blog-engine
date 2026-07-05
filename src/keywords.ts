/**
 * Keyword research: turns the selected topic into a real search-demand signal
 * (via Google Autocomplete) and clusters it with the LLM into the keyword set
 * that drives metadata, body copy, and the generated FAQ.
 *
 * Like dedup, this is additive and never throws — it always returns a usable
 * `KeywordResearch`, degrading from "real demand + LLM clustering" down to
 * "topic-only ideation" or "raw-suggestion salvage" as inputs fail.
 */
import { expandSeedQueries, fetchAutocomplete } from "./suggest.js";
import type { FetchLike } from "./suggest.js";
import type { GeminiLike } from "./types.js";

export const DEFAULT_KEYWORD_MODEL = "claude-sonnet-5";

export type SearchIntent = "informational" | "commercial" | "local";

export interface KeywordResearch {
  /** True when real autocomplete demand data was harvested (not just ideation). */
  available: boolean;
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

async function harvestSuggestions(args: ResearchKeywordsArgs): Promise<string[]> {
  const topArea = args.serviceAreas[0] ?? "";
  const seeds = expandSeedQueries(args.seedTopic, args.categoryKeywords ?? [], topArea);
  const batches = await Promise.all(
    seeds.map((seed) => fetchAutocomplete(seed, { fetchImpl: args.fetchImpl })),
  );
  return Array.from(new Set(batches.flat().map((s) => s.trim()).filter(Boolean)));
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
function fallbackFromSuggestions(args: ResearchKeywordsArgs, suggestions: string[]): KeywordResearch {
  const questions = suggestions.filter(looksLikeQuestion).slice(0, 6);
  const secondary = suggestions.filter((s) => !looksLikeQuestion(s)).slice(0, 5);
  return {
    available: suggestions.length > 0,
    primaryKeyword: suggestions[0] ?? args.seedTopic,
    secondaryKeywords: secondary,
    questionKeywords: questions,
    localModifiers: [],
    searchIntent: "informational",
    rawSuggestions: suggestions,
  };
}

export async function researchKeywords(args: ResearchKeywordsArgs): Promise<KeywordResearch> {
  const suggestions = await harvestSuggestions(args);
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
  } catch {
    return fallbackFromSuggestions(args, suggestions);
  }

  const primaryKeyword =
    typeof parsed.primaryKeyword === "string" && parsed.primaryKeyword.trim().length > 0
      ? parsed.primaryKeyword.trim()
      : suggestions[0] ?? args.seedTopic;

  return {
    available: suggestions.length > 0,
    primaryKeyword,
    secondaryKeywords: asStringArray(parsed.secondaryKeywords),
    questionKeywords: asStringArray(parsed.questionKeywords),
    localModifiers: asStringArray(parsed.localModifiers),
    searchIntent: normalizeIntent(parsed.searchIntent),
    rawSuggestions: suggestions,
  };
}
