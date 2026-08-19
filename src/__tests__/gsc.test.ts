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
