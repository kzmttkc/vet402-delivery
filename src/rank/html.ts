/**
 * Static HTML for the rank report: index.html (the list), method.html, and one page per seller under s/.
 * Readable at phone width, no scripts, no external requests.
 *
 * Every string that a seller can influence (host, URL, payTo, reason text, tx id) goes through
 * escapeHtml. Links are built only from tx ids that match the chain's id format, onto a fixed
 * explorer origin, so a seller-supplied value can never become a link target. Seller page file names
 * are reduced to [a-z0-9._-]; the correction link is a fixed GitHub URL with an encoded query.
 */
import { FAULT_LABEL, ruleById } from "./classify.js";
import type { Comparison, CompareRow } from "./compare.js";
import { APPEAL_ISSUES_URL, type RankReport } from "./report.js";
import type { Grade, RankedSeller } from "./score.js";
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
  delivered: "delivered",
  not_settled: "payment not settled",
  settled_error_status: "paid, error status",
  settled_empty_body: "paid, empty answer",
  unconfirmed_server_error: "5xx, settlement unknown",
  not_payable: "not buyable",
  payto_changed: "payTo changed",
  vet402_skipped: "skipped by vet402",
};

const GRADE_TEXT: Record<Grade, { mark: string; label: string }> = {
  A: { mark: "A", label: "arrives 90%+ of the time" },
  B: { mark: "B", label: "arrives 75%+ of the time" },
  C: { mark: "C", label: "arrives 50%+ of the time" },
  D: { mark: "D", label: "arrives less than half the time" },
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

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${CSS}</style>
</head>
<body><main>
${body}
</main></body></html>
`;
}

function gradeBadge(g: Grade): string {
  return `<span class="g g${g}" title="${escapeHtml(GRADE_TEXT[g].label)}">${GRADE_TEXT[g].mark}</span>`;
}

function legend(): string {
  const items = (["A", "B", "C", "D", "undecided", "measuring"] as Grade[])
    .map((g) => `<span class="item">${gradeBadge(g)} ${escapeHtml(GRADE_TEXT[g].label)}</span>`)
    .join("");
  return `<p class="legend">${items}</p>`;
}

function excludedLine(s: RankedSeller): string {
  const n = s.excluded.vet402_or_facilitator + s.excluded.unknown;
  if (n === 0) return "";
  const parts = [];
  if (s.excluded.vet402_or_facilitator) parts.push(`${s.excluded.vet402_or_facilitator} vet402/facilitator side`);
  if (s.excluded.unknown) parts.push(`${s.excluded.unknown} can't tell`);
  return `<span class="sub">+${n} failed purchases not counted (${escapeHtml(parts.join(", "))})</span>`;
}

function boardRow(s: RankedSeller, slug: string): string {
  return `<li><span class="rk">${s.rank ?? ""}</span>${gradeBadge(s.grade)}<a class="name" href="s/${escapeHtml(slug)}.html">${escapeHtml(s.key)}</a><span class="num">${s.delivered}/${s.counted}</span><span class="date">${escapeHtml(day(s.lastMeasuredAt))}</span>${excludedLine(s)}</li>`;
}

const BOARD_HEAD = `<li class="head" aria-hidden="true"><span class="rk">#</span><span></span><span>seller</span><span class="num">arrived</span><span class="date">last bought</span></li>`;

function renderIndex(r: RankReport, slugs: Map<string, string>): string {
  const ranked = r.ranking.filter((s) => s.rank !== null);
  const measuring = r.ranking.filter((s) => s.rank === null);
  const t = r.totals;
  const body = `
<header>
<h1>vet402 delivery record</h1>
<p class="lead">We buy from each seller with our own money and rank them by whether what we paid for arrived.</p>
<p class="dim">We take no money from sellers. Purchases ${escapeHtml(day(t.firstPurchaseAt))} to ${escapeHtml(day(t.lastPurchaseAt))} (UTC) · method ${escapeHtml(r.method.version)} · <a href="method.html">How we measure</a></p>
</header>
${legend()}
<p class="meta">"arrived" = paid purchases that came back as a 2xx answer with a body, out of those counted. Failures on vet402's or the facilitator's side, or with no clear cause, are not counted and are shown as a number.</p>

<h2>Ranked (${ranked.length})</h2>
${ranked.length ? `<ol class="board">${BOARD_HEAD}\n${ranked.map((s) => boardRow(s, slugs.get(s.key)!)).join("\n")}</ol>` : `<p class="dim">No seller has ${r.method.minCounted} counted purchases on ${r.method.minDays} different days yet.</p>`}

<details>
<summary>Measuring (${measuring.length}): fewer than ${r.method.minCounted} counted purchases, or only one day</summary>
<p class="meta">No grade and no rank number yet. This is not a bad mark.</p>
<ol class="board">${BOARD_HEAD}\n${measuring.map((s) => boardRow(s, slugs.get(s.key)!)).join("\n")}</ol>
</details>

<p class="meta">Not counted in this report: ${t.excluded.vet402_or_facilitator} failed purchases on vet402's or the facilitator's side, ${t.excluded.unknown} with no clear cause. <a href="method.html#instrument">Details</a></p>

<footer><a href="method.html">How we measure</a><a href="method.html#appeal">Report a mistake</a><a href="../rank-${escapeHtml(r.date)}.json">Data (JSON)</a></footer>
`;
  return page("vet402 delivery record", body);
}

