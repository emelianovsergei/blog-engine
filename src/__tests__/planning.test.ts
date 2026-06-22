import assert from "node:assert/strict";
import test from "node:test";
import {
  assertTopicAligned,
  topicAlignmentIssue,
  topicLockPlannerRules,
  writerAccuracyRules,
} from "../planning.js";

test("topicAlignmentIssue flags the production #203 mismatch", () => {
  // The real failure: a whole-house-vs-attic-fan post handed a thermostat keyword.
  const issue = topicAlignmentIssue(
    "best thermostat setting for summer",
    "Whole-House Fans vs. Attic Fans: What Cools Sacramento Homes",
  );
  assert.ok(issue, "expected a mismatch to be reported");
  assert.match(issue!, /shares no topic word/);
});

test("topicAlignmentIssue passes an aligned keyword (plural/location tolerant)", () => {
  assert.equal(
    topicAlignmentIssue(
      "whole-house fan vs attic fan sacramento",
      "Whole-House Fans vs. Attic Fans: What Cools Sacramento Homes",
    ),
    null,
  );
});

test("topicAlignmentIssue ignores shared location/filler words only", () => {
  // Both contain "Sacramento" but nothing topical — must still be flagged.
  const issue = topicAlignmentIssue(
    "furnace repair sacramento",
    "Best AC Maintenance Tips for Sacramento Homes",
  );
  assert.ok(issue, "shared location word must not mask a subject mismatch");
});

test("topicAlignmentIssue rejects all-stopword and empty keywords", () => {
  assert.ok(topicAlignmentIssue("best tips for your home", "Furnace Repair Guide"));
  assert.ok(topicAlignmentIssue("", "Furnace Repair Guide"));
  assert.ok(topicAlignmentIssue("furnace repair", ""));
});

test("assertTopicAligned throws on mismatch, passes on alignment", () => {
  assert.throws(
    () => assertTopicAligned("best thermostat setting for summer", "Whole-House vs Attic Fans"),
    /Invalid blog plan/,
  );
  assert.doesNotThrow(() =>
    assertTopicAligned("heat pump installation", "Heat Pump Installation in Sacramento"),
  );
});

test("topicLockPlannerRules states the single-topic + keyword-binding rules", () => {
  const rules = topicLockPlannerRules();
  assert.match(rules, /SINGLE TOPIC/);
  assert.match(rules, /DISCARD/);
  assert.match(rules, /targetKeyword MUST/);
});

test("writerAccuracyRules lists citations and forbids fabricated figures", () => {
  const rules = writerAccuracyRules([
    { name: "DOE", url: "https://energy.gov/whole-house-fans" },
  ]);
  assert.match(rules, /Do NOT invent statistics/);
  assert.match(rules, /energy\.gov\/whole-house-fans/);

  const noCitations = writerAccuracyRules([]);
  assert.match(noCitations, /\(none provided\)/);
});
