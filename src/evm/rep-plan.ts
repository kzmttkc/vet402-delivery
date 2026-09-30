/**
 * ERC-8004 feedback on EVM chains (Base, Tempo, Robinhood Chain, Arbitrum): which purchases may become
 * feedback, what it says, and every check before a write. Pure: no RPC, no file, no key.
 *
 * Same rules as the 8004-solana writer (src/solana-feedback/plan.ts), with the Base binding
 * (src/evm/base-candidates.ts): the agent is the one registered agent on that chain whose agentWallet is
 * the payTo vet402 paid. Owner-only matches and payTos with several such agents are not written.
 * Values: value 1 or 0 (delivered or not), valueDecimals 0, tags x402-delivery / delivered|paid-not-delivered,
 * no score. feedbackURI is the published vet402 record; feedbackHash is keccak256 of its bytes
 * (ERC-8004 names keccak256; 8004-solana names sha256 of the same bytes).
 */
import { isAddress } from "viem";
import { feedbackValues as solanaValues, outcomeOf, recordUri, VERDICT_FOR, type Outcome, type OutcomeSummary, type Purchase } from "../solana-feedback/plan.js";

export type RepChainKey = "base" | "tempo" | "robinhood" | "arbitrum";
export const REP_CHAIN_KEYS: readonly RepChainKey[] = ["base", "tempo", "robinhood", "arbitrum"];

/** At most this many feedback writes per chain in one run. */
export const MAX_WRITES_PER_RUN = 2;

export interface EvmPurchase extends Purchase {
  /** Atomic units of the payment token, as recorded; null when the input did not record it. */
  amountAtomic: string | null;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const lowerAddr = (v: unknown): string | null => (typeof v === "string" && isAddress(v, { strict: false }) ? v.toLowerCase() : null);
const lowerTx = (v: unknown): string | null => (typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v) ? v.toLowerCase() : null);
const hostOf = (u: string): string => new URL(u).host.toLowerCase();

function usdcToAtomic(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d+(\.\d{1,6})?$/.test(v)) return null;
  const [i, f = ""] = v.split(".");
  return (BigInt(i!) * 1_000_000n + BigInt(f.padEnd(6, "0"))).toString();
}

/**
 * vet402's EVM purchases from the data/ inputs, one shape. Only rows the payer sent; addresses and tx
 * hashes lowercased so a payTo groups as one seller.
 *  - base/purchases.jsonl lines (kind "base-purchases"): outcome sent, settledOnChain, delivered
 *  - tempo/ledger.json (version 1, entries): status sent
 *  - remeasure/<chain>-<day>.json (kind vet402-remeasure): outcome sent
 */
export function normalizeEvmPurchases(file: unknown, source: string, payer: string): EvmPurchase[] {
  const out: EvmPurchase[] = [];
  const p = payer.toLowerCase();
  const push = (x: { at: string | null; url: string | null; payTo: string | null; tx: string | null; settled: boolean; delivered: boolean; httpStatus: unknown; amountAtomic: string | null }) => {
    if (!x.at || !x.url || !x.payTo || !x.tx) return;
    out.push({ source, day: x.at.slice(0, 10), at: x.at, host: hostOf(x.url), url: x.url, payTo: x.payTo, tx: x.tx, settled: x.settled, delivered: x.delivered, httpStatus: typeof x.httpStatus === "number" ? x.httpStatus : null, amountAtomic: x.amountAtomic });
  };
  if (Array.isArray(file)) {
    for (const r of file as Row[]) {
      if (lowerAddr(r.payer) !== p) throw new Error(`${source}: payer ${String(r.payer)} is not ${payer}`);
      if (r.outcome !== "sent") continue;
      push({ at: str(r.at), url: str(r.resource), payTo: lowerAddr(r.payTo), tx: lowerTx(r.settlementTx), settled: r.settledOnChain === true, delivered: r.delivered === true, httpStatus: (r.response as Row | undefined)?.status, amountAtomic: str(r.amountAtomic) });
    }
    return out;
  }
  const f = file as { kind?: string; version?: number; payer?: string; entries?: Row[]; rows?: Row[] };
  if (lowerAddr(f.payer) !== p) throw new Error(`${source}: payer ${String(f.payer)} is not ${payer}`);
  if (f.kind === "vet402-remeasure") {
    for (const r of f.rows ?? []) {
      if (r.outcome !== "sent") continue;
      push({ at: str(r.at), url: str(r.url) ?? str(r.requestUrl), payTo: lowerAddr(r.payTo), tx: lowerTx(r.tx), settled: r.settled === true, delivered: r.delivered === true, httpStatus: r.httpStatus, amountAtomic: usdcToAtomic(r.priceUsdc) });
    }
  } else if (f.kind === undefined && f.version === 1 && Array.isArray(f.entries)) {
    for (const e of f.entries) {
      if (e.status !== "sent") continue;
      push({ at: str(e.reservedAt), url: str(e.url), payTo: lowerAddr(e.recipient), tx: lowerTx(e.txHash), settled: e.settled === true, delivered: e.delivered === true, httpStatus: e.httpStatus, amountAtomic: str(e.amount) });
    }
  } else throw new Error(`${source}: unknown input shape`);
  return out;
}

