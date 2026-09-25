#!/usr/bin/env tsx
/**
 * Tooling for the scheduled Claude autoblog session. AUTOBLOG_CLAUDE.md is the
 * runbook; this file does the deterministic parts so the session's judgment is
 * spent on topics and prose, not on re-implementing the engine.
 *
 *   npm run autoblog:claude -- <command> [flags]
 *
 *   init      --brief <brief.json> [--no-git] [--pending-dir d] [--sibling-dir d] [--sibling-pending-dir d]
 *   rank      [--candidates .autoblog/candidates.json]
 *   keywords  [--answer .autoblog/keywords.answer.json]
 *   prompt    planner | writer
 *   check
 *   review    --round N [--answer .autoblog/review-N.answer.json]
 *   handoff
 *   clean
 *
 * Everything the session writes lives in .autoblog/ (git-ignored) until
 * `handoff` copies the deliverables to data/blog-claude-inbox/.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import matter from "gray-matter";
import { parse as parseYaml } from "yaml";
import {
  extractLinks,
  headTerm,
  mergeDemand,
  policyViolation,
  renderReviewMarkdown,
  researchKeywords,
  reviewBlogPost,
  scoreDemand,
  type BlogPostFrontmatter,
  type CandidateTopic,
  type ExistingPostLike,
  type GscQueryRow,
  type GscSignal,
  type KeywordResearch,
  type ReviewResult,
  type WeatherContext,
} from "blog-engine";
import {
  bodyViolations,
  buildPlannerPrompt,
  buildWriterPrompt,
  checkExternalPlan,
  loadLinkPolicy,
  postPlanSchema,
  type ExistingPost,
  type ExternalMeta,
  type PostPlan,
} from "../generate-blog-post";
import { SITE, reviewConfig, rotationBlocked } from "./site";
import {
  autocompleteFetch,
  autocompleteReachable,
  readPostRows,
  relayClient,
  type AutocompleteCache,
  type PostRow,
} from "./shared";

const ROOT = process.cwd();
const WORK = path.join(ROOT, ".autoblog");
const INBOX = path.join(ROOT, "data/blog-claude-inbox");
const PREVIEW_KEY = "claude-preview";
const WRITER = process.env.AUTOBLOG_WRITER ?? "claude-opus-5-5 (scheduled Claude session)";

const work = (name: string) => path.join(WORK, name);

// ─── io ─────────────────────────────────────────────────────────────────────

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function need(file: string, hint: string): void {
  if (!fs.existsSync(file)) {
    console.error(`Missing ${path.relative(ROOT, file)} — ${hint}`);
    process.exit(1);
  }
}

// ─── context ────────────────────────────────────────────────────────────────

interface Brief {
  runDate: string;
  generatedAt: string;
  season: { season: string; monthName: string; climate: string };
  weather: WeatherContext | { error: string };
  gsc: { status: GscSignal["status"]; message?: string; rows: GscQueryRow[]; opportunities: Array<GscQueryRow & { opportunity: number }> };
  posts: {
    published: PostRow[];
    pending: PostRow[];
    sibling: { site: string; source: string; published: PostRow[]; pending: PostRow[]; note?: string };
  };
  recentCategories: { counts: Record<string, number>; ordered: string[]; overrepresented: string[] };
  autocomplete: { status: string; queries: AutocompleteCache };
}

interface Context {
  runDate: string;
  runAt: string;
  briefDate: string;
  briefGeneratedAt: string;
  autocompleteLive: boolean;
  /** This site's published posts plus its open autoblog PRs and blog/* branches. */
  ownPosts: PostRow[];
  /** The sibling site's posts: brief rows plus anything the session could read itself. */
  siblingPosts: PostRow[];
}

function pacificNow(): { runDate: string; runAt: string } {
  const now = process.env.AUTOBLOG_NOW ? new Date(process.env.AUTOBLOG_NOW) : new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SITE.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const runDate = `${get("year")}-${get("month")}-${get("day")}`;
  // Offset from the zone, so BLOG_GENERATOR_DATE parses to the same instant.
  const tzName = new Intl.DateTimeFormat("en-US", { timeZone: SITE.timezone, timeZoneName: "longOffset" })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")?.value;
  const offset = tzName?.replace("GMT", "") || "+00:00";
  return { runDate, runAt: `${runDate}T${get("hour")}:${get("minute")}:${get("second")}${offset}` };
}

function loadBrief(): Brief {
  need(work("brief.json"), "run `init --brief <file>` first");
  return readJson<Brief>(work("brief.json"));
}

function loadContext(): Context {
  need(work("context.json"), "run `init` first");
  return readJson<Context>(work("context.json"));
}

