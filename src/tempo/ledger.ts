/**
 * The persistent ledger for --pay. Written (atomically) before a credential is signed,
 * so a crash between signing and recording still counts the money as spent.
 *
 * Counted against the caps: every entry that is not `refused_before_sign`.
 * A `reserved` entry that never got an outcome stays counted (fail closed).
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_TOTAL_CAP_ATOMIC,
  FEE_RESERVE_ATOMIC,
  MAX_PER_CALL_ATOMIC,
  MAX_PURCHASES,
  MAX_TOTAL_ATOMIC,
} from "./constants.js";
import type { Refusal } from "./guard.js";

export type EntryStatus =
  | "reserved" // written before signing; no outcome yet
  | "refused_before_sign" // released: nothing was signed
  | "sent" // credential sent; outcome recorded in the fields below
  | "unknown"; // signed, outcome could not be recorded

export interface LedgerEntry {
  key: string; // serviceId: one purchase per service
  url: string;
  recipient: string;
  amount: string; // atomic USDC.e
  feeReserve: string; // atomic USDC.e reserved for a self-paid fee (0 when sponsored)
  status: EntryStatus;
  reservedAt: string;
  httpStatus?: number | null;
  txHash?: string | null;
  settled?: boolean | null;
  delivered?: boolean | null;
  feePaid?: string | null;
  note?: string;
}

export interface LedgerFile {
  version: 1;
  payer: string;
  capAtomic: string;
  entries: LedgerEntry[];
}

export class Ledger {
  readonly path: string | null;
  readonly cap: bigint;
  private data: LedgerFile;

  private lockPath: string | null = null;

  /**
   * `lock: true` takes `<path>.lock` exclusively (O_EXCL) so two --pay processes cannot share a
   * ledger. A leftover lock (crash) is never broken automatically: remove it by hand after checking
   * the ledger and the chain.
   */
  constructor(path: string | null, payer: string, capAtomic: bigint = DEFAULT_TOTAL_CAP_ATOMIC, opts: { lock?: boolean } = {}) {
    if (capAtomic <= 0n || capAtomic > MAX_TOTAL_ATOMIC) throw new Error(`cap ${capAtomic} outside (0, ${MAX_TOTAL_ATOMIC}]`);
    this.path = path;
    this.cap = capAtomic;
    this.data = { version: 1, payer, capAtomic: capAtomic.toString(), entries: [] };
    if (opts.lock) {
      if (!path) throw new Error("ledger: a lock needs a ledger path");
      mkdirSync(dirname(path), { recursive: true });
      const lp = `${path}.lock`;
      let fd: number;
      try {
        fd = openSync(lp, "wx");
      } catch {
        throw new Error(`ledger: ${lp} exists; another --pay run holds this ledger (or one crashed). Check, then delete the lock.`);
      }
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      closeSync(fd);
      this.lockPath = lp;
    }
    try {
      if (path && existsSync(path)) {
        const raw = JSON.parse(readFileSync(path, "utf8")) as LedgerFile;
        if (raw.version !== 1 || !Array.isArray(raw.entries)) throw new Error("ledger: unexpected shape");
        if (raw.payer.toLowerCase() !== payer.toLowerCase()) throw new Error("ledger: payer differs from this run");
        this.data = { ...raw, capAtomic: capAtomic.toString() };
      }
    } catch (e) {
      this.release();
      throw e;
    }
  }

  /** Drop the lock taken by `lock: true`. Safe to call more than once. */
  release(): void {
    if (!this.lockPath) return;
    try {
      unlinkSync(this.lockPath);
    } catch {
      // already gone
    }
    this.lockPath = null;
  }

  entries(): readonly LedgerEntry[] {
    return this.data.entries;
  }

  private counted(): LedgerEntry[] {
    return this.data.entries.filter((e) => e.status !== "refused_before_sign");
  }

  /** Amount + fee reserve of every counted entry. */
  committed(): bigint {
    return this.counted().reduce((s, e) => s + BigInt(e.amount) + BigInt(e.feeReserve), 0n);
  }

  count(): number {
    return this.counted().length;
  }

  /**
   * Reserve one purchase. `chainSpent` is USDC.e that left the payer on chain since the ledger
   * started; the cap is checked against max(ledger, chain) so a lost ledger cannot reopen the budget.
   */
  reserve(
    input: { key: string; url: string; recipient: string; amount: bigint; sponsored: boolean },
    chainSpent: bigint = 0n,
    now: Date = new Date(),
  ): LedgerEntry | Refusal {
    if (input.amount <= 0n || input.amount > MAX_PER_CALL_ATOMIC)
      return { refused: "price_over_cap", detail: `amount ${input.amount}` };
    if (this.counted().some((e) => e.key === input.key)) return { refused: "already_bought", detail: input.key };
    if (this.count() >= MAX_PURCHASES) return { refused: "purchase_count_reached", detail: `${this.count()} >= ${MAX_PURCHASES}` };
    const fee = input.sponsored ? 0n : FEE_RESERVE_ATOMIC;
    const ledgerSpent = this.committed();
    const spent = ledgerSpent > chainSpent ? ledgerSpent : chainSpent;
    if (spent + input.amount + fee > this.cap)
      return { refused: "total_cap_reached", detail: `${spent} + ${input.amount} + fee ${fee} > cap ${this.cap}` };
    const entry: LedgerEntry = {
      key: input.key,
      url: input.url,
      recipient: input.recipient,
      amount: input.amount.toString(),
      feeReserve: fee.toString(),
      status: "reserved",
      reservedAt: now.toISOString(),
    };
    this.data.entries.push(entry);
    this.save();
    return entry;
  }

  update(key: string, patch: Partial<LedgerEntry>): void {
    const e = [...this.data.entries].reverse().find((x) => x.key === key && x.status !== "refused_before_sign");
    if (!e) throw new Error(`ledger: no open entry for ${key}`);
    if (e.status !== "reserved" && patch.status === "refused_before_sign")
      throw new Error(`ledger: ${key} was already sent; it cannot be released`);
    Object.assign(e, patch);
    this.save();
  }

  private save(): void {
    if (!this.path) return;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n");
    renameSync(tmp, this.path);
  }
}
