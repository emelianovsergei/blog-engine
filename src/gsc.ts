/**
 * Google Search Console — the only first-party demand signal available.
 *
 * Autocomplete tells you the shape of the query space; it cannot tell you what
 * this site already gets impressions for, at what position, or which queries
 * are one push from page one. GSC can, for free, and no keyword tool can
 * reproduce it because it is your own property's data.
 *
 * Hand-rolled JWT rather than pulling in `googleapis`: this library's only
 * runtime dependency is `yaml`, and the auth flow here is one signed
 * assertion plus one token exchange.
 *
 * Every entry point degrades instead of throwing. An absent credential is a
 * normal state (the pipeline predates this signal); an EXPIRED or revoked one
 * is not, and must be loud — a key silently rotating the pipeline back to
 * blindness is precisely the failure mode this whole rework exists to remove.
 */
import { createSign } from "node:crypto";
import type { FetchImpl } from "./links.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEARCH_ANALYTICS_URL = "https://www.googleapis.com/webmasters/v3/sites";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

export interface GscCredentials {
  clientEmail: string;
  privateKey: string;
}

/** Tolerant parse of a service-account JSON blob (usually from an env var). */
export function parseServiceAccountJson(raw: string | undefined): GscCredentials | undefined {
  if (!raw || raw.trim().length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const clientEmail = typeof parsed.client_email === "string" ? parsed.client_email : "";
    const privateKey = typeof parsed.private_key === "string" ? parsed.private_key : "";
    if (!clientEmail || !privateKey) return undefined;
    // Secrets pasted through some UIs arrive with literal \n sequences.
    return { clientEmail, privateKey: privateKey.replace(/\\n/g, "\n") };
  } catch {
    return undefined;
  }
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Signed JWT assertion for the OAuth2 service-account flow. */
export function buildJwtAssertion(
  credentials: GscCredentials,
  nowSeconds: number,
  scope: string = SCOPE,
): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: credentials.clientEmail,
      scope,
      aud: TOKEN_URL,
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = base64url(signer.sign(credentials.privateKey));
  return `${header}.${claims}.${signature}`;
}

