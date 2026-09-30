/**
 * The post-run chain check, shared by Solana and Tempo. Pure: no network, no files.
 *
 * Every payment that left the payer during a run must be on a row (or ledger entry) of vet402's records.
 * A payment the records do not carry is written onto a row only when exactly one row can own it:
 *   - its recipient is the row's payTo and its amount is the row's price,
 *   - its block time falls inside that row's paid request (from the row's start to the next attempt),
 *   - no other unrecorded payment fits that row, and no other row fits that payment,
 *   - no earlier row to the same payTo at the same price is still without a tx (that row's payment can land
 *     after the next row started, inside the next row's window),
 *   - the tx is not already on another row.
 * Anything else stays "unmatched" and the run fails (exit code), so a human looks.
 *
 * Why: on 2026-09-29 a Tempo purchase (kicksdb, HTTP 500, sponsored fee) settled on chain while the
 * records said settled null, tx null; the paid response carried no receipt and payOne had no hash to read.
 */

export interface OutTransfer {
  to: string;
  amount: bigint;
}

/** One transaction that moved the payer's token out, with every transfer out of the payer in it. */
export interface OutTx {
  tx: string;
  /** Block time, ms (the chain gives seconds). */
  timeMs: number;
  transfers: OutTransfer[];
}

/** A row that may own an unrecorded payment. */
export interface Candidate {
  id: string;
  payTo: string;
  amount: bigint;
  fromMs: number;
  toMs: number;
}

export interface Matched {
  id: string;
  tx: string;
  time: string;
}

export interface Unmatched {
  tx: string;
  time: string;
  transfers: { to: string; amount: string }[];
  /** Rows that fit this payment (0, or more than one). */
  candidates: string[];
  reason: string;
}

export interface CheckResult {
  /** Transactions that moved the payer's token out in the window. */
  txs: number;
  /** Of those, already on a row. */
  recorded: number;
  matched: Matched[];
  unmatched: Unmatched[];
  /** A tx that more than one row or ledger entry claims. */
  duplicates: string[];
}

export interface CheckInput {
  txs: readonly OutTx[];
  /** Every tx hash the records carry (rows, and every ledger of the key). */
  known: Iterable<string>;
  /**
   * Records that must not share a tx: one list per independent book (not a mirror of another; a
   * result file's rows and the day ledger they came from are one book). A tx twice across them is a duplicate.
   */
  books: readonly (readonly (string | null | undefined)[])[];
  candidates: readonly Candidate[];
  /** Recipients that only take the network fee (Tempo's fee manager). Solana: none. */
  feeSinks?: readonly string[];
  /** Normalise a tx hash / address for comparison (lowercase on EVM, as is on Solana). */
  norm: (s: string) => string;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function checkOutflows(inp: CheckInput): CheckResult {
  const { norm } = inp;
  const known = new Set([...inp.known].map(norm));
  const sinks = new Set((inp.feeSinks ?? []).map(norm));

  const seen = new Map<string, number>();
  for (const book of inp.books) for (const t of book) if (t) seen.set(norm(t), (seen.get(norm(t)) ?? 0) + 1);
  const duplicates = [...seen].filter(([, n]) => n > 1).map(([t]) => t).sort();

  const unrecorded = inp.txs.filter((t) => !known.has(norm(t.tx)));
  const fit = new Map<string, Candidate[]>();
  const pay = new Map<string, OutTransfer | null>();
  for (const u of unrecorded) {
    const payments = u.transfers.filter((x) => !sinks.has(norm(x.to)));
    const p = payments.length === 1 ? payments[0]! : null;
    pay.set(u.tx, p);
    fit.set(
      u.tx,
      p ? inp.candidates.filter((c) => norm(c.payTo) === norm(p.to) && c.amount === p.amount && c.fromMs <= u.timeMs && u.timeMs <= c.toMs) : [],
    );
  }
  const txsOf = (c: Candidate) => unrecorded.filter((u) => fit.get(u.tx)!.includes(c));
  // An earlier candidate (started no later, ended no later) to the same payTo at the same price: the payment may be its.
  const earlierOpen = (c: Candidate) =>
    inp.candidates.some((o) => o !== c && norm(o.payTo) === norm(c.payTo) && o.amount === c.amount && o.fromMs <= c.fromMs && o.toMs <= c.toMs);

  const matched: Matched[] = [];
  const unmatched: Unmatched[] = [];
  for (const u of unrecorded) {
    const cs = fit.get(u.tx)!;
    const show = { tx: u.tx, time: iso(u.timeMs), transfers: u.transfers.map((x) => ({ to: x.to, amount: x.amount.toString() })), candidates: cs.map((c) => c.id) };
    if (!pay.get(u.tx)) unmatched.push({ ...show, reason: "not exactly one payment transfer in the tx" });
    else if (cs.length === 0) unmatched.push({ ...show, reason: "no row with this payTo and price was paying at this time" });
    else if (cs.length > 1) unmatched.push({ ...show, reason: "more than one row fits" });
    else if (txsOf(cs[0]!).length > 1) unmatched.push({ ...show, reason: "the row fits more than one unrecorded payment" });
    else if (earlierOpen(cs[0]!)) unmatched.push({ ...show, reason: "an earlier row with this payTo and price has no tx yet; the payment may be its" });
    else matched.push({ id: cs[0]!.id, tx: u.tx, time: iso(u.timeMs) });
  }
  return { txs: inp.txs.length, recorded: inp.txs.length - unrecorded.length, matched, unmatched, duplicates };
}

/** Rows as candidates: `[start, next start)` windows in time order; the last row ends at `endMs`. */
export function windows<T>(rows: readonly T[], at: (r: T) => string, endMs: number): { row: T; fromMs: number; toMs: number }[] {
  const sorted = [...rows].sort((a, b) => Date.parse(at(a)) - Date.parse(at(b)));
  return sorted.map((row, i) => ({
    row,
    // block times are whole seconds
    fromMs: Math.floor(Date.parse(at(row)) / 1000) * 1000,
    toMs: i + 1 < sorted.length ? Date.parse(at(sorted[i + 1]!)) : endMs,
  }));
}

/** "0.000500" -> 500n (6 decimals, as both USDC and USDC.e are). */
export function unitsToAtomic6(s: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`bad amount ${s}`);
  const [w, f = ""] = s.split(".");
  return BigInt(w!) * 1_000_000n + BigInt(f.padEnd(6, "0"));
}

/** What a run records about its chain check (results file, runs[].chainCheck). */
export interface ChainCheckRecord {
  checkedAt: string;
  from: string;
  to: string;
  txs: number;
  recorded: number;
  /** Payments found on chain and written onto their row by this check. */
  added: { key: string; tx: string; time: string }[];
  unmatched: Unmatched[];
  duplicates: string[];
}

export function checkFailed(r: Pick<CheckResult, "unmatched" | "duplicates">): boolean {
  return r.unmatched.length > 0 || r.duplicates.length > 0;
}
