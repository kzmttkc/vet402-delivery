/**
 * escrow.html: what an escrow keyed on vet402's signed records would have returned in vet402's own purchases
 * (src/escrow/would-refund.ts), and the example escrow's transactions on Solana devnet
 * (solana-program/escrow-devnet.json, written by scripts/escrow-devnet.ts). Static: no scripts, styles inline.
 */
import { escapeHtml, publicFooter, publicPage, siteNav } from "../rank/html.js";
import type { ChainRefund, WouldRefundReport } from "./would-refund.js";

const CHAIN_LABEL: Record<string, string> = { algorand: "Algorand", solana: "Solana", tempo: "Tempo", base: "Base", robinhood: "Robinhood Chain", arbitrum: "Arbitrum One" };
const SOLANA_TX = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const SOLANA_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const RECORD_ID = /^obs_\d{4}-\d{2}-\d{2}_\d{6}$/;

/** What scripts/escrow-devnet.ts writes after a devnet run (the fields the page reads). */
export interface DevnetRun {
  kind: "vet402-escrow-devnet";
  cluster: string;
  rootsProgram: string;
  escrowProgram: string;
  mint: string;
  init?: { posts?: Record<string, { root: string; account: string; tx?: string }> };
  demo?: {
    ranAt: string;
    runs: {
      record: string;
      verdict: string;
      outcome: string;
      amount: string;
      decimals: number;
      payTo: string;
      mainnetTransaction: string;
      deposit: { tx: string };
      settle: { tx: string; log: string | null };
    }[];
  };
}

/** "0.927000" -> "0.927", "0.250000" -> "0.25", "0.000000" -> "0.00". */
export function usd(amount: string): string {
  const [w, f = ""] = amount.split(".");
  const t = f.replace(/0+$/, "");
  return `${w}.${t.length >= 2 ? t : t.padEnd(2, "0")}`;
}

const devnetTx = (sig: string) => {
  if (!SOLANA_TX.test(sig)) throw new Error(`not a Solana signature: ${sig}`);
  return `<a href="https://explorer.solana.com/tx/${sig}?cluster=devnet" rel="noopener noreferrer nofollow"><code>${sig.slice(0, 8)}…${sig.slice(-8)}</code></a>`;
};
const devnetAddr = (a: string) => {
  if (!SOLANA_ADDR.test(a)) throw new Error(`not a Solana address: ${a}`);
  return `<a href="https://explorer.solana.com/address/${a}?cluster=devnet" rel="noopener noreferrer nofollow"><code>${a}</code></a>`;
};
const mainnetTx = (sig: string) => {
  if (!SOLANA_TX.test(sig)) throw new Error(`not a Solana signature: ${sig}`);
  return `<a href="https://solscan.io/tx/${sig}" rel="noopener noreferrer nofollow"><code>${sig.slice(0, 8)}…${sig.slice(-8)}</code></a>`;
};

function chainRow(c: ChainRefund): string {
  const cell = (n: number, amount: string) => (n === 0 ? "0" : `${n} <span class="meta">(${escapeHtml(usd(amount))} USD)</span>`);
  return `<tr><td>${escapeHtml(CHAIN_LABEL[c.chain] ?? c.chain)}</td><td>${c.settled}</td><td>${c.delivered}</td><td><strong>${cell(c.wouldRefund.purchases, c.wouldRefund.amountUsd)}</strong></td><td>${cell(c.vet402Input.purchases, c.vet402Input.amountUsd)}</td><td>${cell(c.cantTell.purchases, c.cantTell.amountUsd)}</td></tr>`;
}

function sellersLine(r: WouldRefundReport): string {
  const told = r.chains.filter((c) => c.signedRecords).flatMap((c) => c.toldSellers.map((s) => ({ ...s, chain: c.chain })));
  const named = told.map((s) => `<code>${escapeHtml(s.seller)}</code> (${escapeHtml(CHAIN_LABEL[s.chain] ?? s.chain)}, ${s.purchases} purchases, ${escapeHtml(usd(s.amountUsd))} USD)`);
  const untold = r.totals.notToldSellers;
  return `<p>These purchases come from ${r.totals.sellers} sellers. ${named.length ? `Sellers vet402 has told about its records: ${named.join("; ")}.` : "vet402 has told none of them yet."} ${untold} ${untold === 1 ? "seller has" : "sellers have"} not been told yet: ${untold === 1 ? "it is" : "they are"} in the counts and amounts above, not by name.</p>`;
}

