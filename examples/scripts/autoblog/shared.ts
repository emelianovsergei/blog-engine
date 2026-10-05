/**
 * Helpers shared by brief.ts (GitHub Action, open network) and claude.ts (the
 * scheduled Claude session, which reaches only GitHub and npm).
 */
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import {
  categorizePost,
  type CategoryDef,
  type FetchLike,
  type GeminiLike,
  type SuggestOutcome,
} from "blog-engine";

/** One post as the brief and the session see it. */
export interface PostRow {
  title: string;
  slug: string;
  date: string;
  category: string;
  tags: string[];
  description?: string;
  targetKeyword?: string;
  /** Where the row came from: this repo, an open PR, or the sibling site. */
  source?: "published" | "pending" | "sibling" | "sibling-pending" | "sitemap";
}

function asDate(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return "";
}

/** Reads every .mdx in `dir`, newest first. A missing dir is an empty list. */
export function readPostRows(
  dir: string,
  categories: CategoryDef[],
  source: PostRow["source"],
): PostRow[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".mdx") || file.endsWith(".md"))
    .map((file) => {
      const { data } = matter(fs.readFileSync(path.join(dir, file), "utf-8"));
      const slug = typeof data.slug === "string" ? data.slug : file.replace(/\.mdx?$/, "");
      const title = typeof data.title === "string" ? data.title : slug;
      const tags = Array.isArray(data.tags)
        ? data.tags.filter((t: unknown): t is string => typeof t === "string")
        : [];
      const description = typeof data.description === "string" ? data.description : undefined;
      const category =
        typeof data.category === "string" && categories.some((c) => c.id === data.category)
          ? data.category
          : categorizePost(categories, { title, slug, tags, date: "", description });
      return {
        title,
        slug,
        date: asDate(data.date),
        category,
        tags,
        ...(description && { description }),
        ...(typeof data.targetKeyword === "string" && { targetKeyword: data.targetKeyword }),
        source,
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** Published blog slugs from a public sitemap. Titles are the humanized slug. */
export function postsFromSitemap(xml: string, siteUrl: string): PostRow[] {
  const base = siteUrl.replace(/\/+$/, "");
  const rows: PostRow[] = [];
  const seen = new Set<string>();
  for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
    const url = match[1];
    const m = url.replace(base, "").match(/^\/blog\/([a-z0-9-]+)\/?$/);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const title = m[1].replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());
    rows.push({ title, slug: m[1], date: "", category: "", tags: [], source: "sitemap" });
  }
  return rows;
}

export function pacificDate(now: Date, timezone = "America/Los_Angeles"): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// ─── Autocomplete ────────────────────────────────────────────────────────────

/** Query string → outcome, as fetched by the brief or by a live session call. */
export type AutocompleteCache = Record<string, SuggestOutcome>;

function queryOf(url: string): string {
  try {
    return new URL(url).searchParams.get("q") ?? "";
  } catch {
    return "";
  }
}

function response(status: number, body: string) {
  return { ok: status >= 200 && status < 300, status, text: async () => body };
}

/**
 * A FetchLike for the engine's suggest functions. Live mode calls the real
 * endpoint and records every outcome; cache mode answers from the brief and
 * reports a miss as a 403 so the engine records it as `blocked` (no signal),
 * never as zero demand.
 */
export function autocompleteFetch(
  cache: AutocompleteCache,
  live: boolean,
  record?: AutocompleteCache,
): FetchLike {
  return async (url, init) => {
    const q = queryOf(url);
    if (live) {
      try {
        const res = await fetch(url, {
          ...(init?.headers ? { headers: init.headers } : {}),
          signal: AbortSignal.timeout(10_000),
        });
        const body = await res.text();
        if (record && q) {
          if (!res.ok) {
            record[q] =
              res.status === 403 || res.status === 429
                ? { status: "blocked", httpStatus: res.status }
                : { status: "error", message: `HTTP ${res.status}` };
          } else {
            try {
              const parsed = JSON.parse(body) as unknown[];
              const suggestions = Array.isArray(parsed?.[1])
                ? (parsed[1] as unknown[]).filter((s): s is string => typeof s === "string")
                : [];
              record[q] =
                suggestions.length > 0
                  ? { status: "ok", suggestions }
                  : { status: "empty", suggestions: [] };
            } catch {
              record[q] = { status: "error", message: "unexpected response shape" };
            }
          }
        }
        return response(res.status, body);
      } catch (error) {
        if (record && q) record[q] = { status: "error", message: String(error) };
        throw error;
      }
    }
    const hit = cache[q];
    if (hit?.status === "ok") return response(200, JSON.stringify([q, hit.suggestions]));
    if (hit?.status === "empty") return response(200, JSON.stringify([q, []]));
    return response(403, "not in the brief's autocomplete cache");
  };
}

/** True when the real Autocomplete endpoint answers from this machine. */
export async function autocompleteReachable(): Promise<boolean> {
  try {
    const res = await fetch(
      "https://suggestqueries.google.com/complete/search?client=firefox&hl=en&gl=us&q=furnace",
      { signal: AbortSignal.timeout(8_000) },
    );
    return res.ok;
  } catch {
    return false;
  }
}

// ─── Relay client ────────────────────────────────────────────────────────────

export class RelayPending extends Error {
  constructor(readonly promptPath: string) {
    super(`Prompt written to ${promptPath}; answer it, then re-run with the answer file.`);
  }
}

/**
 * A GeminiLike that lets the Claude session stand in for the model inside an
 * engine function (researchKeywords, reviewBlogPost). With no answer it writes
 * the exact prompt and schema the engine sent and throws RelayPending. With an
 * answer it returns it verbatim, so the engine's own parsing, provenance and
 * gate logic run on Claude's output.
 */
export function relayClient(
  promptPath: string,
  answerPath?: string,
  label = "claude (session relay)",
  // Site rules appended to the engine's prompt, ahead of the answer schema.
  appendix?: string,
): GeminiLike & {
  pending: boolean;
} {
  const client = {
    pending: false,
    models: {
      async generateContent(req: { model: string; contents: unknown; config?: unknown }) {
        if (answerPath && fs.existsSync(answerPath)) {
          return { text: fs.readFileSync(answerPath, "utf-8"), model: label };
        }
        const schema = (req.config as { responseSchema?: unknown } | undefined)?.responseSchema;
        const text = [
          String(req.contents),
          "",
          ...(appendix ? [appendix.trim(), ""] : []),
          ...(schema
            ? [
                "Answer with ONE JSON object and nothing else (no prose, no code fences). It must match this JSON schema:",
                "```json",
                JSON.stringify(schema, null, 2),
                "```",
              ]
            : []),
        ].join("\n");
        fs.mkdirSync(path.dirname(promptPath), { recursive: true });
        fs.writeFileSync(promptPath, `${text}\n`);
        client.pending = true;
        throw new RelayPending(promptPath);
      },
      async embedContent(): Promise<{ embeddings?: Array<{ values?: number[] }> }> {
        throw new Error("embeddings are not available in the Claude session");
      },
    },
  };
  return client;
}

/**
 * Topics the blog does not cover: emergencies, hazards and health. The blog
 * shares friendly homeowner information; it is not a safety guide. On
 * 2026-10-05 a heat-wave "24-hour AC repair" post was closed after two
 * revisions because every fix to its safety advice (evacuating before the
 * breaker, when to call 911, a fan cutoff) drew a new Codex P1.
 *
 * Matched against what names a topic (a candidate's topic and query, a plan's
 * title and keywords), not against prose, so "turn the power off first" in a
 * maintenance post is not caught. The reviewer's editorial policy covers the
 * body.
 */
const OFF_LIMITS_TOPIC = new RegExp(
  [
    // "Emergency heat" is a heat pump setting, not an emergency, unless a
    // repair follows ("emergency heat pump repair"). "Emergency heating" and
    // "emergency heater" are emergencies.
    "emergenc(?:y|ies)(?! heat\\b(?![\\s-]+(?:(?:pump|system|unit)s?[\\s-]+)?(?:repairs?|replace(?:ment|ments|d)?|install(?:ation|ations|ed|s)?|service|technicians?|techs?|contractors?|company|fix)))",
    // Round-the-clock or after-hours repair: "24-hour" or "24 hr" (not the
    // duration "24 hours"), "24/7" (not "runs 24/7"), "after-hours" or "open
    // 24 hours", before a repair word with no punctuation in between.
    "(?:24[\\s-]*(?:hour|hr)(?!s)|(?<!\\b(?:runs?|running|ran|run|on|going)(?:\\s+[a-z]+){0,2}\\s+)24\\s*/\\s*7|after[\\s-]hours|around[\\s-]the[\\s-]clock)(?:\\s+[a-z/&-]+){0,6}?\\s+(?:repairs?|service|technicians?|techs?|contractors?|company|companies)",
    "(?:repairs?|service|technicians?|techs?|contractors?|company)\\s+(?:that(?:'s| is)\\s+)?(?:open\\s+24[\\s-]*(?:hours?|hrs?)|24\\s*/\\s*7|after[\\s-]hours|around[\\s-]the[\\s-]clock)",
    // "Safety switch" or "safety valve" is a part, not a hazard topic.
    // "Allergy-safe" or "pet-safe" is a product claim, not a hazard topic.
    "(?<!-)safe(?:ty)?(?!-)(?! (?:switch(?:es)?|valves?|sensors?|controls?|limits?|shut-?offs?|cut-?offs?|floats?|devices?|thermostats?)\\b)",
    "unsafe",
    "danger(?:ous)?",
    "hazard(?:s|ous)?",
    "carbon monoxide",
    "co (?:detectors?|alarms?|poisoning|leaks?)",
    "gas leaks?",
    "smell(?:s|ing)? (?:of |like )?(?:natural )?gas",
    "gas (?:odou?rs?|smells?)",
    "smoke (?:detectors?|alarms?)",
    // Smoke or sparks from equipment. Wildfire smoke (named anywhere in the
    // topic) and a spark igniter or electrode (a part) stay in scope.
    "(?<!wild ?fires?\\b.*)smoke (?:from|coming|out of|in the|smells?|odou?rs?)(?!.*\\bwild ?fires?\\b)(?! (?:fires?\\b|outside|outdoors))",
    "smells? like (?:smoke|burning)",
    "smoking",
    "sparks? (?:from|coming|flying|out of|inside|when)",
    "(?<!(?:igniter|ignitor|electrode|module|starter)s? (?:keeps? |is |not |won'?t stop )?)sparking",
    "(?:electrical|house|kitchen|dryer(?:[\\s-]vent)?|furnace|ac|a/c|unit|hvac|appliance|microwave|oven|stove|heater|outlet|wiring|equipment) fires?(?! up\\b| off\\b| on\\b)",
    "catch(?:es|ing)? (?:on )?fire",
    "fire (?:risk|hazard)s?",
    "burning (?:smells?|odou?rs?)",
    "electric(?:al)? shocks?",
    "evacuat\\w*",
    "heat (?:stroke|illness|exhaustion)",
    "hypothermia",
    // Medical topics. Allergy and air-quality comfort stay in scope.
    "health (?:risks?|hazards?|effects?|problems?|issues?)",
    "respiratory",
    "asthma",
    "medical",
    "illness(?:es)?",
    "diseases?",
    "(?:make|makes|making|made|get|getting|got) (?:me |you |us |them |people |kids |family )?sick",
    // Symptoms alone are medical topics too.
    "headaches?|migraines?|dizz(?:y|iness)|nause(?:a|ous)|nosebleeds?|sore throats?|cough(?:s|ing)?|short(?:ness)? of breath|trouble breathing",
    "poison\\w*",
    "911",
  ]
    .map((p) => `\\b${p}\\b`)
    .join("|"),
  "i",
);

/** The off-limits phrase in a topic's text, or undefined when it is in scope. */
export function offLimitsTopic(...texts: Array<string | undefined>): string | undefined {
  for (const text of texts) {
    const hit = text?.match(OFF_LIMITS_TOPIC);
    if (hit) return hit[0];
  }
  return undefined;
}
