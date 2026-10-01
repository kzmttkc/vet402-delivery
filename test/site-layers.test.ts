/**
 * The site in two layers:
 *  - the Check page (index.html) holds only what a first-time visitor needs, in 120 words or fewer
 *    (the two example answers, computed from the data, are counted apart);
 *  - everything the first page used to say is still on the site, on the Sellers or the Method page;
 *  - the same four-place navigation on every page; no relative link points at nothing;
 *  - nothing on any page needs more than a phone's width (375 px).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadLanePublic } from "../src/evm/site.js";
import { escapeHtml, PUBLIC_LEAD, renderPublicSite, SITE_NAV, TOP_HEADING } from "../src/rank/html.js";
import { buildReport, DELIVERED_LINE, MONEY_LINE, REBUY_PLAN, type RankReport } from "../src/rank/report.js";
import { loadPublishedRecords } from "../src/receipt/publish.js";
import { recordsBySeller } from "../src/receipt/site.js";
import type { Attempt } from "../src/rank/types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pub = JSON.parse(readFileSync(join(ROOT, "site", "rank.json"), "utf8")) as RankReport;
const lanes = loadLanePublic(join(ROOT, "data"));
const pages = renderPublicSite(pub, { records: recordsBySeller(await loadPublishedRecords(join(ROOT, "data", "records"))), lanes });
const site = (rel: string) => readFileSync(join(ROOT, "site", rel), "utf8");

/** The words a reader sees in <main>: tags, styles and the example answers taken out. */
function visibleWords(html: string, { examples = false } = {}): string[] {
  let main = html.slice(html.indexOf("<main>"), html.indexOf("</main>"));
  main = main.replace(/<style>[\s\S]*?<\/style>/g, " ");
  if (!examples) main = main.replace(/<ul class="plain examples"[\s\S]*?<\/ul>/, " ");
  const text = main
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
}

test("Check page: 120 words or fewer, the example answers apart; heading, field, three numbers, two ways to use it", () => {
  const top = site("index.html");
  assert.equal(top, pages.get("index.html"));
  const words = visibleWords(top);
  assert.ok(words.length <= 120, `${words.length} words: ${words.join(" ")}`);
  const examples = visibleWords(top, { examples: true }).length - words.length;
  assert.ok(examples > 0 && examples <= 70, `example answers: ${examples} words`);
  assert.ok(top.includes(`<h1>${escapeHtml(TOP_HEADING)}</h1>`));
  assert.ok(top.includes("x402 lets an AI agent pay for an API call before it sees the answer."));
  assert.match(top, /on Solana, Base, Tempo, Arbitrum One, Robinhood Chain and Algorand, and shows what came back\./, "every chain, none first in the numbers");
  assert.equal((top.match(/<span class="big">/g) ?? []).length, 3, "three numbers");
  assert.ok(top.includes('<h2 id="use">Use it every time your agent pays</h2>'));
  assert.ok(top.includes('<pre class="cmd">wrapFetchWithPayment(wrapFetchWithCheck(fetch, { block: "avoid" }), client)</pre>'));
  assert.ok(!top.includes("<table"), "no seller table on the Check page");
  assert.ok(!top.includes("<details>"), "nothing folded");
  // The field comes before everything but the heading and the lead (first screen).
  assert.ok(top.indexOf('id="check-url"') < top.indexOf('<div class="stats">'));
});

