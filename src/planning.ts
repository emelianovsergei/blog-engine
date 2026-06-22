/**
 * Shared generation-time guardrails that keep an auto-generated post on a
 * single, accurately-targeted topic.
 *
 * These exist because the failure mode in production was never weak prose — it
 * was a *brief* that contradicted itself: the keyword-research stage ranks a
 * `primaryKeyword` purely by search demand, so it can hand the planner a phrase
 * about a different subject than the locked seed topic (e.g. a "whole-house fan
 * vs attic fan" post handed "best thermostat setting for summer"). The planner
 * then front-loads the off-topic keyword and the writer dutifully produces a
 * two-topic article — which fails the SEO gate and dilutes ranking.
 *
 * Two layers defend against that:
 *   1. Prompt fragments (`topicLockPlannerRules`, `writerAccuracyRules`) that
 *      tell the models to stay on one topic and to ground every figure.
 *   2. A deterministic guard (`assertTopicAligned`) that rejects a plan whose
 *      targetKeyword shares no content word with its title — catching the
 *      mismatch cheaply, before a single token is written or built.
 */

/**
 * Words that carry no topical signal: generic SEO/query filler plus location
 * terms (every local title contains "Sacramento", so a shared location word
 * must not mask a subject mismatch). Kept lowercase.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  // articles / conjunctions / prepositions
  "the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "at", "by",
  "with", "vs", "versus", "your", "you", "is", "are", "be", "do", "does",
  // generic query / SEO filler
  "best", "top", "how", "what", "when", "why", "which", "guide", "tips",
  "tip", "complete", "ultimate", "need", "needs", "should", "setting",
  "settings", "homeowner", "homeowners", "home", "homes", "house", "houses",
  // location terms (local titles always include these)
  "sacramento", "ca", "california", "area", "areas", "near", "me", "local",
]);

/** Lowercase, split on non-alphanumerics, drop stopwords + naive plural 's'. */
function contentTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2) continue;
    // Naive singularization so "fans" matches "fan", "homes" matches "home".
    const token = raw.length > 3 && raw.endsWith("s") ? raw.slice(0, -1) : raw;
    if (STOPWORDS.has(raw) || STOPWORDS.has(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

/**
 * Return a human-readable problem string when `targetKeyword` is topically
 * disconnected from `title` (zero shared content words), or `null` when they
 * are aligned. Non-throwing companion to {@link assertTopicAligned}.
 *
 * Deliberately conservative: it only flags a *total* mismatch, the real-world
 * failure mode, so it won't false-positive on partial overlaps.
 */
export function topicAlignmentIssue(
  targetKeyword: string | undefined,
  title: string | undefined,
): string | null {
  if (!targetKeyword || !targetKeyword.trim()) return "targetKeyword is empty";
  if (!title || !title.trim()) return "title is empty";

  const keywordTokens = contentTokens(targetKeyword);
  // A keyword made entirely of stopwords (e.g. "best tips for your home") tells
  // us nothing — treat as a mismatch so the planner re-derives a real keyword.
  if (keywordTokens.size === 0) {
    return `targetKeyword "${targetKeyword}" has no substantive terms`;
  }

  const titleTokens = contentTokens(title);
  for (const token of keywordTokens) {
    if (titleTokens.has(token)) return null;
  }

  return (
    `targetKeyword "${targetKeyword}" shares no topic word with the title ` +
    `"${title}" — the post would target a keyword it is not actually about. ` +
    `Set targetKeyword to a phrase describing the title's topic.`
  );
}

/**
 * Throw when `targetKeyword` is topically disconnected from `title`. Call from a
 * plan-validation step so a mismatch triggers a regenerate instead of shipping
 * a split-focus post.
 */
export function assertTopicAligned(
  targetKeyword: string | undefined,
  title: string | undefined,
): void {
  const issue = topicAlignmentIssue(targetKeyword, title);
  if (issue) throw new Error(`Invalid blog plan: ${issue}`);
}

/**
 * Planner-prompt rules that lock the post to one subject and bind the
 * targetKeyword to that subject. Splice into the planning prompt's rule list.
 */
export function topicLockPlannerRules(): string {
  return [
    "- SINGLE TOPIC: the post covers exactly one subject. Do not introduce a second, adjacent subject (e.g. a post about whole-house vs attic fans must NOT also cover thermostat settings or AC sizing). One post, one searchable question.",
    "- Keyword research informs PHRASING WITHIN the locked topic only. If the provided primaryKeyword, secondary keywords, or searched questions are about a DIFFERENT subject than the topic, DISCARD them — never expand the post's scope to chase demand.",
    "- targetKeyword MUST describe the post's actual topic and share its head term with the title (a reader seeing the title and the targetKeyword must recognize them as the same subject). If the researched primaryKeyword does not match the title's topic, derive targetKeyword from the title instead of using it.",
    "- Every FAQ must be about the post's single topic. Drop any researched question that belongs to a different subject.",
  ].join("\n");
}

/**
 * Writer-prompt rules that prevent fabricated figures and keep the body on one
 * topic. Pass the plan's citations so the writer can ground (and link) claims.
 */
export function writerAccuracyRules(
  citations?: ReadonlyArray<{ name?: string; url?: string }>,
): string {
  const sourceList =
    citations && citations.length > 0
      ? citations
          .map((c) => `  - ${c.name ?? "source"}: ${c.url ?? ""}`.trimEnd())
          .join("\n")
      : "  (none provided)";

  return [
    "Accuracy (these are hard requirements — violating them fails review):",
    "- Do NOT invent statistics, percentages, dollar amounts, rebate values, or efficiency figures. A specific number is allowed only if it is uncontroversial common knowledge OR it is backed by one of the cited sources below.",
    "- NEVER attribute a figure to an agency or brand (DOE, ENERGY STAR, EPA, SMUD, PG&E, ASHRAE, manufacturers) unless that exact source is in the citation list below. If you cannot ground a number, state it qualitatively (e.g. \"a few percent\", \"varies by program — check the utility's current rebate page\") rather than fabricating precision.",
    "- Stay tightly on the ONE locked topic. Do not pivot into adjacent equipment, settings, or services even if they feel related.",
    "Citable sources for this article (link these inline when you reference their facts):",
    sourceList,
  ].join("\n");
}
