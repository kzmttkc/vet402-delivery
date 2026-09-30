/**
 * The day's root, also written on Tempo: one TIP-20 transferWithMemo of 1 atomic USDC.e (0.000001) from
 * vet402's Tempo anchor key to vet402's observer address, with the 32-byte root as the memo. The Solana
 * memo stays the anchor of record (it names the day, the count and the sequence range); the Tempo memo
 * holds the same root, so a reader can check the root on a second chain.
 *
 * The signed records are never rewritten for it: the Tempo tx goes into the records index
 * (data/records/index.json, days[].tempoAnchor), and a record's bytes, sha256 and schema stay as they are.
 *
 * TIP-20 memo: https://tempo.xyz/developers/docs/guide/payments/transfer-memos (32-byte memo, emitted in
 * the indexed `TransferWithMemo` event). Fees in USDC.e: fee = ceil(base_fee * gas_used / 10^12)
 * (https://tempo.xyz/developers/docs/protocol/fees/spec-fee).
 *
 * This file builds and checks; it reads the chain but never signs or sends.
 */
import { decodeFunctionData, encodeFunctionData, type Hex } from "viem";
import { Abis, Transaction } from "viem/tempo";
import type { Rpc } from "../chain.js";
import { TEMPO_MAINNET_CAIP2, TEMPO_MAINNET_CHAIN_ID, USDC_E, normAddr } from "../tempo/constants.js";
import { VET402_TEMPO_ANCHOR_RECIPIENT, VET402_TEMPO_ANCHOR_SENDERS } from "./observers.js";


export const TEMPO_ANCHOR_NETWORK = TEMPO_MAINNET_CAIP2;
export const TEMPO_ANCHOR_METHOD = "tip20-transferWithMemo" as const;
/** 1 atomic USDC.e. */
export const TEMPO_ANCHOR_AMOUNT = 1n;
/** Nothing is signed when the fee could exceed this (atomic USDC.e, 0.02). About 0.54M gas (read 2026-09-30), more on the key's first transaction: 0.0005 at the base-fee floor. */
export const MAX_TEMPO_ANCHOR_FEE_ATOMIC = 20_000n;
/** Tempo's base-fee cap, attodollars per gas: the fee can never be priced above it. */
export const TEMPO_BASE_FEE_CAP = 12_000_000_000n;
/** Head when the Tempo anchor was added (2026-09-30). No vet402 Tempo anchor can be older. */
export const TEMPO_ANCHOR_START_BLOCK = 41_899_000n;
const LOG_RANGE = 99_999n;

export const TRANSFER_WITH_MEMO_TOPIC = "0x57bc7354aa85aed339e000bccffabbc529466af35f0772c8f8ee1145927de7f0";

const topicAddr = (a: string) => `0x${a.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
const isRoot = (r: string) => /^0x[0-9a-fA-F]{64}$/.test(r);

/** The one call of the anchor transaction. */
export function anchorCall(root: string, recipient: string = VET402_TEMPO_ANCHOR_RECIPIENT): { to: Hex; data: Hex } {
  if (!isRoot(root)) throw new Error(`root ${root} is not 32 bytes`);
  return { to: USDC_E as Hex, data: encodeFunctionData({ abi: Abis.tip20, functionName: "transferWithMemo", args: [recipient as Hex, TEMPO_ANCHOR_AMOUNT, root as Hex] }) };
}

/** Worst-case fee in atomic USDC.e for a gas limit priced at `maxFeePerGas` attodollars. */
export function maxFeeAtomic(gas: bigint, maxFeePerGas: bigint): bigint {
  return (gas * maxFeePerGas + 999_999_999_999n) / 1_000_000_000_000n;
}

/**
 * Decode a signed anchor transaction and refuse anything but the anchor: Tempo mainnet, from the
 * sender, one call, to USDC.e, transferWithMemo(recipient, 1, root), no value, the fee in USDC.e, no
 * fee payer, no key authorization, no authorization list, and a fee bound within the cap.
 */
export function anchorTxProblem(serialized: string, exp: { sender: string; root: string; recipient?: string; nonce?: number }): string | null {
  if (!/^0x76[0-9a-fA-F]+$/.test(serialized)) return "not a self-paid Tempo (0x76) transaction";
  let tx: Record<string, unknown>;
  try {
    tx = Transaction.deserialize(serialized as `0x76${string}`) as Record<string, unknown>;
  } catch (e) {
    return `undecodable: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (tx.chainId !== TEMPO_MAINNET_CHAIN_ID) return `chainId ${String(tx.chainId)} is not ${TEMPO_MAINNET_CHAIN_ID}`;
  if (normAddr(tx.from) !== normAddr(exp.sender)) return `signer ${String(tx.from)} is not the anchor key ${exp.sender}`;
  if ((tx.signature as { type?: string } | undefined)?.type !== "secp256k1") return "not a plain secp256k1 signature";
  if (exp.nonce !== undefined && Number(tx.nonce) !== exp.nonce) return `nonce ${String(tx.nonce)} is not ${exp.nonce}`;
  const calls = tx.calls as { to?: string; data?: Hex; value?: bigint }[] | undefined;
  if (!Array.isArray(calls) || calls.length !== 1) return `expected 1 call, got ${Array.isArray(calls) ? calls.length : "none"}`;
  const c = calls[0]!;
  if (normAddr(c.to) !== USDC_E) return `call target ${String(c.to)} is not USDC.e`;
  if (c.value !== undefined && c.value !== 0n) return "call carries value";
  if (!c.data) return "call has no data";
  let d: { functionName: string; args?: readonly unknown[] };
  try {
    d = decodeFunctionData({ abi: Abis.tip20, data: c.data }) as typeof d;
  } catch {
    return "call data is not a TIP-20 function";
  }
  if (d.functionName !== "transferWithMemo") return `function ${d.functionName} is not transferWithMemo`;
  const [to, amount, memo] = d.args ?? [];
  if (normAddr(to) !== normAddr(exp.recipient ?? VET402_TEMPO_ANCHOR_RECIPIENT)) return `transfer to ${String(to)} is not vet402's anchor recipient`;
  if (amount !== TEMPO_ANCHOR_AMOUNT) return `amount ${String(amount)} is not ${TEMPO_ANCHOR_AMOUNT}`;
  if (String(memo).toLowerCase() !== exp.root.toLowerCase()) return `memo ${String(memo)} is not the root ${exp.root}`;
  if (tx.feeToken === undefined || normAddr(tx.feeToken) !== USDC_E) return `fee token ${String(tx.feeToken)} is not USDC.e`;
  if (tx.feePayerSignature !== undefined && tx.feePayerSignature !== null) return "carries a fee payer signature";
  if (tx.keyAuthorization !== undefined && tx.keyAuthorization !== null) return "carries a key authorization";
  if (Array.isArray(tx.authorizationList) && tx.authorizationList.length > 0) return "carries an authorization list";
  const gas = BigInt(String(tx.gas ?? 0));
  const maxFee = BigInt(String(tx.maxFeePerGas ?? 0));
  if (maxFeeAtomic(gas, maxFee) > MAX_TEMPO_ANCHOR_FEE_ATOMIC) return `fee bound ${maxFeeAtomic(gas, maxFee)} is over ${MAX_TEMPO_ANCHOR_FEE_ATOMIC}`;
  return null;
}

