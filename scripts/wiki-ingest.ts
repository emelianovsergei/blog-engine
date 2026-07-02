import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const BRAIN_DIR = path.join(ROOT, "brain");
const MODULES_DIR = path.join(BRAIN_DIR, "modules");
const CONCEPTS_DIR = path.join(BRAIN_DIR, "concepts");
const REPORTS_DIR = path.join(BRAIN_DIR, "reports");
const SRC_DIR = path.join(ROOT, "src");

// Helper to ensure directory exists
function ensureDir(dirPath: string) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// Simple frontmatter stringifier
function stringifyFrontmatter(data: Record<string, any>) {
  let yaml = "---\n";
  for (const [key, val] of Object.entries(data)) {
    if (Array.isArray(val)) {
      yaml += `${key}: [${val.map(v => `"${v}"`).join(", ")}]\n`;
    } else {
      yaml += `${key}: "${val}"\n`;
    }
  }
  yaml += "---\n";
  return yaml;
}

const MODULE_INFOS: Record<string, { title: string; description: string; tags: string[] }> = {
  "orchestrator.ts": {
    title: "Topic Selection Orchestrator",
    description: "Orchestrates the selection of weekly blog topics using seasonal, weather, and keyword demand signals.",
    tags: ["orchestrator", "topic-selection", "pipeline"]
  },
  "weather.ts": {
    title: "Weather Client",
    description: "Fetches regional weather data and detects anomalies like heat waves or cold snaps.",
    tags: ["weather", "api-client", "anomalies"]
  },
  "season.ts": {
    title: "Season Context Mapper",
    description: "Maps calendar dates and time zones to seasons and microclimate profiles.",
    tags: ["season", "climate", "dates"]
  },
  "categories.ts": {
    title: "Category Classifier",
    description: "Classifies blog posts into categories and analyzes category distribution history.",
    tags: ["classification", "taxonomy", "history"]
  },
  "review.ts": {
    title: "Blog Post Reviewer",
    description: "Evaluates blog post drafts against SEO, keyword target, and quality rubric criteria.",
    tags: ["review", "rubric", "quality-gate"]
  },
  "rewrite.ts": {
    title: "Blog Post Rewriter",
    description: "Rewrites blog posts using LLMs to fix issues highlighted in the review rubric.",
    tags: ["rewrite", "llm-generation", "seo"]
  },
  "anthropic.ts": {
    title: "Anthropic Provider Adapter",
    description: "Connects the blog-engine to Anthropic Claude models for review and rewriting tasks.",
    tags: ["llm-client", "claude", "adapter"]
  },
  "client.ts": {
    title: "Unified Model Client",
    description: "Abstract client interface managing fallback routing, retries, and multi-model configuration.",
    tags: ["llm-client", "retry", "fallback"]
  },
  "planning.ts": {
    title: "Topic Alignment Guard",
    description: "Ensures post topics align to planned keywords, target areas, and accuracy guidelines.",
    tags: ["alignment", "guard", "validation"]
  },
  "suggest.ts": {
    title: "Google Autocomplete Client",
    description: "Retrieves autocomplete suggestions from Google's search suggest API.",
    tags: ["google-suggest", "seo", "api-client"]
  },
  "keywords.ts": {
    title: "Keyword Researcher",
    description: "Extracts and clusters search query suggestions into structured keyword profiles.",
    tags: ["seo", "keywords", "clustering"]
  },
  "demand.ts": {
    title: "Search Demand Scorer",
    description: "Scores candidate blog topics against real search suggest frequency signals.",
    tags: ["demand", "ranking", "seo"]
  },
  "rank.ts": {
    title: "Topic Ranker",
    description: "Ranks candidate topics by combining category mix, weather anomaly, and demand scores.",
    tags: ["ranking", "candidates", "pipeline"]
  },
  "candidates.ts": {
    title: "Topic Candidate Generator",
    description: "Generates a list of candidate weekly blog topics matching seasonal and weather conditions.",
    tags: ["generation", "llm", "candidates"]
  },
  "dedup.ts": {
    title: "Semantic Deduplicator",
    description: "Uses vector embeddings to filter out candidate topics that overlap with existing posts.",
    tags: ["dedup", "embeddings", "vector"]
  },
  "config.ts": {
    title: "Configuration Store",
    description: "Contains category definitions, location defaults, and taxonomy profiles.",
    tags: ["config", "constants", "taxonomy"]
  },
  "types.ts": {
    title: "Type Definitions",
    description: "Centralized TypeScript interfaces and type definitions used throughout the engine.",
    tags: ["types", "typescript", "interfaces"]
  }
};

