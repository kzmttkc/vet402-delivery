/**
 * Proxy buy's own books: one process lock for the data directory, one ledger per chain per UTC day
 * (the existing Budget for Solana and Ledger for Tempo, in files of their own), the payment keys and
 * the agents' settled transactions that were already used, the refunds, and the published records.
 *
 * One process per data directory. Two processes would each keep their own in-flight state and could
 * both spend the day's headroom, so a second one refuses to start (O_EXCL lock, never broken automatically).
 *
 * UTC day boundary: a purchase keeps the day ledger it was admitted on until it is over. A new day's
 * ledger is opened only when no purchase on that chain is in flight, so a transfer of the previous day
 * can never land after the new day's start block (Tempo) or the new day's balance baseline (Solana).
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Budget } from "../guard.js";
import { FEE_RESERVE_ATOMIC } from "../tempo/constants.js";
import { Ledger } from "../tempo/ledger.js";
import type { ProxyChain } from "./allowlist.js";

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface RefundRecord {
  status: "sent" | "failed" | "unknown" | "refused";
  /** Where the refund went: the address that paid. */
  to: string | null;
  amountAtomic: string;
  tx: string | null;
  reason: string | null;
}

export interface PurchaseRecord {
  /** The payment key: sha256 of the agent's signed transaction, first 32 hex characters. */
  id: string;
  chain: ProxyChain;
  at: string;
  target: string;
  seller: { host: string; payTo: string; priceAtomic: string };
  feeAtomic: string;
  totalAtomic: string;
  customer: { tx: string | null; payer: string | null; confirmed: boolean };
  /** vet402's payment to the seller. null when vet402 did not pay. */
  sellerPayment: { tx: string | null; settled: boolean | null } | null;
  answer: { httpStatus: number | null; delivered: boolean | null; bodySha256: string | null; bodyBytes: number | null; contentType: string | null } | null;
  outcome: "delivered" | "not_delivered" | "seller_not_paid" | "seller_payment_unknown" | "customer_payment_unconfirmed" | "duplicate_customer_tx" | "answer_too_large";
  reason: string | null;
  /** "none": no refund is owed (the seller was paid, or it is not known that the agent paid). */
  refund: "none" | RefundRecord;
}

interface RefundEntry {
  key: string;
  chain: ProxyChain;
  day: string;
  to: string;
  amountAtomic: string;
  status: "pending" | "sent" | "failed" | "unknown";
  tx: string | null;
  feePaid: string | null;
  reason: string | null;
  at: string;
}

export interface ChainCaps {
  payer: string;
  dailyCapAtomic: bigint;
  dailyMaxPurchases: number;
  /** Refunds: at most this much per UTC day on this chain, and at most `maxRefundAtomic` each. */
  dailyRefundCapAtomic: bigint;
  maxRefundAtomic: bigint;
}

export interface BooksOptions {
  dataDir: string;
  solana?: ChainCaps & { maxPerCallAtomic: bigint };
  tempo?: ChainCaps;
  /** Take the O_EXCL process lock (the server does; tests with a temp dir may too). */
  lock?: boolean;
}

export type Headroom<T> =
  | ({ ok: true } & T)
  | { ok: false; reason: "daily_cap_reached" | "purchase_count_reached" | "insufficient_balance" | "refund_fee_unavailable" | "chain_spend_exceeds_ledger"; detail: string };

export interface SolanaDay {
  day: string;
  budget: Budget;
}
export interface TempoDay {
  day: string;
  ledger: Ledger;
  startBlock: bigint;
}

/** SOL the Solana proxy payer must hold to pay a refund's network fee (lamports). */
export const REFUND_SOL_MIN_LAMPORTS = 100_000n;

export class Books {
  private readonly dir: string;
  private lockPath: string | null = null;
  private readonly used = new Set<string>();
  private readonly customerTxs = new Set<string>();
  private readonly inflight = new Map<string, { chain: ProxyChain; amount: bigint; fee: bigint }>();
  private readonly records = new Map<string, PurchaseRecord>();
  private readonly refunds = new Map<string, RefundEntry>();
  private solanaDay: SolanaDay | null = null;
  private tempoDay: TempoDay | null = null;

