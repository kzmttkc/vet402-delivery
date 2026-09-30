/**
 * Proxy buy's books, in Postgres (src/proxy-buy/db.ts): several serverless instances, or an instance stopped half
 * way, see one state.
 *
 * A purchase row moves through these states (every move is a guarded UPDATE: `where state = any(from)`, and the
 * reconciler also pins `updated_at`, so it never acts on a row someone changed after it read it):
 *   claimed      the payment key is taken (unique); nothing reserved, nothing charged
 *   admitted     the wallet, the day cap and the day's refund room are reserved; nothing charged yet
 *   settling     the agent's payment is being settled: from here the key is never reusable
 *   in_progress  the agent's payment is confirmed on chain and recorded as used; the seller is being paid
 *   seller_unsettled  vet402's payment to the seller was handed over and not seen on chain yet
 *   refund_pending    vet402 did not pay the seller; the refund is owed (see pb_refund)
 *   done         final: the record says what happened
 * claimed/admitted rows are deleted when the request stops before settlement (the key may be used again).
 * Every other non-final state is picked up by the reconciler once it is older than a function can run. While
 * such a row is open, new paid requests from the same agent or to the same seller wait (`blockingFor`);
 * everyone else is served.
 */
import type { ProxyChain } from "./allowlist.js";
import type { Sql } from "./db.js";

export type PurchaseState = "claimed" | "admitted" | "settling" | "in_progress" | "seller_unsettled" | "refund_pending" | "done";
export const OPEN_STATES: PurchaseState[] = ["settling", "in_progress", "seller_unsettled", "refund_pending"];
/** A refund is sent at most this many times; then it is "stuck" and needs a human (the reconciler reports it). */
export const MAX_REFUND_ATTEMPTS = 3;

export interface RefundRecord {
  status: "sent" | "failed" | "unknown" | "refused" | "pending" | "stuck";
  /** Where the refund goes: the owner of the account whose balance paid. */
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
  /** The seller endpoint without its query string (the query is the agent's input, not published). */
  target: string;
  seller: { host: string; payTo: string; priceAtomic: string };
  feeAtomic: string;
  totalAtomic: string;
  customer: { tx: string | null; payer: string | null; confirmed: boolean };
  /** vet402's payment to the seller. null when vet402 did not pay (or never handed a payment over). */
  sellerPayment: { tx: string | null; settled: boolean | null } | null;
  answer: { httpStatus: number | null; delivered: boolean | null; bodySha256: string | null; bodyBytes: number | null; contentType: string | null } | null;
  outcome:
    | "in_progress"
    | "delivered"
    | "not_delivered"
    | "seller_not_paid"
    | "seller_payment_pending"
    | "customer_payment_unconfirmed"
    | "duplicate_customer_tx"
    | "answer_too_large"
    | "no_charge";
  reason: string | null;
  /** "none": no refund is owed (the seller was paid and did not deliver, or the answer was delivered). */
  refund: "none" | RefundRecord;
}

export interface DayCaps {
  cap: bigint;
  maxCount: number;
  refundCap: bigint;
}

export type Refusal = { ok: false; reason: string; detail: string };

class Rollback extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.reason);
  }
}

const iso = (d: Date) => d.toISOString();

export interface PurchaseRow {
  id: string;
  chain: ProxyChain;
  state: PurchaseState;
  day: string | null;
  target: string;
  seller_host: string;
  agent: string | null;
  seller_amount: string;
  fee_reserve: string;
  total: string;
  reserved: string;
  facts: Record<string, unknown>;
  record: PurchaseRecord | null;
  updated_at: string;
  created_at: string;
}

const ROW = `id, chain, state, to_char(day, 'YYYY-MM-DD') as day, target, seller_host, agent, seller_amount::text as seller_amount,
  fee_reserve::text as fee_reserve, total::text as total, reserved::text as reserved, facts, record,
  to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.FF6"Z"') as updated_at,
  to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.FF6"Z"') as created_at`;

