/**
 * The refund for an answer the seller did not deliver after vet402 paid it (Solana, src/proxy-buy/not-delivered.ts).
 * Fake chain, fake facilitator, mock sellers and an in-process Postgres (PGlite): nothing is sent anywhere.
 *
 * What is fixed here: which answers are refunded (and which are not), the amount, the caps per UTC day and month,
 * the three abuse checks, one refund per purchase (also under concurrency), a refund that fails to send staying
 * owed for the reconciler, the wallet books, and that with the caps unset nothing changes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSigner } from "@solana/kit";
import { makeAllowlist } from "../src/proxy-buy/allowlist.js";
import { configFromEnv, notDeliveredRefundCaps } from "../src/proxy-buy/config.js";
import { REFUND_POLICY, REFUND_POLICY_NOT_DELIVERED } from "../src/proxy-buy/constants.js";
import { fetchFailureKind, holdActive, notDeliveredFault, type NotDeliveredRefund } from "../src/proxy-buy/not-delivered.js";
import type { PurchaseRecord } from "../src/proxy-buy/store.js";
import { classifyFailure } from "../src/rank/classify.js";
import type { Attempt } from "../src/rank/types.js";
import { agent, agentPaysSolana, paidReq, proxyPayer, RECEIVE, S_HOST, SELLER, solRig, type SolRig } from "./proxy-buy-fakes.js";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const LATER = new Date("2026-10-02T13:00:00.000Z");
const DAY = "2026-10-02";
const PRICE = 10_000n; // the mock seller's price
const TOTAL = 15_000n; // + the 0.005 fee

/** The production caps (owner approval 2026-10-02): 2 USDC a UTC day, 20 USDC a UTC month. */
function nd(over: Partial<NotDeliveredRefund> = {}): NotDeliveredRefund {
  return { dailyCapAtomic: 2_000_000n, monthlyCapAtomic: 20_000_000n, lastDeliveredAt: () => "2026-09-29T00:00:00Z", ...over };
}

async function rig(o: Parameters<typeof solRig>[0] = {}, on = true): Promise<SolRig> {
  const r = await solRig({ now: () => NOW, ...o });
  if (on) r.side.notDeliveredRefund = nd();
  return r;
}

/** A free quote for the mock seller. */
const quoteOf = async (r: SolRig) =>
  (await r.buy.handle(new Request(`https://buy.test/v1/buy?url=${encodeURIComponent("https://seller.test/api/quote?sym=SOL")}`)));

let memoN = 0;
/** One paid request; each signs a different transaction (its memo), so each is a new payment. */
async function buyOnce(r: SolRig): Promise<{ res: Response; body: Record<string, unknown> }> {
  const { header } = await agentPaysSolana(r.buy, undefined, (++memoN).toString(16).padStart(32, "0"));
  const res = await r.buy.handle(paidReq(header));
  const body = (await res.clone().json().catch(() => ({}))) as Record<string, unknown>;
  return { res, body };
}

async function onlyPurchase(r: SolRig) {
  const rows = await r.sql.query<{ id: string; state: string; reserved: string; spent: string; record: PurchaseRecord; facts: Record<string, unknown> }>(
    `select id, state, reserved::text as reserved, spent::text as spent, record, facts from pb_purchase`,
  );
  assert.equal(rows.rows.length, 1);
  return rows.rows[0]!;
}

/** A granted decision already on record (another buyer, another seller unless given), to fill a cap or a rule. */
async function seedGranted(r: SolRig, o: { id: string; day?: string; month?: string; to?: string; agent?: string | null; host?: string; payTo?: string; amount: bigint; at?: string }) {
  await r.sql.query(
    `insert into pb_nd_refund (purchase_id, chain, day, month, to_addr, agent, seller_host, seller_pay_to, amount, granted, reason, at) values ($1, 'solana', $2, $3, $4, $5, $6, $7, $8, true, 'http_500', $9)`,
    [o.id, o.day ?? DAY, o.month ?? (o.day ?? DAY).slice(0, 7), o.to ?? `other-${o.id}`, o.agent ?? null, o.host ?? `other-${o.id}.test`, o.payTo ?? `payto-${o.id}`, o.amount.toString(), o.at ?? "2026-10-01T00:00:00Z"],
  );
}

// ---------- which answers are refunded ----------

