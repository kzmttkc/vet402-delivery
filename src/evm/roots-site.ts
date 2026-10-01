/**
 * The "daily record" section of the Robinhood Chain and Arbitrum pages, from data/evm/roots/<lane>.json
 * (src/evm/roots.ts). Links only from 0x + 64 hex (transactions) and the pinned contract address.
 */
import { escapeHtml, PUBLIC_REPO_URL } from "../rank/html.js";
import { EVM_CHAINS, LANES } from "./chains.js";
import { ROOTS_DEPLOYMENTS, type RootsFile, type RootsLane } from "./roots.js";

const HEX_TX = /^0x[0-9a-fA-F]{64}$/;
const ext = `rel="noopener noreferrer nofollow"`;

export function rootsSection(lane: RootsLane, roots: RootsFile | undefined): string {
  const spec = EVM_CHAINS[LANES[lane].chain];
  const dep = ROOTS_DEPLOYMENTS[lane];
  const label = escapeHtml(spec.label);
  const src = `<a href="${escapeHtml(PUBLIC_REPO_URL)}/blob/main/contracts/src/DeliveryRoots.sol" ${ext}>DeliveryRoots</a>`;
  // The file exists from the first written day on; before that its name is not a link.
  const file = roots && roots.days.length > 0 ? `<a href="${escapeHtml(PUBLIC_REPO_URL)}/blob/main/data/evm/roots/${lane}.json" ${ext}>data/evm/roots/${lane}.json</a>` : `<code>data/evm/roots/${lane}.json</code>`;
  const how = `<p>The root holds facts, not verdicts. Each purchase is one leaf: what vet402 paid and to whom, the settlement transaction the chain shows for it (or that none was found), and what came back (the HTTP status, the size and the sha256 of the answer, not the answer). Whether a purchase counts as delivered, and whose side a failure is on, is not in the root: it is decided each time this page is built, with that day's rules, so a rule change never leaves an old verdict on chain. To check a purchase, take its record from ${file}, compute keccak256 of the record as canonical JSON (keys sorted, no whitespace, strings escaped as JSON.stringify does), and call <code>verify(dayNumber, digest, proof)</code> on the contract: it returns true only for a record of that day. Another contract can make the same call.</p>
<p class="meta">Every purchase is in the root from the start. A purchase whose verdict today is not in the seller's favour has its record shown only after vet402 has told that seller; until then the file shows its index alone.</p>`;
  if (!roots || roots.days.length === 0) {
    return `<h2 id="root">The daily record on ${label}</h2>
<p>After each UTC day with purchases, vet402 writes that day's Merkle root into a contract on ${label}, ${src}. A day is written once and never changes, and only vet402's own key for this contract can write it.</p>
${how}
<p class="dim">No day has been written on ${label} yet.</p>`;
  }
  const addr = escapeHtml(dep.registry);
  const contract = `<a class="mono" href="${escapeHtml(dep.explorerAddress + dep.registry)}" ${ext}>${addr}</a>`;
  const txLink = (tx: string) => (HEX_TX.test(tx) ? `<a class="mono" href="${escapeHtml(spec.explorerTx + tx)}" ${ext}>${escapeHtml(tx.slice(0, 10))}…</a>` : "–");
  const rows = roots.days
    .map((d) => `<tr><td>${escapeHtml(d.day)}</td><td class="num">${escapeHtml(d.dayNumber)}</td><td class="num">${escapeHtml(d.n)}</td><td class="num">${escapeHtml(d.published)}</td><td class="mono">${escapeHtml(d.root.slice(0, 10))}…</td><td>${txLink(d.tx)}</td></tr>`)
    .join("\n");
  return `<h2 id="root">The daily record on ${label}</h2>
<p>After each UTC day with purchases, vet402 writes that day's Merkle root into ${src} on ${label}, at ${contract}. A day is written once and never changes, and only vet402's own key for this contract can write it.</p>
${how}
<table class="board"><thead><tr><th>UTC day</th><th class="num">dayNumber</th><th class="num">purchases in the root</th><th class="num">records shown</th><th>root</th><th>transaction</th></tr></thead><tbody>
${rows}
</tbody></table>`;
}
