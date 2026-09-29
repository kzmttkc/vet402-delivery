/**
 * Remeasure on Tempo. Money moves only through src/tempo/pay.ts payOne (live 402, guard with the
 * recipient and price locks, balance, Ledger written before signing, signed-tx check), called as is,
 * and a run stops on the same outcomes as the census (stopReason).
 *
 * Ledgers: one Tempo Ledger per UTC day, results/remeasure/tempo-ledger-YYYY-MM-DD.json, capped at the
 * run cap (1 USDC.e, so also at most 1 USDC.e a day). The Ledger allows one purchase per key per file,
 * so a service is bought at most once a day. The month cap (30 USDC.e) is the sum of the month's day
 * ledgers, checked before every attempt.
 *
 * payOne's chain check (USDC.e that left the payer on chain > the ledger's committed amount -> stop)
 * needs the outflow since this ledger started, not since the census: tempo-start-YYYY-MM-DD.json keeps
 * the block the day ledger started at, written once before its first reservation.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseAbiItem, type Hex } from "viem";
import { SellerPacer } from "../measure.js";
import { MEASURE_MAX_PER_SELLER } from "../constants.js";
import { FEE_RESERVE_ATOMIC, PAYER_ADDRESS, USDC_E, atomicToUnits, normAddr } from "../tempo/constants.js";
import { checkCharge, pickTempoCharge } from "../tempo/guard.js";
import { tempoChargeRequest } from "../tempo/challenge.js";
import { Ledger } from "../tempo/ledger.js";
import { payOne, stopReason, type PayDeps, type PayOutcome } from "../tempo/pay.js";
import { probeUnpaid } from "../tempo/probe.js";
import type { FetchLike } from "../tempo/mercator.js";
import { publicClient } from "../tempo/chain.js";
import type { PlanEntry } from "../tempo/census.js";
import { RM_TEMPO_MAX_PER_MONTH_ATOMIC, RM_TEMPO_MAX_PER_RUN_ATOMIC } from "./constants.js";
import { runSlots, type AttemptResult, type LoopResult, type Slot } from "./loop.js";
import type { RemeasureRow } from "./results.js";

export const DAY_LEDGER = /^tempo-ledger-(\d{4}-\d{2})-(\d{2})\.json$/;

export function dayLedgerPath(dir: string, date: string): string {
  return join(dir, `tempo-ledger-${date}.json`);
}
export function startBlockPath(dir: string, date: string): string {
  return join(dir, `tempo-start-${date}.json`);
}

/** Committed USDC.e (amount + fee reserve) of every day ledger in `month` (YYYY-MM) except `skipDate`. */
export function monthCommittedElsewhere(dir: string, month: string, skipDate: string): bigint {
  if (!existsSync(dir)) return 0n;
  let sum = 0n;
  for (const name of readdirSync(dir)) {
    const m = DAY_LEDGER.exec(name);
    if (!m || m[1] !== month || `${m[1]}-${m[2]}` === skipDate) continue;
    // Read only (no lock); the constructor refuses a file for another payer or of another shape.
    sum += new Ledger(join(dir, name), PAYER_ADDRESS, RM_TEMPO_MAX_PER_RUN_ATOMIC).committed();
  }
  return sum;
}

/** The block the day ledger started at. Written once (O_EXCL); a later run the same day reads it. */
export async function ensureStartBlock(file: string, head: () => Promise<bigint>, now: Date = new Date()): Promise<bigint> {
  if (existsSync(file)) {
    const s = JSON.parse(readFileSync(file, "utf8")) as { block?: string };
    if (!s.block || !/^\d+$/.test(s.block)) throw new Error(`${file}: no start block; refusing to pay`);
    return BigInt(s.block);
  }
  const b = await head();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ block: b.toString(), at: now.toISOString() }) + "\n", { flag: "wx" });
  return b;
}

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 amount)");
const LOG_RANGE = 99_999n;

