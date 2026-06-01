/**
 * Minimal YAML frontmatter reader/writer for the CLI tools.
 *
 * Handles the small subset our blog posts use:
 *   - scalar string / number / bool values (quoted or bare)
 *   - inline arrays: `tags: [a, b, c]`
 *   - block arrays of strings:
 *       tags:
 *         - a
 *         - b
 *
 * Deliberately avoids adding `gray-matter` / `js-yaml` to keep the peer-dep
 * surface tiny — frontmatter shapes here are simple and well controlled.
 */
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

  return { frontmatter: parseYamlBlock(yaml), body };
}

function unquote(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseInlineArray(value: string): string[] {
  const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  return inner.split(",").map((piece) => unquote(piece.trim())).filter(Boolean);
}

function parseScalar(value: string): unknown {
  const v = value.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~" || v === "") return null;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  return unquote(v);
}

const leadingSpaces = (s: string): number => (/^ */.exec(s)?.[0].length ?? 0);

interface PendingBlock {
  /** `>` folds line breaks into spaces; `|` keeps them literal. */
  style: ">" | "|";
  /** Indentation of the `key:` line; block content must be more indented. */
  keyIndent: number;
  rawLines: string[];
}

/**
 * Renders an accumulated YAML block scalar (`>`/`|`, with optional `-`/`+`
 * chomping). Dedents to the least-indented content line, then folds (`>`) or
 * preserves (`|`) line breaks. Trailing blank lines are always stripped, which
 * matches the `-` chomp our generators emit (`>-`) and is harmless otherwise.
 */
function renderBlock(block: PendingBlock): string {
  const lines = [...block.rawLines];
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (lines.length === 0) return "";
  const contentIndent = Math.min(
    ...lines.filter((l) => l.trim() !== "").map(leadingSpaces),
  );
  const dedented = lines.map((l) => (l.trim() === "" ? "" : l.slice(contentIndent)));
  if (block.style === "|") return dedented.join("\n");
  // Folded: blank lines separate paragraphs; lines within a paragraph join with a space.
  const paragraphs: string[] = [];
  let current = "";
  for (const line of dedented) {
    if (line === "") {
      paragraphs.push(current);
      current = "";
    } else {
      current = current ? `${current} ${line}` : line;
    }
  }
  paragraphs.push(current);
  return paragraphs.join("\n");
}

function parseYamlBlock(yaml: string): BlogPostFrontmatter {
  const lines = yaml.split(/\r?\n/);
  const out: Record<string, unknown> = {};
  let pendingKey: string | null = null;
  let pendingList: string[] | null = null;
  let pendingBlock: PendingBlock | null = null;

  const flushPending = (): void => {
    if (pendingKey !== null && pendingList !== null) {
      out[pendingKey] = pendingList;
    } else if (pendingKey !== null && pendingBlock !== null) {
      out[pendingKey] = renderBlock(pendingBlock);
    }
    pendingKey = null;
    pendingList = null;
    pendingBlock = null;
  };

  for (const raw of lines) {
    // Block scalars consume blank lines and any line indented past the key,
    // so they must be handled before the blank/comment skip below.
    if (pendingBlock !== null) {
      if (raw.trim() === "" || leadingSpaces(raw) > pendingBlock.keyIndent) {
        pendingBlock.rawLines.push(raw);
        continue;
      }
      flushPending(); // dedent ends the block; fall through to process this line
    }

    if (!raw.trim() || raw.trim().startsWith("#")) continue;

    if (pendingKey !== null && pendingList !== null && /^\s+-\s+/.test(raw)) {
      const item = raw.replace(/^\s+-\s+/, "");
      pendingList.push(unquote(item));
      continue;
    }

    flushPending();

    const m = /^(\s*)([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(raw);
    if (!m) continue;
    const indent = m[1]!.length;
    const key = m[2]!;
    const rest = m[3] ?? "";

    const block = /^([>|])[+-]?\s*$/.exec(rest);
    if (block) {
      pendingKey = key;
      pendingBlock = { style: block[1] as ">" | "|", keyIndent: indent, rawLines: [] };
      continue;
    }
    if (rest.startsWith("[") && rest.trim().endsWith("]")) {
      out[key] = parseInlineArray(rest);
      continue;
    }
    if (rest === "") {
      pendingKey = key;
      pendingList = [];
      continue;
    }
    out[key] = parseScalar(rest);
  }
  flushPending();

  if (typeof out.title !== "string") {
    out.title = String(out.title ?? "");
  }
  return out as BlogPostFrontmatter;
}

function needsQuoting(s: string): boolean {
  return /[:#\[\]&*!|>'"%@`,]/.test(s) || /^\s|\s$/.test(s) || s === "";
}

function serializeScalar(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const s = String(value);
  if (needsQuoting(s)) return JSON.stringify(s);
  return s;
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
  const keys = new Set<string>();
  for (const k of PREFERRED_ORDER) keys.add(k);
  for (const k of Object.keys(frontmatter)) keys.add(k);

  const lines: string[] = ["---"];
  for (const key of keys) {
    if (!(key in frontmatter)) continue;
    const value = (frontmatter as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${serializeScalar(item)}`);
      }
      continue;
    }
    lines.push(`${key}: ${serializeScalar(value)}`);
  }
  lines.push("---");
  lines.push("");
  lines.push(body.replace(/^\r?\n+/, ""));
  return lines.join("\n");
}
