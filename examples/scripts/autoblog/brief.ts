#!/usr/bin/env tsx
/**
 * Daily brief for the Claude autoblog session. No LLM calls.
 *
 *   npx tsx scripts/autoblog/brief.ts --out brief.json
 *
 * Runs in blog-brief.yml, which has open network and the secrets. The Claude
 * session reaches only GitHub and npm, so everything that needs the network
 * (weather, Search Console, the sibling site, Autocomplete) is gathered here.
 *
 * Env (all optional):
 *   GSC_SERVICE_ACCOUNT_JSON, GSC_SITE_URL   Search Console signal
 *   BRIEF_PENDING_DIR                        .mdx files added by open autoblog PRs
 *   BRIEF_SIBLING_DIR                        sibling repo content/blog checkout
 *   BRIEF_SIBLING_PENDING_DIR                .mdx files from the sibling's open autoblog PRs
 *   BRIEF_DATE                               ISO timestamp to build the brief for
 *   BRIEF_AUTOCOMPLETE_MAX                   query cap for the autocomplete pool (default 400)
 */
import fs from "node:fs";
import path from "node:path";
import {
  buildSeedQueries,
  citationGuidance,
  fetchAutocompleteResult,
  findOpportunities,
  getSeasonContext,
  headTerm,
  loadGscSignal,
  openMeteoWeatherClient,
  plannerRubricRules,
  reviewerRubric,
  summarizeRecentCategories,
  topicLockPlannerRules,
  writerAccuracyRules,
  writerRubricRules,
  DIMENSION_LABELS,
  DEFAULT_GATE,
  DEFAULT_RUBRIC_CONSTRAINTS,
  type SuggestOutcome,
} from "blog-engine";
import { RUBRIC, loadLinkPolicy } from "../generate-blog-post";
import { SITE } from "./site";
import { pacificDate, postsFromSitemap, readPostRows, type AutocompleteCache, type PostRow } from "./shared";

