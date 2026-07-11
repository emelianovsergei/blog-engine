/**
 * LLM-driven ingest core for the `brain/` developer wiki (Karpathy "LLM wiki"
 * pattern — slice 1). Given the structural facts of a TypeScript source module,
 * an injected `GeminiLike` client writes a rich, cross-linked developer page.
 *
 * The module is deliberately pure and injectable: no direct filesystem or
 * network access lives on the generation path, so the whole thing is unit-tested
 * with a fake client (see `src/__tests__/wiki-ingest.test.ts`). The thin
 * orchestrator `scripts/wiki-ingest.ts` supplies the client, walks `src/`, and
 * owns fs / index.md / log.md.
 *
 * Two rendering modes share one renderer:
 *   - LLM mode:    `generateModuleFields` → prose summary + per-export
 *                  explanations + validated `[[wikilinks]]`.
 *   - Fallback:    `fieldsFromFacts` → deterministic fields from the file JSDoc
 *                  and export docs (used offline / when no API key is set).
 *
 * Incrementality: `sourceHash(code)` is stored in each page's frontmatter as
 * `source_hash`. The orchestrator skips regeneration (and any LLM call) when the
 * hash is unchanged, so a no-op ingest costs nothing and produces no diff.
 */
import { createHash } from "node:crypto";
import type { GeminiLike } from "../types.js";

/** Short, stable content hash of a source file. */
export function sourceHash(code: string): string {
  return createHash("sha256").update(code).digest("hex").slice(0, 16);
}

/** A single exported symbol extracted from a module. */
export interface ExportFact {
  name: string;
  /** function | const | class | type | interface | async function */
  kind: string;
  /** The `export ...` line, trimmed — gives the model the signature. */
  signature: string;
  /** Preceding JSDoc / `//` comment, flattened to one line, if any. */
  jsdoc?: string;
}

/** Structural facts about one source module — the LLM's grounding input. */
export interface ModuleFacts {
  /** Page id, e.g. "orchestrator" or "cli-shared". */
  pageId: string;
  /** Repo-relative source path, e.g. "src/orchestrator.ts". */
  relPath: string;
  /** Absolute path for the `file://` source link. */
  absPath: string;
  /** Flattened file-level JSDoc. */
  fileDoc: string;
  exports: ExportFact[];
  /** Local sibling modules imported (their page ids), for cross-link seeding. */
  imports: string[];
}

/** The fields that populate a module page (from the LLM or the fallback). */
export interface ModulePageFields {
  title: string;
  description: string;
  tags: string[];
  /** 2-4 sentence prose overview. */
  summary: string;
  exports: Array<{ name: string; explanation: string }>;
  /** Validated wiki targets, e.g. ["modules/client", "concepts/quality-gates"]. */
  relatedLinks: string[];
}

