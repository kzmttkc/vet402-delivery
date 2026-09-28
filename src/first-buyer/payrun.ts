/**
 * Everything a --pay run opens before the first purchase, in this order, each one fail-closed:
 *   1. the run lock (a second --pay stops here)
 *   2. the ledger, which must already exist (--init-ledger creates it once)
 *   3. the month budget file; if the ledger shows more spent this month than the budget file,
 *      the files disagree and the run stops
 * On any failure the lock is released and the error is thrown.
 */
import { acquireRunLock } from "./lock.js";
import { FirstBuyerLedger } from "./ledger.js";
import { FirstBuyerBudget, monthKey } from "./budget.js";

export interface PayRun {
  ledger: FirstBuyerLedger;
  budget: FirstBuyerBudget;
  release: () => void;
}

export function openPayRun(files: { lock: string; ledger: string; month: string }, now: Date = new Date()): PayRun {
  const release = acquireRunLock(files.lock, now);
  try {
    const ledger = FirstBuyerLedger.openForPay(files.ledger);
    const budget = new FirstBuyerBudget(files.month);
    const fromLedger = ledger.monthSpentAtomic(monthKey(now));
    if (fromLedger > budget.spent) {
      throw new Error(`the ledger shows ${fromLedger} spent in ${monthKey(now)} but ${files.month} shows ${budget.spent}; refusing to pay until they agree`);
    }
    return { ledger, budget, release };
  } catch (e) {
    release();
    throw e;
  }
}