function gscSignal(brief: Brief): GscSignal {
  return {
    status: brief.gsc.status,
    rows: brief.gsc.rows,
    byQuery: new Map(brief.gsc.rows.map((r) => [r.query.toLowerCase(), r])),
    ...(brief.gsc.message && { message: brief.gsc.message }),
  };
}

function weatherOf(brief: Brief): WeatherContext {
  if ("anomaly" in brief.weather) return brief.weather;
  return {
    anomaly: "none",
    summary: "Live weather data was unavailable; rely on seasonal context.",
    maxTempF: null,
    minTempF: null,
    maxAqi: null,
    available: false,
  } as WeatherContext;
}

/** Posts the generator's slug check and planner prompt treat as existing. */
function existingForGenerator(ctx: Context): ExistingPost[] {
  return ctx.ownPosts.map((p) => ({
    title: p.title,
    slug: p.slug,
    description: p.description ?? "",
    date: p.date,
    tags: p.tags,
  }));
}

function autocompleteCache(brief: Brief): AutocompleteCache {
  const recorded = fs.existsSync(work("autocomplete.json"))
    ? readJson<AutocompleteCache>(work("autocomplete.json"))
    : {};
  return { ...brief.autocomplete.queries, ...recorded };
}

// ─── init ───────────────────────────────────────────────────────────────────

function git(args: string[], cwd = ROOT): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
}

/**
 * Posts that exist only on unmerged branches: every content/blog/*.mdx present
 * on an origin blog/* or autoblog/* head but not on origin/main. This is what
 * the brief's open-PR scan sees, refreshed at session time and including a
 * branch whose PR has not been opened yet.
 */