export interface RefundRow {
  purchase_id: string;
  chain: ProxyChain;
  day: string;
  to_addr: string;
  amount: string;
  status: "pending" | "sending" | "sent" | "dead" | "failed" | "unknown" | "stuck";
  attempt: number;
  tx: string | null;
  facts: Record<string, unknown>;
  fee_paid: string | null;
  reason: string | null;
  updated_at: string;
}
const REFUND_ROW = `purchase_id, chain, to_char(day, 'YYYY-MM-DD') as day, to_addr, amount::text as amount, status, attempt, tx, facts,
  fee_paid::text as fee_paid, reason, updated_at::text as updated_at`;

export class Store {
  constructor(readonly sql: Sql) {}

  /** Take the payment key. false: the same signed payment is already used or in flight. */
  async claim(p: {
    id: string;
    chain: ProxyChain;
    target: string;
    sellerHost?: string;
    agent?: string | null;
    sellerAmount: bigint;
    feeReserve: bigint;
    total: bigint;
    facts: Record<string, unknown>;
    now: Date;
  }): Promise<boolean> {
    const r = await this.sql.query(
      `insert into pb_purchase (id, chain, state, target, seller_host, agent, seller_amount, fee_reserve, total, facts, created_at, updated_at)
       values ($1, $2, 'claimed', $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $10) on conflict (id) do nothing returning id`,
      [p.id, p.chain, p.target, (p.sellerHost ?? "").toLowerCase(), p.agent ? p.agent.toLowerCase() : null, p.sellerAmount.toString(), p.feeReserve.toString(), p.total.toString(), JSON.stringify(p.facts), iso(p.now)],
    );
    return r.rows.length === 1;
  }

  /**
   * Reserve for one purchase, in one transaction:
   *   the wallet (`need`: the most this purchase can take out of the payer, a refund and its fee included);
   *   the day (seller price + fee reserve, one purchase);
   *   the day's refund room (the total), so a refund that may become owed can never be refused by the cap later.
   * The payer's balance may not be below the floor (the lowest balance proxy buy's own spending can explain). A
   * higher balance raises the floor only while no other purchase is in flight and none closed since the balance
   * was read (`balanceReadAt`): a top-up, not a spend that the balance read did not see yet.
   */
  async admit(
    id: string,
    o: { chain: ProxyChain; payer: string; day: string; caps: DayCaps; need: bigint; balance: bigint; balanceReadAt?: Date; now: Date },
  ): Promise<{ ok: true } | Refusal> {
    try {
      await this.sql.tx(async (q) => {
        const cur = await q.query<{ seller_amount: string; fee_reserve: string; total: string }>(
          `select seller_amount::text as seller_amount, fee_reserve::text as fee_reserve, total::text as total from pb_purchase where id = $1 and state = 'claimed' for update`,
          [id],
        );
        if (cur.rows.length !== 1) throw new Rollback({ ok: false, reason: "not_claimed", detail: "the payment key is not held by this request" });
        const dayAmount = BigInt(cur.rows[0]!.seller_amount) + BigInt(cur.rows[0]!.fee_reserve);
        const total = BigInt(cur.rows[0]!.total);
        await q.query(`insert into pb_wallet (chain, payer, floor) values ($1, $2, $3) on conflict (chain) do nothing`, [o.chain, o.payer, o.balance.toString()]);
        const w = await q.query<{ payer: string; floor: string }>(`select payer, floor::text as floor from pb_wallet where chain = $1 for update`, [o.chain]);
        const wallet = w.rows[0]!;
        if (wallet.payer.toLowerCase() !== o.payer.toLowerCase()) throw new Rollback({ ok: false, reason: "wallet_changed", detail: "the configured payer is not the one the books were kept for" });
        let floor = BigInt(wallet.floor);
        if (o.balance < floor) throw new Rollback({ ok: false, reason: "chain_spend_exceeds_ledger", detail: `balance ${o.balance} < floor ${floor}` });
        if (o.balance > floor) {
          const busy = await q.query(
            `select 1 from pb_purchase where chain = $1 and id <> $2 and (state = any($3) or (state = 'done' and updated_at >= $4)) limit 1`,
            [o.chain, id, ["admitted", ...OPEN_STATES], iso(o.balanceReadAt ?? o.now)],
          );
          if (busy.rows.length === 0) floor = o.balance;
        }
        if (floor - o.need < 0n) throw new Rollback({ ok: false, reason: "insufficient_balance", detail: `balance for proxy buy ${floor} < ${o.need}` });
        await q.query(`update pb_wallet set floor = $2 where chain = $1`, [o.chain, (floor - o.need).toString()]);
        await q.query(
          `insert into pb_day (chain, day, cap, max_count, refund_cap) values ($1, $2, $3, $4, $5) on conflict (chain, day) do nothing`,
          [o.chain, o.day, o.caps.cap.toString(), o.caps.maxCount, o.caps.refundCap.toString()],
        );
        const d = await q.query(
          `update pb_day set committed = committed + $3, count = count + 1, refund_reserved = refund_reserved + $4
           where chain = $1 and day = $2 and committed + $3 <= cap and count < max_count and refund_reserved + $4 <= refund_cap returning count`,
          [o.chain, o.day, dayAmount.toString(), total.toString()],
        );
        if (d.rows.length !== 1) {
          const c = (
            await q.query<{ committed: string; count: number; cap: string; max_count: number; refund_reserved: string; refund_cap: string }>(
              `select committed::text as committed, count, cap::text as cap, max_count, refund_reserved::text as refund_reserved, refund_cap::text as refund_cap from pb_day where chain = $1 and day = $2`,
              [o.chain, o.day],
            )
          ).rows[0]!;
          throw new Rollback(
            Number(c.count) >= Number(c.max_count)
              ? { ok: false, reason: "purchase_count_reached", detail: `${c.count} purchases today >= ${c.max_count}` }
              : BigInt(c.committed) + dayAmount > BigInt(c.cap)
                ? { ok: false, reason: "daily_cap_reached", detail: `spent ${c.committed} + ${dayAmount} > daily cap ${c.cap}` }
                : { ok: false, reason: "daily_refund_cap_reached", detail: `refund room ${c.refund_reserved} + ${total} > ${c.refund_cap}` },
          );
        }
        await q.query(`update pb_purchase set state = 'admitted', day = $2, reserved = $3, updated_at = $4 where id = $1`, [id, o.day, o.need.toString(), iso(o.now)]);
      });
      return { ok: true };
    } catch (e) {
      if (e instanceof Rollback) return e.refusal;
      throw e;
    }
  }

