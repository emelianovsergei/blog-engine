/**
 * Outbound-link policy and liveness checking for generated blog content.
 *
 * Why this exists: the 2026-07-25 weekly run generated a perfectly good post
 * that cited `energy.gov/energysaver/` and `energystar.gov/campaign/`. Both
 * trees had been retired days earlier, a downstream Playwright denylist caught
 * them, and the whole run was discarded — post and all. The generator had no
 * way to know: citation validation was `new URL(...)`, which happily accepts a
 * 404.
 *
 * So links are validated at *generation* time against two independent signals:
 *
 *   1. Policy — a repo-owned list of known-dead URL fragments and banned
 *      domains, shared verbatim with the consumer repo's tests so a rule added
 *      in one place reaches the generator immediately.
 *   2. Liveness — an actual HTTP fetch with a real browser User-Agent,
 *      including soft-404 detection for the very common "deep path now 302s to
 *      the homepage" retirement pattern.
 *
 * A link that cannot be *proven* dead (network flake, 403 bot-block, rate
 * limit) is reported as `unverified`, never as dead. Deleting a good citation
 * because a CI runner got throttled would be its own kind of failure.
 */

/** Repo-owned constraints on which outbound URLs may appear in content. */
export interface LinkPolicy {
  /** Lowercased substrings that mark a URL as known-dead. */
  deniedUrlFragments: readonly string[];
  /** Domains the planner should prefer when citing authorities. */
  preferredCitationDomains: readonly string[];
  /** Domains banned outright (competitors, low-trust aggregators). */
  bannedCitationDomains: readonly string[];
}

export const EMPTY_LINK_POLICY: LinkPolicy = {
  deniedUrlFragments: [],
  preferredCitationDomains: [],
  bannedCitationDomains: [],
};

function cleanStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

/** Parse a raw policy document (JSON) into a `LinkPolicy`, tolerating junk. */
export function parseLinkPolicy(raw: unknown): LinkPolicy {
  if (!raw || typeof raw !== "object") return EMPTY_LINK_POLICY;
  const doc = raw as Record<string, unknown>;
  return {
    deniedUrlFragments: cleanStringList(doc.deniedUrlFragments),
    preferredCitationDomains: cleanStringList(doc.preferredCitationDomains),
    bannedCitationDomains: cleanStringList(doc.bannedCitationDomains),
  };
}

function hostnameOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Return a human-readable reason when `url` breaks the policy, else undefined.
 * Purely textual — no network access, so it is safe to run on every candidate.
 */
export function policyViolation(url: string, policy: LinkPolicy): string | undefined {
  const lowered = url.toLowerCase();

  for (const fragment of policy.deniedUrlFragments) {
    if (lowered.includes(fragment)) {
      return `matches known-dead URL fragment "${fragment}"`;
    }
  }

  const host = hostnameOf(url);
  if (host) {
    for (const domain of policy.bannedCitationDomains) {
      // Match the domain itself or a subdomain of it — never a mere substring,
      // so "competitor-hvac.com" cannot ban "not-competitor-hvac.community.org".
      if (host === domain || host.endsWith(`.${domain}`)) {
        return `uses banned citation domain "${domain}"`;
      }
    }
  }

  return undefined;
}

/**
 * Drop the trailing characters a URL picked up from the prose around it.
 *
 * `)` is the awkward one: it closes a markdown destination *and* appears
 * inside perfectly valid URLs (`.../Heat_pump_(heating)`). Treating every `)`
 * as the delimiter truncates those into a URL that 404s, so the closer is only
 * shed when it is unbalanced — the same heuristic GitHub uses for autolinks.
 */
function trimUrlTail(candidate: string): string {
  let url = candidate;
  for (;;) {
    // Trailing sentence punctuation is never part of the URL.
    const stripped = url.replace(/[.,;:!?]+$/, "");
    if (stripped !== url) {
      url = stripped;
      continue;
    }
    if (!url.endsWith(")")) return url;
    const opens = (url.match(/\(/g) ?? []).length;
    const closes = (url.match(/\)/g) ?? []).length;
    if (closes <= opens) return url;
    url = url.slice(0, -1);
  }
}

/**
 * Extract every absolute http(s) URL from raw MDX — frontmatter citations and
 * body links alike. The 2026-07 sweep found dead links in post *bodies* that a
 * frontmatter-only scan missed, so this deliberately scans the whole file.
 */
