/**
 * Checks made before anything is signed. Pure except the ledger file.
 *
 * Order matters only for which reason is reported; every check must pass before
 * the signer is touched.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isOffCurveAddress, isAddress } from "@solana/kit";
import {
  MAX_PER_PURCHASE_ATOMIC,
  MAX_PURCHASES,
  MAX_TOTAL_ATOMIC,
  SOLANA_MAINNET,
  USDC_MINT,
  toCaip2,
} from "./constants.js";

/** A Solana accept from a live 402, normalised across x402 v1 and v2. */
export interface SolAccept {
  scheme: string;
  network: string; // CAIP-2
  amount: string; // atomic
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export type RefuseReason =
  | "no_solana_accept"
  | "scheme_mismatch"
  | "network_mismatch"
  | "mint_mismatch"
  | "bad_amount"
  | "price_over_cap"
  | "price_raised"
  | "payto_mismatch"
  | "payto_invalid"
  | "payto_off_curve"
  | "self_dealing"
  | "fee_payer_missing"
  | "fee_payer_is_self"
  | "total_cap_reached"
  | "purchase_count_reached"
  | "already_bought"
  | "tx_check_failed"
  | "ledger_unreadable";

export interface Refusal {
  refused: RefuseReason;
  detail: string;
}

/** Normalise one raw accept (v2 `amount`, v1 `maxAmountRequired`, v1 network "solana"). */
export function normalizeAccept(raw: Record<string, unknown>): SolAccept {
  const extra = raw.extra && typeof raw.extra === "object" ? (raw.extra as Record<string, unknown>) : undefined;
  return {
    scheme: String(raw.scheme ?? ""),
    network: toCaip2(raw.network),
    amount: String(raw.amount ?? raw.maxAmountRequired ?? ""),
    asset: String(raw.asset ?? ""),
    payTo: String(raw.payTo ?? ""),
    ...(typeof raw.maxTimeoutSeconds === "number" ? { maxTimeoutSeconds: raw.maxTimeoutSeconds } : {}),
    ...(extra ? { extra } : {}),
  };
}

/**
 * From a live 402's accepts, the one vet402 would pay: Solana mainnet, and the payTo the lock names.
 * When no Solana accept carries the locked payTo, the first Solana accept is returned so that
 * `checkAccept` reports why (payTo mismatch, mint mismatch …) instead of silently skipping.
 */
export function pickSolanaAccept(accepts: SolAccept[], lockedPayTo?: string): SolAccept | null {
  const sol = accepts.filter((a) => a.network === SOLANA_MAINNET);
  if (sol.length === 0) return null;
  const good = sol.filter((a) => a.asset === USDC_MINT && a.scheme === "exact" && (!lockedPayTo || a.payTo === lockedPayTo));
  return good[0] ?? sol[0]!;
}

export interface AcceptContext {
  /** vet402's payer address. */
  payer: string;
  /** payTo recorded from the seller's own unpaid 402 (the lock). */
  lockedPayTo: string;
  /** Amount recorded at the same time; a later 402 may ask less, never more. */
  lockedAmount?: string;
  /** Any other vet402 address (never paid). */
  ownAddresses?: string[];
}

/** Every per-accept check. null = may proceed to the budget. */
export function checkAccept(a: SolAccept | null, ctx: AcceptContext): Refusal | null {
  if (!a) return { refused: "no_solana_accept", detail: "the 402 has no Solana mainnet accept" };
  if (a.scheme !== "exact") return { refused: "scheme_mismatch", detail: `scheme ${a.scheme} (only exact)` };
  if (a.network !== SOLANA_MAINNET) return { refused: "network_mismatch", detail: `network ${a.network}` };
  if (a.asset !== USDC_MINT) return { refused: "mint_mismatch", detail: `asset ${a.asset} is not USDC ${USDC_MINT}` };
  if (!/^\d{1,18}$/.test(a.amount) || BigInt(a.amount) <= 0n) return { refused: "bad_amount", detail: `amount ${JSON.stringify(a.amount)}` };
  const amount = BigInt(a.amount);
  if (amount > MAX_PER_PURCHASE_ATOMIC) {
    return { refused: "price_over_cap", detail: `amount ${amount} > per-purchase cap ${MAX_PER_PURCHASE_ATOMIC}` };
  }
  if (ctx.lockedAmount !== undefined && amount > BigInt(ctx.lockedAmount)) {
    return { refused: "price_raised", detail: `amount ${amount} > recorded ${ctx.lockedAmount}` };
  }
  if (a.payTo !== ctx.lockedPayTo) {
    return { refused: "payto_mismatch", detail: `payTo ${a.payTo} != recorded ${ctx.lockedPayTo}` };
  }
  if (!isAddress(a.payTo)) return { refused: "payto_invalid", detail: `payTo ${a.payTo} is not a Solana address` };
  if (isOffCurveAddress(a.payTo)) {
    return { refused: "payto_off_curve", detail: "payTo is off-curve (an ATA or PDA, not a wallet)" };
  }
  if (a.payTo === ctx.payer || (ctx.ownAddresses ?? []).includes(a.payTo)) {
    return { refused: "self_dealing", detail: "payTo is a vet402 address" };
  }
  const feePayer = a.extra?.feePayer;
  if (typeof feePayer !== "string" || !isAddress(feePayer)) {
    return { refused: "fee_payer_missing", detail: "no valid extra.feePayer; vet402 would have to pay SOL fees" };
  }
  if (feePayer === ctx.payer || (ctx.ownAddresses ?? []).includes(feePayer)) {
    return { refused: "fee_payer_is_self", detail: "extra.feePayer is vet402 itself; SOL would decrease" };
  }
  return null;
}

interface LedgerState {
  /** USDC balance (atomic) when the ledger was first created; chain spend = baseline - current. */
  baselineAtomic: string | null;
  spentAtomic: string;
  purchases: { key: string; amount: string; at: string }[];
}

/**
 * Total and count caps, persisted so that a second run cannot spend another 1.00.
 * A reservation counts as spent the moment it is made. It is released only when
 * we know nothing was signed and sent.
 */
export class Budget {
  private state: LedgerState;
  private readonly open = new Map<string, { key: string; amount: bigint }>();
  private seq = 0;

