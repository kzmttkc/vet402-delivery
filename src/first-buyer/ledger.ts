/**
 * The first-buyer ledger: one entry per payTo, for life. Public as written.
 *
 * An attempt is recorded (state "pending") and written to disk BEFORE anything is signed.
 * A pending attempt that never finished (crash, kill) counts as "money may have moved":
 * that payTo is never tried again. Only attempts that ended before a signed payment left the
 * process ("refused", "not_sent") may be retried, at +7 and +30 days from the first attempt.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { SOLANA_MAINNET } from "../constants.js";
import type { Classified } from "../classify.js";
import type { PurchaseRecord } from "../pay.js";
import { FB_BUYER_WALLETS, FB_MAX_ATTEMPTS, FB_NOTE, FB_RECIPROCAL_WINDOW_DAYS, FB_RETRY_AFTER_DAYS } from "./constants.js";

export type AttemptState = "pending" | "sent" | "not_sent" | "refused";

export interface Attempt {
  at: string;
  host: string;
  requestUrl: string;
  amountAtomic: string | null;
  state: AttemptState;
  /** true for "pending" and "sent": the seller may have been paid. */
  moneyMayHaveMoved: boolean;
  tx: string | null;
  settled: boolean | null;
  delivered: boolean | null;
  reason: string | null;
  category: string | null;
  detail: string | null;
}

export interface SellerEntry {
  payTo: string;
  note: string;
  firstAttemptAt: string;
  attempts: Attempt[];
  /** Rule 6: set when this seller bought from vet402 within 90 days of the purchase. Not checked yet. */
  reciprocal: { boughtFromVet402WithinDays: number; value: boolean; checkedAt: string | null };
}

export interface LedgerFile {
  kind: "vet402-first-buyer-ledger";
  version: 1;
  network: string;
  note: string;
  buyerWallets: string[];
  sellers: Record<string, SellerEntry>;
}

export type Eligibility =
  | { ok: true; retry: boolean }
  | { ok: false; reason: "already_bought" | "money_may_have_moved" | "retry_not_due" | "retries_exhausted"; detail: string };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whether this payTo may be attempted at `now`. Pure. */
export function eligibility(entry: SellerEntry | undefined, now: Date): Eligibility {
  if (!entry || entry.attempts.length === 0) return { ok: true, retry: false };
  if (entry.attempts.some((a) => a.state === "sent")) return { ok: false, reason: "already_bought", detail: "a payment to this payTo was sent" };
  if (entry.attempts.some((a) => a.state === "pending" || a.moneyMayHaveMoved)) {
    return { ok: false, reason: "money_may_have_moved", detail: "an attempt did not finish; treated as paid" };
  }
  const n = entry.attempts.length;
  if (n >= FB_MAX_ATTEMPTS) return { ok: false, reason: "retries_exhausted", detail: `${n} attempts, no money moved` };
  const first = Date.parse(entry.firstAttemptAt);
  if (!Number.isFinite(first)) return { ok: false, reason: "money_may_have_moved", detail: "unreadable firstAttemptAt; treated as paid" };
  const due = first + FB_RETRY_AFTER_DAYS[n - 1]! * DAY_MS;
  if (now.getTime() < due) return { ok: false, reason: "retry_not_due", detail: `next try on or after ${new Date(due).toISOString()}` };
  return { ok: true, retry: true };
}

function emptyLedger(): LedgerFile {
  return {
    kind: "vet402-first-buyer-ledger",
    version: 1,
    network: SOLANA_MAINNET,
    note: FB_NOTE,
    buyerWallets: FB_BUYER_WALLETS.map((w) => w.address),
    sellers: {},
  };
}

function validAttempt(a: unknown): a is Attempt {
  const x = a as Attempt;
  return !!x && typeof x.at === "string" && ["pending", "sent", "not_sent", "refused"].includes(x.state) && typeof x.moneyMayHaveMoved === "boolean";
}

/** --init-ledger: create an empty ledger file. Refuses when one already exists. */
export function initLedgerFile(file: string): void {
  if (existsSync(file)) throw new Error(`${file} already exists; not overwritten`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(emptyLedger(), null, 2) + "\n", { flag: "wx" });
}

