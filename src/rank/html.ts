/**
 * Static HTML for the rank report. Readable at phone width, no scripts, no external requests.
 *
 * Every string that a seller can influence (host, URL, payTo, reason text, tx id) goes through
 * escapeHtml. Links are built only from tx ids that match the chain's id format, onto a fixed
 * explorer origin, so a seller-supplied value can never become a link target.
 */
import type { Comparison, CompareRow } from "./compare.js";
import type { RankReport } from "./report.js";
import type { RankedSeller } from "./score.js";
import type { Chain, ReasonCategory } from "./types.js";

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
  settled_bad_content: "paid, answer not as declared",
  unconfirmed_server_error: "5xx, settlement unknown",
  not_payable: "not buyable",
  payto_changed: "payTo changed",
  vet402_skipped: "skipped by vet402",
};

function pct(x: number): string {
  return `${(x * 100).toFixed(x === 1 || x === 0 ? 0 : 1)}%`;
}

function failuresText(f: Partial<Record<ReasonCategory, number>>): string {
  const parts = Object.entries(f)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([k, n]) => `${CATEGORY_LABEL[k as ReasonCategory] ?? k} ${n}`);
  return parts.join(", ");
}

function sellerCard(s: RankedSeller): string {
  const chains = Object.entries(s.chains)
    .map(([c, v]) => `${c} ${v!.delivered}/${v!.tried}`)
    .join(" · ");
  const fails = failuresText(s.failures);
  const notTried = failuresText(s.notTried);
  const last = s.last
    ? `${escapeHtml(s.last.at.slice(0, 16).replace("T", " "))} UTC · ${escapeHtml(CATEGORY_LABEL[s.last.category])} ${txHtml(s.last.chain, s.last.tx)}`
    : "";
  const payTo = s.payToChanged
    ? `<p class="warn">payTo changed: ${s.payToChanges
        .slice(0, 3)
        .map((c) => `<span class="mono">${escapeHtml(c.from)}</span> → <span class="mono">${escapeHtml(c.to)}</span> (${escapeHtml(c.how === "refused_at_payment" ? "vet402 refused to pay" : "later run")})`)
        .join("; ")}</p>`
    : "";
  return `<li class="seller">
  <div class="row1"><span class="rank">#${s.rank}</span><span class="host">${escapeHtml(s.key)}</span></div>
  <div class="row2"><span class="big">${s.delivered}/${s.tried}</span> delivered · score ${s.wilsonLower.toFixed(3)} · settled ${pct(s.settledRate)}</div>
  <div class="meta">${escapeHtml(chains)}</div>
  ${fails ? `<div class="meta">failed: ${escapeHtml(fails)}</div>` : ""}
  ${notTried ? `<div class="meta dim">not counted: ${escapeHtml(notTried)}</div>` : ""}
  <div class="meta">last: ${last}</div>
  ${payTo}
</li>`;
}

function compareRow(r: CompareRow, metricIsRank: boolean): string {
  const value = metricIsRank ? `best rank ${r.catalogValue}` : `${r.catalogValue.toLocaleString("en-US")} calls/30d`;
  const f = r.delivered === 0 ? r.lastFailure : null;
  const why = f
    ? `<div class="meta">${escapeHtml(f.chain)} · ${escapeHtml(CATEGORY_LABEL[f.category])} · <span class="mono">${escapeHtml(f.rawReason)}</span>${f.detail ? ` · <span class="mono">${escapeHtml(f.detail)}</span>` : ""}</div>
  <div class="meta mono">${escapeHtml(f.url)}</div>`
    : "";
  return `<li><span class="host">${escapeHtml(r.key)}</span><br>
  catalog #${r.catalogPos} (${escapeHtml(value)}) · vet402 #${r.vet402Rank}: <b>${r.delivered}/${r.tried}</b> delivered
  ${r.delivered === 0 ? `· ${escapeHtml(failuresText(r.failures))}` : ""} ${r.tx ? txHtml(r.tx.chain, r.tx.tx) : ""}
  ${why}</li>`;
}

function comparisonSection(c: Comparison): string {
  const isRank = c.direction === "asc";
  const list = (rows: CompareRow[]) =>
    rows.length ? `<ol class="plain">${rows.slice(0, 10).map((r) => compareRow(r, isRank)).join("\n")}</ol>${rows.length > 10 ? `<p class="dim">…and ${rows.length - 10} more in the JSON.</p>` : ""}` : `<p class="dim">none</p>`;
  return `<section>
<h2>${escapeHtml(c.catalog)} order vs vet402</h2>
<p>${escapeHtml(c.rule)}</p>
<div class="stats">
  <div><span class="big">${c.overlap}</span><br>sellers in both</div>
  <div><span class="big">${c.highButNeverDelivered.length}</span><br>high in catalog, never delivered (${c.highButNeverDeliveredDespitePaidTx} after a settled payment)</div>
  <div><span class="big">${c.lowButAlwaysDelivered.length}</span><br>low in catalog, always delivered</div>
  <div><span class="big">${c.spearman === null ? "–" : c.spearman.toFixed(2)}</span><br>rank correlation</div>
</div>
<h3>High in the catalog, never delivered to vet402</h3>
${list(c.highButNeverDelivered)}
<h3>Low in the catalog, delivered every time</h3>
${list(c.lowButAlwaysDelivered)}
</section>`;
}

