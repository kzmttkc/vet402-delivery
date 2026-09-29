/**
 * One Tempo key (PAYER_ADDRESS) pays from several ledgers: the Tempo census ledger and remeasure's day
 * ledgers. payOne stops when `chainSpent()` > its own ledger's committed amount. This file gives every
 * --pay run the same `chainSpent`: the USDC.e that left the key since CENSUS_START_BLOCK, minus what the
 * OTHER ledgers of the key account for. So the one check every run makes is
 *
 *   on-chain outflow since CENSUS_START_BLOCK  <=  this ledger's committed + the other ledgers' outflow
 *
 * A ledger that is lost or deleted accounts for nothing, so its payments become unaccounted outflow and
 * every run of the key stops before signing until a human looks.
 *
 * The other ledgers are counted by what left the key per their own records (entryOutflow), not by their
 * reservations: counting unused fee reserves and unsettled amounts would leave room that hides a lost
 * ledger (the census alone reserved 0.066 USDC.e more than left the key on chain, read 2026-09-29).
 * The run's own ledger still has such room (its unused fee reserves), so a small lost day ledger could
 * hide in it; the day-ledger index below catches that case by name.
 *
 * Only two places may be a ledger of this key: the census ledger path and a day ledger in the remeasure
 * folder. Any other path would count the real census ledger as "another ledger" and pass the check.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { MAX_TOTAL_ATOMIC } from "./constants.js";
import { Ledger, type LedgerEntry } from "./ledger.js";

export interface KeyLedgerSet {
  /** The Tempo census ledger (scripts/tempo-census.ts --pay). */
  census: string;
  /** Folder of remeasure's day ledgers, tempo-ledger-YYYY-MM-DD.json, and their index. */
  remeasureDir: string;
}

/** Where the key's ledgers live in production. The census ran in ~/vet402-solana-tempo; remeasure runs in ~/vet402-solana. */
export const TEMPO_KEY_LEDGERS: KeyLedgerSet = {
  census: join(homedir(), "vet402-solana-tempo", "results", "tempo-ledger.json"),
  remeasureDir: join(homedir(), "vet402-solana", "results", "remeasure"),
};

export const REMEASURE_DAY_LEDGER = /^tempo-ledger-(\d{4}-\d{2}-\d{2})\.json$/;
export const DAY_LEDGER_INDEX = "tempo-ledger-index.json";

export class KeyLedgerError extends Error {}

/** The census --pay ledger must be the one census ledger of the key. */
export function assertCensusLedger(path: string, set: KeyLedgerSet = TEMPO_KEY_LEDGERS): void {
  if (resolve(path) !== resolve(set.census)) {
    throw new KeyLedgerError(`the Tempo census ledger of this key is ${set.census}; --pay with ${resolve(path)} would count it as another ledger and reopen the caps`);
  }
}

/** `path` must be the census ledger or a day ledger in the remeasure folder. */
export function assertKeyLedger(path: string, set: KeyLedgerSet = TEMPO_KEY_LEDGERS): void {
  const p = resolve(path);
  if (p === resolve(set.census)) return;
  if (dirname(p) === resolve(set.remeasureDir) && REMEASURE_DAY_LEDGER.test(p.slice(dirname(p).length + 1))) return;
  throw new KeyLedgerError(`${p} is not a ledger of this key (census ${set.census}, day ledgers in ${set.remeasureDir})`);
}

// ---------- the day-ledger index: every day ledger ever opened for --pay, by date ----------

interface IndexFile {
  kind: "vet402-tempo-day-ledgers";
  dates: string[];
}

function indexPath(set: KeyLedgerSet): string {
  return join(set.remeasureDir, DAY_LEDGER_INDEX);
}

function readIndex(set: KeyLedgerSet): IndexFile | null {
  const f = indexPath(set);
  if (!existsSync(f)) return null;
  const x = JSON.parse(readFileSync(f, "utf8")) as IndexFile;
  if (x?.kind !== "vet402-tempo-day-ledgers" || !Array.isArray(x.dates)) throw new KeyLedgerError(`${f} has an unexpected shape`);
  return x;
}

/**
 * Before a day ledger is used for --pay: list its date in the index, then make sure the file exists
 * (an empty ledger when new), so a day with no purchase is not later taken for a deleted one.
 */
