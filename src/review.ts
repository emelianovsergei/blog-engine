/**
 * AI-powered quality review of a draft blog post.
 *
 * Mirrors the structured-JSON pattern used by `candidates.ts`: the model is
 * asked to emit a JSON object matching `reviewSchema`, we parse it, then
 * compute the pass/fail gate ourselves so the verdict is deterministic and
 * never just trusted from the model.
 */
import {
  DEFAULT_RUBRIC_CONSTRAINTS,
  reviewerRubric,
  type RubricConstraints,
} from "./rubric.js";
import type {
  EngineConfig,
  ExistingPostLike,
  GeminiLike,
} from "./types.js";

export const DEFAULT_REVIEW_MODEL = "grok-4.6";

export type ReviewDimension =
  | "contentQuality"
  | "seoMetadata"
  | "brandVoiceFit"
  | "humanVoice";

/** Rubric headings, shared by the prompt renderer. */
export const DIMENSION_LABELS: Record<string, string> = {
  contentQuality: "CONTENT QUALITY",
  seoMetadata: "SEO & METADATA",
  brandVoiceFit: "BRAND VOICE & SITE FIT",
  humanVoice: "HUMAN VOICE",
};

/** Title-case variants used in the rendered review report. */
const REPORT_LABELS: Record<string, string> = {
  contentQuality: "Content Quality",
  seoMetadata: "SEO & Metadata",
  brandVoiceFit: "Brand Voice & Fit",
  humanVoice: "Human Voice",
};

const ALL_DIMENSIONS: readonly ReviewDimension[] = [
  "contentQuality",
  "seoMetadata",
  "brandVoiceFit",
  "humanVoice",
];

export interface DimensionScore {
  dimension: ReviewDimension;
  /** 0-10, clamped. */
  score: number;
  /** 1-2 sentences justifying the score. */
  reasoning: string;
}

export interface ReviewIssue {
  dimension: ReviewDimension;
  severity: "blocker" | "major" | "minor";
  message: string;
  suggestion: string;
  location?: string;
}

export interface ReviewGate {
  minOverall: number;
  minPerDimension: number;
  blockOnAnyBlocker: boolean;
  /**
   * Dimensions that are scored and reported but never gate a publish —
   * excluded from the overall mean, the per-dimension floor, and blockers.
   * Lets a new dimension run in production long enough to calibrate before
   * it can strand posts.
   */
  advisoryDimensions?: readonly ReviewDimension[];
}

export const DEFAULT_GATE: ReviewGate = {
  minOverall: 7.0,
  minPerDimension: 6.0,
  blockOnAnyBlocker: true,
  // humanVoice ships advisory: scored, reported and fed to the rewriter, but
  // excluded from the gate until there are enough real scores to calibrate
  // against. `overall` is an unweighted mean, so gating on a cold dimension
  // silently moves the bar for every post at once. Set to [] to enforce.
  advisoryDimensions: ["humanVoice"],
};

export interface ReviewResult {
  pass: boolean;
  overallScore: number;
  scores: DimensionScore[];
  issues: ReviewIssue[];
  suggestions: string[];
  summary: string;
  thresholdReasoning: string;
  modelUsed: string;
}

export interface BlogPostFrontmatter {
  title: string;
  description?: string;
  slug?: string;
  tags?: string[];
  category?: string;
  date?: string;
  [key: string]: unknown;
}

export interface ReviewBlogPostArgs {
  gemini: GeminiLike;
  config: EngineConfig;
  frontmatter: BlogPostFrontmatter;
  /** Markdown body without frontmatter. */
  markdown: string;
  /** Optional published-post list — included in the prompt as duplication context. */
  existingPosts?: ExistingPostLike[];
  /** Defaults to `grok-4.6`. */
  model?: string;
  /** Overrides the default gate (testing / forced-strict mode). */
  gate?: ReviewGate;
  /** Site-specific rubric numbers; defaults to DEFAULT_RUBRIC_CONSTRAINTS. */
  rubric?: RubricConstraints;
}

export const reviewSchema = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          dimension: {
            type: "string",
            enum: ["contentQuality", "seoMetadata", "brandVoiceFit", "humanVoice"],
          },
          score: { type: "number", description: "0 to 10" },
          reasoning: { type: "string", description: "1-2 sentences justifying the score" },
        },
        required: ["dimension", "score", "reasoning"],
      },
    },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          dimension: {
            type: "string",
            enum: ["contentQuality", "seoMetadata", "brandVoiceFit", "humanVoice"],
          },
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          message: { type: "string" },
          suggestion: { type: "string" },
          location: { type: "string" },
        },
        required: ["dimension", "severity", "message", "suggestion"],
      },
    },
    suggestions: {
      type: "array",
      items: { type: "string" },
      description: "Non-blocking nice-to-have suggestions (top 3-5)",
    },
    summary: {
      type: "string",
      description: "Overall verdict in 2-3 sentences",
    },
  },
  required: ["scores", "issues", "summary"],
};

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Deterministic structural facts injected into the review prompt.
 *
 * The reviewer model has miscounted list-shaped frontmatter before (a
 * five-entry `faqs` array read as one entry, tripping a false blocker that
 * failed the gate), so everything a few lines of code can verify is computed
 * here and handed to the model as ground truth it must not contradict.
 */
