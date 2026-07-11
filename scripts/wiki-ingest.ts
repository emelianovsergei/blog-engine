/**
 * Developer-wiki ingest (Karpathy "LLM wiki" — slice 1).
 *
 * Thin orchestrator over `src/wiki/ingest.ts`: walks `src/*.ts` and
 * `src/cli/*.ts`, and for each CHANGED source (sha gate) writes an LLM-authored
 * module page into `brain/modules/`, regenerates `brain/index.md`, and appends an
 * ingest entry to `brain/log.md`. Unchanged files are skipped entirely (no LLM
 * call, no diff).
 *
 * The LLM path uses the project's existing Claude-primary client
 * (`makeReviewClient`). When no `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` is set the
 * script falls back to deterministic generation from JSDoc so `wiki:ingest` still
 * works offline and in CI.
 *
 *   Model override:  WIKI_INGEST_MODEL   (default "claude-sonnet-5")
 */
import fs from "fs";
import path from "path";
import type { GeminiLike } from "../src/types.js";
import { makeReviewClient } from "../src/cli/shared.js";
import { parseDocument } from "../src/cli/frontmatter.js";
import {
  CUSTOM_NOTES_STUB,
  extractCustomNotes,
  extractModuleFacts,
  fieldsFromFacts,
  generateModuleFields,
  pageIdFromRelPath,
  renderFrontmatter,
  renderModulePage,
  sourceHash,
  type ModulePageFields,
} from "../src/wiki/ingest.js";

const ROOT = process.cwd();
const BRAIN_DIR = path.join(ROOT, "brain");
const MODULES_DIR = path.join(BRAIN_DIR, "modules");
const CONCEPTS_DIR = path.join(BRAIN_DIR, "concepts");
const REPORTS_DIR = path.join(BRAIN_DIR, "reports");
const SRC_DIR = path.join(ROOT, "src");
const MODEL = process.env.WIKI_INGEST_MODEL || "claude-sonnet-5";
const TODAY = new Date().toISOString().split("T")[0]!;
/** `--force` regenerates every page even when its source is unchanged — use it
 * to re-enrich existing pages with a better model after the source has settled. */
const FORCE = process.argv.includes("--force");

function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

/** Curated titles/tags for the fallback path (top-level modules). */
const MODULE_INFOS: Record<string, { title: string; description: string; tags: string[] }> = {
  "orchestrator.ts": { title: "Topic Selection Orchestrator", description: "Orchestrates the selection of weekly blog topics using seasonal, weather, and keyword demand signals.", tags: ["orchestrator", "topic-selection", "pipeline"] },
  "weather.ts": { title: "Weather Client", description: "Fetches regional weather data and detects anomalies like heat waves or cold snaps.", tags: ["weather", "api-client", "anomalies"] },
  "season.ts": { title: "Season Context Mapper", description: "Maps calendar dates and time zones to seasons and microclimate profiles.", tags: ["season", "climate", "dates"] },
  "categories.ts": { title: "Category Classifier", description: "Classifies blog posts into categories and analyzes category distribution history.", tags: ["classification", "taxonomy", "history"] },
  "review.ts": { title: "Blog Post Reviewer", description: "Evaluates blog post drafts against SEO, keyword target, and quality rubric criteria.", tags: ["review", "rubric", "quality-gate"] },
  "rewrite.ts": { title: "Blog Post Rewriter", description: "Rewrites blog posts using LLMs to fix issues highlighted in the review rubric.", tags: ["rewrite", "llm-generation", "seo"] },
  "anthropic.ts": { title: "Anthropic Provider Adapter", description: "Connects the blog-engine to Anthropic Claude models for review and rewriting tasks.", tags: ["llm-client", "claude", "adapter"] },
  "client.ts": { title: "Unified Model Client", description: "Abstract client interface managing fallback routing, retries, and multi-model configuration.", tags: ["llm-client", "retry", "fallback"] },
  "planning.ts": { title: "Topic Alignment Guard", description: "Ensures post topics align to planned keywords, target areas, and accuracy guidelines.", tags: ["alignment", "guard", "validation"] },
  "suggest.ts": { title: "Google Autocomplete Client", description: "Retrieves autocomplete suggestions from Google's search suggest API.", tags: ["google-suggest", "seo", "api-client"] },
  "keywords.ts": { title: "Keyword Researcher", description: "Extracts and clusters search query suggestions into structured keyword profiles.", tags: ["seo", "keywords", "clustering"] },
  "demand.ts": { title: "Search Demand Scorer", description: "Scores candidate blog topics against real search suggest frequency signals.", tags: ["demand", "ranking", "seo"] },
  "rank.ts": { title: "Topic Ranker", description: "Ranks candidate topics by combining category mix, weather anomaly, and demand scores.", tags: ["ranking", "candidates", "pipeline"] },
  "candidates.ts": { title: "Topic Candidate Generator", description: "Generates a list of candidate weekly blog topics matching seasonal and weather conditions.", tags: ["generation", "llm", "candidates"] },
  "dedup.ts": { title: "Semantic Deduplicator", description: "Uses vector embeddings to filter out candidate topics that overlap with existing posts.", tags: ["dedup", "embeddings", "vector"] },
  "config.ts": { title: "Configuration Store", description: "Contains category definitions, location defaults, and taxonomy profiles.", tags: ["config", "constants", "taxonomy"] },
  "types.ts": { title: "Type Definitions", description: "Centralized TypeScript interfaces and type definitions used throughout the engine.", tags: ["types", "typescript", "interfaces"] },
};

