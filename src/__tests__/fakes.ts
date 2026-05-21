/** Shared test doubles and fixtures. Excluded from the build. */
import { HVAC_APPLIANCE_CATEGORIES, SACRAMENTO_LOCATION } from "../config.js";
import type { EngineConfig, ExistingPostLike, GeminiLike, WeatherClient, WeatherContext } from "../types.js";

/**
 * Deterministic hashed bag-of-words embedding. Stable across calls (same word
 * always hashes to the same dimension), so cosine similarity between separate
 * `embedContent` calls is meaningful — identical text yields cosine 1.0.
 */
export function hashEmbed(text: string, dim = 64): number[] {
  const vec = new Array<number>(dim).fill(0);
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let hash = 0;
    for (let i = 0; i < word.length; i += 1) {
      hash = (hash * 31 + word.charCodeAt(i)) >>> 0;
    }
    const idx = hash % dim;
    vec[idx] = (vec[idx] ?? 0) + 1;
  }
  return vec;
}

export interface FakeGeminiOptions {
  /** Object stringified as the generateContent response. */
  candidatesJson?: unknown;
  /** Raw text override for generateContent. */
  generateText?: string;
  failGenerate?: boolean;
  failEmbed?: boolean;
}

export function makeFakeGemini(opts: FakeGeminiOptions = {}): GeminiLike {
  return {
    models: {
      async generateContent() {
        if (opts.failGenerate) throw new Error("fake generateContent failure");
        if (opts.generateText !== undefined) return { text: opts.generateText };
        return { text: JSON.stringify(opts.candidatesJson ?? { candidates: [] }) };
      },
      async embedContent({ contents }) {
        if (opts.failEmbed) throw new Error("fake embedContent failure");
        const texts = contents as string[];
        return { embeddings: texts.map((text) => ({ values: hashEmbed(text) })) };
      },
    },
  };
}

export function makeFakeWeather(context: Partial<WeatherContext> = {}): WeatherClient {
  return {
    async fetchWeather(): Promise<WeatherContext> {
      return {
        anomaly: "none",
        summary: "fake weather",
        maxTempF: 80,
        minTempF: 50,
        maxAqi: 30,
        available: true,
        ...context,
      };
    },
  };
}

export const sampleConfig: EngineConfig = {
  businessName: "Test HVAC & Appliance Co",
  serviceAreas: ["Sacramento", "Roseville", "Folsom"],
  location: SACRAMENTO_LOCATION,
  categories: HVAC_APPLIANCE_CATEGORIES,
};

export const samplePosts: ExistingPostLike[] = [
  {
    title: "AC Not Blowing Cold Air",
    slug: "ac-not-blowing-cold",
    description: "Common causes and fixes for a window AC that stops cooling.",
    tags: ["air conditioning", "troubleshooting"],
    date: "2026-05-01",
  },
  {
    title: "Refrigerator Not Cooling",
    slug: "refrigerator-not-cooling",
    description: "How to troubleshoot a fridge that is not staying cold.",
    tags: ["refrigerator", "appliance"],
    date: "2026-05-08",
  },
  {
    title: "SMUD Heat Pump Rebates 2026",
    slug: "smud-heat-pump-rebates",
    description: "A guide to SMUD rebates for heat pump upgrades.",
    tags: ["rebate", "smud"],
    date: "2026-05-15",
  },
];
