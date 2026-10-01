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
import { AVOID_TOLD_LINE, BUY_README_LINES, escapeHtml, laneVerdictLine, mdInline, MIN_VERDICT_COUNTED, PUBLIC_LEAD, publicPage, renderPublicSite, SITE_NAV, siteSlugs, TOP_HEADING, USE_EXAMPLE_URL, VERDICT_LINE } from "../src/rank/html.js";
import { handleCheck } from "../packages/check/src/http.js";
import { buildReport, DELIVERED_LINE, MONEY_LINE, REBUY_PLAN, type RankReport } from "../src/rank/report.js";
import { loadPublishedRecords } from "../src/receipt/publish.js";
import { recordsBySeller, renderRecordsSite } from "../src/receipt/site.js";
import type { Attempt } from "../src/rank/types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pub = JSON.parse(readFileSync(join(ROOT, "site", "rank.json"), "utf8")) as RankReport;
const lanes = loadLanePublic(join(ROOT, "data"));
const loaded = await loadPublishedRecords(join(ROOT, "data", "records"));
const recordsIndex = JSON.parse(readFileSync(join(ROOT, "data", "records", "index.json"), "utf8")) as unknown;
const notified = JSON.parse(readFileSync(join(ROOT, "data", "records", "notified.json"), "utf8")) as unknown;
const pages = renderPublicSite(pub, { records: recordsBySeller(loaded), lanes, recordsIndex, notified });
// The records pages too (scripts/build-site.ts adds them the same way).
const slugs = siteSlugs(pub);
for (const [rel, html] of renderRecordsSite(loaded, { sellerSlug: (k) => slugs.get(k) ?? null, page: publicPage })) pages.set(rel, html);
const site = (rel: string) => readFileSync(join(ROOT, "site", rel), "utf8");

/** Every word a reader sees in <main> except the site navigation: headings, labels, the button and the examples included. */
function visibleWords(html: string): string[] {
  let main = html.slice(html.indexOf("<main>"), html.indexOf("</main>"));
  main = main.replace(/<style>[\s\S]*?<\/style>/g, " ").replace(/<nav class="tabs site"[\s\S]*?<\/nav>/, " ");
  const text = main
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  return text.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w));
}

test("Check page: 120 visible words or fewer (all but the navigation), in plain fixed terms", () => {
  const top = site("index.html");
  assert.equal(top, pages.get("index.html"));
  const words = visibleWords(top);
  assert.ok(words.length <= 120, `${words.length} words: ${words.join(" ")}`);
  const text = words.join(" ");
  assert.ok(top.includes(`<h1>${escapeHtml(TOP_HEADING)}</h1>`));
  assert.ok(text.includes("x402 lets an AI agent pay for an API call before it sees the answer."));
  assert.match(text, /on Solana, Base, Tempo, Arbitrum One, Robinhood Chain and Algorand, and shows what came back\. Free, no key\./, "every chain, then Free, no key.");
  assert.ok(text.includes(VERDICT_LINE), "the three verdicts defined in one line");
  for (const banned of ["Answer:", "came back with an answer", "that count"]) assert.ok(!text.includes(banned), `not on the Check page: ${banned}`);
  assert.ok(!top.includes('<span class="big">'), "the numbers are one line, not cards");
  assert.ok(top.includes('<h2 id="use">Check every payment</h2>'));
  assert.ok(top.includes('<pre class="cmd">wrapFetchWithPayment(wrapFetchWithCheck(fetch, { block: "avoid" }), client)</pre>'));
  assert.ok(top.includes('<p>On avoid, your agent never signs. <a href="use.html">More ways →</a></p>'));
  assert.ok(!top.includes("/v1/buy") && !top.includes("curl "), "curl and proxy buy are on use.html only");
  assert.ok(!top.includes("<table"), "no seller table on the Check page");
  assert.ok(!top.includes("<details>"), "nothing folded");
  assert.ok(top.indexOf('id="check-url"') < top.indexOf('class="plain examples"'));
});