function faultBlock(s: RankedSeller, fault: Fault, n: number, blurb: string): string {
  const rules = Object.entries(s.failuresByRule).filter(([id]) => ruleById(id)?.fault === fault);
  return `<div class="fault"><b class="big">${n}</b><b>${escapeHtml(FAULT_LABEL[fault])}</b> <span class="meta">${escapeHtml(blurb)}</span>
${rules.length ? `<div class="meta">${escapeHtml(countsText(Object.fromEntries(rules), ruleLabel))}</div>` : ""}</div>`;
}

function outcomeText(a: RankedSeller["recent"][number]): string {
  if (a.delivered) return "arrived";
  return `${FAULT_LABEL[a.fault!]}: ${ruleLabel(a.rule!)}`;
}

function renderSeller(r: RankReport, s: RankedSeller): string {
  const g = GRADE_TEXT[s.grade];
  const lo = s.wilsonLower;
  const hi = s.wilsonUpper;
  const chains = Object.entries(s.chains)
    .map(([c, v]) => `${c} ${v!.delivered}/${v!.counted}`)
    .join(" · ");
  const standing =
    s.rank !== null
      ? `Rank ${s.rank} of ${r.totals.sellersRanked}`
      : `Measuring: needs ${r.method.minCounted} counted purchases on ${r.method.minDays} different days; has ${s.counted} on ${s.days.length}.`;
  const sellerFailN = s.counted - s.delivered;
  const failures = s.sellerFailures.length
    ? `<ol class="plain">${s.sellerFailures
        .map(
          (f) => `<li>${escapeHtml(when(f.at))} · ${escapeHtml(f.chain)} · ${escapeHtml(ruleLabel(f.rule))}${f.httpStatus !== null ? ` · HTTP ${f.httpStatus}` : ""} ${txHtml(f.chain, f.tx)}
<div class="meta mono">${escapeHtml(f.url)}</div>
<div class="meta">runner said: <span class="mono">${escapeHtml(f.rawReason)}</span>${f.detail ? ` · <span class="mono">${escapeHtml(f.detail)}</span>` : ""}</div></li>`,
        )
        .join("\n")}</ol>${sellerFailN > s.sellerFailures.length ? `<p class="dim">Showing the latest ${s.sellerFailures.length} of ${sellerFailN}.</p>` : ""}`
    : `<p class="dim">None.</p>`;
  const recent = s.recent.length
    ? `<ol class="plain">${s.recent
        .map(
          (a) => `<li>${escapeHtml(when(a.at))} · ${escapeHtml(a.chain)} · ${escapeHtml(outcomeText(a))}${a.declaredMatch === false ? " · answer not as declared" : ""} ${txHtml(a.chain, a.tx)}
<div class="meta mono">${escapeHtml(a.url)}</div></li>`,
        )
        .join("\n")}</ol>`
    : `<p class="dim">None.</p>`;
  const payTo = s.payToChanged
    ? `<p class="warn">payTo changed: ${s.payToChanges
        .slice(0, 3)
        .map((c) => `<span class="mono">${escapeHtml(c.from)}</span> → <span class="mono">${escapeHtml(c.to)}</span> (${escapeHtml(c.how === "refused_at_payment" ? "vet402 refused to pay" : "later run")})`)
        .join("; ")}</p>`
    : "";
  const notTried = countsText(s.notTried, (k) => CATEGORY_LABEL[k as ReasonCategory] ?? k);
  const body = `
<nav><a href="../index.html">← All sellers</a> · <a href="../method.html">How we measure</a></nav>
<h1>${escapeHtml(s.key)}</h1>
<p>${gradeBadge(s.grade)} ${escapeHtml(g.label)} · ${escapeHtml(standing)}</p>

<div class="stats">
  <div><span class="big">${s.delivered} / ${s.counted}</span><br>arrived${s.counted ? ` (${pct(s.deliveredRate)})` : ""}</div>
  <div><span class="big">${lo.toFixed(2)}–${hi.toFixed(2)}</span><br>95% interval</div>
  <div><span class="big">${escapeHtml(day(s.lastMeasuredAt))}</span><br>last bought · ${s.days.length} day${s.days.length === 1 ? "" : "s"} counted</div>
</div>
<div class="bar" aria-label="95% interval ${lo.toFixed(2)} to ${hi.toFixed(2)}"><span style="left:${(lo * 100).toFixed(1)}%;width:${((hi - lo) * 100).toFixed(1)}%"></span>${s.counted ? `<i style="left:${(s.deliveredRate * 100).toFixed(1)}%"></i>` : ""}</div>
<div class="scale"><span>0</span><span>0.5</span><span>1</span></div>
<p class="meta">Arrived = vet402's payment settled, then a 2xx answer with a body. Chains: ${escapeHtml(chains || "–")}.</p>
<p class="meta">Separate column, not in the grade. Answer matched what the seller declared: ${s.declared.checked ? `${s.declared.matched} of ${s.declared.checked} checked` : "not checked"}.</p>
${payTo}

<h2>Failed purchases, by who was at fault</h2>
${faultBlock(s, "seller", sellerFailN, "counted in the grade")}
${faultBlock(s, "vet402_or_facilitator", s.excluded.vet402_or_facilitator, "not counted")}
${faultBlock(s, "unknown", s.excluded.unknown, "not counted")}
${notTried ? `<p class="meta">Not bought at all: ${escapeHtml(notTried)}.</p>` : ""}
<p class="meta"><a href="../method.html#faults">How each failure is assigned</a></p>

<h2>Failures counted against this seller</h2>
${failures}

<h2>Recent purchases</h2>
${recent}

<h2 id="appeal">Is something here wrong?</h2>
<p>Open an issue with the URL or tx you think is wrong. vet402 checks it against the chain and the raw result, fixes a wrong row and notes the fix in the change log.</p>
<p><a href="${escapeHtml(appealUrl(s.key, r.date))}" rel="noopener noreferrer nofollow">Report a mistake on GitHub</a></p>

<footer><a href="../index.html">All sellers</a><a href="../method.html">How we measure</a><a href="../../rank-${escapeHtml(r.date)}.json">Data (JSON)</a></footer>
`;
  return page(`${s.key} · vet402 delivery record`, body);
}

