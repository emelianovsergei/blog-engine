/**
 * Live Search Console check.
 *
 * Verifies the service account can actually read the property and prints the
 * opportunity queries — the ones the site already ranks for at positions 8-25
 * that a dedicated post could push onto page one.
 *
 *   GSC_SERVICE_ACCOUNT_JSON='<json>' GSC_SITE_URL='sc-domain:example.com' npm run smoke:gsc
 */
import { findOpportunities, loadGscSignal } from "../src/gsc.js";

async function main(): Promise<void> {
  const serviceAccountJson = process.env.GSC_SERVICE_ACCOUNT_JSON;
  const siteUrl = process.env.GSC_SITE_URL;

  if (!serviceAccountJson || !siteUrl) {
    console.log("SKIP: GSC_SERVICE_ACCOUNT_JSON / GSC_SITE_URL not set.");
    return;
  }

  const signal = await loadGscSignal({ serviceAccountJson, siteUrl, now: new Date() });
  console.log(`status: ${signal.status}${signal.message ? ` — ${signal.message}` : ""}`);

  if (signal.status !== "ok") {
    // `absent` here means the credential failed to parse, since both env vars
    // are set — that is a real failure, not the quiet no-credential path.
    console.error("FAIL: could not read Search Console.");
    process.exit(1);
  }

  console.log(`rows: ${signal.rows.length}`);
  const top = [...signal.rows].sort((a, b) => b.impressions - a.impressions).slice(0, 5);
  console.log("\ntop queries by impressions:");
  for (const r of top) {
    console.log(`  ${String(r.impressions).padStart(6)} imp  pos ${r.position.toFixed(1).padStart(5)}  ${r.query}`);
  }

  const opportunities = findOpportunities(signal);
  console.log(`\nopportunity queries (pos 8-25, >=50 impressions): ${opportunities.length}`);
  for (const o of opportunities) {
    console.log(`  ${String(o.impressions).padStart(6)} imp  pos ${o.position.toFixed(1).padStart(5)}  ${o.query}`);
  }

  console.log(signal.rows.length > 0 ? "\nPASS" : "\nPASS (property has no data yet)");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