export function buildVerifiedFacts(frontmatter: BlogPostFrontmatter): string {
  const lines: string[] = [];

  const faqs = frontmatter.faqs;
  if (Array.isArray(faqs)) {
    const malformed = faqs
      .map((entry, i) => {
        const f = entry as { question?: unknown; answer?: unknown } | null;
        return isNonEmptyString(f?.question) && isNonEmptyString(f?.answer) ? -1 : i;
      })
      .filter((i) => i >= 0);
    lines.push(
      malformed.length === 0
        ? `frontmatter.faqs: ${faqs.length} entries, all well-formed {question, answer}`
        : `frontmatter.faqs: ${faqs.length} entries; malformed (missing question/answer) at index(es) ${malformed.join(", ")}`,
    );
  } else {
    lines.push("frontmatter.faqs: not present");
  }

  const citations = frontmatter.citations;
  if (Array.isArray(citations)) {
    const malformed = citations
      .map((entry, i) => {
        const c = entry as { name?: unknown; url?: unknown } | null;
        if (!isNonEmptyString(c?.name) || !isNonEmptyString(c?.url)) return i;
        try {
          new URL(c.url);
          return -1;
        } catch {
          return i;
        }
      })
      .filter((i) => i >= 0);
    lines.push(
      malformed.length === 0
        ? `frontmatter.citations: ${citations.length} entries, all well-formed {name, url}`
        : `frontmatter.citations: ${citations.length} entries; malformed (missing name or invalid url) at index(es) ${malformed.join(", ")}`,
    );
  } else {
    lines.push("frontmatter.citations: not present");
  }

  const len = (v: unknown) => (isNonEmptyString(v) ? `${v.length} chars` : "missing");
  lines.push(
    `title: ${len(frontmatter.title)}; description: ${len(frontmatter.description)}; slug: ${len(frontmatter.slug)}`,
  );

  return lines.map((l) => `- ${l}`).join("\n");
}

function buildPrompt(args: ReviewBlogPostArgs): string {
  const { config, frontmatter, markdown, existingPosts } = args;
  const rubric = args.rubric ?? DEFAULT_RUBRIC_CONSTRAINTS;
  const categoryLines = config.categories
    .map((c) => `- ${c.id} (${c.label}): ${c.guidance}`)
    .join("\n");
  const allowedIds = config.categories.map((c) => c.id).join(", ");
  const areas = config.serviceAreas.slice(0, 10).join(", ");
  const recentTitles =
    existingPosts && existingPosts.length > 0
      ? existingPosts
          .slice(0, 20)
          .map((p) => `- "${p.title}"`)
          .join("\n")
      : "(none provided)";

  return `You are the senior editor for ${config.businessName}, a Sacramento-area home services company. Review the candidate blog post below against the rubric. Be strict but fair — this post is going to be published on the public site.

Local service areas: ${areas}.

Allowed topic categories for this site:
${categoryLines}

Rubric — score each dimension 0 to 10 (10 = excellent, 7 = solid publish, 5 = needs work, 0 = unusable). Flag concrete issues with severity (blocker | major | minor) and a concrete suggested fix.

${reviewerRubric(rubric, { dimensionLabels: DIMENSION_LABELS })}

Site-wide requirements that apply regardless of dimension:
   - Factually plausible for HVAC / appliance / home-services domain. No obvious technical errors.
   - Well structured: clear intro, scannable subheads, sensible conclusion.
   - Topic clearly fits this site's category set (above). Off-scope topics fail brandVoiceFit.
   - frontmatter.category is set by the pipeline, not by the writer — treat "${allowedIds}" as ground truth and never raise an issue about it.

Recent published titles for duplication awareness:
${recentTitles}

VERIFIED STRUCTURAL FACTS (computed deterministically by code — trust these over your own counting; do NOT raise issues that contradict them):
${buildVerifiedFacts(frontmatter)}

POST FRONTMATTER:
${JSON.stringify(frontmatter, null, 2)}

POST MARKDOWN BODY:
"""
${markdown}
"""

Return JSON conforming to the provided schema. Every issue MUST have a concrete one-line suggestion. Include exactly one score entry per dimension (contentQuality, seoMetadata, brandVoiceFit).`;
}

