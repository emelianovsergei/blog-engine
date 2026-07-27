/**
 * The edits a link sweep makes to published MDX once `links.ts` has decided a
 * URL is dead.
 *
 * Split from the crawling and file-writing in the consumer repos so the
 * rewriting rules can be tested directly, and kept HERE rather than in each
 * consumer because it was duplicated in two of them for exactly as long as it
 * took to accumulate six defects — a stray `!` from a removed image, an empty
 * `[](target)` link, a destination chopped at a nested paren, orphaned `****`
 * emphasis, and two argument-shape bugs. Every one existed in both copies
 * simultaneously, and each was found in whichever repo happened to be reviewed
 * first. One implementation, one set of tests, one place to fix.
 *
 * These run unattended against live content — a bug here ships to production
 * prose.
 */

import { isMap, isSeq, parseDocument } from "yaml";

const FRONTMATTER = /^(---\r?\n)([\s\S]*?)(\r?\n---\r?\n)/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove a dead URL where doing so cannot damage the sentence around it.
 *
 * Two forms are safe to rewrite unattended:
 *   - `[anchor text](dead)` -> `anchor text`. The anchor survives, so whatever
 *     grammatical role the link played is still filled.
 *   - a URL alone inside parentheses -> gone with its parens, the way any
 *     parenthetical aside can be lifted out.
 *
 * A **bare or autolinked URL in running prose is deliberately left alone**,
 * because deleting it changes what the sentence says. Real examples from this
 * repo's content: `— see https://…` becomes `— see .`; `Sources: URL, and …`
 * becomes `Sources:, and …`; a link-only list item becomes a naked `-`. The
 * sweep detects the survivor, reports it, and withholds the policy denial so a
 * human repairs the prose rather than publishing a broken sentence.
 *
 * `siblings` is every URL in the same file. A dead URL is very often a prefix
 * of a healthy one (`/page` retired, `/page/details` alive), so the destination
 * has to match exactly — otherwise the repair guts a link that was never broken.
 */