async function main() {
  console.log("Starting Developer Wiki Ingestion for blog-engine...");

  ensureDir(BRAIN_DIR);
  ensureDir(MODULES_DIR);
  ensureDir(CONCEPTS_DIR);
  ensureDir(REPORTS_DIR);

  const files = fs.readdirSync(SRC_DIR).filter(f => f.endsWith(".ts"));
  const modulesList: string[] = [];

  for (const file of files) {
    const filePath = path.join(SRC_DIR, file);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) continue;

    const moduleKey = file;
    const info = MODULE_INFOS[moduleKey] || {
      title: file.replace(".ts", "").replace(/^\w/, c => c.toUpperCase()) + " Module",
      description: "Auto-generated module documentation.",
      tags: ["module"]
    };

    const wikiFilename = file.replace(".ts", ".md");
    const wikiPath = path.join(MODULES_DIR, wikiFilename);
    modulesList.push(wikiFilename);

    // Read TS source file
    const code = fs.readFileSync(filePath, "utf-8");

    // Extract File-Level JSDoc
    let fileDoc = "";
    const fileDocMatch = code.match(/^\/\*\*([\s\S]*?)\*\//);
    if (fileDocMatch && fileDocMatch[1]) {
      fileDoc = fileDocMatch[1]
        .split("\n")
        .map(l => l.replace(/^\s*\*\s?/, "").trim())
        .filter(Boolean)
        .join(" ");
    }
    if (!fileDoc) {
      fileDoc = info.description;
    }

    // Extract Exports and their inline docs
    const exports: Array<{ name: string; type: string; jsdoc?: string }> = [];
    const lines = code.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] || "";
      const match = line.match(/^\s*export\s+(function|const|class|type|interface|async\s+function)\s+(\w+)/);
      if (match) {
        const type = match[1]!.trim();
        const name = match[2]!.trim();

        // Scan upwards for JSDoc
        let jsdocLines: string[] = [];
        let inJSDoc = false;
        for (let j = i - 1; j >= 0; j--) {
          const prevLine = lines[j]?.trim();
          if (prevLine === undefined) break;
          if (prevLine === "") continue;
          if (prevLine.endsWith("*/")) {
            inJSDoc = true;
          }
          if (inJSDoc) {
            jsdocLines.unshift(prevLine);
          }
          if (prevLine.startsWith("/**")) {
            break;
          }
          if (!inJSDoc && !prevLine.startsWith("//")) {
            break;
          }
        }

        const jsdoc = jsdocLines.length > 0
          ? jsdocLines
              .map(l => l.replace(/^\/\*\*|^\*\/|^\*\s?|^\/\/\s?/g, "").trim())
              .filter(Boolean)
              .join(" ")
          : undefined;

        exports.push({ name, type, jsdoc });
      }
    }

    // Preserve Custom Notes if file already exists
    let customNotes = "";
    if (fs.existsSync(wikiPath)) {
      const existingContent = fs.readFileSync(wikiPath, "utf-8");
      const notesMatch = existingContent.match(/## Custom Notes[\s\S]*$/);
      if (notesMatch) {
        customNotes = notesMatch[0];
      }
    }
    if (!customNotes) {
      customNotes = "## Custom Notes\n\n*Add any developer notes, usage examples, or design decisions here. They will be preserved across ingestion runs.*\n";
    }

    // Compile new markdown content
    const frontmatter = {
      type: "module",
      title: info.title,
      description: info.description,
      tags: info.tags,
      timestamp: new Date().toISOString().split("T")[0],
      sources: [`src/${file}`]
    };

    let mdContent = stringifyFrontmatter(frontmatter);
    mdContent += `# ${info.title}\n\n`;
    mdContent += `${fileDoc}\n\n`;
    mdContent += `**Source File**: [${file}](file://${filePath})\n\n`;

    if (exports.length > 0) {
      mdContent += `## API Interface\n\n`;
      for (const exp of exports) {
        mdContent += `### \`${exp.name}\` (${exp.type})\n`;
        if (exp.jsdoc) {
          mdContent += `${exp.jsdoc}\n`;
        } else {
          mdContent += `*No description provided.*\n`;
        }
        mdContent += `\n`;
      }
    }

    mdContent += customNotes;

    fs.writeFileSync(wikiPath, mdContent, "utf-8");
    console.log(`Generated module wiki: ${wikiFilename}`);
  }

  // --- Seed Core Concepts ---
  const concepts = [
    {
      file: "topic-deduplication.md",
      title: "Topic Deduplication",
      description: "How blog-engine avoids repeating identical or semantically similar topics.",
      tags: ["concepts", "embeddings", "dedup"],
      content: `# Topic Deduplication

The engine employs a hybrid approach to guarantee that suggested blog topics remain distinct:
1. **Slug Matching**: Rejects direct string overlaps in topic slug identifiers.
2. **Semantic Comparison**: Computes vector embeddings of candidate topics using Gemini models and filters candidates that exceed a similarity threshold (e.g., 0.85) against existing published posts.

See [[modules/dedup]] for implementation details.
`
    },
    {
      file: "weather-season-targeting.md",
      title: "Weather & Seasonal Targeting",
      description: "How seasonal demand and real-time weather anomalies drive topic prioritization.",
      tags: ["concepts", "weather", "season"],
      content: `# Weather & Seasonal Targeting

HVAC search demand is extremely cyclical:
* **Seasonal Alignment**: Targets seasonal requirements (e.g. heating checkups in Winter, AC troubleshooting in Summer).
* **Real-time Anomaly overrides**: Live weather observations (like heat waves, wildfire smoke events, and storm fronts) shift topic candidate weights to address immediate home maintenance needs.

See [[modules/weather]] and [[modules/season]] for mapping details.
`
    },
    {
      file: "quality-gates.md",
      title: "Quality Gates & AI Review Rubric",
      description: "Standard checklist for AI reviews before draft posts are merged.",
      tags: ["concepts", "review", "rubric"],
      content: `# Quality Gates & AI Review Rubric

All automatically generated posts must pass a structured review block:
1. **Local Relevance**: Focuses on geographical keywords and area-specific advice.
2. **Factual Accuracy**: Rubric bars hallucinating metrics or local codes.
3. **Completeness**: Evaluates formatting, structure, and readability scores.

Posts dropping below target thresholds are routed to the rewriter tool automatically.

See [[modules/review]] and [[modules/rewrite]] for details.
`
    }
  ];

  for (const c of concepts) {
    const conceptPath = path.join(CONCEPTS_DIR, c.file);
    if (!fs.existsSync(conceptPath)) {
      const fm = {
        type: "concept",
        title: c.title,
        description: c.description,
        tags: c.tags,
        timestamp: new Date().toISOString().split("T")[0],
        sources: []
      };
      fs.writeFileSync(conceptPath, stringifyFrontmatter(fm) + c.content, "utf-8");
      console.log(`Seeded concept: ${c.file}`);
    }
  }

  // --- Generate overview.md if missing ---
  const overviewPath = path.join(BRAIN_DIR, "overview.md");
  if (!fs.existsSync(overviewPath)) {
    const fm = {
      type: "summary",
      title: "Blog Engine Overview",
      description: "Architecture overview of the blog topic selection and review library.",
      tags: ["overview", "architecture"],
      timestamp: new Date().toISOString().split("T")[0],
      sources: ["README.md"]
    };
    const content = `# Blog Engine Overview

Welcome to the **blog-engine** Developer Knowledge Base. 

This repository provides an automated pipeline to help HVAC websites select relevant topics, review drafted posts, and execute stylistic/SEO rewrites before publishing.

## High-Level Architecture
- **Orchestration**: [[modules/orchestrator]] selects weekly topics based on current signals.
- **External Signals**: Fetches weather extremes via [[modules/weather]] and autocomplete suggestions via [[modules/suggest]].
- **Review Rubric**: Standardizes automated quality inspections via [[modules/review]].
`;
    fs.writeFileSync(overviewPath, stringifyFrontmatter(fm) + content, "utf-8");
    console.log("Seeded overview.md");
  }

  // --- Generate index.md ---
  const indexPath = path.join(BRAIN_DIR, "index.md");
  const fmIndex = {
    type: "index",
    title: "Wiki Vault Index",
    description: "Directory of all documented modules, concepts, and logs in the vault.",
    tags: ["index"],
    timestamp: new Date().toISOString().split("T")[0],
    sources: []
  };

  let indexContent = stringifyFrontmatter(fmIndex);
  indexContent += `# Developer Knowledge Index\n\n`;
  indexContent += `*   [[overview|System Architecture Overview]]\n`;
  indexContent += `*   [[log|Change Log]]\n\n`;

  indexContent += `## Engine Modules\n\n`;
  for (const m of modulesList) {
    const name = m.replace(".md", "");
    const title = MODULE_INFOS[m.replace(".md", ".ts")]?.title || name;
    indexContent += `*   [[modules/${name}|${title}]]\n`;
  }

  indexContent += `\n## Core Concepts\n\n`;
  for (const c of concepts) {
    const name = c.file.replace(".md", "");
    indexContent += `*   [[concepts/${name}|${c.title}]]\n`;
  }

  fs.writeFileSync(indexPath, indexContent, "utf-8");
  console.log("Generated index.md");

  // --- Generate log.md if missing ---
  const logPath = path.join(BRAIN_DIR, "log.md");
  if (!fs.existsSync(logPath)) {
    const fmLog = {
      type: "log",
      title: "Developer Wiki Change Log",
      description: "Track of major modifications and releases.",
      tags: ["log", "changelog"],
      timestamp: new Date().toISOString().split("T")[0],
      sources: []
    };
    const logContent = `# Developer Wiki Change Log

## [2026-07-01] Wiki Implementation
- Initialized Karpathy-style Obsidian wiki structure inside the repository.
- Created \`scripts/wiki-ingest.ts\` to parse exports and JSDocs.
- Set up \`scripts/wiki-lint.ts\` for graph integrity checks.
`;
    fs.writeFileSync(logPath, stringifyFrontmatter(fmLog) + logContent, "utf-8");
    console.log("Seeded log.md");
  }

  console.log("LLM-Wiki Ingestion completed successfully!");
}

main().catch(err => {
  console.error("Ingestion failed:", err);
  process.exit(1);
});
