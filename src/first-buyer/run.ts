/**
 * First-buyer: the unpaid probe that locks a payTo per host, and the purchase loop.
 *
 * The loop only calls the existing money path (src/pay.ts payOne, with its guard, read-back and
 * Budget). What it adds, in this order, before payOne may sign:
 *   own payTo / opt-out -> ledger eligibility (lifetime once) -> run and month caps would fit
 *   -> chain fence, read live right before the attempt (no USDC ever received by the payTo, from
 *      anyone including vet402; readable to the end; USDC account exists), whatever the ledger says
 *   -> the attempt is written to the ledger (pending) -> payOne.
 * A missing USDC account is the seller's cause of "cannot be paid"; it is reported, and it does not
 * use up the seller's one attempt (the payment could not settle, see receipts.ts).
 * A refusal because the live 402 names another payTo is published as "pay_to_changed".
 */
import { PAYER_ADDRESS, atomicToUsdc } from "../constants.js";
import { checkAccept, pickSolanaAccept } from "../guard.js";
import { payOne, probe402, type PayDeps, type PlanEntry, type PurchaseRecord } from "../pay.js";
import { classifyRecord, failureMode, refusalInput, type Classified } from "../classify.js";
import { judgeDelivery, type Declaration } from "../verdict.js";
import type { CensusCandidate, HostPlan, Source } from "../census.js";
import type { FirstBuyerBudget } from "./budget.js";
import type { FirstBuyerLedger } from "./ledger.js";
import { chainFence, type ReceiptCheck } from "./receipts.js";
import type { Excluded } from "./select.js";

export interface FirstBuyerTarget extends PlanEntry {
  url: string;
  source: Source;
  sources: Source[];
  declared: Declaration;
  priceAtomic: string;
  lastUpdated: string | null;
}

const PROBE_TRIES = 3;

/** Unpaid 402 per host: the first listing (cheapest first) whose live 402 passes every accept check gives the lock. */
export async function probeHost(hp: HostPlan, fetchImpl: typeof fetch, payer: string = PAYER_ADDRESS): Promise<{ target: FirstBuyerTarget | null; excluded: Excluded | null }> {
  let last: Excluded | null = null;
  for (const c of hp.candidates.slice(0, PROBE_TRIES)) {
    const p = await probe402(c.requestUrl, fetchImpl);
    const a = pickSolanaAccept(p.accepts, c.declaredAccept?.payTo);
    const rec: Pick<PurchaseRecord, "probe" | "refusal"> = {
      probe: {
        status: p.status,
        x402Version: p.x402Version,
        payTo: a?.payTo ?? null,
        amount: a?.amount ?? null,
        asset: a?.asset ?? null,
        feePayer: typeof a?.extra?.feePayer === "string" ? a.extra.feePayer : null,
        ...(p.error ? { error: p.error } : {}),
      },
    };
    if (p.status === 402 && p.paymentRequired) {
      const lockedPayTo = c.declaredAccept?.payTo ?? a?.payTo ?? "";
      const r = checkAccept(a, { payer, lockedPayTo });
      if (!r) return { target: toTarget(hp, c, a!), excluded: null };
      rec.refusal = r;
    }
    const input = refusalInput(rec);
    last = { host: hp.host, payTo: rec.probe.payTo, reason: `no_valid_402:${failureMode(input) ?? input.reason}`, detail: `${input.reason}: ${input.detail ?? ""}`.slice(0, 200) };
  }
  return { target: null, excluded: last ?? { host: hp.host, payTo: null, reason: "no_valid_402:other", detail: "no candidate probed" } };
}

function toTarget(hp: HostPlan, c: CensusCandidate, a: NonNullable<ReturnType<typeof pickSolanaAccept>>): FirstBuyerTarget {
  return {
    host: hp.host,
    requestUrl: c.requestUrl,
    exampleInput: c.exampleInput,
    lock: { payTo: a.payTo, amount: a.amount, asset: a.asset, network: a.network, feePayer: String(a.extra!.feePayer) },
    url: c.url,
    source: c.source,
    sources: c.sources,
    declared: c.declared,
    priceAtomic: a.amount,
    lastUpdated: c.lastUpdated ?? null,
  };
}

