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
import { refundAgent } from "../src/proxy-buy/refund.js";
import { settleByHand } from "../src/proxy-buy/resolve.js";
import { Store } from "../src/proxy-buy/store.js";
import { agentPaysSolana, PAYER_ATA, paidReq, solRig } from "./proxy-buy-fakes.js";

const URL0 = process.env.PROXY_BUY_TEST_PG_URL;
const skip = !URL0;
const pool = URL0 ? new pg.Pool({ connectionString: URL0, max: 40 }) : null;
const sql = pool ? pgSql(pool) : null;
const TABLES = "pb_purchase, pb_customer_tx, pb_day, pb_wallet, pb_refund, pb_chain_tx, pb_counter, pb_alert, pb_state";

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
  // one refund per purchase, however many try at once (a refund is claimed only for a purchase waiting for it)
  const owed = ids[res.findIndex((x) => x.ok)]!;
  await pool!.query(`update pb_purchase set state = 'refund_pending' where id = $1`, [owed]);
  const one = await Promise.all(Array.from({ length: 20 }, () => s.refundClaim(owed, { chain: "solana", day, to: "A", amount: 105_000n, maxRefund: 105_000n, now })));
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

test("pg (third review): 30 purchases bind one on-chain transaction at once -> exactly one owns it", { skip }, async () => {
  const s = await fresh();
  const r = await Promise.all(Array.from({ length: 30 }, (_, i) => s.bindTx("tempo", "0xAB", `p${i}`, "seller", now)));
  assert.equal(r.filter(Boolean).length, 1);
});

test("pg (third review): 40 concurrent requests against a limit of 5 in one window -> exactly 5 pass", { skip }, async () => {
  const s = await fresh();
  const r = await Promise.all(Array.from({ length: 40 }, () => s.bump("rate:x:1", 5, now)));
  assert.equal(r.filter(Boolean).length, 5);
});

test("pg (third review): 20 concurrent admits with SOL for 3 refunds -> exactly 3 admitted", { skip }, async () => {
  const s = await fresh();
  const ids = Array.from({ length: 20 }, (_, i) => `l${i}`);
  await Promise.all(ids.map((id) => claim(s, id)));
  const wide = { cap: 5_000_000n, maxCount: 100, refundCap: 5_000_000n };
  const res = await Promise.all(
    ids.map((id) => s.admit(id, { chain: "solana", payer: "P", day, caps: wide, need: 105_000n, balance: 5_000_000n, lamports: { have: 3n * 2_100_000n + 1n, perPurchase: 2_100_000n }, now })),
  );
  assert.equal(res.filter((x) => x.ok).length, 3);
  assert.ok(res.filter((x) => !x.ok).every((x) => (x as { reason: string }).reason === "refund_fee_unavailable"));
});

// Fourth review (zz4-race): many reconcilers at once on one purchase, three rounds each.
for (const round of [1, 2, 3]) {
  test(`pg (fourth review) race ${round}: 8 reconcilers at once on a seller payment proven dead -> exactly one refund, books closed once`, { skip }, async () => {
    await fresh();
    const r = await solRig({ seller: { paidStatus: 500 }, sellerSettles: false, budgetMs: 200, sql: sql! });
    r.chain.blockhashValid = true;
    const { header } = await agentPaysSolana(r.buy);
    assert.equal((await r.buy.handle(paidReq(header))).status, 502);
    r.chain.blockhashValid = false; // now provably dead
    await Promise.all(Array.from({ length: 8 }, () => r.reconcile()));
    assert.equal(r.refunds.length, 1, String(r.refunds.length));
    assert.deepEqual((await pool!.query(`select state from pb_purchase`)).rows.map((x) => x.state), ["done"]);
    assert.deepEqual((await pool!.query(`select status, attempt from pb_refund`)).rows, [{ status: "sent", attempt: 1 }]);
    assert.deepEqual((await pool!.query(`select refund_reserved::text as rr from pb_day`)).rows, [{ rr: "0" }]);
  });
  test(`pg (fourth review) race ${round}: settle answer lost, 8 reconcilers at once -> one refund`, { skip }, async () => {
    await fresh();
    const r = await solRig({ sql: sql!, budgetMs: 200 });
    r.fac.fail = "settle_throw";
    const { header } = await agentPaysSolana(r.buy);
    assert.equal((await r.buy.handle(paidReq(header))).status, 502);
    await Promise.all(Array.from({ length: 8 }, () => r.reconcile()));
    assert.equal(r.refunds.length, 1, String(r.refunds.length));
    assert.equal(r.sellerPays.length, 0);
  });
}

test("pg (fourth review): a floor raise leaves out a closed purchase's seller payment not yet seen on chain", { skip }, async () => {
  const s = await fresh();
  const wide = { cap: 5_000_000n, maxCount: 100, refundCap: 5_000_000n };
  const t = (sec: number) => new Date(now.getTime() + sec * 1000);
  const admitAt = (id: string, balance: bigint, at: Date) => s.admit(id, { chain: "solana", payer: "P", day, caps: wide, need: 105_000n, balance, balanceReadAt: at, now: at });
  await claim(s, "A");
  assert.deepEqual(await admitAt("A", 1_000_000n, t(0)), { ok: true });
  await s.move("A", ["admitted"], "in_progress", { now: t(1) });
  assert.ok(await s.finish("A", ["in_progress"], { record: { outcome: "delivered" } as never, spent: 100_000n, sellerOpen: true, now: t(2) }));
  await claim(s, "B");
  assert.deepEqual(await admitAt("B", 1_000_000n, t(3600)), { ok: true });
  assert.equal((await s.wallet("solana"))!.floor, 900_000n - 105_000n);
});

