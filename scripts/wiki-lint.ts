import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const BRAIN_DIR = path.join(ROOT, "brain");
const REPORTS_DIR = path.join(BRAIN_DIR, "reports");

// Helper to recursively get all markdown files
function getAllMarkdownFiles(dirPath: string, fileList: string[] = []): string[] {
  if (!fs.existsSync(dirPath)) return fileList;
  const files = fs.readdirSync(dirPath);

  files.forEach((file) => {
    const fullPath = path.join(dirPath, file);
    if (fs.statSync(fullPath).isDirectory()) {
      fileList = getAllMarkdownFiles(fullPath, fileList);
    } else {
      if (file.endsWith(".md")) {
        fileList.push(fullPath);
      }
    }
  });

  return fileList;
}

// Simple YAML frontmatter parser
function parseFrontmatter(content: string) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { data: {} as Record<string, any>, content };
  const yaml = match[1] || "";
  const data: Record<string, any> = {};
  yaml.split(/\r?\n/).forEach(line => {
    const parts = line.split(":");
    if (parts.length >= 2) {
      const key = parts[0]!.trim();
      const val = parts.slice(1).join(":").trim();
      if (val.startsWith("[") && val.endsWith("]")) {
        data[key] = val.slice(1, -1).split(",").map(s => s.trim().replace(/^['"]|['"]$/g, ""));
      } else {
        data[key] = val.replace(/^['"]|['"]$/g, "");
      }
    }
  });
  return { data, content: content.slice(match[0].length) };
}

interface PageMeta {
  filePath: string;
  relativePath: string;
  frontmatter: Record<string, any>;
  content: string;
  errors: string[];
  links: string[];
}

async function main() {
  console.log("Starting Developer Wiki Linter...");

  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  const allFiles = getAllMarkdownFiles(BRAIN_DIR);
  const pages: PageMeta[] = [];
  const errorsTotal: string[] = [];

  const requiredFields = ["type", "title", "description", "tags", "timestamp", "sources"];
  const validTypes = ["module", "concept", "guide", "index", "log", "report", "summary"];

  // 1. Parse all pages and validate schemas
  for (const filePath of allFiles) {
    const relativePath = path.relative(BRAIN_DIR, filePath);
    if (relativePath.startsWith("reports/") || relativePath === "log.md") {
      continue; // Skip log and report files from schema linting
    }

    const raw = fs.readFileSync(filePath, "utf-8");
    const { data, content } = parseFrontmatter(raw);
    const errors: string[] = [];

    // Verify required fields
    requiredFields.forEach(field => {
      if (data[field] === undefined || data[field] === null || data[field] === "") {
        errors.push(`Missing required field: \`${field}\``);
      }
    });

    if (data.type && !validTypes.includes(data.type)) {
      errors.push(`Invalid type: \`${data.type}\` (expected one of: ${validTypes.join(", ")})`);
    }

    // Extract links [[link]]
    const links: string[] = [];
    const linkRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
    let match;
    while ((match = linkRegex.exec(content)) !== null) {
      if (match[1]) {
        links.push(match[1].trim());
      }
    }

    pages.push({
      filePath,
      relativePath,
      frontmatter: data,
      content,
      errors,
      links
    });
  }

  // 2. Validate Link Integrity
  const pagePathsMap = new Set<string>();
  allFiles.forEach(f => {
    const rel = path.relative(BRAIN_DIR, f);
    const bare = rel.replace(/\.md$/, "");
    pagePathsMap.add(bare);
  });

  const brokenLinks: Array<{ from: string; to: string }> = [];
  const linkGraph = new Map<string, string[]>(); // to -> froms

  for (const page of pages) {
    const barePath = page.relativePath.replace(/\.md$/, "");
    for (const link of page.links) {
      // Resolve link (Obsidian is folder-agnostic sometimes, but we enforce correct paths)
      // Check absolute path first, then relative path
      let resolved = false;
      const targetBare = link.replace(/\.md$/, "");

      if (pagePathsMap.has(targetBare)) {
        resolved = true;
        const list = linkGraph.get(targetBare) || [];
        list.push(barePath);
        linkGraph.set(targetBare, list);
      } else {
        // Check subdirectories or aliases
        for (const p of pagePathsMap) {
          if (p === targetBare || p.endsWith("/" + targetBare)) {
            resolved = true;
            const list = linkGraph.get(p) || [];
            list.push(barePath);
            linkGraph.set(p, list);
            break;
          }
        }
      }

      if (!resolved) {
        brokenLinks.push({ from: page.relativePath, to: link });
        page.errors.push(`Broken link: \`[[${link}]]\` target does not exist.`);
      }
    }
  }

  // 3. Detect Orphans (no incoming links except index/log/reports/overview)
  const orphans: string[] = [];
  for (const page of pages) {
    const barePath = page.relativePath.replace(/\.md$/, "");
    if (barePath === "index" || barePath === "overview") continue;

    const incoming = linkGraph.get(barePath) || [];
    const validIncoming = incoming.filter(i => i !== "index" && i !== "overview");
    if (validIncoming.length === 0) {
      orphans.push(page.relativePath);
    }
  }

  // 4. Staleness check (last updated > 60 days)
  const stalePages: string[] = [];
  const limitDate = new Date();
  limitDate.setDate(limitDate.getDate() - 60);

  for (const page of pages) {
    if (page.frontmatter.timestamp) {
      const ts = new Date(page.frontmatter.timestamp);
      if (ts < limitDate) {
        stalePages.push(page.relativePath);
      }
    }
  }

  // 5. Generate report
  const lintReportPath = path.join(REPORTS_DIR, "lint-report.md");
  let report = `# Wiki Health Report\n\n`;
  report += `*Generated on: ${new Date().toISOString()}*\n\n`;

  const totalSchemaErrors = pages.reduce((sum, p) => sum + p.errors.filter(e => !e.startsWith("Broken link")).length, 0);

  report += `## Summary\n\n`;
  report += `*   **Total Wiki Files**: ${allFiles.length}\n`;
  report += `*   **Schema Violations**: ${totalSchemaErrors}\n`;
  report += `*   **Broken Links**: ${brokenLinks.length}\n`;
  report += `*   **Orphan Pages**: ${orphans.length}\n`;
  report += `*   **Stale Pages**: ${stalePages.length}\n\n`;

  let hasCriticalErrors = false;

  if (totalSchemaErrors > 0 || brokenLinks.length > 0) {
    hasCriticalErrors = true;
    report += `> [!WARNING]\n`;
    report += `> Critical graph errors detected. Please fix the broken links and missing schema tags.\n\n`;
  } else {
    report += `> [!NOTE]\n`;
    report += `> Graph structure is healthy. No critical link or schema errors detected.\n\n`;
  }

  if (brokenLinks.length > 0) {
    report += `## Broken Links\n\n`;
    report += `| File | Target Link |\n`;
    report += `| --- | --- |\n`;
    brokenLinks.forEach(b => {
      report += `| \`${b.from}\` | \`[[${b.to}]]\` |\n`;
    });
    report += `\n`;
  }

  const schemaPages = pages.filter(p => p.errors.filter(e => !e.startsWith("Broken link")).length > 0);
  if (schemaPages.length > 0) {
    report += `## Schema Violations\n\n`;
    schemaPages.forEach(p => {
      report += `### \`${p.relativePath}\`\n`;
      p.errors.filter(e => !e.startsWith("Broken link")).forEach(err => {
        report += `*   ${err}\n`;
      });
      report += `\n`;
    });
  }

  if (orphans.length > 0) {
    report += `## Orphan Pages\n\n`;
    report += `*The following pages have no incoming links:*\n\n`;
    orphans.forEach(o => {
      report += `*   [[${o.replace(/\.md$/, "")}]]\n`;
    });
    report += `\n`;
  }

  if (stalePages.length > 0) {
    report += `## Stale Pages (>60 days)\n\n`;
    stalePages.forEach(s => {
      report += `*   [[${s.replace(/\.md$/, "")}]] (last updated: ${pages.find(p => p.relativePath === s)?.frontmatter.timestamp || "unknown"})\n`;
    });
    report += `\n`;
  }

  fs.writeFileSync(lintReportPath, report, "utf-8");
  console.log(`Lint report generated: brain/reports/lint-report.md`);

  // Log summary to console
  pages.forEach(p => {
    if (p.errors.length > 0) {
      console.error(`Error in ${p.relativePath}:`);
      p.errors.forEach(err => console.error(`  - ${err}`));
    }
  });

  if (hasCriticalErrors) {
    console.error("Linter failed due to critical graph errors.");
    process.exit(1);
  } else {
    console.log("Wiki is 100% healthy!");
    process.exit(0);
  }
}

main().catch(err => {
  console.error("Linter crashed:", err);
  process.exit(1);
});
