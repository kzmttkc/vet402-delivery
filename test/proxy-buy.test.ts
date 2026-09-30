/**
 * Proxy buy against local mock sellers, a fake x402 facilitator, fake chains and a real Postgres (PGlite).
 * No network, no mainnet, no real keys: every key is generated here and thrown away.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { decodePaymentSignatureHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { createClient, custom, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { tempo as tempoChain } from "viem/chains";
import { Transaction } from "viem/tempo";
import { SOLANA_MAINNET, USDC_MINT } from "../src/constants.js";
import { USDC_E } from "../src/tempo/constants.js";
import { loadAllowlist, makeAllowlist } from "../src/proxy-buy/allowlist.js";
import { configFromEnv, describeConfig } from "../src/proxy-buy/config.js";
import { decodeSolanaTx, decodeTempoTx, solanaTxFate, tempoTxFate } from "../src/proxy-buy/fate.js";
import { quote, QUOTE_MAX_BODY_BYTES, readTextCapped } from "../src/proxy-buy/quote.js";
import { redact, refusalReason } from "../src/proxy-buy/reasons.js";
import { checkSolanaRefundTx, sendSolanaRefund, sendTempoRefund } from "../src/proxy-buy/refund.js";
import { settleFailedBeforeSend, solanaPaymentKey } from "../src/proxy-buy/solana.js";
import { Store } from "../src/proxy-buy/store.js";
import { confirmSolanaTransfer } from "../src/proxy-buy/wire.js";
import {
  CAPS,
  ORIGIN,
  PAYER_ATA,
  RECEIVE,
  S_URL,
  SELLER,
  SELLER2,
  T_OTHER,
  T_RECEIVE,
  T_URL,
  VET_FAC,
  agent,
  agentPaysSolana,
  agentPaysTempo,
  b64url,
  buyUrl,
  newFakeChain,
  fakeTempoRpc,
  paidReq,
  proxyPayer,
  solRig,
  solSellerFetch,
  tAgent,
  tPaid,
  tProxy,
  tRig,
  testSql,
  transferTx,
} from "./proxy-buy-fakes.js";

type J = Record<string, any>;
const body = async (r: Response) => (await r.json()) as J;
const recordOf = async (buy: { handle(r: Request): Promise<Response> }, url: string) => body(await buy.handle(new Request(url)));

// ================= Solana =================

test("solana: the 402 asks seller price + 0.005 to vet402's receive wallet, bound to the target and the seller, with the refund rule", async () => {
  const r = await solRig();
  const { req, body: b } = await agentPaysSolana(r.buy);
  assert.equal(req.amount, "15000");
  assert.equal(req.payTo, RECEIVE);
  assert.equal(req.asset, USDC_MINT);
  assert.equal(req.network, SOLANA_MAINNET);
  assert.equal(req.extra?.feePayer, VET_FAC);
  assert.equal(req.extra?.sellerAmount, "10000");
  assert.equal(req.extra?.sellerPayTo, SELLER);
  assert.equal(req.extra?.target, S_URL);
  const offers = (b.buy as J).offers;
  assert.equal(offers.solana.total, "0.015000");
  assert.match(offers.solana.refund, /does not pay the seller.*refunds your full payment/);
  assert.match(offers.solana.refund, /paid the seller and the seller did not deliver, there is no refund/);
  assert.equal(r.fac.settles, 0);
});

test("solana: success returns the answer as-is, both transactions and a public record without the query string", async () => {
  const r = await solRig();
  const { header } = await agentPaysSolana(r.buy);
  const res = await r.buy.handle(paidReq(header));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), r.seller.paidBody);
  assert.match(res.headers.get("x-vet402-customer-tx")!, /^cust/);
  assert.equal(res.headers.get("x-vet402-seller-tx"), "sellertx1");
  assert.equal(r.fac.settles, 1);
  assert.deepEqual(r.sellerPays, [{ amount: 10_000n, payTo: SELLER }]);
  const j = await recordOf(r.buy, res.headers.get("x-vet402-record")!);
  assert.equal(j.outcome, "delivered");
  assert.equal(j.target, "https://seller.test/api/quote", "the agent's query is not published");
  assert.equal(j.customer.payer, agent.address);
  assert.equal(j.refund, "none");
  // the books: one purchase, the seller price on the day, the wallet floor down by what was spent
  const day = await r.store.dayRow("solana", new Date().toISOString().slice(0, 10));
  assert.equal(day?.committed, 10_000n);
  assert.equal((await r.store.wallet("solana"))?.floor, 5_000_000n - 10_000n);
});

test("solana: the seller answers 500 and vet402's payment to it settled -> not_delivered, no refund", async () => {
  const r = await solRig({ seller: { paidStatus: 500, paidBody: "upstream down" } });
  const { header } = await agentPaysSolana(r.buy);
  const res = await r.buy.handle(paidReq(header));
  assert.equal(res.status, 502);
  const j = await body(res);
  assert.equal(j.error, "not_delivered");
  assert.match(j.refund, /none/);
  assert.equal(r.sellerPays.length, 1);
  assert.equal(r.refunds.length, 0);
  const rec = await recordOf(r.buy, j.record);
  assert.equal(rec.sellerPayment.settled, true);
});

test("C1 solana: the seller takes vet402's payment and never settles it (402) -> proven dead on chain -> refunded", async () => {
  const r = await solRig({ sellerSettles: false, seller: { paidStatus: 402, paidBody: "{}" } });
  const { header } = await agentPaysSolana(r.buy);
  const res = await r.buy.handle(paidReq(header));
  assert.equal(res.status, 502);
  const j = await body(res);
  assert.equal(j.error, "seller_not_paid");
  assert.equal(j.reason, "seller_payment_expired_unsent");
  assert.equal(j.refund.status, "sent");
  assert.deepEqual(r.refunds, [{ to: agent.address, amount: 15_000n }]);
  const rec = await recordOf(r.buy, j.record);
  assert.equal(rec.outcome, "seller_not_paid");
  assert.equal(rec.refund.tx, "refundtx1");
});

test("C1 solana: not settled and not provably dead yet -> seller_payment_pending, no refund; the reconciler refunds once it is dead", async () => {
  const r = await solRig({ sellerSettles: false, seller: { paidStatus: 402, paidBody: "{}" } });
  r.chain.blockhashValid = true;
  const { header } = await agentPaysSolana(r.buy);
  const res = await r.buy.handle(paidReq(header));
  assert.equal(res.status, 502);
  const j = await body(res);
  assert.equal(j.error, "seller_payment_pending");
  assert.equal(r.refunds.length, 0);
  assert.equal((await recordOf(r.buy, j.record)).outcome, "seller_payment_pending");
  assert.deepEqual((await r.reconcile()).map((a) => a.action), ["waiting: vet402's payment to the seller can still land"]);
  r.chain.blockhashValid = false;
  const acts = await r.reconcile();
  assert.match(acts[0]!.action, /refund: "sent"/);
  assert.equal(r.refunds.length, 1);
  const rec = await recordOf(r.buy, j.record);
  assert.equal(rec.refund.status, "sent");
  assert.equal(rec.reason, "seller_payment_dead");
  assert.deepEqual(await r.reconcile(), [], "nothing left");
});

test("C1 solana: not settled at first, then it lands -> closed as not delivered, no refund", async () => {
  const r = await solRig({ sellerSettles: false, seller: { paidStatus: 402, paidBody: "{}" } });
  r.chain.blockhashValid = true;
  const { header } = await agentPaysSolana(r.buy);
  const j = await body(await r.buy.handle(paidReq(header)));
  assert.equal(j.error, "seller_payment_pending");
  const row = await r.store.get(j.record.split("/").pop());
  r.chain.landed.set(String((row!.facts.seller as J).messageHash), { sig: "latesig", ok: true });
  const acts = await r.reconcile();
  assert.equal(acts[0]!.action, "closed: seller paid, no refund");
  assert.equal(r.refunds.length, 0);
  const rec = await recordOf(r.buy, j.record);
  assert.equal(rec.outcome, "not_delivered");
  assert.equal(rec.sellerPayment.tx, "latesig");
});

test("solana: the seller raised its price after the agent signed -> 402 price_changed, nothing settled or paid", async () => {
  const r = await solRig();
  const { header } = await agentPaysSolana(r.buy);
  r.seller.price = 20_000n;
  const res = await r.buy.handle(paidReq(header));
  assert.equal(res.status, 402);
  assert.equal((await body(res)).reason, "price_changed");
  assert.equal(r.fac.settles, 0);
  assert.equal(r.sellerPays.length, 0);
});

test("solana: price raised or payTo moved between vet402's re-read and its payment -> seller not paid, refunded", async () => {
  for (const move of [(s: J) => (s.price = 12_000n), (s: J) => (s.payTo = SELLER2)]) {
    // unpaid reads: 1 = agent's 402, 2 = the paid request's re-read, 3 = payOne's read right before signing
    const r = await solRig({ seller: { onRead: (n, s) => void (n === 3 && move(s)) } });
    const { header } = await agentPaysSolana(r.buy);
    const res = await r.buy.handle(paidReq(header));
    assert.equal(res.status, 502);
    const j = await body(res);
    assert.equal(j.error, "seller_not_paid");
    assert.match(j.reason, /price_raised|payto_mismatch/);
    assert.equal(j.refund.status, "sent");
    assert.equal(res.headers.get("x-vet402-refund-tx"), "refundtx1");
    assert.equal(r.sellerPays.length, 0);
    assert.deepEqual(r.refunds, [{ to: agent.address, amount: 15_000n }]);
  }
});

test("solana: the seller's payTo moved to an address vet402 never paid -> 403 before any charge", async () => {
  const r = await solRig();
  const { header } = await agentPaysSolana(r.buy);
  r.seller.payTo = SELLER2;
  const res = await r.buy.handle(paidReq(header));
  assert.equal(res.status, 403);
  assert.equal((await body(res)).reason, "payto_not_allowlisted");
  assert.equal(r.fac.settles, 0);
});

test("R4 solana: one payment sent 10 times at once under both header names and re-encoded, then after a restart -> one purchase", async () => {
  const r = await solRig();
  const { header } = await agentPaysSolana(r.buy);
  const p = decodePaymentSignatureHeader(header);
  const alt = encodePaymentSignatureHeader({ ...p, extensions: { x: 1 } } as never);
  const reqs = Array.from({ length: 10 }, (_, i) => new Request(buyUrl(S_URL), { headers: i % 2 ? { "X-PAYMENT": alt } : { "PAYMENT-SIGNATURE": header } }));
  const out = await Promise.all(reqs.map((q) => r.buy.handle(q)));
  assert.deepEqual(out.map((o) => o.status).sort(), [200, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
  assert.equal(r.fac.settles, 1);
  assert.equal(r.sellerPays.length, 1);
  // another instance on the same database
  const r2 = await solRig({ sql: r.sql });
  assert.equal((await r2.buy.handle(paidReq(header))).status, 409);
  const q = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  q.payload = { junk: "x", transaction: q.payload.transaction };
  assert.equal((await r2.buy.handle(paidReq(Buffer.from(JSON.stringify(q)).toString("base64")))).status, 409);
  assert.equal(r2.fac.settles, 0);
});

test("solana: a facilitator that answers a new payment with an earlier settled transaction -> nothing paid or refunded for it", async () => {
  const r = await solRig();
  r.fac.fixedTx = "custSAME";
  const a = await agentPaysSolana(r.buy, S_URL, "ee112233445566778899aabbccddeeff");
  assert.equal((await r.buy.handle(paidReq(a.header))).status, 200);
  const b = await agentPaysSolana(r.buy, S_URL, "ff112233445566778899aabbccddeeff");
  const rb = await r.buy.handle(paidReq(b.header));
  assert.equal(rb.status, 409);
  assert.equal((await body(rb)).error, "duplicate_customer_tx");
  assert.equal(r.sellerPays.length, 1);
  assert.equal(r.refunds.length, 0);
});

test("solana: two different payments at once when the daily cap has room for one -> one paid, one 503 with no charge", async () => {
  const r = await solRig({ caps: { cap: 15_000n } });
  const p1 = await agentPaysSolana(r.buy, S_URL, "aa112233445566778899aabbccddeeff");
  const p2 = await agentPaysSolana(r.buy, S_URL, "bb112233445566778899aabbccddeeff");
  const [a, b] = await Promise.all([r.buy.handle(paidReq(p1.header)), r.buy.handle(paidReq(p2.header))]);
  assert.deepEqual([a.status, b.status].sort(), [200, 503]);
  const j = await body(a.status === 503 ? a : b);
  assert.equal(j.reason, "daily_cap_reached");
  assert.equal(j.charged, false);
  assert.equal(r.fac.settles, 1);
  // the refused one gave its reservation back: the key can be used again, and the floor is whole
  assert.equal((await r.store.wallet("solana"))?.floor, 5_000_000n - 10_000n);
});

test("solana: balance too low, no SOL for a refund fee, or less on chain than the books allow -> 503 before any charge", async () => {
  const low = await solRig({ balance: 14_999n });
  const h = await agentPaysSolana(low.buy);
  assert.equal((await body(await low.buy.handle(paidReq(h.header)))).reason, "insufficient_balance");
  const nosol = await solRig();
  nosol.state.lamports = 10n;
  const h2 = await agentPaysSolana(nosol.buy);
  assert.equal((await body(await nosol.buy.handle(paidReq(h2.header)))).reason, "refund_fee_unavailable");
  // theft: after one purchase the payer's balance drops below what the books explain
  const r = await solRig();
  const h3 = await agentPaysSolana(r.buy, S_URL, "a1112233445566778899aabbccddeeff");
  assert.equal((await r.buy.handle(paidReq(h3.header))).status, 200);
  r.state.balance -= 50_000n;
  const h4 = await agentPaysSolana(r.buy, S_URL, "a2112233445566778899aabbccddeeff");
  assert.equal((await body(await r.buy.handle(paidReq(h4.header)))).reason, "chain_spend_exceeds_ledger");
  assert.equal(low.fac.settles + nosol.fac.settles, 0);
  assert.equal(r.fac.settles, 1);
});

test("solana: settle throws (the payment went out) -> unknown for the agent, no URL shown; the reconciler finds it and refunds", async () => {
  const r = await solRig();
  r.fac.fail = "settle_throw";
  const { header } = await agentPaysSolana(r.buy);
  const res = await r.buy.handle(paidReq(header));
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.doesNotMatch(text, /SECRET123|rpc\.example/);
  const j = JSON.parse(text) as J;
  assert.equal(j.error, "customer_payment_unconfirmed");
  assert.equal(j.charged, "unknown");
  assert.equal(r.refunds.length, 0);
  const acts = await r.reconcile();
  assert.match(acts[0]!.action, /refund: "sent"/);
  assert.deepEqual(r.refunds, [{ to: agent.address, amount: 15_000n }]);
  assert.equal(r.sellerPays.length, 0);
});

test("H2 solana: settle success:false is 'no charge' only for a verification reason before sending; otherwise it goes to the reconciler", async () => {
  assert.equal(settleFailedBeforeSend({ success: false, errorReason: "invalid_exact_svm_payload_amount_mismatch", transaction: "", network: "x" } as never), true);
  assert.equal(settleFailedBeforeSend({ success: false, errorReason: "invalid_exact_svm_transaction_failed", transaction: "", network: "x" } as never), false);
  assert.equal(settleFailedBeforeSend({ success: false, errorReason: "settlement_pending", transaction: "", network: "x" } as never), false);
  assert.equal(settleFailedBeforeSend({ success: false, errorReason: "invalid_exact_svm_payload_amount_mismatch", transaction: "abc", network: "x" } as never), false);
  const r = await solRig();
  r.fac.fail = "settle_false_verify";
  const a = await agentPaysSolana(r.buy, S_URL, "c1112233445566778899aabbccddeeff");
  const ra = await r.buy.handle(paidReq(a.header));
  assert.equal(ra.status, 402);
  assert.equal((await body(ra)).charged, false);
  r.fac.fail = "settle_false_after_send";
  const b = await agentPaysSolana(r.buy, S_URL, "c2112233445566778899aabbccddeeff");
  const rb = await r.buy.handle(paidReq(b.header));
  assert.equal(rb.status, 502);
  assert.equal((await body(rb)).charged, "unknown");
  // the reconciler: that payment never landed and its blockhash expired -> no charge
  const acts = await r.reconcile();
  assert.deepEqual(acts.map((x) => x.action), ["closed: agent payment dead, no charge"]);
});

test("solana: the agent's transfer is not confirmed in time -> unknown; the reconciler confirms it and refunds (never pays the seller late)", async () => {
  const r = await solRig();
  r.state.confirm = "timeout";
  const { header } = await agentPaysSolana(r.buy);
  const j = await body(await r.buy.handle(paidReq(header)));
  assert.equal(j.error, "customer_payment_unconfirmed");
  r.state.confirm = "ok";
  const acts = await r.reconcile();
  assert.match(acts[0]!.action, /refund: "sent"/);
  assert.equal(r.sellerPays.length, 0);
  assert.equal(r.refunds.length, 1);
});

test("R3 solana: the process stops while the seller holds vet402's payment -> the in-progress record is public; a new request reconciles it first", async () => {
  let release: () => void = () => undefined;
  const hang = new Promise<void>((res) => (release = res));
  let paidSeen = false;
  const r = await solRig({
    wrapSeller: (f) =>
      (async (url: string, init?: RequestInit) => {
        if (new Headers(init?.headers).has("PAYMENT-SIGNATURE")) {
          paidSeen = true;
          await hang; // the process "dies" here
        }
        return f(url as never, init);
      }) as unknown as typeof fetch,
  });
  const { header } = await agentPaysSolana(r.buy);
  const stuck = r.buy.handle(paidReq(header));
  for (let i = 0; i < 300 && !paidSeen; i++) await new Promise((x) => setTimeout(x, 10));
  assert.ok(paidSeen);
  const id = solanaPaymentKey(decodePaymentSignatureHeader(header));
  // "restart": another instance on the same database, which treats the purchase as abandoned
  const r2 = await solRig({ sql: r.sql, staleMs: 0 });
  const pub = await recordOf(r2.buy, `${ORIGIN}/v1/buy/records/${id}`);
  assert.equal(pub.outcome, "in_progress");
  assert.equal(pub.customer.confirmed, true);
  // a new paid request: the gate reconciles first (vet402's seller payment never landed, its blockhash expired) -> refund
  const h2 = await agentPaysSolana(r2.buy, S_URL, "d1112233445566778899aabbccddeeff");
  const next = await r2.buy.handle(paidReq(h2.header));
  assert.equal(next.status, 200);
  const after = await recordOf(r2.buy, `${ORIGIN}/v1/buy/records/${id}`);
  assert.equal(after.outcome, "seller_not_paid");
  assert.equal(after.refund.status, "sent");
  assert.equal(r2.refunds.length, 1);
  release();
  await stuck;
});

test("H1: while an abandoned purchase cannot be settled yet, new paid requests are refused (503, nothing charged)", async () => {
  const r = await solRig({ sellerSettles: false, seller: { paidStatus: 402, paidBody: "{}" }, staleMs: 0 });
  r.chain.blockhashValid = true;
  const a = await agentPaysSolana(r.buy, S_URL, "e1112233445566778899aabbccddeeff");
  assert.equal((await body(await r.buy.handle(paidReq(a.header)))).error, "seller_payment_pending");
  const settlesBefore = r.fac.settles;
  const b = await agentPaysSolana(r.buy, S_URL, "e2112233445566778899aabbccddeeff");
  const rb = await r.buy.handle(paidReq(b.header));
  assert.equal(rb.status, 503);
  const j = await body(rb);
  assert.equal(j.reason, "reconcile_pending");
  assert.equal(j.charged, false);
  assert.equal(r.fac.settles, settlesBefore);
});

test("solana: refunds: over the daily refund cap it is refused and recorded (closed); a refund that fails before sending is retried by the reconciler", async () => {
  const raise = { onRead: (n: number, s: J) => void (n === 3 && (s.price = 12_000n)) };
  const r = await solRig({ caps: { refundCap: 10_000n }, seller: raise });
  const h = await agentPaysSolana(r.buy);
  const j = await body(await r.buy.handle(paidReq(h.header)));
  assert.equal(j.refund.status, "refused");
  assert.equal(j.refund.reason, "daily_refund_cap_reached");
  assert.deepEqual(await r.reconcile(), []);
  const f = await solRig({ seller: raise });
  f.state.refund = "failed";
  const h2 = await agentPaysSolana(f.buy);
  const jf = await body(await f.buy.handle(paidReq(h2.header)));
  assert.equal(jf.refund.status, "failed");
  f.state.refund = "sent";
  const acts = await f.reconcile();
  assert.match(acts[0]!.action, /refund retried: "sent"/);
  assert.equal(f.refunds.length, 1);
  assert.deepEqual(await f.reconcile(), []);
});

test("solana: a refund whose outcome is unknown is resent only after it is proven dead, and exactly once", async () => {
  const r = await solRig({ seller: { onRead: (n, s) => void (n === 3 && (s.price = 12_000n)) } });
  r.state.refund = "unknown";
  const h = await agentPaysSolana(r.buy);
  const j = await body(await r.buy.handle(paidReq(h.header)));
  assert.equal(j.refund.status, "unknown");
  r.chain.blockhashValid = true;
  assert.deepEqual((await r.reconcile()).map((a) => a.action), ["waiting: the refund can still land"]);
  r.chain.blockhashValid = false;
  r.state.refund = "sent";
  const acts = await r.reconcile();
  assert.match(acts[0]!.action, /refund retried: "sent"/);
  assert.equal(r.refunds.length, 1);
  const again = await r.reconcile();
  assert.deepEqual(again, []);
  const rf = await r.store.getRefund(j.record.split("/").pop());
  assert.equal(rf?.status, "sent");
  assert.equal(rf?.attempt, 2);
});

test("R5 solana: the process stops while sending a refund -> another instance proves that refund dead and sends it once", async () => {
  const r = await solRig({ seller: { onRead: (n, s) => void (n === 3 && (s.price = 12_000n)) } });
  r.state.refund = "hang"; // the refund's facts are written, then the process "dies" before the send returns
  const h = await agentPaysSolana(r.buy);
  void r.buy.handle(paidReq(h.header));
  const id = solanaPaymentKey(decodePaymentSignatureHeader(h.header));
  for (let i = 0; i < 300 && (await r.store.getRefund(id))?.status !== "sending"; i++) await new Promise((x) => setTimeout(x, 10));
  assert.equal((await r.store.getRefund(id))?.status, "sending");
  const r2 = await solRig({ sql: r.sql });
  const acts = await r2.reconcile();
  assert.match(acts[0]!.action, /refund retried: "sent"/);
  assert.equal(r2.refunds.length, 1);
  assert.equal(r.refunds.length, 0);
  assert.deepEqual(await r2.reconcile(), []);
  assert.equal((await r2.store.getRefund(id))?.status, "sent");
});

test("solana: binary answer byte for byte; an answer above the cap is not forwarded and not refunded (the seller was paid)", async () => {
  const bin = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80]);
  const r = await solRig({ seller: { paidBody: bin, paidType: "image/png" } });
  const { header } = await agentPaysSolana(r.buy);
  const res = await r.buy.handle(paidReq(header));
  assert.equal(res.status, 200);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bin);
  const big = await solRig({ seller: { paidBody: new Uint8Array(1_000_001).fill(65) } });
  const h2 = await agentPaysSolana(big.buy);
  const j2 = await body(await big.buy.handle(paidReq(h2.header)));
  assert.equal(j2.error, "answer_too_large");
  assert.equal(big.refunds.length, 0);
});

test("solana: v1 payments, a transfer to another address, and an RPC error with its URL", async () => {
  const r = await solRig();
  const { header, req } = await agentPaysSolana(r.buy);
  const p = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  p.x402Version = 1;
  assert.equal((await body(await r.buy.handle(paidReq(Buffer.from(JSON.stringify(p)).toString("base64"))))).reason, "unsupported_x402_version");
  const tx = await transferTx(agent, String(req.extra?.feePayer), SELLER2, BigInt(req.amount));
  const other = encodePaymentSignatureHeader({ x402Version: 2, accepted: req, payload: { transaction: tx } } as unknown as PaymentPayload);
  assert.equal((await body(await r.buy.handle(paidReq(other)))).reason, "invalid_payment");
  r.state.balanceError = "fetch failed: https://mainnet.example-rpc.test/v2/SECRET-KEY-42";
  const h3 = await agentPaysSolana(r.buy, S_URL, "f3112233445566778899aabbccddeeff");
  const text = await (await r.buy.handle(paidReq(h3.header))).text();
  assert.doesNotMatch(text, /SECRET-KEY-42|example-rpc/);
  assert.equal(r.fac.settles, 0);
});

// ================= entry checks =================

test("a host vet402 never paid, or one that never delivered, is refused without being paid", async () => {
  const r = await solRig();
  const res = await r.buy.handle(new Request(buyUrl("https://unknown.example/x")));
  assert.equal((await body(res)).reason, "seller_not_allowlisted");
  assert.equal(r.fetched.length, 0);
  for (const bad of ["http://seller.test/x", "https://127.0.0.1/x", "https://vet402.com/x", "https://user:pw@seller.test/x"]) {
    assert.equal((await r.buy.handle(new Request(buyUrl(bad)))).status, 400, bad);
  }
  const never = makeAllowlist([{ chain: "solana", host: "seller.test", payTo: SELLER, settled: true, delivered: false }]);
  const q = await quote(S_URL, { fetchImpl: solSellerFetch({ price: 10_000n, payTo: SELLER, paidStatus: 200, paidBody: "", unpaidReads: 0, paidRequests: 0 }, []), allowlist: never, ownAddresses: [], solanaPayer: proxyPayer.address, tempoPayer: null });
  assert.equal((q as J).solana.reason, "seller_never_delivered");
});

test("flag off: nothing is read, quoted, settled, paid or written", async () => {
  const r = await solRig({ enabled: false });
  assert.equal((await r.buy.handle(new Request(buyUrl(S_URL)))).status, 503);
  assert.equal((await r.buy.handle(paidReq("eyJ4IjoxfQ=="))).status, 503);
  assert.equal(r.fetched.length, 0);
  const n = await r.sql.query<{ n: string }>("select count(*)::text as n from pb_purchase");
  assert.equal(n.rows[0]!.n, "0");
});

test("records: unknown or malformed ids are 404; POST is 405; /v1/buy?record= works too", async () => {
  const r = await solRig();
  assert.equal((await r.buy.handle(new Request(`${ORIGIN}/v1/buy/records/${"a".repeat(32)}`))).status, 404);
  assert.equal((await r.buy.handle(new Request(`${ORIGIN}/v1/buy/records/../../etc`))).status, 404);
  assert.equal((await r.buy.handle(new Request(buyUrl(S_URL), { method: "POST" }))).status, 405);
  const { header } = await agentPaysSolana(r.buy);
  const res = await r.buy.handle(paidReq(header));
  const id = new URL(res.headers.get("x-vet402-record")!).pathname.split("/").pop();
  assert.equal((await r.buy.handle(new Request(`${ORIGIN}/api/buy?record=${id}`))).status, 200);
});

// ================= chain reads and refund builders =================

test("M1 confirmSolanaTransfer: the receive wallet up and the signer down by exactly the total", async () => {
  const tx = (payTo: string, payer: string, err: unknown = null) => ({
    meta: {
      err,
      preBalances: [0],
      postBalances: [0],
      preTokenBalances: [
        { owner: RECEIVE, mint: USDC_MINT, uiTokenAmount: { amount: "0" } },
        { owner: agent.address, mint: USDC_MINT, uiTokenAmount: { amount: "100000" } },
      ],
      postTokenBalances: [
        { owner: RECEIVE, mint: USDC_MINT, uiTokenAmount: { amount: payTo } },
        { owner: agent.address, mint: USDC_MINT, uiTokenAmount: { amount: payer } },
      ],
    },
    transaction: { message: { accountKeys: [{ pubkey: VET_FAC, signer: true, writable: true }], instructions: [] } },
  });
  const rpcWith = (v: unknown) => async () => v;
  const s = async () => undefined;
  assert.deepEqual(await confirmSolanaTransfer(rpcWith(tx("15000", "85000")), "sig", agent.address, RECEIVE, 15_000n, { sleep: s }), { ok: true });
  assert.equal((await confirmSolanaTransfer(rpcWith(tx("15000", "100000")), "sig", agent.address, RECEIVE, 15_000n, { sleep: s })) .ok, false, "someone else paid: not the signer's money");
  assert.equal((await confirmSolanaTransfer(rpcWith(tx("14999", "85001")), "sig", agent.address, RECEIVE, 15_000n, { sleep: s })).ok, false);
  const failed = await confirmSolanaTransfer(rpcWith(tx("15000", "85000", { x: 1 })), "sig", agent.address, RECEIVE, 15_000n, { sleep: s });
  assert.deepEqual(failed, { ok: false, detail: "customer_tx_failed_on_chain", definite: true });
  const none = await confirmSolanaTransfer(rpcWith(null), "sig", agent.address, RECEIVE, 15_000n, { timeoutMs: 0, sleep: s });
  assert.equal(none.ok === false && none.definite, false);
});

test("fate: Solana by message hash and blockhash expiry; Tempo by receipt, transfer search, validBefore and nonce", async () => {
  const txb = await transferTx(agent, VET_FAC, RECEIVE, 15_000n);
  const facts = decodeSolanaTx(txb)!;
  assert.equal(facts.authority, agent.address);
  assert.equal(facts.amount, "15000");
  let valid = true;
  let landed = false;
  const rpc = async (method: string) => {
    if (method === "getSignaturesForAddress") return landed ? [{ signature: "S1" }] : [];
    if (method === "getTransaction") return { meta: { err: null }, transaction: [txb, "base64"] };
    if (method === "isBlockhashValid") return { value: valid };
    throw new Error(method);
  };
  const f = { messageHash: facts.messageHash, blockhash: facts.blockhash, account: RECEIVE };
  assert.deepEqual(await solanaTxFate(rpc, f), { fate: "pending" });
  valid = false;
  assert.deepEqual(await solanaTxFate(rpc, f), { fate: "dead" });
  landed = true;
  assert.deepEqual(await solanaTxFate(rpc, f), { fate: "landed", tx: "S1" });
  assert.deepEqual(await solanaTxFate(async () => { throw new Error("https://rpc/KEY"); }, f), { fate: "pending" });

  const base = { hash: "0xaa", from: "0xf", nonce: "3", nonceKey: "0", validBefore: "1000", sponsored: false };
  const reads = (o: { receipt?: "success" | null; time?: bigint; nonce?: bigint; hits?: string[] }) => ({
    receipt: async () => (o.receipt ? { status: o.receipt } : null),
    headTime: async () => o.time ?? 0n,
    nonce: async () => o.nonce ?? 0n,
    transfers: async () => o.hits ?? [],
  });
  assert.deepEqual(await tempoTxFate(reads({ receipt: "success" }), base), { fate: "landed", tx: "0xaa" });
  assert.deepEqual(await tempoTxFate(reads({ time: 999n }), base), { fate: "pending" });
  assert.deepEqual(await tempoTxFate(reads({ time: 1001n }), base), { fate: "dead" });
  assert.deepEqual(await tempoTxFate(reads({ nonce: 4n }), { ...base, validBefore: null }), { fate: "dead" });
  const s = { ...base, sponsored: true, search: { recipient: "0xr", amount: "5", fromBlock: "1" } };
  assert.deepEqual(await tempoTxFate(reads({ hits: ["0xBB"] }), s), { fate: "landed", tx: "0xbb" });
  assert.deepEqual(await tempoTxFate(reads({ hits: ["0xbb", "0xcc"] }), s), { fate: "pending" });
});

test("solana refund: one USDC transfer to the signer's account, facts written before sending; a taken attempt sends nothing", async () => {
  const sent: string[] = [];
  const rpc = async (method: string, params: unknown[]) => {
    if (method === "getLatestBlockhash") return { value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10 } };
    if (method === "sendTransaction") {
      sent.push(String(params[0]));
      return "sig";
    }
    if (method === "getTransaction")
      return {
        meta: { err: null, preBalances: [0], postBalances: [0], preTokenBalances: [{ owner: agent.address, mint: USDC_MINT, uiTokenAmount: { amount: "0" } }], postTokenBalances: [{ owner: agent.address, mint: USDC_MINT, uiTokenAmount: { amount: "15000" } }] },
        transaction: { message: { accountKeys: [{ pubkey: proxyPayer.address, signer: true, writable: true }], instructions: [] } },
      };
    throw new Error(method);
  };
  const written: J[] = [];
  const out = await sendSolanaRefund({ rpc, signer: proxyPayer, sleep: async () => undefined }, agent.address, 15_000n, async (f) => (written.push(f), true));
  assert.equal(out.status, "sent");
  assert.equal(written.length, 1);
  assert.equal(written[0]!.facts.account, PAYER_ATA);
  assert.equal(await checkSolanaRefundTx(sent[0]!, { payer: proxyPayer.address, to: agent.address, amount: 15_000n }), null);
  assert.match((await checkSolanaRefundTx(sent[0]!, { payer: proxyPayer.address, to: SELLER, amount: 15_000n }))!, /destination/);
  const taken = await sendSolanaRefund({ rpc, signer: proxyPayer }, agent.address, 15_000n, async () => false);
  assert.equal(taken.status, "failed");
  assert.equal(sent.length, 1, "nothing sent when the attempt belongs to someone else");
});

test("M2 tempo refund: eth_call first, gas = estimate x 1.25, fee cap, fee in USDC.e, validBefore; facts written before sending", async () => {
  const calls: string[] = [];
  let raw: Hex | null = null;
  const rpc = custom({
    async request({ method, params }: { method: string; params?: unknown[] }) {
      calls.push(method);
      switch (method) {
        case "eth_chainId":
          return "0x1079";
        case "eth_call":
          return "0x";
        case "eth_estimateGas":
          return "0xc350";
        case "eth_getTransactionCount":
          return "0x7";
        case "eth_getBlockByNumber":
          return { baseFeePerGas: "0x4a817c800", number: "0x10", timestamp: "0x68000000", hash: `0x${"11".repeat(32)}`, transactions: [] };
        case "eth_sendRawTransactionSync":
          raw = (params as [Hex])[0];
          throw new Error("not sending in this test");
        default:
          throw new Error(`unhandled ${method}`);
      }
    },
  });
  const written: J[] = [];
  const out = await sendTempoRefund(
    { account: tProxy, client: createClient({ chain: tempoChain, transport: rpc }), verify: async () => ({ settled: false, detail: "receipt not found", feePaid: null }) },
    tAgent.address,
    15_000n,
    async (f) => (written.push(f), true),
  );
  assert.equal(out.status, "unknown");
  assert.ok(calls.indexOf("eth_call") < calls.indexOf("eth_sendRawTransactionSync"));
  const t = Transaction.deserialize(raw! as never) as J;
  assert.equal(t.gas, 62_500n);
  assert.equal(t.maxFeePerGas, 12_000_000_000n);
  assert.equal(String(t.feeToken).toLowerCase(), USDC_E);
  assert.equal(t.nonce, 7);
  assert.equal(BigInt(t.validBefore), 0x68000000n + 120n);
  assert.equal(written[0]!.facts.validBefore, String(0x68000000 + 120));
  assert.equal(decodeTempoTx(raw!)!.validBefore, String(0x68000000 + 120));
});

test("store: one refund per purchase; the wallet floor rises on a top-up only while nothing is in flight", async () => {
  const sql = await testSql();
  const s = new Store(sql);
  const now = new Date("2026-10-01T10:00:00Z");
  const claim = (id: string) => s.claim({ id, chain: "tempo", target: "https://t/x", sellerAmount: 8_000n, feeReserve: 2_000n, total: 13_000n, facts: {}, now });
  assert.equal(await claim("a"), true);
  assert.equal(await claim("a"), false);
  assert.deepEqual(await s.admit("a", { chain: "tempo", payer: "0xP", day: "2026-10-01", caps: CAPS, need: 15_000n, balance: 100_000n, now }), { ok: true });
  assert.equal((await s.wallet("tempo"))?.floor, 85_000n);
  // a top-up while "a" is in flight does not raise the floor
  assert.equal(await claim("b"), true);
  assert.deepEqual(await s.admit("b", { chain: "tempo", payer: "0xP", day: "2026-10-01", caps: CAPS, need: 15_000n, balance: 500_000n, now }), { ok: true });
  assert.equal((await s.wallet("tempo"))?.floor, 70_000n);
  await s.release("a");
  await s.release("b");
  assert.equal((await s.wallet("tempo"))?.floor, 100_000n);
  // nothing in flight: the top-up raises it
  assert.equal(await claim("c"), true);
  assert.deepEqual(await s.admit("c", { chain: "tempo", payer: "0xP", day: "2026-10-01", caps: CAPS, need: 15_000n, balance: 500_000n, now }), { ok: true });
  assert.equal((await s.wallet("tempo"))?.floor, 485_000n);
  assert.deepEqual(await s.refundClaim("c", { chain: "tempo", day: "2026-10-01", to: "0xA", amount: 13_000n, maxRefund: 105_000n, now }), { ok: true });
  assert.equal((await s.refundClaim("c", { chain: "tempo", day: "2026-10-01", to: "0xA", amount: 13_000n, maxRefund: 105_000n, now })).ok, false);
  assert.equal((await s.refundClaim("d", { chain: "tempo", day: "2026-10-01", to: "0xA", amount: 105_001n, maxRefund: 105_000n, now })).ok, false);
});

// ================= Tempo =================

test("tempo: the challenge asks seller price + 0.005 to vet402's receive wallet on 4217 in USDC.e", async () => {
  const r = await tRig();
  const res = await r.buy.handle(new Request(buyUrl(T_URL)));
  assert.equal(res.status, 402);
  const req = JSON.parse(Buffer.from(/request="([^"]+)"/.exec(res.headers.get("www-authenticate")!)![1]!, "base64url").toString("utf8"));
  assert.equal(req.amount, "13000");
  assert.equal(req.recipient.toLowerCase(), T_RECEIVE.toLowerCase());
  assert.equal(req.methodDetails.chainId, 4217);
  assert.match(req.externalId, /^vet402-buy:[0-9a-f]{32}$/);
});

test("tempo: success pays the seller (which broadcasts vet402's credential) and returns the binary answer byte for byte", async () => {
  const r = await tRig();
  const cred = await agentPaysTempo(r);
  const res = await r.buy.handle(tPaid(cred));
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), r.seller.paidBody);
  assert.match(res.headers.get("x-vet402-seller-tx")!, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(r.chain.sent.map((x) => [x.from, x.to, x.amount]), [
    [tAgent.address.toLowerCase(), T_RECEIVE.toLowerCase(), 13_000n],
    [tProxy.address.toLowerCase(), r.seller.recipient.toLowerCase(), 8_000n],
  ]);
});

test("tempo: seller answers 500 after broadcasting vet402's payment -> not_delivered, no refund", async () => {
  const r = await tRig({ seller: { paidStatus: 500, paidBody: Buffer.from("boom") } });
  const cred = await agentPaysTempo(r);
  const j = await body(await r.buy.handle(tPaid(cred)));
  assert.equal(j.error, "not_delivered");
  assert.equal(r.chain.sent.length, 2);
});

test("C1/R2 tempo: the seller takes the credential, answers 500 and never broadcasts -> pending until its validBefore passes, then refunded", async () => {
  const r = await tRig({ seller: { paidStatus: 500, paidBody: Buffer.from("boom"), broadcasts: false } });
  const cred = await agentPaysTempo(r);
  const j = await body(await r.buy.handle(tPaid(cred)));
  assert.equal(j.error, "seller_payment_pending");
  assert.deepEqual((await r.reconcile()).map((a) => a.action), ["waiting: vet402's payment to the seller can still land"]);
  r.chain.timeShift = 100_000; // past the credential's validBefore
  const acts = await r.reconcile();
  assert.match(acts[0]!.action, /refund: "sent"/);
  assert.deepEqual(r.chain.sent.map((x) => [x.from, x.to, x.amount]), [
    [tAgent.address.toLowerCase(), T_RECEIVE.toLowerCase(), 13_000n],
    [tProxy.address.toLowerCase(), tAgent.address.toLowerCase(), 13_000n],
  ]);
  assert.equal((await recordOf(r.buy, j.record)).refund.status, "sent");
});

test("tempo: price raised before signing -> 402; a credential for one seller cannot buy another; recipient moved -> 403", async () => {
  const r = await tRig();
  const cred = await agentPaysTempo(r);
  assert.equal((await r.buy.handle(tPaid(cred, `${T_URL}?city=other`))).status, 402);
  r.seller.price = "9000";
  assert.equal((await body(await r.buy.handle(tPaid(cred)))).reason, "price_changed_or_invalid");
  r.seller.price = "8000";
  r.seller.recipient = T_OTHER;
  assert.equal((await body(await r.buy.handle(tPaid(cred)))).reason, "payto_not_allowlisted");
  assert.equal(r.chain.broadcasts, 0);
});

test("tempo: price raised or recipient moved at vet402's last read -> seller not paid, the agent refunded with a real Tempo transfer", async () => {
  for (const move of [(s: J) => (s.price = "9000"), (s: J) => (s.recipient = T_OTHER)]) {
    const r = await tRig({ seller: { onRead: (n, s) => void (n === 3 && move(s)) } });
    const cred = await agentPaysTempo(r);
    const res = await r.buy.handle(tPaid(cred));
    const j = await body(res);
    assert.equal(j.error, "seller_not_paid");
    assert.equal(j.refund.status, "sent");
    assert.match(res.headers.get("x-vet402-refund-tx")!, /^0x[0-9a-f]{64}$/);
    assert.equal(r.seller.paidRequests, 0);
    assert.deepEqual(r.chain.sent.at(-1)!.to, tAgent.address.toLowerCase());
  }
});

test("tempo: the same credential twice at once, re-encoded, or on another instance -> one purchase", async () => {
  const r = await tRig();
  const cred = await agentPaysTempo(r);
  const [a, b] = await Promise.all([r.buy.handle(tPaid(cred)), r.buy.handle(tPaid(cred))]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const c = JSON.parse(Buffer.from(cred.replace(/^Payment\s+/, ""), "base64url").toString("utf8"));
  assert.equal((await r.buy.handle(tPaid(`Payment ${Buffer.from(JSON.stringify({ extra: 1, ...c })).toString("base64url")}`))).status, 409);
  const r2 = await tRig({ sql: r.sql });
  assert.equal((await r2.buy.handle(tPaid(cred))).status, 409);
});

test("L5 tempo: the balance must cover a refund and its fee, not only the seller price", async () => {
  const r = await tRig();
  r.state.balance = 13_000n + 1_999n; // total + fee reserve - 1
  const cred = await agentPaysTempo(r);
  const j = await body(await r.buy.handle(tPaid(cred)));
  assert.equal(j.reason, "insufficient_balance");
  assert.equal(r.chain.broadcasts, 0);
});

test("tempo: a push credential is refused; flag off does nothing", async () => {
  const r = await tRig();
  const cred = await agentPaysTempo(r);
  const c = JSON.parse(Buffer.from(cred.replace(/^Payment\s+/, ""), "base64url").toString("utf8"));
  c.payload = { type: "hash", hash: `0x${"ab".repeat(32)}` };
  assert.equal((await body(await r.buy.handle(tPaid(`Payment ${b64url(c)}`)))).reason, "pull_only");
  const off = await tRig({ enabled: false });
  assert.equal((await off.buy.handle(tPaid(cred))).status, 503);
  assert.equal(off.chain.broadcasts + r.chain.broadcasts, 0);
});

test("tempo: a chain read fails inside the seller payment after the agent paid (nothing signed yet) -> refunded, no error text shown", async () => {
  const r = await tRig();
  r.state.failBalanceAt = 2; // 1 = before settlement, 2 = payOne's own balance read
  const cred = await agentPaysTempo(r);
  const j = await body(await r.buy.handle(tPaid(cred)));
  assert.equal(j.error, "seller_not_paid");
  assert.equal(j.reason, "seller_payment_error");
  assert.doesNotMatch(JSON.stringify(j), /rpc down|KEY/);
  assert.equal(j.refund.status, "sent");
});

test("tempo: the agent's payment not confirmed in time -> the reconciler finds it on chain and refunds", async () => {
  const r = await tRig();
  r.state.confirm = "timeout";
  const cred = await agentPaysTempo(r);
  assert.equal((await body(await r.buy.handle(tPaid(cred)))).error, "customer_payment_unconfirmed");
  r.state.confirm = "ok";
  const acts = await r.reconcile();
  assert.match(acts[0]!.action, /refund: "sent"/);
  assert.equal(r.seller.paidRequests, 0);
});

// ================= allowlist, reasons, config =================

test("allowlist from the committed data: settled pairs, delivered counted", () => {
  const a = loadAllowlist(join(import.meta.dirname, "..", "data"));
  const sol = a.entries.filter((e) => e.chain === "solana");
  assert.ok(sol.length > 50);
  assert.ok(a.entries.every((e) => e.settled >= 1));
  assert.ok(a.entries.some((e) => e.delivered === 0), "some settled sellers never delivered (refused by quote)");
  assert.ok(a.find("solana", sol[0]!.host, sol[0]!.payTo));
});

test("reasons: URLs and credentials are removed; only offer-level refusal details are shown", () => {
  assert.equal(redact("POST https://rpc.x.test/v2/abc?api-key=K failed"), "POST <url> failed");
  assert.equal(redact("postgres://user:pw@host/db down"), "<url> down");
  assert.equal(refusalReason({ refused: "price_raised", detail: "amount 12000 > recorded 10000" }), "price_raised: amount 12000 > recorded 10000");
  assert.equal(refusalReason({ refused: "ledger_unreadable", detail: "cannot read balances: https://rpc/KEY" }), "ledger_unreadable");
});

test("quote reads at most 64 KB of a 402 body", async () => {
  const huge = new Response("x".repeat(2_000_000), { status: 402 });
  assert.equal(await readTextCapped(huge, QUOTE_MAX_BODY_BYTES), "");
});

test("config: keys and the database URL come from env and are never printed; the facilitator URL is shown as its origin", async () => {
  const kp = generateKeyPairSync("ed25519");
  const priv = kp.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = kp.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const keyJson = JSON.stringify([...priv, ...pub]);
  const sol = await createKeyPairSignerFromBytes(Uint8Array.from([...priv, ...pub]));
  const tKey = generatePrivateKey();
  const env = {
    VET402_PROXY_BUY_ENABLED: "1",
    VET402_PROXY_PUBLIC_ORIGIN: "https://buy.example.com",
    DATABASE_URL: "postgres://user:DBPASS@db.example.test/neondb?sslmode=require",
    VET402_PROXY_FACILITATOR_URL: "https://facilitator.example.test/v1?key=FACKEY",
    VET402_PROXY_SOLANA_RECEIVE: RECEIVE,
    VET402_PROXY_SOLANA_PAYER: sol.address,
    VET402_PROXY_SOLANA_PAYER_KEY: keyJson,
    VET402_PROXY_TEMPO_RECEIVE: T_RECEIVE,
    VET402_PROXY_TEMPO_PAYER: privateKeyToAccount(tKey).address,
    VET402_PROXY_TEMPO_PAYER_KEY: tKey,
    VET402_PROXY_MPP_SECRET: "m".repeat(40),
    VET402_PROXY_SOLANA_DAILY_CAP: "1.50",
  };
  const c = configFromEnv(env);
  assert.equal(c.solana!.dailyCapAtomic, 1_500_000n);
  assert.equal(c.databaseUrl, env.DATABASE_URL);
  const printed = JSON.stringify(describeConfig(c));
  for (const secret of [tKey.slice(2), keyJson, "m".repeat(40), "DBPASS", "FACKEY"]) assert.equal(printed.includes(secret), false, secret);
  assert.match(printed, /"database":"set"/);
  assert.throws(() => configFromEnv({ ...env, VET402_PROXY_SOLANA_PAYER_KEY: "[1,2,secretish" }), (e: Error) => !e.message.includes("secretish"));
  assert.throws(() => configFromEnv({ ...env, VET402_PROXY_SOLANA_PAYER: "9VaAPD1CPE4i8pquaRwE7LvZXMmvGdgffD4Q8xJgaQRu" }), /census payer/);
  assert.equal(configFromEnv({ ...env, VET402_PROXY_BUY_ENABLED: "true" }).enabled, false);
});

void newFakeChain;
void fakeTempoRpc;
