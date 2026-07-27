import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "yaml";
import { extractLinks } from "../links.js";
import { repairContent, stripDeadCitations, unlinkUrl } from "../link-repair.js";

// These primitives rewrite published posts unattended, in every consumer repo at
// once. This file is the reason they live in the engine rather than being copied
// into each site: every case below is a defect that shipped in two repositories
// simultaneously, and was found in whichever one happened to be reviewed first.

const DEAD = "https://example.gov/gone";

test("unlinks the dead destination and keeps the sentence", () => {
  const body = `Per the [DOE guide](${DEAD}), sizing matters.`;
  assert.equal(unlinkUrl(body, DEAD, [DEAD]), "Per the DOE guide, sizing matters.");
});

test("leaves a healthy link whose URL merely starts with the dead one", () => {
  // `/page` retired, `/page/details` alive — an unbounded destination match
  // unlinks both and mangles the survivor into `/details`.
  const dead = "https://example.com/page";
  const alive = "https://example.com/page/details";
  assert.equal(
    unlinkUrl(`See [old](${dead}) and [current](${alive}).`, dead, [dead, alive]),
    `See old and [current](${alive}).`,
  );
});

test("leaves a bare healthy URL that extends the dead one", () => {
  const dead = "https://example.com/page";
  const alive = "https://example.com/page/details";
  assert.equal(unlinkUrl(`Read ${alive} today.`, dead, [dead, alive]), `Read ${alive} today.`);
});

test("handles a destination carrying a markdown title", () => {
  assert.equal(unlinkUrl(`A [guide](${DEAD} "DOE guide") here.`, DEAD, [DEAD]), "A guide here.");
});

test("refuses to rewrite prose where the URL is the object of the sentence", () => {
  // Deleting the URL leaves published text that reads as broken, so the sweep
  // leaves these, reports them, and withholds the policy denial until a human
  // rewrites the sentence.
  for (const body of [
    `Rebates vary — see ${DEAD} for current amounts.`,
    `Sources: ${DEAD}, and the CSLB licence lookup.`,
    `- ${DEAD}`,
    `See <${DEAD}> for details.`,
  ]) {
    assert.equal(unlinkUrl(body, DEAD, [DEAD]), body, body);
  }
});

test("removes a dead image whole, rather than leaving a stray `!`", () => {
  // `![alt](dead)` differs from a link by one character. Matching the link
  // inside it leaves `!alt` sitting in the published body.
  const dead = "https://example.com/dead.png";
  assert.equal(
    unlinkUrl(`Before ![equipment diagram](${dead}) after.`, dead, [dead]),
    "Before after.",
  );
  assert.equal(unlinkUrl(`![alt](${dead})`, dead, [dead]), "");
  assert.equal(unlinkUrl(`![alt](${dead} "Title")`, dead, [dead]), "");
  // An ordinary link that merely follows a "!" in the prose is untouched.
  assert.equal(unlinkUrl(`Wow! [see this](${dead}) now.`, dead, [dead]), "Wow! see this now.");
});

test("handles a linked image without leaving an empty link or a stray bracket", () => {
  // `[![alt](img)](target)` — both halves can be the dead one, and they call for
  // opposite treatment. Getting either wrong publishes malformed MDX.
  const deadImg = "https://example.com/dead.png";
  const target = "https://example.com/target";
  const deadTarget = "https://example.com/deadtarget";
  const img = "https://example.com/img.png";

  // Dead image, live target: the whole thing goes. Leaving `[](target)` behind
  // would be an empty link — invalid, unreachable by keyboard or screen reader.
  assert.equal(
    unlinkUrl(`See [![badge](${deadImg})](${target}) here.`, deadImg, [deadImg, target]),
    "See here.",
  );

  // Live image, dead target: keep the image, drop the wrapper — the ordinary
  // link rule, where the thing worth keeping happens to be an image.
  assert.equal(
    unlinkUrl(`See [![badge](${img})](${deadTarget}) here.`, deadTarget, [deadTarget, img]),
    `See ![badge](${img}) here.`,
  );

  // A wholly healthy linked image must survive untouched.
  assert.equal(
    unlinkUrl(`See [![b](${img})](${target}) here.`, deadImg, [deadImg, img, target]),
    `See [![b](${img})](${target}) here.`,
  );
});

