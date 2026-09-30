/**
 * The Robinhood Chain and Arbitrum pages of the public site, from data/evm/<lane>.json.
 *
 * data/evm/<lane>.json is written by scripts/evm-publish.ts from the lane's own output (results/evm/): the
 * read-only census of sellers that list the chain, and, once vet402 has paid, what each purchase did.
 * Every seller-supplied string goes through escapeHtml; tx links only from 0x + 64 hex onto a fixed explorer.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicToUsdc } from "../constants.js";
import { escapeHtml, PUBLIC_REPO_URL, publicFooter, publicPage, tabs } from "../rank/html.js";
import type { GroupReport, RankReport } from "../rank/report.js";
import type { StockComparison, StockReference } from "../robinhood/stock-check.js";
import { EVM_CHAINS, LANES, type EvmChainKey } from "./chains.js";
import type { ChainBuyRecord } from "./evm-buy.js";
import type { CauseResult } from "./settle-cause.js";
import { STOCK_SELLER } from "./lane-plan.js";
import { notifiedSellers, type NotifiedFile } from "../receipt/publish.js";

const STOCK_SELLER_RESOURCE = STOCK_SELLER.resource;

/**
 * delivered       settled on chain (read back by vet402) and an answer came back
 * settled_no_answer settled on chain, no answer: the only status that is the seller's doing
 * not_settled     vet402 sent a payment and no settlement came back (no tx named, or the tx reverted)
 * unconfirmed     a settlement tx was named (or the request timed out) but vet402 could not read it back
 * withheld        a negative result for a seller not yet in data/records/notified.json: not published
 */
export type RowStatus = "not_offered_now" | "not_bought_yet" | "refused" | "delivered" | "settled_no_answer" | "not_settled" | "unconfirmed" | "withheld";

export interface LaneRow {
  payTo: string;
  hosts: string[];
  catalogListings: number;
  resource: string | null;
  /** Atomic price in the live 402 (the chain's token, 6 decimals). */
  livePrice: string | null;
  status: RowStatus;
  cause: CauseResult | null;
  settlementTx: string | null;
  paidRequestMs: number | null;
  relayer: string | null;
  facilitatorLead: string | null;
  /** Why no listing of this payTo was bought (only when none was chosen). */
  skipped: string | null;
  /** When vet402 bought more than once from this payTo (the stock-price check): how many, and how many settled. */
  purchases?: number;
  settled?: number;
}

export interface StockRow {
  ticker: string;
  /** The listing bought for this ticker. */
  resource?: string;
  /** A negative verdict for a seller not yet told: not published. */
  withheld?: boolean;
  reference: Pick<StockReference, "feed" | "token" | "tokenPrice" | "sharePrice" | "multiplier" | "updatedAt" | "readAt" | "stale" | "oraclePaused">;
  comparison: StockComparison | null;
}

export interface LanePublic {
  kind: "vet402-evm-lane";
  lane: "robinhood" | "arbitrum";
  chain: string;
  generatedAt: string;
  /** "census": nothing bought yet, live 402s read without paying. "purchases": rows carry paid results. */
  source: "census" | "purchases";
  catalogs: Record<string, { items: number; complete: boolean | null }>;
  payTosInCatalogs: number;
  payTosOffered: number;
  rows: LaneRow[];
  /** Arbitrum page: the same listing bought on Base, by resource. */
  compare?: Record<string, Pick<LaneRow, "status" | "cause" | "settlementTx" | "paidRequestMs" | "relayer">>;
  stock?: StockRow[];
}

type DryRunChoice = { payTo: string; catalogListings: number; hosts: string[]; chosen: { resource: string; liveAmount: string } | null; tried?: { status: number | null; why: string }[] };

