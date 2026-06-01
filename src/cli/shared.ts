/** Shared CLI helpers — argv parsing, config composition, Gemini client construction. */
import {
  HVAC_APPLIANCE_CATEGORIES,
  HVAC_CATEGORIES,
  SACRAMENTO_LOCATION,
} from "../config.js";
import { createModelClient } from "../client.js";
import type { EngineConfig, GeminiLike } from "../types.js";

export type SiteKey = "pulse" | "promax";

export interface CliArgs {
  flags: Map<string, string>;
  positional: string[];
}

export function parseArgs(argv: string[]): CliArgs {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i]!;
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq !== -1) {
        flags.set(tok.slice(2, eq), tok.slice(eq + 1));
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags.set(tok.slice(2), next);
          i += 1;
        } else {
          flags.set(tok.slice(2), "true");
        }
      }
    } else {
      positional.push(tok);
    }
  }
  return { flags, positional };
}

export function requireFlag(args: CliArgs, name: string): string {
  const v = args.flags.get(name) ?? process.env[`BLOG_ENGINE_${name.toUpperCase().replace(/-/g, "_")}`];
  if (!v) {
    throw new Error(`Missing required --${name} (or BLOG_ENGINE_${name.toUpperCase().replace(/-/g, "_")} env var)`);
  }
  return v;
}

export function optionalFlag(args: CliArgs, name: string): string | undefined {
  return args.flags.get(name) ?? process.env[`BLOG_ENGINE_${name.toUpperCase().replace(/-/g, "_")}`];
}

function categoriesForSite(site: SiteKey) {
  if (site === "pulse") return HVAC_CATEGORIES;
  if (site === "promax") return HVAC_APPLIANCE_CATEGORIES;
  throw new Error(`Unknown --site "${site}" (expected "pulse" or "promax")`);
}

export function composeConfig(args: CliArgs): EngineConfig {
  const site = requireFlag(args, "site") as SiteKey;
  const businessName = requireFlag(args, "business");
  const serviceAreasRaw = requireFlag(args, "service-areas");
  const serviceAreas = serviceAreasRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (serviceAreas.length === 0) {
    throw new Error("--service-areas must be a non-empty comma-separated list");
  }
  return {
    businessName,
    serviceAreas,
    location: SACRAMENTO_LOCATION,
    categories: categoriesForSite(site),
  };
}

/**
 * Dynamically loads `@google/genai` and constructs a client. Kept dynamic so
 * the library has no hard runtime dep on it — peer dep only.
 */
export async function makeGeminiClient(): Promise<GeminiLike> {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY (or GOOGLE_API_KEY) environment variable");
  }
  const mod = (await import("@google/genai")) as unknown as {
    GoogleGenAI: new (init: { apiKey: string }) => GeminiLike;
  };
  return new mod.GoogleGenAI({ apiKey });
}

/**
 * Build the composite client the review/rewrite CLIs use: Claude primary (when
 * `ANTHROPIC_API_KEY` is set) with a Gemini fallback (when a Gemini key is set).
 * Embeddings always route to Gemini. At least one key must be present.
 */
export async function makeReviewClient(): Promise<GeminiLike> {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY);
  if (!anthropicApiKey && !hasGeminiKey) {
    throw new Error(
      "Missing model credentials: set ANTHROPIC_API_KEY (preferred) and/or GEMINI_API_KEY",
    );
  }
  const geminiClient = hasGeminiKey ? await makeGeminiClient() : undefined;
  return createModelClient({
    ...(anthropicApiKey ? { anthropicApiKey } : {}),
    ...(geminiClient ? { geminiClient } : {}),
  });
}