const ROOT = process.cwd();

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function siblingPosts(): Promise<{
  source: "repo" | "sitemap" | "unavailable";
  published: PostRow[];
  pending: PostRow[];
  note?: string;
}> {
  const dir = process.env.BRIEF_SIBLING_DIR;
  const pendingDir = process.env.BRIEF_SIBLING_PENDING_DIR;
  // Sibling rows are categorized with this site's taxonomy only for display;
  // the session compares topics, not category ids, across sites.
  if (dir && fs.existsSync(dir)) {
    return {
      source: "repo",
      published: readPostRows(dir, SITE.categories, "sibling"),
      pending: pendingDir ? readPostRows(pendingDir, SITE.categories, "sibling-pending") : [],
    };
  }
  try {
    const res = await fetch(`${SITE.sibling.siteUrl}/sitemap.xml`, {
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return {
      source: "sitemap",
      published: postsFromSitemap(await res.text(), SITE.sibling.siteUrl),
      pending: [],
      note: "Sibling read from its public sitemap: slugs only, no open PRs. Set AUTOBLOG_SIBLING_TOKEN for titles and pending posts.",
    };
  } catch (error) {
    return {
      source: "unavailable",
      published: [],
      pending: [],
      note: `Sibling sitemap unreadable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Pre-fetches Autocomplete for the topics the session is likely to consider:
 * every Search Console opportunity and every category keyword. Both seed
 * shapes are fetched — scoreDemand's (topic only, 6 seeds) and
 * researchKeywords' (with category keywords and service areas) — so a session
 * that cannot reach Google still gets a real signal for these heads.
 */
async function autocompletePool(topics: Array<{ topic: string; categoryKeywords: string[] }>): Promise<{
  status: "ok" | "partial" | "blocked";
  queries: AutocompleteCache;
}> {
  const max = Number(process.env.BRIEF_AUTOCOMPLETE_MAX ?? 400);
  const wanted: string[] = [];
  const seen = new Set<string>();
  for (const { topic, categoryKeywords } of topics) {
    const seeds = [
      ...buildSeedQueries({ topic, maxSeeds: 6 }),
      ...buildSeedQueries({ topic, categoryKeywords, serviceAreas: SITE.serviceAreas }),
    ];
    for (const seed of seeds) {
      if (!seen.has(seed.query)) {
        seen.add(seed.query);
        wanted.push(seed.query);
      }
    }
  }
  const queries: AutocompleteCache = {};
  let blocked = 0;
  let ok = 0;
  for (const query of wanted.slice(0, max)) {
    const outcome: SuggestOutcome = await fetchAutocompleteResult(query);
    queries[query] = outcome;
    if (outcome.status === "blocked") blocked += 1;
    if (outcome.status === "ok" || outcome.status === "empty") ok += 1;
    // Stop hammering a blocked endpoint: five blocks before any answer.
    if (ok === 0 && blocked >= 5) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  return { status: ok === 0 ? "blocked" : blocked > 0 ? "partial" : "ok", queries };
}

async function main(): Promise<void> {
  const out = path.resolve(flag("out") ?? "brief.json");
  const now = process.env.BRIEF_DATE ? new Date(process.env.BRIEF_DATE) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`Invalid BRIEF_DATE ${process.env.BRIEF_DATE}`);

  const published = readPostRows(path.join(ROOT, SITE.contentDir), SITE.categories, "published");
  const pending = process.env.BRIEF_PENDING_DIR
    ? readPostRows(path.resolve(process.env.BRIEF_PENDING_DIR), SITE.categories, "pending")
    : [];
  const ownPosts = [...pending, ...published].sort((a, b) => b.date.localeCompare(a.date));

  const season = getSeasonContext(now, SITE.timezone);

  let weather: unknown;
  try {
    weather = await openMeteoWeatherClient.fetchWeather(SITE.location, now);
  } catch (error) {
    weather = { error: error instanceof Error ? error.message : String(error) };
  }

  const gscSignal = await loadGscSignal({
    serviceAccountJson: process.env.GSC_SERVICE_ACCOUNT_JSON,
    siteUrl: process.env.GSC_SITE_URL,
    now,
  });
  // Same filter as the engine's orchestrator: drop queries whose head term an
  // existing title already targets.
  const titles = ownPosts.map((p) => p.title.toLowerCase());
  const opportunities =
    gscSignal.status === "ok"
      ? findOpportunities(gscSignal, { limit: 12 }).filter((h) => {
          const head = headTerm(h.query).toLowerCase();
          return head.length > 0 && !titles.some((t) => t.includes(head));
        })
      : [];
  console.log(`Search Console: ${gscSignal.status} (${gscSignal.rows.length} rows, ${opportunities.length} opportunities)`);

  const sibling = await siblingPosts();
  console.log(`Sibling ${SITE.sibling.key}: ${sibling.source}, ${sibling.published.length} published, ${sibling.pending.length} pending`);

  const recentMix = summarizeRecentCategories(SITE.categories, ownPosts);

  const poolTopics = [
    ...opportunities.map((o) => ({ topic: o.query, categoryKeywords: [] as string[] })),
    ...SITE.categories.flatMap((c) =>
      c.keywords.slice(0, 3).map((k) => ({ topic: k, categoryKeywords: [...c.keywords] })),
    ),
  ];
  const autocomplete = await autocompletePool(poolTopics);
  console.log(`Autocomplete pool: ${autocomplete.status}, ${Object.keys(autocomplete.queries).length} queries`);

  const linkPolicyPath = path.join(ROOT, "content/policy/link-constraints.json");
  const brief = {
    version: 1,
    site: SITE.key,
    generatedAt: new Date().toISOString(),
    runDate: pacificDate(now, SITE.timezone),
    timezone: SITE.timezone,
    business: {
      name: SITE.businessName,
      phone: SITE.phone,
      siteUrl: SITE.siteUrl,
      serviceAreas: SITE.serviceAreas,
    },
    season,
    weather,
    gsc: {
      status: gscSignal.status,
      ...(gscSignal.message && { message: gscSignal.message }),
      rows: gscSignal.rows,
      opportunities,
    },
    posts: {
      published,
      pending,
      sibling: { site: SITE.sibling.key, ...sibling },
    },
    recentCategories: recentMix,
    categories: SITE.categories.map((c) => ({
      id: c.id,
      label: c.label,
      guidance: c.guidance,
      keywords: c.keywords,
    })),
    rubric: {
      constraints: RUBRIC,
      gate: DEFAULT_GATE,
      writerRules: writerRubricRules(RUBRIC),
      plannerRules: plannerRubricRules(RUBRIC),
      topicLockPlannerRules: topicLockPlannerRules(),
      writerAccuracyRules: writerAccuracyRules(),
      // The review CLI renders the reviewer rubric from the engine defaults.
      reviewerRubric: reviewerRubric(DEFAULT_RUBRIC_CONSTRAINTS, { dimensionLabels: DIMENSION_LABELS }),
    },
    linkPolicy: fs.existsSync(linkPolicyPath) ? JSON.parse(fs.readFileSync(linkPolicyPath, "utf-8")) : null,
    citationGuidance: citationGuidance(loadLinkPolicy()),
    autocomplete,
  };

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(brief, null, 2)}\n`);
  console.log(`Brief written: ${path.relative(ROOT, out)} (${brief.runDate})`);
}

main().catch((error: Error) => {
  console.error(`❌ brief: ${error.message}`);
  process.exit(1);
});
