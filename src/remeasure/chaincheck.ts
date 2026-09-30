/**
 * The post-run chain check on a remeasure result file (../chaincheck.ts), for each chain.
 *
 * At the end of every --pay run (and by scripts/chain-check.ts on a past day), every payment that left
 * the payer during the run must be on a row. A payment the rows do not carry is written onto the one row
 * that can own it (settled true, tx, "settled on chain" added to detail; outcome and reason unchanged),
 * and on Tempo onto that row's day-ledger entry too. Anything else stays unmatched in runs[].chainCheck,
 * and the run's exit code fails.
 */
import { USDC_MINT } from "../constants.js";
import type { Rpc } from "../chain.js";
import { TEMPO_FEE_MANAGER, normAddr } from "../tempo/constants.js";
import type { KeyLedgerSet } from "../tempo/key-ledgers.js";
import type { Ledger } from "../tempo/ledger.js";
import { SETTLED_NOTE, appendNote, confirmMatches, keyLedgerTxs, type TempoOutflowReader } from "../tempo/chaincheck.js";
import { checkOutflows, unitsToAtomic6, windows, type Candidate, type ChainCheckRecord, type OutTx, type Unmatched } from "../chaincheck.js";
import type { RemeasureRow, ResultFile, RunInfo } from "./results.js";

/** Grace after a run's end for the chain read: a payment landing late is still seen (and must be owned). */
export const CHAIN_CHECK_GRACE_MS = 120_000;

const PAID_OUTCOMES = new Set(["sent", "unknown", "unknown_after_sign"]);

export type RunWithCheck = RunInfo & { chainCheck?: ChainCheckRecord };

/** Rows of `run` in time order, and the candidates among them: paid or maybe paid, not settled on the record. */
export function runCandidates(file: ResultFile, run: RunInfo, endMs: number): Candidate[] {
  const from = Date.parse(run.startedAt);
  const inRun = file.rows.map((row, i) => ({ row, i })).filter(({ row }) => Date.parse(row.at) >= from && Date.parse(row.at) <= endMs);
  return windows(inRun, (x) => x.row.at, endMs)
    .filter(({ row: { row } }) => PAID_OUTCOMES.has(row.outcome) && row.settled !== true && row.priceUsdc !== null && (row.payTo ?? row.expectedPayTo))
    .map(({ row: { row, i }, fromMs, toMs }) => ({ id: String(i), payTo: (row.payTo ?? row.expectedPayTo)!, amount: unitsToAtomic6(row.priceUsdc!), fromMs, toMs }));
}

function markSettled(row: RemeasureRow, tx: string): void {
  row.settled = true;
  row.tx = tx;
  row.detail = appendNote(row.detail, SETTLED_NOTE);
}

function record(run: RunWithCheck, r: Omit<ChainCheckRecord, "added"> & { added: ChainCheckRecord["added"] }): ChainCheckRecord {
  // A later check of the same run keeps what an earlier one added.
  const added = [...(run.chainCheck?.added ?? []), ...r.added];
  run.chainCheck = { ...r, added };
  return run.chainCheck;
}

// ---------- Tempo ----------

export async function checkTempoRun(o: {
  file: ResultFile;
  run: RunWithCheck;
  /** The file's day ledger; entries are updated with the row (null: read-only check, nothing written). */
  dayLedger: Ledger | null;
  set: KeyLedgerSet;
  reader: TempoOutflowReader;
  endMs: number;
  graceMs?: number;
  now?: () => Date;
}): Promise<ChainCheckRecord> {
  const payer = o.file.payer;
  const candidates = runCandidates(o.file, o.run, o.endMs);
  const txs = await o.reader.outTxs(Date.parse(o.run.startedAt), o.endMs + (o.graceMs ?? CHAIN_CHECK_GRACE_MS));
  const { known, books } = keyLedgerTxs(o.set, payer);
  const rowsTx = o.file.rows.map((r) => r.tx).filter((t): t is string => !!t);
  const res = checkOutflows({ txs, known: [...known, ...rowsTx], books, candidates, feeSinks: [TEMPO_FEE_MANAGER], norm: normAddr });
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const { ok, failed } = await confirmMatches(res.matched, (id) => ({ payer, recipient: byId.get(id)!.payTo, amount: byId.get(id)!.amount }), o.reader);
  const added: ChainCheckRecord["added"] = [];
  for (const { m, v } of ok) {
    const row = o.file.rows[Number(m.id)]!;
    if (o.dayLedger) {
      const e = [...o.dayLedger.entries()].reverse().find((x) => x.key === row.key && x.status !== "refused_before_sign");
      if (!e) {
        failed.push({ tx: m.tx, time: m.time, transfers: [], candidates: [m.id], reason: `no day-ledger entry for ${row.key}` });
        continue;
      }
      o.dayLedger.update(row.key, { txHash: m.tx, settled: true, feePaid: v.feePaid, note: appendNote(e.note, SETTLED_NOTE) });
      markSettled(row, m.tx);
    }
    added.push({ key: row.key, tx: m.tx, time: m.time });
  }
  const r = {
    checkedAt: (o.now ?? (() => new Date()))().toISOString(),
    from: o.run.startedAt,
    to: new Date(o.endMs).toISOString(),
    txs: res.txs,
    recorded: res.recorded,
    added,
    unmatched: [...res.unmatched, ...failed],
    duplicates: res.duplicates,
  };
  return o.dayLedger ? record(o.run, r) : r;
}