  /** Before settlement: give the reservations back and drop the row (the payment key may be used again). */
  async release(id: string): Promise<void> {
    await this.sql.tx(async (q) => {
      const r = await q.query<PurchaseRow>(`select ${ROW} from pb_purchase where id = $1 and state = any($2) for update`, [id, ["claimed", "admitted"]]);
      const row = r.rows[0];
      if (!row) return;
      if (row.state === "admitted") {
        await q.query(`update pb_wallet set floor = floor + $2 where chain = $1`, [row.chain, row.reserved]);
        await q.query(`update pb_day set committed = committed - $3, count = count - 1, refund_reserved = refund_reserved - $4 where chain = $1 and day = $2`, [
          row.chain,
          row.day,
          (BigInt(row.seller_amount) + BigInt(row.fee_reserve)).toString(),
          row.total,
        ]);
      }
      await q.query(`delete from pb_purchase where id = $1`, [id]);
    });
  }

  /**
   * Guarded state change; `facts` are merged. false: the row was not in one of `from` (or, with `updatedAt`, it was
   * changed after that time was read).
   */
  async move(id: string, from: PurchaseState[], to: PurchaseState, o: { facts?: Record<string, unknown>; record?: PurchaseRecord | null; updatedAt?: string; now: Date }): Promise<boolean> {
    const r = await this.sql.query(
      `update pb_purchase set state = $3, facts = facts || $4::jsonb, record = coalesce($5::jsonb, record), updated_at = $6
       where id = $1 and state = any($2) and ($7::timestamptz is null or updated_at = $7::timestamptz) returning id`,
      [id, from, to, JSON.stringify(o.facts ?? {}), o.record ? JSON.stringify(o.record) : null, iso(o.now), o.updatedAt ?? null],
    );
    return r.rows.length === 1;
  }

