/**
 * AI-powered quality review of a draft blog post.
 *
 * Mirrors the structured-JSON pattern used by `candidates.ts`: the model is
 * asked to emit a JSON object matching `reviewSchema`, we parse it, then
 * compute the pass/fail gate ourselves so the verdict is deterministic and
 * never just trusted from the model.
 */
import type {
  EngineConfig,
  ExistingPostLike,
  GeminiLike,
} from "./types.js";

export const DEFAULT_REVIEW_MODEL = "claude-sonnet-4-6";

export type ReviewDimension = "contentQuality" | "seoMetadata" | "brandVoiceFit";

const ALL_DIMENSIONS: readonly ReviewDimension[] = [
  "contentQuality",
  "seoMetadata",
  "brandVoiceFit",
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
}

export const DEFAULT_GATE: ReviewGate = {
  minOverall: 7.0,
  minPerDimension: 6.0,
  blockOnAnyBlocker: true,
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
  /** Defaults to `claude-sonnet-4-6`. */
  model?: string;
  /** Overrides the default gate (testing / forced-strict mode). */
  gate?: ReviewGate;
}

const reviewSchema = {
  type: "object",
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        properties: {
          dimension: {
            type: "string",
            enum: ["contentQuality", "seoMetadata", "brandVoiceFit"],
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
            enum: ["contentQuality", "seoMetadata", "brandVoiceFit"],
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

function buildPrompt(args: ReviewBlogPostArgs): string {
  const { config, frontmatter, markdown, existingPosts } = args;
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

1. CONTENT QUALITY (contentQuality)
   - Factually plausible for HVAC / appliance / home-services domain. No obvious technical errors.
   - Concrete and actionable: specific steps, numbers, model names — not generic filler.
   - Well structured: clear intro, scannable subheads, sensible conclusion.
   - Body length roughly 600-1500 words for a weekly post.
   - No hallucinated stats, dollar amounts, model numbers, or rebate values.

2. SEO & METADATA (seoMetadata)
   - frontmatter.title present, 40-65 characters, includes a primary keyword.
   - frontmatter.description present, 120-160 characters, includes a keyword variant.
   - frontmatter.slug kebab-case, descriptive, under 60 characters.
   - frontmatter.tags 2-6 items, relevant.
   - frontmatter.category MUST be one of: ${allowedIds}.
   - Body uses logical H2/H3 structure. Service-area mentions feel natural, not stuffed.

3. BRAND VOICE & SITE FIT (brandVoiceFit)
   - Tone: knowledgeable, helpful, plainspoken — like a trusted local contractor.
   - Topic clearly fits this site's category set (above). Off-scope topics fail this dimension.
   - References Sacramento context naturally where relevant (climate, utilities like SMUD, local building styles).
   - No off-brand content (politics, unrelated services, generic national filler).
   - If a CTA mentions the business, it does so naturally — not over-promotional.

Recent published titles for duplication awareness:
${recentTitles}

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
    if (
      dim !== "contentQuality" &&
      dim !== "seoMetadata" &&
      dim !== "brandVoiceFit"
    ) {
      continue;
    }
    byDim.set(dim, {
      dimension: dim,
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
  const overall =
    scores.reduce((sum, s) => sum + s.score, 0) / scores.length;
  const failingDim = scores.find((s) => s.score < gate.minPerDimension);
  const hasBlocker =
    gate.blockOnAnyBlocker && issues.some((i) => i.severity === "blocker");

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

  const response = await args.gemini.models.generateContent({
    model,
    contents: buildPrompt(args),
    config: { responseMimeType: "application/json", responseSchema: reviewSchema },
  });

  const text = response.text;
  if (!text) throw new Error("Empty review response from Gemini");

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
    modelUsed: model,
  };
}

/**
 * Renders a `ReviewResult` as a Markdown summary suitable for posting as a
 * sticky PR comment. Deterministic — used by the CLI.
 */
export function renderReviewMarkdown(result: ReviewResult): string {
  const verdict = result.pass ? "PASS" : "FAIL";
  const scoreRow = (s: DimensionScore): string => {
    const label =
      s.dimension === "contentQuality"
        ? "Content Quality"
        : s.dimension === "seoMetadata"
          ? "SEO & Metadata"
          : "Brand Voice & Fit";
    return `| ${label} | ${s.score.toFixed(1)}/10 | ${s.reasoning} |`;
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
