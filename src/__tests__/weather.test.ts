import assert from "node:assert/strict";
import test from "node:test";
import { buildWeatherContext, classifyAnomaly } from "../weather.js";

test("classifyAnomaly detects a heat wave (2+ days at/over 100F)", () => {
  assert.equal(classifyAnomaly([101, 99, 103, 90], [60, 62, 64, 58], [0, 0, 0, 0], 40), "heat-wave");
});

test("classifyAnomaly detects a cold snap (2+ days at/under 35F)", () => {
  assert.equal(classifyAnomaly([55, 52, 50], [33, 30, 40], [0, 0, 0], 20), "cold-snap");
});

test("classifyAnomaly detects wildfire smoke from AQI", () => {
  assert.equal(classifyAnomaly([88, 90], [60, 61], [0, 0], 150), "wildfire-smoke");
});

test("classifyAnomaly detects a storm from precipitation", () => {
  assert.equal(classifyAnomaly([60, 58], [48, 47], [3, 30], 25), "storm");
});

test("classifyAnomaly returns none for unremarkable weather", () => {
  assert.equal(classifyAnomaly([78, 80, 82], [55, 57, 56], [0, 1, 0], 35), "none");
});

test("classifyAnomaly prioritises smoke over heat when both apply", () => {
  assert.equal(classifyAnomaly([102, 104], [70, 71], [0, 0], 160), "wildfire-smoke");
});

test("buildWeatherContext summarises extremes and stays available", () => {
  const ctx = buildWeatherContext([101, 103], [70, 71], [0, 0], [55]);
  assert.equal(ctx.anomaly, "heat-wave");
  assert.equal(ctx.maxTempF, 103);
  assert.equal(ctx.minTempF, 70);
  assert.equal(ctx.maxAqi, 55);
  assert.equal(ctx.available, true);
  assert.match(ctx.summary, /heat wave/i);
});