for (const c of [
  { name: "500", seller: { paidStatus: 500, paidBody: "boom" }, basis: "http_500" },
  { name: "402 again", seller: { paidStatus: 402, paidBody: "{}" }, basis: "http_402_after_payment" },
  { name: "200 with an empty body", seller: { paidStatus: 200, paidBody: "  " }, basis: "http_200_empty_body" },
  { name: "302 redirect", seller: { paidStatus: 302, paidBody: "" }, basis: "http_302_not_an_answer" },
]) {
  test(`seller ${c.name} after vet402's payment landed: full refund, with tx, amount and reason in the answer and in the database`, async () => {
    const r = await rig({ seller: c.seller });
    const startBalance = r.state.balance;
    const { res, body } = await buyOnce(r);
    assert.equal(res.status, 502);
    assert.equal(body.error, "not_delivered");
    const refund = body.refund as Record<string, unknown>;
    assert.equal(refund.status, "sent");
    assert.equal(refund.amountAtomic, TOTAL.toString());
    assert.equal(refund.to, agent.address);
    assert.equal(refund.basis, `not_delivered: ${c.basis}`);
    assert.equal(refund.tx, "refundtx1");
    assert.equal(res.headers.get("x-vet402-refund-tx"), "refundtx1");
    assert.equal(res.headers.get("x-vet402-seller-settled"), "true");
    assert.deepEqual(r.refunds, [{ to: agent.address, amount: TOTAL }]);
    assert.equal(r.sellerPays.length, 1);
    const p = await onlyPurchase(r);
    assert.equal(p.state, "done");
    assert.equal(p.record.outcome, "not_delivered");
    assert.equal(p.record.sellerPayment?.settled, true);
    assert.deepEqual(p.record.refund, refund);
    // The books: reserved the seller's price and the refund, spent both; the floor follows the balance exactly.
    assert.equal(p.reserved, (TOTAL + PRICE).toString());
    assert.equal(p.spent, (TOTAL + PRICE).toString());
    assert.equal(r.state.balance, startBalance - TOTAL - PRICE);
    assert.equal((await r.store.wallet("solana"))!.floor, r.state.balance);
    const rf = await r.store.getRefund(p.id);
    assert.equal(rf?.status, "sent");
    assert.equal(rf?.tx, "refundtx1");
    assert.equal(rf?.amount, TOTAL.toString());
    const d = await r.store.ndRefunds("solana");
    assert.deepEqual(d.map((x) => [x.granted, x.reason, x.amount, x.day, x.to_addr]), [[true, c.basis, TOTAL.toString(), DAY, agent.address]]);
    // The public record says the same.
    const rec = await (await r.buy.handle(new Request(`https://buy.test/v1/buy/records/${p.id}`))).json();
    assert.equal((rec as PurchaseRecord).outcome, "not_delivered");
    assert.equal(((rec as PurchaseRecord).refund as { tx: string }).tx, "refundtx1");
  });
}

test("seller closes the connection with no answer after vet402 paid: refunded", async () => {
  const r = await rig({
    wrapSeller: (f) =>
      (async (url: string | URL, init?: RequestInit) => {
        if (new Headers(init?.headers).has("PAYMENT-SIGNATURE")) {
          await f(url as string, init); // the seller takes the payment
          throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
        }
        return f(url as string, init);
      }) as typeof fetch,
  });
  const { res, body } = await buyOnce(r);
  assert.equal(res.status, 502);
  assert.equal((body.refund as { status: string }).status, "sent");
  assert.equal((body.refund as { basis: string }).basis, "not_delivered: no_answer_connection_closed");
  assert.equal(r.refunds.length, 1);
});

// ---------- which answers are not refunded (as before) ----------

for (const c of [
  { name: "404", seller: { paidStatus: 404, paidBody: "not found" } },
  { name: "400", seller: { paidStatus: 400, paidBody: "bad input" } },
  { name: "429", seller: { paidStatus: 429, paidBody: "slow down" } },
]) {
  test(`seller ${c.name} after vet402 paid: no refund (vet402's side is not ruled out)`, async () => {
    const r = await rig({ seller: c.seller });
    const { res, body } = await buyOnce(r);
    assert.equal(res.status, 502);
    assert.equal(body.error, "not_delivered");
    assert.equal(body.refund, "none");
    assert.equal(r.refunds.length, 0);
    const p = await onlyPurchase(r);
    assert.equal(p.state, "done");
    assert.equal(p.spent, PRICE.toString());
    assert.deepEqual(await r.store.ndRefunds("solana"), []);
    assert.equal((await r.store.wallet("solana"))!.floor, r.state.balance);
  });
}

test("the paid request times out after vet402 paid: no refund (a slow seller and a short wait look the same)", async () => {
  const r = await rig({
    wrapSeller: (f) =>
      (async (url: string | URL, init?: RequestInit) => {
        if (new Headers(init?.headers).has("PAYMENT-SIGNATURE")) {
          await f(url as string, init);
          throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
        }
        return f(url as string, init);
      }) as typeof fetch,
  });
  const { body } = await buyOnce(r);
  assert.equal(body.error, "not_delivered");
  assert.equal(body.refund, "none");
  assert.equal(r.refunds.length, 0);
});

test("vet402's payment to the seller not confirmed: no refund now (seller_payment_pending); once it lands, the reconciler decides as the request would", async () => {
  const r = await rig({ seller: { paidStatus: 500, paidBody: "boom" }, sellerSettles: false });
  r.chain.blockhashValid = true; // vet402's payment can still land
  const { res, body } = await buyOnce(r);
  assert.equal(res.status, 502);
  assert.equal(body.error, "seller_payment_pending");
  assert.equal(body.refund, "pending_reconcile");
  assert.equal(r.refunds.length, 0);
  assert.deepEqual(await r.store.ndRefunds("solana"), []);
  // Still unseen: the reconciler waits, refunds nothing.
  await r.reconcile({ now: LATER });
  assert.equal(r.refunds.length, 0);
  // vet402's payment lands: the seller was paid and answered 500, so the refund for an undelivered answer is made.
  const p = await onlyPurchase(r);
  const mh = (p.facts.seller as { messageHash: string }).messageHash;
  r.chain.landed.set(mh, { sig: "sellerlate1", ok: true });
  r.state.balance -= PRICE;
  const acts = await r.reconcile({ now: LATER });
  assert.ok(acts.some((a) => /refund: "sent"/.test(a.action)), JSON.stringify(acts));
  assert.deepEqual(r.refunds, [{ to: agent.address, amount: TOTAL }]);
  const after = await onlyPurchase(r);
  assert.equal(after.state, "done");
  assert.equal(after.record.outcome, "not_delivered");
  assert.equal((after.record.refund as { basis: string }).basis, "not_delivered: http_500");
  assert.equal(after.spent, (TOTAL + PRICE).toString());
});

