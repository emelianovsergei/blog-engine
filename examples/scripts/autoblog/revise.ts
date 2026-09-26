/**
 * Pure parts of `autoblog:claude revise` (scripts/autoblog/claude.ts), kept
 * here so scripts/autoblog/test-revise.ts can exercise every held-post rule
 * without GitHub.
 */

export const REVISION_MARKER = "<!-- autoblog-revision -->";
export const MAX_REVISIONS = 2;
export const CODEX = "chatgpt-codex-connector";

export interface Finding {
  kind: "codex" | "review" | "rule" | "gate" | "link";
  severity: string;
  text: string;
  /** What holds the PR. `revise --resolve` closes only these Codex threads; an optional P2 stays open. */
  blocking?: boolean;
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

/**
 * Revisions recorded on a PR: distinct revision numbers among the marked
 * comments, so a retried `revise --resolve` (or a timeout note followed by the
 * landed revision) never spends the allowance twice.
 */
export function revisionCount(issueComments: Array<{ body: string }>): number {
  const seen = new Set<string>();
  for (const c of issueComments) {
    if (!c.body.includes(REVISION_MARKER)) continue;
    seen.add(c.body.match(/revision (\d+) of/i)?.[1] ?? c.body);
  }
  return seen.size;
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
        kind: "codex", severity, text: codexTitle(first.body), blocking,
        commentId: t.comment_ids[0], path: t.path, line: t.line ?? undefined,
      });
    }
  }
  if (labels.includes("autoblog-review-failed")) reasons.push("session review failed");
  if (labels.includes("autoblog-link-repair-needed")) reasons.push("dead link");
  if (reasons.length === 0) return undefined;
  const revisions = revisionCount(issueComments);
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


/**
 * What the run report says held the post, for a PR labelled
 * `autoblog-review-failed` or `autoblog-link-repair-needed`: the rule
 * violations finalize found, the session review's blocker/major issues, why
 * the review gate failed (a score floor or the overall score can fail it with
 * no blocker at all), and the links finalize could not unlink. Without these
 * the session could resubmit the same defect and spend a revision.
 */
export function reportFindings(report: Record<string, unknown>, reasons: string[]): Finding[] {
  const findings: Finding[] = [];
  const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  if (reasons.includes("session review failed")) {
    for (const key of ["planViolations", "bodyViolations", "structuralViolations"]) {
      const list = report[key];
      if (!Array.isArray(list)) continue;
      for (const v of list) findings.push({ kind: "rule", severity: "blocker", text: `${key}: ${text(v)}`, blocking: true });
    }
    const review = (report.claudeReview as { result?: Record<string, unknown> } | undefined)?.result;
    if (review) {
      for (const issue of (review.issues as Array<Record<string, unknown>> | undefined) ?? []) {
        if (issue.severity === "minor") continue;
        findings.push({
          kind: "review", severity: String(issue.severity), blocking: true,
          text: `${text(issue.message)}${issue.suggestion ? `\nSuggestion: ${text(issue.suggestion)}` : ""}${issue.location ? `\nWhere: ${text(issue.location)}` : ""}`,
        });
      }
      if (review.pass === false) {
        // ReviewResult.scores is an array of { dimension, score, reasoning }
        // (blog-engine src/review.ts); a keyed object is accepted too.
        const raw = review.scores;
        const pairs: Array<[string, number]> = Array.isArray(raw)
          ? raw.map((s) => [String((s as { dimension?: unknown })?.dimension ?? ""), Number((s as { score?: unknown })?.score)])
          : raw && typeof raw === "object"
            ? Object.entries(raw as Record<string, unknown>).map(([d, v]) => [d, typeof v === "number" ? v : Number((v as { score?: unknown })?.score)])
            : [];
        const low = pairs
          .filter(([dim, v]) => dim && dim !== "humanVoice" && Number.isFinite(v) && v < 6)
          .map(([dim, v]) => `${dim} ${v}`);
        const overall = typeof review.overallScore === "number" ? review.overallScore : undefined;
        const parts = [
          ...(low.length ? [`below the 6.0 floor: ${low.join(", ")}`] : []),
          ...(overall !== undefined && overall < 7 ? [`overall ${overall} is below 7.0`] : []),
          ...(review.thresholdReasoning ? [text(review.thresholdReasoning)] : []),
        ];
        findings.push({
          kind: "gate", severity: "blocker", blocking: true,
          text: `The review gate failed${parts.length ? `: ${parts.join("; ")}` : "."}`,
        });
      }
    }
  }
  if (reasons.includes("dead link")) {
    const audit = report.linkAudit as { unresolved?: unknown[] } | undefined;
    for (const url of audit?.unresolved ?? []) {
      findings.push({
        kind: "link", severity: "blocker", blocking: true,
        text: `Dead link finalize could not unlink: ${text(url)}. Remove it or replace it with a live page.`,
      });
    }
  }
  return findings;
}
