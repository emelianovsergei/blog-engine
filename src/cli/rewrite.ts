#!/usr/bin/env node
/**
 * blog-engine-rewrite — apply a previous review's feedback to revise a post.
 *
 * Reads a markdown post and a prior ReviewResult JSON; writes the revised
 * markdown back to the same post path. Designed to be invoked from a
 * user-initiated `/autoblog rewrite` slash-command workflow.
 *
 * Exit codes:
 *   0  Revised post written.
 *   1  ERROR — unexpected failure.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { rewriteBlogPost } from "../rewrite.js";
import type { ReviewResult } from "../review.js";
import { parseDocument, serializeDocument } from "./frontmatter.js";
import {
  composeConfig,
  makeReviewClient,
  optionalFlag,
  parseArgs,
  requireFlag,
} from "./shared.js";

function usage(): string {
  return `Usage: blog-engine-rewrite --post <path.md> --review <result.json> --site pulse|promax \\
                           --business "<Business Name>" \\
                           --service-areas "Sacramento,Roseville,..." \\
                           [--notes-out change-notes.md] [--model claude-sonnet-4-6]`;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("help") || args.flags.has("h")) {
    console.log(usage());
    return 0;
  }

  const postPath = resolve(requireFlag(args, "post"));
  const reviewPath = resolve(requireFlag(args, "review"));
  const notesOut = optionalFlag(args, "notes-out");
  const model = optionalFlag(args, "model");
  const config = composeConfig(args);

  const source = await readFile(postPath, "utf8");
  const { frontmatter, body } = parseDocument(source);
  const reviewRaw = await readFile(reviewPath, "utf8");
  const reviewFeedback = JSON.parse(reviewRaw) as ReviewResult;

  const gemini = await makeReviewClient();
  const result = await rewriteBlogPost({
    gemini,
    config,
    frontmatter,
    markdown: body,
    reviewFeedback,
    ...(model ? { model } : {}),
  });

  const revisedDoc = serializeDocument(result.frontmatter, result.markdown);
  await writeFile(postPath, revisedDoc, "utf8");

  if (notesOut) {
    await writeFile(
      resolve(notesOut),
      `## Autoblog AI Rewrite\n\n${result.changeNotes}\n\n_Model: \`${result.modelUsed}\`_\n`,
      "utf8",
    );
  }

  process.stdout.write(`${JSON.stringify({ changeNotes: result.changeNotes, modelUsed: result.modelUsed }, null, 2)}\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`blog-engine-rewrite: ${msg}\n`);
    process.exit(1);
  });
