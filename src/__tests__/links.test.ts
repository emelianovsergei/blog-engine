import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_LINK_POLICY,
  checkLink,
  checkLinks,
  citationGuidance,
  extractLinks,
  parseLinkPolicy,
  policyViolation,
} from "../links.js";

/** Build a minimal Response-alike for the injectable fetch. */
function res(status: number, finalUrl: string, body = ""): Response {
  return {
    status,
    url: finalUrl,
    text: async () => body,
  } as unknown as Response;
}

test("parseLinkPolicy reads the denied fragments and normalizes case", () => {
  const policy = parseLinkPolicy({
    deniedUrlFragments: ["energy.gov/EnergySaver/", "energystar.gov/campaign/"],
    preferredCitationDomains: ["smud.org"],
    bannedCitationDomains: ["competitor-hvac.com"],
  });
  assert.deepEqual(policy.deniedUrlFragments, [
    "energy.gov/energysaver/",
    "energystar.gov/campaign/",
  ]);
  assert.deepEqual(policy.preferredCitationDomains, ["smud.org"]);
  assert.deepEqual(policy.bannedCitationDomains, ["competitor-hvac.com"]);
});

test("parseLinkPolicy tolerates junk and missing fields", () => {
  assert.deepEqual(parseLinkPolicy(null), EMPTY_LINK_POLICY);
  assert.deepEqual(parseLinkPolicy({}), EMPTY_LINK_POLICY);
  assert.deepEqual(parseLinkPolicy({ deniedUrlFragments: ["ok", 42, null, "  "] }), {
    ...EMPTY_LINK_POLICY,
    deniedUrlFragments: ["ok"],
  });
});

test("policyViolation catches the exact URLs that broke run 30153351381", () => {
  const policy = parseLinkPolicy({
    deniedUrlFragments: ["energy.gov/energysaver/", "energystar.gov/campaign/"],
  });
  assert.match(
    policyViolation("https://www.energy.gov/energysaver/maintaining-your-air-conditioner", policy)!,
    /known-dead/,
  );
  assert.match(
    policyViolation("https://www.energystar.gov/campaign/heating_cooling", policy)!,
    /known-dead/,
  );
  // A live sibling under the same domain must still pass.
  assert.equal(policyViolation("https://www.energy.gov/eere/buildings", policy), undefined);
});

test("policyViolation matches regardless of the URL's casing", () => {
  const policy = parseLinkPolicy({ deniedUrlFragments: ["energy.gov/energysaver/"] });
  assert.ok(policyViolation("https://WWW.ENERGY.GOV/EnergySaver/Foo", policy));
});

test("policyViolation rejects a banned citation domain and its subdomains", () => {
  const policy = parseLinkPolicy({ bannedCitationDomains: ["competitor-hvac.com"] });
  assert.match(policyViolation("https://www.competitor-hvac.com/blog", policy)!, /banned/);
  assert.equal(policyViolation("https://not-competitor-hvac.community.org/x", policy), undefined);
});

test("extractLinks pulls markdown body links and frontmatter citation urls", () => {
  const mdx = [
    "---",
    "title: Test",
    "citations:",
    '  - name: DOE',
    '    url: "https://www.energy.gov/energysaver/foo"',
    "---",
    "",
    "Body text with [a link](https://example.com/a) and an <https://example.com/b> autolink.",
    "",
    'An HTML <a href="https://example.com/c">anchor</a> too.',
  ].join("\n");
  const links = extractLinks(mdx);
  assert.deepEqual(links.sort(), [
    "https://example.com/a",
    "https://example.com/b",
    "https://example.com/c",
    "https://www.energy.gov/energysaver/foo",
  ]);
});

test("extractLinks ignores relative and mailto/tel links", () => {
  const mdx = "See [services](/services/ac-repair), [call](tel:+19168502221), [mail](mailto:a@b.co).";
  assert.deepEqual(extractLinks(mdx), []);
});

test("extractLinks de-duplicates and strips trailing markdown punctuation", () => {
  const mdx = "[a](https://example.com/x) and [b](https://example.com/x) and <https://example.com/x>";
  assert.deepEqual(extractLinks(mdx), ["https://example.com/x"]);
});

test("extractLinks keeps balanced parentheses inside a markdown destination", () => {
  // Truncating this at the first `)` yields a URL that really does 404, so the
  // sweep would "repair" a perfectly live citation.
  const mdx = [
    "[source](https://en.wikipedia.org/wiki/Heat_pump_(heating))",
    "and [plain](https://example.com/page) too.",
    "A bare one in prose (https://example.com/bare) as well.",
  ].join("\n");
  assert.deepEqual(extractLinks(mdx).sort(), [
    "https://en.wikipedia.org/wiki/Heat_pump_(heating)",
    "https://example.com/bare",
    "https://example.com/page",
  ]);
});

test("extractLinks strips a trailing period that follows a closing parenthesis", () => {
  const mdx = "See [x](https://example.com/a_(b)). Done.";
  assert.deepEqual(extractLinks(mdx), ["https://example.com/a_(b)"]);
});

