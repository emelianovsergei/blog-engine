/**
 * Weekly refresh: pick the published post with the most page-two Search
 * Console impressions that has not been touched in a while, and refresh it
 * against the queries it already ranks for. The model is the scheduled Claude
 * session (subscription), never an API key: this script only writes the
 * engine's prompt and later applies the session's answer.
 *
 *   npm run blog:refresh
 *
 * Stages (blog-refresh.yml):
 *   brief     BLOG_REFRESH_PROMPT_OUT=<path>   select the target, write the
 *             engine prompt there; report status "prompt". The post is untouched.
 *   finalize  BLOG_REFRESH_BRIEF=<report.json> BLOG_REFRESH_ANSWER=<answer.json>
 *             apply the session's answer to the brief's post (the engine parses
 *             and validates it exactly as it would a model reply), repair links,
 *             write the post; report status "refreshed" (or "no-target" when the
 *             answer changes nothing).
 *
 * Env:
 *   GSC_SERVICE_ACCOUNT_JSON, GSC_SITE_URL   Search Console access (absent → clean no-op)
 *   BLOG_REFRESH_EXCLUDE_SLUGS                comma list (posts with an open autoblog PR)
 *   BLOG_REFRESH_COOLDOWN_DAYS                default 120
 *   BLOG_GENERATOR_DATE                       run-date override (the workflow passes Pacific time)
 *   BLOG_CONTENT_DIR, BLOG_REFRESH_REPORTS_DIR   path overrides (the fixture harness, refresh-check)
 *   BLOG_REFRESH_LINK_NETWORK                 "false": link audit by policy only (the session's preview)
 *   BLOG_REFRESH_FIXTURE_DIR                  offline mode: pages.json + refreshed.mdx replace
 *                                             Search Console and the model
 *   BLOG_REFRESH_FIXTURE_SIGNAL               "absent" | "malformed" to simulate that signal in fixture mode
 *
 * Writes data/blog-refresh-runs/<RUN_DATE>.json with status
 * "prompt" | "refreshed" | "no-target" | "no-signal". Exit 0 in every
 * non-error case — nothing to refresh is normal.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import matter from "gray-matter";
import {
  ALL_REFRESH_FIELDS,
  DEFAULT_RUBRIC_CONSTRAINTS,
  applyHowToShape,
  auditAndRepairFile,
  loadGscPageSignal,
  parseLinkPolicy,
  pickRefreshTarget,
  refreshBlogPost,
  type BlogPostFrontmatter,
  type GscQueryRow,
  type RefreshablePost,
} from "blog-engine";
import { BUSINESS_NAME, SERVICE_AREAS, SITE_URL } from "../lib/constants";
import { BLOG_REQUIRED_HEADINGS } from "../lib/blog/rubric";
import { relayClient } from "./autoblog/shared";
import { reviewConfig } from "./autoblog/site";

const ROOT = path.resolve(__dirname, "..");
const CONTENT_DIR = path.resolve(process.env.BLOG_CONTENT_DIR ?? path.join(ROOT, "content/blog"));
const REPORTS_DIR = path.resolve(process.env.BLOG_REFRESH_REPORTS_DIR ?? path.join(ROOT, "data/blog-refresh-runs"));
const FIXTURE_DIR = process.env.BLOG_REFRESH_FIXTURE_DIR ? path.resolve(process.env.BLOG_REFRESH_FIXTURE_DIR) : undefined;
const LINK_POLICY = path.join(ROOT, "content/policy/link-constraints.json");
const TIMEZONE = process.env.BLOG_GENERATOR_TIMEZONE ?? "America/Los_Angeles";

interface RefreshReport {
  status: "prompt" | "refreshed" | "no-target" | "no-signal";
  runDate: string;
  generatedAt: string;
  gscStatus: string;
  excludedSlugs: string[];
  candidates: number;
  slug?: string;
  url?: string;
  queries?: Array<{ query: string; impressions: number; position: number }>;
  opportunity?: number;
  changedFields?: string[];
  changeNotes?: string;
  reason?: string;
  /** Brief stage: the engine prompt the session answers, and the post it was built from. */
  prompt?: string;
  postDigest?: string;
}