  constructor(private readonly opts: BooksOptions) {
    this.dir = opts.dataDir;
    mkdirSync(this.dir, { recursive: true });
    if (opts.lock) {
      const lp = join(this.dir, "proxy-buy.lock");
      let fd: number;
      try {
        fd = openSync(lp, "wx");
      } catch {
        throw new Error(`${lp} exists: another proxy-buy process uses this data directory (or one crashed). Check the day ledgers and the chain, then delete the lock.`);
      }
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      closeSync(fd);
      this.lockPath = lp;
    }
    for (const line of this.lines("records.jsonl")) {
      const r = JSON.parse(line) as PurchaseRecord;
      this.records.set(r.id, r);
      this.used.add(r.id);
    }
    for (const k of this.lines("payment-keys.txt")) this.used.add(k.trim());
    for (const t of this.lines("customer-txs.txt")) this.customerTxs.add(t.trim());
    for (const line of this.lines("refunds.jsonl")) {
      const e = JSON.parse(line) as RefundEntry;
      this.refunds.set(e.key, e); // the last line for a key is its state
    }
  }

  private lines(name: string): string[] {
    const f = join(this.dir, name);
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8").split("\n").filter((l) => l.trim());
  }

  release(): void {
    if (!this.lockPath) return;
    try {
      unlinkSync(this.lockPath);
    } catch {
      /* already gone */
    }
    this.lockPath = null;
  }

  /**
   * Take a payment key for this request. false = the same signed transaction was already used or is being
   * processed now (a replay or a double submit). The key is written to disk before the agent's payment is
   * settled (burn) and is never given back once settlement was attempted.
   */
  claim(key: string, chain: ProxyChain, amount: bigint, fee: bigint): boolean {
    if (this.used.has(key) || this.inflight.has(key)) return false;
    this.inflight.set(key, { chain, amount, fee });
    return true;
  }

  /** Before settlement was attempted: nothing was taken from the agent, the key may be used again. */
  unclaim(key: string): void {
    this.inflight.delete(key);
  }

  /** Settlement of the agent's payment is being attempted: the key is spent for good. */
  burn(key: string): void {
    if (this.used.has(key)) return;
    this.used.add(key);
    appendFileSync(join(this.dir, "payment-keys.txt"), `${key}\n`);
  }

  /**
   * The agent's settled transaction, recorded as used before vet402 pays anyone for it. false = this
   * on-chain transaction already paid for a purchase (for example a facilitator that answers a replay
   * with the earlier settlement): nothing more is paid or refunded for it.
   */
  useCustomerTx(chain: ProxyChain, tx: string): boolean {
    const k = `${chain} ${chain === "tempo" ? tx.toLowerCase() : tx}`;
    if (this.customerTxs.has(k)) return false;
    this.customerTxs.add(k);
    appendFileSync(join(this.dir, "customer-txs.txt"), `${k}\n`);
    return true;
  }

  /** The purchase is over (paid or not): drop it from the in-flight headroom. */
  done(key: string): void {
    this.inflight.delete(key);
  }

  private inflightFor(chain: ProxyChain, exceptKey: string): { amount: bigint; count: number } {
    let amount = 0n;
    let count = 0;
    for (const [k, v] of this.inflight) {
      if (k === exceptKey || v.chain !== chain) continue;
      amount += v.amount + v.fee;
      count++;
    }
    return { amount, count };
  }

  private busy(chain: ProxyChain, exceptKey: string): boolean {
    return this.inflightFor(chain, exceptKey).count > 0;
  }

  /** Solana: the day's Budget (its baseline is the payer's USDC balance when the day is opened). */
  solanaBudget(now: Date, usdcBalance: bigint, key = ""): SolanaDay {
    const s = this.opts.solana;
    if (!s) throw new Error("proxy buy: Solana is not configured");
    const day = utcDay(now);
    if (!this.solanaDay || (this.solanaDay.day !== day && !this.busy("solana", key))) {
      const budget = new Budget(join(this.dir, `solana-${day}.json`), s.dailyCapAtomic, s.dailyMaxPurchases, s.maxPerCallAtomic);
      budget.setBaselineIfMissing(usdcBalance);
      this.solanaDay = { day, budget };
    }
    return this.solanaDay;
  }

