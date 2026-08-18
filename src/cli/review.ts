#!/usr/bin/env node
/**
 * blog-engine-review — AI quality review for a draft blog post.
 *
 * Exit codes:
 *   0  PASS — review passed the gate.
 *   2  FAIL — review ran but failed the gate.
 *   1  ERROR — unexpected failure (bad args, no API key, model outage).
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderReviewMarkdown, reviewBlogPost } from "../review.js";
import type { ReviewResult } from "../review.js";
import { parseDocument } from "./frontmatter.js";
import {
  composeConfig,
  makeReviewClient,
  optionalFlag,
  parseArgs,
  requireFlag,
} from "./shared.js";

function usage(): string {
  return `Usage: blog-engine-review --post <path.md> --site pulse|promax \\
                          --business "<Business Name>" \\
                          --service-areas "Sacramento,Roseville,..." \\
                          [--out review-summary.md] [--json-out result.json] \\
                          [--model grok-4.6]`;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("help") || args.flags.has("h")) {
    console.log(usage());
    return 0;
  }

  const postPath = resolve(requireFlag(args, "post"));
  const outPath = resolve(optionalFlag(args, "out") ?? "review-summary.md");
  const jsonOutPath = optionalFlag(args, "json-out");
  const model = optionalFlag(args, "model");
  const config = composeConfig(args);

  const source = await readFile(postPath, "utf8");
  const { frontmatter, body } = parseDocument(source);

  const gemini = await makeReviewClient();
  const result: ReviewResult = await reviewBlogPost({
    gemini,
    config,
    frontmatter,
    markdown: body,
    ...(model ? { model } : {}),
  });

  const md = renderReviewMarkdown(result);
  await writeFile(outPath, md, "utf8");
  if (jsonOutPath) {
    await writeFile(resolve(jsonOutPath), JSON.stringify(result, null, 2), "utf8");
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  return result.pass ? 0 : 2;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`blog-engine-review: ${msg}\n`);
    process.exit(1);
  });