function clamp01to10(n: unknown): number {
  const x = typeof n === "number" && Number.isFinite(n) ? n : 0;
  if (x < 0) return 0;
  if (x > 10) return 10;
  return x;
}

interface RawScore {
  dimension?: unknown;
  score?: unknown;
  reasoning?: unknown;
}
interface RawIssue {
  dimension?: unknown;
  severity?: unknown;
  message?: unknown;
  suggestion?: unknown;
  location?: unknown;
}
interface RawReview {
  scores?: unknown;
  issues?: unknown;
  suggestions?: unknown;
  summary?: unknown;
}

function parseScores(raw: unknown): DimensionScore[] {
  if (!Array.isArray(raw)) {
    throw new Error("Review response missing 'scores' array");
  }
  const byDim = new Map<ReviewDimension, DimensionScore>();
  for (const entry of raw as RawScore[]) {
    if (!entry || typeof entry !== "object") continue;
    const dim = entry.dimension;
    // Derived from ALL_DIMENSIONS so adding a dimension cannot silently drop
    // it here while the missing-dimension check below rejects the response.
    if (!ALL_DIMENSIONS.includes(dim as ReviewDimension)) continue;
    const dimension = dim as ReviewDimension;
    byDim.set(dimension, {
      dimension,
      score: clamp01to10(entry.score),
      reasoning: typeof entry.reasoning === "string" ? entry.reasoning : "",
    });
  }
  const missing = ALL_DIMENSIONS.filter((d) => !byDim.has(d));
  if (missing.length > 0) {
    throw new Error(
      `Review missing required dimension scores: ${missing.join(", ")}`,
    );
  }
  // Preserve canonical ordering.
  return ALL_DIMENSIONS.map((d) => byDim.get(d)!);
}

const SEVERITY_ORDER: Record<ReviewIssue["severity"], number> = {
  blocker: 0,
  major: 1,
  minor: 2,
};

function parseIssues(raw: unknown): ReviewIssue[] {
  if (!Array.isArray(raw)) return [];
  const issues: ReviewIssue[] = [];
  for (const entry of raw as RawIssue[]) {
    if (!entry || typeof entry !== "object") continue;
    const dim = entry.dimension;
    if (
      dim !== "contentQuality" &&
      dim !== "seoMetadata" &&
      dim !== "brandVoiceFit"
    ) {
      continue;
    }
    const sev = entry.severity;
    if (sev !== "blocker" && sev !== "major" && sev !== "minor") continue;
    const message = typeof entry.message === "string" ? entry.message.trim() : "";
    if (!message) continue;
    const suggestion =
      typeof entry.suggestion === "string" ? entry.suggestion.trim() : "";
    const issue: ReviewIssue = { dimension: dim, severity: sev, message, suggestion };
    if (typeof entry.location === "string" && entry.location.trim()) {
      issue.location = entry.location.trim();
    }
    issues.push(issue);
  }
  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return issues;
}

function parseSuggestions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
    .map((s) => s.trim());
}

function computeGate(
  scores: DimensionScore[],
  issues: ReviewIssue[],
  gate: ReviewGate,
): { pass: boolean; overall: number; reasoning: string } {
  const advisory = new Set(gate.advisoryDimensions ?? []);
  const gating = scores.filter((s) => !advisory.has(s.dimension));
  // Falling back to `scores` keeps a gate that marks every dimension advisory
  // from dividing by zero; such a config simply never fails.
  const counted = gating.length > 0 ? gating : scores;
  const overall = counted.reduce((sum, s) => sum + s.score, 0) / counted.length;
  const failingDim = counted.find((s) => s.score < gate.minPerDimension);
  const hasBlocker =
    gate.blockOnAnyBlocker &&
    issues.some((i) => i.severity === "blocker" && !advisory.has(i.dimension));

  if (failingDim) {
    return {
      pass: false,
      overall,
      reasoning: `Failed: ${failingDim.dimension}=${failingDim.score.toFixed(1)} below floor ${gate.minPerDimension.toFixed(1)}.`,
    };
  }
  if (hasBlocker) {
    return {
      pass: false,
      overall,
      reasoning: `Failed: at least one blocker issue must be resolved.`,
    };
  }
  if (overall < gate.minOverall) {
    return {
      pass: false,
      overall,
      reasoning: `Failed: overall ${overall.toFixed(1)} below threshold ${gate.minOverall.toFixed(1)}.`,
    };
  }
  return {
    pass: true,
    overall,
    reasoning: `Passed: overall ${overall.toFixed(1)}, no blockers, all dimensions >= ${gate.minPerDimension.toFixed(1)}.`,
  };
}

/**
 * Reviews a draft blog post. Throws if the model returned an empty response,
 * invalid JSON, or a body missing the required dimension scores. All other
 * shape oddities are clamped/defaulted so we always emit a usable result.
 */