  /**
   * Room for one more Solana purchase of `amount` on the day ledger it will use, counting the purchases in
   * flight in this process; and room for its refund (`refundTotal` in USDC, and SOL for the refund's fee).
   */
  solanaHeadroom(now: Date, bal: { usdcAtomic: bigint; lamports: bigint }, key: string, amount: bigint, refundTotal: bigint): Headroom<{ day: SolanaDay }> {
    const d = this.solanaBudget(now, bal.usdcAtomic, key);
    const b = d.budget;
    const f = this.inflightFor("solana", key);
    const chain = b.chainSpent(bal.usdcAtomic);
    const spent = (chain > b.spent ? chain : b.spent) + f.amount;
    if (b.count + f.count >= b.maxCount) return { ok: false, reason: "purchase_count_reached", detail: `${b.count + f.count} purchases today >= ${b.maxCount}` };
    if (spent + amount > b.maxTotal) return { ok: false, reason: "daily_cap_reached", detail: `spent ${spent} + ${amount} > daily cap ${b.maxTotal}` };
    const need = f.amount + (refundTotal > amount ? refundTotal : amount);
    if (bal.usdcAtomic < need) return { ok: false, reason: "insufficient_balance", detail: `balance ${bal.usdcAtomic} < ${need}` };
    if (bal.lamports < REFUND_SOL_MIN_LAMPORTS) return { ok: false, reason: "refund_fee_unavailable", detail: `SOL ${bal.lamports} lamports < ${REFUND_SOL_MIN_LAMPORTS}` };
    return { ok: true, day: d };
  }

  /** Tempo: the day's Ledger. The day's start block is read when the day is first opened and kept next to it. */
  async tempoLedger(now: Date, head: () => Promise<bigint>, key = ""): Promise<TempoDay> {
    const t = this.opts.tempo;
    if (!t) throw new Error("proxy buy: Tempo is not configured");
    const day = utcDay(now);
    if (!this.tempoDay || (this.tempoDay.day !== day && !this.busy("tempo", key))) {
      const startFile = join(this.dir, `tempo-${day}.start.json`);
      let startBlock: bigint;
      if (existsSync(startFile)) {
        startBlock = BigInt((JSON.parse(readFileSync(startFile, "utf8")) as { startBlock: string }).startBlock);
      } else {
        startBlock = await head();
        writeFileSync(startFile, JSON.stringify({ startBlock: startBlock.toString() }) + "\n");
      }
      const ledger = new Ledger(join(this.dir, `tempo-${day}.json`), t.payer, t.dailyCapAtomic);
      this.tempoDay = { day, ledger, startBlock };
    }
    return this.tempoDay;
  }

  /** USDC.e the Tempo payer sent as refunds (amount + fee, the fee reserve while unknown) for purchases of `day`. */
  tempoRefundOutflow(day: string): bigint {
    let sum = 0n;
    for (const e of this.refunds.values()) {
      if (e.chain !== "tempo" || e.day !== day || e.status === "failed") continue;
      sum += BigInt(e.amountAtomic) + (e.feePaid && /^\d+$/.test(e.feePaid) ? BigInt(e.feePaid) : FEE_RESERVE_ATOMIC);
    }
    return sum;
  }

