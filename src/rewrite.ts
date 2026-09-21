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
import { citationGuidance, EMPTY_LINK_POLICY, type LinkPolicy } from "./links.js";
import { writerAccuracyRules } from "./planning.js";
import { hasExactH2, hasFaqHeading, type RubricConstraints } from "./rubric.js";
import type {
  BlogPostFrontmatter,
  ReviewIssue,
  ReviewResult,
} from "./review.js";

export const DEFAULT_REWRITE_MODEL = "grok-4.6";

export interface RewriteBlogPostArgs {
  gemini: GeminiLike;
  config: EngineConfig;
  frontmatter: BlogPostFrontmatter;
  /** Current markdown body without frontmatter. */
  markdown: string;
  /** The failing review whose issues the rewrite should address. */
  reviewFeedback: ReviewResult;
  /** Defaults to `grok-4.6`. */
  model?: string;
  /**
   * Dead-link policy. Without it a rewrite can reintroduce exactly the URL
   * generation just stripped — the reviewer asks for a citation, and the only
   * prompt in the pipeline that never heard of the policy supplies one.
   * Defaults to `EMPTY_LINK_POLICY` (pre-0.12.0 behavior).
   */
  linkPolicy?: LinkPolicy;
  /** Grounding sources; falls back to `frontmatter.citations`. */
  citations?: ReadonlyArray<{ name?: string; url?: string }>;
  /**
   * The site's structural rules. When given, the prompt names the required
   * headings verbatim and forbids a body FAQ, and the revision is rejected
   * (throws) if it drops or re-cases a required heading or writes an FAQ
   * section — the 2026-08-29 promax autofix did both while the CI-side
   * checks only looked at the build.
   */
  rubric?: RubricConstraints;
}

export interface RewriteResult {
  /** Revised markdown body. */
  markdown: string;
  /** Revised frontmatter. Identity fields stay. FAQ answers change only when the review asks. */
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
        faqs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              answer: { type: "string" },
            },
            required: ["question", "answer"],
          },
        },
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

/** Frontmatter is loosely typed; keep only well-formed citation entries. */
function frontmatterCitations(
  frontmatter: BlogPostFrontmatter,
): ReadonlyArray<{ name?: string; url?: string }> | undefined {
  const raw = frontmatter.citations;
  if (!Array.isArray(raw)) return undefined;
  const entries = raw.filter(
    (c): c is { name?: string; url?: string } => typeof c === "object" && c !== null,
  );
  return entries.length > 0 ? entries : undefined;
}

function formatIssue(i: ReviewIssue): string {
  const loc = i.location ? ` [${i.location}]` : "";
  return `- ${i.severity.toUpperCase()} (${i.dimension})${loc}: ${i.message}\n  Fix: ${i.suggestion}`;
}