// ---------- Solana ----------

export interface SolanaOutflowReader {
  /**
   * Transactions in [fromMs, toMs] that touched the payer's USDC account without error. A signature in
   * `known` comes back with no transfers (it is on a row; nothing to read). Any other one is read, and
   * kept only when USDC left the payer, with each owner that received USDC as a transfer.
   */
  outTxs(fromMs: number, toMs: number, known: ReadonlySet<string>): Promise<OutTx[]>;
  /** The tx moved exactly `amount` USDC from the payer to `payTo`, without error (as payOne's settled). */
  verify(sig: string, payTo: string, amount: bigint): Promise<boolean>;
}

interface TokenBal {
  owner?: string;
  mint: string;
  uiTokenAmount: { amount: string };
}
interface ParsedTx {
  blockTime?: number | null;
  meta: { err: unknown; preTokenBalances?: TokenBal[]; postTokenBalances?: TokenBal[] } | null;
}

/** USDC change per owner in one parsed transaction. */
export function usdcDeltas(tx: ParsedTx): Map<string, bigint> {
  const d = new Map<string, bigint>();
  for (const [arr, sign] of [[tx.meta?.preTokenBalances, -1n], [tx.meta?.postTokenBalances, 1n]] as const) {
    for (const b of arr ?? []) if (b.mint === USDC_MINT && b.owner) d.set(b.owner, (d.get(b.owner) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount));
  }
  return d;
}

export function liveSolanaReader(rpc: Rpc, payer: string, payerUsdcAta: string): SolanaOutflowReader {
  const get = (sig: string) => rpc("getTransaction", [sig, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]) as Promise<ParsedTx | null>;
  return {
    async outTxs(fromMs, toMs, known) {
      const out: OutTx[] = [];
      let before: string | undefined;
      for (;;) {
        const page = (await rpc("getSignaturesForAddress", [payerUsdcAta, { limit: 1000, commitment: "confirmed", ...(before ? { before } : {}) }])) as {
          signature: string;
          blockTime: number | null;
          err: unknown;
        }[];
        if (page.length === 0) break;
        for (const s of page) {
          if (s.blockTime === null) continue;
          const t = s.blockTime * 1000;
          if (t < fromMs || t > toMs || s.err !== null) continue;
          if (known.has(s.signature)) {
            out.push({ tx: s.signature, timeMs: t, transfers: [] });
            continue;
          }
          const tx = await get(s.signature);
          if (!tx || tx.meta?.err) continue;
          const d = usdcDeltas(tx);
          if ((d.get(payer) ?? 0n) >= 0n) continue; // nothing left the payer
          out.push({ tx: s.signature, timeMs: t, transfers: [...d].filter(([k, v]) => k !== payer && v > 0n).map(([to, amount]) => ({ to, amount })) });
        }
        const last = page[page.length - 1]!;
        if (last.blockTime !== null && last.blockTime * 1000 < fromMs) break;
        before = last.signature;
      }
      return out;
    },
    async verify(sig, payTo, amount) {
      const tx = await get(sig);
      if (!tx || tx.meta?.err) return false;
      const d = usdcDeltas(tx);
      return (d.get(payTo) ?? 0n) === amount && (d.get(payer) ?? 0n) === -amount;
    },
  };
}

export async function checkSolanaRun(o: {
  file: ResultFile;
  run: RunWithCheck;
  reader: SolanaOutflowReader;
  endMs: number;
  /** false: read-only, nothing written onto the file. */
  write: boolean;
  graceMs?: number;
  now?: () => Date;
}): Promise<ChainCheckRecord> {
  const candidates = runCandidates(o.file, o.run, o.endMs);
  const rowsTx = o.file.rows.map((r) => r.tx).filter((t): t is string => !!t);
  const known = new Set(rowsTx);
  const txs = await o.reader.outTxs(Date.parse(o.run.startedAt), o.endMs + (o.graceMs ?? CHAIN_CHECK_GRACE_MS), known);
  // The Solana file has no second book: its rows are the record of each purchase.
  const res = checkOutflows({ txs, known, books: [rowsTx], candidates, norm: (s) => s });
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const added: ChainCheckRecord["added"] = [];
  const failed: Unmatched[] = [];
  for (const m of res.matched) {
    const c = byId.get(m.id)!;
    if (!(await o.reader.verify(m.tx, c.payTo, c.amount))) {
      failed.push({ tx: m.tx, time: m.time, transfers: [{ to: c.payTo, amount: c.amount.toString() }], candidates: [m.id], reason: "the chain does not confirm it" });
      continue;
    }
    const row = o.file.rows[Number(m.id)]!;
    if (o.write) markSettled(row, m.tx);
    added.push({ key: row.key, tx: m.tx, time: m.time });
  }
  const r = {
    checkedAt: (o.now ?? (() => new Date()))().toISOString(),
    from: o.run.startedAt,
    to: new Date(o.endMs).toISOString(),
    txs: res.txs,
    recorded: res.recorded,
    added,
    unmatched: [...res.unmatched, ...failed],
    duplicates: res.duplicates,
  };
  return o.write ? record(o.run, r) : r;
}
