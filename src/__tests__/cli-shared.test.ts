import assert from "node:assert/strict";
import test from "node:test";
import { rubricFromFlags } from "../cli/shared.js";

// rubricFromFlags must live in a side-effect-free module: importing it from
// the refresh CLI evaluated that CLI's main() and exited the rewrite command.
test("rubricFromFlags parses pipe-separated headings and the FAQ policy", () => {
  const r = rubricFromFlags("When to Call a Pro|Related Questions", undefined);
  assert.deepEqual(r.requiredHeadings, ["When to Call a Pro", "Related Questions"]);
  assert.equal(r.faqPolicy, "appended-by-code");
  assert.equal(rubricFromFlags(undefined, "written-by-model").faqPolicy, "written-by-model");
  assert.deepEqual(rubricFromFlags(undefined, undefined).requiredHeadings, []);
});

test("rubricFromFlags rejects an unsupported --faq-policy instead of silently defaulting", () => {
  assert.throws(() => rubricFromFlags(undefined, "written-by-modle"), /faq-policy/i);
  assert.throws(() => rubricFromFlags(undefined, "appended"), /faq-policy/i);
  assert.equal(rubricFromFlags(undefined, "appended-by-code").faqPolicy, "appended-by-code");
});
