/** Config-driven topic categorization and recent-mix analysis. */
import type { CategoryDef, ExistingPostLike } from "./types.js";

export interface RecentMix {
  /** Category id -> count within the recency window. */
  counts: Record<string, number>;
  /** Category ids of the recent posts, newest first. */
  ordered: string[];
  /** Category ids appearing twice or more in the window. */
  overrepresented: string[];
}

/**
 * Builds a keyword matcher over some text. Single alphanumeric keywords match
 * whole tokens (so "ac" does not match "back"); keywords with spaces or
 * punctuation ("a/c", "heat pump") fall back to substring matching.
 */
function buildMatcher(text: string): (keyword: string) => boolean {
  const lower = ` ${text.toLowerCase()} `;
  const tokens = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean));
  return (keyword: string): boolean => {
    const kw = keyword.toLowerCase();
    if (/^[a-z0-9]+$/.test(kw)) return tokens.has(kw);
    return lower.includes(kw);
  };
}

/**
 * Returns the id of the first category whose keywords match. When nothing
 * matches, falls back to the LAST category — presets are ordered so the last
 * entry is the broad catch-all (e.g. `hvac` for the HVAC + appliance set).
 */
export function categorizeText(
  categories: CategoryDef[],
  ...parts: Array<string | undefined>
): string {
  const match = buildMatcher(parts.filter(Boolean).join(" "));
  for (const category of categories) {
    if (category.keywords.some(match)) return category.id;
  }
  return categories[categories.length - 1]?.id ?? "";
}

export function categorizePost(categories: CategoryDef[], post: ExistingPostLike): string {
  return categorizeText(categories, post.title, post.tags.join(" "), post.description);
}

/**
 * Summarizes the categories of the most recent posts.
 * `posts` must be ordered newest-first.
 */
export function summarizeRecentCategories(
  categories: CategoryDef[],
  posts: ExistingPostLike[],
  windowSize = 3,
): RecentMix {
  const ordered = posts.slice(0, windowSize).map((post) => categorizePost(categories, post));
  const counts: Record<string, number> = {};
  for (const category of categories) counts[category.id] = 0;
  for (const id of ordered) counts[id] = (counts[id] ?? 0) + 1;
  const overrepresented = categories
    .map((category) => category.id)
    .filter((id) => (counts[id] ?? 0) >= 2);
  return { counts, ordered, overrepresented };
}