export class FirstBuyerLedger {
  /**
   * The ledger a --pay run uses. A missing file stops the run: a run somewhere without the ledger
   * must not start from empty. The first run creates it with --init-ledger.
   */
  static openForPay(file: string): FirstBuyerLedger {
    if (!existsSync(file)) {
      throw new Error(`no first-buyer ledger at ${file}; refusing to pay. For the very first run only, create it with --init-ledger.`);
    }
    return new FirstBuyerLedger(file);
  }

  private state: LedgerFile;

  /** `file` null = in memory. `readOnly` = read the file but never write it (dry run). */
  constructor(
    private readonly file: string | null,
    private readonly readOnly = false,
  ) {
    this.state = this.load();
  }

  private load(): LedgerFile {
    if (!this.file || !existsSync(this.file)) return emptyLedger();
    let s: LedgerFile;
    try {
      s = JSON.parse(readFileSync(this.file, "utf8")) as LedgerFile;
    } catch {
      throw new Error(`first-buyer ledger ${this.file} is not valid JSON; refusing to run`);
    }
    if (s?.kind !== "vet402-first-buyer-ledger" || typeof s.sellers !== "object" || s.sellers === null) {
      throw new Error(`first-buyer ledger ${this.file} has an unexpected shape; refusing to run`);
    }
    for (const [k, e] of Object.entries(s.sellers)) {
      if (e?.payTo !== k || !Array.isArray(e.attempts) || !e.attempts.every(validAttempt)) {
        throw new Error(`first-buyer ledger entry ${k} is malformed; refusing to run`);
      }
    }
    return s;
  }

  private persist(): void {
    if (!this.file || this.readOnly) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + "\n");
    renameSync(tmp, this.file);
  }

  get data(): LedgerFile {
    return this.state;
  }

  /** USDC (atomic) of attempts in `month` (YYYY-MM, UTC) where money may have moved. */
  monthSpentAtomic(month: string): bigint {
    let s = 0n;
    for (const e of Object.values(this.state.sellers)) {
      for (const a of e.attempts) {
        if (a.moneyMayHaveMoved && a.at.slice(0, 7) === month && a.amountAtomic && /^\d+$/.test(a.amountAtomic)) s += BigInt(a.amountAtomic);
      }
    }
    return s;
  }

  eligibility(payTo: string, now: Date = new Date()): Eligibility {
    return eligibility(this.state.sellers[payTo], now);
  }

  /**
   * Record an attempt before anything is signed. Returns the attempt index, or the reason
   * this payTo may not be attempted (a second begin for the same payTo in one run is refused).
   */
  begin(payTo: string, a: { host: string; requestUrl: string; amountAtomic: string | null }, now: Date = new Date()): { index: number } | { refused: string; detail: string } {
    const e = this.eligibility(payTo, now);
    if (!e.ok) return { refused: e.reason, detail: e.detail };
    const at = now.toISOString();
    const entry: SellerEntry = this.state.sellers[payTo] ?? {
      payTo,
      note: FB_NOTE,
      firstAttemptAt: at,
      attempts: [],
      reciprocal: { boughtFromVet402WithinDays: FB_RECIPROCAL_WINDOW_DAYS, value: false, checkedAt: null },
    };
    entry.attempts.push({
      at,
      host: a.host,
      requestUrl: a.requestUrl,
      amountAtomic: a.amountAtomic,
      state: "pending",
      moneyMayHaveMoved: true,
      tx: null,
      settled: null,
      delivered: null,
      reason: null,
      category: null,
      detail: null,
    });
    this.state.sellers[payTo] = entry;
    this.persist();
    return { index: entry.attempts.length - 1 };
  }

  /** Close an attempt with what payOne returned. */
  finish(payTo: string, index: number, rec: PurchaseRecord, c: Classified): void {
    const a = this.state.sellers[payTo]?.attempts[index];
    if (!a) throw new Error(`no attempt ${index} for ${payTo}`);
    const sent = rec.outcome === "sent" || rec.outcome === "would_pay";
    a.state = rec.outcome === "sent" ? "sent" : rec.outcome === "not_sent" ? "not_sent" : rec.outcome === "refused" ? "refused" : "sent";
    a.moneyMayHaveMoved = sent;
    a.amountAtomic = rec.probe.amount ?? a.amountAtomic;
    a.tx = rec.signature ?? null;
    a.settled = rec.outcome === "sent" ? rec.settled === true : false;
    a.delivered = rec.outcome === "sent" ? rec.delivered === true : false;
    a.reason = c.reason;
    a.category = c.category;
    a.detail = c.detail || null;
    this.persist();
  }
}
