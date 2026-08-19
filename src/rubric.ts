/**
 * The single source of truth for what a good post is.
 *
 * Writer, planner, reviewer and the deterministic checker used to carry their
 * own hand-written copies of these rules, which drifted badly: the writer was
 * told "use only ## headings" while the reviewer rewarded H2/H3 nesting, and
 * told "do NOT write an FAQ section" while the reviewer graded FAQ presence.
 * A post was routinely marked down for rules it had never been shown — 6.7 on
 * one site versus 8.2 on the other, whose prompt happened to include two of
 * the missing rules.
 *
 * So the rules live here ONCE, as data. Each rule declares which audiences see
 * it, an imperative form (for the writer/planner), an evaluative form (for the
 * reviewer), and optionally a deterministic check. Adding a rule updates every
 * surface in one edit; a contradiction between two surfaces is unrepresentable.
 */
import type { ReviewDimension } from "./review.js";

export interface RubricConstraints {
  minWords: number;
  maxWords: number;
  titleMinChars: number;
  titleMaxChars: number;
  descriptionMinChars: number;
  descriptionMaxChars: number;
  slugMaxChars: number;
  minTags: number;
  maxTags: number;
  /** `h2-only` sites append no H3; the reviewer must not ask for nesting. */
  headingPolicy: "h2-only" | "h2-h3";
  /** `appended-by-code` means the model must NOT write an FAQ into the body. */
  faqPolicy: "appended-by-code" | "written-by-model";
  requiredHeadings: readonly string[];
  bannedWords: readonly string[];
  bannedOpeners: readonly string[];
  /** Max em-dashes per 150 words before it reads as machine-written. */
  maxEmDashesPer150Words: number;
  businessName?: string;
  ctaTokens?: readonly string[];
}

export const DEFAULT_RUBRIC_CONSTRAINTS: RubricConstraints = {
  minWords: 800,
  maxWords: 1100,
  titleMinChars: 40,
  titleMaxChars: 65,
  descriptionMinChars: 120,
  descriptionMaxChars: 160,
  slugMaxChars: 60,
  minTags: 2,
  maxTags: 6,
  headingPolicy: "h2-only",
  faqPolicy: "appended-by-code",
  requiredHeadings: [],
  bannedWords: ["delve"],
  bannedOpeners: [
    "In today's world",
    "In today's fast-paced",
    "When it comes to",
    "It's important to note",
    "In conclusion",
    "Whether you're",
  ],
  maxEmDashesPer150Words: 1,
};

export type RubricAudience = "planner" | "writer" | "reviewer";

export interface RubricRule {
  id: string;
  dimension: ReviewDimension;
  audience: readonly RubricAudience[];
  /** Imperative — what the writer/planner must do. */
  instruction: (c: RubricConstraints) => string;
  /** Evaluative — what the reviewer grades. Defaults to `instruction`. */
  criterion?: (c: RubricConstraints) => string;
  /** Deterministic check on the body; return a message when violated. */
  check?: (body: string, c: RubricConstraints) => string | null;
}

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Body paragraphs, ignoring headings, lists and code fences. */
function paragraphs(body: string): string[] {
  return body
    .replace(/```[\s\S]*?```/g, "")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && !p.startsWith("#") && !/^[-*>|]/.test(p));
}

