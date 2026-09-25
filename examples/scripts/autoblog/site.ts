/**
 * Site facts shared by the Claude autoblog tooling (brief.ts, claude.ts).
 *
 * The review block must stay identical to the flags autoblog-review.yml passes
 * to `blog-engine-review`, so the Claude reviewer grades against the same
 * prompt and categories the Grok reviewer used.
 */
import { HVAC_CATEGORIES, SACRAMENTO_LOCATION, type EngineConfig } from "blog-engine";
import { BUSINESS_NAME, PHONE, SERVICE_AREAS, SITE_URL } from "../../lib/constants";

export const SITE = {
  key: "pulse",
  repo: "emelianovsergei/pulse-website",
  siteUrl: SITE_URL,
  businessName: BUSINESS_NAME,
  phone: PHONE,
  serviceAreas: [...SERVICE_AREAS] as string[],
  timezone: "America/Los_Angeles",
  categories: HVAC_CATEGORIES,
  location: SACRAMENTO_LOCATION,
  contentDir: "content/blog",
  /** The other autoblog site. Both sites serve Sacramento, so topics dedup across both. */
  sibling: {
    key: "promax",
    repo: "emelianovsergei/promax-website",
    siteUrl: "https://www.promaxhvac.com",
  },
  /** Mirrors the `blog-engine-review` flags in .github/workflows/autoblog-review.yml. */
  review: {
    site: "pulse",
    business: "HVAC Pulse",
    serviceAreas: [
      "Sacramento",
      "Carmichael",
      "Roseville",
      "Citrus Heights",
      "Folsom",
      "Elk Grove",
      "Rancho Cordova",
      "Fair Oaks",
    ],
  },
} as const;

/**
 * Category ids this site's own rotation rule would reject for the next post.
 * Pulse has none beyond the engine's recent mix (already in the brief).
 */
export function rotationBlocked(posts: Array<{ title: string; tags: string[] }>): string[] {
  void posts;
  return [];
}

/** EngineConfig exactly as the review CLI composes it for this site. */
export function reviewConfig(): EngineConfig {
  return {
    businessName: SITE.review.business,
    serviceAreas: [...SITE.review.serviceAreas],
    location: SACRAMENTO_LOCATION,
    categories: HVAC_CATEGORIES,
  };
}
