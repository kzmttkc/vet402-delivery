/**
 * Remeasure on Tempo. Money moves only through src/tempo/pay.ts payOne (live 402, guard with the
 * recipient and price locks, balance, Ledger written before signing, signed-tx check), called as is,
 * and a run stops on the same outcomes as the census (stopReason).
 *
 * Ledgers: one Tempo Ledger per UTC day, <RM_PROD_DIR>/tempo-ledger-YYYY-MM-DD.json, capped at the run cap
 * (1 USDC.e, so also at most 1 USDC.e a day). The key is `<date>|<payTo>|<slot>`: one purchase per payTo
 * and slot per day, whichever of the payTo's services it is.
 *
 * Two chain bounds, neither of which a deleted file can reopen:
 *  - payOne's own check, fed by src/tempo/key-ledgers.ts: USDC.e out of the key since CENSUS_START_BLOCK
 *    must not exceed this day ledger's committed amount plus what the census ledger and the other day
 *    ledgers account for. A lost ledger makes its payments unaccounted, and nothing more is signed.
 *  - the month cap: spent this month = max(the month's day ledgers, USDC.e out of the key since the
 *    month's first block). The chain side also counts census purchases that month (errs on the safe side).
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
import { CENSUS_START_BLOCK, publicClient, usdcOutflowSinceStart } from "../tempo/chain.js";
import { assertDayLedgersPresent, unaccountedChainSpent, type KeyLedgerSet } from "../tempo/key-ledgers.js";
import type { PlanEntry } from "../tempo/census.js";
import { checkInput, INPUT_REJECT_STATUSES, type InputCheck } from "../tempo/answer.js";
import { RM_PAID_TIMEOUT_MS, RM_TEMPO_MAX_PER_MONTH_ATOMIC, RM_TEMPO_MAX_PER_RUN_ATOMIC } from "./constants.js";
import { budgetKey } from "./budget.js";
import { runSlots, type AttemptResult, type LoopResult, type Slot } from "./loop.js";
import type { RemeasureRow } from "./results.js";

export const DAY_LEDGER = /^tempo-ledger-(\d{4}-\d{2})-(\d{2})\.json$/;

export function dayLedgerPath(dir: string, date: string): string {
  return join(dir, `tempo-ledger-${date}.json`);
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

/** Chain reads the Tempo run needs. Injected so tests can play the chain. */
export interface TempoChainView {
  /** USDC.e that left the key since CENSUS_START_BLOCK. */
  outflowSinceCensusStart(): Promise<bigint>;
  /** USDC.e that left the key since the first block of `month` (YYYY-MM, UTC). */
  outflowSinceMonthStart(month: string): Promise<bigint>;
}