interface SourceFile {
  relPath: string;
  absPath: string;
  basename: string;
  pageId: string;
  code: string;
}

/** Collect top-level `src/*.ts` plus `src/cli/*.ts`, excluding tests and types. */
function collectSources(): SourceFile[] {
  const out: SourceFile[] = [];
  const dirs = [SRC_DIR, path.join(SRC_DIR, "cli")];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith(".ts") || name.endsWith(".d.ts") || name.endsWith(".test.ts")) continue;
      const absPath = path.join(dir, name);
      if (!fs.statSync(absPath).isFile()) continue;
      const relPath = path.relative(ROOT, absPath).replace(/\\/g, "/");
      out.push({
        relPath,
        absPath,
        basename: name,
        pageId: pageIdFromRelPath(relPath),
        code: fs.readFileSync(absPath, "utf-8"),
      });
    }
  }
  return out;
}

/** Read an existing wiki page → its frontmatter + raw content (for hash + notes). */
function readPage(filePath: string): { frontmatter: Record<string, unknown>; raw: string } | null {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf-8");
  try {
    const { frontmatter } = parseDocument(raw);
    return { frontmatter: frontmatter as unknown as Record<string, unknown>, raw };
  } catch {
    return { frontmatter: {}, raw };
  }
}

async function main() {
  console.log("Developer-wiki ingest (LLM-driven) starting…");
  ensureDir(BRAIN_DIR);
  ensureDir(MODULES_DIR);
  ensureDir(CONCEPTS_DIR);
  ensureDir(REPORTS_DIR);

  const sources = collectSources();

  // Build the allowed link targets up front so every page can cross-link to any
  // other module or concept (and the LLM's links are schema-constrained to them).
  const conceptTargets = fs.existsSync(CONCEPTS_DIR)
    ? fs
        .readdirSync(CONCEPTS_DIR)
        .filter((f) => f.endsWith(".md"))
        .map((f) => `concepts/${f.replace(/\.md$/, "")}`)
    : [];
  const validTargets = [
    ...sources.map((s) => `modules/${s.pageId}`),
    ...conceptTargets,
    "overview",
  ];

  // Resolve the LLM client; fall back to deterministic generation if absent.
  let client: GeminiLike | null = null;
  try {
    client = await makeReviewClient();
    console.log(`  LLM mode: ${MODEL}`);
  } catch {
    console.warn("  No model credentials (ANTHROPIC_API_KEY / GEMINI_API_KEY) — deterministic fallback.");
  }

  const moduleEntries: Array<{ pageId: string; title: string }> = [];
  const changes: Array<{ pageId: string; title: string; note: string }> = [];

  for (const src of sources) {
    const wikiPath = path.join(MODULES_DIR, `${src.pageId}.md`);
    const existing = readPage(wikiPath);
    const hash = sourceHash(src.code);
    const priorHash = typeof existing?.frontmatter.source_hash === "string" ? existing.frontmatter.source_hash : "";

    if (existing && priorHash === hash && !FORCE) {
      const title = typeof existing.frontmatter.title === "string" ? existing.frontmatter.title : src.pageId;
      moduleEntries.push({ pageId: src.pageId, title });
      continue; // unchanged — skip regeneration entirely
    }

    const facts = extractModuleFacts(src.code, src.relPath, src.absPath);
    // MODULE_INFOS is curated for the top-level library modules only. Never
    // apply it to src/cli/* — the basename collides (cli/review.ts vs
    // review.ts) and would mislabel the CLI page with the library's metadata.
    const info = src.relPath.startsWith("src/cli/") ? {} : (MODULE_INFOS[src.basename] ?? {});
    let fields: ModulePageFields;
    if (client) {
      try {
        fields = await generateModuleFields({ facts, client, model: MODEL, validTargets });
      } catch (err) {
        console.warn(`  ! LLM generation failed for ${src.relPath} (${(err as Error).message}); using fallback.`);
        fields = fieldsFromFacts(facts, info, validTargets);
      }
    } else {
      fields = fieldsFromFacts(facts, info, validTargets);
    }

    const customNotes = extractCustomNotes(existing?.raw) || CUSTOM_NOTES_STUB;
    const markdown = renderModulePage({ fields, facts, timestamp: TODAY, hash, customNotes });
    fs.writeFileSync(wikiPath, markdown, "utf-8");

    moduleEntries.push({ pageId: src.pageId, title: fields.title });
    changes.push({ pageId: src.pageId, title: fields.title, note: fields.description });
    console.log(`  ${existing ? "updated" : "created"} modules/${src.pageId}.md`);
  }

  seedConcepts();
  seedOverview();
  regenerateIndex(moduleEntries);
  seedLog();
  if (changes.length > 0) appendLog(changes);

  console.log(
    changes.length > 0
      ? `Ingest complete — ${changes.length} page(s) updated, ${sources.length - changes.length} unchanged.`
      : `Ingest complete — no source changes; ${sources.length} pages up to date.`,
  );
}

