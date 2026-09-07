/** Gemini-backed generation of weekly topic candidates. */
import { categorizeText } from "./categories.js";
import type { RecentMix } from "./categories.js";
import type { SeasonContext } from "./season.js";
import type { OpportunityQuery } from "./gsc.js";
import type {
  CandidateTopic,
  EngineConfig,
  ExistingPostLike,
  GeminiLike,
  WeatherContext,
} from "./types.js";

export const DEFAULT_GENERATION_MODEL = "grok-4.6";

const candidateSchema = {
  type: "object",
  properties: {
    candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "One concrete sentence: the subject and angle of a single blog post",
          },
          notes: {
            type: "string",
            description: "1-2 sentences of extra guidance — the homeowner problem and what to cover",
          },
          categoryId: {
            type: "string",
            description: "Exactly one of the allowed category ids",
          },
          hintQuery: {
            type: "string",
            description:
              "When this candidate is written to win one of the listed Search Console opportunities, that query verbatim; omit otherwise",
          },
          supportsSlug: {
            type: "string",
            description:
              "Slug of an existing post this candidate would deepen as a supporting article, if any; omit otherwise",
          },
        },
        required: ["topic", "notes", "categoryId"],
      },
    },
  },
  required: ["candidates"],
};

export interface GenerateCandidatesArgs {
  gemini: GeminiLike;
  config: EngineConfig;
  season: SeasonContext;
  weather: WeatherContext;
  existingPosts: ExistingPostLike[];
  recentMix: RecentMix;
  count: number;
  model?: string;
  /** Search Console opportunities (page-two queries with real impressions)
   * the planner should write for. Empty or absent → no hint block. */
  hints?: readonly OpportunityQuery[];
}

function hintBlock(hints: readonly OpportunityQuery[] | undefined, count: number): string {
  if (!hints || hints.length === 0) return "";
  const minTargeted = Math.ceil(count / 2);
  const lines = hints
    .map(
      (h) =>
        `- "${h.query}" — ${h.impressions.toLocaleString("en-US")} impressions, average position ${h.position.toFixed(1)}`,
    )
    .join("\n");
  return `
Search Console opportunities — queries this site ALREADY earns impressions for at positions 8-25 (page two). A dedicated post is the most reliable way to move one onto page one, and no keyword tool can produce this list:
${lines}

At least ${minTargeted} of the ${count} candidates MUST directly answer one of these queries. For those candidates set "hintQuery" to the exact query text; leave it out for the others. If a listed query fits an existing post better than a new one, propose a supporting post for it and set "supportsSlug" to that post's exact slug as listed under existing posts.
`;
}

function buildPrompt(args: GenerateCandidatesArgs): string {
  const { config, season, weather, existingPosts, recentMix, count } = args;
  const hints = hintBlock(args.hints, count);

  const categoryLines = config.categories
    .map((category) => `- ${category.id} (${category.label}): ${category.guidance}`)
    .join("\n");
  const allowedIds = config.categories.map((category) => category.id).join(", ");
  const existingList =
    existingPosts
      .slice(0, 30)
      .map((post) => `- "${post.title}" (slug: ${post.slug}) [${post.tags.join(", ")}]`)
      .join("\n") || "(no posts published yet)";
  const blocked =
    recentMix.overrepresented.length > 0
      ? `These categories are over-represented in the last 3 posts and MUST be avoided this week: ${recentMix.overrepresented.join(
          ", ",
        )}.`
      : "Keep the category mix balanced over time.";
  const areas = config.serviceAreas.slice(0, 8).join(", ");

  return `You are the editorial planner for ${config.businessName}, a Sacramento-area home services company. Propose ${count} DISTINCT candidate topics for this week's blog post.

Time of year: ${season.monthName} — ${season.season}.
Seasonal climate: ${season.climate}

This week's weather: ${weather.summary}

Allowed topic categories:
${categoryLines}
${blocked}

Existing blog posts — every candidate MUST be clearly different from all of these, not a minor rewrite:
${existingList}
${hints}
Local service areas to mention naturally: ${areas}

Rules for each candidate:
- Pick one narrowly scoped homeowner problem or decision — not a broad overview.
- Align candidates with the season; when the weather note above flags something timely, prioritise topics that speak to it.
- Spread the ${count} candidates across the allowed categories (excluding any blocked ones); do not cluster them all in one category.
- "categoryId" must be exactly one of: ${allowedIds}.
- "topic" is a single concrete sentence. "notes" gives 1-2 sentences of angle and coverage guidance.
- Do not duplicate or lightly reword any existing post listed above.`;
}