export async function reviewBlogPost(args: ReviewBlogPostArgs): Promise<ReviewResult> {
  const model = args.model ?? DEFAULT_REVIEW_MODEL;
  const gate = args.gate ?? DEFAULT_GATE;
  const prompt = buildPrompt(args);

  // Structured-output models occasionally return a well-formed JSON object that
  // is nonetheless missing a required field (e.g. Claude tool-use dropping the
  // `scores` array). That parse failure surfaces only after the call returns, so
  // the client's transient-retry can't catch it — re-roll here instead of failing
  // the whole review for a recoverable model hiccup.
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await args.gemini.models.generateContent({
        model,
        contents: prompt,
        config: { responseMimeType: "application/json", responseSchema: reviewSchema },
      });

      const text = response.text;
      if (!text) throw new Error("Empty review response from the model");

      let parsed: RawReview;
      try {
        parsed = JSON.parse(text) as RawReview;
      } catch (error) {
        throw new Error(`Review response was not valid JSON: ${(error as Error).message}`);
      }

      const scores = parseScores(parsed.scores);
      const issues = parseIssues(parsed.issues);
      const suggestions = parseSuggestions(parsed.suggestions);
      const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";

      const { pass, overall, reasoning } = computeGate(scores, issues, gate);

      return {
        pass,
        overallScore: overall,
        scores,
        issues,
        suggestions,
        summary,
        thresholdReasoning: reasoning,
        modelUsed: response.model ?? model,
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Renders a `ReviewResult` as a Markdown summary suitable for posting as a
 * sticky PR comment. Deterministic — used by the CLI.
 */
/**
 * Load a ReviewResult that was written to disk, possibly by an older engine.
 *
 * `parseScores` stays strict for fresh model output — a model that omits a
 * dimension is a real failure the retry loop should absorb. Persisted JSON is
 * different: a review-result.json written before humanVoice existed is still
 * perfectly usable as rewrite input, and the CLI previously did a bare
 * `JSON.parse(raw) as ReviewResult` with no validation at all.
 */
export function parseReviewResult(raw: unknown): ReviewResult {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Review result is not an object");
  }
  const r = raw as Record<string, unknown>;
  const scores = Array.isArray(r.scores)
    ? r.scores
        .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
        .filter((s) => ALL_DIMENSIONS.includes(s.dimension as ReviewDimension))
        .map((s) => ({
          dimension: s.dimension as ReviewDimension,
          score: typeof s.score === "number" ? s.score : 0,
          reasoning: typeof s.reasoning === "string" ? s.reasoning : "",
        }))
    : [];
  const issues = Array.isArray(r.issues)
    ? r.issues.filter((i): i is ReviewIssue => typeof i === "object" && i !== null)
    : [];

  return {
    pass: r.pass === true,
    overallScore: typeof r.overallScore === "number" ? r.overallScore : 0,
    scores,
    issues,
    suggestions: Array.isArray(r.suggestions)
      ? r.suggestions.filter((x): x is string => typeof x === "string")
      : [],
    summary: typeof r.summary === "string" ? r.summary : "",
    thresholdReasoning: typeof r.thresholdReasoning === "string" ? r.thresholdReasoning : "",
    modelUsed: typeof r.modelUsed === "string" ? r.modelUsed : "unknown",
  };
}

export function renderReviewMarkdown(result: ReviewResult, gate: ReviewGate = DEFAULT_GATE): string {
  const verdict = result.pass ? "PASS" : "FAIL";
  const advisory = new Set(gate.advisoryDimensions ?? []);
  const scoreRow = (s: DimensionScore): string => {
    const label = REPORT_LABELS[s.dimension] ?? s.dimension;
    const tag = advisory.has(s.dimension) ? " _(advisory — not gated)_" : "";
    return `| ${label}${tag} | ${s.score.toFixed(1)}/10 | ${s.reasoning} |`;
  };

  const issuesBlock =
    result.issues.length === 0
      ? "_No issues._"
      : result.issues
          .map(
            (i) =>
              `- **${i.severity.toUpperCase()}** (${i.dimension})${i.location ? ` — _${i.location}_` : ""}: ${i.message}\n  - Fix: ${i.suggestion}`,
          )
          .join("\n");

  const suggestionsBlock =
    result.suggestions.length === 0
      ? "_No additional suggestions._"
      : result.suggestions.map((s) => `- ${s}`).join("\n");

  return `## Autoblog AI Review — ${verdict}

**Overall:** ${result.overallScore.toFixed(1)}/10 — ${result.summary}
**Gate:** ${result.thresholdReasoning}
**Model:** \`${result.modelUsed}\`

### Scores
| Dimension | Score | Notes |
| --- | --- | --- |
${result.scores.map(scoreRow).join("\n")}

### Issues
${issuesBlock}

### Suggestions
${suggestionsBlock}
`;
}
