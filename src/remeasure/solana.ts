/**
 * Remeasure on Solana. Money moves only through src/pay.ts payOne (payTo lock, guard, transaction
 * read-back, Budget written before signing), called as is.
 *
 * payOne uses PlanEntry.host as the Budget key; remeasure passes `<date>|<payTo>|<slot>` there
 * (./budget.ts) and takes the seller's host from the target instead.
 */
import { PAYER_ADDRESS, atomicToUsdc } from "../constants.js";
import { checkAccept, pickSolanaAccept } from "../guard.js";
import { payOne, probe402, type PayDeps, type PlanEntry, type PurchaseRecord } from "../pay.js";
import { SellerPacer } from "../measure.js";
import { MEASURE_MAX_PER_SELLER } from "../constants.js";
import { budgetKey, type RemeasureBudget } from "./budget.js";
import { runSlots, type AttemptResult, type LoopResult, type Slot } from "./loop.js";
import type { RemeasureRow } from "./results.js";

/** Refusals after which nothing more is attempted in this run. */
const STOP_ON = new Set(["total_cap_reached", "purchase_count_reached", "ledger_unreadable", "tx_check_failed"]);

export function reasonOf(refused: string): string {
  return refused === "payto_mismatch" ? "pay_to_changed" : refused;
}

export function solanaRow(s: Slot, rec: Pick<PurchaseRecord, "outcome" | "probe" | "refusal" | "priceUsdc" | "signature" | "settled" | "delivered" | "response">, at: string, key: string): RemeasureRow {
  const t = s.target;
  const sent = rec.outcome === "sent";
  return {
    at,
    chain: "solana",
    host: t.host,
    service: null,
    url: t.url,
    requestUrl: t.requestUrl,
    payTo: rec.probe.payTo,
    expectedPayTo: t.payTo,
    outcome: rec.outcome === "would_pay" ? "would_pay" : rec.outcome,
    reason: rec.refusal ? reasonOf(rec.refusal.refused) : rec.outcome,
    detail: rec.refusal ? rec.refusal.detail : sent ? (rec.response?.first300 ?? rec.response?.error ?? null) : null,
    settled: sent ? rec.settled === true : null,
    delivered: sent ? rec.delivered === true : null,
    httpStatus: sent ? (rec.response?.status ?? null) : rec.probe.status,
    bodyBytes: null,
    tx: rec.signature ?? null,
    priceUsdc: rec.priceUsdc ?? (rec.probe.amount && /^\d+$/.test(rec.probe.amount) ? atomicToUsdc(rec.probe.amount) : atomicToUsdc(t.amountAtomic)),
    slot: s.slot,
    key,
  };
}

function planEntry(s: Slot, date: string): PlanEntry {
  const lock = s.target.solana?.lock;
  if (!lock) throw new Error(`not a Solana target: ${s.target.url}`);
  return { host: budgetKey(date, s.target.payTo, s.slot), requestUrl: s.target.requestUrl, exampleInput: null, lock };
}

export interface SolanaRunDeps {
  date: string;
  budget: RemeasureBudget;
  now?: () => Date;
  sleep: (ms: number) => Promise<void>;
  pacer?: SellerPacer;
  onRow?: (row: RemeasureRow) => void;
}

function fits(budget: RemeasureBudget) {
  return (s: Slot): string | null => {
    const a = BigInt(s.target.amountAtomic);
    if (budget.runSpentAtomic + a > budget.runCap) return `total_cap_reached: run ${budget.runSpentAtomic} + ${a} > ${budget.runCap}`;
    if (budget.spent + a > budget.maxTotal) return `total_cap_reached: month ${budget.spent} + ${a} > ${budget.maxTotal}`;
    return null;
  };
}

