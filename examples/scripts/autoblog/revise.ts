/**
 * Pure parts of `autoblog:claude revise` (scripts/autoblog/claude.ts), kept
 * here so scripts/autoblog/test-revise.ts can exercise every held-post rule
 * without GitHub.
 */

export const REVISION_MARKER = "<!-- autoblog-revision -->";
export const MAX_REVISIONS = 2;
export const CODEX = "chatgpt-codex-connector";

export interface Finding {
  kind: "codex" | "review" | "link";
  severity: string;
  text: string;
  commentId?: number;
  path?: string;
  line?: number;
}

export interface HeldPr {
  number: number;
  branch: string;
  /** The PR head when it was listed: `revise --resolve` waits for finalize to replace it. */
  headSha: string;
  title: string;
  reasons: string[];
  revisions: number;
  findings: Finding[];
  blocked?: string;
}

export function codexSeverity(body: string): string | undefined {
  const m = body.match(/badge\/(P[0-3])-|(P[0-3]) Badge/i);
  return m ? (m[1] ?? m[2]).toUpperCase() : undefined;
}

export function codexTitle(body: string): string {
  return body
    .replace(/<sub>|<\/sub>|!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/Useful\? React with[\s\S]*$/, "")
    .trim();
}

export interface CcrThread {
  resolved: boolean;
  outdated: boolean;
  path?: string;
  line?: number | null;
  comment_ids: number[];
}

export interface OpenPr {
  number: number;
  title: string;
  head: { ref: string; sha: string };
  labels: Array<{ name: string }>;
}

export interface ReviewComment {
  id: number;
  body: string;
  user: { login: string } | null;
}

export function isClaudePostPr(pr: OpenPr): boolean {
  return /^blog\/claude-/.test(pr.head.ref) && pr.labels.some((l) => l.name === "autoblog-claude-reviewed");
}

/**
 * Whether an open Claude post PR is held, why, and what to fix. Mirrors
 * autoblog-merge-pending: an unresolved Codex P0 holds even when outdated, an
 * unresolved P1 when current; `autoblog-review-failed` and
 * `autoblog-link-repair-needed` hold too. Current P2s ride along as findings.
 */
export function classifyPr(
  pr: OpenPr,
  threads: CcrThread[],
  reviewComments: ReviewComment[],
  issueComments: Array<{ body: string }>,
): HeldPr | undefined {
  if (!isClaudePostPr(pr)) return undefined;
  const labels = pr.labels.map((l) => l.name);
  const byId = new Map(reviewComments.map((c) => [c.id, { body: c.body, login: (c.user?.login ?? "").replace(/\[bot\]$/, "") }]));
  const findings: Finding[] = [];
  const reasons: string[] = [];
  for (const t of threads) {
    const first = byId.get(t.comment_ids[0]);
    if (t.resolved || !first || first.login !== CODEX) continue;
    const severity = codexSeverity(first.body);
    if (!severity) continue;
    const blocking = severity === "P0" || (severity === "P1" && !t.outdated);
    if (blocking) reasons.push(`Codex ${severity}`);
    if (blocking || (!t.outdated && severity === "P2")) {
      findings.push({
        kind: "codex", severity, text: codexTitle(first.body),
        commentId: t.comment_ids[0], path: t.path, line: t.line ?? undefined,
      });
    }
  }
  if (labels.includes("autoblog-review-failed")) reasons.push("session review failed");
  if (labels.includes("autoblog-link-repair-needed")) reasons.push("dead link");
  if (reasons.length === 0) return undefined;
  const revisions = issueComments.filter((c) => c.body.includes(REVISION_MARKER)).length;
  let blocked: string | undefined;
  if (labels.includes("autoblog-hold")) blocked = "autoblog-hold (a human paused it)";
  else if (labels.includes("autoblog-human-approved") || labels.includes("autoblog-review-failed-overridden")) {
    blocked = "a human approved a head of it";
  } else if (revisions >= MAX_REVISIONS) blocked = `already revised ${revisions} times — needs a human`;
  return {
    number: pr.number, branch: pr.head.ref, headSha: pr.head.sha, title: pr.title,
    reasons: [...new Set(reasons)], revisions, findings, blocked,
  };
}

/**
 * The plan to revise from: the run report's plan with every field the post
 * carries taken from the finalized frontmatter instead. An edit made on the PR
 * after finalize (a human fix, an earlier revision) lives only there.
 */
export function revisionPlan(reportPlan: Record<string, unknown>, frontmatter: Record<string, unknown>): Record<string, unknown> {
  const plan = { ...reportPlan };
  for (const key of Object.keys(reportPlan)) {
    const value = frontmatter[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) !== Array.isArray(reportPlan[key]) || typeof value !== typeof reportPlan[key]) continue;
    plan[key] = value;
  }
  return plan;
}

/**
 * The finalized body minus the links the generator's auto-link pass inserted
 * (recorded in the run report), so regenerating does not link it twice: an
 * inline `[anchor](href)` goes back to its anchor text, and a fallback entry
 * leaves the "Related Resources" block, which goes when it is empty.
 */
export function withoutAutoLinks(body: string, autoLinks: unknown): string {
  if (!autoLinks || typeof autoLinks !== "object") return body;
  let out = body;
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const link of Object.values(autoLinks as Record<string, { href?: string; anchor?: string; title?: string; strategy?: string } | null>)) {
    if (!link?.href) continue;
    if (link.strategy === "fallback") {
      out = out.replace(new RegExp(`^- \\[[^\\]\\n]*\\]\\(${escape(link.href)}\\)[ \\t]*\\n?`, "m"), "");
    } else if (link.anchor) {
      out = out.replace(`[${link.anchor}](${link.href})`, link.anchor);
    }
  }
  // The generator's pass also leaves an extra blank line each time it runs;
  // collapse them so repeated revisions do not grow the gap.
  return out.replace(/(^|\n)## Related Resources[ \t]*\n+(?=## |\s*$)/, "$1").replace(/\n{3,}/g, "\n\n");
}