function devnetSection(d: DevnetRun | null): string {
  if (!d?.demo?.runs.length)
    return `<h2 id="devnet">The example escrow on devnet</h2>
<p>The example has not been run on Solana devnet yet. Its tests run on a local validator with the real roots and records: <code>npm run program:build &amp;&amp; npm run program:test</code>.</p>`;
  const rows = d.demo.runs.map((run) => {
    if (!RECORD_ID.test(run.record)) throw new Error(`bad record id ${run.record}`);
    const amount = (Number(run.amount) / 10 ** run.decimals).toFixed(run.decimals).replace(/0+$/, "").replace(/\.$/, "");
    return `<tr><td><a href="records/${run.record}.html"><code>${run.record}</code></a><br><span class="meta">mainnet payment ${mainnetTx(run.mainnetTransaction)}</span></td><td>${escapeHtml(run.verdict)}</td><td>${escapeHtml(amount)}</td><td>${devnetTx(run.deposit.tx)}</td><td>${devnetTx(run.settle.tx)}</td><td>${escapeHtml(run.outcome)}</td></tr>`;
  });
  const posts = Object.entries(d.init?.posts ?? {})
    .filter(([, p]) => p.tx)
    .map(([day, p]) => `${escapeHtml(day)} ${devnetTx(p.tx!)}`);
  return `<h2 id="devnet">The example escrow on devnet</h2>
<p>observation-roots is deployed on Solana devnet as ${devnetAddr(d.rootsProgram)} (a devnet program id, not the mainnet one), with the same roots as on mainnet for 2026-09-28 to 2026-09-30${posts.length ? ` (posted in ${posts.join(", ")})` : ""}. The example escrow is ${devnetAddr(d.escrowProgram)}. The token is a devnet test token with 6 decimals, ${devnetAddr(d.mint)}, standing in for USDC. Each row is one deposit and one settlement, sent on devnet on ${escapeHtml(d.demo.ranAt.slice(0, 10))}, settled with a real published record and its proof.</p>
<div class="wrap"><table><thead><tr><th>Record</th><th>Verdict</th><th>Amount</th><th>Deposit</th><th>Settlement</th><th>Result</th></tr></thead><tbody>
${rows.join("\n")}
</tbody></table></div>`;
}

