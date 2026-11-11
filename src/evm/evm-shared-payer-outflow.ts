/** Shared EVM payer: ledger committed vs on-chain USDC outflow (Tempo chain_spend_exceeds_ledger family). */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { LANES, type LaneId } from "./chains.js";

export function spentAtomicFromLedgerFile(text: string): bigint {
  try {
    const j = JSON.parse(text) as { spentAtomic?: string; purchases?: { amount?: string }[] };
    if (j.spentAtomic && /^\d+$/.test(j.spentAtomic)) return BigInt(j.spentAtomic);
    if (Array.isArray(j.purchases)) return j.purchases.reduce((n, p) => n + BigInt(p.amount ?? "0"), 0n);
  } catch {
    /* unreadable */
  }
  return 0n;
}

/** Sum committed USDC across every EVM lane ledger file under resultsDir. */
export function evmSharedPayerLedgerCommitted(resultsDir: string, laneIds: readonly LaneId[] = Object.keys(LANES) as LaneId[]): bigint {
  let total = 0n;
  for (const id of laneIds) {
    total += laneLedgerCommitted(resultsDir, id);
  }
  return total;
}

/** Committed USDC on one lane's ledger file. */
export function laneLedgerCommitted(resultsDir: string, laneId: LaneId): bigint {
  const rel = LANES[laneId].ledger.replace(/^results\/evm\//, "");
  const path = rel.startsWith("/") ? rel : join(resultsDir, rel);
  if (!existsSync(path)) return 0n;
  return spentAtomicFromLedgerFile(readFileSync(path, "utf8"));
}

/**
 * The first Polygon block the lane accounts for (2026-11-10, before any Polygon purchase from 0x9B59). Fixed in the
 * code like Tempo's CENSUS_START_BLOCK: no file can move it, so no rewritten baseline can hide an outflow.
 */
export const POLYGON_OUTFLOW_START_BLOCK = 97_090_000n;
/**
 * Blocks per eth_getLogs call. Measured 2026-11-11: polygon-bor-rpc.publicnode.com answers 2,000 and refuses 5,000;
 * polygon.drpc.org (the lane's read RPC) refuses eth_getLogs on its free plan, so the logs have their own RPC.
 */
export const POLYGON_LOG_SPAN = 2_000n;
/** The RPC the outflow logs are read from: POLYGON_LOGS_RPC_URL, else POLYGON_RPC_URL when set, else publicnode. */
export function polygonLogsRpc(env: NodeJS.ProcessEnv = process.env): string {
  return env.POLYGON_LOGS_RPC_URL ?? env.POLYGON_RPC_URL ?? "https://polygon-bor-rpc.publicnode.com";
}

export interface OutflowLogReader {
  head(): Promise<bigint>;
  /** Sum of the asset's Transfer logs out of the payer in blocks [from, to]. */
  outflow(from: bigint, to: bigint): Promise<bigint>;
}

/**
 * USDC that left the payer on Polygon since POLYGON_OUTFLOW_START_BLOCK, read from the Transfer logs (the same read
 * as Tempo's usdcOutflowSinceStart), not from a balance difference: an inflow of the same amount does not hide it.
 * Each call reads only the blocks after the previous call. A failed read throws, and the caller signs nothing.
 */
export function polygonOutflowScanner(reader: OutflowLogReader, start: bigint = POLYGON_OUTFLOW_START_BLOCK, span: bigint = POLYGON_LOG_SPAN): () => Promise<bigint> {
  let next = start;
  let sum = 0n;
  return async () => {
    const head = await reader.head();
    for (let from = next; from <= head; from += span) {
      const to = from + span - 1n > head ? head : from + span - 1n;
      sum += await reader.outflow(from, to);
      next = to + 1n;
    }
    return sum;
  };
}