/** Seed the three foundational concept pages if they don't exist yet. */
function seedConcepts() {
  const concepts = [
    { file: "topic-deduplication.md", title: "Topic Deduplication", description: "How blog-engine avoids repeating identical or semantically similar topics.", tags: ["concepts", "embeddings", "dedup"], content: `# Topic Deduplication\n\nThe engine employs a hybrid approach to guarantee that suggested blog topics remain distinct:\n1. **Slug Matching**: Rejects direct string overlaps in topic slug identifiers.\n2. **Semantic Comparison**: Computes vector embeddings of candidate topics using Gemini models and filters candidates that exceed a similarity threshold (e.g., 0.85) against existing published posts.\n\nSee [[modules/dedup]] for implementation details.\n` },
    { file: "weather-season-targeting.md", title: "Weather & Seasonal Targeting", description: "How seasonal demand and real-time weather anomalies drive topic prioritization.", tags: ["concepts", "weather", "season"], content: `# Weather & Seasonal Targeting\n\nHVAC search demand is extremely cyclical:\n* **Seasonal Alignment**: Targets seasonal requirements (e.g. heating checkups in Winter, AC troubleshooting in Summer).\n* **Real-time Anomaly overrides**: Live weather observations (like heat waves, wildfire smoke events, and storm fronts) shift topic candidate weights to address immediate home maintenance needs.\n\nSee [[modules/weather]] and [[modules/season]] for mapping details.\n` },
    { file: "quality-gates.md", title: "Quality Gates & AI Review Rubric", description: "Standard checklist for AI reviews before draft posts are merged.", tags: ["concepts", "review", "rubric"], content: `# Quality Gates & AI Review Rubric\n\nAll automatically generated posts must pass a structured review block:\n1. **Local Relevance**: Focuses on geographical keywords and area-specific advice.\n2. **Factual Accuracy**: Rubric bars hallucinating metrics or local codes.\n3. **Completeness**: Evaluates formatting, structure, and readability scores.\n\nPosts dropping below target thresholds are routed to the rewriter tool automatically.\n\nSee [[modules/review]] and [[modules/rewrite]] for details.\n` },
  ];
  for (const c of concepts) {
    const conceptPath = path.join(CONCEPTS_DIR, c.file);
    if (fs.existsSync(conceptPath)) continue;
    const fm = renderFrontmatter({ type: "concept", title: c.title, description: c.description, tags: c.tags, timestamp: TODAY, sources: [] });
    fs.writeFileSync(conceptPath, fm + c.content, "utf-8");
    console.log(`  seeded concept: ${c.file}`);
  }
}

