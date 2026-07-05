/**
 * YAML frontmatter reader/writer for the CLI tools, backed by the `yaml`
 * package.
 *
 * This replaced a hand-rolled "minimal subset" parser that silently mangled
 * nested structures: a `faqs:` array of {question, answer} mappings parsed as
 * a single string, which fed the reviewer corrupted frontmatter (the #227
 * "only one FAQ" false blocker) and made the rewriter serialize
 * `[object Object]` entries that crashed the consumer site's prerender.
 * Frontmatter must round-trip whatever YAML the consumer sites' own loaders
 * accept, so a real parser is a correctness requirement, not a convenience.
 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { BlogPostFrontmatter } from "../review.js";

const FENCE = /^---\s*\r?\n/;

export interface ParsedDoc {
  frontmatter: BlogPostFrontmatter;
  body: string;
}

export function parseDocument(source: string): ParsedDoc {
  if (!FENCE.test(source)) {
    throw new Error("Document is missing a leading `---` frontmatter fence");
  }
  const afterFirst = source.replace(FENCE, "");
  const closeIdx = afterFirst.search(/\r?\n---\s*(\r?\n|$)/);
  if (closeIdx === -1) {
    throw new Error("Document is missing the closing `---` frontmatter fence");
  }
  const yaml = afterFirst.slice(0, closeIdx);
  const body = afterFirst
    .slice(closeIdx)
    .replace(/^\r?\n---\s*(\r?\n)?/, "")
    .replace(/^\r?\n/, "");

  const parsed: unknown = parseYaml(yaml);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Frontmatter did not parse to a YAML mapping");
  }
  const frontmatter = parsed as BlogPostFrontmatter;
  if (typeof frontmatter.title !== "string") {
    frontmatter.title = String(frontmatter.title ?? "");
  }
  // An empty `tags:` block is valid YAML null; callers iterate tags, so keep
  // the previous parser's empty-list tolerance.
  if (frontmatter.tags === null) frontmatter.tags = [];
  return { frontmatter, body };
}

const PREFERRED_ORDER = [
  "title",
  "description",
  "slug",
  "date",
  "category",
  "tags",
] as const;

export function serializeDocument(frontmatter: BlogPostFrontmatter, body: string): string {
  // Stable key order: the preferred keys first, then everything else in the
  // order the original document had them.
  const ordered: Record<string, unknown> = {};
  for (const k of PREFERRED_ORDER) {
    if (k in frontmatter && frontmatter[k] !== undefined) ordered[k] = frontmatter[k];
  }
  for (const [k, v] of Object.entries(frontmatter)) {
    if (!(k in ordered) && v !== undefined) ordered[k] = v;
  }

  const yaml = stringifyYaml(ordered, {
    lineWidth: 80,
    // Match the style the consumer sites' generators emit for long prose
    // fields (`>-` folded blocks) so diffs stay readable.
    blockQuote: "folded",
  });

  return `---\n${yaml}---\n\n${body.replace(/^\r?\n+/, "")}`;
}