// ---------- reading ----------

interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string;
}

export interface TempoAnchorRead {
  ok: boolean;
  detail: string;
  root: string | null;
  sender: string | null;
  blockTime: number | null;
  block: number | null;
}

/**
 * Read one transaction and say whether it is a vet402 Tempo anchor: succeeded, sent by one of `senders`,
 * with exactly one TransferWithMemo of 1 atomic USDC.e from that sender to vet402's anchor recipient.
 * Returns the memo (the root) and the block time.
 */
export async function readTempoAnchorTx(rpc: Rpc, tx: string, senders: readonly string[] = VET402_TEMPO_ANCHOR_SENDERS, recipient: string = VET402_TEMPO_ANCHOR_RECIPIENT): Promise<TempoAnchorRead> {
  const none = { root: null, sender: null, blockTime: null, block: null };
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) return { ok: false, detail: `${tx} is not a Tempo tx hash`, ...none };
  const r = (await rpc("eth_getTransactionReceipt", [tx])) as { status: string; from: string; logs: RpcLog[]; blockNumber: string } | null;
  if (!r) return { ok: false, detail: "Tempo anchor transaction not found", ...none };
  if (r.status !== "0x1") return { ok: false, detail: `Tempo anchor transaction status ${r.status}`, ...none };
  if (!senders.some((s) => normAddr(s) === normAddr(r.from)))
    return { ok: false, detail: `sent by ${r.from}, not by vet402's Tempo anchor key ${senders.join(", ")}; not an anchor`, ...none, sender: r.from };
  const memos = r.logs.filter(
    (l) =>
      normAddr(l.address) === USDC_E &&
      l.topics[0]?.toLowerCase() === TRANSFER_WITH_MEMO_TOPIC &&
      l.topics[1]?.toLowerCase() === topicAddr(r.from) &&
      l.topics[2]?.toLowerCase() === topicAddr(recipient) &&
      BigInt(l.data) === TEMPO_ANCHOR_AMOUNT,
  );
  if (memos.length !== 1) return { ok: false, detail: `${memos.length} anchor memos in the transaction (expected 1)`, ...none, sender: r.from };
  const block = (await rpc("eth_getBlockByNumber", [r.blockNumber, false])) as { timestamp: string } | null;
  return {
    ok: true,
    detail: `memo from ${r.from}`,
    root: memos[0]!.topics[3]!.toLowerCase(),
    sender: r.from,
    blockTime: block ? Number(BigInt(block.timestamp)) : null,
    block: Number(BigInt(r.blockNumber)),
  };
}

/** A day's Tempo anchor as the records index names it (data/records/index.json, days[].tempoAnchor). */
export interface TempoDayAnchor {
  tx: string;
  /** The 32-byte memo: the day's root. */
  memo: string;
  block: number;
}