export function unlinkUrl(body: string, url: string, siblings: readonly string[]): string {
  const escaped = escapeRegExp(url);

  // Only URLs that extend this one can be damaged by the bare replacement.
  const extensions = siblings
    .filter((other) => other !== url && other.startsWith(url))
    .map((other) => escapeRegExp(other.slice(url.length)));
  const notAnExtension = extensions.length > 0 ? `(?!${extensions.join("|")})` : "";

  // Autolink or bare URL — the two forms that leave a hole in the prose.
  const loose = `(?:<${escaped}>|${escaped}${notAnExtension})`;

  // Destination must end here — optionally after a markdown title. The URL may
  // be angle-bracketed (`](<url>)`), which CommonMark allows and which the
  // parenthetical rule would otherwise swallow on its own, leaving `![alt]`.
  const destination =
    `\\(\\s*(?:<${escaped}>|${escaped})\\s*` + `(?:"[^"]*"|'[^']*'|\\([^)]*\\))?\\s*\\)`;

  // Any destination, live or dead — the half of a linked image that is not the
  // URL being removed.
  //
  // One level of nesting, NOT `[^)]*`. This repo's extractor deliberately
  // preserves URLs with balanced parens (`.../Heat_(HVAC)`), so the sweep does
  // encounter them; stopping at the first `)` chopped the destination mid-URL
  // and published the remainder as prose (`See) here.`).
  const anyDestination = `\\((?:[^()]|\\([^()]*\\))*\\)`;

  // Emphasis delimiters, matched as a pair via backreference.
  //
  // Asterisks and underscores are NOT interchangeable here. CommonMark allows
  // intraword emphasis with `*` but not with `_`, so `prefix_![x](dead)_suffix`
  // is an image between two LITERAL underscores — deleting them would rewrite
  // `prefix__suffix` into `prefix suffix`. The underscore variant therefore
  // requires non-word flanking; the asterisk variant does not.
  const star = `(\\*\\*|\\*)`;
  const underscore = `(?<![\\p{L}\\p{N}_])(__|_)`;
  const underscoreClose = `(?![\\p{L}\\p{N}_])`;

  // An image that is the entire content of a line — including under a list
  // marker, blockquote or heading — is structural, not prose. Removing just the
  // image leaves the marker behind as an empty list item or a bare `>`.
  const lineMarker = `(?:(?:[-*+]|\\d+\\.)[ \\t]+|>[ \\t]*|#{1,6}[ \\t]+)?`;
  const anyEmphasis = `(?:\\*\\*|\\*|__|_)?`;

  return (
    body
      // Whole-line images first, so the marker goes with them.
      .replace(
        new RegExp(
          `^[ \\t]*${lineMarker}${anyEmphasis}!\\[[^\\]]*\\]${destination}` +
            `${anyEmphasis}[ \\t]*(?:\\r?\\n|$)`,
          "gmu",
        ),
        "",
      )
      // LINKED IMAGES FIRST — `[![alt](img)](target)` — because every simpler
      // rule below mangles them. Each half can be the dead one, and they call
      // for opposite treatment.

      // Emphasis wrapping a doomed linked image goes with it, or the delimiters
      // are published as literal `****`.
      .replace(
        new RegExp(
          `([ \\t]*)${star}\\[!\\[[^\\]]*\\]${destination}\\]${anyDestination}\\2([ \\t]*)`,
          "gu",
        ),
        closeGap,
      )
      .replace(
        new RegExp(
          `([ \\t]*)${underscore}\\[!\\[[^\\]]*\\]${destination}\\]${anyDestination}\\2${underscoreClose}([ \\t]*)`,
          "gu",
        ),
        closeGap,
      )
      // Dead image, live target: the whole thing goes. Removing just the image
      // leaves `[](target)` — an empty link, which is invalid and unreachable
      // for anyone using a screen reader or a keyboard.
      .replace(
        new RegExp(
          `([ \\t]*)\\[!\\[[^\\]]*\\]${destination}\\]${anyDestination}([ \\t]*)`,
          "g",
        ),
        closeGap,
      )
      // Live image, dead target: keep the image, drop the wrapper. This is the
      // same rule as an ordinary link — shed the hyperlink, keep what it wrapped
      // — except the thing worth keeping is an image rather than anchor text.
      // Any emphasis around it survives with the image, so it needs no variant.
      .replace(new RegExp(`\\[(!\\[[^\\]]*\\]${anyDestination})\\]${destination}`, "g"), "$1")

      // Plain image. `![alt](dead)` differs from a link by one leading `!`, and
      // the link rule below would match the `[alt](dead)` inside it and leave a
      // malformed `!alt` sitting in the published prose.
      //
      // The whole construct goes, alt text included: an image is not prose with
      // a hyperlink to shed, and an image whose source is gone leaves nothing
      // worth keeping — its alt text as bare words would read as noise.
      .replace(
        new RegExp(`([ \\t]*)${star}!\\[[^\\]]*\\]${destination}\\2([ \\t]*)`, "gu"),
        closeGap,
      )
      .replace(
        new RegExp(
          `([ \\t]*)${underscore}!\\[[^\\]]*\\]${destination}\\2${underscoreClose}([ \\t]*)`,
          "gu",
        ),
        closeGap,
      )
      .replace(new RegExp(`([ \\t]*)!\\[[^\\]]*\\]${destination}([ \\t]*)`, "gu"), closeGap)
      // Ordinary link: keep the anchor text, drop the hyperlink.
      .replace(new RegExp(`\\[([^\\]]*)\\]${destination}`, "g"), "$1")
      // A URL alone inside parens takes the parens with it, rather than
      // leaving `()` for a global sweep to find later.
      .replace(new RegExp(`([ \\t]*)\\([ \\t]*${loose}[ \\t]*\\)([ \\t]*)`, "g"), closeGap)
  );
}

/**
 * Rejoin the prose either side of a removed link, at the removal site only.
 *
 * This replaced a document-wide `[ \t]{2,}` collapse, which in Markdown is
 * destructive: indentation carries meaning, so flattening every run of
 * horizontal whitespace un-nests list items and turns indented code blocks into
 * paragraphs — anywhere in the file, including passages that never contained
 * the dead link. Matching `[ \t]` and never `\n` also means a line's leading
 * indentation is touched only when the dead URL was sitting in it.
 *
 * Whether to leave a space is decided by the characters that end up ADJACENT,
 * not by how much whitespace the removed span happened to carry. Keying off the
 * captured whitespace gets both edges wrong: `See(dead) for details.` has none
 * on the left and welds into `Seefor details.`, while `Rebates vary (dead).`
 * has none on the right and would gain a space before the full stop. A
 * separator is inserted only between two word characters.
 */