/** Plain words for why no listing of a payTo passed the checks, from the last listing tried. */
export function skipReason(c: DryRunChoice, chainLabel: string): string | null {
  if (c.chosen) return null;
  const t = c.tried?.at(-1);
  if (!t) return "every listing costs more than the per-purchase cap";
  if (t.status !== 402) return `no 402 came back (${t.status === null ? "no response" : `HTTP ${t.status}`})`;
  const code = t.why.split(":")[0] ?? "";
  if (code.startsWith("no_")) return `the live 402 no longer offers ${chainLabel}`;
  if (code === "asset_mismatch") return "the live 402 asks for another token";
  if (code === "price_raised") return "the live 402 asks more than the listing";
  if (code === "price_over_cap") return "the live 402 asks more than the per-purchase cap";
  if (code === "domain_mismatch") return "the 402 names a token domain that is not the token's own";
  if (code === "not_eip3009") return "the 402 asks for Permit2, which vet402 does not sign";
  if (code === "payto_mismatch") return "the live 402 pays another address";
  if (code === "payto_differs_across_chains") return "the payTo differs between Base and this chain";
  if (code === "timeout_invalid") return "the 402's validity window is missing or over an hour";
  return code.replace(/_/g, " ");
}
type Rec = ChainBuyRecord & { lane: string; cause: CauseResult; relayer?: string | null; predictedProblem?: string | null; stock?: StockComparison | { verdict: string } };

function statusOf(r: Rec | undefined): RowStatus {
  if (!r || r.outcome === "would_pay" || r.outcome === "not_sent") return "not_bought_yet";
  if (r.outcome === "refused") return "refused";
  if (r.delivered) return "delivered";
  if (r.settledOnChain === true) return "settled_no_answer";
  return r.cause?.cause === "unconfirmed" ? "unconfirmed" : "not_settled";
}

/** Skip reasons that say nothing against the seller (it just no longer lists the chain, or is over vet402's cap). */
const NEUTRAL_SKIPS = [/^the live 402 no longer offers /, /^every listing costs more than the per-purchase cap$/, /^the live 402 asks more than the per-purchase cap$/];

/** Stock verdicts that are a finding against the seller's answer. */
const NEGATIVE_STOCK = new Set(["close", "differs", "wrong_ticker"]); // "unreadable" is vet402's limit, "market_closed" and reference_* are no verdict