test("Check page numbers add up every page (main and Algorand from rank.json, Arbitrum and Robinhood Chain from data/evm), and the Method page says so", () => {
  const main = pub.groups.find((g) => g.id === "main")!.totals;
  const algo = pub.groups.find((g) => g.id === "algorand")!.totals;
  const bought = (l: typeof lanes.arbitrum) => (l?.rows ?? []).filter((r) => ["delivered", "settled_no_answer", "not_settled", "withheld"].includes(r.status));
  const laneRows = [...bought(lanes.arbitrum), ...bought(lanes.robinhood)];
  const tried = main.tried + algo.tried + laneRows.length;
  const delivered = main.delivered + algo.delivered + laneRows.filter((r) => r.status === "delivered").length;
  const nothing = main.settledNotDelivered + algo.settledNotDelivered + laneRows.filter((r) => r.status === "settled_no_answer").length;
  const top = site("index.html");
  assert.ok(top.includes(`<span class="big">${tried}</span><br>purchases tried, from `));
  assert.ok(top.includes(`<span class="big">${delivered}</span><br>came back with an answer`));
  assert.ok(top.includes(`<span class="big">${nothing}</span><br>settled, and nothing usable came back`));
  const method = site("method.html");
  assert.ok(method.includes('<h2 id="totals">The numbers on the Check page</h2>'));
  assert.ok(method.includes(`Solana, Tempo and Base: ${main.tried} tried, ${main.delivered} came back, ${main.settledNotDelivered} settled with nothing usable back`));
  assert.ok(method.includes(`Algorand: ${algo.tried} tried`));
  assert.ok(method.includes("results held until the seller is told count as tried only"));
});

test("everything the first page used to say is on the second layer (Sellers or Method), unfolded", () => {
  const sellers = site("sellers.html");
  const method = site("method.html");
  // Only what is shown unfolded counts (the method page folds its catalog comparisons, nothing else).
  const second = sellers + method.replace(/<details>[\s\S]*?<\/details>/g, " ");
  const tempo = pub.chains.find((c) => c.chain === "tempo")!;
  const kept: [string, string][] = [
    ["lead", escapeHtml(PUBLIC_LEAD)],
    ["delivered definition", escapeHtml(DELIVERED_LINE)],
    ["money", escapeHtml(MONEY_LINE)],
    ["rebuy plan", escapeHtml(REBUY_PLAN)],
    ["grade condition", `A grade needs ${pub.method.minCounted} counted purchases on ${pub.method.minDays} different days`],
    ["Tempo body note", `for ${tempo.bodyUnchecked} of these ${tempo.tried} the runner kept no body`],
    ["not counted", "Not counted against any seller: <b>"],
    ["data/remeasure", "data/remeasure/"],
    ["corrections", escapeHtml(pub.method.correction)],
  ];
  for (const [what, text] of kept) assert.ok(second.includes(text), `${what} is on the Sellers or Method page`);
  for (const [what, text] of kept.slice(0, 7)) assert.ok(sellers.includes(text), `${what} stays next to the tables`);
  assert.ok(!sellers.includes("<details>"), "nothing folded on the Sellers page");
  // Each second-layer page says first what it tells.
  assert.match(sellers, /<h1>Sellers vet402 paid on Solana, Tempo and Base<\/h1>\n<p class="lead">Every seller vet402 bought from/);
  assert.match(site("use.html"), /<h1>Use vet402 in your agent<\/h1>\n<p class="lead">Every way to ask vet402 before an agent pays/);
  assert.match(method, /<h1>How vet402 measures<\/h1>\n<p class="lead">How vet402 buys, what it counts/);
  // For sellers: at the top of the Sellers page and on every seller page.
  assert.ok(sellers.indexOf('<h2 id="for-sellers">') < sellers.indexOf("<table"));
  for (const [rel, html] of pages) if (rel.startsWith("seller/")) assert.ok(html.includes('<h2 id="appeal">Are you the seller?</h2>'), rel);
  // Signed records: entered from the Method page's "Verify a record".
  assert.ok(method.includes('<h2 id="verify">Verify a record</h2>') && method.includes('<a href="records/index.html">All signed records, by day</a>'));
  // Use it: each way in, with an example and its spec on GitHub.
  const use = site("use.html");
  for (const id of ["http", "hook", "mcp", "cli", "verify", "program"]) assert.ok(use.includes(`<h2 id="${id}">`), `use.html#${id}`);
  assert.equal((use.match(/<pre class="cmd">/g) ?? []).length, 6, "a minimal example for each");
  assert.equal((use.match(/>Spec: /g) ?? []).length, 6, "a spec link for each");
});

