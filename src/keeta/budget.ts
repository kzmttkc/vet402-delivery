/**
 * Keeta caps on top of Budget (src/guard.ts). Keys are `<date>|<url>`: one purchase per URL per UTC day.
 * payTo does not vary between routes on keespecs.xyz, so the URL is the purchase identity (not payTo|slot).
 *
 * runCap / runMaxCount are per UTC day (shared across --pay runs that day via the month ledger's purchase keys).
 */
import { existsSync, readFileSync } from "node:fs";
import { Budget, type Refusal } from "../guard.js";
import {
  KEETA_MAX_PER_MONTH_ATOMIC,
  KEETA_MAX_PER_PURCHASE_ATOMIC,
  KEETA_MAX_PER_RUN_ATOMIC,
  KEETA_MAX_PURCHASES_PER_MONTH,
  KEETA_MAX_PURCHASES_PER_RUN,
} from "./constants.js";

export class KeetaBudget extends Budget {
  private runSpent = 0n;
  private runCount = 0;
  private readonly runOpen = new Map<string, bigint>();

  constructor(
    file: string | null,
    readonly runCap: bigint = KEETA_MAX_PER_RUN_ATOMIC,
    readonly runMaxCount: number = KEETA_MAX_PURCHASES_PER_RUN,
    dayUtc?: string,
    daySeed?: { spent: bigint; count: number },
    monthSeed?: { spent: bigint; count: number },
  ) {
    super(file, KEETA_MAX_PER_MONTH_ATOMIC, KEETA_MAX_PURCHASES_PER_MONTH, KEETA_MAX_PER_PURCHASE_ATOMIC, monthSeed);
    if (daySeed) {
      this.runSpent = daySeed.spent;
      this.runCount = daySeed.count;
    } else if (file && dayUtc) {
      const t = keetaDayTotalsFromLedger(file, dayUtc);
      this.runSpent = t.spent;
      this.runCount = t.count;
    }
  }

  get runSpentAtomic(): bigint {
    return this.runSpent;
  }

  override reserve(amount: bigint, key: string, currentBalanceAtomic: bigint | null = null): Refusal | { ok: true; id: string } {
    if (this.runCount >= this.runMaxCount) {
      return { refused: "purchase_count_reached", detail: `run: ${this.runCount} purchases >= ${this.runMaxCount}` };
    }
    if (this.runSpent + amount > this.runCap) {
      return { refused: "total_cap_reached", detail: `run: spent ${this.runSpent} + ${amount} > run cap ${this.runCap}` };
    }
    const r = super.reserve(amount, key, currentBalanceAtomic);
    if ("ok" in r) {
      this.runSpent += amount;
      this.runCount += 1;
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
    this.runCount -= 1;
  }

  override commit(id: string): void {
    super.commit(id);
    this.runOpen.delete(id);
  }
}

/** Origin + pathname (trailing slash stripped) + search (fragment dropped). One purchase per normalized URL per UTC day. */
export function normalizeKeetaPurchaseUrl(u: string): string {
  const url = new URL(u);
  let path = url.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return url.origin + path + url.search;
}

export function keetaBudgetKey(date: string, url: string): string {
  return `${date}|${normalizeKeetaPurchaseUrl(url)}`;
}

export function keetaDayTotalsFromLedger(file: string, dayUtc: string): { spent: bigint; count: number } {
  let spent = 0n;
  let count = 0;
  if (!existsSync(file)) return { spent, count };
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as { purchases?: { key?: string; amount?: string }[] };
    const prefix = `${dayUtc}|`;
    for (const p of s.purchases ?? []) {
      if (typeof p.key === "string" && p.key.startsWith(prefix) && /^\d+$/.test(String(p.amount ?? ""))) {
        spent += BigInt(p.amount!);
        count += 1;
      }
    }
  } catch {
    return { spent: KEETA_MAX_PER_RUN_ATOMIC, count: KEETA_MAX_PURCHASES_PER_RUN };
  }
  return { spent, count };
}

/** Month cap (Budget "spent …") vs run cap (KeetaBudget "run: …"). Both use refused "total_cap_reached". */
export function isKeetaMonthCapRefusal(r: { refused: string; detail?: string | null }): boolean {
  return r.refused === "total_cap_reached" && typeof r.detail === "string" && r.detail.startsWith("spent ");
}

export function isKeetaRunCapRefusal(r: { refused: string; detail?: string | null }): boolean {
  return r.refused === "total_cap_reached" && typeof r.detail === "string" && r.detail.startsWith("run:");
}