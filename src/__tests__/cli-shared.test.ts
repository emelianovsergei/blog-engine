import assert from "node:assert/strict";
import test from "node:test";
import { composeConfig, optionalFlag, parseArgs, requireFlag } from "../cli/shared.js";
import { HVAC_APPLIANCE_CATEGORIES, HVAC_CATEGORIES } from "../config.js";

test("parseArgs handles --flag value and --flag=value forms", () => {
  const args = parseArgs(["--site", "pulse", "--business=HVAC Pulse"]);
  assert.equal(args.flags.get("site"), "pulse");
  assert.equal(args.flags.get("business"), "HVAC Pulse");
});

test("parseArgs treats a flag with no following non-flag token as boolean (--help at end)", () => {
  const args = parseArgs(["--site", "pulse", "--help"]);
  assert.equal(args.flags.get("site"), "pulse");
  assert.equal(args.flags.get("help"), "true");
});

test("parseArgs treats a flag immediately followed by another --flag as boolean", () => {
  const args = parseArgs(["--dry-run", "--site", "pulse"]);
  assert.equal(args.flags.get("dry-run"), "true");
  assert.equal(args.flags.get("site"), "pulse");
});

test("requireFlag returns the CLI value when present", () => {
  const args = parseArgs(["--site", "pulse"]);
  assert.equal(requireFlag(args, "site"), "pulse");
});

test("requireFlag falls back to BLOG_ENGINE_* env var when CLI flag is absent", () => {
  const args = parseArgs([]);
  process.env.BLOG_ENGINE_SITE = "pulse";
  try {
    assert.equal(requireFlag(args, "site"), "pulse");
  } finally {
    delete process.env.BLOG_ENGINE_SITE;
  }
});

test("requireFlag throws when neither CLI flag nor env var is set", () => {
  const args = parseArgs([]);
  assert.throws(() => requireFlag(args, "site"), /--site/);
});

test("optionalFlag returns undefined when nothing is set", () => {
  const args = parseArgs([]);
  assert.equal(optionalFlag(args, "model"), undefined);
});

test("composeConfig builds an EngineConfig for the pulse site", () => {
  const args = parseArgs([
    "--site",
    "pulse",
    "--business",
    "HVAC Pulse",
    "--service-areas",
    "Sacramento, Roseville, Folsom",
  ]);
  const config = composeConfig(args);
  assert.equal(config.businessName, "HVAC Pulse");
  assert.deepEqual(config.serviceAreas, ["Sacramento", "Roseville", "Folsom"]);
  assert.equal(config.categories, HVAC_CATEGORIES);
});

test("composeConfig builds an EngineConfig for the promax site", () => {
  const args = parseArgs([
    "--site",
    "promax",
    "--business",
    "Pro Max",
    "--service-areas",
    "Sacramento",
  ]);
  const config = composeConfig(args);
  assert.equal(config.categories, HVAC_APPLIANCE_CATEGORIES);
});

test("composeConfig rejects an unknown site key", () => {
  const args = parseArgs([
    "--site",
    "unknown",
    "--business",
    "x",
    "--service-areas",
    "x",
  ]);
  assert.throws(() => composeConfig(args), /Unknown --site/);
});

test("composeConfig rejects an empty service-areas list", () => {
  const args = parseArgs([
    "--site",
    "pulse",
    "--business",
    "x",
    "--service-areas",
    ",,, ,",
  ]);
  assert.throws(() => composeConfig(args), /service-areas/);
});
