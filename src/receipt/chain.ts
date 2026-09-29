/**
 * Read-only chain checks for an observation. Nothing here signs or sends.
 *  - Solana: the transaction is confirmed without error and moved exactly `amount` USDC from payer to payTo
 *  - EVM (Base, Tempo): the receipt has status 1 and an ERC-20/TIP-20 Transfer(payer -> payTo, amount)
 *    emitted by `asset`
 *  - anchor: the anchor transaction succeeded, was paid and signed by vet402's anchor wallet
 *    (VET402_ANCHOR_SIGNERS), and its memo carries the record's day, root, count, sequence range and
 *    observer. A memo from any other wallet is not an anchor, whatever it says.
 *  - day lookup: vet402's anchor memo for a given day, found by reading the anchor wallet's history
 */
import { jsonRpc, readTransaction, type Rpc } from "../chain.js";
import { MEMO_PROGRAM } from "../constants.js";
import { parseAnchorMemo } from "./merkle.js";
import { VET402_ANCHOR_SIGNERS } from "./observers.js";
import type { Observation } from "./types.js";

export const DEFAULT_RPC: Record<string, string> = {
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  "eip155:8453": process.env.BASE_RPC_URL ?? "https://mainnet.base.org",
  "eip155:4217": process.env.TEMPO_RPC_URL ?? "https://rpc.tempo.xyz",
};

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export interface ChainResult {
  ok: boolean;
  detail: string;
}

function topicAddr(addr: string): string {
  return `0x${addr.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
}

interface EvmLog {
  address: string;
  topics: string[];
  data: string;
}

export async function checkEvmPayment(rpc: Rpc, o: Observation): Promise<ChainResult> {
  const r = (await rpc("eth_getTransactionReceipt", [o.payment.transaction])) as { status: string; logs: EvmLog[]; blockNumber: string } | null;
  if (!r) return { ok: false, detail: "transaction not found" };
  if (r.status !== "0x1") return { ok: false, detail: `transaction status ${r.status}` };
  const hit = r.logs.find(
    (l) =>
      l.address.toLowerCase() === o.payment.asset.toLowerCase() &&
      l.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
      l.topics[1]?.toLowerCase() === topicAddr(o.payment.payer) &&
      l.topics[2]?.toLowerCase() === topicAddr(o.payment.payTo) &&
      BigInt(l.data) === BigInt(o.payment.amount),
  );
  return hit
    ? { ok: true, detail: `Transfer ${o.payment.amount} ${o.payment.assetSymbol} ${o.payment.payer} -> ${o.payment.payTo} in block ${BigInt(r.blockNumber)}` }
    : { ok: false, detail: "no Transfer(payer -> payTo, amount) from the asset contract in this transaction" };
}

export async function checkSolanaPayment(rpc: Rpc, o: Observation): Promise<ChainResult> {
  const tx = await readTransaction(rpc, o.payment.transaction, o.payment.payer, o.payment.payTo);
  if (!tx.found) return { ok: false, detail: "transaction not found" };
  if (tx.err !== null) return { ok: false, detail: `transaction failed: ${JSON.stringify(tx.err)}` };
  const ok = tx.payToDeltaAtomic === o.payment.amount && tx.payerDeltaAtomic === `-${o.payment.amount}`;
  return ok
    ? { ok: true, detail: `USDC ${o.payment.amount} ${o.payment.payer} -> ${o.payment.payTo} (payTo +${tx.payToDeltaAtomic}, payer ${tx.payerDeltaAtomic})` }
    : { ok: false, detail: `USDC deltas payTo ${tx.payToDeltaAtomic}, payer ${tx.payerDeltaAtomic}; expected +/-${o.payment.amount}` };
}

export async function checkPayment(o: Observation, rpcFor: (network: string) => Rpc = (n) => jsonRpc(DEFAULT_RPC[n] ?? "")): Promise<ChainResult> {
  if (!DEFAULT_RPC[o.payment.network]) return { ok: false, detail: `no RPC known for ${o.payment.network}` };
  const rpc = rpcFor(o.payment.network);
  return o.payment.network.startsWith("solana:") ? checkSolanaPayment(rpc, o) : checkEvmPayment(rpc, o);
}

type ParsedAnchorTx = {
  blockTime?: number | null;
  meta: { err: unknown } | null;
  transaction: {
    message: {
      accountKeys: ({ pubkey: string; signer?: boolean } | string)[];
      instructions: { programId: string; parsed?: unknown }[];
    };
  };
};

export interface AnchorTxCheck {
  ok: boolean;
  detail: string;
  memo: ReturnType<typeof parseAnchorMemo>;
  feePayer: string | null;
  blockTime: number | null;
}

/** Read one transaction and say whether it is a vet402 anchor: succeeded, fee payer and signer in `signers`, one x402-observation memo. */
export async function readAnchorTx(rpc: Rpc, signature: string, signers: readonly string[] = VET402_ANCHOR_SIGNERS): Promise<AnchorTxCheck> {
  const tx = (await rpc("getTransaction", [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }])) as ParsedAnchorTx | null;
  const none = { memo: null, feePayer: null, blockTime: null };
  if (!tx) return { ok: false, detail: "anchor transaction not found", ...none };
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === "string" ? { pubkey: k, signer: undefined } : k));
  const feePayer = keys[0]?.pubkey ?? null;
  const blockTime = tx.blockTime ?? null;
  if (tx.meta?.err !== null && tx.meta?.err !== undefined) return { ok: false, detail: `anchor transaction failed: ${JSON.stringify(tx.meta.err)}`, memo: null, feePayer, blockTime };
  if (!tx.meta) return { ok: false, detail: "anchor transaction has no status", memo: null, feePayer, blockTime };
  if (!feePayer || !signers.includes(feePayer) || keys[0]!.signer === false)
    return { ok: false, detail: `memo sent by ${feePayer}, not by vet402's anchor wallet ${signers.join(", ")}; not an anchor`, memo: null, feePayer, blockTime };
  const memos = tx.transaction.message.instructions
    .filter((i) => i.programId === MEMO_PROGRAM && typeof i.parsed === "string")
    .map((i) => parseAnchorMemo(i.parsed as string))
    .filter((m): m is NonNullable<typeof m> => m !== null);
  if (memos.length !== 1) return { ok: false, detail: `${memos.length} x402-observation memos in the transaction (expected 1)`, memo: null, feePayer, blockTime };
  return { ok: true, detail: `memo from ${feePayer}`, memo: memos[0]!, feePayer, blockTime };
}

