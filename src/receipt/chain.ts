/**
 * Read-only chain checks for an observation. Nothing here signs or sends.
 *  - Solana: the transaction is confirmed without error and moved exactly `amount` USDC from payer to payTo
 *  - EVM (Base, Tempo): the receipt has status 1 and an ERC-20/TIP-20 Transfer(payer -> payTo, amount)
 *    emitted by `asset`
 *  - anchor: the Solana memo of the anchor transaction carries the record's root
 */
import { jsonRpc, readTransaction, type Rpc } from "../chain.js";
import { parseAnchorMemo } from "./merkle.js";
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

export async function checkAnchorOnChain(o: Observation, rpcFor: (network: string) => Rpc = (n) => jsonRpc(DEFAULT_RPC[n] ?? "")): Promise<ChainResult | null> {
  const a = o.anchor;
  if (!a || a.status !== "anchored" || !a.tx) return null;
  if (!a.network.startsWith("solana:")) return { ok: false, detail: `anchor on ${a.network} not supported by this script` };
  const tx = (await rpcFor(a.network)("getTransaction", [a.tx, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }])) as {
    meta: { err: unknown } | null;
    transaction: { message: { instructions: { programId: string; parsed?: unknown }[] } };
  } | null;
  if (!tx) return { ok: false, detail: "anchor transaction not found" };
  const memos = tx.transaction.message.instructions.map((i) => (typeof i.parsed === "string" ? i.parsed : null)).filter((m): m is string => m !== null);
  const parsed = memos.map(parseAnchorMemo).find((m) => m !== null);
  if (!parsed) return { ok: false, detail: "no x402-observation memo in the anchor transaction" };
  const ok = parsed.root.toLowerCase() === a.root.toLowerCase() && parsed.observer.toLowerCase() === a.observerAddress.toLowerCase() && parsed.day === a.day;
  return ok ? { ok: true, detail: `memo holds root ${parsed.root} for ${parsed.day}, n=${parsed.count}` } : { ok: false, detail: `memo root ${parsed.root} does not match ${a.root}` };
}