export function renderHtml(r: RankReport): string {
  const chainRows = r.chains
    .map(
      (c) => `<tr><td>${escapeHtml(c.chain)}</td><td>${c.tried}</td><td>${c.settled}</td><td>${c.delivered}</td><td>${c.sellersTried}</td></tr>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'">
<meta name="referrer" content="no-referrer">
<title>vet402 seller ranking</title>
<style>
:root{--bg:#fbfbf9;--fg:#1d1d1b;--dim:#6b6b66;--line:#e2e1dc;--card:#fff;--warn:#9a3b00;--link:#0b5cad}
@media (prefers-color-scheme: dark){:root{--bg:#141413;--fg:#ecebe6;--dim:#a09f99;--line:#34332f;--card:#1d1d1b;--warn:#ffb27a;--link:#8cc2ff}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:760px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:1.5rem;margin:0 0 4px}h2{font-size:1.15rem;margin:32px 0 8px}h3{font-size:1rem;margin:20px 0 6px}
p{margin:6px 0}a{color:var(--link)}
.dim{color:var(--dim)}.warn{color:var(--warn);margin:4px 0 0}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85em;overflow-wrap:anywhere}
.host{font-weight:600;overflow-wrap:anywhere}
.big{font-size:1.25rem;font-weight:700;font-variant-numeric:tabular-nums}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin:12px 0}
.stats>div{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;font-size:.85rem;color:var(--dim)}
.stats .big{color:var(--fg)}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{border-bottom:1px solid var(--line);padding:6px 4px;text-align:right}th:first-child,td:first-child{text-align:left}
ol.plain,ul.sellers{padding-left:0;list-style:none;margin:0}
ol.plain li{padding:8px 0;border-bottom:1px solid var(--line);overflow-wrap:anywhere}
li.seller{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:8px 0}
.row1{display:flex;gap:8px;align-items:baseline}.rank{color:var(--dim);font-variant-numeric:tabular-nums;min-width:3ch}
.meta{font-size:.85rem;color:var(--dim);overflow-wrap:anywhere}
details{margin:8px 0}summary{cursor:pointer}
</style>
</head>
<body><main>
<h1>vet402 seller ranking</h1>
<p class="dim">${escapeHtml(r.date)} · generated ${escapeHtml(r.generatedAt)}</p>
<p>Sellers ranked by what happened when vet402, an independent buyer, paid them with its own money. Not by how many calls or payers a catalog reports.</p>
<div class="stats">
  <div><span class="big">${r.totals.sellersRanked}</span><br>sellers ranked</div>
  <div><span class="big">${r.totals.tried}</span><br>paid tries</div>
  <div><span class="big">${r.totals.delivered}</span><br>delivered</div>
  <div><span class="big">${r.totals.payToChanged}</span><br>payTo changed</div>
</div>

<section>
<h2>How the rank is made</h2>
<ul>
<li><b>Score:</b> ${escapeHtml(r.method.score)}</li>
<li><b>Counted:</b> ${escapeHtml(r.method.counted)}</li>
<li><b>Not counted:</b> ${escapeHtml(r.method.notCounted)}</li>
<li><b>Order:</b> ${escapeHtml(r.method.order)}</li>
<li><b>Seller:</b> ${escapeHtml(r.method.sellerIdentity)}</li>
<li><b>payTo:</b> ${escapeHtml(r.method.payTo)}</li>
<li><b>Money:</b> ${escapeHtml(r.method.money)}</li>
<li><b>Delivery check:</b> ${escapeHtml(r.method.deliveryCheck)}</li>
</ul>
<p class="dim">Limits: ${r.method.limits.map(escapeHtml).join(" ")}</p>
</section>

<section>
<h2>By chain</h2>
<table><thead><tr><th>chain</th><th>tries</th><th>settled</th><th>delivered</th><th>sellers</th></tr></thead>
<tbody>
${chainRows}
</tbody></table>
</section>

${r.comparisons.map(comparisonSection).join("\n")}
<section><h2>Catalogs with no order to compare</h2>
<ul>${r.catalogsWithoutOrder.map((c) => `<li><b>${escapeHtml(c.catalog)}</b>: ${escapeHtml(c.why)}</li>`).join("")}</ul>
</section>

<section>
<h2>Ranking</h2>
<ul class="sellers">
${r.ranking.map(sellerCard).join("\n")}
</ul>
</section>

<section>
<h2>Inputs</h2>
<ul>${r.inputs.map((i) => `<li class="meta"><b>${escapeHtml(i.label)}</b> <span class="mono">${escapeHtml(i.location)}</span> sha256 <span class="mono">${escapeHtml(i.sha256.slice(0, 16))}</span>${i.fetchedAt ? ` fetched ${escapeHtml(i.fetchedAt)}` : ""}</li>`).join("")}</ul>
</section>
</main></body></html>
`;
}