function closeGap(...args: unknown[]): string {
  // Read offset/input from the END rather than by position: these patterns have
  // differing capture counts (emphasis adds a backreference group), and a
  // fixed-arity signature silently reads a capture as the offset when one is
  // added.
  const match = args[0] as string;
  const whole = args[args.length - 1] as string;
  const offset = args[args.length - 2] as number;
  const charBefore = whole[offset - 1] ?? "";
  const charAfter = whole[offset + match.length] ?? "";
  // Unicode letters/numbers, not `[A-Za-z0-9]`. An ASCII-only test reads
  // Cyrillic or CJK neighbours as non-words and returns no separator, welding
  // `До ![x](dead) после` into `Допосле`.
  const isWord = (char: string): boolean => /[\p{L}\p{N}]/u.test(char);
  return isWord(charBefore) && isWord(charAfter) ? " " : "";
}

/**
 * Drop whole `citations:` entries whose `url` is dead.
 *
 * Text-replacing the URL inside frontmatter would leave `{ name: "…", url: "" }`
 * behind, and a consumer that renders citations into JSON-LD emits that empty
 * string straight into the structured data — trading a dead link for malformed
 * markup. The entry has to go as a unit, which means editing the YAML as YAML.
 *
 * `parseDocument` keeps comments and scalar styles on untouched nodes, so the
 * repair diff stays limited to the entries actually removed.
 */
export function stripDeadCitations(
  raw: string,
  dead: ReadonlySet<string>,
): { text: string; removed: number } {
  const match = raw.match(FRONTMATTER);
  if (!match) return { text: raw, removed: 0 };

  // All three groups are non-optional in FRONTMATTER, so a match guarantees
  // them — but the engine compiles with noUncheckedIndexedAccess, which the
  // consumer repos did not. Asserted rather than `!`-ed so a future edit to the
  // pattern fails loudly here instead of producing `undefined` downstream.
  const [block, open, yamlText, close] = match;
  if (open === undefined || yamlText === undefined || close === undefined) {
    return { text: raw, removed: 0 };
  }

  const doc = parseDocument(yamlText);
  const citations = doc.get("citations", true);
  if (!isSeq(citations)) return { text: raw, removed: 0 };

  const keep = citations.items.filter((item) => {
    if (!isMap(item)) return true;
    const url = item.get("url");
    return !(typeof url === "string" && dead.has(url.trim()));
  });
  const removed = citations.items.length - keep.length;
  if (removed === 0) return { text: raw, removed: 0 };

  if (keep.length === 0) doc.delete("citations");
  else citations.items = keep;

  const rewritten = doc.toString().replace(/\r?\n+$/, "");
  return { text: `${open}${rewritten}${close}${raw.slice(block.length)}`, removed };
}

/**
 * Repair one MDX file: citations structurally, prose textually.
 *
 * The split is not cosmetic. `unlinkUrl` collapses runs of spaces, which is
 * right for a sentence and catastrophic for YAML — letting it near the
 * frontmatter flattens every citation entry's indentation and corrupts the
 * block. Frontmatter is only ever edited through the YAML document.
 *
 * A dead URL living in some *other* frontmatter field is deliberately left
 * alone: blanking an arbitrary YAML value is the same class of mistake as
 * leaving `url: ""` behind. The caller detects the leftover and flags it for a
 * human instead.
 */
export function repairContent(
  raw: string,
  dead: ReadonlySet<string>,
  siblings: readonly string[],
): { text: string; citationsRemoved: number } {
  const { text: withoutDeadCitations, removed } = stripDeadCitations(raw, dead);

  const match = withoutDeadCitations.match(FRONTMATTER);
  const head = match ? match[0] : "";
  let body = withoutDeadCitations.slice(head.length);
  for (const url of dead) body = unlinkUrl(body, url, siblings);

  return { text: `${head}${body}`, citationsRemoved: removed };
}