  /**
   * Room for one more Tempo purchase, with the same stops src/tempo/pay.ts applies after the agent has paid
   * (on-chain outflow above the ledger, balance, cap), checked here before the agent's payment settles,
   * plus the balance a refund would need.
   */
  async tempoHeadroom(
    now: Date,
    head: () => Promise<bigint>,
    key: string,
    need: { amount: bigint; feeReserve: bigint; refundTotal: bigint },
    chain: { spentSinceStart: (fromBlock: bigint) => Promise<bigint>; balance: () => Promise<bigint> },
  ): Promise<Headroom<{ day: TempoDay }>> {
    const t = this.opts.tempo;
    if (!t) throw new Error("proxy buy: Tempo is not configured");
    const d = await this.tempoLedger(now, head, key);
    const { ledger } = d;
    const f = this.inflightFor("tempo", key);
    if (ledger.count() + f.count >= t.dailyMaxPurchases) return { ok: false, reason: "purchase_count_reached", detail: `${ledger.count() + f.count} purchases today >= ${t.dailyMaxPurchases}` };
    const spentOnChain = await this.tempoSpentForLedger(d, chain.spentSinceStart);
    if (spentOnChain > ledger.committed()) return { ok: false, reason: "chain_spend_exceeds_ledger", detail: `on-chain outflow ${spentOnChain} > ledger ${ledger.committed()}` };
    const spent = ledger.committed() + f.amount;
    if (spent + need.amount + need.feeReserve > ledger.cap) return { ok: false, reason: "daily_cap_reached", detail: `spent ${spent} + ${need.amount} + fee ${need.feeReserve} > daily cap ${ledger.cap}` };
    const bal = await chain.balance();
    const want = f.amount + (need.refundTotal > need.amount ? need.refundTotal : need.amount) + need.feeReserve;
    if (bal < want) return { ok: false, reason: "insufficient_balance", detail: `balance ${bal} < ${want}` };
    return { ok: true, day: d };
  }

  /** On-chain USDC.e outflow of the payer since the day's start block, less the refunds (they are in the refund ledger). */
  async tempoSpentForLedger(d: TempoDay, spentSinceStart: (fromBlock: bigint) => Promise<bigint>): Promise<bigint> {
    const out = (await spentSinceStart(d.startBlock)) - this.tempoRefundOutflow(d.day);
    return out > 0n ? out : 0n;
  }

  /**
   * Take the refund for one payment key. One refund per key, ever (also across restarts); at most
   * `maxRefundAtomic` each and `dailyRefundCapAtomic` per chain per UTC day. Written before anything is signed.
   */
  refundClaim(key: string, chain: ProxyChain, day: string, to: string, amount: bigint, now: Date): { ok: true } | { ok: false; reason: string } {
    const caps = chain === "solana" ? this.opts.solana : this.opts.tempo;
    if (!caps) return { ok: false, reason: "chain_not_configured" };
    if (this.refunds.has(key)) return { ok: false, reason: "already_refunded" };
    if (amount <= 0n || amount > caps.maxRefundAtomic) return { ok: false, reason: "refund_over_cap" };
    let today = 0n;
    for (const e of this.refunds.values()) if (e.chain === chain && e.day === day && e.status !== "failed") today += BigInt(e.amountAtomic);
    if (today + amount > caps.dailyRefundCapAtomic) return { ok: false, reason: "daily_refund_cap_reached" };
    this.writeRefund({ key, chain, day, to, amountAtomic: amount.toString(), status: "pending", tx: null, feePaid: null, reason: null, at: now.toISOString() });
    return { ok: true };
  }

  refundResult(key: string, r: { status: "sent" | "failed" | "unknown"; tx: string | null; feePaid?: string | null; reason?: string | null }, now: Date): void {
    const e = this.refunds.get(key);
    if (!e) throw new Error("refund: no entry for this key");
    this.writeRefund({ ...e, status: r.status, tx: r.tx, feePaid: r.feePaid ?? null, reason: r.reason ?? null, at: now.toISOString() });
  }

  private writeRefund(e: RefundEntry): void {
    this.refunds.set(e.key, e);
    appendFileSync(join(this.dir, "refunds.jsonl"), JSON.stringify(e) + "\n");
  }

  record(r: PurchaseRecord): void {
    this.records.set(r.id, r);
    appendFileSync(join(this.dir, "records.jsonl"), JSON.stringify(r) + "\n");
  }

  getRecord(id: string): PurchaseRecord | null {
    return this.records.get(id) ?? null;
  }
}