function hostOf(u: string | null): string | null {
  try {
    return u ? new URL(u).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Is this row negative for the seller? (Anything but delivered, not bought, or a neutral skip.) */
export function rowIsNegative(r: LaneRow): boolean {
  if (r.status === "settled_no_answer" || r.status === "not_settled" || r.status === "unconfirmed" || r.status === "refused") return true;
  if (r.cause && r.cause.cause !== "delivered" && r.cause.cause !== "not_paid") return true;
  if (r.facilitatorLead) return true;
  if (r.skipped && !NEUTRAL_SKIPS.some((x) => x.test(r.skipped!))) return true;
  return false;
}

/** The seller key of a row: the host of the bought listing, else of its only host. */
export function rowSeller(r: Pick<LaneRow, "resource" | "hosts">): string | null {
  return hostOf(r.resource) ?? (r.hosts.length === 1 ? r.hosts[0]! : null);
}

/**
 * Pure. The rule of data/records/: a negative result names a seller next to a failure, so it is published
 * only for sellers vet402 has told first (notified.json). Other negative rows keep their payTo and hosts,
 * and lose status detail, cause, fix, tx, lead and skip reason.
 */
export function withholdUnnotified(l: LanePublic, notified: ReadonlySet<string>): LanePublic {
  const told = (seller: string | null) => seller !== null && notified.has(seller);
  const rows = l.rows.map((r): LaneRow =>
    !rowIsNegative(r) || told(rowSeller(r))
      ? r
      : r.status === "not_bought_yet" || r.status === "not_offered_now" || r.status === "delivered"
        ? { ...r, facilitatorLead: null, skipped: null } // not bought, or delivered: only the lead or skip text goes
        : { ...r, status: "withheld", cause: null, settlementTx: null, paidRequestMs: null, relayer: null, facilitatorLead: null, skipped: null },
  );
  const compare = l.compare
    ? Object.fromEntries(
        Object.entries(l.compare).map(([res, c]) => {
          const neg = c.status === "settled_no_answer" || c.status === "not_settled" || c.status === "unconfirmed" || c.status === "refused" || (c.cause !== null && c.cause.cause !== "delivered" && c.cause.cause !== "not_paid");
          return [res, neg && !told(hostOf(res)) ? { status: "withheld" as const, cause: null, settlementTx: null, paidRequestMs: null, relayer: null } : c];
        }),
      )
    : undefined;
  const stock = l.stock?.map((s) => (s.comparison && NEGATIVE_STOCK.has(s.comparison.verdict) && !told(hostOf(s.resource ?? null)) ? { ...s, comparison: null, withheld: true } : s));
  return { ...l, rows, ...(compare ? { compare } : {}), ...(stock ? { stock } : {}) };
}

/** Negative rows in a lane file for sellers not in notified.json (build-site stops on any). */
export function unpublishableRows(l: LanePublic, notified: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const r of l.rows) if (rowIsNegative(r) && !notified.has(rowSeller(r) ?? "")) out.push(`${l.lane}: ${r.payTo} (${r.status})`);
  for (const [res, c] of Object.entries(l.compare ?? {})) {
    const neg = c.status === "settled_no_answer" || c.status === "not_settled" || c.status === "unconfirmed" || c.status === "refused" || (c.cause !== null && c.cause.cause !== "delivered" && c.cause.cause !== "not_paid");
    if (neg && !notified.has(hostOf(res) ?? "")) out.push(`${l.lane}: Base side of ${res} (${c.status})`);
  }
  for (const s of l.stock ?? []) if (s.comparison && NEGATIVE_STOCK.has(s.comparison.verdict) && !notified.has(hostOf(s.resource ?? null) ?? "")) out.push(`${l.lane}: stock ${s.ticker} (${s.comparison.verdict})`);
  return out;
}

/**
 * One row per payTo. When vet402 bought, the row shows the listing it actually bought (resource, host, price),
 * which can differ from the planned one (the stock-price check buys the equity endpoint of a payTo whose
 * cheapest listing is another host), and how many of that payTo's purchases settled.
 */
function rowFrom(c: DryRunChoice, r: Rec | undefined, chainLabel: string, all: Rec[] = []): LaneRow {
  const paid = r?.outcome === "sent";
  const resource = paid ? r!.resource : (c.chosen?.resource ?? null);
  const boughtHost = paid ? hostOf(r!.resource) : null;
  const sentAll = all.filter((x) => x.outcome === "sent");
  return {
    payTo: c.payTo,
    hosts: boughtHost ? [boughtHost, ...c.hosts.filter((h) => h !== boughtHost)] : c.hosts,
    catalogListings: c.catalogListings,
    resource,
    livePrice: paid ? (r!.amountAtomic ?? null) : (c.chosen?.liveAmount ?? null),
    ...(sentAll.length > 1 ? { purchases: sentAll.length, settled: sentAll.filter((x) => x.settledOnChain === true).length } : {}),
    status: c.chosen || paid ? statusOf(r) : "not_offered_now",
    cause: paid ? r!.cause : null,
    settlementTx: paid ? (r!.settlementTx ?? null) : null,
    paidRequestMs: paid ? (r!.paidRequestMs ?? null) : null,
    relayer: paid ? (r!.relayer ?? null) : null,
    facilitatorLead: r?.predictedProblem ?? null,
    skipped: skipReason(c, chainLabel),
  };
}

/** Pure. `dry` is results/evm/<lane>-dryrun.json; `paid` the rows of results/evm/<lane(s)>-purchases.jsonl. */
export function buildLanePublic(lane: "robinhood" | "arbitrum", dry: Record<string, unknown>, paid: Rec[]): LanePublic {
  const sec = dry[lane] as { payTosInCatalogs: number; payTosWithLive402: number; choices: DryRunChoice[]; stockReferences?: StockReference[] };
  const chain = EVM_CHAINS[lane].caip2;
  const mine = paid.filter((p) => p.lane === lane);
  const last = (res: string | null, ln: string = lane): Rec | undefined => paid.filter((p) => p.lane === ln && p.resource === res && p.outcome === "sent").at(-1);
  // A payTo bought through another of its listings (the stock-price entries) still counts for its row.
  const byPayTo = (payTo: string): Rec | undefined => mine.filter((p) => p.outcome === "sent" && (p.payTo ?? "").toLowerCase() === payTo.toLowerCase()).at(-1);
  const ofPayTo = (payTo: string): Rec[] => mine.filter((p) => (p.payTo ?? "").toLowerCase() === payTo.toLowerCase() || (p.outcome !== "sent" && p.agentId === `payto:${payTo}`));
  const rows = sec.choices.map((c) => rowFrom(c, last(c.chosen?.resource ?? null) ?? byPayTo(c.payTo), EVM_CHAINS[lane].label, ofPayTo(c.payTo)));
  const out: LanePublic = {
    kind: "vet402-evm-lane",
    lane,
    chain,
    generatedAt: String(dry.generatedAt),
    source: mine.some((p) => p.outcome === "sent") ? "purchases" : "census",
    catalogs: dry.catalogs as LanePublic["catalogs"],
    payTosInCatalogs: sec.payTosInCatalogs,
    payTosOffered: sec.payTosWithLive402,
    rows,
  };
  if (lane === "arbitrum") {
    out.compare = {};
    for (const c of sec.choices) {
      if (!c.chosen) continue;
      const b = last(c.chosen.resource, "base-compare");
      const paidB = b?.outcome === "sent";
      out.compare[c.chosen.resource] = {
        status: statusOf(b),
        cause: paidB ? b!.cause : null,
        settlementTx: paidB ? (b!.settlementTx ?? null) : null,
        paidRequestMs: paidB ? (b!.paidRequestMs ?? null) : null,
        relayer: paidB ? (b!.relayer ?? null) : null,
      };
    }
  }
  if (sec.stockReferences) {
    out.stock = sec.stockReferences.map((ref) => {
      const p = mine.filter((x) => x.agentId === `stock:${ref.ticker}` && x.outcome === "sent").at(-1);
      const cmp = p?.stock && "deviationPct" in (p.stock as object) ? (p.stock as StockComparison) : null;
      return {
        ticker: ref.ticker,
        resource: p?.resource ?? STOCK_SELLER_RESOURCE,
        reference: { feed: ref.feed, token: ref.token, tokenPrice: ref.tokenPrice, sharePrice: ref.sharePrice, multiplier: ref.multiplier, updatedAt: ref.updatedAt, readAt: ref.readAt, stale: ref.stale, oraclePaused: ref.oraclePaused },
        comparison: cmp,
      };
    });
  }
  return out;
}

export function loadLanePublic(dataDir: string): { robinhood?: LanePublic; arbitrum?: LanePublic } {
  const out: { robinhood?: LanePublic; arbitrum?: LanePublic } = {};
  const nf = join(dataDir, "records", "notified.json");
  const notified = existsSync(nf) ? notifiedSellers(JSON.parse(readFileSync(nf, "utf8")) as NotifiedFile) : new Set<string>();
  for (const lane of ["robinhood", "arbitrum"] as const) {
    const f = join(dataDir, "evm", `${lane}.json`);
    if (!existsSync(f)) continue;
    const j = JSON.parse(readFileSync(f, "utf8")) as LanePublic;
    if (j.kind !== "vet402-evm-lane" || j.lane !== lane) throw new Error(`${f}: not a vet402 ${lane} lane file`);
    const bad = unpublishableRows(j, notified);
    if (bad.length) throw new Error(`${f}: negative results for sellers not in notified.json: ${bad.join("; ")}`);
    out[lane] = j;
  }
  return out;
}

// ---------- rendering ----------

const HEX_TX = /^0x[0-9a-fA-F]{64}$/;
function txLink(chain: EvmChainKey, tx: string | null): string {
  if (!tx || !HEX_TX.test(tx)) return "–";
  return `<a class="mono" href="${escapeHtml(EVM_CHAINS[chain].explorerTx + tx)}" rel="noopener noreferrer nofollow">${escapeHtml(tx.slice(0, 10))}…</a>`;
}
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const utc = (sec: number): string => new Date(sec * 1000).toISOString().replace(".000Z", "Z");
const STATUS_TEXT: Record<RowStatus, string> = {
  not_offered_now: "not bought",
  not_bought_yet: "not bought yet",
  refused: "vet402 did not pay",
  delivered: "settled on chain, came back",
  settled_no_answer: "settled on chain, no answer",
  not_settled: "sent; no settlement came back",
  unconfirmed: "sent; vet402 could not read the settlement back",
  withheld: "bought; the result is shown after the seller is told",
};

function money(atomic: string | null, symbol: string): string {
  return atomic === null ? "–" : `${atomicToUsdc(atomic).replace(/0{1,4}$/, "")} ${symbol}`;
}

const CAUSE_TEXT: Record<string, string> = {
  facilitator: "the seller's facilitator",
  seller_config: "the seller's setup",
  vet402: "vet402's payment",
  unconfirmed: "vet402 could not confirm the settlement",
  not_settled: "not settled; no side identified",
  unknown: "no clear cause",
};

function causeCell(c: CauseResult | null): string {
  if (!c || c.cause === "delivered" || c.cause === "not_paid") return "–";
  const lead = c.evidence === "supported_page" ? " (lead from the facilitator's /supported page)" : "";
  return `${escapeHtml(CAUSE_TEXT[c.cause] ?? c.cause)}${escapeHtml(lead)}${c.fix ? `<span class="sub">${escapeHtml(c.fix)}</span>` : ""}`;
}

function counts(l: LanePublic): string {
  const n = (s: RowStatus) => l.rows.filter((r) => r.status === s).length;
  const bought = n("delivered") + n("settled_no_answer") + n("not_settled") + n("withheld");
  return `<div class="stats">
  <div><span class="big">${l.payTosInCatalogs}</span><br>payTo addresses that the CDP, Dexter and PayAI catalogs list on ${escapeHtml(EVM_CHAINS[l.lane].label)}</div>
  <div><span class="big">${l.payTosOffered}</span><br>whose live 402 still offers it, read without paying</div>
  <div><span class="big">${bought}</span><br>bought by vet402</div>
  <div><span class="big">${n("delivered")}</span><br>paid, settled on chain and came back with an answer</div>
</div>`;
}

function sellerTable(l: LanePublic, withCompare: boolean): string {
  const spec = EVM_CHAINS[l.lane];
  const rows = l.rows
    .map((r) => {
      const cmp = withCompare && r.resource ? l.compare?.[r.resource] : undefined;
      const compareCells = withCompare ? `<td>${escapeHtml(cmp ? STATUS_TEXT[cmp.status] : "–")}${cmp?.settlementTx ? `<span class="sub">${txLink("base", cmp.settlementTx)}</span>` : ""}</td>` : "";
      const bought = hostOf(r.resource);
      const name = bought && r.status !== "not_bought_yet" && r.status !== "not_offered_now"
        ? `${escapeHtml(bought)}${r.hosts.length > 1 ? `<span class="sub">bought here; the same payTo also serves ${r.hosts.length - 1} other ${r.hosts.length === 2 ? "host" : "hosts"}</span>` : ""}`
        : `${escapeHtml(r.hosts.slice(0, 3).join(", "))}${r.hosts.length > 3 ? ` +${r.hosts.length - 3}` : ""}`;
      const many = r.purchases ? `<span class="sub">${r.purchases} purchases, ${r.settled ?? 0} settled on chain</span>` : "";
      return `<tr><td class="name">${name}<span class="sub mono">${escapeHtml(short(r.payTo))} · ${r.catalogListings} listed</span></td><td class="num">${escapeHtml(money(r.livePrice, spec.assetSymbol))}</td><td>${escapeHtml(STATUS_TEXT[r.status])}${many}${r.skipped ? `<span class="sub">${escapeHtml(r.skipped)}</span>` : ""}${r.settlementTx ? `<span class="sub">${txLink(l.lane, r.settlementTx)}${r.paidRequestMs !== null ? ` · ${(r.paidRequestMs / 1000).toFixed(1)} s` : ""}</span>` : ""}</td>${compareCells}<td>${causeCell(r.cause)}${!r.cause && r.facilitatorLead ? `<span class="sub">${escapeHtml(r.facilitatorLead)}</span>` : ""}</td></tr>`;
    })
    .join("\n");
  const head = withCompare ? `<th>seller</th><th class="num">price</th><th>Arbitrum One</th><th>Base, same listing</th><th>why not, and the fix</th>` : `<th>seller</th><th class="num">price</th><th>result</th><th>why not, and the fix</th>`;
  return `<table class="board"><thead><tr>${head}</tr></thead><tbody>\n${rows}\n</tbody></table>`;
}

function stockTable(l: LanePublic): string {
  const rows = (l.stock ?? [])
    .map((s) => {
      const r = s.reference;
      const c = s.comparison;
      const age = r.readAt - r.updatedAt;
      return `<tr><td class="name">${escapeHtml(s.ticker)}<span class="sub mono">feed ${escapeHtml(short(r.feed))}</span></td><td class="num">${r.sharePrice !== null ? `$${r.sharePrice.toFixed(2)}` : "–"}<span class="sub">token $${r.tokenPrice.toFixed(2)} · ×${r.multiplier !== null ? r.multiplier.toFixed(6) : "?"}</span></td><td class="num">${(age / 3600).toFixed(1)} h${r.stale ? " (stale)" : ""}${r.oraclePaused ? " (paused)" : ""}</td><td class="num">${s.withheld ? "bought" : c?.sellerPrice != null ? `$${c.sellerPrice.toFixed(2)}` : "not bought yet"}</td><td>${s.withheld ? "shown after the seller is told" : c ? `${escapeHtml(c.verdict.replace(/_/g, " "))}${c.deviationPct !== null ? ` (${c.deviationPct >= 0 ? "+" : ""}${c.deviationPct.toFixed(2)}%)` : ""}` : "–"}</td></tr>`;
    })
    .join("\n");
  const readAt = l.stock?.[0] ? utc(l.stock[0].reference.readAt) : "–";
  return `<table class="board"><caption>Reference read from Robinhood Chain at ${escapeHtml(readAt)}. Share price = Chainlink feed (the token price) ÷ the token's uiMultiplier().</caption><thead><tr><th>ticker</th><th class="num">share price</th><th class="num">feed age</th><th class="num">seller said</th><th>verdict</th></tr></thead><tbody>\n${rows}\n</tbody></table>`;
}

function limits(l: LanePublic): string {
  const lane = LANES[l.lane];
  return `<h2 id="money">How vet402 pays for this</h2>
<p>vet402 pays from one wallet, 0x9B59…4E51, the same on every EVM chain it buys on, with the seller's own x402 402: exact scheme, EIP-3009 transferWithAuthorization only (no Permit2, no approve), to the payTo the 402 named when vet402 planned the purchase, never more than that price. On this chain: at most ${escapeHtml(money(lane.maxPerAtomic.toString(), EVM_CHAINS[l.lane].assetSymbol))} a purchase, ${escapeHtml(money(lane.maxTotalAtomic.toString(), EVM_CHAINS[l.lane].assetSymbol))} in total and ${lane.maxCount} purchases, in a ledger of its own. The facilitator the seller chose submits the payment and pays its gas.</p>`;
}

function anchorSection(l: LanePublic): string {
  return `<h2 id="root">The daily record on ${escapeHtml(EVM_CHAINS[l.lane].label)}</h2>
<p>After each UTC day with purchases, vet402 writes one transaction on ${escapeHtml(EVM_CHAINS[l.lane].label)} from its wallet to itself. Its input data is the text <code>vet402-purchases/v0 chain=${escapeHtml(l.chain)} day=… root=… n=…</code>: the Merkle root of that day's purchase records (each leaf is keccak256 of one record's canonical JSON). Anyone holding a record can recompute its leaf and check it against the root on chain.</p>
${l.lane === "arbitrum" ? `<p class="meta">The same root can go to a contract, <a href="${escapeHtml(PUBLIC_REPO_URL)}/blob/main/contracts/src/DeliveryRoots.sol" rel="noopener noreferrer nofollow">DeliveryRoots.sol</a>, whose <code>verify(day, digest, proof)</code> lets another contract ask in one call whether vet402 recorded a purchase. It is tested, not deployed yet.</p>` : ""}`;
}

export function renderRobinhoodPage(r: RankReport, _g: GroupReport, l: LanePublic | undefined): string {
  const intro = `<p class="lead">Robinhood's developer docs ask apps that read Stock Token prices to "reject stale prices" and, when mixing a share price with a token price, to "apply currentMultiplier". vet402 buys stock prices that x402 sellers offer on Robinhood Chain, pays in USDG, and holds each answer to those checks against the Chainlink feed of that Stock Token.</p>`;
  const body = !l
    ? `<p class="dim">No Robinhood Chain data yet.</p>`
    : `<p class="dim">${l.source === "census" ? `Nothing bought yet. Read without paying on ${escapeHtml(l.generatedAt.slice(0, 10))}.` : `Updated ${escapeHtml(l.generatedAt.slice(0, 10))}.`}</p>
<h2 id="stock">Stock prices sold over x402, against the Chainlink feed</h2>
<p class="meta">Verdicts: agrees = within 0.5% of the share price (the feed's own deviation threshold), close = within 2%, differs = further. A feed older than its 24 h heartbeat, or a token whose oraclePaused() is true, gives no verdict. Outside the NYSE core session (9:30 a.m. to 4:00 p.m. ET on trading days) an answer more than 0.5% off is marked market closed, not held against the seller. A result that is not in the seller's favour is shown after vet402 has told that seller.</p>
${stockTable(l)}
<h2 id="sellers">Sellers that list Robinhood Chain: can they be paid there?</h2>
${counts(l)}
<p class="meta">One purchase per payTo, at the cheapest listing whose live 402 still offers Robinhood Chain in USDG. A purchase counts as settled only when vet402 reads the USDG transfer to that payTo back on chain; a payment that did not settle is never counted against the seller. A result that is not in the seller's favour is shown after vet402 has told that seller.</p>
${sellerTable(l, false)}
${anchorSection(l)}
${limits(l)}`;
  return publicPage(
    "vet402: Robinhood Chain",
    "x402 sellers on Robinhood Chain, bought with USDG: which ones can be paid there, and whether the stock prices they sell match the Chainlink feed.",
    `
${tabs("robinhood")}
<header>
<h1>Robinhood Chain: paid in USDG, checked against the feed</h1>
${intro}
<p class="dim">Method ${escapeHtml(r.method.version)} · <a href="${escapeHtml(PUBLIC_REPO_URL)}/blob/main/src/robinhood/stock-check.ts" rel="noopener noreferrer nofollow">the check, in code</a></p>
</header>
${body}
${publicFooter()}
`,
  );
}

export function renderArbitrumPage(r: RankReport, _g: GroupReport, l: LanePublic | undefined): string {
  const body = !l
    ? `<p class="dim">No Arbitrum data yet.</p>`
    : `<p class="dim">${l.source === "census" ? `Nothing bought yet. Read without paying on ${escapeHtml(l.generatedAt.slice(0, 10))}.` : `Updated ${escapeHtml(l.generatedAt.slice(0, 10))}.`}</p>
${counts(l)}
<p class="meta">Each row is one payTo that lists both Arbitrum One and Base with the same address. vet402 buys the same listing once on each chain, the same UTC day, from the same wallet, and reads each USDC transfer back on its chain. The fix column says what the seller can change when Arbitrum does not come back. A payment that did not settle is never counted against the seller, and a result that is not in the seller's favour is shown after vet402 has told that seller.</p>
${sellerTable(l, true)}
${anchorSection(l)}
${limits(l)}`;
  return publicPage(
    "vet402: Arbitrum One",
    "x402 sellers that list Arbitrum One, bought on Arbitrum and on Base: same seller, same payTo, only the chain differs.",
    `
${tabs("arbitrum")}
<header>
<h1>Arbitrum One: does the seller deliver when paid there?</h1>
<p class="lead">Many x402 sellers list Arbitrum One next to Base. vet402 pays the same seller on both chains and shows whether the Arbitrum payment settles and the answer comes back, and if not, why.</p>
<p class="dim">Method ${escapeHtml(r.method.version)}</p>
</header>
${body}
${publicFooter()}
`,
  );
}
