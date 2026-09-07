/**
 * Refresh an existing post against the Search Console queries it already
 * ranks for. Two modes:
 *
 * - "refresh": regenerate the GEO fields (summary, faqs, targetKeyword,
 *   keywords, citations, howTo) AND lightly revise the body — keep every
 *   existing H2, add at most one new H2 that answers the top uncovered
 *   query, stay within ±20% of the length. Used by the weekly refresh job.
 * - "backfill": regenerate only the requested fields; the body is kept
 *   verbatim. Used to bring older posts up to the current template.
 *
 * `updated` is set to the run date only when something actually changed.
 * The body may never contain an FAQ section; required headings must survive
 * with exact case; `targetKeyword` must be on-topic for the title; category
 * is never model-chosen. Any of those failing throws — the caller (CLI)
 * exits non-zero and the workflow opens no PR.
 */
import { categorizeText } from "./categories.js";
import { EMPTY_LINK_POLICY, citationGuidance, policyViolation, type LinkPolicy } from "./links.js";
import { topicAlignmentIssue, writerAccuracyRules } from "./planning.js";
import type { BlogPostFrontmatter } from "./review.js";
import { DEFAULT_RUBRIC_CONSTRAINTS, countWords, hasExactH2, hasFaqHeading, type RubricConstraints } from "./rubric.js";
import type { EngineConfig, GeminiLike } from "./types.js";

export const DEFAULT_REFRESH_MODEL = "grok-4.6";

export type RefreshField = "summary" | "faqs" | "targetKeyword" | "keywords" | "citations" | "howTo";
export const ALL_REFRESH_FIELDS: readonly RefreshField[] = [
  "summary",
  "faqs",
  "targetKeyword",
  "keywords",
  "citations",
  "howTo",
];

export interface RankingQuery {
  query: string;
  impressions: number;
  position: number;
}

export interface RefreshBlogPostArgs {
  gemini: GeminiLike;
  config: EngineConfig;
  frontmatter: BlogPostFrontmatter;
  /** Current markdown body without frontmatter. */
  markdown: string;
  /** Queries this URL ranks for (Search Console, page dimension). May be empty for backfill. */
  rankingQueries: readonly RankingQuery[];
  now: Date;
  mode: "refresh" | "backfill";
  /** Fields to regenerate; defaults to all. */
  fields?: readonly RefreshField[];
  rubric?: RubricConstraints;
  linkPolicy?: LinkPolicy;
  model?: string;
}

export interface RefreshHowTo {
  name: string;
  steps: Array<{ name: string; text: string }>;
}

export interface RefreshResult {
  frontmatter: BlogPostFrontmatter;
  markdown: string;
  changeNotes: string;
  modelUsed: string;
  /** Which of the requested fields (plus "markdown") actually changed. */
  changedFields: string[];
  /** Site-agnostic HowTo, when produced; the CLI maps it to the site's shape. */
  howTo?: RefreshHowTo;
}

const refreshSchema = {
  type: "object",
  properties: {
    frontmatter: {
      type: "object",
      properties: {
        summary: { type: "string", description: "2-3 sentence answer-first summary, 50-70 words" },
        faqs: {
          type: "array",
          items: {
            type: "object",
            properties: { question: { type: "string" }, answer: { type: "string" } },
            required: ["question", "answer"],
          },
        },
        targetKeyword: { type: "string" },
        keywords: { type: "array", items: { type: "string" } },
        citations: {
          type: "array",
          items: {
            type: "object",
            properties: { name: { type: "string" }, url: { type: "string" } },
            required: ["name", "url"],
          },
        },
        howTo: {
          type: "object",
          properties: {
            name: { type: "string" },
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: { name: { type: "string" }, text: { type: "string" } },
                required: ["name", "text"],
              },
            },
          },
          required: ["name", "steps"],
        },
      },
    },
    markdown: { type: "string", description: "The full revised markdown body (refresh mode only)" },
    changeNotes: { type: "string", description: "1-3 sentences on what changed and why" },
  },
  required: ["frontmatter", "markdown", "changeNotes"],
};

