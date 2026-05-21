import assert from "node:assert/strict";
import test from "node:test";
import { getSeasonContext, seasonForMonth } from "../season.js";

test("seasonForMonth maps months to seasons", () => {
  assert.equal(seasonForMonth(1), "Winter");
  assert.equal(seasonForMonth(2), "Winter");
  assert.equal(seasonForMonth(4), "Spring");
  assert.equal(seasonForMonth(7), "Summer");
  assert.equal(seasonForMonth(9), "Summer");
  assert.equal(seasonForMonth(11), "Fall");
  assert.equal(seasonForMonth(12), "Winter");
});

test("getSeasonContext returns season, month name, and climate", () => {
  const ctx = getSeasonContext(new Date("2026-07-15T19:00:00Z"), "America/Los_Angeles");
  assert.equal(ctx.season, "Summer");
  assert.equal(ctx.monthName, "July");
  assert.match(ctx.climate, /summer/i);
});

test("getSeasonContext respects the timezone at a day boundary", () => {
  // 2026-01-01 06:00 UTC is still Dec 31 in Los Angeles.
  const ctx = getSeasonContext(new Date("2026-01-01T06:00:00Z"), "America/Los_Angeles");
  assert.equal(ctx.monthName, "December");
  assert.equal(ctx.season, "Winter");
});
