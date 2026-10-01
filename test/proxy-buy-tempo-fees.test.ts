/**
 * Tempo's network fees leave the proxy payer's USDC.e wallet, the same wallet the floor counts. A closed purchase
 * must count every fee it caused (its refund's, a reverted seller payment's, a reverted refund attempt's), or the
 * next admission sees the balance below the floor (chain_spend_exceeds_ledger) and Tempo stops. These rigs take the
 * fees off the payer's balance the way the chain does (liveBalance).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUY_FEE_ATOMIC, TEMPO_BASE_FEE_ALERT, TEMPO_REFUND_FEE_BOUND_ATOMIC } from "../src/proxy-buy/constants.js";
import { recordTempoFee } from "../src/proxy-buy/flow.js";
import { reconcile } from "../src/proxy-buy/reconcile.js";
import { signerFor } from "../src/tempo/chain.js";
import { agentPaysTempo, buyUrl, CAPS, mineTempo, ORIGIN, T_RECEIVE, T_URL, tPaid, tProxy, tRig, type TRig } from "./proxy-buy-fakes.js";

type J = Record<string, any>;
const body = async (r: Response) => (await r.json()) as J;
const TOTAL = 13_000n; // seller 0.008 + fee 0.005

async function nextPurchaseGoesThrough(r: TRig) {
  r.seller.reverts = false;
  r.seller.paidStatus = 200;
  const res = await r.buy.handle(tPaid(await agentPaysTempo(r)));
  assert.equal(res.status, 200, JSON.stringify(res.status === 200 ? {} : await res.json()));
}

test("tempo fees: after a refund the floor equals the balance the chain shows (total + the refund's fee), and the next purchase goes through", async () => {
  const r = await tRig({ liveBalance: true });
  r.state.failBalanceAt = 2; // payOne's own balance read fails after the agent paid: vet402 never pays the seller -> refund
  const first = await body(await r.buy.handle(tPaid(await agentPaysTempo(r))));
  assert.equal(first.refund.status, "sent");
  const row = (await r.sql.query<J>(`select spent::text as spent, facts->'fees' as fees from pb_purchase`)).rows[0]!;
  assert.equal(row.spent, String(TOTAL + 31n), "the refund's fee is spent too");
  assert.equal(Object.keys(row.fees).length, 1);
  assert.equal((await r.store.wallet("tempo"))!.floor, await r.side.pay.balance());
  await nextPurchaseGoesThrough(r);
});

test("tempo fees: the same with a fee of 0 and of 31 (the reviewer's repro) -> both go on", async () => {
  for (const fee of [0n, 31n, 9_999n]) {
    const r = await tRig({ liveBalance: true });
    r.state.fee = fee;
    r.state.failBalanceAt = 2;
    assert.equal((await body(await r.buy.handle(tPaid(await agentPaysTempo(r))))).refund.status, "sent");
    await nextPurchaseGoesThrough(r);
  }
});

test("tempo fees: a seller payment that reverts takes its fee; the refund after it takes another; both are spent and the next purchase goes through", async () => {
  const r = await tRig({ liveBalance: true, seller: { reverts: true, paidStatus: 500, paidBody: Buffer.from("boom") } });
  const j = await body(await r.buy.handle(tPaid(await agentPaysTempo(r))));
  assert.equal(j.error, "seller_not_paid");
  assert.equal(j.reason, "seller_payment_failed_on_chain");
  assert.equal(j.refund.status, "sent");
  const row = (await r.sql.query<J>(`select spent::text as spent, facts->'fees' as fees from pb_purchase`)).rows[0]!;
  assert.equal(Object.keys(row.fees).length, 2, "the reverted seller payment and the refund");
  assert.equal(row.spent, String(TOTAL + 62n));
  assert.equal((await r.store.wallet("tempo"))!.floor, await r.side.pay.balance());
  await nextPurchaseGoesThrough(r);
});

test("tempo fees: a seller payment that reverts after the seller delivered: spent is its fee only, not the seller price", async () => {
  const r = await tRig({ liveBalance: true, seller: { reverts: true } });
  const res = await r.buy.handle(tPaid(await agentPaysTempo(r)));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-vet402-seller-settled"), "false");
  const row = (await r.sql.query<J>(`select spent::text as spent from pb_purchase`)).rows[0]!;
  assert.equal(row.spent, "31");
  assert.equal((await r.store.wallet("tempo"))!.floor, await r.side.pay.balance());
  await nextPurchaseGoesThrough(r);
});

test("tempo fees: a refund attempt that reverts, then the reconciler's retry lands: both fees are spent and the next purchase goes through", async () => {
  const r = await tRig({ liveBalance: true });
  r.state.failBalanceAt = 2;
  r.chain.revertNext = { from: tProxy.address, n: 1 }; // the first refund transaction is mined reverted
  const j = await body(await r.buy.handle(tPaid(await agentPaysTempo(r))));
  assert.notEqual(j.refund.status, "sent");
  const acts = await r.reconcile();
  assert.ok(acts.some((a) => /refund retried: "sent"/.test(a.action)), JSON.stringify(acts));
  const row = (await r.sql.query<J>(`select state, spent::text as spent, facts->'fees' as fees from pb_purchase`)).rows[0]!;
  assert.equal(row.state, "done");
  assert.equal(Object.keys(row.fees).length, 2, "the reverted attempt and the one that landed");
  assert.equal(row.spent, String(TOTAL + 62n));
  assert.equal((await r.store.wallet("tempo"))!.floor, await r.side.pay.balance());
  await nextPurchaseGoesThrough(r);
});

test("tempo fees: one transaction's fee counts once; a fee that cannot be read counts the refund's fee bound; finish adds them all", async () => {
  const r = await tRig();
  const now = new Date();
  assert.equal(await r.store.claim({ id: "p1", chain: "tempo", target: "https://t/x", sellerAmount: 8_000n, feeReserve: 2_000n, total: TOTAL, facts: {}, now }), true);
  await r.store.addFee("p1", "0xAB", 5n);
  await r.store.addFee("p1", "0xab", 5n);
  await recordTempoFee(r.store, "tempo", "p1", { hash: "0xcd" }, { feeOf: async () => { throw new Error("rpc down"); } });
  await recordTempoFee(r.store, "tempo", "p1", { hash: "0xef", sponsored: true }, { feeOf: async () => 77n }); // the seller's fee
  await recordTempoFee(r.store, "solana", "p1", { hash: "sig" }, { known: 99n }); // SOL, not the floor's USDC
  const fees = (await r.sql.query<J>(`select facts->'fees' as fees from pb_purchase where id = 'p1'`)).rows[0]!.fees;
  assert.deepEqual(fees, { "0xab": "5", "0xcd": String(TEMPO_REFUND_FEE_BOUND_ATOMIC) });
  assert.equal(await r.store.finish("p1", ["claimed"], { record: null as never, spent: TOTAL, now }), true);
  assert.equal((await r.sql.query<J>(`select spent::text as spent from pb_purchase where id = 'p1'`)).rows[0]!.spent, String(TOTAL + 5n + TEMPO_REFUND_FEE_BOUND_ATOMIC));
});

test("tempo base fee: above 3 gwei the cron's wallet check says ALERT; at 3 gwei it does not", async () => {
  const r = await tRig();
  const run = () =>
    reconcile({ store: r.store, feeAtomic: BUY_FEE_ATOMIC, now: () => new Date(), recordUrl: (id) => `${ORIGIN}/v1/buy/records/${id}`, caps: CAPS, maxRefund: 105_000n, deadline: Date.now() + 5_000, staleMs: 0, tempo: r.side });
  r.state.baseFee = TEMPO_BASE_FEE_ALERT;
  assert.equal((await run()).filter((a) => a.action.includes("tempo_base_fee_high")).length, 0);
  r.state.baseFee = TEMPO_BASE_FEE_ALERT + 1n;
  const acts = await run();
  assert.equal(acts.filter((a) => a.action.startsWith("ALERT tempo_base_fee_high")).length, 1);
  const open = (await r.sql.query<J>(`select reason from pb_alert where resolved_at is null`)).rows;
  assert.ok(open.some((x) => String(x.reason).includes("tempo_base_fee_high")), "kept for /api/alerts (proxy-alerts)");
  r.state.baseFee = 600_000_000n;
  await run();
  assert.equal((await r.sql.query<J>(`select 1 from pb_alert where resolved_at is null and reason like '%tempo_base_fee_high%'`)).rows.length, 0, "resolved once it is back down");
});

test("tempo: a payment from vet402's own proxy payer is refused before any charge", async () => {
  const r = await tRig();
  const quote = await r.buy.handle(new Request(buyUrl(T_URL)));
  const id = /id="([^"]+)"/.exec(quote.headers.get("www-authenticate")!)![1]!;
  const { credential } = await signerFor(tProxy, r.rpc).credentialFor(quote, id, T_RECEIVE);
  const j = await body(await r.buy.handle(tPaid(credential)));
  assert.equal(j.reason, "payer_is_vet402");
  assert.equal(j.charged, false);
  assert.equal(r.chain.broadcasts, 0);
});

test("tempo: a Tempo challenge that cannot be made takes only the Tempo offer away (no 500)", async () => {
  const r = await tRig();
  r.side.mpp.challenge = async () => {
    throw new Error("mppx down");
  };
  const res = await r.buy.handle(new Request(buyUrl(T_URL)));
  assert.equal(res.status, 422);
  const j = await body(res);
  assert.equal(j.offers.tempo.refused, "challenge_unavailable");
});

test("reconcile onlyChain: a Solana request's turn never reads a Tempo purchase, a Tempo request's turn does", async () => {
  const r = await tRig();
  const now = new Date(Date.now() - 3_600_000);
  assert.equal(await r.store.claim({ id: "t1", chain: "tempo", target: "https://t/x", sellerAmount: 8_000n, feeReserve: 2_000n, total: TOTAL, facts: {}, now }), true);
  const ctx = { store: r.store, feeAtomic: BUY_FEE_ATOMIC, now: () => new Date(), recordUrl: (id: string) => id, caps: CAPS, maxRefund: 105_000n, deadline: Date.now() + 5_000, staleMs: 0, walletCheck: false, tempo: r.side };
  assert.deepEqual(await reconcile({ ...ctx, onlyChain: "solana" }), []);
  assert.equal((await r.store.get("t1"))?.state, "claimed");
  const acts = await reconcile({ ...ctx, onlyChain: "tempo" });
  assert.ok(acts.some((a) => a.id === "t1" && a.action.startsWith("released")));
  assert.equal(await r.store.get("t1"), null);
});

test("tempo fees: a delivered purchase counts its seller payment's real fee (9,999 > the 2,000 reserve): floor = balance, the next purchase goes through", async () => {
  const r = await tRig({ liveBalance: true });
  r.state.fee = 9_999n;
  const res = await r.buy.handle(tPaid(await agentPaysTempo(r)));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-vet402-seller-settled"), "true");
  const row = (await r.sql.query<J>(`select spent::text as spent, facts->'fees' as fees from pb_purchase`)).rows[0]!;
  assert.equal(row.spent, String(8_000n + 9_999n), "the seller price and the fee it really took, not the 2,000 reserve");
  assert.equal(Object.keys(row.fees).length, 1);
  assert.equal((await r.store.wallet("tempo"))!.floor, await r.side.pay.balance());
  await nextPurchaseGoesThrough(r);
  await nextPurchaseGoesThrough(r);
});

test("tempo fees: the fee record cannot be written for a delivered purchase -> the answer is handed over and it closes counting the fee bound (floor below the balance, never above)", async () => {
  const r = await tRig({ liveBalance: true });
  const addFee = r.store.addFee.bind(r.store);
  r.store.addFee = async () => {
    throw new Error("db write failed");
  };
  const res = await r.buy.handle(tPaid(await agentPaysTempo(r)));
  assert.equal(res.status, 200);
  r.store.addFee = addFee;
  const row = (await r.sql.query<J>(`select state, spent::text as spent from pb_purchase`)).rows[0]!;
  assert.equal(row.state, "done");
  assert.equal(row.spent, String(8_000n + TEMPO_REFUND_FEE_BOUND_ATOMIC));
  assert.ok((await r.store.wallet("tempo"))!.floor <= (await r.side.pay.balance()));
  await nextPurchaseGoesThrough(r);
});

test("tempo fees: a reverted seller payment whose fee cannot be recorded -> no refund and no close in the request; the reconciler records it, refunds, and the books match", async () => {
  const r = await tRig({ liveBalance: true, seller: { reverts: true, paidStatus: 500, paidBody: Buffer.from("boom") } });
  const addFee = r.store.addFee.bind(r.store);
  r.store.addFee = async () => {
    throw new Error("db write failed");
  };
  // the request ends in an error (api/buy.ts answers 500 internal_error); the purchase stays open for the reconciler
  await assert.rejects(r.buy.handle(tPaid(await agentPaysTempo(r))), /db write failed/);
  assert.equal((await r.sql.query<J>(`select state from pb_purchase`)).rows[0]!.state, "in_progress");
  assert.equal(r.chain.sent.filter((s) => s.from === tProxy.address.toLowerCase()).length, 1, "only the reverted seller payment; no refund yet");
  r.store.addFee = addFee;
  const acts = await r.reconcile();
  assert.ok(acts.some((a) => /refund: "sent"/.test(a.action)), JSON.stringify(acts));
  const row = (await r.sql.query<J>(`select state, spent::text as spent from pb_purchase`)).rows[0]!;
  assert.equal(row.state, "done");
  assert.equal(row.spent, String(TOTAL + 62n));
  assert.equal((await r.store.wallet("tempo"))!.floor, await r.side.pay.balance());
  await nextPurchaseGoesThrough(r);
});

test("tempo fees: a seller payment not seen when the answer is handed over, then seen landed with a fee above the reserve -> the excess comes off the floor", async () => {
  let raw: string | null = null;
  const r = await tRig({
    liveBalance: true,
    seller: { broadcasts: false },
    wrapSeller: (f) => (async (url: string, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (auth) raw = (JSON.parse(Buffer.from(auth.replace(/^Payment\s+/, ""), "base64url").toString("utf8")) as J).payload.signature;
      return f(url, init);
    }) as typeof fetch,
  });
  r.state.fee = 9_999n;
  const res = await r.buy.handle(tPaid(await agentPaysTempo(r)));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-vet402-seller-settled"), "unknown");
  assert.equal((await r.sql.query<J>(`select spent::text as spent, seller_open from pb_purchase`)).rows[0]!.spent, String(8_000n + 2_000n));
  mineTempo(r.chain, raw! as `0x${string}`); // the seller broadcasts it later
  await r.reconcile();
  const row = (await r.sql.query<J>(`select spent::text as spent, seller_open from pb_purchase`)).rows[0]!;
  assert.equal(row.seller_open, false);
  assert.equal(row.spent, String(8_000n + 9_999n));
  assert.equal((await r.store.wallet("tempo"))!.floor, await r.side.pay.balance());
  r.seller.broadcasts = true;
  await nextPurchaseGoesThrough(r);
});
