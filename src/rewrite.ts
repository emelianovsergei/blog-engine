/**
 * Revision of a failed-review blog post against the review's findings.
 *
 * Invoked two ways in consumer repos: automatically by the review workflow
 * when the gate fails (autoblog-review.yml auto-fix steps), and manually via
 * the `/autoblog rewrite` slash-command workflow as the escape hatch once
 * auto-fix gives up. One call produces one revision; the revised post goes
 * back through normal review like any other commit.
 *
 * Loop-safety lives in CI, not here: the review workflow counts
 * `[autoblog-autofix]` marker commits on the PR branch and stops at
 * AUTOBLOG_MAX_AUTOFIX attempts (default 2). There is deliberately no
 * `--max-attempts` flag — the cap is only derivable from branch state,
 * which CI owns.
 */
import type { EngineConfig, GeminiLike } from "./types.js";
import type {
  BlogPostFrontmatter,
  ReviewIssue,
  ReviewResult,
} from "./review.js";

export const DEFAULT_REWRITE_MODEL = "claude-sonnet-5";

export interface RewriteBlogPostArgs {
  gemini: GeminiLike;
  config: EngineConfig;
  frontmatter: BlogPostFrontmatter;
  /** Current markdown body without frontmatter. */
  markdown: string;
  /** The failing review whose issues the rewrite should address. */
  reviewFeedback: ReviewResult;
  /** Defaults to `claude-sonnet-5`. */
  model?: string;
}

export interface RewriteResult {
  /** Revised markdown body. */
  markdown: string;
  /** Possibly revised frontmatter (title / description / slug / tags / category). */
  frontmatter: BlogPostFrontmatter;
  /** 1-3 sentences explaining what changed and why. */
  changeNotes: string;
  modelUsed: string;
}

const rewriteSchema = {
  type: "object",
  properties: {
    frontmatter: {
      type: "object",
      properties: {
        title: { type: "string" },
        description: { type: "string" },
        slug: { type: "string" },
        category: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["title"],
    },
    markdown: { type: "string", description: "The full revised markdown body" },
    changeNotes: {
      type: "string",
      description: "1-3 sentences summarizing what was changed and why",
    },
  },
  required: ["frontmatter", "markdown", "changeNotes"],
};

function formatIssue(i: ReviewIssue): string {
  const loc = i.location ? ` [${i.location}]` : "";
  return `- ${i.severity.toUpperCase()} (${i.dimension})${loc}: ${i.message}\n  Fix: ${i.suggestion}`;
}

function buildPrompt(args: RewriteBlogPostArgs): string {
  const { config, frontmatter, markdown, reviewFeedback } = args;
  const categoryLines = config.categories
    .map((c) => `- ${c.id} (${c.label}): ${c.guidance}`)
    .join("\n");
  const allowedIds = config.categories.map((c) => c.id).join(", ");
  const areas = config.serviceAreas.slice(0, 10).join(", ");
  const issuesText =
    reviewFeedback.issues.length > 0
      ? reviewFeedback.issues.map(formatIssue).join("\n")
      : "(no issues listed — apply the suggestions below)";
  const suggestionsText =
    reviewFeedback.suggestions.length > 0
      ? reviewFeedback.suggestions.map((s) => `- ${s}`).join("\n")
      : "(none)";
  const scoresText = reviewFeedback.scores
    .map((s) => `- ${s.dimension}: ${s.score.toFixed(1)}/10 — ${s.reasoning}`)
    .join("\n");

  return `You are the senior editor for ${config.businessName}, a Sacramento-area home services company. The draft blog post below failed AI review. Revise it to address the issues — do NOT rewrite from scratch. Preserve sections, examples, and structure that already work; change only what's necessary to resolve the feedback.

Local service areas: ${areas}.

Allowed topic categories for this site (frontmatter.category MUST be one of: ${allowedIds}):
${categoryLines}

REVIEW VERDICT: ${reviewFeedback.thresholdReasoning}
Overall score: ${reviewFeedback.overallScore.toFixed(1)}/10. Summary: ${reviewFeedback.summary}

DIMENSION SCORES:
${scoresText}

ISSUES TO FIX:
${issuesText}

NON-BLOCKING SUGGESTIONS (apply if they help):
${suggestionsText}

CURRENT FRONTMATTER:
${JSON.stringify(frontmatter, null, 2)}

CURRENT MARKDOWN BODY:
"""
${markdown}
"""

Return JSON conforming to the provided schema with:
- "frontmatter": the full revised frontmatter object (title required; preserve other fields, updating only what the review demanded).
- "markdown": the full revised markdown body (no frontmatter fences).
- "changeNotes": 1-3 sentences explaining what you changed and why, referencing the specific issues addressed.

Constraints:
- Do NOT change the post's topic or category unless an issue explicitly demands it.
- Keep the same approximate length (within +/- 25%).
- Maintain the post's tone and Sacramento-local framing.`;
}

interface RawRewriteFrontmatter {
  title?: unknown;
  description?: unknown;
  slug?: unknown;
  category?: unknown;
  tags?: unknown;
  date?: unknown;
  [key: string]: unknown;
}
interface RawRewrite {
  frontmatter?: unknown;
  markdown?: unknown;
  changeNotes?: unknown;
}

function mergeFrontmatter(
  original: BlogPostFrontmatter,
  revised: RawRewriteFrontmatter,
): BlogPostFrontmatter {
  const out: BlogPostFrontmatter = { ...original };
  if (typeof revised.title === "string" && revised.title.trim()) {
    out.title = revised.title.trim();
  }
  if (typeof revised.description === "string") {
    out.description = revised.description.trim();
  }
  if (typeof revised.slug === "string" && revised.slug.trim()) {
    out.slug = revised.slug.trim();
  }
  if (typeof revised.category === "string" && revised.category.trim()) {
    out.category = revised.category.trim();
  }
  if (Array.isArray(revised.tags)) {
    out.tags = revised.tags.filter((t): t is string => typeof t === "string");
  }
  return out;
}

/**
 * Asks Gemini to revise the post to address review feedback. Throws on empty
 * response, invalid JSON, or missing required output fields — the workflow
 * surfaces the error and the user decides whether to retry.
 */
export async function rewriteBlogPost(args: RewriteBlogPostArgs): Promise<RewriteResult> {
  const model = args.model ?? DEFAULT_REWRITE_MODEL;

  const response = await args.gemini.models.generateContent({
    model,
    contents: buildPrompt(args),
    config: { responseMimeType: "application/json", responseSchema: rewriteSchema },
  });

  const text = response.text;
  if (!text) throw new Error("Empty rewrite response from Gemini");

  let parsed: RawRewrite;
  try {
    parsed = JSON.parse(text) as RawRewrite;
  } catch (error) {
    throw new Error(`Rewrite response was not valid JSON: ${(error as Error).message}`);
  }

  if (
    !parsed.frontmatter ||
    typeof parsed.frontmatter !== "object" ||
    typeof parsed.markdown !== "string" ||
    parsed.markdown.trim().length === 0
  ) {
    throw new Error("Rewrite response missing required 'frontmatter' or 'markdown' fields");
  }

  const frontmatter = mergeFrontmatter(
    args.frontmatter,
    parsed.frontmatter as RawRewriteFrontmatter,
  );
  const markdown = parsed.markdown.trim();
  const changeNotes =
    typeof parsed.changeNotes === "string" && parsed.changeNotes.trim()
      ? parsed.changeNotes.trim()
      : "(no change notes provided)";

  return { frontmatter, markdown, changeNotes, modelUsed: model };
}
