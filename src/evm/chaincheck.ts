/**
 * The post-run chain check for the EVM lanes (Arbitrum One, Robinhood Chain, and the Base side of Arbitrum):
 * whether a purchase settled is read from the chain, never from the seller's settlement header.
 *
 * Same idea as the Solana and Tempo checks (../chaincheck.ts): every token transfer out of the payer in the
 * run's time is read from Transfer logs, and each purchase gets the transfer that is its own:
 *   1. nonce               the token's AuthorizationUsed(payer, nonce) event carries the EIP-3009 nonce vet402
 *                          signed for this purchase (recorded since 2026-10-01): exact, one to one
 *   2. named_tx            the tx the seller named in PAYMENT-RESPONSE moved the price from the payer to the payTo
 *   3. payto_amount_window the rules of ../chaincheck.ts checkOutflows: the payTo and the price match, the block
 *                          time is inside the authorization's validity window, and exactly one purchase fits
 * A purchase with no fitting transfer in its window is "no_transfer": nothing left the payer for it. One that
 * fits a transfer another purchase could also own is "ambiguous" and is not decided here.
 *
 * Why: on 2026-09-30 two Arbitrum purchases (x402-bazaar-rank, 0x8e885499…; x402.quickintel.io, 0x78140ce1…)
 * settled on chain while the records said not settled: one answer carried no PAYMENT-RESPONSE, the other one
 * that said success without a transaction.
 *
 * The window: an EIP-3009 authorization can only be executed while block.timestamp < validBefore, and vet402
 * signs validBefore at most MAX_TIMEOUT_SECONDS after it starts a purchase. Old rows without the authorization
 * use `at` + MAX_TIMEOUT_SECONDS + 5 s.
 */
import { parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { checkOutflows, type Candidate, type OutTx, type Unmatched } from "../chaincheck.js";
import type { EvmChainSpec } from "./chains.js";
import { MAX_TIMEOUT_SECONDS, type ChainBuyRecord, type ChainCheckNote } from "./evm-buy.js";

/** One transaction that moved the payer's token out: its transfers and the payer's EIP-3009 nonces used in it. */
export interface EvmOutTx extends OutTx {
  nonces: string[];
}

export interface EvmCheckSummary {
  checkedAt: string;
  from: string;
  to: string;
  /** Transactions that moved the payer's token out in the read range. */
  txs: number;
  /** Purchases whose settlement this check found on chain and the record did not have. */
  added: { key: string; tx: string; by: ChainCheckNote["by"] }[];
  /** Purchases the record called settled-unknown or not settled, and the chain shows nothing for. */
  noTransfer: string[];
  ambiguous: string[];
  /** Windows still open when the chain was read. */
  pending: string[];
  /** Transfers out of the payer that no purchase of this lane owns (another lane, a refund, or a mistake). */
  unmatched: Unmatched[];
}

const norm = (s: string) => s.toLowerCase();
const HEX_TX = /^0x[0-9a-fA-F]{64}$/;

/** Identity of a purchase record across the purchases, reverify and chain-check files. */
export function recordKey(r: Pick<ChainBuyRecord, "agentId" | "at" | "resource"> & { lane?: string }): string {
  return `${r.lane ?? ""}|${r.agentId}|${r.at}|${r.resource}`;
}

/** Pure. One record per purchase (recordKey), in first-seen order; a later line for the same purchase replaces it. */
export function mergeReadings<T extends Pick<ChainBuyRecord, "agentId" | "at" | "resource"> & { lane?: string }>(rows: readonly T[]): T[] {
  const by = new Map<string, T>();
  for (const r of rows) by.set(recordKey(r), r);
  return [...by.values()];
}

/** Pure. Sent purchases whose settlement the chain check has not decided (a receipt read at purchase time counts). */
export function uncheckedPurchases(rows: readonly (ChainBuyRecord & { lane?: string })[]): string[] {
  return rows.filter((r) => r.outcome === "sent" && r.settledOnChain !== true && (!r.chainCheck || r.chainCheck.result === "pending")).map((r) => `${r.lane ?? ""} ${r.resource}`);
}

/** [from, to) in ms during which this purchase's authorization could have settled. */
export function settleWindow(r: Pick<ChainBuyRecord, "at" | "authorization">): { fromMs: number; toMs: number } {
  const fromMs = Math.floor(Date.parse(r.at) / 1000) * 1000;
  const vb = r.authorization?.validBefore;
  const toMs = vb && /^\d{1,12}$/.test(vb) ? Number(vb) * 1000 : fromMs + (MAX_TIMEOUT_SECONDS + 5) * 1000;
  return { fromMs, toMs };
}

/** Pure. The read range that covers every sent record's window. */
export function readRange(records: readonly ChainBuyRecord[]): { fromMs: number; toMs: number } | null {
  const ws = records.filter((r) => r.outcome === "sent").map(settleWindow);
  if (!ws.length) return null;
  return { fromMs: Math.min(...ws.map((w) => w.fromMs)), toMs: Math.max(...ws.map((w) => w.toMs)) };
}

function answered(r: ChainBuyRecord): boolean {
  const s = r.response?.status ?? null;
  return s !== null && s >= 200 && s < 300 && ((r.response?.bytes ?? 0) > 0 || (r.response?.first300 ?? "").trim().length > 0);
}

function fits(t: EvmOutTx, r: ChainBuyRecord): boolean {
  return t.transfers.some((x) => norm(x.to) === norm(r.payTo!) && x.amount === BigInt(r.amountAtomic!));
}

/**
 * Pure. Each sent record of one lane, read against the transfers out of the payer (`txs`, read over at least
 * readRange(records)). Records come back in the same order; only sent records change.
 */
export function chainCheckRecords<T extends ChainBuyRecord>(
  records: readonly T[],
  txs: readonly EvmOutTx[],
  o: { payer: string; checkedAt: string; /** The chain was read up to this time; a window still open then is not decided. */ readToMs?: number },
): { records: T[]; summary: EvmCheckSummary } {
  const out = records.map((r) => ({ ...r }));
  const idx = out.map((r, i) => ({ r, i })).filter(({ r }) => r.outcome === "sent" && !!r.payTo && !!r.amountAtomic && /^\d+$/.test(r.amountAtomic));
  const byTx = new Map(txs.map((t) => [norm(t.tx), t]));
  const owner = new Map<string, number>(); // tx -> record index
  const found = new Map<number, { tx: string; by: ChainCheckNote["by"] }>();
  const claim = (i: number, tx: string, by: ChainCheckNote["by"]) => {
    owner.set(norm(tx), i);
    found.set(i, { tx, by });
  };
  const inWindow = (t: EvmOutTx, r: ChainBuyRecord) => {
    const w = settleWindow(r);
    return w.fromMs <= t.timeMs && t.timeMs < w.toMs;
  };

  // 0. Settled at purchase time on the receipt of the tx the seller named: that tx is this record's.
  for (const { r, i } of idx) if (r.settledOnChain === true && r.settlementTx && HEX_TX.test(r.settlementTx)) claim(i, r.settlementTx, byTx.has(norm(r.settlementTx)) ? "named_tx" : "receipt");
  // 1. The nonce vet402 signed.
  for (const { r, i } of idx) {
    if (found.has(i) || !r.authorization?.nonce) continue;
    const t = txs.find((x) => x.nonces.some((n) => norm(n) === norm(r.authorization!.nonce)) && fits(x, r) && !owner.has(norm(x.tx)));
    if (t) claim(i, t.tx, "nonce");
  }
  // 2. The tx the seller named, when it moved the price from the payer to the payTo inside the window.
  for (const { r, i } of idx) {
    if (found.has(i) || !r.settlementTx || !HEX_TX.test(r.settlementTx)) continue;
    const t = byTx.get(norm(r.settlementTx));
    if (t && fits(t, r) && inWindow(t, r) && !owner.has(norm(t.tx))) claim(i, t.tx, "named_tx");
  }
  // 3. payTo + price + window, only when exactly one purchase can own the transfer. A record that has its
  // nonce is decided by step 1 alone (its transfer would carry its nonce).
  const open = idx.filter(({ r, i }) => !found.has(i) && !r.authorization?.nonce);
  const candidates: Candidate[] = open.map(({ r, i }) => ({ id: String(i), payTo: r.payTo!, amount: BigInt(r.amountAtomic!), ...settleWindow(r) }));
  const res = checkOutflows({
    txs,
    known: owner.keys(),
    books: [[...owner.keys()]],
    candidates: candidates.map((c) => ({ ...c, toMs: c.toMs - 1 })),
    norm,
  });
  for (const m of res.matched) claim(Number(m.id), m.tx, "payto_amount_window");

  const summary: EvmCheckSummary = { checkedAt: o.checkedAt, from: "", to: "", txs: txs.length, added: [], noTransfer: [], ambiguous: [], pending: [], unmatched: [] };
  const range = readRange(out);
  if (range) {
    summary.from = new Date(range.fromMs).toISOString();
    summary.to = new Date(range.toMs).toISOString();
  }
  for (const { r, i } of idx) {
    // Rows from before 2026-10-01 did not keep the raw header: say so, with what the record does show.
    if (!r.paymentResponseHeader && r.response) {
      const s = r.settleResponse;
      out[i]!.paymentResponseHeader = { present: "not_recorded", decoded: s !== undefined && s !== null, namedTx: !!s && typeof s.transaction === "string" && HEX_TX.test(s.transaction) };
    }
    const w = settleWindow(r);
    const note = (result: ChainCheckNote["result"], by: ChainCheckNote["by"], tx: string | null): ChainCheckNote => ({
      checkedAt: o.checkedAt,
      result,
      by,
      tx,
      windowFrom: new Date(w.fromMs).toISOString(),
      windowTo: new Date(w.toMs).toISOString(),
    });
    const f = found.get(i);
    const rec = out[i]!;
    if (f) {
      const was = r.settledOnChain === true;
      rec.chainCheck = note("transfer_found", f.by, f.tx);
      if (!was) {
        rec.settledOnChain = true;
        rec.settlementTx = f.tx;
        rec.settlementCheck = `transfer ${o.payer} -> ${r.payTo} ${r.amountAtomic} (read on chain by the chain check: ${f.by})`;
        rec.delivered = answered(r);
        summary.added.push({ key: recordKey(r), tx: f.tx, by: f.by });
      }
      continue;
    }
    // Not found, and its window was still open when the chain was read: a settlement can still land.
    if (o.readToMs !== undefined && w.toMs > o.readToMs) {
      rec.chainCheck = note("pending", null, null);
      summary.pending.push(recordKey(r));
      continue;
    }
    // Not found: does any transfer that no purchase owns fit it? Then it is not decided here.
    const fitting = txs.filter((t) => !owner.has(norm(t.tx)) && inWindow(t, r) && fits(t, r));
    if (fitting.length) {
      rec.chainCheck = note("ambiguous", null, null);
      summary.ambiguous.push(recordKey(r));
      continue;
    }
    rec.chainCheck = note("no_transfer", null, null);
    rec.settledOnChain = false;
    rec.delivered = false;
    // A tx the seller named that moved nothing of the payer's to the payTo, or one vet402 could not read back.
    if (r.settlementTx && !String(r.settlementCheck ?? "").startsWith("not verified: no_usdc_transfer_to_seller") && !String(r.settlementCheck ?? "").startsWith("not verified: amount_mismatch") && !String(r.settlementCheck ?? "").startsWith("not verified: tx_status_")) {
      rec.settlementCheck = "not verified: no_transfer_on_chain";
    }
    summary.noTransfer.push(recordKey(r));
  }
  summary.unmatched = txs
    .filter((t) => !owner.has(norm(t.tx)))
    .map((t) => ({ tx: t.tx, time: new Date(t.timeMs).toISOString(), transfers: t.transfers.map((x) => ({ to: x.to, amount: x.amount.toString() })), candidates: [], reason: "no purchase of this lane owns this transfer" }));
  return { records: out, summary };
}

// ---------- the chain read ----------

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const AUTH_USED = parseAbiItem("event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)");

type LogClient = Pick<PublicClient, "getBlockNumber" | "getBlock" | "getLogs">;

async function firstBlockAtOrAfter(tsSec: bigint, head: bigint, tsOf: (b: bigint) => Promise<bigint>): Promise<bigint> {
  let a = 0n;
  let b = head;
  if ((await tsOf(b)) < tsSec) return head + 1n;
  if ((await tsOf(a)) >= tsSec) return a;
  while (b - a > 1n) {
    const m = (a + b) / 2n;
    if ((await tsOf(m)) >= tsSec) b = m;
    else a = m;
  }
  return b;
}

/**
 * Every transaction in [fromMs, toMs] that moved the chain's token out of `payer`, with the payer's
 * AuthorizationUsed nonces in it. Read-only (eth_getLogs, eth_getBlockByNumber).
 */
export async function readEvmOutflows(c: LogClient, spec: Pick<EvmChainSpec, "asset">, payer: Address, fromMs: number, toMs: number, chunk = 10_000n): Promise<EvmOutTx[]> {
  const ts = new Map<bigint, bigint>();
  const tsOf = async (n: bigint) => {
    let t = ts.get(n);
    if (t === undefined) {
      t = (await c.getBlock({ blockNumber: n })).timestamp;
      ts.set(n, t);
    }
    return t;
  };
  const head = await c.getBlockNumber();
  const from = await firstBlockAtOrAfter(BigInt(Math.floor(fromMs / 1000)), head, tsOf);
  const to = (await firstBlockAtOrAfter(BigInt(Math.floor(toMs / 1000)) + 1n, head, tsOf)) - 1n;
  const byTx = new Map<string, EvmOutTx & { block: bigint }>();
  const get = (tx: Hex, block: bigint) => {
    let o = byTx.get(norm(tx));
    if (!o) {
      o = { tx, timeMs: 0, transfers: [], nonces: [], block };
      byTx.set(norm(tx), o);
    }
    return o;
  };
  for (let s = from; s <= to; s += chunk) {
    const e = s + chunk - 1n > to ? to : s + chunk - 1n;
    const [transfers, auths] = await Promise.all([
      c.getLogs({ address: spec.asset, event: TRANSFER, args: { from: payer }, fromBlock: s, toBlock: e }),
      c.getLogs({ address: spec.asset, event: AUTH_USED, args: { authorizer: payer }, fromBlock: s, toBlock: e }),
    ]);
    for (const l of transfers) get(l.transactionHash!, l.blockNumber!).transfers.push({ to: l.args.to!, amount: l.args.value! });
    for (const l of auths) get(l.transactionHash!, l.blockNumber!).nonces.push(l.args.nonce!);
  }
  const out: EvmOutTx[] = [];
  for (const o of byTx.values()) {
    if (!o.transfers.length) continue; // a nonce used without a transfer out of the payer: nothing moved
    out.push({ tx: o.tx, timeMs: Number(await tsOf(o.block)) * 1000, transfers: o.transfers, nonces: o.nonces });
  }
  return out.sort((a, b) => a.timeMs - b.timeMs);
}