function seedOverview() {
  const overviewPath = path.join(BRAIN_DIR, "overview.md");
  if (fs.existsSync(overviewPath)) return;
  const fm = renderFrontmatter({ type: "summary", title: "Blog Engine Overview", description: "Architecture overview of the blog topic selection and review library.", tags: ["overview", "architecture"], timestamp: TODAY, sources: ["README.md"] });
  const content = `# Blog Engine Overview\n\nWelcome to the **blog-engine** Developer Knowledge Base.\n\nThis repository provides an automated pipeline to help HVAC websites select relevant topics, review drafted posts, and execute stylistic/SEO rewrites before publishing.\n\n## High-Level Architecture\n- **Orchestration**: [[modules/orchestrator]] selects weekly topics based on current signals.\n- **External Signals**: Fetches weather extremes via [[modules/weather]] and autocomplete suggestions via [[modules/suggest]].\n- **Review Rubric**: Standardizes automated quality inspections via [[modules/review]].\n`;
  fs.writeFileSync(overviewPath, fm + content, "utf-8");
  console.log("  seeded overview.md");
}

/** Regenerate index.md from the live module list + a scan of concepts/. */
function regenerateIndex(moduleEntries: Array<{ pageId: string; title: string }>) {
  const fm = renderFrontmatter({ type: "index", title: "Wiki Vault Index", description: "Directory of all documented modules, concepts, and logs in the vault.", tags: ["index"], timestamp: TODAY, sources: [] });
  let content = fm + `# Developer Knowledge Index\n\n`;
  content += `*   [[overview|System Architecture Overview]]\n`;
  content += `*   [[log|Change Log]]\n\n`;

  content += `## Engine Modules\n\n`;
  for (const m of [...moduleEntries].sort((a, b) => a.pageId.localeCompare(b.pageId))) {
    content += `*   [[modules/${m.pageId}|${m.title}]]\n`;
  }

  // Scan the concepts directory so hand-written concept pages are indexed too
  // (previously only three hardcoded concepts appeared — orphaning the rest).
  const conceptFiles = fs.existsSync(CONCEPTS_DIR)
    ? fs.readdirSync(CONCEPTS_DIR).filter((f) => f.endsWith(".md")).sort()
    : [];
  if (conceptFiles.length > 0) {
    content += `\n## Core Concepts\n\n`;
    for (const f of conceptFiles) {
      const name = f.replace(/\.md$/, "");
      const page = readPage(path.join(CONCEPTS_DIR, f));
      const title = typeof page?.frontmatter.title === "string" ? page.frontmatter.title : name;
      content += `*   [[concepts/${name}|${title}]]\n`;
    }
  }

  fs.writeFileSync(path.join(BRAIN_DIR, "index.md"), content, "utf-8");
  console.log("  regenerated index.md");
}

function seedLog() {
  const logPath = path.join(BRAIN_DIR, "log.md");
  if (fs.existsSync(logPath)) return;
  const fm = renderFrontmatter({ type: "log", title: "Developer Wiki Change Log", description: "Append-only record of wiki ingest runs and major changes.", tags: ["log", "changelog"], timestamp: TODAY, sources: [] });
  const body = `# Developer Wiki Change Log\n\n`;
  fs.writeFileSync(logPath, fm + body, "utf-8");
  console.log("  seeded log.md");
}

/** Append a new ingest entry (Karpathy parseable prefix) under the H1, keeping
 * existing entries untouched (append-only, newest first). */
function appendLog(changes: Array<{ pageId: string; title: string; note: string }>) {
  const logPath = path.join(BRAIN_DIR, "log.md");
  const raw = fs.readFileSync(logPath, "utf-8");

  const entryLines = [
    `## [${TODAY}] ingest | ${changes.length} module page(s) updated`,
    "",
    ...changes.map((c) => `- [[modules/${c.pageId}|${c.title}]] — ${firstSentence(c.note)}`),
    "",
  ];
  const entry = entryLines.join("\n");

  const h1 = raw.indexOf("# Developer Wiki Change Log");
  let updated: string;
  if (h1 === -1) {
    updated = `${raw.replace(/\s*$/, "")}\n\n${entry}\n`;
  } else {
    const afterH1 = raw.indexOf("\n", h1);
    const insertAt = afterH1 === -1 ? raw.length : afterH1 + 1;
    const head = raw.slice(0, insertAt).replace(/\n+$/, "\n");
    const tail = raw.slice(insertAt).replace(/^\n+/, "");
    updated = `${head}\n${entry}\n${tail}`;
  }
  // Keep the log's own frontmatter timestamp current so it never reads as stale.
  updated = updated.replace(/^(---[\s\S]*?timestamp:\s*")[^"]*(")/, `$1${TODAY}$2`);
  fs.writeFileSync(logPath, updated, "utf-8");
  console.log(`  appended log.md entry (${changes.length} change(s))`);
}

function firstSentence(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  const m = t.match(/^(.*?[.!?])(\s|$)/);
  return (m ? m[1]! : t).slice(0, 160);
}

main().catch((err) => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