export function renderEscrowPage(r: WouldRefundReport, devnet: DevnetRun | null): string {
  const t = r.totals;
  const withheld = r.withheldLanes.filter((l) => l.withheldPurchases > 0);
  const signedChains = r.chains.filter((c) => c.signedRecords);
  const unsignedChains = r.chains.filter((c) => !c.signedRecords);
  const body = `${siteNav(null)}
<style>.wrap{overflow-x:auto;margin:8px 0}.wrap table{border-collapse:collapse;min-width:600px;font-size:.92rem}.wrap th,.wrap td{padding:6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:baseline}.wrap thead th{border-bottom:1px solid var(--fg)}</style>
<h1>What an escrow would have returned</h1>
<p class="lead">vet402 signs a record of each purchase it pays for on Solana, Tempo and Base. On Solana, a program can check that record and read its verdict. An escrow can then pay the seller only when the record says DELIVERED, and give the money back when it says NOT_DELIVERED. This page shows how much such an escrow would have given back in vet402's own purchases, and an example escrow doing it on devnet.</p>
<p>No escrow was used for these purchases: no money was actually returned. The numbers are what an escrow would have done.</p>
<h2 id="numbers">In vet402's own purchases</h2>
<p class="big">${t.wouldRefund.purchases} purchases, ${escapeHtml(usd(t.wouldRefund.amountUsd))} USD</p>
<p>would have gone back to the buyer on Solana, Tempo and Base, the chains where vet402 signs a record of each purchase: the payment settled, nothing usable came back, and the failure is on the seller's side. That is out of ${t.settled} purchases whose payment settled on these chains, up to ${escapeHtml(r.dataDate)} (UTC).</p>
<div class="wrap"><table><thead><tr><th>Chain</th><th>Payment settled</th><th>Came back with an answer</th><th>Escrow would return</th><th>Not counted: vet402 sent a wrong request</th><th>Not counted: can't tell whose side</th></tr></thead><tbody>
${signedChains.map(chainRow).join("\n")}
</tbody></table></div>
${sellersLine(r)}
${unsignedChains.length ? `<p>Same rule, no signed record: vet402 does not sign records of these purchases, so no escrow could be settled with one. Not in the totals above.</p>
<div class="wrap"><table><thead><tr><th>Chain</th><th>Payment settled</th><th>Came back with an answer</th><th>Same rule</th><th>Not counted: vet402 sent a wrong request</th><th>Not counted: can't tell whose side</th></tr></thead><tbody>
${unsignedChains.map(chainRow).join("\n")}
</tbody></table></div>` : ""}
${withheld.length ? `<p>${withheld.map((l) => `${escapeHtml(CHAIN_LABEL[l.lane] ?? l.lane)}: ${l.withheldPurchases} purchases whose results are not published yet`).join(". ")}. They are not in the numbers above.</p>` : ""}
<p class="meta">The amounts are small because each is the listed price of one API call. The count is the point: how often a paid call brought back nothing.</p>
<h3 id="definition">What is counted</h3>
<ul>
${r.definition.map((d) => `<li>${escapeHtml(d)}</li>`).join("\n")}
</ul>
${devnetSection(devnet)}
<h2 id="how">How the example works</h2>
<ol>
<li><strong>Deposit.</strong> The buyer locks the price for one purchase, named by the record's network, payTo and transaction, with a deadline. payTo must be a Solana address; only that address can be paid.</li>
<li><strong>Settle.</strong> Anyone sends the purchase's signed record and its Merkle proof. The escrow checks that the record is about this purchase and this amount, then asks observation-roots (one CPI to <code>verify</code>) whether the record is in the day's root. DELIVERED pays the seller. NOT_DELIVERED returns the money to the buyer. A changed record or a wrong proof is refused.</li>
<li><strong>Otherwise, wait.</strong> MISMATCH and UNCLEAR settle nothing. After the deadline the buyer can take the money back, so a purchase without a usable record does not lock it.</li>
</ol>
<p>The code is <a href="https://github.com/kzmttkc/vet402-delivery/tree/main/solana-program/programs/delivery-escrow-example" rel="noopener noreferrer nofollow"><code>solana-program/programs/delivery-escrow-example</code></a>, with its tests in <code>solana-program/tests/escrow.test.ts</code>. The numbers above come from <code>npx tsx scripts/escrow-would-refund.ts</code>, and as JSON from <a href="escrow.json">escrow.json</a>.</p>
<h3 id="limits">Limits</h3>
<ul>
<li>The records here are of purchases vet402 paid straight to the seller. The devnet escrow is tied to such a record to show the mechanism; the seller had already been paid on mainnet. For a purchase paid through an escrow, the record would have to name the escrow deposit as its payment, and the seller would have to accept being paid that way.</li>
<li>A record says what vet402 saw, no more. Corrections made after a record was signed are not in the root, so the escrow does not see them.</li>
<li>The example does not compare the record's asset with the deposited token. A real escrow should.</li>
<li>The example does not set a lowest deadline. A seller should check the deadline before serving: it must fall after the end of the purchase's UTC day plus the time vet402 takes to post that day's root (during the next UTC day). Otherwise the buyer can reclaim before the record can be checked.</li>
<li>The example escrow has not been audited. It runs on devnet and in tests only, is not for real funds, and is not deployed on mainnet.</li>
</ul>
${publicFooter()}`;
  return publicPage(
    "What an escrow would have returned · vet402",
    `On Solana, Tempo and Base, ${t.wouldRefund.purchases} of vet402's paid purchases (${usd(t.wouldRefund.amountUsd)} USD) settled with nothing usable back on the seller's side; an escrow keyed on the signed record would have returned them. No escrow was used.`,
    body,
  );
}