test("vet402's payment to the seller proven dead: the existing refund (seller_not_paid), not a second one", async () => {
  const r = await rig({ seller: { paidStatus: 500, paidBody: "boom" }, sellerSettles: false });
  r.chain.blockhashValid = false;
  const { body } = await buyOnce(r);
  assert.equal(body.error, "seller_not_paid");
  assert.equal(r.refunds.length, 1);
  assert.deepEqual(await r.store.ndRefunds("solana"), []);
  const p = await onlyPurchase(r);
  assert.equal(p.spent, TOTAL.toString());
});

// ---------- caps ----------

test("cap per UTC day (2.00): a refund that would pass it is not made, and the answer and the record say the cap", async () => {
  const r = await rig({ seller: { paidStatus: 500, paidBody: "boom" } });
  // 1.99 already refunded today for other buyers and sellers: 1.99 + 0.015 > 2.00.
  await seedGranted(r, { id: "s1", amount: 1_000_000n });
  await seedGranted(r, { id: "s2", amount: 990_000n });
  const { res, body } = await buyOnce(r);
  assert.equal(res.status, 502);
  const refund = body.refund as Record<string, string>;
  assert.equal(refund.status, "refused");
  assert.match(refund.reason!, /^cap_daily: refunded 1990000 on 2026-10-02 \+ 15000 > the day's cap 2000000$/);
  assert.equal(refund.tx, null);
  assert.equal(r.refunds.length, 0);
  const p = await onlyPurchase(r);
  assert.equal(p.state, "done");
  assert.equal((p.record.refund as { reason: string }).reason, refund.reason);
  assert.equal(p.spent, PRICE.toString());
  assert.equal((await r.store.wallet("solana"))!.floor, r.state.balance);
  const d = (await r.store.ndRefunds("solana")).find((x) => x.purchase_id === p.id)!;
  assert.deepEqual([d.granted, d.reason], [false, "cap_daily"]);
});

test("cap per UTC day: exactly up to 2.00 is refunded", async () => {
  const r = await rig({ seller: { paidStatus: 500, paidBody: "boom" } });
  await seedGranted(r, { id: "s1", amount: 1_985_000n });
  const { body } = await buyOnce(r);
  assert.equal((body.refund as { status: string }).status, "sent");
});

test("cap per UTC month (20.00): earlier days of the month count, other months do not", async () => {
  const r = await rig({ seller: { paidStatus: 500, paidBody: "boom" } });
  for (let i = 1; i <= 10; i++) await seedGranted(r, { id: `m${i}`, day: `2026-10-01`, amount: i === 10 ? 1_990_000n : 2_000_000n });
  await seedGranted(r, { id: "sep", day: "2026-09-30", amount: 2_000_000n }); // September: not this month
  const { body } = await buyOnce(r);
  const refund = body.refund as Record<string, string>;
  assert.equal(refund.status, "refused");
  assert.match(refund.reason!, /^cap_monthly: refunded 19990000 in 2026-10 \+ 15000 > the month's cap 20000000$/);
  assert.equal(r.refunds.length, 0);
});

test("caps come from the environment: both or neither, never above 2.00 a day or 20.00 a month", () => {
  const D = "VET402_PROXY_SOLANA_NOT_DELIVERED_REFUND_DAILY_CAP";
  const M = "VET402_PROXY_SOLANA_NOT_DELIVERED_REFUND_MONTHLY_CAP";
  assert.equal(notDeliveredRefundCaps({}), null);
  assert.deepEqual(notDeliveredRefundCaps({ [D]: "2.00", [M]: "20.00" }), { dailyCapAtomic: 2_000_000n, monthlyCapAtomic: 20_000_000n });
  assert.deepEqual(notDeliveredRefundCaps({ [D]: "0.5", [M]: "3" }), { dailyCapAtomic: 500_000n, monthlyCapAtomic: 3_000_000n });
  assert.throws(() => notDeliveredRefundCaps({ [D]: "2.00" }), /set both/);
  assert.throws(() => notDeliveredRefundCaps({ [M]: "20.00" }), /set both/);
  assert.throws(() => notDeliveredRefundCaps({ [D]: "2.01", [M]: "20.00" }), /at most 2000000/);
  assert.throws(() => notDeliveredRefundCaps({ [D]: "2.00", [M]: "20.000001" }), /at most 20000000/);
  assert.throws(() => notDeliveredRefundCaps({ [D]: "0", [M]: "20" }), /above 0/);
  assert.throws(() => notDeliveredRefundCaps({ [D]: "-1", [M]: "20" }), /USDC amount/);
});

// ---------- abuse checks ----------

test("(a) one refund for an undelivered answer per paying address per UTC day", async () => {
  const r = await rig({ seller: { paidStatus: 500, paidBody: "boom" } });
  // Earlier today, this agent got one from another seller.
  await seedGranted(r, { id: "a1", to: agent.address, agent: agent.address, amount: 15_000n });
  const { body } = await buyOnce(r);
  const refund = body.refund as Record<string, string>;
  assert.equal(refund.status, "refused");
  assert.match(refund.reason!, /^buyer_daily_limit:/);
  assert.equal(r.refunds.length, 0);
});

test("(a) a refund on another UTC day does not count", async () => {
  const r = await rig({ seller: { paidStatus: 500, paidBody: "boom" } });
  await seedGranted(r, { id: "a1", day: "2026-10-01", to: agent.address, agent: agent.address, amount: 15_000n });
  const { body } = await buyOnce(r);
  assert.equal((body.refund as { status: string }).status, "sent");
});

test("(b) after a refund, the seller is not bought from until a later vet402 purchase from it delivered", async () => {
  const al = makeAllowlist([{ chain: "solana", host: S_HOST, payTo: SELLER, settled: true, delivered: true, at: "2026-09-29T00:00:00Z" }]);
  const r = await rig({ seller: { paidStatus: 500, paidBody: "boom" }, allowlist: al });
  r.side.notDeliveredRefund = nd({ lastDeliveredAt: (h, p) => al.find("solana", h, p)?.lastDeliveredAt ?? null });
  // Signed while the seller was not held yet: the paid request is the one that must refuse.
  const early = await agentPaysSolana(r.buy, undefined, "e1".padStart(32, "0"));
  const early2 = await agentPaysSolana(r.buy, undefined, "e2".padStart(32, "0"));
  const first = await buyOnce(r);
  assert.equal((first.body.refund as { status: string }).status, "sent");
  // The next paid request to that seller: refused before any charge.
  r.seller.paidStatus = 200;
  r.seller.paidBody = JSON.stringify({ ok: 1 });
  const settlesBefore = r.fac.settles;
  const second = await r.buy.handle(paidReq(early.header));
  const sb = (await second.json()) as Record<string, unknown>;
  assert.equal(second.status, 403);
  assert.equal(sb.reason, "seller_on_hold");
  assert.equal(sb.charged, false);
  assert.equal(r.fac.settles, settlesBefore);
  // A delivered vet402 purchase from it before the refund does not release it.
  al.find("solana", S_HOST, SELLER)!.lastDeliveredAt = "2026-10-02T11:59:59.000Z";
  assert.equal((await r.buy.handle(paidReq(early2.header))).status, 403);
  assert.equal((await quoteOf(r)).status, 422);
  // The next daily run delivered (data/ after the refund): bought again.
  al.find("solana", S_HOST, SELLER)!.lastDeliveredAt = "2026-10-03T01:18:00.000Z";
  const third = await buyOnce(r);
  assert.equal(third.res.status, 200, JSON.stringify(third.body));
});

test("(b) at decision time: a second undelivered answer from a held seller is not refunded (two purchases at once)", async () => {
  const r = await rig({ seller: { paidStatus: 500, paidBody: "boom" } });
  await seedGranted(r, { id: "h1", host: S_HOST, amount: 15_000n, at: "2026-10-02T11:00:00.000Z" });
  // The paid-path check would refuse first; the decision itself is checked by asking it directly.
  const ok = await r.store.claim({ id: "p-held", chain: "solana", target: "https://seller.test/x", sellerHost: S_HOST, agent: "agentX", sellerAmount: PRICE, feeReserve: 0n, total: TOTAL, facts: {}, now: NOW });
  assert.ok(ok);
  await r.sql.query(`update pb_purchase set state = 'in_progress', day = $1 where id = 'p-held'`, [DAY]);
  const d = await r.store.ndRefundClaim("p-held", { chain: "solana", from: ["in_progress"], to: "buyerX", agent: "agentX", sellerHost: S_HOST, sellerPayTo: SELLER, amount: TOTAL, maxRefund: 105_000n, basis: "http_500", caps: nd(), lastDeliveredAt: "2026-09-29T00:00:00Z", record: {} as PurchaseRecord, now: NOW });
  assert.ok("granted" in d && d.granted === false && d.reason === "seller_on_hold", JSON.stringify(d));
});

test("(c) the seller's payTo is the paying address: no refund", async () => {
  const al = makeAllowlist([{ chain: "solana", host: S_HOST, payTo: agent.address, settled: true, delivered: true, at: "2026-09-29T00:00:00Z" }]);
  const r = await rig({ seller: { paidStatus: 500, paidBody: "boom", payTo: agent.address }, allowlist: al });
  const { res, body } = await buyOnce(r);
  assert.equal(res.status, 502);
  const refund = body.refund as Record<string, string>;
  assert.equal(refund.status, "refused");
  assert.match(refund.reason!, /^payto_is_buyer:/);
  assert.equal(r.refunds.length, 0);
  assert.equal(r.sellerPays[0]!.payTo, agent.address);
});

// ---------- once per purchase ----------

test("the same signed payment twice at once: one purchase, one refund", async () => {
  const r = await rig({ seller: { paidStatus: 500, paidBody: "boom" } });
  const { header } = await agentPaysSolana(r.buy);
  const [a, b] = await Promise.all([r.buy.handle(paidReq(header)), r.buy.handle(paidReq(header))]);
  assert.deepEqual([a.status, b.status].sort(), [409, 502]);
  assert.equal(r.refunds.length, 1);
  assert.equal((await r.store.ndRefunds("solana")).length, 1);
});

test("two decisions on one purchase at once (a request and a reconciler): one refund row, one grant", async () => {
  const r = await rig();
  await r.store.claim({ id: "p-twice", chain: "solana", target: "https://seller.test/x", sellerHost: S_HOST, agent: agent.address, sellerAmount: PRICE, feeReserve: 0n, total: TOTAL, facts: {}, now: NOW });
  await r.sql.query(`update pb_purchase set state = 'seller_unsettled', day = '2026-10-02' where id = 'p-twice'`);
  const ask = () =>
    r.store.ndRefundClaim("p-twice", { chain: "solana", from: ["in_progress", "seller_unsettled"], to: agent.address, agent: agent.address, sellerHost: S_HOST, sellerPayTo: SELLER, amount: TOTAL, maxRefund: 105_000n, basis: "http_500", caps: nd(), lastDeliveredAt: "2026-09-29T00:00:00Z", record: {} as PurchaseRecord, now: NOW });
  const out = await Promise.all([ask(), ask(), ask()]);
  assert.equal(out.filter((d) => "granted" in d && d.granted).length, 1, JSON.stringify(out));
  assert.equal(out.filter((d) => "moved" in d).length, 2);
  assert.equal((await r.sql.query(`select 1 from pb_refund where purchase_id = 'p-twice'`)).rows.length, 1);
  // Asked again later: nothing new.
  assert.ok("moved" in (await ask()));
  assert.equal((await r.store.ndRefunds("solana")).length, 1);
});

// ---------- a refund that does not go out ----------

test("refund send fails: stays owed (refund_pending), the reconciler reports it, then retries and closes", async () => {
  const r = await rig({ seller: { paidStatus: 500, paidBody: "boom" } });
  r.state.refund = "failed";
  const { res, body } = await buyOnce(r);
  assert.equal(res.status, 502);
  assert.equal((body.refund as { status: string }).status, "failed");
  assert.equal(res.headers.get("x-vet402-refund-tx"), null);
  let p = await onlyPurchase(r);
  assert.equal(p.state, "refund_pending");
  assert.equal(p.record.outcome, "not_delivered");
  // Still failing: an ALERT for a human, the purchase stays open and owed.
  const a1 = await r.reconcile({ now: LATER });
  assert.ok(a1.some((a) => a.action.startsWith("ALERT refund failed")), JSON.stringify(a1));
  assert.equal((await onlyPurchase(r)).state, "refund_pending");
  // The RPC comes back: retried, sent once, closed with the seller's price and the refund spent.
  r.state.refund = "sent";
  const a2 = await r.reconcile({ now: LATER });
  assert.ok(a2.some((a) => /refund retried: "sent"/.test(a.action)), JSON.stringify(a2));
  assert.deepEqual(r.refunds, [{ to: agent.address, amount: TOTAL }]);
  p = await onlyPurchase(r);
  assert.equal(p.state, "done");
  assert.equal(p.record.outcome, "not_delivered");
  assert.equal((p.record.refund as { status: string; basis: string }).status, "sent");
  assert.equal((p.record.refund as { basis: string }).basis, "not_delivered: http_500");
  assert.equal(p.spent, (TOTAL + PRICE).toString());
  assert.equal((await r.store.wallet("solana"))!.floor, r.state.balance);
  // Nothing more on the next run.
  await r.reconcile({ now: LATER });
  assert.equal(r.refunds.length, 1);
});

test("refund keeps failing: stuck after the attempts, reported, never closed as done", async () => {
  const r = await rig({ seller: { paidStatus: 500, paidBody: "boom" } });
  r.state.refund = "failed";
  await buyOnce(r);
  let last: string[] = [];
  for (let i = 0; i < 7; i++) last = (await r.reconcile({ now: LATER })).map((a) => a.action);
  assert.ok(last.some((a) => a.startsWith("ALERT refund stuck")), JSON.stringify(last));
  assert.equal((await onlyPurchase(r)).state, "refund_pending");
  assert.equal(r.refunds.length, 0);
});

test("a process stopped after the refund was decided: the reconciler sends it (pending row)", async () => {
  const r = await rig({ seller: { paidStatus: 500, paidBody: "boom" } });
  r.state.refund = "hang"; // the function is killed while sending: the refund row stays "sending"
  const { header } = await agentPaysSolana(r.buy);
  void r.buy.handle(paidReq(header));
  for (let i = 0; i < 200 && !(await r.store.ndRefunds("solana")).length; i++) await new Promise((s) => setTimeout(s, 20));
  for (let i = 0; i < 200 && (await r.store.getRefund((await onlyPurchase(r)).id))?.status !== "sending"; i++) await new Promise((s) => setTimeout(s, 20));
  r.state.refund = "sent";
  // The hung attempt's transaction never lands (its blockhash expired): proven dead, sent again once.
  const acts = await r.reconcile({ now: LATER });
  assert.ok(acts.some((a) => /refund retried: "sent"/.test(a.action)), JSON.stringify(acts));
  assert.equal(r.refunds.length, 1);
  assert.equal((await onlyPurchase(r)).state, "done");
});

// ---------- the wallet ----------

test("with the refund on, a purchase reserves the seller's price and the refund: refused before any charge when the payer cannot hold both", async () => {
  const r = await rig({ seller: { paidStatus: 500, paidBody: "boom" }, balance: TOTAL + PRICE - 1n });
  const { res, body } = await buyOnce(r);
  assert.equal(res.status, 503);
  assert.equal(body.reason, "insufficient_balance");
  assert.equal(body.charged, false);
  assert.equal(r.fac.settles, 0);
});

// ---------- off by default ----------

test("caps unset: off; a 500 after vet402 paid is closed with no refund, exactly as before", async () => {
  const env = { VET402_PROXY_SOLANA_RECEIVE: RECEIVE, VET402_PROXY_SOLANA_PAYER: proxyPayer.address, VET402_PROXY_SOLANA_PAYER_KEY: JSON.stringify(Array(64).fill(1)) };
  assert.equal(configFromEnv(env).solana!.notDeliveredRefund, null);
  const r = await rig({ seller: { paidStatus: 500, paidBody: "boom" } }, false);
  const q = (await (await r.buy.handle(new Request(`https://buy.test/v1/buy?url=${encodeURIComponent("https://seller.test/api/quote?sym=SOL")}`))).json()) as { buy: { refund: string; offers: { solana: { refund: string } } } };
  assert.equal(q.buy.refund, REFUND_POLICY);
  assert.equal(q.buy.offers.solana.refund, REFUND_POLICY);
  const { res, body } = await buyOnce(r);
  assert.equal(res.status, 502);
  assert.deepEqual(Object.keys(body).sort(), ["error", "note", "record", "refund", "sellerAnswer", "sellerStatus"]);
  assert.equal(body.refund, "none");
  assert.equal(body.note, "vet402 paid the seller; no refund");
  assert.equal(r.refunds.length, 0);
  const p = await onlyPurchase(r);
  assert.equal(p.reserved, TOTAL.toString());
  assert.equal(p.spent, PRICE.toString());
  assert.equal(p.record.refund, "none");
  assert.equal(p.facts.notDelivered, undefined);
  assert.deepEqual(await r.store.ndRefunds("solana"), []);
});

test("caps unset: the refund for a seller vet402 did not pay is recorded exactly as before (no basis field)", async () => {
  const r = await rig({ seller: { paidStatus: 500, paidBody: "boom" }, sellerSettles: false }, false);
  r.chain.blockhashValid = false;
  const { body } = await buyOnce(r);
  assert.equal(body.error, "seller_not_paid");
  assert.deepEqual(Object.keys(body.refund as object).sort(), ["amountAtomic", "reason", "status", "to", "tx"]);
  const p = await onlyPurchase(r);
  assert.deepEqual(Object.keys(p.record.refund as object).sort(), ["amountAtomic", "reason", "status", "to", "tx"]);
  assert.equal(p.reserved, TOTAL.toString());
});

test("on: the price says the refund rule for undelivered answers", async () => {
  const r = await rig();
  const q = (await (await r.buy.handle(new Request(`https://buy.test/v1/buy?url=${encodeURIComponent("https://seller.test/api/quote?sym=SOL")}`))).json()) as { buy: { refund: string; offers: { solana: { refund: string } } } };
  assert.equal(q.buy.refund, REFUND_POLICY_NOT_DELIVERED);
  assert.equal(q.buy.offers.solana.refund, REFUND_POLICY_NOT_DELIVERED);
});

// ---------- the rule itself ----------

test("the refund rule is inside the ranking's seller-side failures (src/rank/classify.ts)", () => {
  const attempt = (httpStatus: number | null, rawReason = ""): Attempt =>
    ({ chain: "solana", source: "t", host: "h", service: null, url: "https://h/x", payTo: null, expectedPayTo: null, at: NOW.toISOString(), tried: true, settled: true, delivered: false, category: "not_delivered", rawReason, detail: null, tx: null, priceUsdc: null, httpStatus, declaredMatch: null, bodyChecked: true }) as unknown as Attempt;
  const statuses = [100, 200, 204, 301, 302, 400, 401, 402, 403, 404, 422, 429, 500, 502, 503, 599, null];
  for (const s of statuses) {
    for (const fetchFailure of s === null ? (["closed", "timeout", "unknown"] as const) : ([null] as const)) {
      const f = notDeliveredFault({ status: s, bodyError: false, truncated: false, fetchFailure });
      if (f.refundable) assert.equal(classifyFailure(attempt(s)).fault, "seller", `status ${s} ${fetchFailure}`);
      if (s !== null && s >= 400 && s <= 499 && s !== 402) assert.equal(f.refundable, false, `status ${s}`);
    }
  }
  assert.equal(notDeliveredFault({ status: null, bodyError: false, truncated: false, fetchFailure: "timeout" }).refundable, false);
  assert.equal(notDeliveredFault({ status: null, bodyError: false, truncated: false, fetchFailure: "unknown" }).refundable, false);
  assert.equal(notDeliveredFault({ status: 200, bodyError: true, truncated: false, fetchFailure: null }).refundable, false);
  assert.equal(notDeliveredFault({ status: 500, bodyError: true, truncated: false, fetchFailure: null }).refundable, true);
  assert.equal(notDeliveredFault({ status: 200, bodyError: false, truncated: true, fetchFailure: null }).refundable, false);
});

test("fetch failures: timeouts and unknown causes are not the seller's for certain; a refused or reset connection is", () => {
  assert.equal(fetchFailureKind(new DOMException("The operation was aborted due to timeout", "TimeoutError")), "timeout");
  assert.equal(fetchFailureKind(new DOMException("aborted", "AbortError")), "timeout");
  assert.equal(fetchFailureKind(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "UND_ERR_CONNECT_TIMEOUT" }) })), "timeout");
  assert.equal(fetchFailureKind(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "UND_ERR_HEADERS_TIMEOUT" }) })), "timeout");
  assert.equal(fetchFailureKind(new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) })), "closed");
  assert.equal(fetchFailureKind(new TypeError("fetch failed", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) })), "closed");
  assert.equal(fetchFailureKind(new TypeError("fetch failed", { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) })), "closed");
  assert.equal(fetchFailureKind(new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) })), "unknown");
  assert.equal(fetchFailureKind(new Error("boom")), "unknown");
});

