/**
 * Pure Keeta dry-run plan from probed payable rows and ledger caps (no network, no persist).
 */
import { atomicToUsdc } from "../constants.js";
import { toAtomic } from "../daily/steps.js";
import { KeetaBudget, isKeetaMonthCapRefusal, keetaBudgetKey, keetaDayTotalsFromLedger } from "./budget.js";
import type { KeetaRemeasureRow } from "./buy.js";
import {
  KEETA_MAX_PER_MONTH_ATOMIC,
  KEETA_MAX_PER_RUN_ATOMIC,
  KEETA_MAX_PURCHASES_PER_RUN,
} from "./constants.js";

export interface KeetaPlanProbe {
  url: string;
  host: string;
  expectedPayTo: string;
  priceUsdc: string;
  at?: string;
}

export interface KeetaDryRunFile {
  kind: "vet402-remeasure-dry-run";
  chain: "keeta";
  createdAt: string;
  perPayTo: 1;
  caps: { perRun: string; monthLeft: string };
  summary: { would: number; estimate: string; payerUsdcBefore: string };
  rows: KeetaRemeasureRow[];
  signer: { problem?: string; warn?: string };
  payer: string;
}

function planBudget(monthSpent: bigint, monthCount: number, daySeed: { spent: bigint; count: number }, date: string): KeetaBudget {
  return new KeetaBudget(null, KEETA_MAX_PER_RUN_ATOMIC, KEETA_MAX_PURCHASES_PER_RUN, date, daySeed, { spent: monthSpent, count: monthCount });
}

export function applyKeetaCapsToPlanRows(
  rows: KeetaRemeasureRow[],
  opts: { monthSpent: bigint; monthCount: number; daySeed: { spent: bigint; count: number }; balance: bigint; date: string },
): { monthCut: number; payableCount: number } {
  const budget = planBudget(opts.monthSpent, opts.monthCount, opts.daySeed, opts.date);
  let payableCount = 0;
  let monthCut = 0;
  let runWould = 0;
  for (const row of rows) {
    if (row.outcome !== "would_pay" || !row.priceUsdc) continue;
    payableCount += 1;
    const amount = toAtomic(row.priceUsdc);
    const res = budget.reserve(amount, row.key, opts.balance);
    if ("refused" in res) {
      row.outcome = "refused";
      row.reason = res.refused;
      row.detail = res.detail ?? null;
      if (isKeetaMonthCapRefusal({ refused: res.refused, detail: res.detail })) monthCut += 1;
    } else {
      budget.commit(res.id);
      runWould += 1;
    }
    if (runWould >= KEETA_MAX_PURCHASES_PER_RUN) break;
  }
  return { monthCut, payableCount };
}

export function keetaMonthCapWarn(would: number, payableCount: number, monthSpent: bigint): string | undefined {
  const monthLeftAtomic = KEETA_MAX_PER_MONTH_ATOMIC - monthSpent;
  const monthLeftUsdc = atomicToUsdc(monthLeftAtomic > 0n ? monthLeftAtomic : 0n);
  if (payableCount <= would) return undefined;
  return `Keeta month cap: ${would} of ${payableCount} payable routes fit in what is left this month (${monthLeftUsdc} USDC), buying those`;
}

export function buildKeetaPlan(opts: {
  probes: KeetaPlanProbe[];
  monthSpent: bigint;
  monthCount: number;
  daySeed: { spent: bigint; count: number };
  balance: bigint;
  now: Date;
  payer: string;
  date: string;
  signerProblem?: string | null;
}): KeetaDryRunFile {
  const { probes, monthSpent, monthCount, daySeed, balance, now, payer, date, signerProblem } = opts;
  const at = now.toISOString();
  const monthLeftAtomic = KEETA_MAX_PER_MONTH_ATOMIC - monthSpent;
  const monthLeftUsdc = atomicToUsdc(monthLeftAtomic > 0n ? monthLeftAtomic : 0n);
  const perRunLeft = KEETA_MAX_PER_RUN_ATOMIC - daySeed.spent;
  const rows: KeetaRemeasureRow[] = probes.map((p, i) => ({
    at: p.at ?? at,
    chain: "keeta",
    host: p.host,
    service: null,
    url: p.url,
    requestUrl: p.url,
    payTo: p.expectedPayTo,
    expectedPayTo: p.expectedPayTo,
    outcome: "would_pay",
    reason: "would_pay",
    detail: null,
    settled: null,
    delivered: null,
    httpStatus: 402,
    bodyBytes: null,
    tx: null,
    sellerTx: null,
    priceUsdc: p.priceUsdc,
    slot: i + 1,
    key: keetaBudgetKey(date, p.url),
  }));
  const { monthCut, payableCount } = applyKeetaCapsToPlanRows(rows, { monthSpent, monthCount, daySeed, balance, date });
  const would = rows.filter((r) => r.outcome === "would_pay");
  const estProper = atomicToUsdc(would.reduce((a, r) => a + (r.priceUsdc ? toAtomic(r.priceUsdc) : 0n), 0n));
  const signer: KeetaDryRunFile["signer"] = {};
  if (signerProblem) signer.problem = signerProblem;
  if (monthCut > 0) {
    signer.warn = keetaMonthCapWarn(would.length, payableCount, monthSpent);
  }
  return {
    kind: "vet402-remeasure-dry-run",
    chain: "keeta",
    createdAt: at,
    perPayTo: 1,
    caps: {
      perRun: atomicToUsdc(perRunLeft > 0n ? perRunLeft : 0n),
      monthLeft: monthLeftUsdc,
    },
    summary: { would: would.length, estimate: estProper, payerUsdcBefore: atomicToUsdc(balance) },
    rows,
    signer,
    payer,
  };
}

/** Read month and day caps from a budget file path (missing file → zeros). */
export function keetaLedgerCaps(monthFile: string, dayUtc: string): { monthSpent: bigint; monthCount: number; daySeed: { spent: bigint; count: number } } {
  const monthLedger = new KeetaBudget(monthFile, KEETA_MAX_PER_RUN_ATOMIC, KEETA_MAX_PURCHASES_PER_RUN, dayUtc);
  return {
    monthSpent: monthLedger.spent,
    monthCount: monthLedger.count,
    daySeed: keetaDayTotalsFromLedger(monthFile, dayUtc),
  };
}