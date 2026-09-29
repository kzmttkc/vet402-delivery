/**
 * The purchase loop shared by both chains. Before each attempt, in this order:
 *   caps would fit (else stop, or in a dry run skip and go on)
 *   -> pacing per payTo (SellerPacer, src/measure.ts: at most MEASURE_MAX_PER_SELLER per run,
 *      MEASURE_SPACING_MS apart; waits instead of skipping)
 *   -> the chain's attempt, which calls the existing payment function.
 * The caps are enforced again inside the payment path (Budget / Ledger), before anything is signed.
 */
import { SellerPacer } from "../measure.js";
import type { RemeasureRow } from "./results.js";
import type { Target } from "./targets.js";

export interface Slot {
  target: Target;
  slot: number;
}

export interface AttemptResult {
  row: RemeasureRow;
  /** Stop the whole run after this row. */
  stop: string | null;
}

export interface LoopDeps {
  pacer: SellerPacer;
  sleep: (ms: number) => Promise<void>;
  /** null = this purchase fits every cap; otherwise the reason it does not. */
  fits: (s: Slot) => string | null;
  attempt: (s: Slot) => Promise<AttemptResult>;
  onRow?: (row: RemeasureRow) => void;
  /** Dry run: keep going after a cap is reached, so every slot is listed. */
  continueAfterCap?: boolean;
}

export interface LoopResult {
  rows: RemeasureRow[];
  skipped: { url: string; payTo: string; slot: number; reason: string; detail?: string }[];
  stopped: string | null;
}

export const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runSlots(slots: readonly Slot[], deps: LoopDeps): Promise<LoopResult> {
  const rows: RemeasureRow[] = [];
  const skipped: LoopResult["skipped"] = [];
  for (const s of slots) {
    const t = s.target;
    const cap = deps.fits(s);
    if (cap) {
      const i = cap.indexOf(":");
      skipped.push({ url: t.url, payTo: t.payTo, slot: s.slot, reason: i < 0 ? cap : cap.slice(0, i), ...(i < 0 ? {} : { detail: cap.slice(i + 1).trim() }) });
      if (deps.continueAfterCap) continue;
      return { rows, skipped, stopped: cap };
    }
    const wait = deps.pacer.waitMs(t.payTo);
    if (wait === null) {
      skipped.push({ url: t.url, payTo: t.payTo, slot: s.slot, reason: "per_payto_limit" });
      continue;
    }
    if (wait > 0) await deps.sleep(wait);
    deps.pacer.record(t.payTo);
    const r = await deps.attempt(s);
    rows.push(r.row);
    deps.onRow?.(r.row);
    if (r.stop) return { rows, skipped, stopped: r.stop };
  }
  return { rows, skipped, stopped: null };
}