test("Check page: the verdict labels differ by word and by frame style, not by colour alone", () => {
  const top = site("index.html");
  for (const v of ["avoid", "pay"]) assert.ok(top.includes(`<span class="v v-${v}">${v}</span>`), v);
  for (const rule of [".v-avoid{border-color:var(--gD)}", ".v-pay{border-color:var(--gA)}", ".v-unknown{border-style:dashed;color:var(--dim)}"]) assert.ok(top.includes(rule), rule);
});

/** Hosts with a settled payment on any page, counted once (the Check page's seller count). */
function sellersWithSettled(): number {
  const hosts = new Set<string>();
  for (const g of pub.groups) if (g.id === "main" || g.id === "algorand") for (const s of g.ranking) if (s.settled > 0) hosts.add(s.host.toLowerCase());
  for (const l of [lanes.arbitrum, lanes.robinhood]) for (const r of l?.rows ?? []) if ((r.status === "delivered" || r.status === "settled_no_answer") && r.resource) hosts.add(new URL(r.resource).hostname.toLowerCase());
  return hosts.size;
}

test("Check page numbers add up every page (main and Algorand from rank.json, Arbitrum and Robinhood Chain from data/evm), and the Method page says so", () => {
  const main = pub.groups.find((g) => g.id === "main")!.totals;
  const algo = pub.groups.find((g) => g.id === "algorand")!.totals;
  const laneRows = [...(lanes.arbitrum?.rows ?? []), ...(lanes.robinhood?.rows ?? [])];
  const n = (st: string) => laneRows.filter((r) => r.status === st).length;
  const settled = main.settled + algo.settled + n("delivered") + n("settled_no_answer");
  const delivered = main.delivered + algo.delivered + n("delivered");
  const nothing = main.settledNotDelivered + algo.settledNotDelivered + n("settled_no_answer");
  const top = site("index.html");
  assert.ok(top.includes(`<p>${settled} paid calls to ${sellersWithSettled()} sellers. ${nothing} returned nothing usable. As of ${pub.date}. <a href="method.html#totals">Sources</a></p>`));
  assert.ok(!/\btried\b/.test(visibleWords(top).join(" ")), "no count of tries on the Check page");
  assert.ok(delivered + nothing <= settled, "the numbers start from settled payments");
  const method = site("method.html");
  assert.ok(method.includes('<h2 id="totals">The numbers on the Check page</h2>'));
  assert.ok(method.includes(`Solana, Tempo and Base: ${main.settled} settled, ${main.delivered} came back, ${main.settledNotDelivered} settled with nothing usable back, out of ${main.tried} tried`));
  assert.ok(method.includes(`Algorand: ${algo.settled} settled`));
  assert.ok(method.includes("On Algorand, settled means the facilitator returned a settlement receipt with a tx id; vet402 has not read those payments back on chain."));
  assert.ok(method.includes("a result held until the seller is told is counted as tried only, and in none of the Check page's numbers"));
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
  for (const id of ["http", "python", "curl", "hook", "mcp", "cli", "verify", "program"]) assert.ok(use.includes(`<h2 id="${id}">`), `use.html#${id}`);
  for (const id of ["buy"]) assert.ok(use.includes(`<h2 id="${id}">`), `use.html#${id}`);
  assert.ok(use.indexOf('<h2 id="http">') < use.indexOf('<h2 id="python">') && use.indexOf('<h2 id="curl">') < use.indexOf('<h2 id="hook">'), "Python and curl right after the HTTP spec");
  assert.equal((use.match(/<pre class="cmd">/g) ?? []).length, 10, "a minimal example for each, and the live answer");
  assert.equal((use.match(/>Spec: /g) ?? []).length, 9, "a spec link for each");
});