test("two buyers, one seller, the same day: the first is refunded, the seller is then held", async () => {
  // A second agent key: the shared fakes sign with `agent`; here the rule is read at decision time.
  const other = await generateKeyPairSigner();
  const r = await rig();
  for (const [id, who] of [["p1", agent.address], ["p2", other.address]] as const) {
    await r.store.claim({ id, chain: "solana", target: "https://seller.test/x", sellerHost: S_HOST, agent: who, sellerAmount: PRICE, feeReserve: 0n, total: TOTAL, facts: {}, now: NOW });
    await r.sql.query(`update pb_purchase set state = 'in_progress', day = '2026-10-02' where id = $1`, [id]);
  }
  const ask = (id: string, who: string) =>
    r.store.ndRefundClaim(id, { chain: "solana", from: ["in_progress"], to: who, agent: who, sellerHost: S_HOST, sellerPayTo: SELLER, amount: TOTAL, maxRefund: 105_000n, basis: "http_500", caps: nd(), lastDeliveredAt: "2026-09-29T00:00:00Z", record: {} as PurchaseRecord, now: NOW });
  const [a, b] = await Promise.all([ask("p1", agent.address), ask("p2", other.address)]);
  const granted = [a, b].filter((d) => "granted" in d && d.granted).length;
  const held = [a, b].filter((d) => "granted" in d && !d.granted && d.reason === "seller_on_hold").length;
  assert.deepEqual([granted, held], [1, 1], JSON.stringify([a, b]));
});

