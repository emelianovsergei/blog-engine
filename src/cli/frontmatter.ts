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

function parseYamlBlock(yaml: string): BlogPostFrontmatter {
  const lines = yaml.split(/\r?\n/);
  const out: Record<string, unknown> = {};
  let pendingKey: string | null = null;
  let pendingList: string[] | null = null;

  const flushList = (): void => {
    if (pendingKey !== null && pendingList !== null) {
      out[pendingKey] = pendingList;
    }
    pendingKey = null;
    pendingList = null;
  };

  for (const raw of lines) {
    if (!raw.trim() || raw.trim().startsWith("#")) continue;

    if (pendingKey !== null && /^\s+-\s+/.test(raw)) {
      const item = raw.replace(/^\s+-\s+/, "");
      pendingList!.push(unquote(item));
      continue;
    }

    flushList();

    const m = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(raw);
    if (!m) continue;
    const key = m[1]!;
    const rest = m[2] ?? "";

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
  flushList();

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
