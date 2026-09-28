/**
 * Per-seller pacing for measurement runs (MEASURE_* in ./constants.ts).
 * Pure bookkeeping: it never touches amounts, recipients or the money caps.
 */
import { MEASURE_MAX_PER_SELLER, MEASURE_SPACING_MS } from "./constants.js";

export class SellerPacer {
  private readonly seen = new Map<string, { count: number; lastAt: number }>();

  constructor(
    private readonly max: number = MEASURE_MAX_PER_SELLER,
    private readonly spacingMs: number = MEASURE_SPACING_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** null = this seller already had `max` purchases in this run; otherwise ms to wait before the next one. */
  waitMs(seller: string): number | null {
    const s = this.seen.get(seller);
    if (!s) return 0;
    if (s.count >= this.max) return null;
    return Math.max(0, s.lastAt + this.spacingMs - this.now());
  }

  /** Call right before paying. Throws if the caller skipped waitMs. */
  record(seller: string): void {
    const w = this.waitMs(seller);
    if (w === null || w > 0) throw new Error(`SellerPacer: ${seller} is not due (${w === null ? "over the per-seller limit" : `${w} ms early`})`);
    const s = this.seen.get(seller);
    this.seen.set(seller, { count: (s?.count ?? 0) + 1, lastAt: this.now() });
  }
}