// ---------- review fixes (2026-10-02) ----------

/** The review's probe P-A / probe-dberr: the decision's database write fails once in the request. */
function failFirstDecision(r: SolRig): void {
  const orig = r.store.ndRefundClaim.bind(r.store);
  let n = 0;
  r.store.ndRefundClaim = (async (...a: Parameters<typeof orig>) => {
    if (n++ === 0) throw new Error("connection terminated");
    return orig(...a);
  }) as typeof orig;
}

test("review P-A: the refund decision cannot be written in the request (database error) -> 502, answer kept, the reconciler refunds once", async () => {
  const r = await rig({ seller: { paidStatus: 500, paidBody: "boom" } });
  failFirstDecision(r);
  const { res, body } = await buyOnce(r);
  assert.equal(res.status, 502);
  assert.equal(body.error, "not_delivered");
  assert.equal(body.refund, "pending_reconcile");
  assert.match(String(body.note), /decided later by the reconciler/);
  assert.equal(r.refunds.length, 0);
  const p = await onlyPurchase(r);
  assert.equal(p.state, "seller_unsettled");
  assert.equal(p.record.answer?.httpStatus, 500);
  assert.deepEqual(p.facts.answerFault, { refundable: true, basis: "http_500" });
  assert.equal((p.record.refund as { reason: string }).reason, "decision_pending");
  const acts = await r.reconcile({ now: LATER });
  assert.ok(acts.some((a) => /closed: seller paid, not delivered, refund: "sent"/.test(a.action)), JSON.stringify(acts));
  assert.deepEqual(r.refunds, [{ to: agent.address, amount: TOTAL }]);
  const after = await onlyPurchase(r);
  assert.equal(after.state, "done");
  assert.equal(after.record.outcome, "not_delivered");
  assert.equal((after.record.refund as { status: string }).status, "sent");
  assert.equal(after.spent, (TOTAL + PRICE).toString());
  assert.equal((await r.store.wallet("solana"))!.floor, r.state.balance);
  for (let i = 0; i < 3; i++) await r.reconcile({ now: LATER });
  assert.equal(r.refunds.length, 1);
  assert.equal((await r.store.ndRefunds("solana")).length, 1);
});

