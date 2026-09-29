/**
 * The human page for one observation: a static HTML file, phone width, no external requests.
 * Read top to bottom:
 *   verdict word + one sentence -> what it proves / does not prove -> 3 checks (payment, response,
 *   record) -> verify it yourself -> all fields (folded) -> seller's note and corrections.
 * For NOT_DELIVERED / MISMATCH / UNCLEAR the seller's entry point moves up, right under the summary.
 * No score, no badge, no lock or shield. Shape carries the verdict as well as colour.
 * Every value from the record goes through `esc`; nothing from the record is placed in a script.
 */
import type { Observation, VerdictCode } from "./types.js";

export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const WORD: Record<VerdictCode, { text: string; shape: string; cls: string }> = {
  DELIVERED: { text: "DELIVERED", shape: "●", cls: "v-delivered" },
  MISMATCH: { text: "MISMATCH", shape: "◐", cls: "v-mismatch" },
  NOT_DELIVERED: { text: "NOT DELIVERED", shape: "○", cls: "v-not" },
  UNCLEAR: { text: "UNCLEAR", shape: "?", cls: "v-unclear" },
};

const CHAIN: Record<string, { name: string; tx: (t: string) => string }> = {
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": { name: "Solana", tx: (t) => `https://solscan.io/tx/${encodeURIComponent(t)}` },
  "eip155:8453": { name: "Base", tx: (t) => `https://basescan.org/tx/${encodeURIComponent(t)}` },
  "eip155:4217": { name: "Tempo", tx: (t) => `https://explore.tempo.xyz/tx/${encodeURIComponent(t)}` },
};

export function chainName(network: string): string {
  return CHAIN[network]?.name ?? network;
}

export function explorerUrl(network: string, tx: string): string | null {
  return CHAIN[network]?.tx(tx) ?? null;
}

