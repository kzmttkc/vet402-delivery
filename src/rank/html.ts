/**
 * Static HTML for the rank report: index.html (Solana, Tempo, Base), algorand.html, method.html, and one
 * page per seller under seller/. Readable at phone width, no scripts, no external requests.
 * scripts/build-site.ts writes them to site/ (GitHub Pages); scripts/rank.ts writes the same pages next to the report.
 *
 * Every string that a seller can influence (host, URL, payTo, reason text, tx id) goes through
 * escapeHtml. Links are built only from tx ids that match the chain's id format, onto a fixed
 * explorer origin, so a seller-supplied value can never become a link target. Seller page file names
 * are reduced to [a-z0-9._-]; the correction link is a fixed GitHub URL with an encoded query.
 */
import { chainName } from "../receipt/html.js";
import { FAULT_LABEL, ruleById } from "./classify.js";
import type { Comparison, CompareRow } from "./compare.js";
import { APPEAL_ISSUES_URL, DELIVERED_LINE, GROUPS, groupById, MONEY_LINE, REBUY_PLAN, rebuyFacts, rebuySeller, type GroupId, type GroupReport, type RankReport } from "./report.js";
import type { ChainFigures, Grade, RankedSeller } from "./score.js";
import type { Chain, Fault, ReasonCategory } from "./types.js";