function postsOnBranches(repoDir: string, source: PostRow["source"]): PostRow[] {
  try {
    git(["fetch", "--quiet", "--depth", "50", "origin", "main",
      "+refs/heads/blog/*:refs/remotes/origin/blog/*",
      "+refs/heads/autoblog/*:refs/remotes/origin/autoblog/*"], repoDir);
  } catch (error) {
    console.warn(`⚠️ Could not fetch blog/* branches in ${repoDir}: ${String(error).split("\n")[0]}`);
  }
  let branches: string[] = [];
  try {
    branches = git(["for-each-ref", "--format=%(refname)", "refs/remotes/origin/blog", "refs/remotes/origin/autoblog"], repoDir)
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
  const dir = fs.mkdtempSync(path.join(WORK, `branches-${source}-`));
  for (const ref of branches) {
    let added: string[] = [];
    try {
      added = git(["diff", "--name-only", "--diff-filter=A", "refs/remotes/origin/main", ref, "--", SITE.contentDir], repoDir)
        .split("\n")
        .filter((f) => /\.mdx$/.test(f));
    } catch {
      continue;
    }
    for (const file of added) {
      try {
        fs.writeFileSync(path.join(dir, path.basename(file)), git(["show", `${ref}:${file}`], repoDir));
      } catch {
        // unreadable blob — skip
      }
    }
  }
  return readPostRows(dir, SITE.categories, source);
}

/** Best effort: the sibling repo is reachable only if this session was given it. */
function siblingClone(): { published: PostRow[]; pending: PostRow[] } | undefined {
  const dir = work("sibling");
  try {
    if (!fs.existsSync(path.join(dir, ".git"))) {
      git(["clone", "--quiet", "--depth", "1", "--filter=blob:none", "--sparse",
        `https://github.com/${SITE.sibling.repo}.git`, dir]);
      git(["sparse-checkout", "set", SITE.contentDir], dir);
    }
    return {
      published: readPostRows(path.join(dir, SITE.contentDir), SITE.categories, "sibling"),
      pending: postsOnBranches(dir, "sibling-pending"),
    };
  } catch (error) {
    console.warn(`⚠️ Sibling ${SITE.sibling.repo} not readable from this session (${String(error).split("\n")[0]}); using the brief's list.`);
    return undefined;
  }
}

async function cmdInit(): Promise<void> {
  const briefPath = flag("brief");
  if (!briefPath) throw new Error("init needs --brief <brief.json>");
  fs.mkdirSync(WORK, { recursive: true });
  fs.copyFileSync(path.resolve(briefPath), work("brief.json"));
  const brief = loadBrief();
  const { runDate, runAt } = pacificNow();

  const useGit = !process.argv.includes("--no-git");
  const extraPending = [
    ...(flag("pending-dir") ? readPostRows(path.resolve(flag("pending-dir")!), SITE.categories, "pending") : []),
    ...(useGit ? postsOnBranches(ROOT, "pending") : []),
  ];
  const cloned = useGit ? siblingClone() : undefined;
  const extraSibling = [
    ...(cloned ? [...cloned.pending, ...cloned.published] : []),
    ...(flag("sibling-dir") ? readPostRows(path.resolve(flag("sibling-dir")!), SITE.categories, "sibling") : []),
    ...(flag("sibling-pending-dir")
      ? readPostRows(path.resolve(flag("sibling-pending-dir")!), SITE.categories, "sibling-pending")
      : []),
  ];

  // Disk is the truth for this repo: the session's clone is newer than the brief.
  const published = readPostRows(path.join(ROOT, SITE.contentDir), SITE.categories, "published");
  const bySlug = new Map<string, PostRow>();
  for (const row of [...published, ...brief.posts.pending, ...extraPending]) {
    if (!bySlug.has(row.slug)) bySlug.set(row.slug, row);
  }
  const ownPosts = [...bySlug.values()].sort((a, b) => b.date.localeCompare(a.date));

  const sib = new Map<string, PostRow>();
  for (const row of [...extraSibling, ...brief.posts.sibling.pending, ...brief.posts.sibling.published]) {
    if (!sib.has(row.slug)) sib.set(row.slug, row);
  }
  const siblingPosts = [...sib.values()];

  const live = await autocompleteReachable();
  const ctx: Context = {
    runDate,
    runAt,
    briefDate: brief.runDate,
    briefGeneratedAt: brief.generatedAt,
    autocompleteLive: live,
    ownPosts,
    siblingPosts,
  };
  writeJson(work("context.json"), ctx);

  const weather = weatherOf(brief);
  const line = (s = "") => console.log(s);
  line(`# Autoblog context — ${SITE.key}, ${runDate}`);
  if (brief.runDate !== runDate) {
    line(`⚠️ The brief is for ${brief.runDate}, not ${runDate}. Weather and Search Console may be a day old; post lists were refreshed from git.`);
  }
  line(`Season: ${brief.season.monthName} (${brief.season.season}) — ${brief.season.climate}`);
  line(`Weather: ${weather.anomaly} — ${weather.summary}`);
  line(`Search Console: ${brief.gsc.status}${brief.gsc.message ? ` (${brief.gsc.message})` : ""}; ${brief.gsc.opportunities.length} opportunities`);
  for (const o of brief.gsc.opportunities) {
    line(`  - "${o.query}" — ${o.impressions} impressions, position ${o.position.toFixed(1)}`);
  }
  line(`Recent categories (newest first): ${brief.recentCategories.ordered.join(", ") || "none"}; over-represented: ${brief.recentCategories.overrepresented.join(", ") || "none"}`);
  line(`Categories: ${SITE.categories.map((c) => c.id).join(", ")}`);
  line(`This site: ${ownPosts.length} posts (${ownPosts.filter((p) => p.source === "pending").length} pending)`);
  line(`Sibling ${SITE.sibling.key}: ${siblingPosts.length} posts via ${brief.posts.sibling.source}${extraSibling.length ? " + session clone" : ""}${brief.posts.sibling.note ? ` — ${brief.posts.sibling.note}` : ""}`);
  line(`Autocomplete: ${live ? "live" : `brief cache (${brief.autocomplete.status}, ${Object.keys(brief.autocomplete.queries).length} queries)`}`);
  line();
  line("Full lists: .autoblog/context.json (ownPosts, siblingPosts). Brief: .autoblog/brief.json.");
}

// ─── rank ───────────────────────────────────────────────────────────────────

/**
 * Mirrors blog-engine src/rank.ts (rankCandidates + pickBest, not exported):
 * dedup 0.25, demand 0.45, rotation 0.15, weather 0.15 when any row has a
 * demand signal; 0.5 / 0.3 / 0.2 without. The session supplies similarity by
 * judgment instead of embeddings.
 */
const DEMAND_WEIGHTS = { dedup: 0.25, demand: 0.45, rotation: 0.15, weather: 0.15 };
const PLAIN_WEIGHTS = { dedup: 0.5, rotation: 0.3, weather: 0.2 };
const UNMEASURED_DEMAND = 0.5;
const COMFORT_SIMILARITY = 0.6;
const DUPLICATE_THRESHOLD = 0.86;
const ANOMALY_KEYWORDS: Record<string, string[]> = {
  "wildfire-smoke": ["smoke", "air quality", "filter", "merv", "hepa", "iaq", "ventilation"],
  "heat-wave": ["heat", "cooling", "cool", "ac", "air conditioner", "condenser", "overheat"],
  "cold-snap": ["cold", "heat", "furnace", "heating", "freeze", "no heat"],
  storm: ["storm", "rain", "flood", "power", "surge", "wind"],
  none: [],
};

function dedupCurve(similarity: number): number {
  if (similarity <= COMFORT_SIMILARITY) return 1;
  if (similarity <= DUPLICATE_THRESHOLD) {
    return 1 - 0.5 * ((similarity - COMFORT_SIMILARITY) / (DUPLICATE_THRESHOLD - COMFORT_SIMILARITY));
  }
  return Math.max(0, 0.5 * ((1 - similarity) / (1 - DUPLICATE_THRESHOLD)));
}

interface SessionCandidate extends CandidateTopic {
  /** 0-1, the session's judgment of overlap with the closest post on either site. */
  similarity: number;
  nearestSlug?: string;
}

async function cmdRank(): Promise<void> {
  const brief = loadBrief();
  const ctx = loadContext();
  const file = path.resolve(flag("candidates") ?? work("candidates.json"));
  need(file, "write the candidates first (see AUTOBLOG_CLAUDE.md step 3)");
  const candidates = readJson<SessionCandidate[]>(file);
  if (!Array.isArray(candidates) || candidates.length === 0) throw new Error("candidates.json must be a non-empty array");
  for (const c of candidates) {
    if (!c.topic || !c.categoryId || typeof c.similarity !== "number") {
      throw new Error(`Each candidate needs topic, notes, categoryId and similarity: ${JSON.stringify(c)}`);
    }
    if (!SITE.categories.some((cat) => cat.id === c.categoryId)) {
      throw new Error(`Unknown categoryId "${c.categoryId}" (allowed: ${SITE.categories.map((x) => x.id).join(", ")})`);
    }
  }
  const opportunities = new Set(brief.gsc.opportunities.map((o) => o.query.toLowerCase()));
  const answering = candidates.filter((c) => c.hintQuery && opportunities.has(c.hintQuery.toLowerCase())).length;
  if (opportunities.size > 0 && answering * 2 < candidates.length) {
    console.warn(`⚠️ Only ${answering}/${candidates.length} candidates answer a Search Console opportunity; the runbook asks for at least half.`);
  }

  const record: AutocompleteCache = {};
  const fetchImpl = autocompleteFetch(autocompleteCache(brief), ctx.autocompleteLive, record);
  // As the orchestrator calls it: candidates + fetch only.
  const demandResult = await scoreDemand({ candidates, fetchImpl });
  if (ctx.autocompleteLive) writeJson(work("autocomplete.json"), { ...autocompleteCache(brief), ...record });
  const breadth = demandResult.available ? demandResult.scores : undefined;
  const signal = gscSignal(brief);
  const gscOk = signal.status === "ok";
  const demand =
    breadth || gscOk
      ? candidates.map(
          (c, i) =>
            mergeDemand({
              head: c.hintQuery ?? headTerm(c.topic),
              breadthScore: breadth?.[i] ?? null,
              ...(gscOk ? { signal } : {}),
            }).score,
        )
      : undefined;

  const weather = weatherOf(brief);
  const anomalyWords = ANOMALY_KEYWORDS[weather.anomaly] ?? [];
  // The engine's recent-mix rule, plus any hard rotation rule the site's
  // generator enforces (a plan in a blocked category fails assertPlan).
  const siteBlocked = rotationBlocked(ctx.ownPosts);
  const blocked = new Set([...brief.recentCategories.overrepresented, ...siteBlocked]);
  for (const c of candidates) {
    if (siteBlocked.includes(c.categoryId)) {
      console.warn(`⚠️ "${c.topic}" is in ${c.categoryId}, which this site's rotation rule blocks today; the plan would fail check.`);
    }
  }
  const ranked = candidates.map((candidate, i) => {
    const dedupScore = dedupCurve(candidate.similarity);
    const overrepresented = blocked.has(candidate.categoryId);
    const rotationScore = overrepresented ? 0 : 1;
    const text = `${candidate.topic} ${candidate.notes ?? ""}`.toLowerCase();
    const weatherFit = anomalyWords.some((w) => text.includes(w)) ? 1 : 0;
    const rowDemand = demand?.[i];
    const hasDemand = typeof rowDemand === "number";
    const demandScore = hasDemand ? rowDemand : UNMEASURED_DEMAND;
    const score = demand
      ? dedupScore * DEMAND_WEIGHTS.dedup +
        demandScore * DEMAND_WEIGHTS.demand +
        rotationScore * DEMAND_WEIGHTS.rotation +
        weatherFit * DEMAND_WEIGHTS.weather
      : dedupScore * PLAIN_WEIGHTS.dedup + rotationScore * PLAIN_WEIGHTS.rotation + weatherFit * PLAIN_WEIGHTS.weather;
    const rationale = [
      `dedup distance ${dedupScore.toFixed(2)}`,
      hasDemand ? `search demand ${demandScore.toFixed(2)}` : null,
      overrepresented
        ? `category "${candidate.categoryId}" is over-represented`
        : `category "${candidate.categoryId}" keeps rotation balanced`,
      weatherFit ? `aligned with ${weather.anomaly} conditions` : "seasonally appropriate",
    ]
      .filter(Boolean)
      .join("; ");
    return {
      ...candidate,
      score: Number(score.toFixed(4)),
      demand: hasDemand ? Number(demandScore.toFixed(4)) : null,
      autocomplete: demandResult.perCandidate[i]
        ? {
            available: demandResult.perCandidate[i].available,
            relevant: demandResult.perCandidate[i].relevantSuggestions.length,
          }
        : undefined,
      rejectedAsDuplicate: candidate.similarity >= DUPLICATE_THRESHOLD,
      rationale,
    };
  });

  const survivors = ranked.filter((r) => !r.rejectedAsDuplicate);
  const relaxed = survivors.length === 0;
  const winner = [...(relaxed ? ranked : survivors)].sort((a, b) => b.score - a.score)[0];
  const hintRow = gscOk && winner.hintQuery ? signal.byQuery.get(winner.hintQuery.toLowerCase()) : undefined;
  const dupNote = winner.nearestSlug
    ? ` Closest existing post: ${winner.nearestSlug} (similarity ${winner.similarity.toFixed(2)}).`
    : "";
  const gscNote = hintRow
    ? ` Targets the Search Console query "${hintRow.query}" (${hintRow.impressions.toLocaleString("en-US")} impressions, position ${hintRow.position.toFixed(1)}).`
    : "";
  const selection: NonNullable<ExternalMeta["topicSelection"]> = {
    topic: winner.topic,
    category: winner.categoryId,
    rationale: `${winner.rationale}.${dupNote}${gscNote}`,
    weather,
    ...(winner.supportsSlug && { supportsSlug: winner.supportsSlug }),
    gsc: {
      status: signal.status,
      opportunitiesOffered: brief.gsc.opportunities.length,
      ...(hintRow && { hintQuery: hintRow.query, impressions: hintRow.impressions }),
    },
  };
  writeJson(work("selection.json"), {
    selection,
    notes: winner.notes,
    relaxedDuplicateFilter: relaxed,
    demandSource: breadth ? (gscOk ? "autocomplete+gsc" : "autocomplete") : gscOk ? "gsc" : "none",
    ranked: [...ranked].sort((a, b) => b.score - a.score),
  });

  console.log(`Demand: ${breadth ? "autocomplete" : "no autocomplete (not every candidate had a signal)"}${gscOk ? " + Search Console" : ""}`);
  for (const r of [...ranked].sort((a, b) => b.score - a.score)) {
    console.log(`${r === winner ? "→" : " "} ${r.score.toFixed(3)} ${r.rejectedAsDuplicate ? "[dup] " : ""}[${r.categoryId}] ${r.topic} — ${r.rationale}`);
  }
  if (relaxed) console.warn("⚠️ Every candidate is a near-duplicate; picked the most distinct. Consider proposing new candidates.");
  console.log(`\nWinner written to .autoblog/selection.json`);
}

// ─── keywords ───────────────────────────────────────────────────────────────

async function cmdKeywords(): Promise<void> {
  const brief = loadBrief();
  const ctx = loadContext();
  need(work("selection.json"), "run `rank` first");
  const { selection } = readJson<{ selection: NonNullable<ExternalMeta["topicSelection"]> }>(work("selection.json"));
  const answer = flag("answer") ? path.resolve(flag("answer")!) : undefined;
  if (answer) need(answer, "write the keyword answer JSON first");
  const record: AutocompleteCache = {};
  const categoryKeywords = SITE.categories.find((c) => c.id === selection.category)?.keywords ?? [];
  const client = relayClient(work("keywords.prompt.md"), answer);
  const research = await researchKeywords({
    gemini: client,
    seedTopic: selection.topic,
    serviceAreas: [...SITE.serviceAreas],
    categoryKeywords: [...categoryKeywords],
    seasonLabel: brief.season.season,
    fetchImpl: autocompleteFetch(autocompleteCache(brief), ctx.autocompleteLive, record),
    model: "claude-session",
  });
  if (ctx.autocompleteLive) writeJson(work("autocomplete.json"), { ...autocompleteCache(brief), ...record });
  if (answer && research.llmError) {
    throw new Error(`The keyword answer was not usable (${research.llmError}). Fix .autoblog/keywords.answer.json and re-run.`);
  }
  if (client.pending) {
    console.log(`Keyword prompt written to .autoblog/keywords.prompt.md (${research.rawSuggestions.length} autocomplete phrases kept).`);
    console.log("Answer it as JSON in .autoblog/keywords.answer.json, then run `keywords --answer .autoblog/keywords.answer.json`.");
    return;
  }
  writeJson(work("keywords.json"), research);
  console.log(
    `Keywords [demand: ${research.demandSignal}]: primary "${research.primaryKeyword}"` +
      `${research.provenance.primaryKeywordVerbatim ? " (verified search)" : " (inferred)"}; ` +
      `${research.provenance.questionKeywordsVerbatim}/${research.questionKeywords.length} questions verified` +
      (research.llmError ? `; answer rejected: ${research.llmError}` : ""),
  );
}

// ─── prompts ────────────────────────────────────────────────────────────────

function keywordsOrUndefined(): KeywordResearch | undefined {
  return fs.existsSync(work("keywords.json")) ? readJson<KeywordResearch>(work("keywords.json")) : undefined;
}

function cmdPrompt(): void {
  const which = process.argv[3];
  const ctx = loadContext();
  const now = new Date(ctx.runAt);
  if (which === "planner") {
    need(work("selection.json"), "run `rank` first");
    const sel = readJson<{ selection: NonNullable<ExternalMeta["topicSelection"]>; notes?: string }>(work("selection.json"));
    const prompt = buildPlannerPrompt(
      existingForGenerator(ctx),
      now,
      ctx.runDate,
      { topic: sel.selection.topic, notes: sel.notes ?? "" },
      keywordsOrUndefined(),
    );
    const sibling = ctx.siblingPosts
      .slice(0, 40)
      .map((p) => `- "${p.title}" (slug: ${p.slug})`)
      .join("\n");
    const text = `${prompt}

Also do not duplicate these posts from our sister site ${SITE.sibling.siteUrl} (same Sacramento market):
${sibling || "(none known)"}

Return ONE JSON object, no prose and no code fences, matching the planner's schema:
\`\`\`json
${JSON.stringify(postPlanSchema, null, 2)}
\`\`\`
`;
    fs.writeFileSync(work("planner.prompt.md"), text);
    console.log("Planner prompt: .autoblog/planner.prompt.md → write .autoblog/plan.json");
    return;
  }
  if (which === "writer") {
    need(work("plan.json"), "write the plan first");
    const plan = readJson<PostPlan>(work("plan.json"));
    fs.writeFileSync(work("writer.prompt.md"), `${buildWriterPrompt(plan, now, keywordsOrUndefined())}\n`);
    console.log("Writer prompt: .autoblog/writer.prompt.md → write .autoblog/body.md");
    return;
  }
  throw new Error("prompt needs `planner` or `writer`");
}

// ─── check (offline preview) ────────────────────────────────────────────────

function previewPaths(slug: string) {
  return {
    mdx: path.join(ROOT, SITE.contentDir, `${slug}.mdx`),
    image: path.join(ROOT, "public/images/blog", `${slug}.jpg`),
    report: path.join(ROOT, "data/blog-generation-runs", `${PREVIEW_KEY}.json`),
  };
}

function removePreview(): void {
  if (!fs.existsSync(work("preview.json"))) return;
  const { slug } = readJson<{ slug: string }>(work("preview.json"));
  const p = previewPaths(slug);
  for (const file of [p.mdx, p.image, p.report]) fs.rmSync(file, { force: true });
  fs.rmSync(work("preview.json"), { force: true });
}

/** Writes the pending/sibling rows as stub .mdx files for BLOG_PENDING_DIR. */
function pendingDir(ctx: Context): string {
  const dir = work("pending");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const p of ctx.ownPosts.filter((row) => row.source === "pending")) {
    fs.writeFileSync(
      path.join(dir, `${p.slug}.mdx`),
      matter.stringify("", { title: p.title, slug: p.slug, date: p.date, tags: p.tags, description: p.description ?? "" }),
    );
  }
  return dir;
}