  /**
   * The agent's settled transaction, recorded as used, and the purchase marked in progress with its record, in one
   * transaction, before vet402 pays anyone for it. false: this on-chain payment already paid for a purchase.
   */
  async useCustomerTx(id: string, chain: ProxyChain, tx: string, o: { facts: Record<string, unknown>; record: PurchaseRecord; updatedAt?: string; now: Date }): Promise<boolean> {
    return this.sql.tx(async (q) => {
      const r = await q.query(`insert into pb_customer_tx (chain, tx, purchase_id) values ($1, $2, $3) on conflict (chain, tx) do nothing returning tx`, [
        chain,
        chain === "tempo" ? tx.toLowerCase() : tx,
        id,
      ]);
      if (r.rows.length !== 1) return false;
      const m = await q.query(
        `update pb_purchase set state = 'in_progress', facts = facts || $2::jsonb, record = $3::jsonb, updated_at = $4
         where id = $1 and state = 'settling' and ($5::timestamptz is null or updated_at = $5::timestamptz) returning id`,
        [id, JSON.stringify(o.facts), JSON.stringify(o.record), iso(o.now), o.updatedAt ?? null],
      );
      if (m.rows.length !== 1) throw new Error("purchase is not settling");
      return true;
    });
  }

  /**
   * Final: the record; what the purchase did not take out of the wallet (`reserved - spent`) goes back to the floor,
   * and its refund room goes back to the day.
   */
  async finish(id: string, from: PurchaseState[], o: { record: PurchaseRecord; spent: bigint; facts?: Record<string, unknown>; updatedAt?: string; now: Date }): Promise<boolean> {
    return this.sql.tx(async (q) => {
      const r = await q.query<{ chain: string; reserved: string; total: string; day: string | null }>(
        `update pb_purchase set state = 'done', record = $3::jsonb, facts = facts || $4::jsonb, updated_at = $5
         where id = $1 and state = any($2) and ($6::timestamptz is null or updated_at = $6::timestamptz)
         returning chain, reserved::text as reserved, total::text as total, to_char(day, 'YYYY-MM-DD') as day`,
        [id, from, JSON.stringify(o.record), JSON.stringify(o.facts ?? {}), iso(o.now), o.updatedAt ?? null],
      );
      if (r.rows.length !== 1) return false;
      const row = r.rows[0]!;
      const reserved = BigInt(row.reserved);
      const left = reserved - o.spent;
      const give = left < 0n ? 0n : left > reserved ? reserved : left;
      if (give > 0n) await q.query(`update pb_wallet set floor = floor + $2 where chain = $1`, [row.chain, give.toString()]);
      if (row.day) await q.query(`update pb_day set refund_reserved = refund_reserved - $3 where chain = $1 and day = $2`, [row.chain, row.day, row.total]);
      return true;
    });
  }

  async get(id: string): Promise<PurchaseRow | null> {
    const r = await this.sql.query<PurchaseRow>(`select ${ROW} from pb_purchase where id = $1`, [id]);
    return r.rows[0] ?? null;
  }

  async getRecord(id: string): Promise<PurchaseRecord | null> {
    const r = await this.sql.query<{ record: PurchaseRecord | null }>(`select record from pb_purchase where id = $1`, [id]);
    return r.rows[0]?.record ?? null;
  }

  /**
   * Take the refund for one purchase: one per purchase ever (primary key). The day's refund room was reserved when
   * the purchase was admitted, so the cap cannot refuse it here.
   */
  async refundClaim(id: string, o: { chain: ProxyChain; day: string; to: string; amount: bigint; maxRefund: bigint; now: Date }): Promise<{ ok: true } | Refusal> {
    if (o.amount <= 0n || o.amount > o.maxRefund) return { ok: false, reason: "refund_over_cap", detail: `${o.amount} > ${o.maxRefund}` };
    return this.sql.tx(async (q) => {
      const r = await q.query(
        `insert into pb_refund (purchase_id, chain, day, to_addr, amount, status, updated_at) values ($1, $2, $3, $4, $5, 'pending', $6)
         on conflict (purchase_id) do nothing returning purchase_id`,
        [id, o.chain, o.day, o.to, o.amount.toString(), iso(o.now)],
      );
      if (r.rows.length !== 1) return { ok: false as const, reason: "already_refunded", detail: "a refund for this purchase exists" };
      await q.query(`update pb_day set refunded = refunded + $3 where chain = $1 and day = $2`, [o.chain, o.day, o.amount.toString()]);
      return { ok: true as const };
    });
  }