export function escapeHtml(v: unknown): string {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/`/g, "&#96;");
}

const TX_FORMAT: Record<Chain, { re: RegExp; base: string }> = {
  algorand: { re: /^[A-Z2-7]{52}$/, base: "https://allo.info/tx/" },
  solana: { re: /^[1-9A-HJ-NP-Za-km-z]{64,90}$/, base: "https://solscan.io/tx/" },
  tempo: { re: /^0x[0-9a-fA-F]{64}$/, base: "https://explore.tempo.xyz/tx/" },
  base: { re: /^0x[0-9a-fA-F]{64}$/, base: "https://basescan.org/tx/" },
};

/** Explorer URL for a tx id, or null when the id does not match the chain's format. */
export function txUrl(chain: Chain, tx: string): string | null {
  const f = TX_FORMAT[chain];
  return f && f.re.test(tx) ? f.base + tx : null;
}

export function txHtml(chain: Chain, tx: string | null): string {
  if (!tx) return "";
  const short = tx.length > 16 ? `${tx.slice(0, 8)}…${tx.slice(-6)}` : tx;
  const url = txUrl(chain, tx);
  return url
    ? `<a class="mono" href="${escapeHtml(url)}" rel="noopener noreferrer nofollow">${escapeHtml(short)}</a>`
    : `<span class="mono" title="${escapeHtml(tx)}">${escapeHtml(short)}</span>`;
}

const CATEGORY_LABEL: Record<ReasonCategory, string> = {
  delivered: "came back with an answer",
  not_settled: "payment not settled",
  settled_error_status: "paid, error status",
  settled_empty_body: "paid, empty answer",
  unconfirmed_server_error: "5xx, settlement unknown",
  not_payable: "not buyable",
  payto_changed: "payTo changed",
  vet402_skipped: "skipped by vet402",
};

const GRADE_TEXT: Record<Grade, { mark: string; label: string }> = {
  A: { mark: "A", label: "comes back with an answer 90%+ of the time" },
  B: { mark: "B", label: "comes back with an answer 75%+ of the time" },
  C: { mark: "C", label: "comes back with an answer 50%+ of the time" },
  D: { mark: "D", label: "comes back with an answer less than half the time" },
  undecided: { mark: "?", label: "unclear so far" },
  measuring: { mark: "…", label: "still measuring" },
};

function pct(x: number): string {
  return `${(x * 100).toFixed(x === 1 || x === 0 ? 0 : 1)}%`;
}

function day(at: string | null): string {
  return at ? at.slice(0, 10) : "–";
}

function when(at: string): string {
  return `${at.slice(0, 16).replace("T", " ")} UTC`;
}

function countsText(f: Partial<Record<string, number>>, label: (k: string) => string): string {
  return Object.entries(f)
    .filter(([, n]) => (n ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([k, n]) => `${label(k)} ${n}`)
    .join(", ");
}

function ruleLabel(id: string): string {
  return ruleById(id)?.id.replace(/_/g, " ") ?? id;
}

/** File name for a seller page: [a-z0-9._-] only, never "." or "..", unique within the report. */
export function sellerSlugs(keys: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const key of keys) {
    let base = key
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "_")
      .replace(/\.{2,}/g, "_")
      .replace(/^[.-]+/, "_")
      .slice(0, 120);
    if (base === "" || base === "_") base = "seller";
    let slug = base;
    for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
    used.add(slug);
    out.set(key, slug);
  }
  return out;
}

/** GitHub "new issue" link for a correction, with the seller and report date prefilled. */
export function appealUrl(key: string, date: string): string {
  const title = `Rank correction: ${key}`;
  const body = `Seller: ${key}\nReport: ${date}\nWhich row is wrong (URL or tx):\nWhat actually happened:\n`;
  return `${APPEAL_ISSUES_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

const CSS = `
:root{--bg:#fbfbf9;--fg:#1d1d1b;--dim:#62625d;--line:#e2e1dc;--card:#fff;--warn:#9a3b00;--link:#0b5cad;
--gA:#1f7a3d;--gB:#3f7f6a;--gC:#8a6400;--gD:#b3261e;--gU:#62625d;--on:#fff}
@media (prefers-color-scheme: dark){:root{--bg:#141413;--fg:#ecebe6;--dim:#a8a79f;--line:#34332f;--card:#1d1d1b;--warn:#ffb27a;--link:#8cc2ff;
--gA:#5cc27f;--gB:#7cc1a9;--gC:#e0b64a;--gD:#ff8a80;--gU:#a8a79f;--on:#141413}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:1.45rem;line-height:1.25;margin:0 0 6px;overflow-wrap:anywhere}h2{font-size:1.1rem;margin:28px 0 8px}h3{font-size:1rem;margin:18px 0 6px}
p{margin:6px 0}a{color:var(--link)}ul,ol{padding-left:1.2em}
.lead{font-size:1.05rem;margin:4px 0}
.dim{color:var(--dim)}.warn{color:var(--warn)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;overflow-wrap:anywhere}
.g{display:inline-block;min-width:1.7em;padding:0 .3em;border-radius:5px;text-align:center;font-weight:700;color:var(--on);font-variant-numeric:tabular-nums}
.gA{background:var(--gA)}.gB{background:var(--gB)}.gC{background:var(--gC)}.gD{background:var(--gD)}.gundecided{background:var(--gU)}
.gmeasuring{background:transparent;color:var(--dim);border:1px solid var(--line)}
.legend{font-size:.85rem;color:var(--dim);display:flex;flex-wrap:wrap;gap:4px 12px;margin:12px 0}
.legend span.item{min-width:0}
ol.board{list-style:none;padding:0;margin:8px 0}
.board li{display:grid;grid-template-columns:2.4em 2em minmax(0,1fr) auto 5.6em;gap:0 8px;align-items:baseline;padding:8px 0;border-bottom:1px solid var(--line)}
.board .head{font-size:.8rem;color:var(--dim);border-bottom:1px solid var(--fg)}
.board .rk{color:var(--dim);font-variant-numeric:tabular-nums;text-align:right}
.board .name{font-weight:600;overflow-wrap:anywhere;min-width:0}
.board .num,.board .date{font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.board .date{color:var(--dim);font-size:.85rem}
.board .sub{grid-column:3 / -1;font-size:.8rem;color:var(--dim)}
@media (max-width:420px){.board li{grid-template-columns:2em 1.9em minmax(0,1fr) auto}.board .date{grid-column:3 / -1;text-align:left}}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin:12px 0}
.stats>div{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;font-size:.85rem;color:var(--dim)}
.big{font-size:1.25rem;font-weight:700;color:var(--fg);font-variant-numeric:tabular-nums}
.bar{position:relative;height:10px;background:var(--line);border-radius:5px;margin:8px 0 2px}
.bar span{position:absolute;top:0;bottom:0;background:var(--fg);opacity:.35;border-radius:5px}
.bar i{position:absolute;top:-3px;bottom:-3px;width:3px;margin-left:-1px;background:var(--fg)}
.scale{display:flex;justify-content:space-between;font-size:.75rem;color:var(--dim)}
ul.plain,ol.plain{list-style:none;padding:0;margin:0}
.plain li{padding:8px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
.meta{font-size:.85rem;color:var(--dim);overflow-wrap:anywhere}
.fault{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:8px 0;background:var(--card)}
.fault b.big{margin-right:6px}
details{margin:12px 0}summary{cursor:pointer;font-weight:600}
nav{margin-bottom:12px;font-size:.9rem}
footer{margin-top:32px;padding-top:12px;border-top:1px solid var(--line);font-size:.9rem;display:flex;flex-wrap:wrap;gap:6px 16px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums;font-size:.9rem}
th,td{border-bottom:1px solid var(--line);padding:6px 3px;text-align:right}th{font-size:.8rem;font-weight:600;vertical-align:bottom}th:first-child,td:first-child{text-align:left}
`;

function outcomeText(a: RankedSeller["recent"][number]): string {
  if (a.delivered) return "came back with an answer";
  return `${FAULT_LABEL[a.fault!]}: ${ruleLabel(a.rule!)}`;
}

function compareRow(r: CompareRow, metricIsRank: boolean): string {
  const value = metricIsRank ? `best rank ${r.catalogValue}` : `${r.catalogValue.toLocaleString("en-US")} calls/30d`;
  const f = r.delivered === 0 ? r.lastFailure : null;
  const why = f
    ? `<div class="meta">${escapeHtml(f.chain)} · ${escapeHtml(ruleLabel(f.rule))} · <span class="mono">${escapeHtml(f.rawReason)}</span>${f.detail ? ` · <span class="mono">${escapeHtml(f.detail)}</span>` : ""}</div>
  <div class="meta mono">${escapeHtml(f.url)}</div>`
    : "";
  return `<li><b class="mono">${escapeHtml(r.key)}</b><br>
  catalog #${r.catalogPos} (${escapeHtml(value)}) · vet402 ${r.vet402Rank === null ? "measuring" : `#${r.vet402Rank}`}: <b>${r.delivered}/${r.tried}</b> came back ${r.tx ? txHtml(r.tx.chain, r.tx.tx) : ""}
  ${why}</li>`;
}

function comparisonSection(c: Comparison): string {
  const isRank = c.direction === "asc";
  const list = (rows: CompareRow[]) =>
    rows.length ? `<ol class="plain">${rows.slice(0, 10).map((r) => compareRow(r, isRank)).join("\n")}</ol>${rows.length > 10 ? `<p class="dim">…and ${rows.length - 10} more in the JSON.</p>` : ""}` : `<p class="dim">none</p>`;
  return `<h4>${escapeHtml(c.catalog)} order vs vet402</h4>
<p class="meta">${escapeHtml(c.rule)}</p>
<div class="stats">
  <div><span class="big">${c.overlap}</span><br>sellers in both</div>
  <div><span class="big">${c.highButNeverDelivered.length}</span><br>high in catalog, never came back (${c.highButNeverDeliveredDespitePaidTx} after a settled payment)</div>
  <div><span class="big">${c.lowButAlwaysDelivered.length}</span><br>low in catalog, always came back</div>
  <div><span class="big">${c.spearman === null ? "–" : c.spearman.toFixed(2)}</span><br>rank correlation</div>
</div>
<details><summary>High in the catalog, never came back with an answer</summary>${list(c.highButNeverDelivered)}</details>
<details><summary>Low in the catalog, came back every time</summary>${list(c.lowButAlwaysDelivered)}</details>`;
}

// ---------------------------------------------------------------------------------------------------
// Public site (site/, GitHub Pages): index.html (Solana, Tempo, Base), algorand.html, method.html and
// seller/<slug>.html next to rank.json. Each page is graded from its own chains only (method v3).
// Same escaping and link rules as above. The wording speaks of vet402 in the third person.
// ---------------------------------------------------------------------------------------------------

/** The public repository that holds the code, the inputs (data/) and this site. */
export const PUBLIC_REPO_URL = "https://github.com/kzmttkc/vet402-delivery";

/** The separate Algorand entry whose census files are the Algorand page's inputs. */
const ALGORAND_REPO_URL = "https://github.com/kzmttkc/vet402-algorand";

/** What vet402 does, in plain words, then how it pays for it. Also the meta description of the first page. */
export const PUBLIC_LEAD =
  "Before an AI agent pays for an API, vet402 buys it with its own money and shows what came back. Grades come only from vet402's own purchases.";

const CHAIN_LABEL: Record<Chain, string> = { algorand: "Algorand", solana: "Solana", tempo: "Tempo", base: "Base" };

const TAB_LABEL: Record<GroupId, string> = { main: "Solana, Tempo, Base", algorand: "Algorand" };

/** "settled" per page: read back on chain (Solana, Tempo, Base) or a facilitator's settlement receipt (Algorand). */
const SETTLED_TEXT: Record<GroupId, { stat: string; short: string; nothing: string }> = {
  main: { stat: "payments settled on chain", short: "settled on chain", nothing: "settled on chain, and nothing usable came back" },
  algorand: { stat: "with a settlement receipt (tx id)", short: "with a settlement receipt", nothing: "with a settlement receipt, and nothing usable came back" },
};

const PUBLIC_GRADE_TEXT: Record<Grade, string> = {
  A: "90%+ came back",
  B: "75%+",
  C: "50%+",
  D: "under 50%",
  undecided: "undecided",
  measuring: "measuring",
};

const PUBLIC_CSS = `
nav.tabs{display:flex;flex-wrap:wrap;gap:4px 16px;margin:0 0 14px;font-size:.95rem}
nav.tabs a[aria-current="page"]{color:var(--fg);font-weight:700;text-decoration:none;border-bottom:2px solid var(--fg)}
table.board{table-layout:fixed;width:100%;margin:8px 0;font-size:.95rem}
table.board caption{text-align:left;font-size:.85rem;color:var(--dim);padding:0 0 6px}
table.board th,table.board td{padding:7px 3px;vertical-align:baseline;border-bottom:1px solid var(--line)}
table.board thead th{border-bottom:1px solid var(--fg)}
table.board .rk{width:2.3em;text-align:right;color:var(--dim)}
table.board .gr{width:2.2em;text-align:center}
table.board .name{text-align:left;overflow-wrap:anywhere;word-break:break-word}
table.board .num{width:5.3em;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
table.board .date{width:3.6em;text-align:right;white-space:nowrap;color:var(--dim);font-size:.85rem;padding-left:6px}
table.board td.name a{font-weight:600}
table.board .sub{display:block;font-size:.78rem;color:var(--dim);font-weight:400}
table.chain .num{width:3.9em}
table.chain th.num{white-space:normal}
.notcounted{border-left:3px solid var(--line);padding:4px 0 4px 10px;margin:10px 0;font-size:.9rem}
.nw{white-space:nowrap}
.legend{display:block}
code,.cmd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;overflow-wrap:anywhere}
pre.cmd{white-space:pre-wrap;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;margin:8px 0}
`;

export function publicPage(title: string, description: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<meta name="description" content="${escapeHtml(description)}">
<title>${escapeHtml(title)}</title>
<style>${CSS}${PUBLIC_CSS}</style>
</head>
<body><main>
${body}
</main></body></html>
`;
}

function publicBadge(g: Grade): string {
  return `<span class="g g${g}" title="${escapeHtml(PUBLIC_GRADE_TEXT[g])}">${GRADE_TEXT[g].mark}</span>`;
}

const GRADE_ORDER: Grade[] = ["A", "B", "C", "D", "undecided", "measuring"];

/** One line: A 90%+ came back · B 75%+ · C 50%+ · D under 50% · ? undecided · … measuring. */
function publicLegend(): string {
  const items = GRADE_ORDER.map((g) => `${publicBadge(g)} ${escapeHtml(PUBLIC_GRADE_TEXT[g])}`).join(" · ");
  return `<p class="legend meta">${items}</p>`;
}

/** The two pages as tabs (links: the site has no scripts), plus the method page. prefix is "../" from seller pages. */
function tabs(current: GroupId | null, prefix = ""): string {
  const links = GROUPS.map((g) =>
    g.id === current
      ? `<a href="${prefix}${g.page}" aria-current="page">${escapeHtml(TAB_LABEL[g.id])}</a>`
      : `<a href="${prefix}${g.page}">${escapeHtml(TAB_LABEL[g.id])}</a>`,
  );
  return `<nav class="tabs" aria-label="Pages">${links.join("")}<a href="${prefix}method.html">How vet402 measures</a></nav>`;
}

function chainList(s: RankedSeller): string {
  return (Object.keys(s.chains) as Chain[])
    .filter((c) => (s.chains[c]?.tried ?? 0) > 0)
    .map((c) => CHAIN_LABEL[c] ?? c)
    .join(", ");
}

function monthDay(at: string | null): string {
  return at ? at.slice(5, 10) : "–";
}

function dateCell(at: string | null): string {
  return at ? `<time datetime="${escapeHtml(at.slice(0, 10))}">${escapeHtml(monthDay(at))}</time>` : "–";
}

function notCountedFor(s: RankedSeller): number {
  return s.excluded.vet402_or_facilitator + s.excluded.unknown;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function publicRow(s: RankedSeller, slug: string): string {
  const nc = notCountedFor(s);
  const sub = [chainList(s), nc ? `${nc} not counted` : ""].filter(Boolean).join(" · ");
  return `<tr><td class="rk">${s.rank ?? ""}</td><td class="gr">${publicBadge(s.grade)}</td><td class="name"><a href="seller/${escapeHtml(slug)}.html">${escapeHtml(s.key)}</a><span class="sub">${escapeHtml(sub)}</span></td><td class="num">${s.delivered}/${s.counted}</td><td class="date">${dateCell(s.lastMeasuredAt)}</td></tr>`;
}

function publicTable(caption: string, rows: RankedSeller[], slugs: Map<string, string>): string {
  return `<table class="board">
<caption>${escapeHtml(caption)}</caption>
<thead><tr><th class="rk" scope="col">#</th><th class="gr" scope="col"><span title="grade">gr.</span></th><th class="name" scope="col">seller · chain</th><th class="num" scope="col">came back</th><th class="date" scope="col">last</th></tr></thead>
<tbody>
${rows.map((s) => publicRow(s, slugs.get(s.key)!)).join("\n")}
</tbody>
</table>`;
}

/** One chain on the first page: every seller bought on it, by name, with that chain's figures only. */
function chainTable(chain: Chain, rows: RankedSeller[], slugs: Map<string, string>): string {
  const body = rows
    .map((s) => {
      const f = s.chains[chain]!;
      const sub = [`last ${monthDay(f.lastAt)}`, s.grade === "measuring" ? "" : `grade ${GRADE_TEXT[s.grade].mark} on this page`].filter(Boolean).join(" · ");
      return `<tr><td class="name"><a href="seller/${escapeHtml(slugs.get(s.key)!)}.html">${escapeHtml(s.key)}</a><span class="sub">${escapeHtml(sub)}</span></td><td class="num">${f.tried}</td><td class="num">${f.settled}</td><td class="num">${f.delivered}</td></tr>`;
    })
    .join("\n");
  return `<table class="board chain">
<caption>Sorted by name. tried = vet402 sent a payment; settled = the payment settled on chain; came back = settled, then an answer.</caption>
<thead><tr><th class="name" scope="col">seller</th><th class="num" scope="col">tried</th><th class="num" scope="col">settled</th><th class="num" scope="col">came back</th></tr></thead>
<tbody>
${body}
</tbody>
</table>`;
}

/** "2026-09-28 to 2026-09-29 (UTC)" as HTML; a date never breaks at its hyphens on a phone. */
function periodHtml(t: { firstPurchaseAt: string | null; lastPurchaseAt: string | null }): string {
  return `<span class="nw">${escapeHtml(day(t.firstPurchaseAt))}</span> to <span class="nw">${escapeHtml(day(t.lastPurchaseAt))}</span> (UTC)`;
}

function methodDate(r: RankReport): string {
  return r.method.changeLog.find((c) => c.version === r.method.version)?.date ?? r.date;
}

/** Tried, settled, came back, and settled with nothing usable back: the four numbers at the top of each page. */
function purchaseStats(t: GroupReport["totals"], gid: GroupId): string {
  return `<div class="stats">
  <div><span class="big">${t.tried}</span><br>purchases tried, from ${plural(t.sellersListed, "seller")}</div>
  <div><span class="big">${t.settled}</span><br>${SETTLED_TEXT[gid].stat}</div>
  <div><span class="big">${t.delivered}</span><br>came back with an answer</div>
  <div><span class="big">${t.settledNotDelivered}</span><br>${SETTLED_TEXT[gid].nothing}</div>
</div>`;
}

function notCountedLine(t: GroupReport["totals"], gid: GroupId): string {
  return `<p class="notcounted">Not counted against any seller: <b>${t.excluded.vet402_or_facilitator}</b> failed purchases on vet402's or the facilitator's side and <b>${t.excluded.unknown}</b> with no clear cause, out of ${t.tried} tries where vet402 sent a payment (${t.settled} ${SETTLED_TEXT[gid].short}). They never lower a grade. <a href="method.html#instrument">By rule</a></p>`;
}

function payToLine(t: GroupReport["totals"]): string {
  return t.payToChanged
    ? `<p class="meta warn">payTo changed for ${plural(t.payToChanged, "seller")} between runs or at payment. Shown on their pages; no effect on the grade.</p>`
    : "";
}

function moneySection(): string {
  return `<h2 id="money">How vet402 pays for this</h2>
<p>${escapeHtml(MONEY_LINE)} Every purchase file the grades read is in <a href="${escapeHtml(PUBLIC_REPO_URL)}/tree/main/data" rel="noopener noreferrer nofollow">data/</a> with its sha256.</p>`;
}

function publicFooter(): string {
  return `<footer><a href="method.html">How vet402 measures</a><a href="method.html#appeal">Mistakes and corrections</a><a href="rank.json">Data (rank.json)</a><a href="${escapeHtml(PUBLIC_REPO_URL)}/tree/main/data" rel="noopener noreferrer nofollow">Inputs (data/)</a></footer>`;
}

/** Graded sellers first, then undecided, both with rank numbers; nothing when the page has none. */
function gradedTables(r: RankReport, g: GroupReport, slugs: Map<string, string>, headingLevel: "h2" | "h3"): string {
  const graded = g.ranking.filter((s) => s.rank !== null && s.grade !== "undecided");
  const undecided = g.ranking.filter((s) => s.rank !== null && s.grade === "undecided");
  const out: string[] = [];
  if (graded.length)
    out.push(
      publicTable(
        `Ranked: ${graded.length} sellers with ${r.method.minCounted}+ counted purchases on ${r.method.minDays}+ days. "came back" = came back with an answer / counted.`,
        graded,
        slugs,
      ),
    );
  if (undecided.length)
    out.push(`<${headingLevel}>Undecided (${undecided.length}): enough purchases, but the interval is too wide for a grade</${headingLevel}>
${publicTable("Rank number kept; no grade yet.", undecided, slugs)}`);
  return out.join("\n\n");
}

/** The first page: Solana, Tempo and Base. What vet402 bought and what came back, shown in full before any grade. */
function renderMainIndex(r: RankReport, g: GroupReport, slugs: Map<string, string>): string {
  const t = g.totals;
  const chains = r.chains.filter((c) => g.chains.includes(c.chain));
  const perChain = chains
    .map((c) => `${CHAIN_LABEL[c.chain]}: ${c.tried} tried, ${c.settled} settled, ${c.delivered} came back${c.bodyUnchecked ? ` (for ${c.bodyUnchecked} of these ${c.tried} the runner kept no body, so for them "came back" means settled, then 2xx; the other ${c.tried - c.bodyUnchecked} were tested for an empty body)` : ""}.`)
    .join(" ");
  const ranked = g.ranking.filter((s) => s.rank !== null);
  const maxCounted = Math.max(0, ...g.ranking.map((s) => s.counted));
  const maxDays = Math.max(0, ...g.ranking.map((s) => s.days.length));
  const gradeState = ranked.length
    ? `${publicLegend()}\n${gradedTables(r, g, slugs, "h3")}`
    : `<p class="meta">No grades on this page yet. A grade needs ${r.method.minCounted} counted purchases on ${r.method.minDays} different days; the most any seller here has is ${maxCounted} counted on ${plural(maxDays, "day")}. ${escapeHtml(REBUY_PLAN)} ${escapeHtml(rebuyFacts(g.ranking, r.date))} One or two purchases are a start, not a verdict.</p>`;
  const byChain = g.chains
    .map((c) => ({ c, rows: g.ranking.filter((s) => (s.chains[c]?.tried ?? 0) > 0).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)) }))
    .filter((x) => x.rows.length > 0);
  const jump = byChain.map((x) => `<a href="#${x.c}">${CHAIN_LABEL[x.c]} (${x.rows.length})</a>`).join(" · ");
  const body = `
${tabs("main")}
<header>
<h1>Did the API deliver after it was paid?</h1>
<p class="lead">${escapeHtml(PUBLIC_LEAD)}</p>
<p class="dim">${escapeHtml(g.label)} · purchases ${periodHtml(t)} · method ${escapeHtml(r.method.version)} (<span class="nw">${escapeHtml(methodDate(r))}</span>)</p>
</header>
${purchaseStats(t, g.id)}
<p class="meta">${escapeHtml(DELIVERED_LINE)}</p>
<p class="meta">${escapeHtml(perChain)}</p>
${gradeState}
<p class="meta">Jump to: ${jump}</p>

${byChain.map((x) => `<h2 id="${x.c}">${CHAIN_LABEL[x.c]}: ${plural(x.rows.length, "seller")}</h2>\n${chainTable(x.c, x.rows, slugs)}`).join("\n\n")}

${notCountedLine(t, g.id)}
${payToLine(t)}
${moneySection()}

${publicFooter()}
`;
  return publicPage("vet402: did the API deliver?", PUBLIC_LEAD, body);
}

/** The Algorand page: data from vet402-algorand, graded from Algorand purchases only, nothing folded. */
function renderAlgorandIndex(r: RankReport, g: GroupReport, slugs: Map<string, string>): string {
  const t = g.totals;
  const measuring = g.ranking.filter((s) => s.rank === null);
  const body = `
${tabs("algorand")}
<header>
<h1>Algorand: delivery grades</h1>
<p class="lead">vet402 bought the listed Algorand x402 APIs it could buy, with its own money, from ${periodHtml(t)}. ${t.sellersRanked} of ${plural(t.sellersListed, "seller")} have enough purchases for a rank number.</p>
<p class="meta">These results come from <a href="${escapeHtml(ALGORAND_REPO_URL)}" rel="noopener noreferrer nofollow">vet402-algorand</a>, a separate project built for Algorand's Global x402 Challenge. They are graded from Algorand purchases only, apart from the Solana, Tempo and Base page. Those runs bought up to about 500 items of one seller in under an hour, before the pacing rule of method v2.</p>
</header>
${purchaseStats(t, g.id)}
<p class="meta">${escapeHtml(DELIVERED_LINE)} On Algorand, "settled" is the facilitator's settlement receipt with a tx id, as vet402-algorand recorded it; vet402 has not read these payments back on chain.</p>
${publicLegend()}

${gradedTables(r, g, slugs, "h2") || `<p class="dim">No seller has ${r.method.minCounted} counted purchases on ${r.method.minDays} different days yet.</p>`}

${notCountedLine(t, g.id)}

<h2>Measuring (${measuring.length}): fewer than ${r.method.minCounted} counted purchases, or only one day</h2>
<p class="meta">No grade and no rank number yet. This is not a bad mark.</p>
${publicTable("Sorted by name.", measuring, slugs)}

${payToLine(t)}
${moneySection()}

${publicFooter()}
`;
  return publicPage("vet402: Algorand delivery grades", `Algorand x402 sellers graded by what came back after vet402 paid them. ${MONEY_LINE}`, body);
}

function publicFaultBlock(s: RankedSeller, fault: Fault, n: number, blurb: string): string {
  const rules = Object.entries(s.failuresByRule).filter(([id]) => ruleById(id)?.fault === fault);
  return `<div class="fault"><b class="big">${n}</b><b>${escapeHtml(FAULT_LABEL[fault])}</b> <span class="meta">${escapeHtml(blurb)}</span>
${rules.length ? `<div class="meta">${escapeHtml(countsText(Object.fromEntries(rules), ruleLabel))}</div>` : ""}</div>`;
}

/** A seller's signed delivery records on the public site (records/<id>.html), oldest first. */
export interface SellerRecordLink {
  id: string;
  day: string;
  network: string;
}

function recordsSection(links: readonly SellerRecordLink[] | undefined): string {
  if (!links || links.length === 0) return "";
  return `<h2 id="records">Signed delivery records</h2>
<p class="meta">One page per purchase that came back with an answer, signed by vet402 and included in a daily Merkle root. Each page shows how to check it without trusting vet402.</p>
<ol class="plain">${links.map((l) => `<li><a href="../records/${escapeHtml(l.id)}.html">${escapeHtml(l.day)} · ${escapeHtml(chainName(l.network))} · ${escapeHtml(l.id)}</a></li>`).join("\n")}</ol>

`;
}

/** One page's part of a seller page: that page's figures, grade and purchases only. */
function sellerGroupSection(r: RankReport, g: GroupReport, s: RankedSeller): string {
  const lo = s.wilsonLower;
  const hi = s.wilsonUpper;
  const chains = (Object.entries(s.chains) as [Chain, ChainFigures][]).filter(([, v]) => v.tried > 0);
  const triedText = chains.map(([c, v]) => `${CHAIN_LABEL[c] ?? c} ${v.tried}`).join(", ");
  const perChain = chains.map(([c, v]) => `${CHAIN_LABEL[c] ?? c} ${v.delivered}/${v.counted}`).join(" · ");
  const standing =
    s.rank !== null
      ? s.grade === "undecided"
        ? `Rank ${s.rank} of ${g.totals.sellersRanked} on this page, no grade yet: the interval is too wide.`
        : `Rank ${s.rank} of ${g.totals.sellersRanked} on this page.`
      : `Measuring: a rank number needs ${r.method.minCounted} counted purchases on ${r.method.minDays} different days; this seller has ${s.counted} on ${s.days.length}.`;
  // Only a seller with purchases in data/remeasure/: several sellers can share one payTo, and only one of them is bought again.
  const rebuys = g.id === "main" ? rebuySeller(s) : null;
  const sellerFailN = s.counted - s.delivered;
  const failures = s.sellerFailures.length
    ? `<ol class="plain">${s.sellerFailures
        .map(
          (f) => `<li>${escapeHtml(when(f.at))} · ${escapeHtml(CHAIN_LABEL[f.chain] ?? f.chain)} · ${escapeHtml(ruleLabel(f.rule))}${f.httpStatus !== null ? ` · HTTP ${f.httpStatus}` : ""} ${txHtml(f.chain, f.tx)}
<div class="meta mono">${escapeHtml(f.url)}</div>
<div class="meta">runner said: <span class="mono">${escapeHtml(f.rawReason)}</span>${f.detail ? ` · <span class="mono">${escapeHtml(f.detail)}</span>` : ""}</div></li>`,
        )
        .join("\n")}</ol>${sellerFailN > s.sellerFailures.length ? `<p class="dim">Latest ${s.sellerFailures.length} of ${sellerFailN}. All rows are in rank.json and data/.</p>` : ""}`
    : `<p class="dim">None.</p>`;
  const recent = s.recent.length
    ? `<ol class="plain">${s.recent
        .map(
          (a) => `<li>${escapeHtml(when(a.at))} · ${escapeHtml(CHAIN_LABEL[a.chain] ?? a.chain)} · ${escapeHtml(outcomeText(a))}${a.declaredMatch === false ? " · answer not as declared" : ""} ${txHtml(a.chain, a.tx)}
<div class="meta mono">${escapeHtml(a.url)}</div></li>`,
        )
        .join("\n")}</ol>`
    : `<p class="dim">None.</p>`;
  const payTo = s.payToChanged
    ? `<p class="warn">payTo changed: ${s.payToChanges
        .slice(0, 3)
        .map((c) => `<span class="mono">${escapeHtml(c.from)}</span> to <span class="mono">${escapeHtml(c.to)}</span> (${escapeHtml(c.how === "refused_at_payment" ? "vet402 refused to pay" : "later run")})`)
        .join("; ")}. No effect on the grade.</p>`
    : "";
  const notTried = countsText(s.notTried, (k) => CATEGORY_LABEL[k as ReasonCategory] ?? k);
  const where =
    g.id === "algorand"
      ? `From <a href="${escapeHtml(ALGORAND_REPO_URL)}" rel="noopener noreferrer nofollow">vet402-algorand</a>, a separate project; graded apart from Solana, Tempo and Base. Listed on <a href="../${g.page}">the Algorand page</a>.`
      : `Graded from Solana, Tempo and Base purchases only. Listed on <a href="../${g.page}">the first page</a>.`;
  return `<h2 id="${g.id}">${escapeHtml(g.label)}</h2>
<p class="meta">${where}</p>
<p class="lead">vet402 paid this seller ${plural(s.tried, "time")} with its own money (${escapeHtml(triedText)}), most recently on <span class="nw">${escapeHtml(day(s.lastMeasuredAt))}</span> (UTC). ${s.settled} ${SETTLED_TEXT[g.id].short}; ${s.delivered} came back with an answer${s.paidButNotDelivered ? `; ${s.paidButNotDelivered} ${SETTLED_TEXT[g.id].nothing}` : ""}.</p>
<p class="meta">${rebuys ? `${escapeHtml(rebuys)} ` : ""}It costs the seller nothing, and there is nothing to sign up for.</p>
<p>${publicBadge(s.grade)} ${escapeHtml(s.grade === "measuring" || s.grade === "undecided" ? PUBLIC_GRADE_TEXT[s.grade] : `grade ${s.grade}: ${GRADE_TEXT[s.grade].label}`)} · ${escapeHtml(standing)}</p>

<div class="stats">
  <div><span class="big">${s.delivered} / ${s.counted}</span><br>came back, of counted${s.counted ? ` (${pct(s.deliveredRate)})` : ""}</div>
  <div><span class="big">${lo.toFixed(2)} to ${hi.toFixed(2)}</span><br>95% interval</div>
  <div><span class="big">${escapeHtml(day(s.lastMeasuredAt))}</span><br>last bought · ${plural(s.days.length, "day")} counted</div>
</div>
<div class="bar" role="img" aria-label="95% interval ${lo.toFixed(2)} to ${hi.toFixed(2)}"><span style="left:${(lo * 100).toFixed(1)}%;width:${((hi - lo) * 100).toFixed(1)}%"></span>${s.counted ? `<i style="left:${(s.deliveredRate * 100).toFixed(1)}%"></i>` : ""}</div>
<div class="scale"><span>0</span><span>0.5</span><span>1</span></div>
<p class="meta">Came back, of counted, per chain: ${escapeHtml(perChain || "–")}. ${escapeHtml(DELIVERED_LINE)}</p>
<p class="meta">Separate column, not in the grade. Answer matched what the seller declared: ${s.declared.checked ? `${s.declared.matched} of ${s.declared.checked} checked` : "not checked"}.</p>
${payTo}

<h3>Not counted</h3>
${publicFaultBlock(s, "vet402_or_facilitator", s.excluded.vet402_or_facilitator, "not counted")}
${publicFaultBlock(s, "unknown", s.excluded.unknown, "not counted")}
${notTried ? `<p class="meta">Not bought at all: ${escapeHtml(notTried)}.</p>` : ""}

<h3>Counted against this seller</h3>
${publicFaultBlock(s, "seller", sellerFailN, "counted in the grade")}
${failures}
<p class="meta"><a href="../method.html#faults">How each failure is assigned</a></p>

<h3>Recent purchases</h3>
<p class="meta">Each tx links to a public explorer.</p>
${recent}
`;
}

function renderPublicSeller(r: RankReport, key: string, parts: readonly { g: GroupReport; s: RankedSeller }[], records?: readonly SellerRecordLink[]): string {
  const tried = parts.reduce((n, p) => n + p.s.tried, 0);
  const delivered = parts.reduce((n, p) => n + p.s.delivered, 0);
  const body = `
${tabs(null, "../")}
<h1>${escapeHtml(key)}</h1>
${parts.length > 1 ? `<p class="meta">Bought on both pages; each part below is graded from its own purchases only: ${parts.map((p) => `<a href="#${p.g.id}">${escapeHtml(p.g.label)}</a>`).join(" · ")}.</p>` : ""}
${parts.map((p) => sellerGroupSection(r, p.g, p.s)).join("\n")}
${recordsSection(records)}<h2 id="appeal">Is a row wrong?</h2>
<p>${escapeHtml(r.method.correction)}</p>
<p><a href="${escapeHtml(appealUrl(key, r.date))}" rel="noopener noreferrer nofollow">Tell vet402 a row is wrong (GitHub issue, prefilled)</a></p>

<footer><a href="../index.html">Solana, Tempo, Base</a><a href="../algorand.html">Algorand</a><a href="../method.html">How vet402 measures</a><a href="../rank.json">Data (rank.json)</a></footer>
`;
  return publicPage(`${key} · vet402`, `${key}: ${delivered} of ${tried} purchases by vet402 came back with an answer.`, body);
}

function inputLink(location: string): string {
  return location.startsWith("data/")
    ? `<a class="mono" href="${escapeHtml(`${PUBLIC_REPO_URL}/blob/main/${location}`)}" rel="noopener noreferrer nofollow">${escapeHtml(location)}</a>`
    : `<span class="mono">${escapeHtml(location)}</span>`;
}

function renderPublicMethod(r: RankReport): string {
  const m = r.method;
  const t = r.totals;
  const rules = m.faultRules
    .map(
      (x, i) =>
        `<li><b>${i + 1}. ${escapeHtml(FAULT_LABEL[x.fault])}</b> · <span class="mono">${escapeHtml(x.id)}</span> · this report: ${t.failuresByRule[x.id] ?? 0}<br>${escapeHtml(x.when)}</li>`,
    )
    .join("\n");
  const chainRows = r.chains
    .map(
      (c) =>
        `<tr><td>${escapeHtml(CHAIN_LABEL[c.chain] ?? c.chain)}</td><td>${c.tried}</td><td>${c.settled}</td><td>${c.delivered}</td><td>${c.declared.checked ? `${c.declared.matched}/${c.declared.checked}` : "–"}</td><td>${c.bodyUnchecked ? `${c.tried - c.bodyUnchecked} of ${c.tried}` : "yes"}</td></tr>`,
    )
    .join("\n");
  const onChain = r.chains.filter((c) => c.settledOnChain).reduce((n, c) => n + c.settled, 0);
  const byReceipt = r.chains.filter((c) => !c.settledOnChain).reduce((n, c) => n + c.settled, 0);
  const settledSplit = `${onChain} settled on chain, ${byReceipt} with a settlement receipt on Algorand`;
  const grades = r.groups
    .map((g) => `${escapeHtml(g.label)}: ${GRADE_ORDER.map((x) => `${publicBadge(x)} ${g.totals.grades[x] ?? 0}`).join(" · ")}`)
    .join("<br>");
  const comparisons = r.groups
    .map((g) => `<h3>${escapeHtml(g.label)}</h3>\n${g.comparisons.length ? g.comparisons.map(comparisonSection).join("\n") : `<p class="dim">No seller on this page is in a catalog with an order.</p>`}`)
    .join("\n");
  const body = `
${tabs(null)}
<h1>How vet402 measures</h1>
<p class="dim">Method ${escapeHtml(m.version)} (${escapeHtml(methodDate(r))}) · report ${escapeHtml(r.date)} · purchases ${periodHtml(t)} · <a href="#changes">change log</a></p>

<h2>1. How vet402 pays for this</h2>
<p>${escapeHtml(m.money)}</p>

<h2 id="faults">2. What is counted, and what is not</h2>
<p>${escapeHtml(m.counted)}</p>
<p>${escapeHtml(m.notCounted)}</p>
<p class="meta">A failed purchase gets the first rule that matches, top to bottom. Only seller-side rules lower a grade.</p>
<ol class="plain">${rules}</ol>

<h2>3. What "settled" and "came back with an answer" mean</h2>
<p>${escapeHtml(m.settled)}</p>
<p>${escapeHtml(m.delivered)}</p>
<p class="meta">${escapeHtml(m.declared)}</p>

<h2>4. Grades and rank numbers</h2>
<p>${escapeHtml(m.score)}</p>
<ul>
<li>${publicBadge("A")} lower bound ≥ ${m.gradeLower.A}</li>
<li>${publicBadge("B")} lower bound ≥ ${m.gradeLower.B}</li>
<li>${publicBadge("C")} lower bound ≥ ${m.gradeLower.C}</li>
<li>${publicBadge("D")} upper bound &lt; ${m.dUpper}: bad only when the evidence says so</li>
<li>${publicBadge("undecided")} none of the above</li>
<li>${publicBadge("measuring")} fewer than ${m.minCounted} counted purchases, or fewer than ${m.minDays} days</li>
</ul>
<p>${escapeHtml(m.rankNumber)}</p>
<p class="meta">${escapeHtml(m.grades)}</p>
<p class="meta">${escapeHtml(m.order)}</p>
<p class="meta">This report:<br>${grades}</p>

<h2>5. How vet402 buys</h2>
<p>${escapeHtml(m.measurement)}</p>
<p class="meta">${escapeHtml(rebuyFacts(r.groups.find((x) => x.id === "main")?.ranking ?? [], r.date))}</p>
<p class="meta">${escapeHtml(m.sellerIdentity)} ${escapeHtml(m.payTo)}</p>

<h2 id="instrument">6. vet402's own record in this report</h2>
<p>Out of ${t.tried} tries where vet402 sent a payment (${settledSplit}), <b>${t.excluded.vet402_or_facilitator}</b> failed on vet402's or the facilitator's side and <b>${t.excluded.unknown}</b> had no clear cause. None of them lowered a grade. ${t.counted} purchases were counted: ${t.delivered} came back with an answer.</p>
<table><thead><tr><th>chain</th><th>tries</th><th>settled</th><th>came back</th><th>as de&shy;clared</th><th>body test</th></tr></thead>
<tbody>
${chainRows}
</tbody></table>
<p class="meta">settled: read back on chain on Solana, Tempo and Base; a facilitator's settlement receipt with a tx id on Algorand. body test: purchases tested for an empty body.</p>
<p class="meta">Algorand rows come from <a href="${escapeHtml(ALGORAND_REPO_URL)}" rel="noopener noreferrer nofollow">vet402-algorand</a>, a separate project; they are graded on their own page.</p>

<h2 id="appeal">7. Mistakes and corrections</h2>
<p>${escapeHtml(m.correction)}</p>
<p><a href="${escapeHtml(APPEAL_ISSUES_URL.replace(/\/new$/, ""))}" rel="noopener noreferrer nofollow">GitHub issues</a> · each seller page has a prefilled link.</p>

<h2>8. Limits</h2>
<ul>${m.limits.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>

<h2 id="reproduce">9. Reproduce</h2>
<pre class="cmd">git clone ${escapeHtml(PUBLIC_REPO_URL)}
cd vet402-delivery
npm ci
npm run rank -- --data data --offline --out /tmp/rank
npx tsx scripts/build-site.ts --report /tmp/rank/rank-${escapeHtml(r.date)}.json --out /tmp/site</pre>
<p class="meta">The same inputs give the same rank.json (apart from generatedAt) and the same pages. The run only reads files; nothing is signed or sent. Each input and its sha256:</p>
<ul class="plain">${r.inputs
    .map(
      (i) =>
        `<li class="meta"><b>${escapeHtml(i.label)}</b> ${inputLink(i.location)}<br>sha256 <span class="mono">${escapeHtml(i.sha256)}</span>${i.fetchedAt ? ` · fetched ${escapeHtml(i.fetchedAt)}` : ""}${i.note ? `<br>${escapeHtml(i.note)}` : ""}</li>`,
    )
    .join("")}</ul>

<h2>10. Compared with catalog order</h2>
<p class="meta">Per page, like the grades.</p>
${comparisons}
<ul>${r.catalogsWithoutOrder.map((c) => `<li><b>${escapeHtml(c.catalog)}</b>: ${escapeHtml(c.why)}</li>`).join("")}</ul>

<h2 id="changes">Change log</h2>
<ul>${m.changeLog.map((c) => `<li><b>${escapeHtml(c.version)}</b> (${escapeHtml(c.date)})<ul>${c.changes.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></li>`).join("")}</ul>

<footer><a href="index.html">Solana, Tempo, Base</a><a href="algorand.html">Algorand</a><a href="rank.json">Data (rank.json)</a><a href="${escapeHtml(PUBLIC_REPO_URL)}" rel="noopener noreferrer nofollow">Code and inputs</a></footer>
`;
  return publicPage("How vet402 measures", "Method, counted and not counted purchases, grades per page, limits and how to reproduce the vet402 delivery pages.", body);
}

/** Seller page file names, one per seller key on any page. Sorted keys, so a name does not depend on grades. */
export function siteSlugs(r: RankReport): Map<string, string> {
  return sellerSlugs([...new Set(r.groups.flatMap((g) => g.ranking.map((s) => s.key)))].sort());
}

/**
 * Every HTML page of the public site, keyed by path relative to the site root.
 * rank.json (the report itself) is written next to them by scripts/build-site.ts.
 */
export function renderPublicSite(r: RankReport, opts: { records?: ReadonlyMap<string, readonly SellerRecordLink[]> } = {}): Map<string, string> {
  const slugs = siteSlugs(r);
  const out = new Map<string, string>();
  out.set("index.html", renderMainIndex(r, groupById(r, "main"), slugs));
  out.set("algorand.html", renderAlgorandIndex(r, groupById(r, "algorand"), slugs));
  out.set("method.html", renderPublicMethod(r));
  for (const [key, slug] of slugs) {
    const parts = r.groups.flatMap((g) => g.ranking.filter((s) => s.key === key).map((s) => ({ g, s })));
    out.set(`seller/${slug}.html`, renderPublicSeller(r, key, parts, opts.records?.get(key)));
  }
  return out;
}

/** The pages scripts/rank.ts writes next to the report (results/rank-<date>/): the public site, without records. */
export function renderSite(r: RankReport): Map<string, string> {
  return renderPublicSite(r);
}