/** Shape problems of an index entry's tempoAnchor for a day whose root is `root`; empty = well formed. */
export function tempoDayAnchorShape(a: unknown, root: string): string[] {
  const out: string[] = [];
  if (typeof a !== "object" || a === null) return ["tempoAnchor is not an object"];
  const t = a as Record<string, unknown>;
  const extra = Object.keys(t).filter((k) => !["tx", "memo", "block"].includes(k));
  if (extra.length) out.push(`tempoAnchor has unknown fields ${extra.join(", ")}`);
  if (typeof t.tx !== "string" || !/^0x[0-9a-f]{64}$/.test(t.tx)) out.push("tempoAnchor.tx is not a lowercase 32-byte hash");
  if (typeof t.memo !== "string" || t.memo !== root.toLowerCase()) out.push(`tempoAnchor.memo is not the day's root ${root}`);
  if (typeof t.block !== "number" || !Number.isSafeInteger(t.block) || t.block <= 0) out.push("tempoAnchor.block is not a block number");
  return out;
}

/**
 * A day's Tempo anchor, as verify-receipt checks it: the tx is vet402's Tempo anchor (sent by the anchor
 * key to the anchor recipient), its memo is the index's memo and the record's root, it is in the named
 * block, and it was written after the root's UTC day ended.
 */
export async function checkTempoDayAnchor(
  a: TempoDayAnchor,
  day: { day: string; root: string },
  rpc: Rpc,
  senders: readonly string[] = VET402_TEMPO_ANCHOR_SENDERS,
  recipient: string = VET402_TEMPO_ANCHOR_RECIPIENT,
): Promise<{ ok: boolean; detail: string }> {
  const shape = tempoDayAnchorShape(a, day.root);
  if (shape.length) return { ok: false, detail: shape.join("; ") };
  const t = await readTempoAnchorTx(rpc, a.tx, senders, recipient);
  if (!t.ok) return { ok: false, detail: t.detail };
  if (t.root !== day.root.toLowerCase()) return { ok: false, detail: `Tempo memo ${t.root} is not the record's root ${day.root}` };
  if (t.block !== a.block) return { ok: false, detail: `Tempo anchor is in block ${t.block}, the index says ${a.block}` };
  const dayEnd = Date.parse(`${day.day}T00:00:00Z`) / 1000 + 86_400;
  if (t.blockTime === null || t.blockTime < dayEnd) return { ok: false, detail: `Tempo memo written at ${t.blockTime}, before ${day.day} ended` };
  return { ok: true, detail: `Tempo memo from vet402's anchor key ${t.sender} holds root ${t.root} (tx ${a.tx}, block ${t.block})` };
}

/**
 * The Tempo anchor a records index names for the record's day. `entry` null = the index names none.
 * `problem` = the index is not a records index, or names another root for the day, or a malformed entry.
 */
export function tempoAnchorFromIndex(index: unknown, record: { anchor: { day: string; root: string } | null }): { entry: TempoDayAnchor | null; problem: string | null } {
  const idx = index as { kind?: unknown; days?: unknown };
  if (typeof idx !== "object" || idx === null || idx.kind !== "vet402-observation-records" || !Array.isArray(idx.days)) return { entry: null, problem: "not a vet402 records index" };
  const a = record.anchor;
  if (!a) return { entry: null, problem: null };
  const d = (idx.days as { day?: unknown; root?: unknown; tempoAnchor?: unknown }[]).find((x) => x?.day === a.day);
  if (!d) return { entry: null, problem: null };
  if (typeof d.root !== "string" || d.root.toLowerCase() !== a.root.toLowerCase()) return { entry: null, problem: `the index names root ${String(d.root)} for ${a.day}, the record ${a.root}` };
  if (d.tempoAnchor === undefined) return { entry: null, problem: null };
  const bad = tempoDayAnchorShape(d.tempoAnchor, a.root);
  if (bad.length) return { entry: null, problem: bad.join("; ") };
  return { entry: d.tempoAnchor as TempoDayAnchor, problem: null };
}

/** Anchor transactions from `sender` to the recipient whose memo is `root`, from `fromBlock` to the head. */
export async function findTempoAnchors(rpc: Rpc, root: string, sender: string, fromBlock: bigint = TEMPO_ANCHOR_START_BLOCK, recipient: string = VET402_TEMPO_ANCHOR_RECIPIENT): Promise<{ tx: string; block: bigint }[]> {
  if (!isRoot(root)) throw new Error(`root ${root} is not 32 bytes`);
  const head = BigInt((await rpc("eth_blockNumber", [])) as string);
  const out: { tx: string; block: bigint }[] = [];
  for (let from = fromBlock; from <= head; from += LOG_RANGE + 1n) {
    const to = from + LOG_RANGE > head ? head : from + LOG_RANGE;
    const logs = (await rpc("eth_getLogs", [
      { address: USDC_E, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}`, topics: [TRANSFER_WITH_MEMO_TOPIC, topicAddr(sender), topicAddr(recipient), root.toLowerCase()] },
    ])) as RpcLog[];
    for (const l of logs) out.push({ tx: l.transactionHash.toLowerCase(), block: BigInt(l.blockNumber) });
  }
  return out;
}