test("handles balanced parentheses in the surviving half of a linked image", () => {
  // extractLinks preserves balanced parens on purpose, so the sweep does meet
  // these. Stopping at the first `)` chopped the destination mid-URL and
  // published the remainder as prose: `See) here.`
  const deadImg = "https://example.com/dead.png";
  const parenTarget = "https://example.org/wiki/Heat_(HVAC)";
  assert.equal(
    unlinkUrl(`See [![badge](${deadImg})](${parenTarget}) here.`, deadImg, [
      deadImg,
      parenTarget,
    ]),
    "See here.",
  );

  const img = "https://example.com/img.png";
  const deadParen = "https://example.org/wiki/Dead_(HVAC)";
  assert.equal(
    unlinkUrl(`See [![badge](${img})](${deadParen}) here.`, deadParen, [deadParen, img]),
    `See ![badge](${img}) here.`,
  );
});

test("takes emphasis delimiters with a removed image", () => {
  // Removing only the image publishes the bare delimiters as literal text.
  const dead = "https://example.com/dead.png";
  const target = "https://example.com/target";
  for (const [open, close] of [
    ["**", "**"],
    ["*", "*"],
    ["__", "__"],
    ["_", "_"],
  ]) {
    assert.equal(
      unlinkUrl(`Before ${open}![alt](${dead})${close} after.`, dead, [dead]),
      "Before after.",
      `${open}…${close}`,
    );
  }
  // Emphasis around a doomed *linked* image goes too.
  assert.equal(
    unlinkUrl(`See **[![b](${dead})](${target})** here.`, dead, [dead, target]),
    "See here.",
  );
  // Unrelated emphasis in the same sentence is untouched.
  assert.equal(
    unlinkUrl(`Before **bold** and [x](${dead}) after.`, dead, [dead]),
    "Before **bold** and x after.",
  );
});

test("removes a URL that is a parenthetical aside", () => {
  assert.equal(unlinkUrl(`Rebates vary (${DEAD}) by utility.`, DEAD, [DEAD]), "Rebates vary by utility.");
  assert.equal(
    unlinkUrl(`Rebates vary (<${DEAD}>) by utility.`, DEAD, [DEAD]),
    "Rebates vary by utility.",
  );
});

test("preserves indentation everywhere in the document", () => {
  // Indentation is semantic in Markdown. A document-wide whitespace collapse
  // un-nests list items and turns indented code blocks into paragraphs —
  // including in passages that never contained the dead link.
  const body = [
    "- top level",
    `  - nested item with [a dead link](${DEAD})`,
    "    - deeper still",
    "",
    "      indented code block, four+ spaces",
    "",
    "Prose   with   deliberate   spacing.",
  ].join("\n");

  const out = unlinkUrl(body, DEAD, [DEAD]);

  assert.ok(out.includes("  - nested item with a dead link"));
  assert.ok(out.includes("    - deeper still"));
  assert.ok(out.includes("      indented code block, four+ spaces"));
  assert.ok(out.includes("Prose   with   deliberate   spacing."));
  assert.ok(!out.includes(DEAD));
});

test("closes the gap left by a removed aside without touching the rest", () => {
  assert.equal(unlinkUrl(`Source (${DEAD}) here.`, DEAD, [DEAD]), "Source here.");
});

test("joins the surviving words correctly however the parenthetical was spaced", () => {
  // The separator depends on the characters that end up adjacent, not on how
  // much whitespace the removed span carried. Keying off the captured
  // whitespace welds words together on one side and strands punctuation on the
  // other.
  const cases: Array<[string, string]> = [
    [`See (${DEAD}) for details.`, "See for details."],
    [`See(${DEAD}) for details.`, "See for details."],
    [`See (${DEAD})for details.`, "See for details."],
    [`See(${DEAD})for details.`, "See for details."],
    // No separator where one side is punctuation or a boundary.
    [`Rebates vary (${DEAD}).`, "Rebates vary."],
    [`Rebates vary (${DEAD}), roughly.`, "Rebates vary, roughly."],
    [`(${DEAD})`, ""],
  ];
  for (const [input, expected] of cases) {
    assert.equal(unlinkUrl(input, DEAD, [DEAD]), expected, input);
  }
});