  constructor(
    private readonly file: string | null,
    readonly maxTotal: bigint = MAX_TOTAL_ATOMIC,
    readonly maxCount: number = MAX_PURCHASES,
    readonly maxPer: bigint = MAX_PER_PURCHASE_ATOMIC,
  ) {
    this.state = this.load();
  }

  private load(): LedgerState {
    if (this.file && existsSync(this.file)) {
      try {
        const s = JSON.parse(readFileSync(this.file, "utf8")) as LedgerState;
        if (/^\d+$/.test(s.spentAtomic) && Array.isArray(s.purchases)) return s;
      } catch {
        /* fall through: fail closed */
      }
      // Unreadable ledger: treat the budget as used up.
      return { baselineAtomic: null, spentAtomic: this.maxTotal.toString(), purchases: Array(this.maxCount).fill({ key: "?", amount: "0", at: "" }) };
    }
    return { baselineAtomic: null, spentAtomic: "0", purchases: [] };
  }

  private persist(): void {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2) + "\n");
    renameSync(tmp, this.file);
  }

  get spent(): bigint {
    return BigInt(this.state.spentAtomic);
  }
  get count(): number {
    return this.state.purchases.length;
  }

  /** Record the USDC balance the first time; later runs compare against it. */
  setBaselineIfMissing(balanceAtomic: bigint): void {
    if (this.state.baselineAtomic === null) {
      this.state.baselineAtomic = balanceAtomic.toString();
      this.persist();
    }
  }

  /** What the chain says was spent since the baseline (0 if unknown). */
  chainSpent(currentBalanceAtomic: bigint | null): bigint {
    if (currentBalanceAtomic === null || this.state.baselineAtomic === null) return 0n;
    const d = BigInt(this.state.baselineAtomic) - currentBalanceAtomic;
    return d > 0n ? d : 0n;
  }

  /**
   * One synchronous step: spent = max(ledger, chain) -> compare -> record.
   * `key` is the purchase identity (one purchase per host).
   */
  reserve(amount: bigint, key: string, currentBalanceAtomic: bigint | null = null): Refusal | { ok: true; id: string } {
    if (amount > this.maxPer) return { refused: "price_over_cap", detail: `amount ${amount} > per-purchase cap ${this.maxPer}` };
    if (this.state.purchases.some((p) => p.key === key) || [...this.open.values()].some((o) => o.key === key)) {
      return { refused: "already_bought", detail: `${key} was already bought once` };
    }
    if (this.state.purchases.length >= this.maxCount) {
      return { refused: "purchase_count_reached", detail: `${this.state.purchases.length} purchases >= ${this.maxCount}` };
    }
    const local = this.spent;
    const chain = this.chainSpent(currentBalanceAtomic);
    const spent = chain > local ? chain : local;
    if (spent + amount > this.maxTotal) {
      return { refused: "total_cap_reached", detail: `spent ${spent} + ${amount} > total cap ${this.maxTotal}` };
    }
    this.state.spentAtomic = (spent + amount).toString();
    this.state.purchases.push({ key, amount: amount.toString(), at: new Date().toISOString() });
    this.persist();
    const id = `r${++this.seq}`;
    this.open.set(id, { key, amount });
    return { ok: true, id };
  }

  /** Give a reservation back. Only when nothing signed left the process. */
  release(id: string): void {
    const r = this.open.get(id);
    if (!r) return;
    this.open.delete(id);
    const i = this.state.purchases.findIndex((p) => p.key === r.key);
    if (i >= 0) this.state.purchases.splice(i, 1);
    const s = this.spent - r.amount;
    this.state.spentAtomic = (s < 0n ? 0n : s).toString();
    this.persist();
  }

  /** The payment may have been sent: the reservation stays spent. */
  commit(id: string): void {
    this.open.delete(id);
  }
}