function cmdCheck(): void {
  const ctx = loadContext();
  need(work("plan.json"), "write the plan first");
  need(work("body.md"), "write the body first");
  const plan = readJson<PostPlan>(work("plan.json"));
  const body = fs.readFileSync(work("body.md"), "utf-8");
  const problems: string[] = [];

  let checked: ReturnType<typeof checkExternalPlan> | undefined;
  try {
    checked = checkExternalPlan(plan, existingForGenerator(ctx));
    problems.push(...checked.violations.map((v) => `plan: ${v}`));
  } catch (error) {
    problems.push(`plan: ${error instanceof Error ? error.message : String(error)}`);
  }
  const siblingClash = ctx.siblingPosts.find((p) => p.slug === plan.slug);
  if (siblingClash) problems.push(`plan: slug "${plan.slug}" is already used by ${SITE.sibling.key} — pick a distinct topic or slug`);
  problems.push(...bodyViolations(body).map((v) => `body: ${v}`));

  const policy = loadLinkPolicy();
  for (const url of new Set([...extractLinks(body), ...extractLinks(JSON.stringify(plan))])) {
    const reason = policyViolation(url, policy);
    if (reason) problems.push(`link: ${url} — ${reason}`);
  }

  if (!checked) {
    report(problems);
    process.exit(1);
  }

  // Offline preview: the real generator in external mode, stock image, no
  // network. Produces the MDX CI and the reviewer will see.
  removePreview();
  const meta: ExternalMeta = { writer: WRITER };
  writeJson(work("meta.preview.json"), meta);
  const env = {
    ...process.env,
    BLOG_EXTERNAL_PLAN: work("plan.json"),
    BLOG_EXTERNAL_BODY: work("body.md"),
    BLOG_EXTERNAL_META: work("meta.preview.json"),
    BLOG_EXTERNAL_OFFLINE: "1",
    BLOG_PENDING_DIR: pendingDir(ctx),
    BLOG_GENERATOR_DATE: ctx.runAt,
    BLOG_RUN_KEY: PREVIEW_KEY,
  };
  const gen = spawnSync("npx", ["tsx", "scripts/generate-blog-post.ts"], { cwd: ROOT, env, encoding: "utf-8" });
  if (gen.status !== 0) {
    console.log(gen.stdout);
    console.error(gen.stderr);
    problems.push("preview: the generator failed in external mode (output above)");
    report(problems);
    process.exit(1);
  }
  const slug = checked.plan.slug;
  writeJson(work("preview.json"), { slug });
  const structural = spawnSync("npx", ["tsx", "scripts/check-blog-post.ts", previewPaths(slug).mdx, "--strict"], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  if (structural.status !== 0) problems.push(`structure: ${structural.stdout.trim()}`);
  console.log(`Preview written: ${path.relative(ROOT, previewPaths(slug).mdx)} (stock image; finalize makes the real one)`);
  report(problems);
  process.exit(problems.length > 0 ? 1 : 0);
}

function report(problems: string[]): void {
  if (problems.length === 0) {
    console.log("✔ plan, body, link policy and structure are clean");
    return;
  }
  console.log(`✘ ${problems.length} problem(s):`);
  for (const p of problems) console.log(`  - ${p}`);
}

// ─── review ─────────────────────────────────────────────────────────────────

/** The review CLI's frontmatter parser (blog-engine src/cli/frontmatter.ts). */
function parseDocument(source: string): { frontmatter: BlogPostFrontmatter; body: string } {
  const fence = /^---\s*\r?\n/;
  if (!fence.test(source)) throw new Error("Document is missing a leading `---` frontmatter fence");
  const afterFirst = source.replace(fence, "");
  const closeIdx = afterFirst.search(/\r?\n---\s*(\r?\n|$)/);
  if (closeIdx === -1) throw new Error("Document is missing the closing `---` frontmatter fence");
  const body = afterFirst
    .slice(closeIdx)
    .replace(/^\r?\n---\s*(\r?\n)?/, "")
    .replace(/^\r?\n/, "");
  const frontmatter = parseYaml(afterFirst.slice(0, closeIdx)) as BlogPostFrontmatter;
  if (typeof frontmatter.title !== "string") frontmatter.title = String(frontmatter.title ?? "");
  if (frontmatter.tags === null) frontmatter.tags = [];
  return { frontmatter, body };
}

/** The review CLI's --posts-dir list: newest ~20 by filename, excluding the post. */
function reviewNeighbours(exclude: string): ExistingPostLike[] {
  const dir = path.join(ROOT, SITE.contentDir);
  const posts: ExistingPostLike[] = [];
  for (const entry of fs.readdirSync(dir).filter((e) => /\.mdx?$/.test(e) && e !== exclude).sort().reverse()) {
    if (posts.length >= 20) break;
    try {
      const { frontmatter } = parseDocument(fs.readFileSync(path.join(dir, entry), "utf-8"));
      if (typeof frontmatter.title !== "string" || !frontmatter.title) continue;
      posts.push({
        title: frontmatter.title,
        slug: typeof frontmatter.slug === "string" ? frontmatter.slug : entry.replace(/\.mdx?$/, ""),
        tags: Array.isArray(frontmatter.tags) ? frontmatter.tags.filter((t): t is string => typeof t === "string") : [],
        date: typeof frontmatter.date === "string" ? frontmatter.date : "",
        ...(typeof frontmatter.description === "string" ? { description: frontmatter.description } : {}),
      });
    } catch {
      // A malformed neighbour must never block a review.
    }
  }
  return posts;
}

async function cmdReview(): Promise<void> {
  const round = Number(flag("round") ?? "1");
  need(work("preview.json"), "run `check` first — the reviewer grades the preview MDX");
  const { slug } = readJson<{ slug: string }>(work("preview.json"));
  const file = previewPaths(slug).mdx;
  const { frontmatter, body } = parseDocument(fs.readFileSync(file, "utf-8"));
  const answer = flag("answer") ? path.resolve(flag("answer")!) : undefined;
  if (answer) need(answer, "write the reviewer's JSON answer first");
  const promptPath = work(`review-${round}.prompt.md`);
  const client = relayClient(promptPath, answer, "Claude review subagent (did not write the post)");
  let result: ReviewResult;
  try {
    result = await reviewBlogPost({
      gemini: client,
      config: reviewConfig(),
      frontmatter,
      markdown: body,
      existingPosts: reviewNeighbours(path.basename(file)),
      model: "claude-review-subagent",
    });
  } catch (error) {
    if (client.pending) {
      console.log(`Reviewer prompt: .autoblog/review-${round}.prompt.md`);
      console.log(`Hand it to a fresh subagent; save its JSON to .autoblog/review-${round}.answer.json; then run \`review --round ${round} --answer .autoblog/review-${round}.answer.json\`.`);
      return;
    }
    throw error;
  }
  writeJson(work(`review-${round}.json`), result);
  fs.writeFileSync(work(`review-${round}.md`), renderReviewMarkdown(result));
  writeJson(work("review.json"), { round, result });
  console.log(renderReviewMarkdown(result));
  process.exit(result.pass ? 0 : 2);
}

// ─── handoff ────────────────────────────────────────────────────────────────

function cmdHandoff(): void {
  const ctx = loadContext();
  for (const f of ["plan.json", "body.md", "selection.json", "review.json"]) need(work(f), "finish the earlier steps first");
  const sel = readJson<{ selection: NonNullable<ExternalMeta["topicSelection"]>; ranked: unknown[] }>(work("selection.json"));
  const review = readJson<{ round: number; result: ReviewResult }>(work("review.json"));
  const meta: ExternalMeta & { runDate: string; runAt: string; briefDate: string; autocompleteLive: boolean } = {
    writer: WRITER,
    runDate: ctx.runDate,
    runAt: ctx.runAt,
    briefDate: ctx.briefDate,
    autocompleteLive: ctx.autocompleteLive,
    topicSelection: sel.selection,
    ...(keywordsOrUndefined() && { keywordResearch: keywordsOrUndefined() }),
    candidates: sel.ranked,
    claudeReview: { pass: review.result.pass, fixRounds: Math.max(0, review.round - 1), result: review.result },
  };
  removePreview();
  fs.rmSync(INBOX, { recursive: true, force: true });
  fs.mkdirSync(INBOX, { recursive: true });
  fs.copyFileSync(work("plan.json"), path.join(INBOX, "plan.json"));
  fs.copyFileSync(work("body.md"), path.join(INBOX, "body.md"));
  writeJson(path.join(INBOX, "meta.json"), meta);
  fs.copyFileSync(work(`review-${review.round}.md`), path.join(INBOX, "review.md"));
  const status = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf-8" })
    .split("\n")
    .filter((l) => l.trim() && !l.includes("data/blog-claude-inbox"));
  console.log(`Handoff written to data/blog-claude-inbox/ (review ${review.result.pass ? "PASSED" : "FAILED"} after ${meta.claudeReview!.fixRounds} fix round(s)).`);
  if (status.length > 0) {
    console.warn("⚠️ Other working-tree changes exist; commit ONLY data/blog-claude-inbox/:");
    for (const l of status) console.warn(`   ${l}`);
  }
}

// ─── main ───────────────────────────────────────────────────────────────────

const commands: Record<string, () => void | Promise<void>> = {
  init: cmdInit,
  rank: cmdRank,
  keywords: cmdKeywords,
  prompt: cmdPrompt,
  check: cmdCheck,
  review: cmdReview,
  handoff: cmdHandoff,
  clean: removePreview,
};

const command = process.argv[2];
if (!command || !commands[command]) {
  console.error(`usage: autoblog:claude <${Object.keys(commands).join("|")}> — see AUTOBLOG_CLAUDE.md`);
  process.exit(2);
}
Promise.resolve(commands[command]()).catch((error: Error) => {
  console.error(`❌ ${command}: ${error.message}`);
  process.exit(1);
});
