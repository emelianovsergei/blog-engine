#!/usr/bin/env node
/**
 * blog-engine-review — AI quality review for a draft blog post.
 *
 * Exit codes:
 *   0  PASS — review passed the gate.
 *   2  FAIL — review ran but failed the gate.
 *   1  ERROR — unexpected failure (bad args, no API key, model outage).
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { renderReviewMarkdown, reviewBlogPost } from "../review.js";
import type { ReviewResult } from "../review.js";
import type { ExistingPostLike } from "../types.js";
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

/** Newest ~20 published posts, excluding the one under review. */
async function loadExistingPosts(dir: string, excludePath: string): Promise<ExistingPostLike[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const exclude = basename(excludePath);
  const posts: ExistingPostLike[] = [];
  for (const entry of entries.filter((e) => /\.mdx?$/.test(e) && e !== exclude).sort().reverse()) {
    if (posts.length >= 20) break;
    try {
      const { frontmatter } = parseDocument(await readFile(join(dir, entry), "utf8"));
      const title = typeof frontmatter.title === "string" ? frontmatter.title : undefined;
      if (!title) continue;
      const description =
        typeof frontmatter.description === "string" ? frontmatter.description : undefined;
      const tags = Array.isArray(frontmatter.tags)
        ? frontmatter.tags.filter((t): t is string => typeof t === "string")
        : [];
      posts.push({
        title,
        slug: typeof frontmatter.slug === "string" ? frontmatter.slug : entry.replace(/\.mdx?$/, ""),
        tags,
        date: typeof frontmatter.date === "string" ? frontmatter.date : "",
        ...(description ? { description } : {}),
      });
    } catch {
      // A malformed neighbour must never block a review.
    }
  }
  return posts;
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
  const postsDir = optionalFlag(args, "posts-dir");
  const config = composeConfig(args);

  const source = await readFile(postPath, "utf8");
  const { frontmatter, body } = parseDocument(source);

  // Without this the rubric's duplication-awareness block always rendered
  // "(none provided)" — the reviewer could never catch a near-rewrite of an
  // existing post, which is exactly what the planner is warned about.
  const existingPosts = postsDir ? await loadExistingPosts(resolve(postsDir), postPath) : [];

  const gemini = await makeReviewClient();
  const result: ReviewResult = await reviewBlogPost({
    gemini,
    config,
    frontmatter,
    markdown: body,
    ...(existingPosts.length > 0 ? { existingPosts } : {}),
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