async function fetchAccessToken(
  credentials: GscCredentials,
  fetchImpl: FetchImpl,
  nowSeconds: number,
): Promise<string> {
  const assertion = buildJwtAssertion(credentials, nowSeconds);
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`token exchange failed: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { access_token?: string };
  if (!payload.access_token) throw new Error("token exchange returned no access_token");
  return payload.access_token;
}

export interface GscQueryRow {
  query: string;
  impressions: number;
  clicks: number;
  ctr: number;
  position: number;
}

export interface FetchSearchAnalyticsArgs {
  credentials: GscCredentials;
  siteUrl: string;
  startDate: string;
  endDate: string;
  dimensions?: Array<"query" | "page" | "date">;
  rowLimit?: number;
  fetchImpl?: FetchImpl;
  nowSeconds?: number;
}

export async function fetchSearchAnalytics(args: FetchSearchAnalyticsArgs): Promise<GscQueryRow[]> {
  const fetchImpl = args.fetchImpl ?? (fetch as FetchImpl);
  const nowSeconds = args.nowSeconds ?? Math.floor(Date.now() / 1000);
  const token = await fetchAccessToken(args.credentials, fetchImpl, nowSeconds);

  const url = `${SEARCH_ANALYTICS_URL}/${encodeURIComponent(args.siteUrl)}/searchAnalytics/query`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      startDate: args.startDate,
      endDate: args.endDate,
      dimensions: args.dimensions ?? ["query"],
      rowLimit: args.rowLimit ?? 500,
    }),
  });
  if (!response.ok) {
    throw new Error(`searchAnalytics failed: HTTP ${response.status}`);
  }

  const payload = (await response.json()) as {
    rows?: Array<{ keys?: string[]; impressions?: number; clicks?: number; ctr?: number; position?: number }>;
  };
  return (payload.rows ?? []).map((row) => ({
    query: row.keys?.[0] ?? "",
    impressions: row.impressions ?? 0,
    clicks: row.clicks ?? 0,
    ctr: row.ctr ?? 0,
    position: row.position ?? 0,
  }));
}

export type GscStatus = "ok" | "absent" | "unauthorized" | "error";

export interface GscSignal {
  status: GscStatus;
  rows: GscQueryRow[];
  byQuery: Map<string, GscQueryRow>;
  message?: string;
}

const EMPTY_SIGNAL = (status: GscStatus, message?: string): GscSignal => ({
  status,
  rows: [],
  byQuery: new Map(),
  ...(message ? { message } : {}),
});

function isoDaysAgo(now: Date, days: number): string {
  const d = new Date(now.getTime() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

export interface LoadGscSignalArgs {
  serviceAccountJson?: string;
  siteUrl?: string;
  now: Date;
  lookbackDays?: number;
  rowLimit?: number;
  fetchImpl?: FetchImpl;
}

/**
 * The one function consumers call. Never throws.
 *
 * `absent` (no credential) is a normal, quiet state. `unauthorized` is not —
 * it means a key that used to work no longer does, and callers are expected to
 * surface it rather than silently fall back to autocomplete-only.
 */
export async function loadGscSignal(args: LoadGscSignalArgs): Promise<GscSignal> {
  const credentials = parseServiceAccountJson(args.serviceAccountJson);
  if (!credentials || !args.siteUrl) return EMPTY_SIGNAL("absent");

  try {
    const rows = await fetchSearchAnalytics({
      credentials,
      siteUrl: args.siteUrl,
      startDate: isoDaysAgo(args.now, args.lookbackDays ?? 90),
      endDate: isoDaysAgo(args.now, 1),
      ...(args.rowLimit ? { rowLimit: args.rowLimit } : {}),
      ...(args.fetchImpl ? { fetchImpl: args.fetchImpl } : {}),
      nowSeconds: Math.floor(args.now.getTime() / 1000),
    });
    return {
      status: "ok",
      rows,
      byQuery: new Map(rows.map((r) => [r.query.toLowerCase(), r])),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const unauthorized = /HTTP 40(1|3)/.test(message);
    return EMPTY_SIGNAL(unauthorized ? "unauthorized" : "error", message);
  }
}

export interface OpportunityQuery extends GscQueryRow {
  /** Higher = more worth writing a dedicated post about. */
  opportunity: number;
}

export interface OpportunityOptions {
  minImpressions?: number;
  minPosition?: number;
  maxPosition?: number;
  limit?: number;
}

/**
 * Queries the site already ranks for, just not well enough to get clicks.
 *
 * Positions 8-25 with real impression volume are the ones a dedicated post can
 * realistically move onto page one. This is the highest-value output of the
 * whole GSC integration: it is specific, first-party, and no keyword tool can
 * produce it.
 */
export function findOpportunities(
  signal: GscSignal,
  options: OpportunityOptions = {},
): OpportunityQuery[] {
  const minImpressions = options.minImpressions ?? 50;
  const minPosition = options.minPosition ?? 8;
  const maxPosition = options.maxPosition ?? 25;

  return signal.rows
    .filter(
      (r) =>
        r.impressions >= minImpressions && r.position >= minPosition && r.position <= maxPosition,
    )
    .map((r) => ({
      ...r,
      // Impressions carry the weight; being nearer page one breaks ties.
      opportunity: r.impressions * (1 - (r.position - minPosition) / (maxPosition - minPosition)),
    }))
    .sort((a, b) => b.opportunity - a.opportunity)
    .slice(0, options.limit ?? 10);
}

export interface MergedDemand {
  /** Log-scaled GSC impressions relative to this site's own maximum. */
  volumeScore: number | null;
  /** Autocomplete completion breadth. */
  breadthScore: number | null;
  score: number | null;
  sources: Array<"autocomplete" | "gsc">;
}

/**
 * Combine the two signals without averaging away what each one knows.
 *
 * GSC measures proven impressions but is blind to anything the site does not
 * already rank for. Autocomplete measures breadth of the query space including
 * the unranked. Collapsing them into a single number too early would hide both
 * facts, so each is kept and the blend only happens when both exist.
 */
export function mergeDemand(args: {
  head: string;
  breadthScore?: number | null;
  signal?: GscSignal;
  maxImpressions?: number;
}): MergedDemand {
  const sources: Array<"autocomplete" | "gsc"> = [];
  const breadthScore = typeof args.breadthScore === "number" ? args.breadthScore : null;
  if (breadthScore !== null) sources.push("autocomplete");

  let volumeScore: number | null = null;
  if (args.signal && args.signal.status === "ok" && args.head) {
    const head = args.head.toLowerCase();
    const matches = args.signal.rows.filter((r) => r.query.toLowerCase().includes(head));
    if (matches.length > 0) {
      const impressions = matches.reduce((sum, r) => sum + r.impressions, 0);
      const ceiling = args.maxImpressions ?? Math.max(...args.signal.rows.map((r) => r.impressions), 1);
      volumeScore = Math.min(1, Math.log10(1 + impressions) / Math.log10(1 + ceiling));
      sources.push("gsc");
    }
  }

  const score =
    volumeScore !== null && breadthScore !== null
      ? 0.7 * volumeScore + 0.3 * breadthScore
      : (volumeScore ?? breadthScore);

  return { volumeScore, breadthScore, score, sources };
}