/** 0.001000 -> "0.001" (atomic string, decimals) without floating point. */
export function formatAmount(atomic: string, decimals: number): string {
  const neg = atomic.startsWith("-");
  const digits = (neg ? atomic.slice(1) : atomic).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Always a full date in UTC. Never a relative time. */
export function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

export function shortHash(h: string): string {
  return h.length > 14 ? `${h.slice(0, 6)}…${h.slice(-4)}` : h;
}

function bytesText(n: number | null): string | null {
  if (n === null) return null;
  if (n < 1000) return `${n} bytes`;
  return `${(n / 1000).toFixed(1)} KB`;
}

function hostPath(resourceUrl: string): string {
  try {
    const u = new URL(resourceUrl);
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return resourceUrl;
  }
}

/** The one sentence under the verdict word, Etherscan "Transaction Action" style. Past tense. */
export function summarySentence(o: Observation): string {
  const amt = `${formatAmount(o.payment.amount, o.payment.decimals)} ${o.payment.assetSymbol}`;
  const head = `vet402 paid ${amt} on ${chainName(o.payment.network)} to ${hostPath(o.resourceUrl)}`;
  const s = o.response.status;
  const size = bytesText(o.response.bytes);
  const type = o.response.contentType ? o.response.contentType.split(";")[0]!.trim() : null;
  switch (o.verdict.code) {
    case "DELIVERED": {
      const what = size && type ? `${size} of ${type}` : size ?? type ?? "a response";
      return `${head} and received ${what} with HTTP ${s}.`;
    }
    case "NOT_DELIVERED":
      if (s === null) return `${head}. No response came back before the timeout.`;
      if (s === 402) return `${head}. The seller answered HTTP 402 (payment required) again.`;
      if (s >= 200 && s <= 299) return `${head}. The seller answered HTTP ${s} with an empty body.`;
      return `${head}. The seller answered HTTP ${s}.`;
    case "MISMATCH":
      return `${head} and received HTTP ${s}, but ${o.verdict.reason.replace(/^HTTP \d+; /, "").replace(/\.$/, "")}.`;
    case "UNCLEAR":
      return `${head}. The seller answered HTTP ${s}.`;
  }
}

function flatten(obj: unknown, prefix = "", out: [string, string][] = []): [string, string][] {
  if (obj === null || typeof obj !== "object") {
    out.push([prefix, obj === null ? "null" : String(obj)]);
    return out;
  }
  const entries = Array.isArray(obj) ? obj.map((v, i) => [String(i), v] as const) : Object.entries(obj);
  if (entries.length === 0) out.push([prefix, Array.isArray(obj) ? "[]" : "{}"]);
  for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

function copyable(full: string): string {
  return `<button type="button" class="hash" data-copy="${esc(full)}" title="Copy ${esc(full)}">${esc(shortHash(full))}</button>`;
}

export interface RenderOptions {
  /** File name of the JSON next to this page. */
  jsonHref: string;
  /** Command shown under "Verify it yourself". */
  verifyCommand: string;
  /**
   * For the public site: a Content-Security-Policy that forbids scripts (as on the ranking pages), no
   * script and no copy buttons, a navigation line, and where vet402's key is published.
   */
  site?: { nav: string; keyHref: string };
}

const SITE_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'">`;

export function renderObservationPage(o: Observation, opts: RenderOptions): string {
  const site = opts.site;
  const hashOf = (full: string): string => (site ? `<code class="hash" title="${esc(full)}">${esc(shortHash(full))}</code>` : copyable(full));
  const w = WORD[o.verdict.code];
  const when = o.response.receivedAt ?? o.request.ts;
  const whenLabel = o.response.receivedAt ? "response recorded" : "request sent";
  const txUrl = explorerUrl(o.payment.network, o.payment.transaction);
  const negative = o.verdict.code !== "DELIVERED";
  const statusText = o.response.status === null ? "no response" : `HTTP ${o.response.status}`;
  const respDetail = [statusText, bytesText(o.response.bytes), o.response.contentType?.split(";")[0]].filter(Boolean).join(" · ");
  const hashLine = o.response.responseHash
    ? `responseHash ${hashOf(o.response.responseHash)} (${esc(o.response.responseHashAlg)}, ${esc(o.response.responseHashEncoding)})`
    : `responseHash: ${esc(o.response.responseHashNote ?? "not recorded")}`;
  const anchor = o.anchor;
  const recordRow = !anchor
    ? `<span class="mark">◷</span><span class="k">Record</span><span class="v">Not yet in a daily root.</span>`
    : anchor.status === "anchored" && anchor.tx
      ? `<span class="mark">✓</span><span class="k">Record</span><span class="v">In the ${esc(anchor.day)} root, written on ${esc(chainName(anchor.network))} · ${
          explorerUrl(anchor.network, anchor.tx) ? `<a href="${esc(explorerUrl(anchor.network, anchor.tx))}" rel="noopener noreferrer">${esc(shortHash(anchor.tx))} ↗</a>` : esc(anchor.tx)
        }</span>`
      : `<span class="mark">◷</span><span class="k">Record</span><span class="v">In the ${esc(anchor.day)} root ${hashOf(anchor.root)} (leaf ${esc(anchor.leafIndex)} of ${esc(
          anchor.count,
        )}). Not yet written on chain.</span>`;

  const seller = `
  <section class="card seller${negative ? " up" : ""}" aria-labelledby="seller-h">
    <h2 id="seller-h">Are you the seller?</h2>
    <p>You can attach your own signed x402 Receipt for this transaction, add a note, or ask vet402 to pay and check again. Nothing here is deleted; additions are listed below the record with their date.</p>
    <p>Open an issue at <a href="https://github.com/kzmttkc/vet402-delivery/issues" rel="noopener noreferrer">github.com/kzmttkc/vet402-delivery/issues</a> with the record id <code>${esc(o.id)}</code> (the same place as corrections to the ranking), or send the id to <a href="${esc(o.contact)}" rel="noopener noreferrer">${esc(o.contact)}</a>.</p>
  </section>`;

  const fields = flatten({ ...o, signature: o.signature ? { ...o.signature } : null })
    .map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`)
    .join("\n");

  const corrections = o.corrections.length
    ? `<ol class="corr">${o.corrections
        .map(
          (c) =>
            `<li><span class="date">${esc(formatUtc(c.at))}</span> · ${esc(c.kind)} · by ${esc(c.by)}${
              c.kind === "seller-note" ? " <em>(the seller's statement; vet402 has not checked it)</em>" : ""
            }<br>${esc(c.text)}</li>`,
        )
        .join("")}</ol>`
    : `<p class="muted">None.</p>`;
  const sellerNotes = o.corrections.filter((c) => c.kind === "seller-note" || c.kind === "seller-receipt").length;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
${site ? SITE_CSP : ""}
<title>Delivery record ${esc(o.id)}</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#5f5e58;--line:#dedcd4;--card:#ffffff;--accent:#2f5d8a;
--delivered:#2e6b3f;--mismatch:#8a5a12;--not:#8a2f2f;--unclear:#4d4d6b;color-scheme:light}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#161614;--fg:#eceae3;--muted:#a6a39a;--line:#34332f;--card:#1f1f1c;--accent:#8db5dc;
--delivered:#8fc79d;--mismatch:#e0b36a;--not:#e59a9a;--unclear:#b3b3d6;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#161614;--fg:#eceae3;--muted:#a6a39a;--line:#34332f;--card:#1f1f1c;--accent:#8db5dc;
--delivered:#8fc79d;--mismatch:#e0b36a;--not:#e59a9a;--unclear:#b3b3d6;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-text-size-adjust:100%}
main{max-width:560px;margin:0 auto;padding:16px}
header.top{font-size:14px;color:var(--muted);margin:4px 0 12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:0 0 12px}
.verdict{font-size:28px;font-weight:700;letter-spacing:.02em;margin:0 0 6px;display:flex;gap:10px;align-items:baseline}
.v-delivered .verdict{color:var(--delivered)}.v-mismatch .verdict{color:var(--mismatch)}.v-not .verdict{color:var(--not)}.v-unclear .verdict{color:var(--unclear)}
.sentence{margin:0 0 8px;overflow-wrap:anywhere}
.date{color:var(--muted);font-size:14px}
.scope{margin-top:12px;padding-top:12px;border-top:1px solid var(--line);font-size:15px}
.scope p{margin:0 0 4px}
.vantage{font-weight:600}
h2{font-size:16px;margin:0 0 8px}
.checks{list-style:none;margin:0;padding:0}
.checks li{display:grid;grid-template-columns:1.4em 5.5em 1fr;gap:6px;padding:8px 0;border-top:1px solid var(--line);font-size:15px}
.checks li:first-child{border-top:0}
.checks .v{overflow-wrap:anywhere}
.checks .sub{grid-column:3;color:var(--muted);font-size:14px}
a{color:var(--accent)}
code,.hash,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.hash{background:none;border:1px dashed var(--line);border-radius:4px;color:inherit;padding:0 4px;cursor:pointer}
pre{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:10px;white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0}
details{border-top:1px solid var(--line);padding:10px 0}
details:first-of-type{border-top:0}
summary{cursor:pointer;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed}
th,td{text-align:left;vertical-align:top;padding:4px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}
th{width:42%;font-weight:500;color:var(--muted);padding-right:8px}
.muted{color:var(--muted)}
.seller.up{border-color:var(--fg)}
footer{font-size:13px;color:var(--muted);margin:8px 0 24px;overflow-wrap:anywhere}
ul.plain{margin:4px 0 0;padding-left:1.2em;font-size:14px}
</style>
</head>
<body>
<main class="${w.cls}">
<header class="top">${site ? site.nav : "vet402 · Delivery record"}</header>

<section class="card" aria-labelledby="verdict-h">
  <h1 class="verdict" id="verdict-h"><span aria-hidden="true">${w.shape}</span><span>${esc(w.text)}</span></h1>
  <p class="sentence">${esc(summarySentence(o))}</p>
  ${o.verdict.code === "DELIVERED" && o.verdict.checks.bodyNonEmpty === null ? `<p class="limit"><strong>Limit:</strong> only the HTTP status was recorded for this purchase. The body length was not, so an empty 200 cannot be ruled out.</p>` : ""}
  <p class="date">${when ? `<time datetime="${esc(when)}" data-local>${esc(formatUtc(when))}</time> (${esc(whenLabel)})` : "Time not recorded"}</p>
  ${o.verdict.recheck ? `<p><strong>Next check:</strong> ${esc(o.verdict.recheck)}</p>` : ""}
  <div class="scope">
    ${negative ? `<p class="vantage">${esc(o.scope.vantage)}</p>` : ""}
    <p><strong>Proves:</strong> vet402 paid${o.response.responseHash ? " and got these bytes" : " and saw this HTTP status"} at this time.</p>
    <p><strong>Doesn't prove:</strong> that the content is correct, or that the seller is working now.</p>
  </div>
</section>
${negative ? seller : ""}
<section class="card" aria-labelledby="checks-h">
  <h2 id="checks-h">3 checks</h2>
  <ul class="checks">
    <li><span class="mark">✓</span><span class="k">Payment</span><span class="v">${esc(formatAmount(o.payment.amount, o.payment.decimals))} ${esc(o.payment.assetSymbol)} on ${esc(
      chainName(o.payment.network),
    )} · ${txUrl ? `<a href="${esc(txUrl)}" rel="noopener noreferrer">${esc(shortHash(o.payment.transaction))} ↗</a>` : esc(o.payment.transaction)}</span>
      <span class="sub">from ${hashOf(o.payment.payer)} to ${hashOf(o.payment.payTo)}</span></li>
    <li><span class="mark">${w.shape}</span><span class="k">Response</span><span class="v">${esc(respDetail)}</span>
      <span class="sub">${esc(o.verdict.reason)}<br>${hashLine}</span></li>
    <li>${recordRow}</li>
  </ul>
</section>

<section class="card" aria-labelledby="verify-h">
  <h2 id="verify-h">Verify it yourself</h2>
  <p>No account and no payment needed. The script checks that ${
    site ? `vet402's published key (<a href="${esc(site.keyHref)}" rel="noopener noreferrer">src/receipt/observers.ts</a>)` : "vet402's published key (<code>--signer</code>)"
  } signed this record, looks up the payment on chain, and checks the record against its daily Merkle root.</p>
  <p><a href="${esc(opts.jsonHref)}" download>Download JSON</a></p>
  <pre>${esc(opts.verifyCommand)}</pre>
  ${site ? "" : `<button type="button" class="hash" data-copy="${esc(opts.verifyCommand)}">Copy command</button>`}
</section>

<section class="card">
  <details>
    <summary>All fields</summary>
    <table>${fields}</table>
    <p class="muted">Not recorded by the run that made this observation:</p>
    <ul class="plain">${o.notRecorded.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
  </details>
  <details>
    <summary>Seller response (${sellerNotes})</summary>
    ${sellerNotes ? "" : `<p class="muted">None.</p>`}
  </details>
  <details>
    <summary>Correction history (${o.corrections.length})</summary>
    ${corrections}
  </details>
</section>
${negative ? "" : seller}
<footer>
  Record #${esc(o.observer.sequence)} · <code>${esc(o.id)}</code><br>
  Signed by vet402 key ${hashOf(o.observer.address)} (${esc(o.observer.id)}; ${
    site ? `listed in <a href="${esc(site.keyHref)}" rel="noopener noreferrer">src/receipt/observers.ts</a>` : "key publication pending"
  })<br>
  Contact: <a href="${esc(o.contact)}" rel="noopener noreferrer">${esc(o.contact)}</a>
</footer>
</main>
${site ? "" : `<script>
(function(){
  document.querySelectorAll("time[data-local]").forEach(function(t){
    try{var d=new Date(t.getAttribute("datetime"));if(isNaN(d))return;
      var s=d.toLocaleString(undefined,{day:"numeric",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"});
      var span=document.createElement("span");span.className="date";span.textContent=" ("+s+" your time)";t.after(span);}catch(e){}
  });
  document.addEventListener("click",function(e){
    var b=e.target.closest("[data-copy]");if(!b)return;
    try{navigator.clipboard.writeText(b.getAttribute("data-copy"));var o=b.textContent;b.textContent="Copied";setTimeout(function(){b.textContent=o},1200);}catch(err){}
  });
})();
</script>`}
</body>
</html>
`;
}
