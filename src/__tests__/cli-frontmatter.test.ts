import assert from "node:assert/strict";
import test from "node:test";
import { parseDocument, serializeDocument } from "../cli/frontmatter.js";

const sample = `---
title: How to Prep Your AC
description: A short Sacramento guide.
slug: prep-your-ac
date: 2026-06-01
category: cooling
tags:
  - cooling
  - heat wave
---

# How to Prep Your AC

Body paragraph.

## Section
More body.
`;

test("parseDocument extracts frontmatter and body", () => {
  const { frontmatter, body } = parseDocument(sample);
  assert.equal(frontmatter.title, "How to Prep Your AC");
  assert.equal(frontmatter.description, "A short Sacramento guide.");
  assert.equal(frontmatter.slug, "prep-your-ac");
  assert.equal(frontmatter.date, "2026-06-01");
  assert.equal(frontmatter.category, "cooling");
  assert.deepEqual(frontmatter.tags, ["cooling", "heat wave"]);
  assert.match(body, /^# How to Prep Your AC/);
  assert.match(body, /## Section/);
});

test("parseDocument accepts inline arrays for tags", () => {
  const src = `---\ntitle: T\ntags: [a, b, c]\n---\nbody\n`;
  const { frontmatter } = parseDocument(src);
  assert.deepEqual(frontmatter.tags, ["a", "b", "c"]);
});

test("parseDocument unquotes string scalars", () => {
  const src = `---\ntitle: "Quoted: with colon"\ndescription: 'single-quoted'\n---\nbody\n`;
  const { frontmatter } = parseDocument(src);
  assert.equal(frontmatter.title, "Quoted: with colon");
  assert.equal(frontmatter.description, "single-quoted");
});

test("parseDocument throws when leading fence is missing", () => {
  assert.throws(() => parseDocument("no fence here\nbody"), /leading.*frontmatter fence/);
});

test("parseDocument throws when closing fence is missing", () => {
  assert.throws(
    () => parseDocument(`---\ntitle: x\n\nno closing fence here`),
    /closing.*frontmatter fence/,
  );
});

test("parseDocument tolerates an empty tags block", () => {
  const src = `---\ntitle: x\ntags:\n---\nbody\n`;
  const { frontmatter } = parseDocument(src);
  assert.deepEqual(frontmatter.tags, []);
});

test("parseDocument reads folded block scalars (>-) as joined single-line text", () => {
  // This is exactly what gray-matter / js-yaml emit for a long description.
  const src = `---
title: Furnace Prep
metaDescription: >-
  Prepare your Sacramento furnace for summer dormancy with essential steps.
  Learn how to safely shut down your system and save energy.
description: >-
  Learn the practical steps Sacramento homeowners can take to safely shut down
  their furnace for the warm months, extending system life and preventing
  issues.
date: 2026-05-31
slug: furnace-prep
---
body
`;
  const { frontmatter } = parseDocument(src);
  assert.equal(
    frontmatter.metaDescription,
    "Prepare your Sacramento furnace for summer dormancy with essential steps. Learn how to safely shut down your system and save energy.",
  );
  assert.equal(
    frontmatter.description,
    "Learn the practical steps Sacramento homeowners can take to safely shut down their furnace for the warm months, extending system life and preventing issues.",
  );
  // The scalar after the folded block must still parse — not be swallowed.
  assert.equal(frontmatter.date, "2026-05-31");
  assert.equal(frontmatter.slug, "furnace-prep");
});

test("parseDocument reads literal block scalars (|) preserving line breaks", () => {
  const src = `---
title: T
note: |-
  line one
  line two
slug: t
---
body
`;
  const { frontmatter } = parseDocument(src);
  assert.equal(frontmatter.note, "line one\nline two");
  assert.equal(frontmatter.slug, "t");
});

test("parseDocument handles a folded scalar immediately followed by a block list", () => {
  const src = `---
description: >-
  A folded summary that spans
  two physical lines.
tags:
  - furnace
  - summer prep
---
body
`;
  const { frontmatter } = parseDocument(src);
  assert.equal(frontmatter.description, "A folded summary that spans two physical lines.");
  assert.deepEqual(frontmatter.tags, ["furnace", "summer prep"]);
});

test("serializeDocument round-trips through parseDocument", () => {
  const { frontmatter, body } = parseDocument(sample);
  const serialized = serializeDocument(frontmatter, body);
  const reparsed = parseDocument(serialized);
  assert.equal(reparsed.frontmatter.title, frontmatter.title);
  assert.equal(reparsed.frontmatter.description, frontmatter.description);
  assert.equal(reparsed.frontmatter.slug, frontmatter.slug);
  assert.equal(reparsed.frontmatter.category, frontmatter.category);
  assert.deepEqual(reparsed.frontmatter.tags, frontmatter.tags);
  // Body is preserved verbatim (modulo leading newline normalization).
  assert.equal(reparsed.body.trim(), body.trim());
});

test("serializeDocument quotes values containing reserved characters", () => {
  const out = serializeDocument(
    { title: "Title: with colon", description: "ok" },
    "body\n",
  );
  // The colon-containing value must be JSON-quoted so YAML parses it back correctly.
  assert.match(out, /title: "Title: with colon"/);
  const { frontmatter } = parseDocument(out);
  assert.equal(frontmatter.title, "Title: with colon");
});

test("serializeDocument places preferred keys before extras and preserves them", () => {
  const out = serializeDocument(
    {
      title: "X",
      description: "d",
      customField: "preserved",
      slug: "x",
    },
    "body\n",
  );
  const titleIdx = out.indexOf("title:");
  const slugIdx = out.indexOf("slug:");
  const customIdx = out.indexOf("customField:");
  assert.ok(titleIdx < slugIdx, "title should appear before slug");
  assert.ok(slugIdx < customIdx, "preferred keys should precede extras");
  const { frontmatter } = parseDocument(out);
  assert.equal(frontmatter.customField, "preserved");
});