test("Use it, proxy buy: every line is word for word in the README's Proxy buy section (the README is the source), and the Check page links to it", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const section = readme.slice(readme.indexOf("## Proxy buy"), readme.indexOf("\n## ", readme.indexOf("## Proxy buy") + 5));
  const use = site("use.html");
  const buy = use.slice(use.indexOf('<h2 id="buy">'), use.indexOf('<h2 id="mcp">'));
  for (const line of BUY_README_LINES) {
    assert.ok(section.includes(line), `not in the README's Proxy buy section: ${line}`);
    assert.ok(buy.includes(mdInline(line)), `not on use.html: ${line}`);
  }
  for (const fact of ["plus 0.005", "already paid with a settled payment and that delivered at least once", "vet402 refunds the full payment", "there is no refund. The purchase is recorded against the seller", "1,000,000 bytes is not forwarded", "both transactions", "/v1/buy/records/"])
    assert.ok(buy.includes(escapeHtml(fact)), fact);
  assert.ok(buy.includes(`curl -i 'https://vet402-delivery.vercel.app/v1/buy?url=&lt;seller endpoint&gt;'   # free: shows the price, charges nothing`));
  assert.ok(readme.includes("curl -i 'https://vet402-delivery.vercel.app/v1/buy?url=<seller endpoint>'   # free: shows the price, charges nothing"));
  assert.ok(!use.includes("&#96;"), "no backtick shown as a character");
  assert.ok(!/<b>(\w[\w ]*):<\/b> \1/i.test(buy), "no label said twice");
  assert.ok(buy.indexOf("<b>Solana only for now.</b>") < buy.indexOf("Price: the seller"), "Tempo is off: said before the price line");
});

test("Use it: the verdict first, the live answer built from the data, the hook's chains, Arbitrum and Robinhood Chain measured", async () => {
  const use = site("use.html");
  assert.ok(use.indexOf('<h2 id="verdict">What the verdict means</h2>') < use.indexOf('<h2 id="http">'), "the verdict before every way in");
  assert.equal(MIN_VERDICT_COUNTED, 4);
  assert.ok(use.includes(`With 1 to ${MIN_VERDICT_COUNTED - 1} counted calls the verdict is always unknown`));
  // The JSON shown is what api/check.ts answers for the same files.
  const lanesRaw = ["arbitrum", "robinhood"].map((l) => JSON.parse(readFileSync(join(ROOT, "data", "evm", `${l}.json`), "utf8")));
  const res = await handleCheck(new Request(`https://h.example/v1/check?url=${encodeURIComponent(USE_EXAMPLE_URL)}`), () => ({ rank: pub, recordsIndex, lanes: lanesRaw, notified }));
  const live = (await res.json()) as unknown;
  assert.ok(use.includes(`<pre class="cmd">${escapeHtml(JSON.stringify(live, null, 2))}</pre>`), "the answer on use.html is the endpoint's, byte for byte");
  assert.ok(use.includes("so it works under any x402 client that pays through <code>fetch</code>"));
  assert.ok(use.includes("the hook is not Solana-only"));
  assert.ok(use.includes("On Robinhood Chain and Arbitrum, a purchase whose result is held until the seller is told is never used: the verdict comes from the published purchases, and the answer adds <code>heldPurchases</code> and <code>heldNote</code>. A seller with nothing but held purchases is unknown."));
  assert.ok(!use.includes("seller_not_told"), "no held mark");
  assert.ok(use.includes(escapeHtml(AVOID_TOLD_LINE)), "the same sentence for every seller: when avoid can be said");
  const line = laneVerdictLine(pub, recordsIndex, lanes, notified);
  assert.match(line, /^As of the 2026-09-30 run, all 63 Arbitrum One sellers are unknown and all 14 Robinhood Chain sellers are unknown:/);
  assert.ok(use.includes(escapeHtml(line)));
});

test("Sellers page: a grade and the Check page's verdict are said to be different things", () => {
  const sellers = site("sellers.html");
  assert.ok(sellers.includes(`A grade is not the verdict on the Check page. A grade (A to D) orders sellers and needs ${pub.method.minCounted} counted purchases on ${pub.method.minDays} days; the verdict (pay, avoid, unknown) answers one question before paying, and can be given from ${MIN_VERDICT_COUNTED} counted purchases on ${pub.method.minDays} days.`));
  assert.ok(!sellers.includes("not a verdict"));
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
