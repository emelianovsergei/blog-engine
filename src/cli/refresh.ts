#!/usr/bin/env node
/**
 * blog-engine-refresh — refresh a published post against the Search Console
 * queries it ranks for, or backfill its GEO frontmatter fields.
 *
 *   blog-engine-refresh --post content/blog/x.mdx --site pulse|promax \
 *     --business "<Business Name>" --service-areas "Sacramento,Roseville" \
 *     --mode refresh|backfill [--queries queries.json] [--fields summary,faqs,…] \
 *     [--howto-shape steps|nested] [--now YYYY-MM-DD] [--link-policy policy.json] \
 *     [--audit-out audit.json] [--notes-out notes.md] [--result-out result.json] \
 *     [--required-headings "A|B"] [--faq-policy appended-by-code|written-by-model] \
 *     [--model grok-4.6] [--no-link-audit]
 *
 * `--queries` is a JSON array of {query, impressions, position} (the page's
 * rows from loadGscPageSignal). `--howto-shape` picks how HowTo is written:
 * "steps" → howToName + howToSteps (hvacpulse.com), "nested" → howTo {name,
 * step[]} (promaxhvac.com); the default follows --site.
 *
 * Exit codes: 0 written (or nothing to change, see result-out), 1 error.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { auditAndRepairFile } from "../link-audit.js";
import { EMPTY_LINK_POLICY, parseLinkPolicy } from "../links.js";
import { ALL_REFRESH_FIELDS, refreshBlogPost, type RefreshField, type RankingQuery } from "../refresh.js";
import { DEFAULT_RUBRIC_CONSTRAINTS, type RubricConstraints } from "../rubric.js";
import { parseDocument, serializeDocument } from "./frontmatter.js";
import { composeConfig, makeReviewClient, optionalFlag, parseArgs, requireFlag } from "./shared.js";

function usage(): string {
  return `Usage: blog-engine-refresh --post <path.md> --site pulse|promax --business "<Name>" \\
                            --service-areas "A,B" --mode refresh|backfill [--queries queries.json] \\
                            [--fields summary,faqs,targetKeyword,keywords,citations,howTo] \\
                            [--howto-shape steps|nested] [--now YYYY-MM-DD] [--link-policy policy.json] \\
                            [--audit-out audit.json] [--notes-out notes.md] [--result-out result.json] \\
                            [--required-headings "A|B"] [--faq-policy appended-by-code|written-by-model] \\
                            [--model grok-4.6] [--no-link-audit]`;
}

export function rubricFromFlags(
  requiredHeadings: string | undefined,
  faqPolicy: string | undefined,
): RubricConstraints {
  return {
    ...DEFAULT_RUBRIC_CONSTRAINTS,
    requiredHeadings: (requiredHeadings ?? "")
      .split("|")
      .map((h) => h.trim())
      .filter(Boolean),
    faqPolicy: faqPolicy === "written-by-model" ? "written-by-model" : "appended-by-code",
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("help") || args.flags.has("h")) {
    console.log(usage());
    return 0;
  }
  const postPath = resolve(requireFlag(args, "post"));
  const modeRaw = requireFlag(args, "mode");
  if (modeRaw !== "refresh" && modeRaw !== "backfill") {
    throw new Error(`--mode must be "refresh" or "backfill" (got "${modeRaw}")`);
  }
  const mode = modeRaw;
  const site = requireFlag(args, "site");
  const config = composeConfig(args);
  const model = optionalFlag(args, "model");
  const queriesPath = optionalFlag(args, "queries");
  const fieldsRaw = optionalFlag(args, "fields");
  const howToShape = optionalFlag(args, "howto-shape") ?? (site === "promax" ? "nested" : "steps");
  const nowRaw = optionalFlag(args, "now");
  const now = nowRaw ? new Date(`${nowRaw}T12:00:00Z`) : new Date();
  const linkPolicyPath = optionalFlag(args, "link-policy");
  const auditOut = optionalFlag(args, "audit-out");
  const notesOut = optionalFlag(args, "notes-out");
  const resultOut = optionalFlag(args, "result-out");
  const skipAudit = args.flags.has("no-link-audit");
  const rubric = rubricFromFlags(optionalFlag(args, "required-headings"), optionalFlag(args, "faq-policy"));

  const fields = fieldsRaw
    ? (fieldsRaw
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean) as RefreshField[])
    : ALL_REFRESH_FIELDS;
  for (const f of fields) {
    if (!ALL_REFRESH_FIELDS.includes(f)) throw new Error(`Unknown --fields entry "${f}"`);
  }

  let linkPolicy = EMPTY_LINK_POLICY;
  if (linkPolicyPath) {
    try {
      linkPolicy = parseLinkPolicy(JSON.parse(await readFile(resolve(linkPolicyPath), "utf8")));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`blog-engine-refresh: link policy unreadable (${linkPolicyPath}): ${msg}\n`);
    }
  }

  let rankingQueries: RankingQuery[] = [];
  if (queriesPath) {
    const raw = JSON.parse(await readFile(resolve(queriesPath), "utf8")) as unknown;
    if (!Array.isArray(raw)) throw new Error("--queries must be a JSON array");
    rankingQueries = raw
      .filter((q): q is { query: string; impressions?: number; position?: number } => typeof q === "object" && q !== null && typeof (q as { query?: unknown }).query === "string")
      .map((q) => ({ query: q.query, impressions: Number(q.impressions ?? 0), position: Number(q.position ?? 0) }));
  }

  const source = await readFile(postPath, "utf8");
  const { frontmatter, body } = parseDocument(source);
  const gemini = await makeReviewClient();

  const result = await refreshBlogPost({
    gemini,
    config,
    frontmatter,
    markdown: body,
    rankingQueries,
    now,
    mode,
    fields,
    rubric,
    linkPolicy,
    ...(model ? { model } : {}),
  });

  // Map the site-agnostic HowTo onto the site's frontmatter shape.
  const out = { ...result.frontmatter };
  if (result.howTo) {
    if (howToShape === "nested") {
      out.howTo = { name: result.howTo.name, step: result.howTo.steps };
    } else {
      out.howToName = result.howTo.name;
      out.howToSteps = result.howTo.steps;
    }
  }

  let text = serializeDocument(out, result.markdown);
  let auditSummary: unknown = null;
  if (!skipAudit) {
    const repaired = await auditAndRepairFile(text, linkPolicy);
    text = repaired.text;
    auditSummary = repaired.audit;
  }
  if (result.changedFields.length > 0) {
    await writeFile(postPath, text, "utf8");
  }
  if (notesOut) await writeFile(resolve(notesOut), `${result.changeNotes}\n`, "utf8");
  if (auditOut && auditSummary) await writeFile(resolve(auditOut), JSON.stringify(auditSummary, null, 2), "utf8");
  if (resultOut) {
    await writeFile(
      resolve(resultOut),
      JSON.stringify(
        { mode, changedFields: result.changedFields, modelUsed: result.modelUsed, updated: out.updated ?? null, changeNotes: result.changeNotes },
        null,
        2,
      ),
      "utf8",
    );
  }
  process.stdout.write(
    result.changedFields.length > 0
      ? `blog-engine-refresh: wrote ${postPath} (${result.changedFields.join(", ")})\n`
      : `blog-engine-refresh: nothing to change for ${postPath}\n`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`blog-engine-refresh: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
