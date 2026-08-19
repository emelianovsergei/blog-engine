import { test } from "node:test";
import assert from "node:assert/strict";
import { auditLinks, unlinkDeadUrls, auditAndRepairFile } from "../link-audit.js";
import { parseLinkPolicy, extractLinks } from "../links.js";

// The real pulse policy fragment that the 2026-08-18 auto-fix violated.
const POLICY = parseLinkPolicy({
  deniedUrlFragments: ["energy.gov/energysaver/"],
  deniedUrls: [],
  preferredCitationDomains: [],
  bannedCitationDomains: [],
});

const DENIED = "https://www.energy.gov/energysaver/air-conditioning";

test("policy-only audit issues no network requests", async () => {
  let fetches = 0;
  const fetchImpl = (async () => {
    fetches += 1;
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;

  const result = await auditLinks([DENIED], POLICY, { network: false, fetchImpl });

  assert.equal(fetches, 0);
  assert.equal(result.dead.size, 1);
  assert.match(result.dead.get(DENIED)!, /known-dead URL fragment/);
});

test("an unverifiable link is never treated as dead", async () => {
  const fetchImpl = (async () => new Response("", { status: 403 })) as unknown as typeof fetch;

  const result = await auditLinks(["https://www.ashrae.org/guide"], POLICY, { fetchImpl });

  assert.equal(result.dead.size, 0);
  assert.equal(result.unverified.size, 1);
});

test("extractLinks finds schemeless URLs only when asked", () => {
  const prose = "see energy.gov/energysaver/thermostats for details";

  assert.deepEqual(extractLinks(prose), []);
  assert.deepEqual(extractLinks(prose, { includeSchemeless: true }), [
    "energy.gov/energysaver/thermostats",
  ]);
});

test("prose that merely names an organisation is not mistaken for a URL", () => {
  const prose = "The U.S. Dept. of Energy says so. Costs vary (e.g. 10%).";
  assert.deepEqual(extractLinks(prose, { includeSchemeless: true }), []);
});

test("a schemeless denylisted URL is caught by the policy pass", async () => {
  const result = await auditLinks(["energy.gov/energysaver/thermostats"], POLICY, {
    network: false,
  });

  assert.equal(result.dead.size, 1);
});

test("unlinkDeadUrls keeps the sentence and drops the link", () => {
  const body = `The [DOE overview](${DENIED}) explains airflow.`;
  const out = unlinkDeadUrls(body, new Map([[DENIED, "policy"]]));

  assert.ok(!out.includes(DENIED));
  assert.match(out, /DOE overview/);
  assert.match(out, /explains airflow/);
});

test("auditAndRepairFile removes a denylisted body link and reports it", async () => {
  const raw = `---\ntitle: Test\n---\n\nThe [DOE overview](${DENIED}) explains airflow.\n`;

  const { text, audit } = await auditAndRepairFile(raw, POLICY, { network: false });

  assert.ok(!text.includes(DENIED));
  assert.equal(audit.removed.length, 1);
  assert.equal(audit.unresolved.length, 0);
  assert.match(text, /^---\ntitle: Test\n---/);
});

test("auditAndRepairFile strips a dead URL out of frontmatter citations", async () => {
  const raw = `---\ntitle: Test\ncitations:\n  - name: DOE\n    url: ${DENIED}\n  - name: ASHRAE\n    url: https://www.ashrae.org\n---\n\nBody text.\n`;

  const { text, audit } = await auditAndRepairFile(raw, POLICY, { network: false });

  assert.ok(!text.includes(DENIED));
  assert.ok(!/url:\s*(''|""|$)/m.test(text), "must not leave an empty url behind");
  assert.match(text, /ashrae\.org/);
  assert.equal(audit.removed.length, 1);
});

test("a bare URL left in prose is reported as unresolved rather than silently kept", async () => {
  const raw = `---\ntitle: Test\n---\n\nSee energy.gov/energysaver/thermostats for details.\n`;

  const { audit } = await auditAndRepairFile(raw, POLICY, { network: false });

  assert.equal(audit.removed.length, 1);
  assert.equal(audit.unresolved.length, 1, "prose URL survives repair and needs a human");
});