export const RUBRIC_RULES: readonly RubricRule[] = [
  // ---- contentQuality -----------------------------------------------------
  {
    id: "answer-first",
    dimension: "contentQuality",
    audience: ["writer", "reviewer"],
    instruction: () =>
      "Answer first. The opening sentence — and the first sentence under every ## heading — must directly answer the question that heading poses. No warm-up, no throat-clearing.",
    criterion: () =>
      "GEO (answer-first): the opening sentence, and the first sentence under each H2, directly answer the question rather than warming up.",
  },
  {
    id: "cited-statistic",
    dimension: "contentQuality",
    audience: ["writer", "reviewer"],
    instruction: () =>
      "Include at least one cited statistic or concrete authoritative data point within the first 200 words, attributed to a source from your citation list. State the number, not just the link.",
    criterion: () =>
      "Rewards at least one cited statistic from an authoritative source early on — a bare link with no figure does not count.",
  },
  {
    id: "concrete-not-filler",
    dimension: "contentQuality",
    audience: ["writer", "reviewer"],
    instruction: () =>
      "Be concrete and actionable: specific steps, temperatures, timeframes, real product lines. Naming a real product line (e.g. Trane XR15) is fine; inventing a model number, price, rebate amount or efficiency figure is not.",
    criterion: () =>
      "Concrete and actionable — specific steps, numbers, real product lines rather than generic filler. No hallucinated stats, dollar amounts, model numbers or rebate values. Naming a real product line is correct behaviour, not a fault.",
  },
  {
    id: "faq-consistency",
    dimension: "contentQuality",
    audience: ["writer", "reviewer"],
    instruction: () =>
      "Every number, price, range and spec in the body must match the FAQ answers exactly. Never contradict them.",
    criterion: () =>
      "Any numbers/prices in the FAQ match the body — no contradictions in either direction.",
  },
  {
    id: "word-count",
    dimension: "contentQuality",
    audience: ["writer", "reviewer"],
    instruction: (c) =>
      `Write between ${c.minWords} and ${c.maxWords} words. Do not exceed ${c.maxWords}.`,
    criterion: (c) => `Body length is roughly ${c.minWords}-${c.maxWords} words.`,
    check: (body, c) => {
      const n = countWords(body);
      if (n < c.minWords) return `body is ${n} words, below the ${c.minWords}-word minimum`;
      if (n > c.maxWords) return `body is ${n} words, above the ${c.maxWords}-word maximum`;
      return null;
    },
  },
  // ---- seoMetadata --------------------------------------------------------
  {
    id: "title-length",
    dimension: "seoMetadata",
    audience: ["planner", "reviewer"],
    instruction: (c) =>
      `title must be ${c.titleMinChars}-${c.titleMaxChars} characters — long enough to be specific, short enough not to truncate in search results — and include the primary keyword.`,
    criterion: (c) =>
      `frontmatter.title present, ${c.titleMinChars}-${c.titleMaxChars} characters, includes a primary keyword.`,
  },
  {
    id: "description-length",
    dimension: "seoMetadata",
    audience: ["planner", "reviewer"],
    instruction: (c) =>
      `description must be a COMPLETE sentence of ${c.descriptionMinChars}-${c.descriptionMaxChars} characters including a keyword variant — never cut off mid-phrase.`,
    criterion: (c) =>
      `frontmatter.description present, ${c.descriptionMinChars}-${c.descriptionMaxChars} characters, includes a keyword variant.`,
  },
  {
    id: "slug-shape",
    dimension: "seoMetadata",
    audience: ["planner", "reviewer"],
    instruction: (c) =>
      `slug must be kebab-case, descriptive, unique, filesystem-safe and under ${c.slugMaxChars} characters.`,
    criterion: (c) => `frontmatter.slug kebab-case, descriptive, under ${c.slugMaxChars} characters.`,
  },
  {
    id: "tags",
    dimension: "seoMetadata",
    audience: ["planner", "reviewer"],
    instruction: (c) => `tags: ${c.minTags}-${c.maxTags} relevant items.`,
    criterion: (c) => `frontmatter.tags ${c.minTags}-${c.maxTags} items, relevant.`,
  },
  {
    id: "heading-structure",
    dimension: "seoMetadata",
    audience: ["writer", "reviewer"],
    instruction: (c) =>
      c.headingPolicy === "h2-only"
        ? "Use only ## headings. Do not use ### or deeper."
        : "Use ## headings, with ### only where a section genuinely needs sub-structure.",
    criterion: (c) =>
      c.headingPolicy === "h2-only"
        ? "Body uses a logical, scannable ## structure. This site renders H2 only — do NOT penalise the absence of H3."
        : "Body uses logical H2/H3 structure.",
    check: (body, c) =>
      c.headingPolicy === "h2-only" && /^###\s/m.test(body)
        ? "body uses ### headings but this site is H2-only"
        : null,
  },
  {
    id: "keyword-placement",
    dimension: "seoMetadata",
    audience: ["writer", "reviewer"],
    instruction: () =>
      "Work the target keyword into the title and the first ~100 words as natural language. Rephrase it to read like a sentence — never paste the raw phrase in verbatim, and never append it to an FAQ answer. Keyword stuffing is a ranking penalty.",
    criterion: () =>
      "Keyword targeting (GEO): the target keyword is front-loaded in the title and appears naturally in the description and first ~100 words. Penalise stuffing — raw keyword phrases jammed into sentences or FAQ answers.",
  },
  {
    id: "service-areas",
    dimension: "seoMetadata",
    audience: ["writer", "reviewer"],
    instruction: () =>
      "Name at most two service-area cities in the body, and only where they carry real meaning. Listing the whole coverage area reads as stuffing. If you need a general reference, say \"the Sacramento area\".",
    criterion: () =>
      "Service-area mentions feel natural, not stuffed — a lede that lists every city fails this.",
  },
  {
    id: "faq-authorship",
    dimension: "seoMetadata",
    audience: ["writer", "reviewer"],
    instruction: (c) =>
      c.faqPolicy === "appended-by-code"
        ? "Do NOT write a \"Frequently Asked Questions\" section — it is appended automatically after your body from frontmatter."
        : "Include a genuine FAQ section answering real homeowner questions.",
    criterion: (c) =>
      c.faqPolicy === "appended-by-code"
        ? "FAQ for AI search: grade frontmatter.faqs — the visible FAQ section is appended by the build, so its absence from the markdown body is CORRECT and must not be penalised."
        : "Rewards a genuine FAQ section answering real questions and matching frontmatter.faqs.",
    check: (body, c) =>
      c.faqPolicy === "appended-by-code" && /^##+\s*frequently asked questions/im.test(body)
        ? "body contains an FAQ section, but FAQs are appended from frontmatter"
        : null,
  },
  // ---- brandVoiceFit ------------------------------------------------------
  {
    id: "local-specificity",
    dimension: "brandVoiceFit",
    audience: ["writer", "reviewer"],
    instruction: () =>
      "Reference genuine local context where it matters — SMUD rate schedules and peak windows, the Delta breeze, valley inversion, 100°+ streaks, 1970s tract construction. One real local detail beats five city names.",
    criterion: () =>
      "References Sacramento context naturally where relevant (climate, utilities like SMUD, local building styles).",
  },
  {
    id: "trusted-contractor-tone",
    dimension: "brandVoiceFit",
    audience: ["writer", "reviewer"],
    instruction: () =>
      "Write like a knowledgeable local contractor explaining something to a homeowner: plainspoken, helpful, no hype, no national-SEO filler.",
    criterion: () =>
      "Tone is knowledgeable, helpful, plainspoken — like a trusted local contractor. No off-brand or generic national filler. Any CTA mentions the business naturally, not over-promotionally.",
  },
  {
    id: "required-headings",
    dimension: "brandVoiceFit",
    audience: ["writer"],
    instruction: (c) =>
      c.requiredHeadings.length > 0
        ? `Include these sections verbatim: ${c.requiredHeadings.map((h) => `"## ${h}"`).join(", ")}.`
        : "",
    check: (body, c) => {
      const missing = c.requiredHeadings.filter((h) => !body.includes(`## ${h}`));
      return missing.length > 0 ? `missing required heading(s): ${missing.join(", ")}` : null;
    },
  },
];

