/**
 * The cut the rank makes to a detail (its first 200 characters and "…", src/remeasure/normalize.ts and
 * src/rank/normalize.ts), made so that the cut itself never gives the secret gate's scan of the tree something to stop
 * on. The rank's detail is published twice: as a JSON string (site/rank.json, the reports) and in the site's HTML
 * (src/rank/html.ts, inside <span class="mono">). A cut can leave a piece of a mark, a mark without its closing
 * quote, or a secret name with nothing after it ("access_token=…"), and any of those is a new finding there, which
 * halts the publish after the day's purchases.
 *
 * So the cut text is put through the gate's own detection in both places, and only findings the whole detail does
 * not already have count (the whole detail is judged as it is, by the allow list or the copy step). With one or
 * more, the cut moves back one character at a time until there is none: the longest cut that adds nothing. In the
 * end that leaves out the whole value a mark stands in, and at worst everything ("…").
 *
 * One kind is left out of that count: opaque-40, a random-looking run the cut shortens (a transaction id cut at 200
 * characters). The site has published such pieces since 2026-09-27 and site/rank.json must stay what the rank makes
 * of data/ (test/site.test.ts), so moving those cuts would change pages already public. A piece like that is judged
 * by the tree's scan and the allow list as before.
 */
import { cutKeepingMarks } from "./marks.js";
import { scanFileText } from "./secret-gate.js";

/** The same escaping as escapeHtml in src/rank/html.ts (test/detail-cut-bounds.test.ts holds them equal). */
export function siteHtmlEscape(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/`/g, "&#96;");
}

/** Every finding the gate makes of a detail where it is published, as "<kind>:<sha256>". */
function publishedFindings(d: string): Set<string> {
  const json = scanFileText(JSON.stringify({ detail: d }, null, 2), "rank.json");
  const html = scanFileText(`<div class="meta"><span class="mono">${siteHtmlEscape(d)}</span></div>\n`, "index.html");
  return new Set([...json, ...html].filter((f) => f.kind !== "opaque-40").map((f) => `${f.kind}:${f.sha256}`));
}

/** The detail kept to about `n` characters and "…", with no finding the whole detail does not have. */
export function cutDetail(v: string | null, n = 200): string | null {
  if (v === null || v.length <= n) return v;
  // a mark the cut would split is first kept whole (./marks.ts), then the check below has the last word
  const first = cutKeepingMarks(v, n)!;
  if (first === v) return v;
  const whole = publishedFindings(v);
  const adds = (c: string) => [...publishedFindings(c)].some((k) => !whole.has(k));
  if (!adds(first)) return first;
  for (let end = first.length - 2; end > 0; end--) {
    const c = `${v.slice(0, end)}…`;
    if (!adds(c)) return c;
  }
  return "…";
}
