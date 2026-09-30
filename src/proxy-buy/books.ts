/**
 * Proxy buy's own books: one process lock for the data directory, one ledger per chain per UTC day
 * (the existing Budget for Solana and Ledger for Tempo, in files of their own), the payment keys that
 * were already used, and the published purchase records.
 *
 * One process per data directory. Two processes would each keep their own in-flight state and could
 * both spend the day's headroom, so a second one refuses to start (O_EXCL lock, never broken automatically).
 */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { Budget } from "../guard.js";
import { Ledger } from "../tempo/ledger.js";
import type { ProxyChain } from "./allowlist.js";

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface PurchaseRecord {
  /** The payment key: sha256 of the agent's signed payment, first 32 hex characters. */
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
  outcome: "delivered" | "not_delivered" | "seller_not_paid" | "seller_payment_unknown" | "customer_payment_unconfirmed" | "answer_too_large";
  reason: string | null;
  refund: "none";
}

export interface BooksOptions {
  dataDir: string;
  solana?: { payer: string; dailyCapAtomic: bigint; maxPerCallAtomic: bigint; dailyMaxPurchases: number };
  tempo?: { payer: string; dailyCapAtomic: bigint; dailyMaxPurchases: number };
  /** Take the O_EXCL process lock (the server does; tests with a temp dir may too). */
  lock?: boolean;
}

type Headroom =
  | { ok: true }
  | { ok: false; reason: "daily_cap_reached" | "purchase_count_reached" | "insufficient_balance" | "chain_spend_exceeds_ledger"; detail: string };

export class Books {
  private readonly dir: string;
  private lockPath: string | null = null;
  private readonly used = new Set<string>();
  private readonly inflight = new Map<string, { chain: ProxyChain; amount: bigint; fee: bigint }>();
  private readonly records = new Map<string, PurchaseRecord>();
  private solanaDay: { day: string; budget: Budget } | null = null;
  private tempoDay: { day: string; ledger: Ledger; startBlock: bigint } | null = null;

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
    const rf = this.recordsFile();
    if (existsSync(rf)) {
      for (const line of readFileSync(rf, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const r = JSON.parse(line) as PurchaseRecord;
        this.records.set(r.id, r);
        this.used.add(r.id);
      }
    }
    const kf = this.keysFile();
    if (existsSync(kf)) for (const k of readFileSync(kf, "utf8").split("\n")) if (k.trim()) this.used.add(k.trim());
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

  private recordsFile() {
    return join(this.dir, "records.jsonl");
  }
  private keysFile() {
    return join(this.dir, "payment-keys.txt");
  }

  /**
   * Take a payment key for this request. false = the same signed payment was already used or is being
   * processed now (a replay or a double submit). The key is written to disk before the agent's payment
   * is settled and is never given back once settlement was attempted.
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
    appendFileSync(this.keysFile(), `${key}\n`);
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

  /** Solana: the day's Budget (created with the payer's USDC balance as its baseline). */
  solanaBudget(now: Date, usdcBalance: bigint): Budget {
    const s = this.opts.solana;
    if (!s) throw new Error("proxy buy: Solana is not configured");
    const day = utcDay(now);
    if (!this.solanaDay || this.solanaDay.day !== day) {
      const budget = new Budget(join(this.dir, `solana-${day}.json`), s.dailyCapAtomic, s.dailyMaxPurchases, s.maxPerCallAtomic);
      budget.setBaselineIfMissing(usdcBalance);
      this.solanaDay = { day, budget };
    }
    return this.solanaDay.budget;
  }

  /** Room for one more Solana purchase of `amount` today, counting the ones in flight in this process. */
  solanaHeadroom(now: Date, usdcBalance: bigint, key: string, amount: bigint): Headroom {
    const b = this.solanaBudget(now, usdcBalance);
    const f = this.inflightFor("solana", key);
    const chain = b.chainSpent(usdcBalance);
    const spent = (chain > b.spent ? chain : b.spent) + f.amount;
    if (b.count + f.count >= b.maxCount) return { ok: false, reason: "purchase_count_reached", detail: `${b.count + f.count} purchases today >= ${b.maxCount}` };
    if (spent + amount > b.maxTotal) return { ok: false, reason: "daily_cap_reached", detail: `spent ${spent} + ${amount} > daily cap ${b.maxTotal}` };
    if (usdcBalance < f.amount + amount) return { ok: false, reason: "insufficient_balance", detail: `balance ${usdcBalance} < ${f.amount + amount}` };
    return { ok: true };
  }

  /**
   * Tempo: the day's Ledger. `head` is read when the day's ledger is first opened; the chain outflow for
   * the day is counted from that block (kept next to the ledger).
   */
  async tempoLedger(now: Date, head: () => Promise<bigint>): Promise<{ ledger: Ledger; startBlock: bigint }> {
    const t = this.opts.tempo;
    if (!t) throw new Error("proxy buy: Tempo is not configured");
    const day = utcDay(now);
    if (!this.tempoDay || this.tempoDay.day !== day) {
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
    return { ledger: this.tempoDay.ledger, startBlock: this.tempoDay.startBlock };
  }

  /**
   * Room for one more Tempo purchase, with the same stops src/tempo/pay.ts applies after the agent has
   * paid (on-chain outflow above the ledger, balance, cap), checked here before the agent's payment settles.
   */
  async tempoHeadroom(
    now: Date,
    head: () => Promise<bigint>,
    key: string,
    need: { amount: bigint; feeReserve: bigint },
    chain: { spentSinceStart: (fromBlock: bigint) => Promise<bigint>; balance: () => Promise<bigint> },
  ): Promise<Headroom> {
    const t = this.opts.tempo;
    if (!t) throw new Error("proxy buy: Tempo is not configured");
    const { ledger, startBlock } = await this.tempoLedger(now, head);
    const f = this.inflightFor("tempo", key);
    if (ledger.count() + f.count >= t.dailyMaxPurchases) return { ok: false, reason: "purchase_count_reached", detail: `${ledger.count() + f.count} purchases today >= ${t.dailyMaxPurchases}` };
    const spentOnChain = await chain.spentSinceStart(startBlock);
    if (spentOnChain > ledger.committed()) return { ok: false, reason: "chain_spend_exceeds_ledger", detail: `on-chain outflow ${spentOnChain} > ledger ${ledger.committed()}` };
    const spent = ledger.committed() + f.amount;
    if (spent + need.amount + need.feeReserve > ledger.cap) return { ok: false, reason: "daily_cap_reached", detail: `spent ${spent} + ${need.amount} + fee ${need.feeReserve} > daily cap ${ledger.cap}` };
    const bal = await chain.balance();
    if (bal < f.amount + need.amount + need.feeReserve) return { ok: false, reason: "insufficient_balance", detail: `balance ${bal} < ${f.amount + need.amount + need.feeReserve}` };
    return { ok: true };
  }

  record(r: PurchaseRecord): void {
    this.records.set(r.id, r);
    appendFileSync(this.recordsFile(), JSON.stringify(r) + "\n");
  }

  getRecord(id: string): PurchaseRecord | null {
    return this.records.get(id) ?? null;
  }
}