export function memoMatches(m: NonNullable<AnchorTxCheck["memo"]>, a: NonNullable<Observation["anchor"]>): string | null {
  if (m.day !== a.day) return `memo day ${m.day} is not ${a.day}`;
  if (m.root.toLowerCase() !== a.root.toLowerCase()) return `memo root ${m.root} does not match ${a.root}`;
  if (m.observer.toLowerCase() !== a.observerAddress.toLowerCase()) return `memo observer ${m.observer} is not ${a.observerAddress}`;
  if (m.count !== a.count || m.seq[0] !== a.sequenceRange[0] || m.seq[1] !== a.sequenceRange[1]) return `memo n=${m.count} seq=${m.seq.join("-")} differs from the record's root (n=${a.count} seq=${a.sequenceRange.join("-")})`;
  return null;
}

export async function checkAnchorOnChain(
  o: Observation,
  rpcFor: (network: string) => Rpc = (n) => jsonRpc(DEFAULT_RPC[n] ?? ""),
  signers: readonly string[] = VET402_ANCHOR_SIGNERS,
): Promise<ChainResult | null> {
  const a = o.anchor;
  if (!a || a.status !== "anchored" || !a.tx) return null;
  if (!a.network.startsWith("solana:")) return { ok: false, detail: `anchor on ${a.network} not supported by this script` };
  const t = await readAnchorTx(rpcFor(a.network), a.tx, signers);
  if (!t.ok || !t.memo) return { ok: false, detail: t.detail };
  const bad = memoMatches(t.memo, a);
  return bad ? { ok: false, detail: bad } : { ok: true, detail: `memo from vet402's anchor wallet ${t.feePayer} holds root ${t.memo.root} for ${t.memo.day}, n=${t.memo.count}` };
}

export interface DayAnchorLookup {
  /** vet402 anchor transactions whose memo names `day` (checked with readAnchorTx). */
  found: { signature: string; memo: NonNullable<AnchorTxCheck["memo"]>; blockTime: number | null }[];
  /** false = the history was not read far enough back to be sure nothing else is there. */
  complete: boolean;
  pagesRead: number;
}

/**
 * Every successful memo transaction from vet402's anchor wallet that names `day`. Reads the wallet's
 * history newest first, 1,000 signatures a page, until it passes the start of `day` (a day's root is
 * only written after the day ends) or the history ends. `complete: false` when `maxPages` ran out first.
 */
export async function findDayAnchors(rpc: Rpc, day: string, signer: string = VET402_ANCHOR_SIGNERS[0]!, maxPages = 20): Promise<DayAnchorLookup> {
  const dayStart = Date.parse(`${day}T00:00:00Z`) / 1000;
  const found: DayAnchorLookup["found"] = [];
  let before: string | undefined;
  for (let page = 1; page <= maxPages; page++) {
    const sigs = (await rpc("getSignaturesForAddress", [signer, { limit: 1000, commitment: "confirmed", ...(before ? { before } : {}) }])) as {
      signature: string;
      err: unknown;
      memo: string | null;
      blockTime: number | null;
    }[];
    for (const s of sigs) {
      if (s.err !== null || !s.memo || !s.memo.includes(`day=${day} `)) continue;
      const t = await readAnchorTx(rpc, s.signature, [signer]);
      if (t.ok && t.memo && t.memo.day === day) found.push({ signature: s.signature, memo: t.memo, blockTime: t.blockTime });
    }
    const last = sigs[sigs.length - 1];
    if (sigs.length < 1000 || (last?.blockTime !== null && last?.blockTime !== undefined && last.blockTime < dayStart)) return { found, complete: true, pagesRead: page };
    before = last!.signature;
  }
  return { found, complete: false, pagesRead: maxPages };
}