test("checkLink reports a 404 as dead", async () => {
  const out = await checkLink("https://example.com/gone", {
    fetchImpl: async () => res(404, "https://example.com/gone"),
    retries: 0,
  });
  assert.equal(out.ok, false);
  assert.equal(out.status, 404);
  assert.match(out.reason!, /404/);
});

test("checkLink flags a soft-404 that redirects a deep path to the site root", async () => {
  // This is precisely the retired DOE Energy Saver tree: 200 OK, but the deep
  // consumer path now lands on the homepage, so the citation is meaningless.
  const out = await checkLink("https://www.energy.gov/energysaver/maintaining-your-ac", {
    fetchImpl: async () => res(200, "https://www.energy.gov/"),
    retries: 0,
  });
  assert.equal(out.ok, false);
  assert.match(out.reason!, /redirect(ed)? to the site root/i);
});

test("checkLink allows a redirect that keeps a real path", async () => {
  const out = await checkLink("http://example.com/a", {
    fetchImpl: async () => res(200, "https://example.com/a/"),
    retries: 0,
  });
  assert.equal(out.ok, true);
});

test("checkLink allows a root URL that stays at the root", async () => {
  const out = await checkLink("https://www.energystar.gov/", {
    fetchImpl: async () => res(200, "https://www.energystar.gov/"),
    retries: 0,
  });
  assert.equal(out.ok, true);
});

test("checkLink sends a real browser User-Agent", async () => {
  let seen: string | undefined;
  await checkLink("https://example.com/a", {
    retries: 0,
    fetchImpl: async (_url, init) => {
      seen = (init?.headers as Record<string, string>)["User-Agent"];
      return res(200, "https://example.com/a");
    },
  });
  assert.match(seen!, /Mozilla\/5\.0.*Chrome/);
});

test("checkLink retries a transient network error before giving up", async () => {
  let calls = 0;
  const out = await checkLink("https://example.com/a", {
    retries: 2,
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) throw new Error("ECONNRESET");
      return res(200, "https://example.com/a");
    },
  });
  assert.equal(out.ok, true);
  assert.equal(calls, 3);
});

test("checkLink treats an exhausted retry budget as unverified, not dead", async () => {
  // A network flake must never silently delete a citation — it is reported
  // separately so the caller can keep the link and warn instead.
  const out = await checkLink("https://example.com/a", {
    retries: 1,
    retryDelayMs: 0,
    fetchImpl: async () => {
      throw new Error("ETIMEDOUT");
    },
  });
  assert.equal(out.ok, false);
  assert.equal(out.unverified, true);
  assert.match(out.reason!, /unreachable/i);
});

test("checkLink treats 403/429 bot-blocks as unverified rather than dead", async () => {
  for (const status of [403, 429]) {
    const out = await checkLink("https://example.com/a", {
      retries: 0,
      fetchImpl: async () => res(status, "https://example.com/a"),
    });
    assert.equal(out.ok, false, `status ${status}`);
    assert.equal(out.unverified, true, `status ${status} should be unverified`);
  }
});

test("checkLink retries a 5xx and accepts the page once the origin recovers", async () => {
  let calls = 0;
  const out = await checkLink("https://example.com/a", {
    retries: 2,
    retryDelayMs: 0,
    fetchImpl: async () => {
      calls += 1;
      return calls < 3 ? res(503, "https://example.com/a") : res(200, "https://example.com/a");
    },
  });
  assert.equal(out.ok, true);
  assert.equal(calls, 3);
});

test("checkLink treats a persistent 5xx as unverified, never as dead", async () => {
  // An origin outage must not delete a valid citation or discard the post.
  for (const status of [500, 502, 503]) {
    let calls = 0;
    const out = await checkLink("https://example.com/a", {
      retries: 1,
      retryDelayMs: 0,
      fetchImpl: async () => {
        calls += 1;
        return res(status, "https://example.com/a");
      },
    });
    assert.equal(out.ok, false, `status ${status}`);
    assert.equal(out.unverified, true, `status ${status} should be unverified`);
    assert.equal(calls, 2, `status ${status} should use the retry budget`);
  }
});

test("checkLinks resolves every url and reuses one result per unique url", async () => {
  let calls = 0;
  const results = await checkLinks(
    ["https://example.com/a", "https://example.com/b", "https://example.com/a"],
    {
      retries: 0,
      concurrency: 2,
      fetchImpl: async (url) => {
        calls += 1;
        return res(url.endsWith("/b") ? 404 : 200, url);
      },
    },
  );
  assert.equal(calls, 2);
  assert.equal(results.get("https://example.com/a")!.ok, true);
  assert.equal(results.get("https://example.com/b")!.ok, false);
});

test("citationGuidance names denied fragments so the planner avoids them", () => {
  const guidance = citationGuidance(
    parseLinkPolicy({
      deniedUrlFragments: ["energy.gov/energysaver/"],
      preferredCitationDomains: ["smud.org", "cslb.ca.gov"],
    }),
  );
  assert.match(guidance, /energy\.gov\/energysaver\//);
  assert.match(guidance, /smud\.org/);
  assert.match(guidance, /NEVER/);
});

test("citationGuidance is empty when the policy is empty", () => {
  assert.equal(citationGuidance(EMPTY_LINK_POLICY), "");
});
