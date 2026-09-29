/**
 * Offline harness for scripts/refresh-blog-post.ts (the weekly refresh job).
 *
 * Fixture mode (BLOG_REFRESH_FIXTURE_DIR) replaces the two network calls:
 *   pages.json   — the Search Console page+query rows loadGscPageSignal would
 *                  return, grouped by URL
 *   refreshed.mdx — what blog-engine-refresh would write for the target
 * Everything else (target selection, cooldown, exclusions, report, no-op
 * path) runs for real. Run with `npm run blog:test-refresh-fixtures`.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import matter from "gray-matter";

const ROOT = path.resolve(__dirname, "..");
const FIXTURE = path.join(ROOT, "tests/fixtures/blog-refresh");

interface RefreshReport {
  status: "prompt" | "refreshed" | "no-target" | "no-signal";
  prompt?: string;
  postDigest?: string;
  slug?: string;
  url?: string;
  queries?: Array<{ query: string; impressions: number; position: number }>;
  excludedSlugs?: string[];
  reason?: string;
  gscStatus?: string;
}

function workspace(): { root: string; contentDir: string; reportsDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blog-refresh-"));
  const contentDir = path.join(root, "content/blog");
  const reportsDir = path.join(root, "data/blog-refresh-runs");
  fs.mkdirSync(contentDir, { recursive: true });
  fs.mkdirSync(reportsDir, { recursive: true });
  for (const f of fs.readdirSync(path.join(FIXTURE, "content"))) {
    fs.copyFileSync(path.join(FIXTURE, "content", f), path.join(contentDir, f));
  }
  return { root, contentDir, reportsDir };
}

/** stdout of the most recent run(); the workflow reads ::error::/::notice:: lines from it. */
let lastStdout = "";

function run(ws: ReturnType<typeof workspace>, extraEnv: Record<string, string> = {}): RefreshReport {
  try {
    lastStdout = execFileSync("npx", ["tsx", "scripts/refresh-blog-post.ts"], {
      cwd: ROOT,
      env: {
        ...process.env,
        BLOG_CONTENT_DIR: ws.contentDir,
        BLOG_REFRESH_REPORTS_DIR: ws.reportsDir,
        BLOG_REFRESH_FIXTURE_DIR: FIXTURE,
        BLOG_GENERATOR_DATE: "2026-09-14T09:00:00-07:00",
        ...extraEnv,
      },
      stdio: "pipe",
    }).toString();
  } catch (error) {
    const e = error as { stderr?: Buffer; stdout?: Buffer; message?: string };
    throw new Error(`${e.message}\n--- stdout ---\n${e.stdout?.toString() ?? ""}\n--- stderr ---\n${e.stderr?.toString() ?? ""}`);
  }
  const reportPath = path.join(ws.reportsDir, "2026-09-14.json");
  assert.ok(fs.existsSync(reportPath), `Expected report at ${reportPath}`);
  return JSON.parse(fs.readFileSync(reportPath, "utf-8")) as RefreshReport;
}

function testPicksTargetAndWritesRefresh(): void {
  const ws = workspace();
  const report = run(ws);
  assert.equal(report.status, "refreshed");
  // fixture: "hot-post" has the most page-two impressions and is outside the
  // cooldown; "recent-post" was updated 10 days ago; "page-one-post" ranks 2.
  assert.equal(report.slug, "hot-post");
  assert.ok(report.queries && report.queries.length >= 2, "queries for the target are recorded");
  const written = matter(fs.readFileSync(path.join(ws.contentDir, "hot-post.mdx"), "utf-8"));
  assert.equal(written.data.updated, "2026-09-14", "refreshed post carries updated");
  assert.equal(written.data.slug, "hot-post", "slug untouched");
  assert.equal(String(written.data.date).slice(0, 10), "2026-03-01", "publish date untouched");
  assert.ok(typeof written.data.summary === "string" && written.data.summary.length > 0);
  const untouched = fs.readFileSync(path.join(ws.contentDir, "recent-post.mdx"), "utf-8");
  assert.equal(untouched, fs.readFileSync(path.join(FIXTURE, "content", "recent-post.mdx"), "utf-8"), "other posts untouched");
}

function testExcludesPendingSlugs(): void {
  const ws = workspace();
  const report = run(ws, { BLOG_REFRESH_EXCLUDE_SLUGS: "hot-post" });
  assert.equal(report.status, "no-target", "the only qualifying post is excluded → clean no-op");
  assert.deepEqual(report.excludedSlugs, ["hot-post"]);
  assert.equal(
    fs.readFileSync(path.join(ws.contentDir, "hot-post.mdx"), "utf-8"),
    fs.readFileSync(path.join(FIXTURE, "content", "hot-post.mdx"), "utf-8"),
    "nothing written on a no-op",
  );
}

function testNoSignalIsCleanNoop(): void {
  const ws = workspace();
  const report = run(ws, { BLOG_REFRESH_FIXTURE_SIGNAL: "absent" });
  assert.equal(report.status, "no-signal");
  assert.equal(report.gscStatus, "absent");
}

testPicksTargetAndWritesRefresh();
testExcludesPendingSlugs();
function testMalformedSignalFailsTheRun(): void {
  // An ::error:: annotation alone does not fail the workflow step; the
  // process must exit nonzero so a broken secret cannot leave the scheduled
  // refresh silently, permanently disabled behind a green run.
  const ws = workspace();
  assert.throws(
    () => run(ws, { BLOG_REFRESH_FIXTURE_SIGNAL: "malformed" }),
    /malformed/,
    "a broken Search Console secret must fail the run, not exit 0",
  );
  const reportPath = path.join(ws.reportsDir, "2026-09-14.json");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf-8")) as RefreshReport;
  assert.equal(report.status, "no-signal", "the report is still written before the process fails");
  assert.equal(report.gscStatus, "malformed");
}

function testBriefWritesPromptOnly(): void {
  // The brief stage (blog-refresh.yml) asks the engine for its prompt; the
  // Claude session answers it later. Nothing is written to the post.
  const ws = workspace();
  const promptOut = path.join(ws.root, "prompt.md");
  const report = run(ws, { BLOG_REFRESH_PROMPT_OUT: promptOut });
  assert.equal(report.status, "prompt");
  assert.equal(report.slug, "hot-post");
  assert.ok(report.postDigest && /^[0-9a-f]{64}$/.test(report.postDigest), "the brief pins the post it was built from");
  const prompt = fs.readFileSync(promptOut, "utf-8");
  assert.match(prompt, /Answer with ONE JSON object/, "the prompt carries the answer schema");
  assert.ok(report.queries?.every((q) => prompt.includes(q.query)), "the ranking queries are in the prompt");
  assert.equal(
    fs.readFileSync(path.join(ws.contentDir, "hot-post.mdx"), "utf-8"),
    fs.readFileSync(path.join(FIXTURE, "content", "hot-post.mdx"), "utf-8"),
    "the brief does not touch the post",
  );
}

testNoSignalIsCleanNoop();
testMalformedSignalFailsTheRun();
testBriefWritesPromptOnly();
console.log("Blog refresh fixture tests passed.");