/** --pay: buy each slot through payOne. Stops on a cap, a ledger problem, a rejected transaction, or SOL going down. */
export async function paySolana(slots: readonly Slot[], pay: Omit<PayDeps, "budget" | "judge" | "dryRun">, deps: SolanaRunDeps): Promise<LoopResult> {
  const now = deps.now ?? (() => new Date());
  return runSlots(slots, {
    pacer: deps.pacer ?? new SellerPacer(),
    sleep: deps.sleep,
    fits: fits(deps.budget),
    ...(deps.onRow ? { onRow: deps.onRow } : {}),
    attempt: async (s): Promise<AttemptResult> => {
      const at = now().toISOString();
      const rec = await payOne(planEntry(s, deps.date), { ...pay, budget: deps.budget, ownAddresses: [PAYER_ADDRESS] });
      const row = solanaRow(s, rec, at, budgetKey(deps.date, s.target.payTo, s.slot));
      if (rec.solDecreased) return { row, stop: `payer SOL decreased after ${s.target.host}` };
      const r = rec.refusal?.refused;
      return { row, stop: r && STOP_ON.has(r) ? r : null };
    },
  });
}

/**
 * --dry-run: the unpaid 402 and every accept check payOne makes, then the caps simulated on an in-memory
 * budget. Nothing is built or signed. The same URL is probed once even when it has several slots.
 */
export async function dryRunSolana(slots: readonly Slot[], fetchImpl: typeof fetch, deps: Omit<SolanaRunDeps, "sleep" | "pacer">): Promise<LoopResult> {
  const now = deps.now ?? (() => new Date());
  const probes = new Map<string, Awaited<ReturnType<typeof probe402>>>();
  return runSlots(slots, {
    pacer: new SellerPacer(MEASURE_MAX_PER_SELLER, 0),
    sleep: async () => undefined,
    fits: fits(deps.budget),
    continueAfterCap: true,
    ...(deps.onRow ? { onRow: deps.onRow } : {}),
    attempt: async (s): Promise<AttemptResult> => {
      const lock = s.target.solana!.lock;
      let p = probes.get(s.target.requestUrl);
      if (!p) {
        p = await probe402(s.target.requestUrl, fetchImpl);
        probes.set(s.target.requestUrl, p);
      }
      const a = pickSolanaAccept(p.accepts, lock.payTo);
      const probe: PurchaseRecord["probe"] = {
        status: p.status,
        x402Version: p.x402Version,
        payTo: a?.payTo ?? null,
        amount: a?.amount ?? null,
        asset: a?.asset ?? null,
        feePayer: typeof a?.extra?.feePayer === "string" ? a.extra.feePayer : null,
        ...(p.error ? { error: p.error } : {}),
      };
      const at = now().toISOString();
      if (p.status !== 402 || !p.paymentRequired) {
        const refusal = { refused: "no_solana_accept" as const, detail: `unpaid request returned ${p.status ?? "no response"}${p.error ? `: ${p.error}` : ""}` };
        return { row: solanaRow(s, { outcome: "refused", probe, refusal }, at, budgetKey(deps.date, s.target.payTo, s.slot)), stop: null };
      }
      const r = checkAccept(a, { payer: PAYER_ADDRESS, lockedPayTo: lock.payTo, lockedAmount: lock.amount, ownAddresses: [PAYER_ADDRESS] });
      if (r) return { row: solanaRow(s, { outcome: "refused", probe, refusal: r }, at, budgetKey(deps.date, s.target.payTo, s.slot)), stop: null };
      const res = deps.budget.reserve(BigInt(a!.amount), budgetKey(deps.date, s.target.payTo, s.slot), null);
      if ("refused" in res) return { row: solanaRow(s, { outcome: "refused", probe, refusal: res }, at, budgetKey(deps.date, s.target.payTo, s.slot)), stop: null };
      deps.budget.commit(res.id);
      return { row: solanaRow(s, { outcome: "would_pay", probe, priceUsdc: atomicToUsdc(a!.amount) }, at, budgetKey(deps.date, s.target.payTo, s.slot)), stop: null };
    },
  });
}
