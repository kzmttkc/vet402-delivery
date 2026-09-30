/**
 * Proxy buy's books against a real Postgres server, with real concurrent connections (the review's zz2-pg and
 * zz2-migrate). Runs only when PROXY_BUY_TEST_PG_URL is set (a throwaway database: the tables are dropped):
 *   PROXY_BUY_TEST_PG_URL=postgres://user@127.0.0.1:55433/pb node --import tsx --test test/proxy-buy-pg.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { migrate, pgSql } from "../src/proxy-buy/db.js";
import { reconcile } from "../src/proxy-buy/reconcile.js";
import { Store } from "../src/proxy-buy/store.js";
import { agentPaysSolana, PAYER_ATA, paidReq, solRig } from "./proxy-buy-fakes.js";

const URL0 = process.env.PROXY_BUY_TEST_PG_URL;
const skip = !URL0;
const pool = URL0 ? new pg.Pool({ connectionString: URL0, max: 40 }) : null;
const sql = pool ? pgSql(pool) : null;
const TABLES = "pb_purchase, pb_customer_tx, pb_day, pb_wallet, pb_refund";

async function fresh(): Promise<Store> {
  await pool!.query(`drop table if exists ${TABLES}`);
  await migrate(sql!);
  return new Store(sql!);
}
const caps = { cap: 500_000n, maxCount: 3, refundCap: 1_000_000n };
const now = new Date("2026-09-30T00:00:00Z");
const day = "2026-09-30";
const claim = (s: Store, id: string) => s.claim({ id, chain: "solana", target: "https://x.test/", sellerAmount: 100_000n, feeReserve: 0n, total: 105_000n, facts: {}, now });

test("pg: 8 concurrent cold-start migrations, 5 rounds -> no error", { skip }, async () => {
  const errs: string[] = [];
  for (let round = 0; round < 5; round++) {
    await pool!.query(`drop table if exists ${TABLES}`);
    const pools = Array.from({ length: 8 }, () => new pg.Pool({ connectionString: URL0!, max: 1 }));
    const r = await Promise.allSettled(pools.map((p) => migrate(pgSql(p))));
    r.forEach((x) => x.status === "rejected" && errs.push(String((x.reason as Error).message)));
    await Promise.all(pools.map((p) => p.end()));
  }
  assert.deepEqual(errs, []);
});

test("pg: 50 concurrent claims of one payment key -> exactly one", { skip }, async () => {
  const s = await fresh();
  const r = await Promise.all(Array.from({ length: 50 }, () => claim(s, "k1")));
  assert.equal(r.filter(Boolean).length, 1);
});

test("pg: 40 concurrent admits vs the day count, the wallet floor and the refund room; all released -> back to the start", { skip }, async () => {
  const s = await fresh();
  const ids = Array.from({ length: 40 }, (_, i) => `a${i}`);
  await Promise.all(ids.map((id) => claim(s, id)));
  const res = await Promise.all(ids.map((id) => s.admit(id, { chain: "solana", payer: "P", day, caps, need: 105_000n, balance: 1_000_000n, now })));
  assert.equal(res.filter((x) => x.ok).length, 3);
  const d = await s.dayRow("solana", day);
  assert.equal(d!.count, 3);
  assert.equal(d!.refundReserved, 3n * 105_000n);
  assert.equal((await s.wallet("solana"))!.floor, 1_000_000n - 3n * 105_000n);
  await Promise.all(ids.map((id) => s.release(id)));
  const d2 = await s.dayRow("solana", day);
  assert.deepEqual([d2!.count, d2!.committed, d2!.refundReserved], [0, 0n, 0n]);
  assert.equal((await s.wallet("solana"))!.floor, 1_000_000n);
});

test("pg: 20 concurrent admits vs the day's refund room -> never more refund room reserved than the cap", { skip }, async () => {
  const s = await fresh();
  const ids = Array.from({ length: 20 }, (_, i) => `f${i}`);
  await Promise.all(ids.map((id) => claim(s, id)));
  const res = await Promise.all(ids.map((id) => s.admit(id, { chain: "solana", payer: "P", day, caps: { cap: 10_000_000n, maxCount: 100, refundCap: 300_000n }, need: 105_000n, balance: 10_000_000n, now })));
  assert.equal(res.filter((x) => x.ok).length, 2);
  assert.ok((await s.dayRow("solana", day))!.refundReserved <= 300_000n);
  // one refund per purchase, however many try at once
  const one = await Promise.all(Array.from({ length: 20 }, () => s.refundClaim(ids[res.findIndex((x) => x.ok)]!, { chain: "solana", day, to: "A", amount: 105_000n, maxRefund: 105_000n, now })));
  assert.equal(one.filter((x) => x.ok).length, 1);
});

test("pg: a release racing move(admitted -> settling), 30 times: one wins and the books agree", { skip }, async () => {
  for (let i = 0; i < 30; i++) {
    const s = await fresh();
    await claim(s, "r1");
    await s.admit("r1", { chain: "solana", payer: "P", day, caps, need: 105_000n, balance: 1_000_000n, now });
    const [mv] = await Promise.all([s.move("r1", ["admitted"], "settling", { now }), s.release("r1")]);
    const row = await s.get("r1");
    const w = await s.wallet("solana");
    const d = await s.dayRow("solana", day);
    if (mv) {
      assert.equal(row!.state, "settling");
      assert.equal(w!.floor, 895_000n);
      assert.equal(d!.count, 1);
    } else {
      assert.equal(row, null);
      assert.equal(w!.floor, 1_000_000n);
      assert.equal(d!.count, 0);
    }
  }
});

test("pg: one on-chain payment used by 10 purchases at once -> one", { skip }, async () => {
  const s = await fresh();
  const ids = Array.from({ length: 10 }, (_, i) => `u${i}`);
  for (const id of ids) {
    await claim(s, id);
    await s.admit(id, { chain: "solana", payer: "P", day, caps: { cap: 5_000_000n, maxCount: 100, refundCap: 5_000_000n }, need: 105_000n, balance: 5_000_000n, now });
    await s.move(id, ["admitted"], "settling", { now });
  }
  const r = await Promise.all(ids.map((id) => s.useCustomerTx(id, "solana", "SIG", { facts: {}, record: { id } as never, now })));
  assert.equal(r.filter(Boolean).length, 1);
});

test("pg: four reconcilers at once on a refund whose first attempt is proven dead -> exactly one new refund", { skip }, async () => {
  const s = await fresh();
  await claim(s, "d1");
  await s.admit("d1", { chain: "solana", payer: "P", day, caps, need: 105_000n, balance: 1_000_000n, now });
  await s.move("d1", ["admitted"], "settling", { facts: { agent: { authority: "AGENT" } }, now });
  await s.useCustomerTx("d1", "solana", "CUST", { facts: {}, record: { id: "d1", chain: "solana" } as never, now });
  await s.move("d1", ["in_progress"], "refund_pending", { now });
  await s.refundClaim("d1", { chain: "solana", day, to: "AGENT", amount: 105_000n, maxRefund: 105_000n, now });
  await s.refundSending("d1", ["pending"], { tx: "r1", facts: { messageHash: "m1", blockhash: "b", account: PAYER_ATA }, now });
  await s.refundSet("d1", ["sending"], "unknown", { now });
  let sends = 0;
  const side = {
    fate: async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { fate: "dead" as const };
    },
    refund: async (_to: string, _a: bigint, before: (f: { tx: string; facts: Record<string, unknown> }) => Promise<boolean>) => {
      if (!(await before({ tx: "r2", facts: { messageHash: "m2", blockhash: "b", account: PAYER_ATA } }))) return { status: "failed" as const, reason: "refund_taken_by_another_attempt", tx: null };
      sends++;
      await new Promise((r) => setTimeout(r, 20));
      return { status: "sent" as const, tx: "r2" };
    },
    confirmCustomer: async () => ({ ok: true as const, payer: "AGENT" }),
  };
  const ctx = () => ({ store: s, feeAtomic: 5000n, now: () => new Date(Date.now() + 3_600_000), recordUrl: (id: string) => id, caps, maxRefund: 105_000n, deadline: Date.now() + 10_000, staleMs: 0, solana: side as never });
  await Promise.all([reconcile(ctx()), reconcile(ctx()), reconcile(ctx()), reconcile(ctx())]);
  assert.equal(sends, 1);
  assert.equal((await s.getRefund("d1"))!.status, "sent");
  assert.equal((await s.get("d1"))!.state, "done");
});

test("pg e2e: the same signed payment sent 12 times at once through the handler -> one settle, one seller payment", { skip }, async () => {
  await fresh();
  const r = await solRig({ sql: sql! });
  const { header } = await agentPaysSolana(r.buy);
  const res = await Promise.all(Array.from({ length: 12 }, () => r.buy.handle(paidReq(header))));
  assert.equal(res.filter((x) => x.status === 200).length, 1);
  assert.equal(r.fac.settles, 1);
  assert.equal(r.sellerPays.length, 1);
});

test("pg e2e: 8 distinct payments at once with a day count of 3 -> at most 3 settle", { skip }, async () => {
  await fresh();
  const r = await solRig({ sql: sql!, caps: { maxCount: 3 } });
  const hs: string[] = [];
  for (let i = 0; i < 8; i++) hs.push((await agentPaysSolana(r.buy, undefined, i.toString(16).padStart(2, "0").repeat(16))).header);
  const res = await Promise.all(hs.map((h) => r.buy.handle(paidReq(h))));
  assert.equal(res.filter((x) => x.status === 200).length, 3);
  assert.equal(r.fac.settles, 3);
});

test.after(async () => {
  await pool?.end();
});
