/**
 * Tempo side of the post-run chain check (../chaincheck.ts): read every USDC.e transfer out of the key
 * in a run's time, and check it against the key's records. Used at the end of every Tempo --pay run:
 * remeasure (../remeasure/chaincheck.ts) and the census (checkCensusRun below).
 *
 * How it sits next to key-ledgers.ts `unaccountedChainSpent`: that check runs before every signature
 * and compares totals (outflow since the census start vs what the ledgers account for). It bounds the
 * money, but it cannot say which purchase a transfer belongs to, and it counts an unknown outcome as
 * spent, so a payment recorded as settled null passes it (2026-09-29, kicksdb). This check runs after
 * the run and identifies each transfer. Both stay: the first stops spending, the second fixes the record.
 */
import { MAX_TOTAL_ATOMIC, PAYER_ADDRESS, TEMPO_FEE_MANAGER, normAddr } from "./constants.js";
import { CENSUS_START_BLOCK, headBlock, payerTransfers, publicClient, verifySettlement, type SettlementCheck } from "./chain.js";
import { keyLedgerFiles, type KeyLedgerSet } from "./key-ledgers.js";
import { Ledger } from "./ledger.js";
import { firstBlockAtOrAfter } from "../remeasure/tempo.js";
import { checkOutflows, windows, type ChainCheckRecord, type Candidate, type OutTx, type Unmatched } from "../chaincheck.js";

export interface TempoOutflowReader {
  /** Transactions with a USDC.e transfer out of the payer whose block time is in [fromMs, toMs]. */
  outTxs(fromMs: number, toMs: number): Promise<OutTx[]>;
  verify(tx: string, exp: { payer: string; recipient: string; amount: bigint }): Promise<SettlementCheck>;
}

export function liveTempoReader(payer: string = PAYER_ADDRESS): TempoOutflowReader {
  const c = publicClient();
  const ts = new Map<bigint, bigint>();
  const tsOf = async (n: bigint) => {
    let t = ts.get(n);
    if (t === undefined) {
      t = (await c.getBlock({ blockNumber: n })).timestamp;
      ts.set(n, t);
    }
    return t;
  };
  return {
    async outTxs(fromMs, toMs) {
      const head = await headBlock();
      const from = await firstBlockAtOrAfter(BigInt(Math.floor(fromMs / 1000)), CENSUS_START_BLOCK, head, tsOf);
      const to = (await firstBlockAtOrAfter(BigInt(Math.floor(toMs / 1000)) + 1n, CENSUS_START_BLOCK, head, tsOf)) - 1n;
      if (to < from) return [];
      const byTx = new Map<string, OutTx>();
      for (const t of await payerTransfers(payer, from, to)) {
        let o = byTx.get(t.tx);
        if (!o) {
          o = { tx: t.tx, timeMs: Number(await tsOf(t.block)) * 1000, transfers: [] };
          byTx.set(t.tx, o);
        }
        o.transfers.push({ to: t.to, amount: t.amount });
      }
      return [...byTx.values()];
    },
    verify: (tx, exp) => verifySettlement(tx, exp),
  };
}

/** The tx hashes every ledger of the key carries: all of them (known), and one list per ledger (books). */
export function keyLedgerTxs(set: KeyLedgerSet, payer: string): { known: string[]; books: string[][] } {
  const books = keyLedgerFiles(set).map((f) =>
    new Ledger(f, payer, MAX_TOTAL_ATOMIC)
      .entries()
      .map((e) => e.txHash)
      .filter((h): h is string => !!h),
  );
  return { known: books.flat(), books };
}

export const SETTLED_NOTE = "settled on chain (found by the post-run chain check)";

export function appendNote(prev: string | null | undefined, add: string): string {
  return prev ? `${prev}; ${add}` : add;
}

/** Verify each match on chain; a match the chain does not confirm becomes unmatched. */
export async function confirmMatches<T extends { id: string; tx: string; time: string }>(
  matched: readonly T[],
  expOf: (id: string) => { payer: string; recipient: string; amount: bigint },
  reader: TempoOutflowReader,
): Promise<{ ok: { m: T; v: SettlementCheck }[]; failed: Unmatched[] }> {
  const ok: { m: T; v: SettlementCheck }[] = [];
  const failed: Unmatched[] = [];
  for (const m of matched) {
    const exp = expOf(m.id);
    const v = await reader.verify(m.tx, exp);
    if (v.settled) ok.push({ m, v });
    else failed.push({ tx: m.tx, time: m.time, transfers: [{ to: exp.recipient, amount: exp.amount.toString() }], candidates: [m.id], reason: `the chain does not confirm it: ${v.detail}` });
  }
  return { ok, failed };
}

/**
 * The census --pay run that started at `startedAt`: every USDC.e transfer out of the key since then must
 * be on a ledger of the key. A transfer that exactly one of this run's entries can own is written onto
 * that entry (txHash, settled true, the fee read back); the rest are returned as unmatched.
 */
export async function checkCensusRun(o: {
  ledger: Ledger;
  startedAt: string;
  endMs: number;
  set: KeyLedgerSet;
  reader: TempoOutflowReader;
  payer?: string;
  now?: () => Date;
}): Promise<ChainCheckRecord> {
  const payer = o.payer ?? PAYER_ADDRESS;
  const fromMs = Date.parse(o.startedAt);
  const mine = o.ledger.entries().filter((e) => Date.parse(e.reservedAt) >= fromMs);
  const w = windows(mine, (e) => e.reservedAt, o.endMs);
  const candidates: Candidate[] = w
    .filter(({ row: e }) => (e.status === "sent" || e.status === "unknown") && e.settled !== true)
    .map(({ row: e, fromMs: f, toMs }) => ({ id: e.key, payTo: e.recipient, amount: BigInt(e.amount), fromMs: f, toMs }));
  const txs = await o.reader.outTxs(fromMs, o.endMs);
  const { known, books } = keyLedgerTxs(o.set, payer);
  const res = checkOutflows({ txs, known, books, candidates, feeSinks: [TEMPO_FEE_MANAGER], norm: normAddr });
  const byKey = new Map(candidates.map((c) => [c.id, c]));
  const { ok, failed } = await confirmMatches(res.matched, (id) => ({ payer, recipient: byKey.get(id)!.payTo, amount: byKey.get(id)!.amount }), o.reader);
  for (const { m, v } of ok) {
    const e = [...o.ledger.entries()].reverse().find((x) => x.key === m.id && x.status !== "refused_before_sign")!;
    o.ledger.update(m.id, { txHash: m.tx, settled: true, feePaid: v.feePaid, note: appendNote(e.note, SETTLED_NOTE) });
  }
  return {
    checkedAt: (o.now ?? (() => new Date()))().toISOString(),
    from: o.startedAt,
    to: new Date(o.endMs).toISOString(),
    txs: res.txs,
    recorded: res.recorded,
    added: ok.map(({ m }) => ({ key: m.id, tx: m.tx, time: m.time })),
    unmatched: [...res.unmatched, ...failed],
    duplicates: res.duplicates,
  };
}