/** Group by payTo (lowercase), one row per tx, oldest first. */
export function groupEvmByPayTo(ps: EvmPurchase[]): Map<string, EvmPurchase[]> {
  const m = new Map<string, EvmPurchase[]>();
  const seen = new Set<string>();
  for (const x of ps) {
    if (seen.has(x.tx)) continue;
    seen.add(x.tx);
    m.set(x.payTo, [...(m.get(x.payTo) ?? []), x]);
  }
  for (const list of m.values()) list.sort((a, b) => a.at.localeCompare(b.at));
  return m;
}

export { outcomeOf, recordUri, VERDICT_FOR, type Outcome, type OutcomeSummary };

export interface EvmValues {
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
}

/** The same words as 8004-solana; ERC-8004 has no separate score, so value carries the fact. */
export function evmValues(o: Outcome): EvmValues {
  const v = solanaValues(o);
  return { value: v.value, valueDecimals: v.valueDecimals, tag1: v.tag1, tag2: v.tag2 };
}

/** One agent index entry: what the Identity registry says now. */
export interface AgentEntry {
  agentId: bigint;
  owner: string | null;
  agentWallet: string | null;
}

export interface AgentChoice {
  agentId: bigint | null;
  /** Agents whose agentWallet is the payTo. */
  byWallet: string[];
  /** Agents whose owner is the payTo (reported; not enough on its own). */
  byOwner: string[];
  detail: string;
}

const ZERO = "0x0000000000000000000000000000000000000000";

/** The agent to write to: exactly one agent with agentWallet == payTo. */
export function chooseEvmAgent(index: AgentEntry[], payTo: string): AgentChoice {
  const p = payTo.toLowerCase();
  const byWallet = index.filter((a) => a.agentWallet && a.agentWallet.toLowerCase() !== ZERO && a.agentWallet.toLowerCase() === p).map((a) => a.agentId.toString());
  const byOwner = index.filter((a) => a.owner?.toLowerCase() === p).map((a) => a.agentId.toString());
  if (byWallet.length === 1) return { agentId: BigInt(byWallet[0]!), byWallet, byOwner, detail: "the only agent whose agentWallet is the payTo" };
  if (byWallet.length > 1) return { agentId: null, byWallet, byOwner, detail: `${byWallet.length} agents have the payTo as agentWallet; which one sells this endpoint is not decided` };
  if (byOwner.length > 0) return { agentId: null, byWallet, byOwner, detail: "the payTo owns an agent but is not its agentWallet (owner match is not enough)" };
  return { agentId: null, byWallet, byOwner, detail: "no agent has the payTo as agentWallet" };
}