/** Derive a collision-free page id from a repo-relative source path. */
export function pageIdFromRelPath(relPath: string): string {
  const norm = relPath.replace(/\\/g, "/").replace(/^src\//, "").replace(/\.ts$/, "");
  // "orchestrator" stays; "cli/shared" → "cli-shared" (avoids colliding with a
  // top-level module of the same basename, e.g. review.ts vs cli/review.ts).
  return norm.replace(/\//g, "-");
}

function titleCase(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * Extract structural facts from a TypeScript module. Regex-based and naive by
 * design — it only supplies grounding to the model, which does the prose. This
 * is the extraction logic that previously lived inline in wiki-ingest.ts.
 */
export function extractModuleFacts(code: string, relPath: string, absPath: string): ModuleFacts {
  const pageId = pageIdFromRelPath(relPath);

  let fileDoc = "";
  const fileDocMatch = code.match(/^\/\*\*([\s\S]*?)\*\//);
  if (fileDocMatch && fileDocMatch[1]) {
    fileDoc = fileDocMatch[1]
      .split("\n")
      .map((l) => l.replace(/^\s*\*\s?/, "").trim())
      .filter(Boolean)
      .join(" ");
  }

  const exports: ExportFact[] = [];
  const lines = code.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || "";
    const match = line.match(
      /^\s*export\s+(async\s+function|function|const|class|type|interface)\s+(\w+)/,
    );
    if (!match) continue;
    const kind = match[1]!.trim();
    const name = match[2]!.trim();

    // Scan upward for a preceding JSDoc / // comment block.
    const jsdocLines: string[] = [];
    let inJSDoc = false;
    for (let j = i - 1; j >= 0; j -= 1) {
      const prev = lines[j]?.trim();
      if (prev === undefined) break;
      if (prev === "") continue;
      if (prev.endsWith("*/")) inJSDoc = true;
      if (inJSDoc) jsdocLines.unshift(prev);
      if (prev.startsWith("/**")) break;
      if (!inJSDoc && !prev.startsWith("//")) break;
    }
    const jsdoc =
      jsdocLines.length > 0
        ? jsdocLines
            .map((l) => l.replace(/\/\*\*|\*\/|^\*\s?|^\/\/\s?/g, "").trim())
            .filter(Boolean)
            .join(" ")
        : undefined;

    exports.push({ name, kind, signature: line.trim(), ...(jsdoc ? { jsdoc } : {}) });
  }

  // Local sibling imports → their page ids (seeds cross-links). Matches
  // `from "./x.js"` / `from "../cli/y.js"` and normalises to a page id.
  const imports = new Set<string>();
  const importRe = /from\s+["'](\.[^"']+)["']/g;
  let im: RegExpExecArray | null;
  while ((im = importRe.exec(code)) !== null) {
    const spec = im[1]!.replace(/\.js$/, "").replace(/\.\//g, "").replace(/^\.\.\//, "");
    const id = spec.replace(/\//g, "-");
    if (id && id !== pageId) imports.add(id);
  }

  return { pageId, relPath, absPath, fileDoc, exports, imports: [...imports] };
}

/** JSON schema for the module-page fields, constrained to valid link targets. */
export function buildModulePageSchema(validTargets: string[]) {
  return {
    type: "object",
    properties: {
      title: { type: "string", description: "Short Title Case name of the module" },
      description: { type: "string", description: "One-sentence summary of what the module does" },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "3-5 short lowercase topic tags",
      },
      summary: {
        type: "string",
        description: "2-4 sentence prose overview: what it does and its role in the pipeline",
      },
      exports: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            explanation: {
              type: "string",
              description: "1-2 sentences grounded ONLY in the provided signature/JSDoc",
            },
          },
          required: ["name", "explanation"],
        },
      },
      relatedLinks: {
        type: "array",
        items: validTargets.length > 0 ? { type: "string", enum: validTargets } : { type: "string" },
        description: "Genuinely related wiki pages, chosen ONLY from the allowed targets",
      },
    },
    required: ["title", "description", "tags", "summary", "exports", "relatedLinks"],
  };
}

/** Build the grounding prompt for one module. */
export function buildModulePrompt(facts: ModuleFacts, validTargets: string[]): string {
  const exportsBlock =
    facts.exports.length > 0
      ? facts.exports
          .map(
            (e) =>
              `- ${e.name} (${e.kind})\n  signature: ${e.signature}${e.jsdoc ? `\n  jsdoc: ${e.jsdoc}` : ""}`,
          )
          .join("\n")
      : "(no exported symbols)";

  return [
    "You are documenting one TypeScript module of `blog-engine` — a library that",
    "automatically selects weekly HVAC blog topics (using seasonal, weather, and",
    "search-demand signals), reviews drafted posts against a quality rubric, and",
    "rewrites them. You are writing a page for a developer wiki that AI coding",
    "agents consult before changing the code, so be accurate and concrete.",
    "",
    "Ground every statement ONLY in the facts below. Do NOT invent behavior,",
    "parameters, or return values that are not evidenced by the signatures/JSDoc.",
    "",
    `SOURCE FILE: ${facts.relPath}`,
    "",
    `FILE-LEVEL DOC:\n${facts.fileDoc || "(none)"}`,
    "",
    `EXPORTS:\n${exportsBlock}`,
    "",
    `LOCAL IMPORTS (page ids): ${facts.imports.length ? facts.imports.join(", ") : "(none)"}`,
    "",
    "For `relatedLinks`, choose ONLY from this allowed list of wiki targets, and",
    "only the ones genuinely related (typically the modules this file imports and",
    "the concepts it implements). Omit unrelated ones; an empty list is fine.",
    `ALLOWED TARGETS: ${validTargets.join(", ") || "(none)"}`,
    "",
    "Return a JSON object with: title, description, tags[], summary,",
    "exports[] (one {name, explanation} per exported symbol above), relatedLinks[].",
  ].join("\n");
}

/** Keep only links that exist, drop self-links, dedupe, cap. */
export function validateLinks(links: unknown, validTargets: string[], selfId: string): string[] {
  if (!Array.isArray(links)) return [];
  const allowed = new Set(validTargets);
  const self = `modules/${selfId}`;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of links) {
    if (typeof raw !== "string") continue;
    const link = raw.trim().replace(/^\[\[|\]\]$/g, "").split("|")[0]!.trim();
    if (!allowed.has(link) || link === self || seen.has(link)) continue;
    seen.add(link);
    out.push(link);
    if (out.length >= 8) break;
  }
  return out;
}