test("review probe-dberr: the same, with the move to seller_unsettled failing too: the answer kept first lets the reconciler refund once", async () => {
  const r = await rig({ seller: { paidStatus: 500, paidBody: "boom" } });
  failFirstDecision(r);
  const move = r.store.move.bind(r.store);
  r.store.move = (async (...a: Parameters<typeof move>) => {
    if (a[2] === "seller_unsettled") throw new Error("connection terminated");
    return move(...a);
  }) as typeof move;
  const { res, body } = await buyOnce(r);
  assert.equal(res.status, 502);
  assert.equal(body.refund, "pending_reconcile");
  const p = await onlyPurchase(r);
  assert.equal(p.state, "in_progress");
  assert.equal(p.record.answer?.httpStatus, 500);
  r.store.move = move;
  const acts = await r.reconcile({ now: LATER, staleMs: 0 });
  assert.ok(acts.some((a) => /refund: "sent"/.test(a.action)), JSON.stringify(acts));
  assert.deepEqual(r.refunds, [{ to: agent.address, amount: TOTAL }]);
  assert.equal((await onlyPurchase(r)).state, "done");
  await r.reconcile({ now: LATER, staleMs: 0 });
  assert.equal(r.refunds.length, 1);
});

test("review: a refund decision the reconciler cannot write waits for its next run (no close, no refund lost)", async () => {
  const r = await rig({ seller: { paidStatus: 500, paidBody: "boom" }, sellerSettles: false });
  r.chain.blockhashValid = true;
  const { body } = await buyOnce(r);
  assert.equal(body.error, "seller_payment_pending");
  assert.match(String(body.note), /if it settles, the reconciler decides the refund for an undelivered answer/);
  const p = await onlyPurchase(r);
  r.chain.landed.set((p.facts.seller as { messageHash: string }).messageHash, { sig: "sellerlate2", ok: true });
  r.state.balance -= PRICE;
  failFirstDecision(r);
  const a1 = await r.reconcile({ now: LATER });
  assert.ok(a1.some((a) => /waiting: the refund decision/.test(a.action)), JSON.stringify(a1));
  assert.equal((await onlyPurchase(r)).state, "seller_unsettled");
  const a2 = await r.reconcile({ now: LATER });
  assert.ok(a2.some((a) => /refund: "sent"/.test(a.action)), JSON.stringify(a2));
  assert.equal(r.refunds.length, 1);
});