export function registerDayLedger(set: KeyLedgerSet, date: string, payer: string, capAtomic: bigint): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new KeyLedgerError(`bad date ${date}`);
  mkdirSync(set.remeasureDir, { recursive: true });
  const idx = readIndex(set) ?? { kind: "vet402-tempo-day-ledgers" as const, dates: [] };
  const file = join(set.remeasureDir, `tempo-ledger-${date}.json`);
  if (idx.dates.includes(date) && !existsSync(file)) throw new KeyLedgerError(`${file} is listed in ${indexPath(set)} but missing; refusing to pay`);
  if (!idx.dates.includes(date)) {
    idx.dates = [...idx.dates, date].sort();
    const tmp = `${indexPath(set)}.tmp`;
    writeFileSync(tmp, JSON.stringify(idx, null, 2) + "\n");
    renameSync(tmp, indexPath(set));
  }
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ version: 1, payer, capAtomic: capAtomic.toString(), entries: [] }, null, 2) + "\n", { flag: "wx" });
  return file;
}

/**
 * The day ledgers must all still be there: every date in the index has its file, and when day ledgers
 * exist the index exists. Throws KeyLedgerError otherwise.
 */
export function assertDayLedgersPresent(set: KeyLedgerSet = TEMPO_KEY_LEDGERS): void {
  const idx = readIndex(set);
  const onDisk = existsSync(set.remeasureDir) ? readdirSync(set.remeasureDir).filter((n) => REMEASURE_DAY_LEDGER.test(n)) : [];
  if (!idx) {
    if (onDisk.length > 0) throw new KeyLedgerError(`${indexPath(set)} is missing but ${onDisk.length} day ledgers exist; refusing to pay`);
    return;
  }
  const missing = idx.dates.filter((d) => !existsSync(join(set.remeasureDir, `tempo-ledger-${d}.json`)));
  if (missing.length > 0) throw new KeyLedgerError(`day ledgers listed in ${indexPath(set)} are missing: ${missing.join(", ")}; refusing to pay`);
}

/** Every ledger file of the key that exists now (after checking no listed day ledger is gone). */
export function keyLedgerFiles(set: KeyLedgerSet = TEMPO_KEY_LEDGERS): string[] {
  assertDayLedgersPresent(set);
  const out: string[] = [];
  if (existsSync(set.census)) out.push(resolve(set.census));
  if (existsSync(set.remeasureDir)) {
    for (const n of readdirSync(set.remeasureDir).sort()) if (REMEASURE_DAY_LEDGER.test(n)) out.push(resolve(join(set.remeasureDir, n)));
  }
  return [...new Set(out)];
}

/**
 * USDC.e that left the key for one ledger entry, per the entry's own record:
 *   refused_before_sign, reserved -> 0 (nothing signed: payOne marks "sent" before a credential leaves)
 *   settled false  -> 0 (the transfer was not found on chain)
 *   settled true   -> amount + fee paid (the fee reserve when the fee was not read back)
 *   anything else  -> amount + fee reserve (outcome unknown: assume it left)
 * On the census ledger this gives exactly the on-chain outflow (1,570,786 atomic, read 2026-09-29).
 */
export function entryOutflow(e: LedgerEntry): bigint {
  if (e.status === "refused_before_sign" || e.status === "reserved") return 0n;
  if (e.settled === false) return 0n;
  const amount = BigInt(e.amount);
  if (e.settled === true) return amount + BigInt(e.feePaid && /^\d+$/.test(e.feePaid) ? e.feePaid : e.feeReserve);
  return amount + BigInt(e.feeReserve);
}

/** Read-only: what one ledger file accounts for. Throws on a file for another payer or of another shape. */
export function accountedOutflow(file: string, payer: string): bigint {
  return new Ledger(file, payer, MAX_TOTAL_ATOMIC).entries().reduce((s, e) => s + entryOutflow(e), 0n);
}

/**
 * The `chainSpent` for payOne when `self` is the ledger in use: on-chain outflow since CENSUS_START_BLOCK
 * minus what every other ledger of the key accounts for (never below 0). `self` must be a ledger of the
 * key. The files are read again on every call, so a purchase another run records meanwhile is counted;
 * a listed day ledger that has gone missing throws (payOne then signs nothing).
 */
export function unaccountedChainSpent(
  self: string,
  outflowSinceCensusStart: () => Promise<bigint>,
  payer: string,
  set: KeyLedgerSet = TEMPO_KEY_LEDGERS,
): () => Promise<bigint> {
  assertKeyLedger(self, set);
  const me = resolve(self);
  return async () => {
    const files = keyLedgerFiles(set);
    const out = await outflowSinceCensusStart();
    let others = 0n;
    for (const f of files) if (f !== me) others += accountedOutflow(f, payer);
    const d = out - others;
    return d > 0n ? d : 0n;
  };
}