export interface BuyRow {
  host: string;
  payTo: string;
  outcome: "skipped" | PurchaseRecord["outcome"];
  reason: string;
  detail: string;
  priceUsdc: string | null;
  tx: string | null;
  settled: boolean | null;
  delivered: boolean | null;
  category: string | null;
  receipts: ReceiptCheck | null;
}

export interface BuyDeps {
  pay: Omit<PayDeps, "budget" | "judge" | "ownAddresses">;
  budget: FirstBuyerBudget;
  ledger: FirstBuyerLedger;
  own: ReadonlySet<string>;
  optOut: ReadonlySet<string>;
  checkReceipts: (payTo: string) => Promise<ReceiptCheck>;
  now?: () => Date;
  log?: (row: BuyRow) => void;
  /** Dry run: keep going after the caps are reached, so every target gets a row. */
  continueAfterCap?: boolean;
}

export async function buyAll(targets: FirstBuyerTarget[], deps: BuyDeps): Promise<{ rows: BuyRow[]; stopped: string | null }> {
  const now = deps.now ?? (() => new Date());
  const rows: BuyRow[] = [];
  const push = (r: BuyRow) => {
    rows.push(r);
    deps.log?.(r);
  };
  const skip = (t: FirstBuyerTarget, reason: string, detail: string, receipts: ReceiptCheck | null = null) =>
    push({ host: t.host, payTo: t.lock.payTo, outcome: "skipped", reason, detail, priceUsdc: atomicToUsdc(t.lock.amount), tx: null, settled: null, delivered: null, category: null, receipts });
  const ownList = [...deps.own];

  for (const t of targets) {
    const p = t.lock.payTo;
    if (deps.own.has(p)) {
      skip(t, "own_payto", "payTo is a vet402 address");
      continue;
    }
    if (deps.optOut.has(p)) {
      skip(t, "opted_out", "the seller opted out");
      continue;
    }
    const e = deps.ledger.eligibility(p, now());
    if (!e.ok) {
      skip(t, e.reason, e.detail);
      continue;
    }
    const amount = BigInt(t.lock.amount);
    if (deps.budget.runSpentAtomic + amount > deps.budget.runCap || deps.budget.spent + amount > deps.budget.maxTotal) {
      skip(t, "total_cap_reached", `run ${deps.budget.runSpentAtomic}/${deps.budget.runCap}, month ${deps.budget.spent}/${deps.budget.maxTotal}, next ${amount}`);
      if (deps.continueAfterCap) continue;
      return { rows, stopped: "cap reached" };
    }
    let rc: ReceiptCheck;
    try {
      rc = await deps.checkReceipts(p);
    } catch (e) {
      skip(t, "chain_unreadable", `receipt check threw: ${(e as Error).message}`.slice(0, 200));
      continue;
    }
    const fence = chainFence(rc);
    if (fence) {
      skip(t, fence.reason, fence.detail, rc);
      continue;
    }
    const began = deps.ledger.begin(p, { host: t.host, requestUrl: t.requestUrl, amountAtomic: t.lock.amount }, now());
    if ("refused" in began) {
      skip(t, began.refused, began.detail);
      continue;
    }
    const rec = await payOne(t, { ...deps.pay, budget: deps.budget, ownAddresses: ownList, judge: (d) => judgeDelivery(t.declared, d) });
    const base: Classified = classifyRecord(rec);
    const c: Classified = rec.refusal?.refused === "payto_mismatch" ? { ...base, reason: "pay_to_changed", category: null } : base;
    deps.ledger.finish(p, began.index, rec, c);
    push({
      host: t.host,
      payTo: p,
      outcome: rec.outcome,
      reason: c.reason,
      detail: c.detail,
      priceUsdc: rec.priceUsdc ?? atomicToUsdc(t.lock.amount),
      tx: rec.signature ?? null,
      settled: rec.outcome === "sent" ? rec.settled === true : null,
      delivered: rec.outcome === "sent" ? rec.delivered === true : null,
      category: c.category,
      receipts: rc,
    });
    if (rec.solDecreased) return { rows, stopped: `payer SOL decreased after ${t.host}` };
    const w = rec.refusal?.refused;
    if (w === "total_cap_reached" || w === "purchase_count_reached" || w === "ledger_unreadable") return { rows, stopped: w };
  }
  return { rows, stopped: null };
}
