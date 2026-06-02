/**
 * Public types for the blog topic-selection engine.
 *
 * The engine has zero hard dependency on `@google/genai`: it accepts an
 * injected `GeminiLike` client described structurally below, so a real
 * `GoogleGenAI` instance satisfies it and tests can pass lightweight fakes.
 */
import type { FetchLike } from "./suggest.js";

/** Minimal structural view of the `@google/genai` client the engine uses. */
export interface GeminiLike {
  models: {
    generateContent(req: {
      model: string;
      contents: unknown;
      config?: unknown;
    }): Promise<{ text?: string }>;
    embedContent(req: {
      model: string;
      contents: unknown;
      config?: unknown;
    }): Promise<{ embeddings?: Array<{ values?: number[] }> }>;
  };
}

/** A previously published post — used for category rotation and dedup. */
export interface ExistingPostLike {
  title: string;
  slug: string;
  description?: string;
  tags: string[];
  /** ISO date string (`YYYY-MM-DD` or full ISO). */
  date: string;
}

/** One topic bucket. Order matters: categorization picks the first match. */
export interface CategoryDef {
  id: string;
  label: string;
  /** Keywords used to categorize existing posts and generated candidates. */
  keywords: string[];
  /** Prompt guidance describing what topics belong in this bucket. */
  guidance: string;
}

export interface GeoLocation {
  latitude: number;
  longitude: number;
  /** IANA timezone, e.g. "America/Los_Angeles". */
  timezone: string;
}

export interface EngineConfig {
  businessName: string;
  serviceAreas: readonly string[];
  location: GeoLocation;
  /** The single per-site difference: which topic categories are in scope. */
  categories: CategoryDef[];
}

export type WeatherAnomaly =
  | "heat-wave"
  | "cold-snap"
  | "wildfire-smoke"
  | "storm"
  | "none";

export interface WeatherContext {
  anomaly: WeatherAnomaly;
  /** Human-readable summary fed into the candidate-generation prompt. */
  summary: string;
  maxTempF: number | null;
  minTempF: number | null;
  maxAqi: number | null;
  /** False when the weather APIs could not be reached. */
  available: boolean;
}

export interface WeatherClient {
  fetchWeather(location: GeoLocation, now: Date): Promise<WeatherContext>;
}

export interface CandidateTopic {
  /** A single concrete sentence: subject + angle. */
  topic: string;
  /** 1-2 sentences of extra guidance for the downstream planner. */
  notes: string;
  categoryId: string;
}

export interface SelectedTopic {
  /** Subject + angle — maps onto the existing planPost seedTopic.topic field. */
  topic: string;
  /** Extra guidance — maps onto seedTopic.notes. */
  notes: string;
  category: string;
  /** Why this topic won — recorded in the generation run report. */
  rationale: string;
  weather: WeatherContext;
}

export interface SelectWeeklyTopicArgs {
  config: EngineConfig;
  existingPosts: ExistingPostLike[];
  now: Date;
  gemini: GeminiLike;
  /** Defaults to the live Open-Meteo client. Inject a fake for offline tests. */
  weatherClient?: WeatherClient;
  /** How many candidate topics to generate before ranking. Default 6. */
  candidateCount?: number;
  /** Model overrides — defaults are sane; exposed for tests and cost tuning. */
  models?: { generation?: string; embedding?: string };
  /** When provided, enables the Google-Autocomplete search-demand signal in
   * ranking (pass the global `fetch`). Omit to skip it. Injected in tests. */
  fetchImpl?: FetchLike;
}