test("review: with the refund off, seller_payment_pending says what it said before", async () => {
  const r = await rig({ seller: { paidStatus: 500, paidBody: "boom" }, sellerSettles: false }, false);
  r.chain.blockhashValid = true;
  const { body } = await buyOnce(r);
  assert.equal(body.note, "if vet402's payment to the seller never settles, the reconciler refunds you");
});

test("review: a seller hold ends 7 days after the refund at the latest", async () => {
  const H = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
  const DAY_MS = 86_400_000;
  assert.equal(holdActive(null, null, NOW), false);
  assert.equal(holdActive(H(6 * DAY_MS), null, NOW), true);
  assert.equal(holdActive(H(7 * DAY_MS - 1), null, NOW), true);
  assert.equal(holdActive(H(7 * DAY_MS), null, NOW), false);
  assert.equal(holdActive(H(DAY_MS), H(DAY_MS - 1), NOW), false); // delivered after the refund
  assert.equal(holdActive(H(DAY_MS), H(DAY_MS + 1), NOW), true); // delivered before it
  // Paid path: held 6 days ago -> refused before any charge; 7 days ago -> bought. The seller last delivered before both.
  const al = makeAllowlist([{ chain: "solana", host: S_HOST, payTo: SELLER, settled: true, delivered: true, at: "2026-09-01T00:00:00Z" }]);
  let clock = NOW;
  const r = await rig({ seller: { paidStatus: 200, paidBody: JSON.stringify({ ok: 1 }) }, allowlist: al, now: () => clock });
  const signed = await agentPaysSolana(r.buy, undefined, "f1".padStart(32, "0"));
  await seedGranted(r, { id: "old", host: S_HOST, amount: 15_000n, at: H(6 * DAY_MS) });
  const ares = await r.buy.handle(paidReq(signed.header));
  const a = (await ares.json()) as Record<string, unknown>;
  assert.equal(ares.status, 403);
  assert.equal(a.reason, "seller_on_hold");
  assert.equal(a.charged, false);
  assert.match(String(a.detail), /or from 2026-10-03T12:00:00.000Z at the latest/);
  // A day later the hold is 7 days old: the quote and the paid request both go ahead.
  clock = new Date(NOW.getTime() + DAY_MS);
  assert.equal((await buyOnce(r)).res.status, 200);
  clock = NOW;
  await r.sql.query(`update pb_nd_refund set at = $1`, [H(7 * DAY_MS)]);
  // Decision time: a hold of 7 days ago no longer refuses a refund.
  await r.store.claim({ id: "p-exp", chain: "solana", target: "https://seller.test/x", sellerHost: S_HOST, agent: "agentY", sellerAmount: PRICE, feeReserve: 0n, total: TOTAL, facts: {}, now: NOW });
  await r.sql.query(`update pb_purchase set state = 'in_progress', day = $1 where id = 'p-exp'`, [DAY]);
  const d = await r.store.ndRefundClaim("p-exp", { chain: "solana", from: ["in_progress"], to: "buyerY", agent: "agentY", sellerHost: S_HOST, sellerPayTo: SELLER, amount: TOTAL, maxRefund: 105_000n, basis: "http_500", caps: nd(), lastDeliveredAt: null, record: {} as PurchaseRecord, now: NOW });
  assert.ok("granted" in d && d.granted, JSON.stringify(d));
});