function compareRow(r: CompareRow, metricIsRank: boolean): string {
  const value = metricIsRank ? `best rank ${r.catalogValue}` : `${r.catalogValue.toLocaleString("en-US")} calls/30d`;
  const f = r.delivered === 0 ? r.lastFailure : null;
  const why = f
    ? `<div class="meta">${escapeHtml(f.chain)} · ${escapeHtml(ruleLabel(f.rule))} · <span class="mono">${escapeHtml(f.rawReason)}</span>${f.detail ? ` · <span class="mono">${escapeHtml(f.detail)}</span>` : ""}</div>
  <div class="meta mono">${escapeHtml(f.url)}</div>`
    : "";
  return `<li><b class="mono">${escapeHtml(r.key)}</b><br>
  catalog #${r.catalogPos} (${escapeHtml(value)}) · vet402 ${r.vet402Rank === null ? "measuring" : `#${r.vet402Rank}`}: <b>${r.delivered}/${r.tried}</b> arrived ${r.tx ? txHtml(r.tx.chain, r.tx.tx) : ""}
  ${why}</li>`;
}

function comparisonSection(c: Comparison): string {
  const isRank = c.direction === "asc";
  const list = (rows: CompareRow[]) =>
    rows.length ? `<ol class="plain">${rows.slice(0, 10).map((r) => compareRow(r, isRank)).join("\n")}</ol>${rows.length > 10 ? `<p class="dim">…and ${rows.length - 10} more in the JSON.</p>` : ""}` : `<p class="dim">none</p>`;
  return `<h3>${escapeHtml(c.catalog)} order vs vet402</h3>
<p class="meta">${escapeHtml(c.rule)}</p>
<div class="stats">
  <div><span class="big">${c.overlap}</span><br>sellers in both</div>
  <div><span class="big">${c.highButNeverDelivered.length}</span><br>high in catalog, never arrived (${c.highButNeverDeliveredDespitePaidTx} after a settled payment)</div>
  <div><span class="big">${c.lowButAlwaysDelivered.length}</span><br>low in catalog, always arrived</div>
  <div><span class="big">${c.spearman === null ? "–" : c.spearman.toFixed(2)}</span><br>rank correlation</div>
</div>
<details><summary>High in the catalog, never arrived</summary>${list(c.highButNeverDelivered)}</details>
<details><summary>Low in the catalog, arrived every time</summary>${list(c.lowButAlwaysDelivered)}</details>`;
}

function renderMethod(r: RankReport): string {
  const m = r.method;
  const t = r.totals;
  const rules = m.faultRules
    .map(
      (x, i) => `<li><b>${i + 1}. ${escapeHtml(FAULT_LABEL[x.fault])}</b> · <span class="mono">${escapeHtml(x.id)}</span> · this run: ${t.failuresByRule[x.id] ?? 0}<br>${escapeHtml(x.when)}</li>`,
    )
    .join("\n");
  const chainRows = r.chains
    .map(
      (c) =>
        `<tr><td>${escapeHtml(c.chain)}</td><td>${c.tried}</td><td>${c.settled}</td><td>${c.delivered}</td><td>${c.declared.checked ? `${c.declared.matched}/${c.declared.checked}` : "–"}</td><td>${c.bodyChecked ? "yes" : "no"}</td></tr>`,
    )
    .join("\n");
  const grades = (Object.entries(t.grades) as [Grade, number][]).map(([g, n]) => `${gradeBadge(g)} ${n}`).join(" · ");
  const body = `
<nav><a href="index.html">← All sellers</a></nav>
<h1>How we measure</h1>
<p class="dim">Method ${escapeHtml(m.version)} · report ${escapeHtml(r.date)} · <a href="#changes">change log</a></p>

<h2>1. Who pays</h2>
<p>${escapeHtml(m.money)}</p>

<h2>2. What "arrived" means</h2>
<p>${escapeHtml(m.delivered)}</p>
<p class="meta">${escapeHtml(m.declared)}</p>

<h2 id="faults">3. Who was at fault</h2>
<p>${escapeHtml(m.counted)}</p>
<p>${escapeHtml(m.notCounted)}</p>
<p class="meta">A failed purchase gets the first rule that matches, top to bottom.</p>
<ol class="plain">${rules}</ol>

<h2>4. Grades and rank numbers</h2>
<p>${escapeHtml(m.score)} ${escapeHtml(m.grades)}</p>
<p>${escapeHtml(m.rankNumber)}</p>
<p class="meta">${escapeHtml(m.order)}</p>
<p class="meta">This report: ${grades}</p>

<h2>5. How we buy</h2>
<p>${escapeHtml(m.measurement)}</p>
<p class="meta">${escapeHtml(m.sellerIdentity)} ${escapeHtml(m.payTo)}</p>

<h2 id="instrument">6. Our own mistakes in this report</h2>
<p>${t.excluded.vet402_or_facilitator} failed purchases were on vet402's or the facilitator's side and ${t.excluded.unknown} had no clear cause, out of ${t.tried} paid tries. None of them lowered a grade.</p>
<table><thead><tr><th>chain</th><th>tries</th><th>settled</th><th>arrived</th><th>as de&shy;clared</th><th>body test</th></tr></thead>
<tbody>
${chainRows}
</tbody></table>

<h2 id="appeal">7. Mistakes and corrections</h2>
<p>${escapeHtml(m.correction)}</p>
<p><a href="${escapeHtml(APPEAL_ISSUES_URL)}" rel="noopener noreferrer nofollow">Open an issue on GitHub</a> · each seller page has a prefilled link.</p>

<h2>8. Limits</h2>
<ul>${m.limits.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>

<h2>9. Reproduce</h2>
<p class="mono">npm run rank -- --date ${escapeHtml(r.date)} --offline</p>
<p class="meta">Same inputs give the same JSON and pages. Inputs and their sha256:</p>
<ul class="plain">${r.inputs.map((i) => `<li class="meta"><b>${escapeHtml(i.label)}</b> <span class="mono">${escapeHtml(i.location)}</span> sha256 <span class="mono">${escapeHtml(i.sha256.slice(0, 16))}</span>${i.fetchedAt ? ` fetched ${escapeHtml(i.fetchedAt)}` : ""}</li>`).join("")}</ul>

<h2>10. Compared with catalog order</h2>
${r.comparisons.map(comparisonSection).join("\n")}
<ul>${r.catalogsWithoutOrder.map((c) => `<li><b>${escapeHtml(c.catalog)}</b>: ${escapeHtml(c.why)}</li>`).join("")}</ul>

<h2 id="changes">Change log</h2>
<ul>${m.changeLog.map((c) => `<li><b>${escapeHtml(c.version)}</b> (${escapeHtml(c.date)})<ul>${c.changes.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul></li>`).join("")}</ul>

<footer><a href="index.html">All sellers</a><a href="../rank-${escapeHtml(r.date)}.json">Data (JSON)</a></footer>
`;
  return page("How we measure · vet402", body);
}

/** Every page of the report, keyed by path relative to the report folder. */
export function renderSite(r: RankReport): Map<string, string> {
  const slugs = sellerSlugs(r.ranking.map((s) => s.key));
  const out = new Map<string, string>();
  out.set("index.html", renderIndex(r, slugs));
  out.set("method.html", renderMethod(r));
  for (const s of r.ranking) out.set(`s/${slugs.get(s.key)!}.html`, renderSeller(r, s));
  return out;
}
