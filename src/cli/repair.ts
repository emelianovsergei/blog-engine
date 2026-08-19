#!/usr/bin/env node
/**
 * blog-engine-repair — deterministically strip dead/denylisted links from a post.
 *
 * No model, no cost, no new prose. This exists so a red CI caused by a link
 * violation can be healed automatically: an LLM asked to "fix the link" is
 * free to rewrite the paragraph around it, which is a fresh hallucination
 * surface for a problem that is purely mechanical.
 *
 * Exit codes:
 *   0  Post is clean, or was repaired to clean.
 *   2  Repaired, but a URL survives in prose and needs a human.
 *   1  ERROR — unexpected failure.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { auditAndRepairFile } from "../link-audit.js";
import { EMPTY_LINK_POLICY, parseLinkPolicy } from "../links.js";
import { optionalFlag, parseArgs, requireFlag } from "./shared.js";

function usage(): string {
  return `Usage: blog-engine-repair --post <path.md> \\
                          [--link-policy content/policy/link-constraints.json] \\
                          [--audit-out audit.json] [--no-network]`;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("help") || args.flags.has("h")) {
    console.log(usage());
    return 0;
  }

  const postPath = resolve(requireFlag(args, "post"));
  const linkPolicyPath = optionalFlag(args, "link-policy");
  const auditOut = optionalFlag(args, "audit-out");
  const network = !args.flags.has("no-network");

  let policy = EMPTY_LINK_POLICY;
  if (linkPolicyPath) {
    policy = parseLinkPolicy(JSON.parse(await readFile(resolve(linkPolicyPath), "utf8")));
  }

  const raw = await readFile(postPath, "utf8");
  const { text, audit } = await auditAndRepairFile(raw, policy, { network });

  if (text !== raw) await writeFile(postPath, text, "utf8");
  if (auditOut) await writeFile(resolve(auditOut), `${JSON.stringify(audit, null, 2)}\n`, "utf8");

  for (const { url, reason } of audit.removed) {
    process.stdout.write(`\u{1F517} removed ${url} — ${reason}\n`);
  }
  for (const { url, reason } of audit.unresolved) {
    process.stderr.write(`\u{1F517} UNRESOLVED ${url} — ${reason}\n`);
  }
  process.stdout.write(
    `\u{1F517} repair: ${audit.checked} checked, ${audit.removed.length} removed, ` +
      `${audit.unverified.length} unverified, ${audit.unresolved.length} unresolved\n`,
  );

  return audit.unresolved.length > 0 ? 2 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`blog-engine-repair: ${msg}\n`);
    process.exit(1);
  });