/** Normalise a raw LLM JSON payload into typed, link-validated fields. */
export function normalizeFields(
  parsed: unknown,
  facts: ModuleFacts,
  validTargets: string[],
): ModulePageFields {
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const asStr = (v: unknown, fallback = ""): string =>
    typeof v === "string" && v.trim() ? v.trim() : fallback;

  const tags = Array.isArray(obj.tags)
    ? obj.tags.filter((t): t is string => typeof t === "string" && !!t.trim()).map((t) => t.trim())
    : [];

  const knownExports = new Set(facts.exports.map((e) => e.name));
  const explanations = Array.isArray(obj.exports) ? obj.exports : [];
  const exportFields = facts.exports.map((e) => {
    const found = explanations.find(
      (x): x is { name: string; explanation?: unknown } =>
        !!x && typeof x === "object" && (x as { name?: unknown }).name === e.name,
    );
    return {
      name: e.name,
      explanation: asStr(found?.explanation, e.jsdoc ?? "*No description provided.*"),
    };
  });
  // Ignore any hallucinated export names not in the source.
  void knownExports;

  return {
    title: asStr(obj.title, titleCase(facts.pageId)),
    description: asStr(obj.description, facts.fileDoc || "Module documentation."),
    tags: tags.length ? tags.slice(0, 6) : ["module"],
    summary: asStr(obj.summary, facts.fileDoc || "*No summary available.*"),
    exports: exportFields,
    relatedLinks: validateLinks(obj.relatedLinks, validTargets, facts.pageId),
  };
}

/** Call the injected client (JSON mode) to produce validated page fields. */
export async function generateModuleFields(opts: {
  facts: ModuleFacts;
  client: GeminiLike;
  model: string;
  validTargets: string[];
}): Promise<ModulePageFields> {
  const { facts, client, model, validTargets } = opts;
  const response = await client.models.generateContent({
    model,
    contents: buildModulePrompt(facts, validTargets),
    config: {
      responseMimeType: "application/json",
      responseSchema: buildModulePageSchema(validTargets),
    },
  });
  const text = response.text;
  if (!text) throw new Error(`Empty wiki response from the model for ${facts.relPath}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`Wiki response for ${facts.relPath} was not valid JSON: ${(err as Error).message}`);
  }
  return normalizeFields(parsed, facts, validTargets);
}

/** Deterministic fields from facts alone — the offline / no-key fallback. */
export function fieldsFromFacts(
  facts: ModuleFacts,
  info: { title?: string; description?: string; tags?: string[] },
  validTargets: string[],
): ModulePageFields {
  const relatedLinks = validateLinks(
    facts.imports.map((id) => `modules/${id}`),
    validTargets,
    facts.pageId,
  );
  return {
    title: info.title ?? titleCase(facts.pageId),
    description: info.description ?? facts.fileDoc ?? "Auto-generated module documentation.",
    tags: info.tags?.length ? info.tags : ["module"],
    summary: facts.fileDoc || "*No summary available.*",
    exports: facts.exports.map((e) => ({
      name: e.name,
      explanation: e.jsdoc ?? "*No description provided.*",
    })),
    relatedLinks,
  };
}

/** Frontmatter emitter matching the wiki's existing quoted-inline style so the
 * hand-rolled `wiki:lint` parser keeps working. */
export function renderFrontmatter(data: Record<string, string | string[]>): string {
  let out = "---\n";
  for (const [key, val] of Object.entries(data)) {
    if (Array.isArray(val)) {
      out += `${key}: [${val.map((v) => `"${escapeQuotes(v)}"`).join(", ")}]\n`;
    } else {
      out += `${key}: "${escapeQuotes(val)}"\n`;
    }
  }
  out += "---\n";
  return out;
}

function escapeQuotes(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** The default `## Custom Notes` block for a fresh page. */
export const CUSTOM_NOTES_STUB =
  "## Custom Notes\n\n*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*\n";

/** Pull the preserved `## Custom Notes …` block out of an existing page body. */
export function extractCustomNotes(existing: string | undefined): string {
  if (!existing) return CUSTOM_NOTES_STUB;
  const match = existing.match(/## Custom Notes[\s\S]*$/);
  return match ? match[0] : CUSTOM_NOTES_STUB;
}

/** Render a full module page markdown string. Pure. */
export function renderModulePage(opts: {
  fields: ModulePageFields;
  facts: ModuleFacts;
  timestamp: string;
  hash: string;
  customNotes: string;
}): string {
  const { fields, facts, timestamp, hash, customNotes } = opts;

  const frontmatter = renderFrontmatter({
    type: "module",
    title: fields.title,
    description: fields.description,
    tags: fields.tags,
    timestamp,
    sources: [facts.relPath],
    source_hash: hash,
  });

  let md = frontmatter;
  md += `# ${fields.title}\n\n`;
  md += `${fields.summary}\n\n`;
  md += `**Source File**: [${facts.relPath}](file://${facts.absPath})\n\n`;

  if (fields.relatedLinks.length > 0) {
    md += `## Related\n\n`;
    for (const link of fields.relatedLinks) md += `- [[${link}]]\n`;
    md += `\n`;
  }

  if (fields.exports.length > 0) {
    md += `## API Interface\n\n`;
    for (const exp of fields.exports) {
      md += `### \`${exp.name}\`\n`;
      md += `${exp.explanation}\n\n`;
    }
  }

  md += customNotes.endsWith("\n") ? customNotes : `${customNotes}\n`;
  return md;
}
