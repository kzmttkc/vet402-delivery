/**
 * The chain check of one EVM lane over its result files (src/evm/chaincheck.ts). Read-only on chain: eth_getLogs
 * and eth_getBlockByNumber. Used by scripts/evm-chaincheck.ts and at the end of every paying lane run.
 *
 * Reads results/evm/<lane>-purchases.jsonl (+ -reverify.jsonl, + an earlier -chaincheck.jsonl), writes
 * results/evm/<lane>-chaincheck.jsonl: every sent purchase with its chain reading.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { EVM_CHAINS, LANES, type LaneId } from "./chains.js";
import { chainCheckRecords, mergeReadings, readEvmOutflows, readRange, readRanges, type EvmCheckSummary } from "./chaincheck.js";
import type { ChainBuyRecord } from "./evm-buy.js";

export interface LaneCheckOutput {
  lane: LaneId;
  rpc: string;
  sent: number;
  transfersOut: number;
  tally: Record<string, number>;
  summary: EvmCheckSummary | null;
  /** Unmatched transfers, ambiguous or pending purchases: a human looks (exit code 1). */
  failed: boolean;
}

export function laneRpc(laneId: LaneId): string {
  const spec = EVM_CHAINS[LANES[laneId].chain];
  // Base: base-rpc.publicnode.com refuses old reads; mainnet.base.org answers them (chains.ts receiptRpc).
  return process.env[spec.rpcEnv] ?? (spec.key === "base" ? spec.receiptRpc : spec.rpc);
}

export async function checkLaneFiles(laneId: LaneId, payer: Address, dir = "results/evm", nowMs = Date.now()): Promise<LaneCheckOutput> {
  const spec = EVM_CHAINS[LANES[laneId].chain];
  const files = [`${dir}/${laneId}-purchases.jsonl`, `${dir}/${laneId}-reverify.jsonl`];
  const rows = mergeReadings(
    files.flatMap((f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as ChainBuyRecord & { lane: string }) : [])),
  ).filter((r) => r.lane === laneId);
  const rpc = laneRpc(laneId);
  const range = readRange(rows);
  if (!range) return { lane: laneId, rpc, sent: 0, transfersOut: 0, tally: {}, summary: null, failed: false };
  const client = createPublicClient({ transport: http(rpc) }) as PublicClient;
  if ((await client.getChainId()) !== spec.chainId) throw new Error(`${rpc}: chainId is not ${spec.chainId}`);
  // Blocks a few seconds old may not be served by every RPC node yet.
  const readTo = Math.min(range.toMs, nowMs - 30_000);
  // Each run of purchases on its own (readRanges), each in block chunks a public RPC answers (eth_getLogs ranges).
  const chunk = BigInt(process.env.EVM_LOG_CHUNK ?? (spec.key === "base" ? "2000" : "10000"));
  const seen = new Set<string>();
  const txs: Awaited<ReturnType<typeof readEvmOutflows>> = [];
  for (const g of readRanges(rows)) {
    const to = Math.min(g.toMs, readTo);
    if (to <= g.fromMs) continue;
    for (const t of await readEvmOutflows(client, spec, payer, g.fromMs, to, chunk)) {
      if (seen.has(t.tx.toLowerCase())) continue;
      seen.add(t.tx.toLowerCase());
      txs.push(t);
    }
  }
  txs.sort((a, b) => a.timeMs - b.timeMs);
  const { records, summary } = chainCheckRecords(rows, txs, { payer, checkedAt: new Date(nowMs).toISOString(), readToMs: readTo });
  const sent = records.filter((r) => r.outcome === "sent");
  writeFileSync(`${dir}/${laneId}-chaincheck.jsonl`, sent.map((r) => JSON.stringify(r)).join("\n") + (sent.length ? "\n" : ""));
  const tally: Record<string, number> = {};
  for (const r of sent) tally[r.chainCheck?.result ?? "none"] = (tally[r.chainCheck?.result ?? "none"] ?? 0) + 1;
  return { lane: laneId, rpc, sent: sent.length, transfersOut: txs.length, tally, summary, failed: summary.unmatched.length > 0 || summary.ambiguous.length > 0 || summary.pending.length > 0 };
}