/** First block whose timestamp is at or after `tsSec`, searched in [lo, head]. */
export async function firstBlockAtOrAfter(tsSec: bigint, lo: bigint, head: bigint, tsOf: (b: bigint) => Promise<bigint>): Promise<bigint> {
  if ((await tsOf(lo)) >= tsSec) return lo;
  if ((await tsOf(head)) < tsSec) return head + 1n;
  let a = lo; // ts(a) < tsSec
  let b = head; // ts(b) >= tsSec
  while (b - a > 1n) {
    const m = (a + b) / 2n;
    if ((await tsOf(m)) >= tsSec) b = m;
    else a = m;
  }
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

/** The live chain: census-start outflow as the census reads it; the month's first block found by block time. */
export function liveChainView(owner: string = PAYER_ADDRESS): TempoChainView {
  const monthStart = new Map<string, bigint>();
  return {
    outflowSinceCensusStart: () => usdcOutflowSinceStart(owner),
    async outflowSinceMonthStart(month) {
      let b = monthStart.get(month);
      if (b === undefined) {
        const c = publicClient();
        const ts = BigInt(Date.parse(`${month}-01T00:00:00Z`) / 1000);
        b = await firstBlockAtOrAfter(ts, CENSUS_START_BLOCK, await c.getBlockNumber(), async (n) => (await c.getBlock({ blockNumber: n })).timestamp);
        monthStart.set(month, b);
      }
      return usdcOutflowSince(owner, b);
    },
  };
}

const MISMATCH = /recipient\s+(0x[0-9a-fA-F]{40})\s*!=/;

/** The request a Tempo target sends, judged against the catalog example it was built from (src/tempo/answer.ts). */
export function targetInput(s: Slot): InputCheck | null {
  const req = s.target.tempo?.plan.request;
  if (!req) return null;
  try {
    return checkInput(req);
  } catch {
    return null;
  }
}

/**
 * A slot whose request carries a placeholder (`{"ip":"string"}`, `"<from x/y>"`, a `*` path) and whose settled
 * census purchase of the same request got 400, 404 or 422 back is not bought again: vet402 already knows the
 * seller cannot answer it, and another failure would say nothing about the seller. Recorded as refused,
 * `placeholder_input` (vet402's own skip, never the seller's). Any other census answer (2xx, a search for
 * "string"; 402; 401; 5xx) is still bought and measured. Checked before payOne; payOne is unchanged.
 */
function placeholderRefusal(s: Slot, input: InputCheck | null): { refused: "placeholder_input"; detail: string } | null {
  const census = s.target.tempo?.censusHttpStatus ?? null;
  if (!input || input.placeholders.length === 0 || census === null || !INPUT_REJECT_STATUSES.has(census)) return null;
  return { refused: "placeholder_input", detail: `placeholders: ${input.placeholders.join(", ")}` };
}

export function tempoRow(
  s: Slot,
  o: Pick<PayOutcome, "result" | "httpStatus" | "txHash" | "settled" | "delivered" | "bodyBytes" | "detail" | "answer"> & { refusal?: { refused: string; detail: string } },
  at: string,
  extra: { key: string; livePayTo: string | null; amountAtomic: string | null; would?: boolean },
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
    key: extra.key,
    input: targetInput(s),
    answer: sent ? (o.answer ?? null) : null,
  };
}

function entryFor(s: Slot, date: string): PlanEntry {
  const p = s.target.tempo?.plan;
  if (!p) throw new Error(`not a Tempo target: ${s.target.url}`);
  // payOne uses serviceId only as the Ledger key and to label the outcome.
  return { ...p, serviceId: budgetKey(date, s.target.payTo, s.slot) };
}

function fits(ledger: Ledger, monthElsewhere: bigint, monthCap: bigint, monthChain: () => Promise<bigint>, intact: () => string | null = () => null) {
  return async (s: Slot): Promise<string | null> => {
    const lost = intact();
    if (lost) return lost;
    // The fee reserve is always counted here, even when the plan says sponsored: the live 402 may not be.
    const need = BigInt(s.target.amountAtomic) + FEE_RESERVE_ATOMIC;
    const day = ledger.committed();
    if (day + need > ledger.cap) return `total_cap_reached: run/day ${day} + ${need} > ${ledger.cap}`;
    const books = monthElsewhere + day;
    const chain = await monthChain();
    const spent = chain > books ? chain : books;
    if (spent + need > monthCap) return `month_cap_reached: ${spent} (ledgers ${books}, chain ${chain}) + ${need} > ${monthCap}`;
    return null;
  };
}

