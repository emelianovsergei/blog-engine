import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import {
  buildJwtAssertion,
  findOpportunities,
  loadGscSignal,
  mergeDemand,
  parseServiceAccountJson,
  type GscQueryRow,
  type GscSignal,
} from "../gsc.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const CREDS = { clientEmail: "svc@example.iam.gserviceaccount.com", privateKey };
const SA_JSON = JSON.stringify({ client_email: CREDS.clientEmail, private_key: privateKey });

function rows(...specs: Array<Partial<GscQueryRow> & { query: string }>): GscQueryRow[] {
  return specs.map((s) => ({
    impressions: 0,
    clicks: 0,
    ctr: 0,
    position: 0,
    ...s,
  }));
}

const signalOf = (list: GscQueryRow[]): GscSignal => ({
  status: "ok",
  rows: list,
  byQuery: new Map(list.map((r) => [r.query.toLowerCase(), r])),
});

test("service-account JSON parses, including escaped newlines", () => {
  const escaped = JSON.stringify({
    client_email: "a@b.com",
    private_key: "-----BEGIN-----\\nline\\n-----END-----",
  });
  const parsed = parseServiceAccountJson(escaped);

  assert.equal(parsed?.clientEmail, "a@b.com");
  assert.ok(parsed?.privateKey.includes("\n"), "literal \\n must become a real newline");
});

test("malformed or absent credentials parse to undefined rather than throwing", () => {
  assert.equal(parseServiceAccountJson(undefined), undefined);
  assert.equal(parseServiceAccountJson(""), undefined);
  assert.equal(parseServiceAccountJson("not json"), undefined);
  assert.equal(parseServiceAccountJson(JSON.stringify({ client_email: "a@b.com" })), undefined);
});

test("the JWT assertion carries the right issuer, scope, audience and expiry", () => {
  const jwt = buildJwtAssertion(CREDS, 1_700_000_000);
  const [header, claims, signature] = jwt.split(".");

  assert.ok(signature && signature.length > 0);
  const decodedHeader = JSON.parse(Buffer.from(header!, "base64url").toString());
  const decodedClaims = JSON.parse(Buffer.from(claims!, "base64url").toString());

  assert.equal(decodedHeader.alg, "RS256");
  assert.equal(decodedClaims.iss, CREDS.clientEmail);
  assert.match(decodedClaims.scope, /webmasters\.readonly/);
  assert.equal(decodedClaims.aud, "https://oauth2.googleapis.com/token");
  assert.equal(decodedClaims.exp - decodedClaims.iat, 3600);
});

test("loadGscSignal is quiet when no credential is configured", async () => {
  const absent = await loadGscSignal({ now: new Date("2026-08-19"), siteUrl: "sc-domain:x.com" });
  assert.equal(absent.status, "absent");

  const noSite = await loadGscSignal({ now: new Date("2026-08-19"), serviceAccountJson: SA_JSON });
  assert.equal(noSite.status, "absent");
});

test("a revoked key reports unauthorized rather than degrading silently", async () => {
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ error: "invalid_grant" }), { status: 401 })) as unknown as typeof fetch;

  const signal = await loadGscSignal({
    now: new Date("2026-08-19"),
    serviceAccountJson: SA_JSON,
    siteUrl: "sc-domain:example.com",
    fetchImpl,
  });

  assert.equal(signal.status, "unauthorized");
  assert.ok(signal.message);
});