  /**
   * Before a refund transaction is sent: its facts (signature/hash and expiry) are written first. A new attempt
   * (from "dead" or "failed") counts, and stops at MAX_REFUND_ATTEMPTS.
   */
  async refundSending(id: string, from: RefundRow["status"][], o: { tx: string; facts: Record<string, unknown>; now: Date }): Promise<boolean> {
    const r = await this.sql.query(
      `update pb_refund set status = 'sending', tx = $3, facts = $4::jsonb, attempt = attempt + (case when status in ('dead', 'failed') then 1 else 0 end), updated_at = $5
       where purchase_id = $1 and status = any($2) and (status not in ('dead', 'failed') or attempt < $6) returning purchase_id`,
      [id, from, o.tx, JSON.stringify(o.facts), iso(o.now), MAX_REFUND_ATTEMPTS],
    );
    return r.rows.length === 1;
  }

  /** Guarded refund status change; with `tx`, only while the row still carries that transaction. */
  async refundSet(id: string, from: RefundRow["status"][], to: RefundRow["status"], o: { feePaid?: string | null; reason?: string | null; tx?: string | null; now: Date }): Promise<boolean> {
    const r = await this.sql.query(
      `update pb_refund set status = $3, fee_paid = coalesce($4, fee_paid), reason = $5, updated_at = $6
       where purchase_id = $1 and status = any($2) and ($7::text is null or tx = $7::text) returning purchase_id`,
      [id, from, to, o.feePaid ?? null, o.reason ?? null, iso(o.now), o.tx ?? null],
    );
    return r.rows.length === 1;
  }

  async getRefund(id: string): Promise<RefundRow | null> {
    const r = await this.sql.query<RefundRow>(`select ${REFUND_ROW} from pb_refund where purchase_id = $1`, [id]);
    return r.rows[0] ?? null;
  }

  /** Purchases in a non-final state not touched for `staleMs`: they need the reconciler. */
  async stale(now: Date, staleMs: number, limit = 50): Promise<PurchaseRow[]> {
    const r = await this.sql.query<PurchaseRow>(`select ${ROW} from pb_purchase where state <> 'done' and updated_at < $1 order by updated_at limit $2`, [
      iso(new Date(now.getTime() - staleMs)),
      limit,
    ]);
    return r.rows;
  }

  /**
   * Open purchases (money may have moved, outcome not settled) from this agent or to this seller host, older than
   * `staleMs`: a new paid request from that agent or to that seller waits for them. Nobody else is held up.
   */
  async blockingFor(now: Date, staleMs: number, o: { agent?: string | null; host?: string | null }): Promise<number> {
    const r = await this.sql.query<{ n: string }>(
      `select count(*)::text as n from pb_purchase where state = any($1) and updated_at < $2 and ((agent is not null and agent = $3) or (seller_host <> '' and seller_host = $4))`,
      [OPEN_STATES, iso(new Date(now.getTime() - staleMs)), o.agent ? o.agent.toLowerCase() : null, o.host ? o.host.toLowerCase() : null],
    );
    return Number(r.rows[0]?.n ?? 0);
  }

  /** Test and ops helper: the wallet floor and the day row. */
  async wallet(chain: ProxyChain): Promise<{ payer: string; floor: bigint } | null> {
    const r = await this.sql.query<{ payer: string; floor: string }>(`select payer, floor::text as floor from pb_wallet where chain = $1`, [chain]);
    return r.rows[0] ? { payer: r.rows[0].payer, floor: BigInt(r.rows[0].floor) } : null;
  }

  async dayRow(chain: ProxyChain, day: string): Promise<{ committed: bigint; count: number; refunded: bigint; refundReserved: bigint } | null> {
    const r = await this.sql.query<{ committed: string; count: number; refunded: string; refund_reserved: string }>(
      `select committed::text as committed, count, refunded::text as refunded, refund_reserved::text as refund_reserved from pb_day where chain = $1 and day = $2`,
      [chain, day],
    );
    const x = r.rows[0];
    return x ? { committed: BigInt(x.committed), count: Number(x.count), refunded: BigInt(x.refunded), refundReserved: BigInt(x.refund_reserved) } : null;
  }
}

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