export interface TempoRunDeps {
  date: string;
  /** The day ledger, opened with a path (and the lock) by the caller. */
  ledger: Ledger;
  /** Every ledger the key pays from (census + remeasure day ledgers). */
  keyLedgers: KeyLedgerSet;
  chain: TempoChainView;
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
export async function payTempo(slots: readonly Slot[], pay: Omit<PayDeps, "ledger" | "chainSpent">, deps: TempoRunDeps): Promise<LoopResult> {
  const now = deps.now ?? (() => new Date());
  if (!deps.ledger.path) throw new Error("payTempo: the day ledger needs a file");
  const chainSpent = unaccountedChainSpent(deps.ledger.path, () => deps.chain.outflowSinceCensusStart(), pay.payer, deps.keyLedgers);
  const month = deps.date.slice(0, 7);
  return runSlots(slots, {
    pacer: deps.pacer ?? new SellerPacer(),
    sleep: deps.sleep,
    fits: fits(deps.ledger, deps.monthElsewhere, deps.monthCap ?? RM_TEMPO_MAX_PER_MONTH_ATOMIC, () => deps.chain.outflowSinceMonthStart(month), () => {
      // A day ledger listed in the index has gone: its payments could hide in this ledger's fee-reserve room.
      try {
        assertDayLedgersPresent(deps.keyLedgers);
        return null;
      } catch (e) {
        return `key_ledger_missing: ${(e as Error).message}`;
      }
    }),
    ...(deps.onRow ? { onRow: deps.onRow } : {}),
    attempt: async (s): Promise<AttemptResult> => {
      const at = now().toISOString();
      const entry = entryFor(s, deps.date);
      const skip = placeholderRefusal(s, targetInput(s));
      if (skip) return { row: tempoRow(s, { result: "refused", refusal: skip }, at, { key: entry.serviceId, livePayTo: null, amountAtomic: null }), stop: null };
      const o = await payOne(entry, { ...pay, paidTimeoutMs: pay.paidTimeoutMs ?? RM_PAID_TIMEOUT_MS, ledger: deps.ledger, chainSpent });
      const row = tempoRow(s, o, at, { key: entry.serviceId, livePayTo: null, amountAtomic: o.result === "refused" ? null : paidAmount(deps.ledger, entry.serviceId) });
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
  deps: { date: string; monthElsewhere: bigint; monthCommittedToday: bigint; monthChainOutflow?: bigint; monthCap?: bigint; now?: () => Date; onRow?: (row: RemeasureRow) => void },
): Promise<LoopResult> {
  const now = deps.now ?? (() => new Date());
  const sim = new Ledger(null, PAYER_ADDRESS, RM_TEMPO_MAX_PER_RUN_ATOMIC);
  const probes = new Map<string, Awaited<ReturnType<typeof probeUnpaid>>>();
  const monthChain = deps.monthChainOutflow ?? 0n;
  return runSlots(slots, {
    pacer: new SellerPacer(MEASURE_MAX_PER_SELLER, 0),
    sleep: async () => undefined,
    // The chain figure is read once; the simulated purchases add to the ledger side.
    fits: fits(sim, deps.monthElsewhere + deps.monthCommittedToday, deps.monthCap ?? RM_TEMPO_MAX_PER_MONTH_ATOMIC, async () => monthChain + sim.committed()),
    continueAfterCap: true,
    ...(deps.onRow ? { onRow: deps.onRow } : {}),
    attempt: async (s): Promise<AttemptResult> => {
      const entry = entryFor(s, deps.date);
      const key = entry.serviceId;
      const skip = placeholderRefusal(s, targetInput(s));
      if (skip) return { row: tempoRow(s, { result: "refused", refusal: skip }, now().toISOString(), { key, livePayTo: null, amountAtomic: null }), stop: null };
      const k = `${entry.request.method} ${entry.request.url} ${entry.request.body ?? ""}`;
      let p = probes.get(k);
      if (!p) {
        p = await probeUnpaid(fetchImpl, entry.request);
        probes.set(k, p);
      }
      const at = now().toISOString();
      if (p.httpStatus !== 402) {
        const refusal = { refused: "no_tempo_charge" as const, detail: `unpaid status ${p.httpStatus ?? "none"}${p.error ? `: ${p.error}` : ""}` };
        return { row: tempoRow(s, { result: "refused", refusal }, at, { key, livePayTo: null, amountAtomic: null }), stop: null };
      }
      const ch = pickTempoCharge(p.challenges, entry.lockedRecipient);
      const req = ch ? tempoChargeRequest(ch) : null;
      const live = req?.recipient ?? null;
      const r = checkCharge(ch, { payer: PAYER_ADDRESS, lockedRecipient: entry.lockedRecipient, lockedAmount: entry.lockedAmount, allowlist: entry.allowlist, now: now() });
      if (r) return { row: tempoRow(s, { result: "refused", refusal: r }, at, { key, livePayTo: live, amountAtomic: req?.amount ?? null }), stop: null };
      const res = sim.reserve({ key, url: entry.request.url, recipient: req!.recipient!, amount: BigInt(req!.amount), sponsored: req!.feePayer }, 0n, now());
      if ("refused" in res) return { row: tempoRow(s, { result: "refused", refusal: res }, at, { key, livePayTo: live, amountAtomic: req!.amount }), stop: null };
      return { row: tempoRow(s, { result: "refused" }, at, { key, livePayTo: live, amountAtomic: req!.amount, would: true }), stop: null };
    },
  });
}