function buildPrompt(args: RewriteBlogPostArgs): string {
  const { config, frontmatter, markdown, reviewFeedback } = args;
  const policy = args.linkPolicy ?? EMPTY_LINK_POLICY;
  const guidance = citationGuidance(policy);
  // The review that triggered this rewrite frequently asks for a citation.
  // Without the policy in front of it the model reaches for the same retired
  // agency page generation just removed, and the post fails @smoke forever.
  const linkRules = guidance
    ? `\nOutbound links — these are hard requirements:\n${guidance}\n- NEVER reintroduce a URL that was removed from this post. If a claim needs a source and every obvious URL is denied above, state the finding qualitatively and cite the organisation by name without linking.`
    : "";
  const accuracyRules = `\n${writerAccuracyRules(args.citations ?? frontmatterCitations(frontmatter))}`;
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
- Maintain the post's tone and Sacramento-local framing.
- If an issue is about a frontmatter FAQ answer, update that answer in frontmatter.faqs and keep each question string unchanged. Do not add a Frequently Asked Questions section to the markdown body. If no issue mentions an FAQ, return frontmatter.faqs unchanged.
${structureRules(args.rubric)}${linkRules}
${accuracyRules}`;
}

function structureRules(rubric: RubricConstraints | undefined): string {
  if (!rubric) return "";
  const lines: string[] = [];
  if (rubric.requiredHeadings.length > 0) {
    lines.push(
      `- Keep these section headings verbatim, including capitalisation, as H2 lines: ${rubric.requiredHeadings
        .map((h) => `"## ${h}"`)
        .join(", ")}. Never remove, demote or reword them.`,
    );
  }
  if (rubric.faqPolicy === "appended-by-code") {
    lines.push(
      "- Do NOT add a \"Frequently Asked Questions\" (or \"FAQ\") section to the body: the FAQs render from frontmatter. Never remove frontmatter fields you were not asked to change.",
    );
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/** Structural violations a rubric-aware rewrite must not introduce. */
function structuralViolation(markdown: string, rubric: RubricConstraints): string | null {
  if (rubric.faqPolicy === "appended-by-code" && hasFaqHeading(markdown)) {
    return "revision added a Frequently Asked Questions section to the body (FAQs render from frontmatter)";
  }
  const missing = rubric.requiredHeadings.filter((h) => !hasExactH2(markdown, h));
  if (missing.length > 0) {
    return `revision dropped or re-cased required heading(s): ${missing.map((h) => `"## ${h}"`).join(", ")}`;
  }
  return null;
}

interface RawRewriteFrontmatter {
  title?: unknown;
  description?: unknown;
  slug?: unknown;
  category?: unknown;
  tags?: unknown;
  date?: unknown;
  faqs?: unknown;
  [key: string]: unknown;
}

function readFaqEntries(raw: unknown, requireAnswer: boolean): Array<Record<string, unknown>> | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: Array<Record<string, unknown>> = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    if (typeof record.question !== "string" || !record.question.trim()) return null;
    if (record.answer !== undefined && typeof record.answer !== "string") return null;
    if (requireAnswer && (typeof record.answer !== "string" || !record.answer.trim())) return null;
    out.push(record);
  }
  return out;
}

/**
 * Copy revised answers onto the original entries when every question is unchanged.
 * An empty original answer can be filled. Extra keys on the original entry stay.
 * Returns null when the revision drops, reorders, or empties an answer.
 */
function mergeFaqAnswers(original: unknown, revised: unknown): Array<Record<string, unknown>> | null {
  const prev = readFaqEntries(original, false);
  const next = readFaqEntries(revised, true);
  if (!prev || !next || prev.length !== next.length) return null;
  let changed = false;
  for (let i = 0; i < prev.length; i += 1) {
    if (String(prev[i]!.question).trim() !== String(next[i]!.question).trim()) return null;
    const prevRaw = prev[i]!.answer;
    const prevAnswer = typeof prevRaw === "string" ? prevRaw.trim() : "";
    if (prevAnswer !== String(next[i]!.answer).trim()) changed = true;
  }
  if (!changed) return null;
  return prev.map((entry, i) => ({
    ...entry,
    question: String(entry.question).trim(),
    answer: String(next[i]!.answer).trim(),
  }));
}

/** True only when an issue asks to change a frontmatter FAQ answer, not the body. */
function reviewAsksForFaqEdit(review: { issues: ReadonlyArray<{ message: string; suggestion: string; location?: string }> }): boolean {
  return review.issues.some((issue) => {
    const loc = issue.location ?? "";
    const text = `${issue.message}\n${issue.suggestion}`;
    const blob = `${loc}\n${text}`;
    if (!/\bfaqs?\b/i.test(blob)) return false;
    const pointsAtFaq = /\bfaqs?\b/i.test(loc) || /\bfrontmatter\b/i.test(text);
    const asksAnswer = /\banswer\b/i.test(`${loc}\n${text}`);
    return pointsAtFaq && asksAnswer;
  });
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

  const revisedFrontmatter = parsed.frontmatter as RawRewriteFrontmatter;
  const frontmatter = mergeFrontmatter(args.frontmatter, revisedFrontmatter);
  if (reviewAsksForFaqEdit(args.reviewFeedback)) {
    const faqs = mergeFaqAnswers(args.frontmatter.faqs, revisedFrontmatter.faqs);
    if (!faqs) {
      throw new Error(
        "Rewrite rejected: the review asks for a FAQ answer change, but the revised faqs omit the list, change a question, or leave an answer empty",
      );
    }
    frontmatter.faqs = faqs;
  }
  const markdown = parsed.markdown.trim();
  if (args.rubric) {
    const problem = structuralViolation(markdown, args.rubric);
    if (problem) throw new Error(`Rewrite rejected: ${problem}`);
  }
  const changeNotes =
    typeof parsed.changeNotes === "string" && parsed.changeNotes.trim()
      ? parsed.changeNotes.trim()
      : "(no change notes provided)";

  return { frontmatter, markdown, changeNotes, modelUsed: response.model ?? model };
}