/**
 * Asks Gemini for `count` candidate topics. Throws if the response is empty or
 * unparseable — the orchestrator treats that as a hard failure of the run.
 */
export async function generateCandidates(args: GenerateCandidatesArgs): Promise<CandidateTopic[]> {
  const first = await requestCandidates(args, buildPrompt(args));
  const required = hintQuota(args);
  if (required === 0 || first.filter((c) => c.hintQuery).length >= required) return first;

  // The prompt promised at least half the candidates would answer an offered
  // Search Console query; this response did not deliver. Ask once more with
  // the shortfall stated, so a run does not quietly revert to blind topic
  // generation while still reporting the opportunities as offered.
  console.error(
    `[blog-engine] candidate response targeted ${first.filter((c) => c.hintQuery).length} of the required ${required} Search Console queries — retrying once.`,
  );
  const retry = await requestCandidates(
    args,
    `${buildPrompt(args)}\n\nYOUR PREVIOUS RESPONSE IS REJECTED: it set "hintQuery" on fewer than ${required} candidates. Return ${args.count} candidates again, and for at least ${required} of them set "hintQuery" to one of the exact Search Console queries listed above, copied character for character.`,
  );
  if (retry.filter((c) => c.hintQuery).length >= required) return retry;

  // Still short. Continue with the better of the two rather than lose the
  // week's post over a ranking preference, but say so loudly: the run report
  // and the workflow log must not imply the hints were used.
  const best = retry.filter((c) => c.hintQuery).length > first.filter((c) => c.hintQuery).length ? retry : first;
  console.error(
    `[blog-engine] candidate generation ignored the Search Console hints after a retry: ${best.filter((c) => c.hintQuery).length} of ${best.length} candidates target an offered query, expected at least ${required}. Continuing without the hint quota.`,
  );
  return best;
}

/** How many candidates must carry a recognized `hintQuery`, given what was
 * offered and how many were asked for. Zero when no hints were offered. */
function hintQuota(args: GenerateCandidatesArgs): number {
  const offered = args.hints?.length ?? 0;
  if (offered === 0) return 0;
  return Math.min(Math.ceil(args.count / 2), offered);
}

async function requestCandidates(args: GenerateCandidatesArgs, prompt: string): Promise<CandidateTopic[]> {
  const response = await args.gemini.models.generateContent({
    model: args.model ?? DEFAULT_GENERATION_MODEL,
    contents: prompt,
    config: { responseMimeType: "application/json", responseSchema: candidateSchema },
  });

  const text = response.text;
  if (!text) throw new Error("Empty candidate-generation response");

  let parsed: { candidates?: unknown };
  try {
    parsed = JSON.parse(text) as { candidates?: unknown };
  } catch (error) {
    throw new Error(`Candidate response was not valid JSON: ${(error as Error).message}`);
  }

  const validIds = new Set(args.config.categories.map((category) => category.id));
  const knownSlugs = new Set(args.existingPosts.map((post) => post.slug));
  const raw = Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const candidates: CandidateTopic[] = raw
    .filter(
      (
        entry,
      ): entry is { topic: string; notes?: string; categoryId?: string; hintQuery?: unknown; supportsSlug?: unknown } =>
        !!entry &&
        typeof (entry as { topic?: unknown }).topic === "string" &&
        (entry as { topic: string }).topic.trim().length > 0,
    )
    .map((entry) => {
      const topic = entry.topic.trim();
      const notes = (entry.notes ?? "").trim();
      // Trust the model's categoryId only if valid; otherwise re-derive it.
      const categoryId =
        entry.categoryId && validIds.has(entry.categoryId)
          ? entry.categoryId
          : categorizeText(args.config.categories, topic, notes);
      // Only references the planner was actually offered survive: a
      // hallucinated query would otherwise pull volume from the whole GSC
      // signal and win ranking, and an invented slug would be exposed
      // downstream as a real post.
      const offered = new Map((args.hints ?? []).map((h) => [h.query.toLowerCase(), h.query]));
      const hintQuery =
        typeof entry.hintQuery === "string" ? offered.get(entry.hintQuery.trim().toLowerCase()) : undefined;
      const supportsSlug =
        typeof entry.supportsSlug === "string" && knownSlugs.has(entry.supportsSlug.trim())
          ? entry.supportsSlug.trim()
          : undefined;
      return {
        topic,
        notes,
        categoryId,
        ...(hintQuery && { hintQuery }),
        ...(supportsSlug && { supportsSlug }),
      };
    });

  if (candidates.length === 0) {
    throw new Error("Candidate generation returned no usable topics");
  }
  return candidates;
}
