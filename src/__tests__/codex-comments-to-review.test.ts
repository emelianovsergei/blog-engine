import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const script = join(root, "examples/scripts/codex-comments-to-review.sh");

const P1_BODY =
  "**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Remove the unverified service-call anecdote**\n\n" +
  "A repo-wide search finds no supporting job record. Replace it with a hypothetical example.\n\n" +
  "Useful? React with 👍 / 👎.";

const P2_BODY =
  "**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>  Stop presenting the seven-day peak AQI as today's reading**\n\n" +
  "The generation report records 54 only as the maximum AQI in a seven-day forecast.\n\n" +
  "Useful? React with 👍 / 👎.";

const P0_BODY =
  "**<sub><sub>![P0 Badge](https://img.shields.io/badge/P0-red?style=flat)</sub></sub>  Do not tell readers to stay in a gas leak**\n\n" +
  "Evacuate and call the utility from outside before any diagnosis.\n\n" +
  "Useful? React with 👍 / 👎.";

function run(input: unknown): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("bash", [script], {
    cwd: root,
    encoding: "utf8",
    input: JSON.stringify(input),
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

test("maps Codex P0/P1 comments into ReviewResult issues and drops P2", () => {
  const { status, stdout } = run([
    {
      body: P1_BODY,
      path: "content/blog/sacramento-duct-cleaning-fair-oaks-wildfire-attic.mdx",
      line: 90,
    },
    {
      body: P2_BODY,
      path: "content/blog/sacramento-duct-cleaning-fair-oaks-wildfire-attic.mdx",
      line: 83,
    },
    {
      body: P0_BODY,
      path: "content/blog/gas-cooktop-clicking-not-lighting-rocklin-summer.mdx",
      line: 46,
    },
  ]);
  assert.equal(status, 0);
  const result = JSON.parse(stdout) as {
    pass: boolean;
    issues: Array<{
      dimension: string;
      severity: string;
      message: string;
      suggestion: string;
      location?: string;
    }>;
    suggestions: string[];
    thresholdReasoning: string;
  };
  assert.equal(result.pass, false);
  assert.equal(result.suggestions.length, 0);
  assert.match(result.thresholdReasoning, /P0\/P1 only/i);
  assert.equal(result.issues.length, 2);

  const p0 = result.issues.find((i) => i.severity === "blocker");
  const p1 = result.issues.find((i) => i.severity === "major");
  assert.ok(p0);
  assert.ok(p1);
  assert.equal(p0.dimension, "contentQuality");
  assert.equal(p1.dimension, "contentQuality");
  assert.equal(
    p0.location,
    "content/blog/gas-cooktop-clicking-not-lighting-rocklin-summer.mdx:46",
  );
  assert.equal(
    p1.location,
    "content/blog/sacramento-duct-cleaning-fair-oaks-wildfire-attic.mdx:90",
  );
  assert.match(p1.message, /Remove the unverified service-call anecdote/i);
  assert.doesNotMatch(p1.message, /P1 Badge|img\.shields|Useful\?/i);
  assert.doesNotMatch(p1.suggestion, /Useful\?/i);
  assert.ok(!result.issues.some((i) => /AQI/i.test(i.message)));
});

test("exits 2 with empty issues when only P2 comments are present", () => {
  const { status, stdout } = run([
    {
      body: P2_BODY,
      path: "content/blog/foo.mdx",
      line: 1,
    },
  ]);
  assert.equal(status, 2);
  const result = JSON.parse(stdout) as { pass: boolean; issues: unknown[] };
  assert.equal(result.issues.length, 0);
  assert.equal(result.pass, true);
});