// Tenth review: settling by hand racing the reconciler's first refund or its retry, 40 rounds each, real connections.
for (const kind of ["first refund (no refund row yet)", "retry of a dead refund"] as const) {
  test(`pg (tenth review): settle by hand vs the reconciler's ${kind}, 40 rounds -> never both`, { skip }, async () => {
    const s = await fresh();
    const wide = { cap: 50_000_000n, maxCount: 1000, refundCap: 50_000_000n };
    const at = new Date(now.getTime() + 3_600_000);
    let both = 0;
    let neither = 0;
    for (let i = 0; i < 40; i++) {
      const id = `q${i}`;
      await claim(s, id);
      await s.admit(id, { chain: "solana", payer: "P", day, caps: wide, need: 105_000n, balance: 500_000_000n, now });
      await s.move(id, ["admitted"], "settling", { now });
      const rec = { id, chain: "solana", at: now.toISOString(), target: "", seller: { host: "", payTo: "", priceAtomic: "100000" }, feeAtomic: "5000", totalAtomic: "105000", customer: { tx: "C" + id, payer: "A", confirmed: true }, sellerPayment: null, answer: null, outcome: "in_progress", reason: null, refund: "none" };
      await s.useCustomerTx(id, "solana", "C" + id, { facts: { refundTo: "A" }, record: rec as never, now });
      await s.move(id, ["in_progress"], "refund_pending", { now });
      const retry = kind.startsWith("retry");
      if (retry) {
        await s.refundClaim(id, { chain: "solana", day, to: "A", amount: 105_000n, maxRefund: 2_000_000n, now });
        await s.refundSending(id, ["pending"], { tx: "R1", facts: {}, now });
        await s.refundSet(id, ["sending"], "dead", { tx: "R1", now });
      }
      let sent = false;
      const send = async (_to: string, _a: bigint, before: (f: { tx: string; facts: Record<string, unknown> }) => Promise<boolean>) => {
        if (!(await before({ tx: `AUTO_${id}`, facts: {} }))) return { status: "failed" as const, reason: "refund_taken_by_another_attempt", tx: null };
        sent = true;
        return { status: "sent" as const, tx: `AUTO_${id}` };
      };
      const [st] = await Promise.all([
        settleByHand(s, id, { reason: "by hand", spent: 105_000n, refundTx: `HAND_${id}`, now: at }),
        refundAgent(s, send, { id, chain: "solana", day, to: "A", amount: 105_000n, maxRefund: 2_000_000n, now: () => at, ...(retry ? { retry: true } : {}) }),
      ]);
      if (st.ok && sent) both++;
      if (!st.ok && !sent) neither++;
    }
    assert.equal(both, 0, "never a refund by hand and an automatic one");
    assert.equal(neither, 0, "one of them always goes through");
  });
}

// Ninth review: settling by hand racing the reconciler's new refund attempt, on real connections.
test("pg (ninth review): settle by hand vs a new refund attempt at once, 20 rounds -> one wins, never both", { skip }, async () => {
  for (let round = 0; round < 20; round++) {
    const s = await fresh();
    const id = `r${round}`;
    await claim(s, id);
    await s.admit(id, { chain: "solana", payer: "P", day, caps: { cap: 5_000_000n, maxCount: 100, refundCap: 5_000_000n }, need: 105_000n, balance: 1_000_000n, now });
    await s.move(id, ["admitted"], "settling", { now });
    const rec = { id, chain: "solana", at: now.toISOString(), target: "", seller: { host: "", payTo: "", priceAtomic: "100000" }, feeAtomic: "5000", totalAtomic: "105000", customer: { tx: "C" + id, payer: "A", confirmed: true }, sellerPayment: null, answer: null, outcome: "in_progress", reason: null, refund: "none" };
    await s.useCustomerTx(id, "solana", "C" + id, { facts: {}, record: rec as never, now });
    await s.move(id, ["in_progress"], "refund_pending", { now });
    await s.refundClaim(id, { chain: "solana", day, to: "A", amount: 105_000n, maxRefund: 105_000n, now });
    await s.refundSending(id, ["pending"], { tx: "R1", facts: {}, now });
    await s.refundSet(id, ["sending"], "dead", { tx: "R1", now });
    const at = new Date(now.getTime() + 3_600_000);
    const [settled, took] = await Promise.all([
      settleByHand(s, id, { reason: "by hand", spent: 105_000n, refundTx: "HAND", now: at }),
      s.refundSending(id, ["pending", "dead", "failed"], { tx: "R2", facts: {}, now: at }),
    ]);
    assert.notEqual(settled.ok && took, true, `round ${round}: both won`);
    assert.ok(settled.ok || took, `round ${round}: neither won`);
    const rf = (await s.getRefund(id))!;
    const st = (await s.get(id))!.state;
    if (settled.ok) assert.deepEqual([st, rf.status, rf.tx], ["done", "sent", "HAND"]);
    else assert.deepEqual([st, rf.status, rf.tx], ["refund_pending", "sending", "R2"]);
  }
});
