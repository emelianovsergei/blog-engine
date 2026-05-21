import assert from "node:assert/strict";
import test from "node:test";
import { categorizePost, categorizeText, summarizeRecentCategories } from "../categories.js";
import { HVAC_APPLIANCE_CATEGORIES } from "../config.js";
import { samplePosts } from "./fakes.js";

const cats = HVAC_APPLIANCE_CATEGORIES;

test("categorizeText matches by category keywords", () => {
  assert.equal(categorizeText(cats, "AC repair tips for summer"), "hvac");
  assert.equal(categorizeText(cats, "Refrigerator maintenance basics"), "appliance");
  assert.equal(categorizeText(cats, "SMUD rebate guide for homeowners"), "rebate");
});

test("categorizeText uses whole-word matching, not substrings", () => {
  // "ac" must not match inside "Backyard"; with no keyword hit it falls back
  // to the last category (the broad catch-all).
  assert.equal(categorizeText(cats, "Backyard landscaping ideas"), "hvac");
});

test("rebate is checked before hvac for posts mentioning both", () => {
  assert.equal(categorizeText(cats, "SMUD heat pump rebate program"), "rebate");
});

test("categorizePost categorizes from title, tags, and description", () => {
  assert.equal(categorizePost(cats, samplePosts[0]!), "hvac");
  assert.equal(categorizePost(cats, samplePosts[1]!), "appliance");
  assert.equal(categorizePost(cats, samplePosts[2]!), "rebate");
});

test("summarizeRecentCategories flags an over-represented category", () => {
  const posts = [
    { ...samplePosts[0]!, slug: "a" },
    { ...samplePosts[0]!, slug: "b" },
    { ...samplePosts[2]!, slug: "c" },
  ];
  const mix = summarizeRecentCategories(cats, posts);
  assert.deepEqual(mix.ordered, ["hvac", "hvac", "rebate"]);
  assert.deepEqual(mix.overrepresented, ["hvac"]);
});

test("summarizeRecentCategories reports nothing over-represented for a balanced mix", () => {
  const mix = summarizeRecentCategories(cats, samplePosts);
  assert.deepEqual(mix.overrepresented, []);
});