function getNow(): Date {
  const override = process.env.BLOG_GENERATOR_DATE;
  if (!override) return new Date();
  const parsed = new Date(override);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid BLOG_GENERATOR_DATE: ${override}`);
  return parsed;
}

function localDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function readPosts(): RefreshablePost[] {
  if (!fs.existsSync(CONTENT_DIR)) return [];
  return fs
    .readdirSync(CONTENT_DIR)
    .filter((f) => f.endsWith(".mdx"))
    .map((file) => {
      const { data } = matter(fs.readFileSync(path.join(CONTENT_DIR, file), "utf-8"));
      const iso = (v: unknown): string | undefined =>
        typeof v === "string" ? v : v instanceof Date ? v.toISOString().slice(0, 10) : undefined;
      const slug = typeof data.slug === "string" ? data.slug : file.replace(/\.mdx$/, "");
      return {
        slug,
        url: `${SITE_URL}/blog/${slug}`,
        date: iso(data.date) ?? "1970-01-01",
        ...(iso(data.updated) ? { updated: iso(data.updated) } : {}),
      };
    });
}

async function loadSignal(now: Date): Promise<{ status: string; byPage: Map<string, GscQueryRow[]> }> {
  if (FIXTURE_DIR) {
    const simulated = process.env.BLOG_REFRESH_FIXTURE_SIGNAL;
    if (simulated === "absent" || simulated === "malformed") return { status: simulated, byPage: new Map() };
    const raw = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, "pages.json"), "utf-8")) as Record<string, GscQueryRow[]>;
    return { status: "ok", byPage: new Map(Object.entries(raw)) };
  }
  const signal = await loadGscPageSignal({
    serviceAccountJson: process.env.GSC_SERVICE_ACCOUNT_JSON,
    siteUrl: process.env.GSC_SITE_URL,
    now,
    pathPrefix: "/blog/",
  });
  return { status: signal.status, byPage: signal.byPage };
}

function writeReport(runDate: string, report: RefreshReport): string {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const p = path.join(REPORTS_DIR, `${runDate}.json`);
  fs.writeFileSync(p, `${JSON.stringify(report, null, 2)}\n`);
  return p;
}

async function main(): Promise<void> {
  const answerPath = process.env.BLOG_REFRESH_ANSWER;
  if (answerPath) {
    await finalizeStage(requireEnv("BLOG_REFRESH_BRIEF"), answerPath);
    return;
  }
  const now = getNow();
  const runDate = localDate(now);
  const excludedSlugs = (process.env.BLOG_REFRESH_EXCLUDE_SLUGS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const cooldownDays = Number(process.env.BLOG_REFRESH_COOLDOWN_DAYS ?? 120);
  const posts = readPosts();
  const base: Omit<RefreshReport, "status" | "gscStatus"> = {
    runDate,
    generatedAt: new Date().toISOString(),
    excludedSlugs,
    candidates: posts.length,
  };

  const { status, byPage } = await loadSignal(now);
  if (status !== "ok") {
    writeReport(runDate, { ...base, status: "no-signal", gscStatus: status, reason: `search console signal ${status}` });
    // unauthorized (no property access) and malformed (a broken secret) are
    // operator problems that would otherwise disable refreshes for good. An
    // ::error:: annotation alone does not fail the job — the workflow step
    // would report green while the weekly refresh stayed silently disabled.
    // Throwing here (report already written) makes the run red.
    if (status === "unauthorized" || status === "malformed") {
      throw new Error(`Search Console signal ${status} — refresh is disabled until this is fixed.`);
    }
    console.log(`::notice::Search Console signal ${status} — nothing to refresh this week.`);
    return;
  }

  const target = pickRefreshTarget({ byPage, posts, now, excludeSlugs: excludedSlugs, cooldownDays });
  if (!target) {
    console.log("::notice::No post qualifies for a refresh this week (cooldown, exclusions, or no page-two impressions).");
    writeReport(runDate, { ...base, status: "no-target", gscStatus: status, reason: "no qualifying post" });
    return;
  }

  const queries = target.queries.map((q) => ({ query: q.query, impressions: q.impressions, position: q.position }));
  const postPath = path.join(CONTENT_DIR, `${target.slug}.mdx`);
  console.log(
    `Refresh target: ${target.slug} (${queries.length} ranking queries, opportunity ${Math.round(target.opportunity)})`,
  );
  const found = { ...base, gscStatus: status, slug: target.slug, url: target.url, queries, opportunity: target.opportunity };

  if (FIXTURE_DIR && !process.env.BLOG_REFRESH_PROMPT_OUT) {
    // Offline: the pre-baked model output stands in for the session's answer.
    fs.copyFileSync(path.join(FIXTURE_DIR, "refreshed.mdx"), postPath);
    writeReport(runDate, {
      ...found,
      status: "refreshed",
      changedFields: ["summary", "faqs", "targetKeyword", "keywords", "citations", "markdown"],
      changeNotes: "(fixture) refreshed content",
    });
    console.log(`Refreshed ${target.slug} (fixture)`);
    return;
  }

  const promptOut = process.env.BLOG_REFRESH_PROMPT_OUT;
  if (!promptOut) {
    throw new Error(
      "set BLOG_REFRESH_PROMPT_OUT (brief) or BLOG_REFRESH_BRIEF + BLOG_REFRESH_ANSWER (finalize): the refresh is written by the Claude session, not an API key",
    );
  }
  const outcome = await refreshPost(postPath, queries, runDate, path.resolve(promptOut));
  if (outcome !== "prompt") throw new Error("the refresh prompt was not written (the engine asked the model nothing)");
  writeReport(runDate, {
    ...found,
    status: "prompt",
    prompt: path.relative(ROOT, path.resolve(promptOut)),
    postDigest: digest(fs.readFileSync(postPath, "utf-8")),
  });
  console.log(`Refresh prompt for ${target.slug}: ${promptOut}`);
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The engine's frontmatter parser and serializer, exactly as blog-engine-refresh writes a post. */
async function frontmatterIo(): Promise<{
  parseDocument(source: string): { frontmatter: BlogPostFrontmatter; body: string };
  serializeDocument(frontmatter: BlogPostFrontmatter, body: string): string;
}> {
  // Not in the package's exports map; loaded by path from the pinned engine.
  const file = path.join(path.dirname(require.resolve("blog-engine")), "cli", "frontmatter.js");
  return import(pathToFileURL(file).href);
}

/**
 * One refresh through the engine, with the Claude session as the model
 * (relayClient): without an answer it writes the engine's prompt and returns
 * "prompt"; with one it applies it the way blog-engine-refresh does (HowTo
 * shape, `updated:`, link audit) and writes the post when anything changed.
 */
async function refreshPost(
  postPath: string,
  queries: Array<{ query: string; impressions: number; position: number }>,
  runDate: string,
  promptPath: string,
  answerPath?: string,
): Promise<"prompt" | { changedFields: string[]; changeNotes: string; wrote: boolean }> {
  const { parseDocument, serializeDocument } = await frontmatterIo();
  const { frontmatter, body } = parseDocument(fs.readFileSync(postPath, "utf-8"));
  const client = relayClient(promptPath, answerPath, "Claude session (weekly refresh)");
  const now = new Date(`${runDate}T12:00:00Z`);
  let result: Awaited<ReturnType<typeof refreshBlogPost>>;
  try {
    result = await refreshBlogPost({
      gemini: client,
      config: { ...reviewConfig(), businessName: BUSINESS_NAME, serviceAreas: [...SERVICE_AREAS] },
      frontmatter,
      markdown: body,
      rankingQueries: queries,
      now,
      mode: "refresh",
      fields: ALL_REFRESH_FIELDS,
      rubric: { ...DEFAULT_RUBRIC_CONSTRAINTS, requiredHeadings: [...BLOG_REQUIRED_HEADINGS], faqPolicy: "appended-by-code" },
      linkPolicy: parseLinkPolicy(JSON.parse(fs.readFileSync(LINK_POLICY, "utf-8"))),
      model: "claude-session",
    });
  } catch (error) {
    if (client.pending) return "prompt";
    throw error;
  }
  const shaped = applyHowToShape(result.frontmatter, result.howTo, "steps");
  const out = shaped.frontmatter;
  const changedFields = shaped.changed && !result.changedFields.includes("howTo")
    ? [...result.changedFields, "howTo"]
    : [...result.changedFields];
  if (changedFields.length > 0 && !out.updated) out.updated = runDate;
  const preAudit = serializeDocument(out, result.markdown);
  // The session's preview (refresh-check) runs where most sites are
  // unreachable: policy only there, and finalize does the network audit.
  const repaired = await auditAndRepairFile(preAudit, parseLinkPolicy(JSON.parse(fs.readFileSync(LINK_POLICY, "utf-8"))), {
    network: process.env.BLOG_REFRESH_LINK_NETWORK !== "false",
  });
  const auditChanged = repaired.text !== preAudit;
  if (auditChanged && changedFields.length === 0) changedFields.push("link-audit");
  const wrote = changedFields.length > 0;
  if (wrote) fs.writeFileSync(postPath, repaired.text);
  return { changedFields, changeNotes: result.changeNotes, wrote };
}

/** Finalize: apply the session's answer to the post the brief chose. */
async function finalizeStage(briefPath: string, answerPath: string): Promise<void> {
  const brief = JSON.parse(fs.readFileSync(briefPath, "utf-8")) as RefreshReport;
  if (brief.status !== "prompt" || !brief.slug || !brief.queries || !brief.postDigest) {
    throw new Error(`${briefPath} is not a refresh brief (status ${brief.status})`);
  }
  // The brief arrives on a pushed branch: its slug names a file, so it must be one.
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(brief.slug)) throw new Error(`invalid slug in the brief: ${JSON.stringify(brief.slug)}`);
  const postPath = path.join(CONTENT_DIR, `${brief.slug}.mdx`);
  // The answer was written against the post as the brief saw it; a post that
  // changed since would get fields meant for different text.
  if (digest(fs.readFileSync(postPath, "utf-8")) !== brief.postDigest) {
    throw new Error(`content/blog/${brief.slug}.mdx changed since the brief; run the brief again`);
  }
  const promptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "refresh-")), "prompt.md");
  const outcome = await refreshPost(postPath, brief.queries, brief.runDate, promptPath, path.resolve(answerPath));
  if (outcome === "prompt") throw new Error(`no answer at ${answerPath}`);
  const { status: _status, prompt: _prompt, postDigest: _digest, ...rest } = brief;
  void _status; void _prompt; void _digest;
  if (!outcome.wrote) {
    writeReport(brief.runDate, { ...rest, generatedAt: new Date().toISOString(), status: "no-target", reason: "the answer changed nothing" });
    console.log(`::notice::${brief.slug} needed no changes.`);
    return;
  }
  writeReport(brief.runDate, {
    ...rest,
    generatedAt: new Date().toISOString(),
    status: "refreshed",
    changedFields: outcome.changedFields,
    changeNotes: outcome.changeNotes,
  });
  console.log(`Refreshed ${brief.slug}: ${outcome.changedFields.join(", ")}`);
}

main().catch((error) => {
  console.error(`refresh-blog-post: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