/** Everything read before a write. A null means "not checked", which also refuses. */
export interface EvmGateChecks {
  chain: RepChainKey;
  caip2: string;
  client: string;
  payTo: string;
  outcome: Outcome | null;
  agent: { agentId: bigint | null; agentWalletNow: string | null; clientIsOwnerOrOperator: boolean | null } | null;
  purchase: {
    tx: string;
    status: "success" | "reverted" | "missing";
    /** Receipt block is at or below the chain's finalized block. */
    finalized: boolean;
    /** Payment-token Transfer from the client to the payTo, of the recorded amount, found in the receipt. */
    transferMatches: boolean;
    detail: string;
  } | null;
  record: {
    id: string;
    published: boolean;
    fetchedOk: boolean | null;
    fetchedSha256: string | null;
    indexSha256: string | null;
    localSha256: string;
    paymentTx: string;
    payer: string;
    payTo: string;
    network: string;
    verdict: string;
    /** null = not checked (no agent to write to). */
    verifiesOffline: boolean | null;
  } | null;
  /** getLastIndex(agentId, client) on chain; null = not read. */
  lastIndexOnChain: bigint | null;
  inLedger: boolean;
}

const same = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** Every reason not to write. Empty means all gates pass. */
export function evmRefusals(c: EvmGateChecks): string[] {
  const r: string[] = [];
  if (!c.outcome) r.push("no single outcome to report");
  const a = c.agent;
  if (!a || a.agentId === null) r.push("no agent chosen");
  else {
    if (!same(a.agentWalletNow, c.payTo)) r.push(`agentWallet now ${a.agentWalletNow} is not the payTo ${c.payTo}`);
    if (a.clientIsOwnerOrOperator !== false) r.push("the writer owns or operates the agent, or it was not checked");
  }
  const p = c.purchase;
  if (!p) r.push("purchase tx not read");
  else {
    if (p.status !== "success") r.push(`purchase ${p.tx} is ${p.status} on chain`);
    if (!p.finalized) r.push(`purchase ${p.tx} is not finalized`);
    if (!p.transferMatches) r.push(`purchase ${p.tx}: ${p.detail}`);
  }
  const d = c.record;
  if (!d) r.push("no vet402 record of the purchase");
  else {
    if (!d.published) r.push(`record ${d.id} is not published`);
    else if (d.fetchedOk === null) r.push(`record ${d.id} not fetched`);
    else if (d.fetchedOk !== true) r.push(`record ${d.id} could not be fetched from its URI`);
    else if (d.fetchedSha256 !== d.localSha256 || d.indexSha256 !== d.localSha256) r.push(`record ${d.id}: fetched bytes, index and local file disagree`);
    if (p && !same(d.paymentTx, p.tx)) r.push(`record ${d.id} is not about the purchase checked on chain`);
    if (!same(d.payer, c.client) || !same(d.payTo, c.payTo)) r.push(`record ${d.id}: payer or payTo differs`);
    if (d.network !== c.caip2) r.push(`record ${d.id} is on ${d.network}, not ${c.caip2}`);
    if (!c.outcome || d.verdict !== VERDICT_FOR[c.outcome]) r.push(`record ${d.id}: verdict ${d.verdict} does not back the outcome`);
    if (d.verifiesOffline === null) r.push(`record ${d.id} not verified`);
    else if (!d.verifiesOffline) r.push(`record ${d.id} does not verify offline`);
  }
  if (c.lastIndexOnChain === null) {
    if (a?.agentId !== null && a?.agentId !== undefined) r.push("could not read earlier feedback from this address");
  } else if (c.lastIndexOnChain > 0n) r.push(`this address already has ${c.lastIndexOnChain} feedback on the agent`);
  if (c.inLedger) r.push("the ledger already has a write for this agent");
  return r;
}

/** Fee gate: the cost at the node's max fee, in the chain's fee unit, against the per-chain cap and the balance. */
export function feeRefusal(costAtMax: bigint | null, cap: bigint, balance: bigint | null): string | null {
  if (costAtMax === null) return "no fee estimate";
  if (costAtMax > cap) return `fee ${costAtMax} over the cap ${cap}`;
  if (balance === null) return "fee balance not read";
  if (balance < costAtMax * 2n) return `fee balance ${balance} below twice the fee ${costAtMax}`;
  return null;
}

/** Tempo prices gas in attodollars; a TIP-20 fee is ceil(gas * price / 1e12) microdollars (tempo fee spec). */
export function tempoFeeAtomic(gas: bigint, attodollarsPerGas: bigint): bigint {
  const n = gas * attodollarsPerGas;
  return (n + 999_999_999_999n) / 1_000_000_000_000n;
}
