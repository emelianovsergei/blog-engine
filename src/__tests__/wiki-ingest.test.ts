import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFakeGemini, type GenerateContentCall } from "./fakes.js";
import {
  extractModuleFacts,
  generateModuleFields,
  fieldsFromFacts,
  validateLinks,
  renderModulePage,
  extractCustomNotes,
  sourceHash,
  pageIdFromRelPath,
} from "../wiki/ingest.js";

const SAMPLE = `/**
 * Sample module. Does a thing.
 */
import { foo } from "./client.js";
import type { Bar } from "./types.js";

/** Adds two numbers. */
export function add(a: number, b: number): number { return a + b; }

export const NAME = "x";
`;

const REL = "src/sample.ts";
const ABS = "/abs/src/sample.ts";
const VALID_TARGETS = ["modules/sample", "modules/client", "modules/types", "concepts/quality-gates"];

test("pageIdFromRelPath is collision-free for cli subdir", () => {
  assert.equal(pageIdFromRelPath("src/orchestrator.ts"), "orchestrator");
  assert.equal(pageIdFromRelPath("src/cli/shared.ts"), "cli-shared");
  assert.equal(pageIdFromRelPath("src/cli/review.ts"), "cli-review"); // ≠ "review"
});

test("extractModuleFacts pulls file doc, exports, and local imports", () => {
  const facts = extractModuleFacts(SAMPLE, REL, ABS);
  assert.equal(facts.pageId, "sample");
  assert.match(facts.fileDoc, /Sample module\. Does a thing\./);
  assert.deepEqual(
    facts.exports.map((e) => e.name),
    ["add", "NAME"],
  );
  const add = facts.exports.find((e) => e.name === "add")!;
  assert.equal(add.kind, "function");
  assert.match(add.jsdoc ?? "", /Adds two numbers/);
  assert.deepEqual(facts.imports.sort(), ["client", "types"]);
});

test("sourceHash is stable and content-sensitive", () => {
  assert.equal(sourceHash(SAMPLE), sourceHash(SAMPLE));
  assert.notEqual(sourceHash(SAMPLE), sourceHash(SAMPLE + " "));
});

test("validateLinks drops unknown targets, self-links, and dupes", () => {
  const out = validateLinks(
    ["modules/client", "modules/nonexistent", "modules/sample", "modules/client", "[[modules/types|Types]]"],
    VALID_TARGETS,
    "sample",
  );
  assert.deepEqual(out, ["modules/client", "modules/types"]);
});

test("generateModuleFields uses JSON mode and validates model links", async () => {
  const capture: GenerateContentCall[] = [];
  const client = makeFakeGemini({
    capture,
    candidatesJson: {
      title: "Sample Module",
      description: "A sample.",
      tags: ["a", "b"],
      summary: "Does a thing in the pipeline.",
      exports: [
        { name: "add", explanation: "Adds two numbers." },
        { name: "NAME", explanation: "A constant name." },
      ],
      relatedLinks: ["modules/client", "modules/nonexistent", "modules/sample"],
    },
  });
  const facts = extractModuleFacts(SAMPLE, REL, ABS);
  const fields = await generateModuleFields({ facts, client, model: "test-model", validTargets: VALID_TARGETS });

  assert.equal(fields.title, "Sample Module");
  assert.equal(fields.exports.length, 2);
  // unknown target dropped, self-link dropped:
  assert.deepEqual(fields.relatedLinks, ["modules/client"]);
  // JSON mode was requested with a responseSchema:
  assert.equal(capture.length, 1);
  const cfg = capture[0]!.config as { responseMimeType?: string; responseSchema?: unknown };
  assert.equal(cfg.responseMimeType, "application/json");
  assert.ok(cfg.responseSchema, "a responseSchema should be passed");
});

test("fieldsFromFacts is the offline path — no client, import-seeded links", () => {
  const capture: GenerateContentCall[] = [];
  // (fieldsFromFacts takes no client, so nothing can be captured — asserting the
  // fallback never touches the model.)
  const facts = extractModuleFacts(SAMPLE, REL, ABS);
  const fields = fieldsFromFacts(facts, { title: "Fallback Title" }, VALID_TARGETS);
  assert.equal(capture.length, 0);
  assert.equal(fields.title, "Fallback Title");
  assert.ok(fields.relatedLinks.includes("modules/client"));
  assert.ok(fields.relatedLinks.includes("modules/types"));
});

test("extractCustomNotes preserves an existing notes block; renderModulePage keeps it", () => {
  const existing = `---\ntype: "module"\ntitle: "Old"\n---\n# Old Title\n\nbody\n\n## Custom Notes\n\nKeep me across ingests.\n`;
  const notes = extractCustomNotes(existing);
  assert.match(notes, /Keep me across ingests\./);

  const facts = extractModuleFacts(SAMPLE, REL, ABS);
  const fields = fieldsFromFacts(facts, {}, VALID_TARGETS);
  const md = renderModulePage({ fields, facts, timestamp: "2026-07-11", hash: "deadbeef", customNotes: notes });

  assert.match(md, /source_hash: "deadbeef"/);
  assert.match(md, /## Related/);
  assert.match(md, /\[\[modules\/client\]\]/);
  assert.match(md, /## API Interface/);
  assert.match(md, /### `add`/);
  assert.match(md, /## Custom Notes/);
  assert.match(md, /Keep me across ingests\./);
});

test("extractCustomNotes returns a stub when no prior page exists", () => {
  const notes = extractCustomNotes(undefined);
  assert.match(notes, /## Custom Notes/);
  assert.match(notes, /preserved across ingestion runs/);
});
