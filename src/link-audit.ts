/**
 * Outbound-link auditing and repair, shared by every path that writes a post.
 *
 * Generation had this logic inline in the consumer repos; the rewrite path had
 * none at all. That asymmetry is not cosmetic: on 2026-08-18 generation
 * stripped a denylisted DOE URL, the reviewer asked for a cited statistic, and
 * the auto-fix rewrite — which had never heard of the link policy — put the
 * exact same URL back. The post failed `@smoke` and could never merge.
 *
 * Policy is evaluated before the network because it is free, deterministic and
 * authoritative. Only survivors cost a request. A link that cannot be verified
 * (403 bot-block, 429, network flake) is NEVER treated as dead — deleting a
 * good citation because a runner got throttled is its own bug.
 */
import {
  checkLinks,
  extractLinks,
  policyViolation,
  type FetchImpl,
  type LinkPolicy,
} from "./links.js";
import { repairContent } from "./link-repair.js";

export interface LinkAuditResult {
  /** Proven bad — policy hit or a real 404/soft-404. Safe to remove. */
  dead: Map<string, string>;
  /** Liveness unknown. Kept in the post, surfaced to a human. */
  unverified: Map<string, string>;
  checked: number;
}

export interface AuditLinksOptions {
  /** When false, apply policy only and issue no requests (hermetic runs). */
  network?: boolean;
  fetchImpl?: FetchImpl;
  concurrency?: number;
  timeoutMs?: number;
}

export async function auditLinks(
  urls: readonly string[],
  policy: LinkPolicy,
  options: AuditLinksOptions = {},
): Promise<LinkAuditResult> {
  const { network = true, fetchImpl, concurrency = 4, timeoutMs = 15_000 } = options;
  const dead = new Map<string, string>();
  const unverified = new Map<string, string>();
  const needsFetch: string[] = [];

  const unique = [...new Set(urls)];
  for (const url of unique) {
    const violation = policyViolation(url, policy);
    if (violation) dead.set(url, violation);
    else needsFetch.push(url);
  }

  if (network && needsFetch.length > 0) {
    const results = await checkLinks(needsFetch, {
      concurrency,
      timeoutMs,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    for (const [url, result] of results) {
      if (result.ok) continue;
      if (result.unverified) unverified.set(url, result.reason ?? "unverified");
      else dead.set(url, result.reason ?? "dead");
    }
  }

  return { dead, unverified, checked: unique.length };
}

/** Unlink every dead URL in `text`, keeping the surrounding prose intact. */
export function unlinkDeadUrls(text: string, dead: ReadonlyMap<string, string>): string {
  if (dead.size === 0) return text;
  const { text: repaired } = repairContent(text, new Set(dead.keys()), extractLinks(text));
  return repaired;
}

export interface FileAudit {
  checked: number;
  removed: Array<{ url: string; reason: string }>;
  unverified: Array<{ url: string; reason: string }>;
  /** Still present after repair — a bare URL in prose needs a human. */
  unresolved: Array<{ url: string; reason: string }>;
}

/**
 * Audit and repair a serialized post (frontmatter + body) in one pass.
 *
 * Built on `repairContent` rather than a second repair implementation: that
 * function already edits frontmatter through the YAML document and is
 * conservative in prose. Survivors are recomputed from the repaired text, so
 * `unresolved` reflects the file as it will actually be written.
 */
export async function auditAndRepairFile(
  raw: string,
  policy: LinkPolicy,
  options: AuditLinksOptions = {},
): Promise<{ text: string; audit: FileAudit }> {
  // The policy pass sees schemeless URLs too — `energy.gov/energysaver/x`
  // written as plain prose is exactly what the @smoke guard greps for, and
  // what the absolute-only extractor used to miss.
  const policyUrls = extractLinks(raw, { includeSchemeless: true });
  const fetchableUrls = extractLinks(raw);

  const audit = await auditLinks([...new Set([...policyUrls, ...fetchableUrls])], policy, {
    ...options,
    // Schemeless strings are not reliably fetchable; policy already covered them.
    network: options.network ?? true,
  });

  const text = unlinkDeadUrls(raw, audit.dead);
  const stillPresent = new Set(extractLinks(text, { includeSchemeless: true }));

  return {
    text,
    audit: {
      checked: audit.checked,
      removed: [...audit.dead].map(([url, reason]) => ({ url, reason })),
      unverified: [...audit.unverified].map(([url, reason]) => ({ url, reason })),
      unresolved: [...audit.dead]
        .filter(([url]) => stillPresent.has(url))
        .map(([url, reason]) => ({ url, reason })),
    },
  };
}