test("the same four-place navigation on every page the site builds, in the same order", () => {
  const order = SITE_NAV.map((n) => n.label);
  assert.deepEqual(order, ["Check", "Sellers", "Use it", "Method"]);
  for (const [rel, html] of pages) {
    const nav = /<nav class="tabs site" aria-label="Site">([\s\S]*?)<\/nav>/.exec(html);
    assert.ok(nav, `${rel}: site navigation`);
    assert.deepEqual([...nav[1]!.matchAll(/>([^<]+)<\/a>/g)].map((m) => m[1]), order, rel);
    const prefix = rel.includes("/") ? "../" : "";
    assert.deepEqual([...nav[1]!.matchAll(/href="([^"]+)"/g)].map((m) => m[1]), SITE_NAV.map((n) => prefix + n.href), rel);
    assert.equal((nav[1]!.match(/aria-current="page"/g) ?? []).length, 1, `${rel}: one place is current`);
  }
});

test("no relative link on the built pages points at nothing (files and #anchors)", () => {
  const ids = (html: string) => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!));
  const broken: string[] = [];
  let checked = 0;
  for (const [rel, html] of pages) {
    for (const m of html.matchAll(/\bhref="([^"]+)"/g)) {
      const href = m[1]!.replace(/&amp;/g, "&");
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue; // https:, mailto: ...
      const [path, frag] = href.split("#") as [string, string | undefined];
      const target = path === "" ? rel : posix.normalize(posix.join(posix.dirname(rel), path));
      checked++;
      const built = pages.get(target);
      if (!built && !existsSync(join(ROOT, "site", target))) {
        broken.push(`${rel} -> ${href}`);
        continue;
      }
      if (frag && built && !ids(built).has(frag)) broken.push(`${rel} -> ${href} (no id)`);
    }
  }
  assert.ok(checked > 1000, `${checked} links followed`);
  assert.deepEqual(broken, []);
});

test("375 px: every page has the viewport tag, and nothing on the new pages is wider than the screen", () => {
  for (const [rel, html] of pages) assert.ok(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'), rel);
  const top = site("index.html");
  // main: max 760 px with 16 px sides; long code wraps; the form's field may shrink; nav and examples wrap.
  assert.ok(top.includes("main{max-width:760px;margin:0 auto;padding:20px 16px 48px}"));
  assert.ok(top.includes("pre.cmd{white-space:pre-wrap"));
  assert.ok(top.includes("code,.cmd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;overflow-wrap:anywhere}"));
  assert.ok(top.includes(".mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;overflow-wrap:anywhere}"), "example URLs break anywhere");
  assert.ok(top.includes(".checkbox input[type=url]{flex:1 1 220px;min-width:0;"));
  assert.ok(top.includes("nav.tabs{display:flex;flex-wrap:wrap;"));
  assert.ok(top.includes(".stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));"));
  for (const rel of ["index.html", "sellers.html", "use.html", "method.html"]) {
    const html = site(rel);
    // No fixed width above 343 px (375 minus the two 16 px sides) in the page's own styles or attributes.
    for (const m of html.matchAll(/(?<![\w-])(?:min-width|width)\s*:\s*(\d+)px/g)) assert.ok(Number(m[1]) <= 343, `${rel}: ${m[0]}`);
  }
});

test("a synthetic report with graded sellers keeps the Check page at 120 words", () => {
  const at = (host: string, i: number): Attempt => ({
    chain: "solana", source: "t", host, service: null, url: `https://${host}/x`, payTo: "P", expectedPayTo: null,
    at: i % 2 ? "2026-09-27T04:00:00.000Z" : "2026-09-28T04:00:00.000Z", tried: true, settled: true, delivered: true,
    category: "delivered", rawReason: "delivered", detail: null, tx: null, priceUsdc: "0.001000", httpStatus: 200,
    declaredMatch: null, bodyChecked: true, feedbackTx: null,
  });
  const r = buildReport({ date: "2026-09-28", generatedAt: "2026-09-28T00:00:00.000Z", attempts: Array.from({ length: 40 }, (_, i) => at("good.example", i)), excludeHosts: [], cdp: null, mercator: null, inputs: [] });
  const top = renderPublicSite(r, { lanes }).get("index.html")!;
  assert.ok(visibleWords(top).length <= 120, `${visibleWords(top).length} words`);
});
