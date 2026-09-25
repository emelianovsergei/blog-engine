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