function h2Headings(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => /^ {0,3}##[ \t]+(.+?)[ \t]*$/.exec(line)?.[1])
    .filter((h): h is string => typeof h === "string");
}

function stable(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function normalizeBody(markdown: string): string {
  return markdown.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

/** YYYY-MM-DD in the site's timezone: 6:30 PM PDT on the 8th is the 8th, not
 * the UTC 9th. */
export function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function fieldInstructions(fields: readonly RefreshField[], queries: readonly RankingQuery[]): string {
  const lines: string[] = [];
  const queryHint = queries.length > 0 ? " that answer the ranking queries above" : "";
  if (fields.includes("summary")) {
    lines.push(
      "- summary: 2-3 sentences, 50-70 words, answer-first — the answer or verdict in the first sentence, then the one reason that matters. It renders as the answer box under the H1 and must stand alone.",
    );
  }
  if (fields.includes("faqs")) {
    lines.push(
      `- faqs: 3-5 real homeowner questions${queryHint}, each answered answer-first in 40-70 words. Keep any existing FAQ that is still accurate.`,
    );
  }
  if (fields.includes("targetKeyword")) {
    lines.push(
      "- targetKeyword: the ONE primary phrase this post targets — prefer the highest-impression ranking query when it matches the title's topic; it must clearly belong to this post's subject.",
    );
  }
  if (fields.includes("keywords")) {
    lines.push("- keywords: 3-6 supporting phrases actually used in the post (other ranking queries qualify).");
  }
  if (fields.includes("citations")) {
    lines.push(
      "- citations: 2-3 authoritative government, utility, manufacturer or industry sources that back the article's factual claims, as {name, url}. Link a stable top-level section, never a deep consumer path.",
    );
  }
  if (fields.includes("howTo")) {
    lines.push(
      "- howTo: ONLY when the post is procedural (a homeowner performs 3-8 ordered physical steps): {name, steps[{name, text}]}. Omit it entirely otherwise.",
    );
  }
  return lines.join("\n");
}

function buildPrompt(args: RefreshBlogPostArgs, fields: readonly RefreshField[], rubric: RubricConstraints): string {
  const { config, frontmatter, markdown, rankingQueries, mode } = args;
  const policy = args.linkPolicy ?? EMPTY_LINK_POLICY;
  const guidance = citationGuidance(policy);
  const areas = config.serviceAreas.slice(0, 10).join(", ");
  const queryLines =
    rankingQueries.length > 0
      ? rankingQueries
          .map(
            (q) =>
              `- "${q.query}" — ${q.impressions.toLocaleString("en-US")} impressions, average position ${q.position.toFixed(1)}`,
          )
          .join("\n")
      : "(no Search Console data for this URL)";
  const headings = h2Headings(markdown);
  const bodyRules =
    mode === "refresh"
      ? `Body revision rules (refresh mode):
- Keep EVERY existing H2 heading verbatim, in order: ${headings.map((h) => `"## ${h}"`).join(", ") || "(none)"}.
- You may add AT MOST ONE new H2 section that directly answers the highest-impression ranking query the body does not already cover. Place it before the final call-to-action section.
- Update facts, dates and figures that have aged; tighten prose; do not change the topic, tone or Sacramento-local framing.
- Stay within ±20% of the current length (${countWords(markdown)} words).
${rubric.requiredHeadings.length > 0 ? `- These headings are required verbatim as H2 lines: ${rubric.requiredHeadings.map((h) => `"## ${h}"`).join(", ")}.\n` : ""}${rubric.faqPolicy === "appended-by-code" ? `- Do NOT write a "Frequently Asked Questions" (or "FAQ") section in the body — FAQs render from frontmatter.\n` : ""}- Return the full revised body in "markdown".`
      : `Body rules (backfill mode):
- Do NOT revise the body. Return it unchanged in "markdown"; only the requested frontmatter fields are regenerated.`;

  return `You are the senior editor for ${config.businessName}, a Sacramento-area home services company. The published post below already earns impressions in Google Search Console for the queries listed. Refresh it so it wins those queries outright: the answer box, FAQs and sources are what AI engines and featured snippets quote.

Local service areas: ${areas}.

RANKING QUERIES (Search Console, last 90 days):
${queryLines}

CURRENT FRONTMATTER:
${JSON.stringify(frontmatter, null, 2)}

CURRENT MARKDOWN BODY (${countWords(markdown)} words):
"""
${markdown}
"""

Regenerate ONLY these frontmatter fields and return them under "frontmatter" (omit every other key):
${fieldInstructions(fields, rankingQueries)}

${bodyRules}

Return JSON conforming to the provided schema with "frontmatter", "markdown" and "changeNotes" (1-3 sentences on what changed and why).
${guidance ? `\nOutbound links — hard requirements:\n${guidance}\n` : ""}
${writerAccuracyRules(Array.isArray(frontmatter.citations) ? (frontmatter.citations as Array<{ name?: string; url?: string }>) : undefined)}`;
}

interface RawRefresh {
  frontmatter?: Record<string, unknown>;
  markdown?: unknown;
  changeNotes?: unknown;
}

function cleanFaqs(raw: unknown): Array<{ question: string; answer: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((f): f is { question: unknown; answer: unknown } => typeof f === "object" && f !== null)
    .map((f) => ({ question: String(f.question ?? "").trim(), answer: String(f.answer ?? "").trim() }))
    .filter((f) => f.question && f.answer);
  return out.length > 0 ? out : undefined;
}

function cleanCitations(raw: unknown, policy: LinkPolicy): Array<{ name: string; url: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw
    .filter((c): c is { name: unknown; url: unknown } => typeof c === "object" && c !== null)
    .map((c) => ({ name: String(c.name ?? "").trim(), url: String(c.url ?? "").trim() }))
    .filter((c) => c.name && /^https?:\/\//.test(c.url) && !policyViolation(c.url, policy));
  return out.length > 0 ? out : undefined;
}

function cleanStrings(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((k): k is string => typeof k === "string" && k.trim().length > 0).map((k) => k.trim());
  return out.length > 0 ? out : undefined;
}

/** Frontmatter shape a site uses for HowTo: Promax nests `howTo {name, step[]}`,
 * Pulse flattens to `howToName` + `howToSteps`. */
export type HowToShape = "steps" | "nested";

/**
 * Write a site-agnostic HowTo into the site's frontmatter shape, removing the
 * other shape's keys so a post never carries both. `changed` is true when the
 * serialized HowTo keys differ from what the post had — including a pure
 * shape conversion of identical data, which must still be persisted.
 */
export function applyHowToShape(
  frontmatter: BlogPostFrontmatter,
  howTo: RefreshHowTo | undefined,
  shape: HowToShape,
): { frontmatter: BlogPostFrontmatter; changed: boolean } {
  if (!howTo) return { frontmatter: { ...frontmatter }, changed: false };
  const before = stable({ howTo: frontmatter.howTo, howToName: frontmatter.howToName, howToSteps: frontmatter.howToSteps });
  const out: BlogPostFrontmatter = { ...frontmatter };
  delete out.howTo;
  delete out.howToName;
  delete out.howToSteps;
  if (shape === "nested") {
    out.howTo = { name: howTo.name, step: howTo.steps };
  } else {
    out.howToName = howTo.name;
    out.howToSteps = howTo.steps;
  }
  const after = stable({ howTo: out.howTo, howToName: out.howToName, howToSteps: out.howToSteps });
  return { frontmatter: out, changed: before !== after };
}

/** The post's current HowTo in the site-agnostic shape, whichever frontmatter
 * shape it uses (`howTo {name, step[]}` or `howToName` + `howToSteps`). */
function existingHowTo(frontmatter: BlogPostFrontmatter): RefreshHowTo | undefined {
  const nested = frontmatter.howTo as { name?: unknown; step?: unknown } | undefined;
  if (nested && typeof nested === "object") {
    return cleanHowTo({ name: nested.name, steps: nested.step });
  }
  if (frontmatter.howToSteps !== undefined) {
    return cleanHowTo({ name: frontmatter.howToName, steps: frontmatter.howToSteps });
  }
  return undefined;
}

function cleanHowTo(raw: unknown): RefreshHowTo | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as { name?: unknown; steps?: unknown };
  const name = typeof r.name === "string" ? r.name.trim() : "";
  const steps = Array.isArray(r.steps)
    ? r.steps
        .filter((s): s is { name: unknown; text: unknown } => typeof s === "object" && s !== null)
        .map((s) => ({ name: String(s.name ?? "").trim(), text: String(s.text ?? "").trim() }))
        .filter((s) => s.name && s.text)
    : [];
  return name && steps.length >= 3 ? { name, steps } : undefined;
}

export async function refreshBlogPost(args: RefreshBlogPostArgs): Promise<RefreshResult> {
  const model = args.model ?? DEFAULT_REFRESH_MODEL;
  const fields = args.fields ?? ALL_REFRESH_FIELDS;
  const rubric = args.rubric ?? DEFAULT_RUBRIC_CONSTRAINTS;
  const policy = args.linkPolicy ?? EMPTY_LINK_POLICY;

  const response = await args.gemini.models.generateContent({
    model,
    contents: buildPrompt(args, fields, rubric),
    config: { responseMimeType: "application/json", responseSchema: refreshSchema },
  });
  const text = response.text;
  if (!text) throw new Error("Empty refresh response from the model");

  let parsed: RawRefresh;
  try {
    parsed = JSON.parse(text) as RawRefresh;
  } catch (error) {
    throw new Error(`Refresh response was not valid JSON: ${(error as Error).message}`);
  }
  const raw = parsed.frontmatter && typeof parsed.frontmatter === "object" ? parsed.frontmatter : {};

  // ── body ────────────────────────────────────────────────────────────────
  let markdown = args.markdown;
  if (args.mode === "refresh") {
    if (typeof parsed.markdown !== "string" || parsed.markdown.trim().length === 0) {
      throw new Error("Refresh response missing the revised markdown body");
    }
    const revised = parsed.markdown.trim();
    if (rubric.faqPolicy === "appended-by-code" && hasFaqHeading(revised)) {
      throw new Error("Refresh rejected: revision added an FAQ (Frequently Asked Questions) section to the body");
    }
    const missingRequired = rubric.requiredHeadings.filter((h) => !hasExactH2(revised, h));
    if (missingRequired.length > 0) {
      throw new Error(
        `Refresh rejected: revision dropped or re-cased required heading(s): ${missingRequired.map((h) => `"## ${h}"`).join(", ")}`,
      );
    }
    const before = h2Headings(args.markdown);
    const after = new Set(h2Headings(revised));
    const dropped = before.filter((h) => !after.has(h));
    if (dropped.length > 0) {
      throw new Error(`Refresh rejected: revision dropped existing section(s): ${dropped.map((h) => `"## ${h}"`).join(", ")}`);
    }
    const added = h2Headings(revised).filter((h) => !before.includes(h));
    if (added.length > 1) {
      throw new Error(`Refresh rejected: revision added ${added.length} sections; at most one is allowed`);
    }
    // Existing sections must keep their order: the revised heading list with
    // the (at most one) new heading removed must equal the original list.
    const revisedOld = h2Headings(revised).filter((h) => before.includes(h));
    if (revisedOld.join("\u0000") !== before.join("\u0000")) {
      throw new Error("Refresh rejected: revision changed the order of existing sections");
    }
    const ratio = countWords(revised) / Math.max(1, countWords(args.markdown));
    if (ratio < 0.8 || ratio > 1.2) {
      throw new Error(`Refresh rejected: revision length changed by ${Math.round((ratio - 1) * 100)}% (limit ±20%)`);
    }
    // Insignificant whitespace (a trailing newline, CRLF) is not a revision:
    // keep the original bytes so nothing is rewritten or stamped `updated`.
    markdown = normalizeBody(revised) === normalizeBody(args.markdown) ? args.markdown : revised;
  }

  // ── fields ──────────────────────────────────────────────────────────────
  const frontmatter: BlogPostFrontmatter = { ...args.frontmatter };
  const changed: string[] = [];
  const set = (key: string, value: unknown) => {
    if (value === undefined) return;
    if (stable(frontmatter[key]) !== stable(value)) changed.push(key);
    frontmatter[key] = value;
  };

  // A requested field the model omitted or returned malformed is a rejected
  // response, not a silent no-op: the whole point of a backfill is that the
  // post leaves with the field. (howTo and keywords stay optional.)
  const missing = (field: string): never => {
    throw new Error(`Refresh rejected: requested field "${field}" is missing or malformed in the model response`);
  };
  if (fields.includes("summary")) {
    if (typeof raw.summary !== "string" || !raw.summary.trim()) missing("summary");
    const words = countWords(raw.summary as string);
    if (words < 35 || words > 95) throw new Error(`Refresh rejected: summary is ${words} words (expected 50-70)`);
    set("summary", (raw.summary as string).trim());
  }
  if (fields.includes("faqs")) {
    const faqs = cleanFaqs(raw.faqs);
    if (!faqs) missing("faqs");
    // Only a NEW FAQ set is held to the count; echoing the existing one back
    // (even a short legacy one) is "no change", not a rejection.
    if (faqs && stable(faqs) !== stable(frontmatter.faqs) && (faqs.length < 3 || faqs.length > 8)) {
      throw new Error(`Refresh rejected: ${faqs.length} FAQs (expected 3-5)`);
    }
    set("faqs", faqs);
  }
  if (fields.includes("targetKeyword")) {
    if (typeof raw.targetKeyword !== "string" || !raw.targetKeyword.trim()) missing("targetKeyword");
    const keyword = (raw.targetKeyword as string).trim();
    const issue = topicAlignmentIssue(keyword, frontmatter.title);
    if (issue) throw new Error(`Refresh rejected: targetKeyword is off-topic — ${issue}`);
    set("targetKeyword", keyword);
  }
  if (fields.includes("keywords")) set("keywords", cleanStrings(raw.keywords));
  if (fields.includes("citations")) {
    const citations = cleanCitations(raw.citations, policy);
    if (!citations) missing("citations");
    set("citations", citations);
  }

  let howTo: RefreshHowTo | undefined;
  if (fields.includes("howTo")) {
    howTo = cleanHowTo(raw.howTo);
    const existing = existingHowTo(args.frontmatter);
    if (howTo && stable(howTo) !== stable(existing)) changed.push("howTo");
    if (!howTo && existing) {
      // The model was asked for a HowTo and omitted it: the post is not
      // procedural, so stale HowTo metadata (either site shape) comes off.
      delete frontmatter.howTo;
      delete frontmatter.howToName;
      delete frontmatter.howToSteps;
      changed.push("howTo");
    }
  }

  // Category is never the model's call.
  if (typeof frontmatter.category !== "string" || !frontmatter.category.trim()) {
    frontmatter.category = categorizeText(
      args.config.categories,
      String(frontmatter.title ?? ""),
      (frontmatter.tags ?? []).join(" "),
      String(frontmatter.description ?? ""),
    );
    changed.push("category");
  }

  if (markdown !== args.markdown) changed.push("markdown");
  const changedFields = [...new Set(changed)];
  if (changedFields.length > 0) {
    frontmatter.updated = localDate(args.now, args.config.location.timezone);
  }

  const changeNotes =
    typeof parsed.changeNotes === "string" && parsed.changeNotes.trim()
      ? parsed.changeNotes.trim()
      : changedFields.length > 0
        ? `Regenerated ${changedFields.join(", ")}.`
        : "No changes.";

  return { frontmatter, markdown, changeNotes, modelUsed: response.model ?? model, changedFields, ...(howTo && { howTo }) };
}
