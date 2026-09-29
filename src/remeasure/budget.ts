/**
 * Remeasure money caps on Solana, on top of the existing Budget (src/guard.ts), unchanged:
 * the Budget keeps the per-purchase cap, the persistent month total (chain-checked against the payer's
 * balance baseline) and one purchase per key, and writes the reservation to disk before anything is signed.
 * This subclass adds the per-run cap in memory, the same way src/first-buyer/budget.ts does.
 *
 * Keys are `<date>|<payTo>|<slot>`: the same payTo and slot cannot be bought twice on one UTC day,
 * whatever number of runs that day.
 */
import { Budget, type Refusal } from "../guard.js";
import { RM_MAX_PURCHASES_PER_MONTH, RM_SOLANA_MAX_PER_MONTH_ATOMIC, RM_SOLANA_MAX_PER_PURCHASE_ATOMIC, RM_SOLANA_MAX_PER_RUN_ATOMIC } from "./constants.js";

export class RemeasureBudget extends Budget {
  private runSpent = 0n;
  private readonly runOpen = new Map<string, bigint>();

  constructor(
    file: string | null,
    readonly runCap: bigint = RM_SOLANA_MAX_PER_RUN_ATOMIC,
    monthCap: bigint = RM_SOLANA_MAX_PER_MONTH_ATOMIC,
  ) {
    super(file, monthCap, RM_MAX_PURCHASES_PER_MONTH, RM_SOLANA_MAX_PER_PURCHASE_ATOMIC);
  }

  get runSpentAtomic(): bigint {
    return this.runSpent;
  }

  override reserve(amount: bigint, key: string, currentBalanceAtomic: bigint | null = null): Refusal | { ok: true; id: string } {
    if (amount > this.maxPer) return super.reserve(amount, key, currentBalanceAtomic); // price_over_cap
    if (this.runSpent + amount > this.runCap) {
      return { refused: "total_cap_reached", detail: `run: spent ${this.runSpent} + ${amount} > run cap ${this.runCap}` };
    }
    const r = super.reserve(amount, key, currentBalanceAtomic);
    if ("ok" in r) {
      this.runSpent += amount;
      this.runOpen.set(r.id, amount);
    }
    return r;
  }

  override release(id: string): void {
    super.release(id);
    const a = this.runOpen.get(id);
    if (a === undefined) return;
    this.runOpen.delete(id);
    this.runSpent -= a;
  }

  override commit(id: string): void {
    super.commit(id);
    this.runOpen.delete(id);
  }
}

export function budgetKey(date: string, payTo: string, slot: number): string {
  return `${date}|${payTo}|${slot}`;
}
