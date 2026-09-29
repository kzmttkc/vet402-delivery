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
 * The other ledgers are counted by what left the key per their own records (accountedOutflow), not by
 * their reservations: counting unused fee reserves and unsettled amounts would leave room that hides a
 * lost ledger (the census alone reserved 0.066 USDC.e more than left the key on chain, read 2026-09-29).
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MAX_TOTAL_ATOMIC } from "./constants.js";
import { Ledger, type LedgerEntry } from "./ledger.js";

export interface KeyLedgerSet {
  /** The Tempo census ledger (scripts/tempo-census.ts --pay). */
  census: string;
  /** Folder of remeasure's day ledgers, tempo-ledger-YYYY-MM-DD.json. */
  remeasureDir: string;
}

/** Where the key's ledgers live in production. The census ran in ~/vet402-solana-tempo; remeasure runs in ~/vet402-solana. */
export const TEMPO_KEY_LEDGERS: KeyLedgerSet = {
  census: join(homedir(), "vet402-solana-tempo", "results", "tempo-ledger.json"),
  remeasureDir: join(homedir(), "vet402-solana", "results", "remeasure"),
};

export const REMEASURE_DAY_LEDGER = /^tempo-ledger-\d{4}-\d{2}-\d{2}\.json$/;

/** Every ledger file of the key that exists now. */
export function keyLedgerFiles(set: KeyLedgerSet = TEMPO_KEY_LEDGERS): string[] {
  const out: string[] = [];
  if (existsSync(set.census)) out.push(resolve(set.census));
  if (existsSync(set.remeasureDir)) {
    for (const n of readdirSync(set.remeasureDir).sort()) if (REMEASURE_DAY_LEDGER.test(n)) out.push(resolve(join(set.remeasureDir, n)));
  }
  return [...new Set(out)];
}

/**
 * USDC.e that left the key for one ledger entry, per the entry's own record:
 *   settled true   -> amount + fee paid (the fee reserve when the fee was not read back)
 *   settled false  -> 0 (the transfer was not found on chain)
 *   anything else  -> amount + fee reserve (outcome unknown: assume it left)
 *   refused_before_sign -> 0
 * On the census ledger this gives exactly the on-chain outflow (1,570,786 atomic, read 2026-09-29).
 */
export function entryOutflow(e: LedgerEntry): bigint {
  if (e.status === "refused_before_sign") return 0n;
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
 * minus what every other ledger of the key accounts for (never below 0). The files are read again on
 * every call, so a purchase another run records meanwhile is counted.
 */
export function unaccountedChainSpent(
  self: string,
  outflowSinceCensusStart: () => Promise<bigint>,
  payer: string,
  set: KeyLedgerSet = TEMPO_KEY_LEDGERS,
): () => Promise<bigint> {
  const me = resolve(self);
  return async () => {
    const out = await outflowSinceCensusStart();
    let others = 0n;
    for (const f of keyLedgerFiles(set)) if (f !== me) others += accountedOutflow(f, payer);
    const d = out - others;
    return d > 0n ? d : 0n;
  };
}