export function extractLinks(mdx: string): string[] {
  // Stops at whitespace and at the delimiters that close an autolink, an HTML
  // attribute, or a YAML string — which covers every form these URLs appear in
  // without needing four separate patterns. `)` is deliberately *not* a
  // delimiter here; trimUrlTail decides that by balance instead.
  const pattern = /https?:\/\/[^\s<>"'`\]}]+/g;
  const seen = new Set<string>();
  for (const match of mdx.matchAll(pattern)) {
    const url = trimUrlTail(match[0]);
    if (url.length > 0) seen.add(url);
  }
  return [...seen];
}

export interface LinkCheckResult {
  url: string;
  /** True only when the URL was fetched and resolved to real content. */
  ok: boolean;
  status?: number;
  /** Where the request actually landed after redirects. */
  finalUrl?: string;
  /**
   * True when liveness could not be determined (network error, bot-block,
   * rate limit). Callers must keep the link and warn — never delete it.
   */
  unverified?: boolean;
  reason?: string;
}

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;

export interface CheckLinkOptions {
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}

// Some federal sites serve 403 to anything that does not look like a browser,
// which is exactly how a live page gets mistaken for a dead one.
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

/** Statuses that mean "we were blocked", not "this page is gone". */
const UNVERIFIABLE_STATUSES = new Set([401, 403, 405, 408, 429]);

/** A 5xx is the origin having a bad day, not proof the page was retired. */
function isTransientStatus(status: number): boolean {
  return status >= 500;
}

function isRootPath(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    return pathname === "" || pathname === "/";
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch one URL and decide whether it is live, dead, or unverifiable. */
export async function checkLink(
  url: string,
  options: CheckLinkOptions = {},
): Promise<LinkCheckResult> {
  const {
    fetchImpl = fetch,
    timeoutMs = 15_000,
    retries = 2,
    retryDelayMs = 750,
  } = options;

  let lastError: unknown;
  let lastTransient: { status: number; finalUrl: string } | undefined;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });

      const status = response.status;
      const finalUrl = response.url || url;

      if (UNVERIFIABLE_STATUSES.has(status)) {
        return {
          url,
          ok: false,
          unverified: true,
          status,
          finalUrl,
          reason: `HTTP ${status} — blocked or rate-limited, liveness unverified`,
        };
      }

      // A 500/502/503 during an origin outage must not be allowed to delete a
      // live citation, so it spends the retry budget like a network error and
      // degrades to `unverified` rather than `dead` if it never recovers.
      if (isTransientStatus(status)) {
        lastTransient = { status, finalUrl };
        if (attempt < retries) {
          await sleep(retryDelayMs * (attempt + 1));
          continue;
        }
        return {
          url,
          ok: false,
          unverified: true,
          status,
          finalUrl,
          reason: `HTTP ${status} — origin error after ${retries + 1} attempt(s), liveness unverified`,
        };
      }

      if (status >= 400) {
        return { url, ok: false, status, finalUrl, reason: `HTTP ${status}` };
      }

      // The retirement pattern that broke run 30153351381: a deep consumer
      // path answers 200, but only because it redirected to the homepage.
      if (!isRootPath(url) && isRootPath(finalUrl)) {
        return {
          url,
          ok: false,
          status,
          finalUrl,
          reason: `soft-404 — redirected to the site root (${finalUrl})`,
        };
      }

      return { url, ok: true, status, finalUrl };
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(retryDelayMs * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  return {
    url,
    ok: false,
    unverified: true,
    status: lastTransient?.status,
    finalUrl: lastTransient?.finalUrl,
    reason: `unreachable after ${retries + 1} attempt(s): ${detail}`,
  };
}

export interface CheckLinksOptions extends CheckLinkOptions {
  concurrency?: number;
}

/** Check many URLs with bounded concurrency; each unique URL is fetched once. */
export async function checkLinks(
  urls: readonly string[],
  options: CheckLinksOptions = {},
): Promise<Map<string, LinkCheckResult>> {
  const { concurrency = 4, ...linkOptions } = options;
  const unique = [...new Set(urls)];
  const results = new Map<string, LinkCheckResult>();

  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
    while (cursor < unique.length) {
      const url = unique[cursor];
      cursor += 1;
      if (url === undefined) break;
      results.set(url, await checkLink(url, linkOptions));
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Prompt text that hands the policy to the planning model, so dead domains are
 * avoided at the source instead of being cleaned up afterwards.
 */
export function citationGuidance(policy: LinkPolicy): string {
  const lines: string[] = [];

  if (policy.deniedUrlFragments.length > 0) {
    lines.push(
      `- NEVER cite or link any URL containing these fragments — these pages have been retired and now 404 or bounce to a homepage: ${policy.deniedUrlFragments
        .map((fragment) => `\`${fragment}\``)
        .join(", ")}.`,
    );
    lines.push(
      "- Prefer linking an authority's stable top-level section over a deep consumer path, which is the kind of URL agencies retire without redirecting.",
    );
  }

  if (policy.preferredCitationDomains.length > 0) {
    lines.push(
      `- Prefer these citation domains: ${policy.preferredCitationDomains
        .map((domain) => `\`${domain}\``)
        .join(", ")}.`,
    );
  }

  if (policy.bannedCitationDomains.length > 0) {
    lines.push(
      `- NEVER cite these domains: ${policy.bannedCitationDomains
        .map((domain) => `\`${domain}\``)
        .join(", ")}.`,
    );
  }

  return lines.join("\n");
}