function renderRules(
  audience: RubricAudience,
  c: RubricConstraints,
  rules: readonly RubricRule[],
): string {
  return rules
    .filter((r) => r.audience.includes(audience))
    .map((r) => (audience === "reviewer" ? (r.criterion ?? r.instruction)(c) : r.instruction(c)))
    .filter((line) => line.trim().length > 0)
    .map((line) => `- ${line}`)
    .join("\n");
}

/** Rules the article writer must follow, as an imperative block. */
export function writerRubricRules(
  c: RubricConstraints = DEFAULT_RUBRIC_CONSTRAINTS,
  rules: readonly RubricRule[] = RUBRIC_RULES,
): string {
  return `Article rules (the reviewer grades against exactly these):\n${renderRules("writer", c, rules)}`;
}

/** Rules the planner must follow when producing frontmatter. */
export function plannerRubricRules(
  c: RubricConstraints = DEFAULT_RUBRIC_CONSTRAINTS,
  rules: readonly RubricRule[] = RUBRIC_RULES,
): string {
  return renderRules("planner", c, rules);
}

/** The reviewer's rubric, grouped by dimension. */
export function reviewerRubric(
  c: RubricConstraints = DEFAULT_RUBRIC_CONSTRAINTS,
  opts: { dimensionLabels: Record<string, string>; rules?: readonly RubricRule[] },
): string {
  const rules = opts.rules ?? RUBRIC_RULES;
  const byDimension = new Map<ReviewDimension, string[]>();
  for (const rule of rules) {
    if (!rule.audience.includes("reviewer")) continue;
    const line = (rule.criterion ?? rule.instruction)(c);
    if (!line.trim()) continue;
    const bucket = byDimension.get(rule.dimension) ?? [];
    bucket.push(`   - ${line}`);
    byDimension.set(rule.dimension, bucket);
  }
  return [...byDimension]
    .map(([dimension, lines], i) => {
      const label = opts.dimensionLabels[dimension] ?? dimension;
      return `${i + 1}. ${label} (${dimension})\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

export interface RubricViolation {
  rule: string;
  message: string;
}

/**
 * Deterministic checks the writer's own retry loop can act on, so a mechanical
 * miss costs a local regeneration rather than a full review round-trip.
 */
export function checkArticleBody(
  body: string,
  c: RubricConstraints = DEFAULT_RUBRIC_CONSTRAINTS,
  rules: readonly RubricRule[] = RUBRIC_RULES,
): RubricViolation[] {
  const violations: RubricViolation[] = [];
  for (const rule of rules) {
    const message = rule.check?.(body, c);
    if (message) violations.push({ rule: rule.id, message });
  }

  for (const word of c.bannedWords) {
    if (new RegExp(`\\b${word}\\b`, "i").test(body)) {
      violations.push({ rule: "banned-word", message: `body uses the banned word "${word}"` });
    }
  }

  const paras = paragraphs(body);
  for (const opener of c.bannedOpeners) {
    if (paras.some((p) => p.toLowerCase().startsWith(opener.toLowerCase()))) {
      violations.push({
        rule: "banned-opener",
        message: `a paragraph opens with the stock phrase "${opener}"`,
      });
    }
  }

  const words = countWords(body);
  const emDashes = (body.match(/—/g) ?? []).length;
  const allowed = Math.ceil((words / 150) * c.maxEmDashesPer150Words);
  if (words > 0 && emDashes > allowed) {
    violations.push({
      rule: "em-dash-density",
      message: `${emDashes} em-dashes in ${words} words reads as machine-written (max ~${allowed})`,
    });
  }

  // Uniform paragraph length is the most reliable tell of generated prose.
  if (paras.length >= 5) {
    const lengths = paras.map(countWords);
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    const variance = lengths.reduce((a, n) => a + (n - mean) ** 2, 0) / lengths.length;
    if (mean > 0 && Math.sqrt(variance) / mean < 0.25) {
      violations.push({
        rule: "paragraph-rhythm",
        message: "every paragraph is nearly the same length — vary the rhythm",
      });
    }
  }

  return violations;
}