test("loadGscSignal returns parsed rows on the happy path", async () => {
  const fetchImpl = (async (url: string) => {
    if (String(url).includes("oauth2")) {
      return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
    }
    return new Response(
      JSON.stringify({
        rows: [
          { keys: ["furnace blowing cold air"], impressions: 340, clicks: 12, ctr: 0.035, position: 14.2 },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const signal = await loadGscSignal({
    now: new Date("2026-08-19"),
    serviceAccountJson: SA_JSON,
    siteUrl: "sc-domain:example.com",
    fetchImpl,
  });

  assert.equal(signal.status, "ok");
  assert.equal(signal.rows.length, 1);
  assert.equal(signal.byQuery.get("furnace blowing cold air")?.impressions, 340);
});

test("a network failure is an error, not an unauthorized", async () => {
  const fetchImpl = (async () => {
    throw new Error("socket hang up");
  }) as unknown as typeof fetch;

  const signal = await loadGscSignal({
    now: new Date("2026-08-19"),
    serviceAccountJson: SA_JSON,
    siteUrl: "sc-domain:example.com",
    fetchImpl,
  });

  assert.equal(signal.status, "error");
});

test("opportunities are queries ranking just off page one with real volume", () => {
  const signal = signalOf(
    rows(
      { query: "near miss", impressions: 340, position: 14 }, // in band
      { query: "already winning", impressions: 900, position: 2 }, // too good
      { query: "hopeless", impressions: 800, position: 60 }, // too deep
      { query: "no volume", impressions: 3, position: 12 }, // too small
      { query: "closer", impressions: 340, position: 9 }, // same volume, nearer page one
    ),
  );

  const found = findOpportunities(signal);
  const queries = found.map((f) => f.query);

  assert.deepEqual(queries, ["closer", "near miss"], "band-filtered and ranked by proximity");
  assert.ok(!queries.includes("already winning"));
  assert.ok(!queries.includes("hopeless"));
  assert.ok(!queries.includes("no volume"));
});

test("mergeDemand keeps both signals distinct and blends only when both exist", () => {
  const signal = signalOf(rows({ query: "furnace blowing cold air", impressions: 500, position: 12 }));

  const both = mergeDemand({ head: "furnace blowing", breadthScore: 0.5, signal });
  assert.deepEqual(both.sources, ["autocomplete", "gsc"]);
  assert.ok(both.volumeScore !== null && both.breadthScore !== null);
  assert.ok(both.score! > 0.5, "volume dominates the blend");

  const autocompleteOnly = mergeDemand({ head: "unrelated topic", breadthScore: 0.4, signal });
  assert.deepEqual(autocompleteOnly.sources, ["autocomplete"]);
  assert.equal(autocompleteOnly.score, 0.4);

  const nothing = mergeDemand({ head: "x" });
  assert.equal(nothing.score, null);
  assert.deepEqual(nothing.sources, []);
});

test("an unauthorized signal contributes no volume score", () => {
  const merged = mergeDemand({
    head: "furnace",
    breadthScore: 0.6,
    signal: { status: "unauthorized", rows: [], byQuery: new Map() },
  });

  assert.equal(merged.volumeScore, null);
  assert.equal(merged.score, 0.6);
});

// ─── page-dimension signal + refresh target (v0.17) ─────────────────────────

import { loadGscPageSignal, pickRefreshTarget } from "../gsc.js";

test("loadGscPageSignal groups query rows by page and honours a path prefix", async () => {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = (async (url: string, init?: { body?: string }) => {
    calls.push({ url, body: String(init?.body ?? "") });
    if (url.includes("oauth2")) return { ok: true, status: 200, json: async () => ({ access_token: "t" }), text: async () => "" };
    return {
      ok: true,
      status: 200,
      text: async () => "",
      json: async () => ({
        rows: [
          { keys: ["https://www.example.com/blog/a", "query a1"], impressions: 100, clicks: 3, ctr: 0.03, position: 9 },
          { keys: ["https://www.example.com/blog/a", "query a2"], impressions: 50, clicks: 0, ctr: 0, position: 15 },
          { keys: ["https://www.example.com/services/x", "service q"], impressions: 900, clicks: 9, ctr: 0.01, position: 5 },
        ],
      }),
    };
  }) as unknown as NonNullable<Parameters<typeof loadGscPageSignal>[0]["fetchImpl"]>;

  const signal = await loadGscPageSignal({
    serviceAccountJson: SA_JSON,
    siteUrl: "https://www.example.com/",
    now: new Date("2026-09-06T12:00:00Z"),
    pathPrefix: "/blog/",
    fetchImpl,
  });
  assert.equal(signal.status, "ok");
  assert.match(calls[1]!.body, /"dimensions":\["page","query"\]/);
  assert.deepEqual([...signal.byPage.keys()], ["https://www.example.com/blog/a"]);
  assert.equal(signal.byPage.get("https://www.example.com/blog/a")!.length, 2);
  assert.equal(signal.byPage.get("https://www.example.com/blog/a")![0]!.query, "query a1");
});

test("pickRefreshTarget chooses the highest-opportunity page-two post outside the cooldown", () => {
  const byPage = new Map([
    [
      "https://www.example.com/blog/hot",
      rows({ query: "hot q1", impressions: 1200, position: 11 }, { query: "hot q2", impressions: 300, position: 6 }),
    ],
    ["https://www.example.com/blog/recent", rows({ query: "recent q", impressions: 5000, position: 10 })],
    ["https://www.example.com/blog/winner-already", rows({ query: "w", impressions: 4000, position: 2 })],
    ["https://www.example.com/blog/thin", rows({ query: "t", impressions: 20, position: 12 })],
    ["https://www.example.com/blog/open-pr", rows({ query: "o", impressions: 3000, position: 12 })],
  ]);
  const posts = [
    { slug: "hot", url: "https://www.example.com/blog/hot", date: "2026-03-01" },
    { slug: "recent", url: "https://www.example.com/blog/recent", date: "2026-03-01", updated: "2026-08-20" },
    { slug: "winner-already", url: "https://www.example.com/blog/winner-already", date: "2026-01-01" },
    { slug: "thin", url: "https://www.example.com/blog/thin", date: "2026-01-01" },
    { slug: "open-pr", url: "https://www.example.com/blog/open-pr", date: "2026-01-01" },
    { slug: "no-data", url: "https://www.example.com/blog/no-data", date: "2026-01-01" },
  ];
  const target = pickRefreshTarget({
    byPage,
    posts,
    now: new Date("2026-09-06T12:00:00Z"),
    excludeSlugs: ["open-pr"],
  });
  assert.equal(target?.slug, "hot", "recent is inside the cooldown, winner-already is on page one, thin has too few impressions, open-pr is excluded");
  assert.equal(target?.queries.length, 2, "all of the page's ranking queries come along, page-one ones included");
  assert.equal(target?.queries[0]?.query, "hot q1", "sorted by impressions");
  assert.equal(pickRefreshTarget({ byPage: new Map(), posts, now: new Date() }), undefined);
});

test("a configured but malformed credential is reported, not treated as absent", async () => {
  const now = new Date("2026-08-19");
  const truncated = SA_JSON.slice(0, 40);
  const missingKey = JSON.stringify({ client_email: "svc@example.iam.gserviceaccount.com" });
  for (const bad of [truncated, missingKey]) {
    const signal = await loadGscSignal({ now, siteUrl: "sc-domain:x.com", serviceAccountJson: bad });
    assert.equal(signal.status, "malformed");
    assert.match(signal.message ?? "", /service.account/i);
    const page = await loadGscPageSignal({ now, siteUrl: "sc-domain:x.com", serviceAccountJson: bad });
    assert.equal(page.status, "malformed");
    assert.match(page.message ?? "", /service.account/i);
  }
});

test("a query at the inclusive maximum position still earns opportunity", () => {
  const byPage = new Map([["https://www.example.com/blog/edge", rows({ query: "edge q", impressions: 4000, position: 20 })]]);
  const posts = [{ slug: "edge", url: "https://www.example.com/blog/edge", date: "2026-01-01" }];
  const target = pickRefreshTarget({ byPage, posts, now: new Date("2026-09-06T12:00:00Z") });
  assert.equal(target?.slug, "edge", "position 20 is inside the documented 4-20 window, so it must be selectable");
  assert.ok((target?.opportunity ?? 0) > 0);
});
