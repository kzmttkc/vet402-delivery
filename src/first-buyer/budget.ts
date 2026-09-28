/**
 * First-buyer money caps on top of the existing Budget (src/guard.ts), unchanged:
 * the Budget keeps the per-purchase cap (0.10), the persistent month total (20 USDC, chain-checked
 * against the payer's balance baseline) and one purchase per key; this subclass adds the per-run
 * cap (5 USDC) in memory. A reservation that is released gives back its run share too.
 */
import { Budget, type Refusal } from "../guard.js";
import { FB_MAX_PER_MONTH_ATOMIC, FB_MAX_PER_PURCHASE_ATOMIC, FB_MAX_PER_RUN_ATOMIC, FB_MAX_PURCHASES_PER_MONTH } from "./constants.js";

export class FirstBuyerBudget extends Budget {
  private runSpent = 0n;
  private readonly runOpen = new Map<string, bigint>();

  constructor(
    file: string | null,
    readonly runCap: bigint = FB_MAX_PER_RUN_ATOMIC,
    monthCap: bigint = FB_MAX_PER_MONTH_ATOMIC,
  ) {
    super(file, monthCap, FB_MAX_PURCHASES_PER_MONTH, FB_MAX_PER_PURCHASE_ATOMIC);
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

/** results/first-buyer-budget-YYYY-MM.json key for `now` (UTC). */
export function monthKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}