/** USDC.e the owner sent from `fromBlock` on (Transfer logs), the same read as usdcOutflowSinceStart. */
export async function usdcOutflowSince(owner: string, fromBlock: bigint): Promise<bigint> {
  const c = publicClient();
  const head = await c.getBlockNumber();
  let sum = 0n;
  for (let from = fromBlock; from <= head; from += LOG_RANGE + 1n) {
    const to = from + LOG_RANGE > head ? head : from + LOG_RANGE;
    const logs = await c.getLogs({ address: USDC_E as Hex, event: TRANSFER, args: { from: owner as Hex }, fromBlock: from, toBlock: to });
    for (const l of logs) sum += l.args.amount ?? 0n;
  }
  return sum;
}

const MISMATCH = /recipient\s+(0x[0-9a-fA-F]{40})\s*!=/;

export function tempoRow(
  s: Slot,
  o: Pick<PayOutcome, "result" | "refusal" | "httpStatus" | "txHash" | "settled" | "delivered" | "bodyBytes" | "detail">,
  at: string,
  extra: { livePayTo: string | null; amountAtomic: string | null; would?: boolean },
): RemeasureRow {
  const t = s.target;
  const r = o.refusal;
  const livePayTo = extra.livePayTo ?? (r?.refused === "recipient_mismatch" ? (MISMATCH.exec(r.detail)?.[1] ?? null) : null);
  const sent = o.result === "sent";
  return {
    at,
    chain: "tempo",
    host: t.host,
    service: t.service,
    url: t.url,
    requestUrl: t.requestUrl,
    payTo: livePayTo ? normAddr(livePayTo) : sent || extra.would ? t.payTo : null,
    expectedPayTo: t.payTo,
    outcome: extra.would ? "would_pay" : o.result,
    reason: r ? (r.refused === "recipient_mismatch" ? "pay_to_changed" : r.refused) : extra.would ? "would_pay" : o.result,
    detail: r ? r.detail : (o.detail ?? null),
    settled: sent ? (o.settled ?? null) : null,
    delivered: sent ? o.delivered === true : null,
    httpStatus: o.httpStatus ?? null,
    bodyBytes: sent ? (o.bodyBytes ?? null) : null,
    tx: o.txHash ?? null,
    priceUsdc: atomicToUnits(extra.amountAtomic ?? t.amountAtomic),
    slot: s.slot,
  };
}

/** The Ledger key: the service id, with the slot number when a service is bought more than once a day. */
export function ledgerKey(s: Slot): string {
  const id = s.target.service!;
  return s.slot === 0 ? id : `${id}~${s.slot + 1}`;
}

function entryFor(s: Slot): PlanEntry {
  const p = s.target.tempo?.plan;
  if (!p) throw new Error(`not a Tempo target: ${s.target.url}`);
  return { ...p, serviceId: ledgerKey(s) };
}

function fits(ledger: Ledger, monthElsewhere: bigint, monthCap: bigint) {
  return (s: Slot): string | null => {
    // The fee reserve is always counted here, even when the plan says sponsored: the live 402 may not be.
    const need = BigInt(s.target.amountAtomic) + FEE_RESERVE_ATOMIC;
    const day = ledger.committed();
    if (day + need > ledger.cap) return `total_cap_reached: run/day ${day} + ${need} > ${ledger.cap}`;
    if (monthElsewhere + day + need > monthCap) return `month_cap_reached: ${monthElsewhere + day} + ${need} > ${monthCap}`;
    return null;
  };
}

export interface TempoRunDeps {
  ledger: Ledger;
  /** Committed in this month's other day ledgers. */
  monthElsewhere: bigint;
  monthCap?: bigint;
  now?: () => Date;
  sleep: (ms: number) => Promise<void>;
  pacer?: SellerPacer;
  onRow?: (row: RemeasureRow) => void;
}

function paidAmount(ledger: Ledger, key: string): string | null {
  const e = [...ledger.entries()].reverse().find((x) => x.key === key && x.status !== "refused_before_sign");
  return e?.amount ?? null;
}

