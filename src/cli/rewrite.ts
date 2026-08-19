#!/usr/bin/env node
/**
 * blog-engine-rewrite — apply a previous review's feedback to revise a post.
 *
 * Reads a markdown post and a prior ReviewResult JSON; writes the revised
 * markdown back to the same post path. Invoked from CI two ways: the review
 * workflow's automatic fix-on-failure steps (bounded by a CI-side attempt
 * cap), and the user-initiated `/autoblog rewrite` slash-command workflow.
 *
 * Exit codes:
 *   0  Revised post written.
 *   1  ERROR — unexpected failure.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { rewriteBlogPost } from "../rewrite.js";
import { auditAndRepairFile } from "../link-audit.js";
import { EMPTY_LINK_POLICY, parseLinkPolicy } from "../links.js";
import { parseReviewResult } from "../review.js";
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
                           [--notes-out change-notes.md] [--model grok-4.6] \\
                           [--link-policy content/policy/link-constraints.json] \\
                           [--audit-out rewrite-audit.json] [--no-link-audit]`;
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
  const linkPolicyPath = optionalFlag(args, "link-policy");
  const auditOut = optionalFlag(args, "audit-out");
  const skipAudit = args.flags.has("no-link-audit");
  const config = composeConfig(args);

  // A missing or unreadable policy must not stop the fix — degrade to "no
  // policy" and let the @smoke guard remain the backstop, exactly as the
  // generation path does.
  let linkPolicy = EMPTY_LINK_POLICY;
  if (linkPolicyPath) {
    try {
      linkPolicy = parseLinkPolicy(JSON.parse(await readFile(resolve(linkPolicyPath), "utf8")));
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`blog-engine-rewrite: link policy unreadable (${linkPolicyPath}): ${msg}\n`);
    }
  }

  const source = await readFile(postPath, "utf8");
  const { frontmatter, body } = parseDocument(source);
  const reviewRaw = await readFile(reviewPath, "utf8");
  const reviewFeedback = parseReviewResult(JSON.parse(reviewRaw));

  const gemini = await makeReviewClient();
  const result = await rewriteBlogPost({
    gemini,
    config,
    frontmatter,
    markdown: body,
    reviewFeedback,
    linkPolicy,
    ...(model ? { model } : {}),
  });

  // Audit AFTER serialization: the model can reintroduce a denylisted URL in
  // either the body or a frontmatter citation, and both live in the file.
  let revisedDoc = serializeDocument(result.frontmatter, result.markdown);
  let auditSummary: unknown;
  if (!skipAudit) {
    const { text, audit } = await auditAndRepairFile(revisedDoc, linkPolicy);
    revisedDoc = text;
    auditSummary = audit;
    for (const { url, reason } of audit.removed) {
      process.stderr.write(`\u{1F517} removed dead link ${url} — ${reason}\n`);
    }
    for (const { url, reason } of audit.unresolved) {
      process.stderr.write(`\u{1F517} UNRESOLVED ${url} — ${reason} (needs a human)\n`);
    }
    if (auditOut) {
      await writeFile(resolve(auditOut), `${JSON.stringify(audit, null, 2)}\n`, "utf8");
    }
  }
  await writeFile(postPath, revisedDoc, "utf8");

  if (notesOut) {
    await writeFile(
      resolve(notesOut),
      `## Autoblog AI Rewrite\n\n${result.changeNotes}\n\n_Model: \`${result.modelUsed}\`_\n`,
      "utf8",
    );
  }

  process.stdout.write(
    `${JSON.stringify({ changeNotes: result.changeNotes, modelUsed: result.modelUsed, linkAudit: auditSummary }, null, 2)}\n`,
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`blog-engine-rewrite: ${msg}\n`);
    process.exit(1);
  });