const MDX = [
  "---",
  "title: Test post",
  "citations:",
  "  - name: Dead authority",
  `    url: '${DEAD}'`,
  "  - name: Live authority",
  "    url: 'https://example.gov/alive'",
  "---",
  "",
  "Body text.",
  "",
].join("\n");

test("citations: removes the whole entry, never just its url", () => {
  const { text, removed } = stripDeadCitations(MDX, new Set([DEAD]));
  assert.equal(removed, 1);
  // An emptied `url` would reach a consumer's JSON-LD builder verbatim.
  assert.ok(!text.includes("url: ''"));
  assert.ok(!text.includes('url: ""'));
  assert.ok(!text.includes("Dead authority"));
  assert.ok(text.includes("Live authority"));
  assert.ok(text.includes("https://example.gov/alive"));
  assert.ok(text.includes("Body text."));
});

test("citations: drops the key entirely when every entry is dead", () => {
  const { text, removed } = stripDeadCitations(
    MDX,
    new Set([DEAD, "https://example.gov/alive"]),
  );
  assert.equal(removed, 2);
  assert.ok(!text.includes("citations:"));
  assert.ok(text.includes("title: Test post"));
});

test("citations: leaves the file untouched when none is dead", () => {
  const { text, removed } = stripDeadCitations(MDX, new Set(["https://example.gov/other"]));
  assert.equal(removed, 0);
  assert.equal(text, MDX);
});

test("citations: tolerates a post with no frontmatter", () => {
  const { text, removed } = stripDeadCitations("Just body.", new Set(["https://a.co/b"]));
  assert.equal(removed, 0);
  assert.equal(text, "Just body.");
});

test("repairContent keeps the frontmatter parseable — prose rules must not reach YAML", () => {
  // unlinkUrl collapses runs of spaces, which is correct for a sentence and
  // fatal for a YAML block: flattening the indentation detaches `url:` from its
  // `- name:` and corrupts every citation in the file.
  const mdx = [
    "---",
    "title: 'Fixture: repair'",
    "citations:",
    "  - name: Dead authority",
    `    url: '${DEAD}'`,
    "  - name: Live authority",
    "    url: 'https://smud.org/rebates'",
    "---",
    "",
    `Per the [dead guide](${DEAD}), sizing matters.`,
    "",
  ].join("\n");

  const { text, citationsRemoved } = repairContent(mdx, new Set([DEAD]), [
    DEAD,
    "https://smud.org/rebates",
  ]);
  assert.equal(citationsRemoved, 1);

  const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(frontmatter !== null);

  const parsed = parse(frontmatter![1]!) as { title: string; citations: { url: string }[] };
  assert.equal(parsed.title, "Fixture: repair");
  assert.deepEqual(parsed.citations, [
    { name: "Live authority", url: "https://smud.org/rebates" },
  ]);
  assert.ok(text.includes("Per the dead guide, sizing matters."));
  assert.ok(!text.includes(DEAD));
});

test("a repaired file reports no leftover when only a longer sibling remains", () => {
  // The sweep decides whether a URL is 'unresolved' from what survives, and
  // withholds its policy denial when it is. A substring test is true whenever
  // the healthy `/details` link survives — so the denial is withheld and the
  // generator is free to cite the dead URL again. Membership must be by exact
  // link.
  const short = "https://example.com/page";
  const long = "https://example.com/page/details";
  const repaired = unlinkUrl(`See [old](${short}) and [current](${long}).`, short, [short, long]);

  assert.ok(repaired.includes(long));
  assert.ok(repaired.includes(short)); // substring test would misfire
  assert.ok(!new Set(extractLinks(repaired)).has(short)); // exact test is right
});