test("review: UND_ERR_CLOSED (vet402's own client closed) is not the seller's: no refund", async () => {
  assert.equal(fetchFailureKind(new TypeError("fetch failed", { cause: Object.assign(new Error("closed"), { code: "UND_ERR_CLOSED" }) })), "unknown");
  const r = await rig({
    wrapSeller: (f) =>
      (async (url: string | URL, init?: RequestInit) => {
        if (new Headers(init?.headers).has("PAYMENT-SIGNATURE")) {
          await f(url as string, init);
          throw new TypeError("fetch failed", { cause: Object.assign(new Error("The client is destroyed"), { code: "UND_ERR_CLOSED" }) });
        }
        return f(url as string, init);
      }) as typeof fetch,
  });
  const { body } = await buyOnce(r);
  assert.equal(body.error, "not_delivered");
  assert.equal(body.refund, "none");
  assert.equal(r.refunds.length, 0);
});


test("review: the free 402 says seller_on_hold before the agent signs (after this instance's paid request)", async () => {
  const r = await rig({ seller: { paidStatus: 500, paidBody: "boom" } });
  assert.equal((await quoteOf(r)).status, 402);
  const first = await buyOnce(r);
  assert.equal((first.body.refund as { status: string }).status, "sent");
  const q = await quoteOf(r);
  assert.equal(q.status, 422);
  assert.equal(q.headers.get("PAYMENT-REQUIRED"), null);
  const b = (await q.json()) as { reason: string; offers: { solana: { refused: string; detail: string } } };
  assert.equal(b.reason, "no_payable_offer");
  assert.equal(b.offers.solana.refused, "seller_on_hold");
  assert.match(b.offers.solana.detail, /at the latest/);
});

test("review: a free quote reads the holds only while the database is awake anyway (after a cron run), never otherwise", async () => {
  for (const [at, reads, shown] of [["2026-10-02T12:10:00.000Z", 0, false], ["2026-10-02T12:03:00.000Z", 1, true]] as const) {
    const r = await rig({ now: () => new Date(at) });
    await seedGranted(r, { id: `q${at}`, host: S_HOST, amount: 15_000n, at: "2026-10-02T11:00:00.000Z" });
    let n = 0;
    const q0 = r.sql.query.bind(r.sql);
    r.sql.query = ((...a: Parameters<typeof q0>) => {
      n++;
      return q0(...a);
    }) as typeof q0;
    const q = await quoteOf(r);
    assert.equal(n, reads, at);
    assert.equal(q.status, shown ? 422 : 402, at);
  }
});