/** --pay: buy each slot through the Tempo payOne; stop where the census stops (stopReason). */
export async function payTempo(slots: readonly Slot[], pay: Omit<PayDeps, "ledger">, deps: TempoRunDeps): Promise<LoopResult> {
  const now = deps.now ?? (() => new Date());
  return runSlots(slots, {
    pacer: deps.pacer ?? new SellerPacer(),
    sleep: deps.sleep,
    fits: fits(deps.ledger, deps.monthElsewhere, deps.monthCap ?? RM_TEMPO_MAX_PER_MONTH_ATOMIC),
    ...(deps.onRow ? { onRow: deps.onRow } : {}),
    attempt: async (s): Promise<AttemptResult> => {
      const at = now().toISOString();
      const entry = entryFor(s);
      const o = await payOne(entry, { ...pay, ledger: deps.ledger });
      const row = tempoRow(s, o, at, { livePayTo: null, amountAtomic: o.result === "refused" ? null : paidAmount(deps.ledger, entry.serviceId) });
      return { row, stop: stopReason(o) };
    },
  });
}

/**
 * --dry-run: the unpaid 402 and the guard payOne runs (recipient and price locks), then the caps
 * simulated on an in-memory ledger. Nothing is signed; no key is loaded.
 */
export async function dryRunTempo(
  slots: readonly Slot[],
  fetchImpl: FetchLike,
  deps: { monthElsewhere: bigint; monthCommittedToday: bigint; monthCap?: bigint; now?: () => Date; onRow?: (row: RemeasureRow) => void },
): Promise<LoopResult> {
  const now = deps.now ?? (() => new Date());
  const sim = new Ledger(null, PAYER_ADDRESS, RM_TEMPO_MAX_PER_RUN_ATOMIC);
  const probes = new Map<string, Awaited<ReturnType<typeof probeUnpaid>>>();
  return runSlots(slots, {
    pacer: new SellerPacer(MEASURE_MAX_PER_SELLER, 0),
    sleep: async () => undefined,
    fits: fits(sim, deps.monthElsewhere + deps.monthCommittedToday, deps.monthCap ?? RM_TEMPO_MAX_PER_MONTH_ATOMIC),
    continueAfterCap: true,
    ...(deps.onRow ? { onRow: deps.onRow } : {}),
    attempt: async (s): Promise<AttemptResult> => {
      const entry = entryFor(s);
      const k = `${entry.request.method} ${entry.request.url} ${entry.request.body ?? ""}`;
      let p = probes.get(k);
      if (!p) {
        p = await probeUnpaid(fetchImpl, entry.request);
        probes.set(k, p);
      }
      const at = now().toISOString();
      if (p.httpStatus !== 402) {
        const refusal = { refused: "no_tempo_charge" as const, detail: `unpaid status ${p.httpStatus ?? "none"}${p.error ? `: ${p.error}` : ""}` };
        return { row: tempoRow(s, { result: "refused", refusal }, at, { livePayTo: null, amountAtomic: null }), stop: null };
      }
      const ch = pickTempoCharge(p.challenges, entry.lockedRecipient);
      const req = ch ? tempoChargeRequest(ch) : null;
      const live = req?.recipient ?? null;
      const r = checkCharge(ch, { payer: PAYER_ADDRESS, lockedRecipient: entry.lockedRecipient, lockedAmount: entry.lockedAmount, allowlist: entry.allowlist, now: now() });
      if (r) return { row: tempoRow(s, { result: "refused", refusal: r }, at, { livePayTo: live, amountAtomic: req?.amount ?? null }), stop: null };
      const res = sim.reserve({ key: entry.serviceId, url: entry.request.url, recipient: req!.recipient!, amount: BigInt(req!.amount), sponsored: req!.feePayer }, 0n, now());
      if ("refused" in res) return { row: tempoRow(s, { result: "refused", refusal: res }, at, { livePayTo: live, amountAtomic: req!.amount }), stop: null };
      return { row: tempoRow(s, { result: "refused" }, at, { livePayTo: live, amountAtomic: req!.amount, would: true }), stop: null };
    },
  });
}
