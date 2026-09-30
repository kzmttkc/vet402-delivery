/**
 * Proxy buy against local mock sellers, a fake x402 facilitator and a fake Tempo RPC. No network, no
 * mainnet, no real keys: every key is generated here and thrown away.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { USDC_MINT, SOLANA_MAINNET } from "../src/constants.js";
import { USDC_E } from "../src/tempo/constants.js";
import { loadAllowlist } from "../src/proxy-buy/allowlist.js";
import { Books } from "../src/proxy-buy/books.js";
import { confirmSolanaTransfer } from "../src/proxy-buy/wire.js";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { solanaPaymentKey } from "../src/proxy-buy/solana.js";
import { QUOTE_MAX_BODY_BYTES, readTextCapped } from "../src/proxy-buy/quote.js";
import { checkSolanaRefundTx, sendSolanaRefund } from "../src/proxy-buy/refund.js";
import { redact, refusalReason } from "../src/proxy-buy/reasons.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { configFromEnv, describeConfig } from "../src/proxy-buy/config.js";
import {
  FakeChain,
  FakeFacilitator,
  ORIGIN,
  RECEIVE,
  SELLER,
  SELLER2,
  SELLER_FAC,
  S_HOST,
  S_URL,
  SolRig,
  SolSeller,
  TRig,
  TSeller,
  T_HOST,
  T_OTHER,
  T_RECEIVE,
  T_SELLER,
  T_URL,
  VET_FAC,
  agent,
  agentPaysSolana,
  agentPaysTempo,
  allowlist,
  b64url,
  buyUrl,
  fakeTempoRpc,
  paidReq,
  proxyPayer,
  solRig,
  solSeller,
  solSellerFetch,
  tAgent,
  tPaid,
  tProxy,
  tRig,
  tSellerFetch,
  transferTx,
} from "./proxy-buy-fakes.js";

// ================= Solana =================

test("solana: the 402 asks seller price + 0.005 to vet402's receive wallet, bound to the target and the seller", async () => {
  const r = solRig();
  const { req, body } = await agentPaysSolana(r.buy);
  assert.equal(req.amount, "15000");
  assert.equal(req.payTo, RECEIVE);
  assert.equal(req.asset, USDC_MINT);
  assert.equal(req.network, SOLANA_MAINNET);
  assert.equal(req.extra?.feePayer, VET_FAC);
  assert.equal(req.extra?.sellerAmount, "10000");
  assert.equal(req.extra?.sellerPayTo, SELLER);
  assert.equal(req.extra?.target, S_URL);
  const offers = (body.buy as { offers: { solana: { total: string; fee: string } } }).offers;
  assert.equal(offers.solana.total, "0.015000");
  assert.equal(offers.solana.fee, "0.005000");
  assert.equal(r.fac.settles, 0);
  assert.equal(r.sellerPays.length, 0);
});

test("solana: success returns the seller's answer as-is, both transactions and a public record", async () => {
  const r = solRig();
  const { header } = await agentPaysSolana(r.buy);
  const res = await r.buy.handle(paidReq(header));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), r.seller.paidBody);
  assert.equal(res.headers.get("content-type"), "application/json");
  assert.match(res.headers.get("x-vet402-customer-tx")!, /^cust/);
  assert.equal(res.headers.get("x-vet402-seller-tx"), "sellertx1");
  assert.ok(res.headers.get("PAYMENT-RESPONSE"));
  assert.equal(r.fac.settles, 1);
  assert.deepEqual(r.sellerPays, [{ amount: 10_000n, payTo: SELLER }]);
  const recUrl = res.headers.get("x-vet402-record")!;
  const rec = await r.buy.handle(new Request(recUrl));
  assert.equal(rec.status, 200);
  const j = (await rec.json()) as Record<string, any>;
  assert.equal(j.outcome, "delivered");
  assert.equal(j.totalAtomic, "15000");
  assert.equal(j.seller.priceAtomic, "10000");
  assert.equal(j.sellerPayment.tx, "sellertx1");
  assert.equal(j.customer.confirmed, true);
  assert.equal(j.refund, "none");
});

test("solana: the seller does not deliver after being paid -> 502 not_delivered, recorded, no refund", async () => {
  const r = solRig({ seller: { paidStatus: 500, paidBody: "upstream down" } });
  const { header } = await agentPaysSolana(r.buy);
  const res = await r.buy.handle(paidReq(header));
  assert.equal(res.status, 502);
  const j = (await res.json()) as Record<string, any>;
  assert.equal(j.error, "not_delivered");
  assert.equal(j.sellerStatus, 500);
  assert.equal(j.refund, "none");
  assert.equal(r.sellerPays.length, 1);
  const rec = (await (await r.buy.handle(new Request(j.record))).json()) as Record<string, any>;
  assert.equal(rec.outcome, "not_delivered");
  assert.equal(rec.sellerPayment.tx, "sellertx1");
});

test("solana: the seller raised its price after the agent signed -> 402 price_changed, nothing settled or paid", async () => {
  const r = solRig();
  const { header } = await agentPaysSolana(r.buy);
  r.seller.price = 20_000n;
  const res = await r.buy.handle(paidReq(header));
  assert.equal(res.status, 402);
  const j = (await res.json()) as Record<string, any>;
  assert.equal(j.reason, "price_changed");
  assert.equal(j.charged, false);
  assert.ok(res.headers.get("PAYMENT-REQUIRED"), "a fresh price to sign");
  assert.equal(r.fac.verifies, 0);
  assert.equal(r.fac.settles, 0);
  assert.equal(r.sellerPays.length, 0);
});

test("solana: the seller raised its price between vet402's re-read and its payment -> payOne refuses, seller not paid, recorded", async () => {
  // unpaid reads: 1 = agent's 402, 2 = the paid request's re-read, 3 = payOne's read right before signing
  const r = solRig({ seller: { onRead: (n, s) => { if (n === 3) s.price = 12_000n; } } });
  const { header } = await agentPaysSolana(r.buy);
  const res = await r.buy.handle(paidReq(header));
  assert.equal(res.status, 502);
  const j = (await res.json()) as Record<string, any>;
  assert.equal(j.error, "seller_not_paid");
  assert.match(j.reason, /price_raised/);
  assert.equal(r.fac.settles, 1, "the agent's payment settled before the third read");
  assert.equal(r.sellerPays.length, 0);
  assert.equal(r.seller.paidRequests, 0);
  // the agent's full payment goes back to the address that paid
  assert.equal(j.refund.status, "sent");
  assert.equal(j.refund.to, agent.address);
  assert.equal(j.refund.amountAtomic, "15000");
  assert.equal(res.headers.get("x-vet402-refund-tx"), "refundtx1");
  assert.deepEqual(r.refunds, [{ to: agent.address, amount: 15_000n }]);
  const rec = (await (await r.buy.handle(new Request(j.record))).json()) as Record<string, any>;
  assert.equal(rec.refund.tx, "refundtx1");
  assert.equal(rec.outcome, "seller_not_paid");
});

test("solana: the seller's payTo changed to an address vet402 never paid -> 403 before any charge", async () => {
  const r = solRig();
  const { header } = await agentPaysSolana(r.buy);
  r.seller.payTo = SELLER2;
  const res = await r.buy.handle(paidReq(header));
  assert.equal(res.status, 403);
  const j = (await res.json()) as Record<string, any>;
  assert.equal(j.reason, "payto_not_allowlisted");
  assert.equal(j.charged, false);
  assert.equal(r.fac.settles, 0);
  assert.equal(r.sellerPays.length, 0);
});

test("solana: payTo changed between vet402's re-read and its payment -> payOne refuses payto_mismatch, seller not paid", async () => {
  const r = solRig({ seller: { onRead: (n, s) => { if (n === 3) s.payTo = SELLER2; } } });
  const { header } = await agentPaysSolana(r.buy);
  const res = await r.buy.handle(paidReq(header));
  assert.equal(res.status, 502);
  const j = (await res.json()) as Record<string, any>;
  assert.match(j.reason, /payto_mismatch/);
  assert.equal(r.sellerPays.length, 0);
  assert.equal(j.refund.status, "sent");
  assert.equal(r.refunds.length, 1);
});

test("solana: the same signed payment sent twice at once settles and pays once; the other is 409", async () => {
  const r = solRig();
  const { header } = await agentPaysSolana(r.buy);
  const [a, b] = await Promise.all([r.buy.handle(paidReq(header)), r.buy.handle(paidReq(header))]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.equal(r.fac.settles, 1);
  assert.equal(r.sellerPays.length, 1);
  // replayed later, and after a restart of the process (keys are on disk)
  assert.equal((await r.buy.handle(paidReq(header))).status, 409);
  r.books.release();
  const books2 = new Books({ dataDir: r.dir, solana: { payer: proxyPayer.address, dailyCapAtomic: 2_000_000n, maxPerCallAtomic: 100_000n, dailyMaxPurchases: 100, dailyRefundCapAtomic: 1n, maxRefundAtomic: 1n } });
  const key = solanaPaymentKey(decodePaymentSignatureHeader(header));
  assert.equal(books2.claim(key, "solana", 1n, 0n), false, "the key is on disk");
  assert.equal(books2.claim("0".repeat(32), "solana", 1n, 0n), true);
  books2.release();
});

test("solana: the same signed transaction re-encoded (extra payload fields, another JSON) is the same payment -> 409", async () => {
  const r = solRig();
  const { header } = await agentPaysSolana(r.buy);
  assert.equal((await r.buy.handle(paidReq(header))).status, 200);
  const p = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  p.payload = { junk: "x", transaction: p.payload.transaction };
  const again = await r.buy.handle(paidReq(Buffer.from(JSON.stringify(p)).toString("base64")));
  assert.equal(again.status, 409);
  assert.equal(r.fac.settles, 1);
  assert.equal(r.sellerPays.length, 1);
});

test("solana: a facilitator that answers a new payment with an earlier settled transaction -> nothing paid or refunded for it", async () => {
  const r = solRig();
  r.fac.fixedTx = "custSAME";
  const a = await agentPaysSolana(r.buy, S_URL, "ee112233445566778899aabbccddeeff");
  assert.equal((await r.buy.handle(paidReq(a.header))).status, 200);
  const b = await agentPaysSolana(r.buy, S_URL, "ff112233445566778899aabbccddeeff");
  const rb = await r.buy.handle(paidReq(b.header));
  assert.equal(rb.status, 409);
  assert.equal(((await rb.json()) as Record<string, any>).error, "duplicate_customer_tx");
  assert.equal(r.sellerPays.length, 1);
  assert.equal(r.refunds.length, 0);
});

test("solana: two different payments at once when the daily cap has room for one -> one paid, one 503 with no charge", async () => {
  const r = solRig({ dailyCap: 15_000n });
  const p1 = await agentPaysSolana(r.buy, S_URL, "aa112233445566778899aabbccddeeff");
  const p2 = await agentPaysSolana(r.buy, S_URL, "bb112233445566778899aabbccddeeff");
  const [a, b] = await Promise.all([r.buy.handle(paidReq(p1.header)), r.buy.handle(paidReq(p2.header))]);
  const got = [a.status, b.status].sort();
  assert.deepEqual(got, [200, 503]);
  const refused = a.status === 503 ? a : b;
  const j = (await refused.json()) as Record<string, any>;
  assert.equal(j.reason, "daily_cap_reached");
  assert.equal(j.charged, false);
  assert.equal(r.fac.settles, 1);
  assert.equal(r.sellerPays.length, 1);
});

test("solana: the proxy wallet balance is too low -> 503 before any charge", async () => {
  const r = solRig({ balance: 5_000n });
  const { header } = await agentPaysSolana(r.buy);
  const res = await r.buy.handle(paidReq(header));
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as Record<string, any>).reason, "insufficient_balance");
  assert.equal(r.fac.settles, 0);
});

test("solana: a seller above the per-purchase cap is refused before any 402", async () => {
  const r = solRig({ seller: { price: 150_000n } });
  const res = await r.buy.handle(new Request(buyUrl(S_URL)));
  assert.equal(res.status, 422);
  const j = (await res.json()) as Record<string, any>;
  assert.equal(j.reason, "no_payable_offer");
  assert.equal(j.offers.solana.refused, "price_over_cap");
  assert.equal(res.headers.get("PAYMENT-REQUIRED"), null);
});

test("solana: the agent's transfer is not confirmed on chain -> vet402 does not pay the seller, recorded", async () => {
  const r = solRig();
  r.state.confirm = false;
  const { header } = await agentPaysSolana(r.buy);
  const res = await r.buy.handle(paidReq(header));
  assert.equal(res.status, 502);
  const j = (await res.json()) as Record<string, any>;
  assert.equal(j.error, "customer_payment_unconfirmed");
  assert.equal(r.sellerPays.length, 0);
});

test("solana: settlement refused by the facilitator -> no charge, seller not paid; settle throws -> recorded as unknown, seller not paid", async () => {
  const r = solRig();
  r.fac.fail = "settle_false";
  const a = await agentPaysSolana(r.buy, S_URL, "cc112233445566778899aabbccddeeff");
  const ra = await r.buy.handle(paidReq(a.header));
  assert.equal(ra.status, 402);
  assert.equal(((await ra.json()) as Record<string, any>).reason, "customer_settlement_failed");
  r.fac.fail = "settle_throw";
  const b = await agentPaysSolana(r.buy, S_URL, "dd112233445566778899aabbccddeeff");
  const rb = await r.buy.handle(paidReq(b.header));
  assert.equal(rb.status, 502);
  const text = await rb.text();
  assert.doesNotMatch(text, /SECRET123|rpc\.example/, "an error message never reaches the answer");
  const jb = JSON.parse(text) as Record<string, any>;
  assert.equal(jb.error, "customer_payment_unconfirmed");
  assert.equal(jb.charged, "unknown");
  assert.equal(r.sellerPays.length, 0);
  assert.equal(r.refunds.length, 0, "no refund when it is not known that the agent paid");
  const rec = await (await r.buy.handle(new Request(jb.record))).text();
  assert.doesNotMatch(rec, /SECRET123|rpc\.example/);
});

test("solana: an RPC error with its URL (and key) in the message never reaches the answer", async () => {
  const r = solRig();
  r.state.balanceError = "fetch failed: https://mainnet.example-rpc.test/v2/SECRET-KEY-42";
  const { header } = await agentPaysSolana(r.buy);
  const res = await r.buy.handle(paidReq(header));
  assert.equal(res.status, 503);
  const text = await res.text();
  assert.doesNotMatch(text, /SECRET-KEY-42|example-rpc/);
  assert.equal(JSON.parse(text).reason, "ledger_unreadable");
});

test("solana: the seller's binary answer is handed over byte for byte; an answer above the cap is not forwarded and not refunded (the seller was paid)", async () => {
  const bin = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x80]);
  const r = solRig({ seller: { paidBody: bin, paidType: "image/png" } });
  const { header } = await agentPaysSolana(r.buy);
  const res = await r.buy.handle(paidReq(header));
  assert.equal(res.status, 200);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bin);
  const big = solRig({ seller: { paidBody: new Uint8Array(1_000_001).fill(65) } });
  const h2 = await agentPaysSolana(big.buy);
  const r2 = await big.buy.handle(paidReq(h2.header));
  assert.equal(r2.status, 502);
  const j2 = (await r2.json()) as Record<string, any>;
  assert.equal(j2.error, "answer_too_large");
  assert.equal(j2.refund, "none");
  assert.equal(big.sellerPays.length, 1);
  assert.equal(big.refunds.length, 0);
});

test("solana: refund caps: over the daily refund cap the refund is refused and recorded; a failed refund is recorded, never retried", async () => {
  const r = solRig({ refundCap: 10_000n, seller: { onRead: (n, s) => { if (n === 3) s.price = 12_000n; } } });
  const { header } = await agentPaysSolana(r.buy);
  const j = (await (await r.buy.handle(paidReq(header))).json()) as Record<string, any>;
  assert.equal(j.refund.status, "refused");
  assert.equal(j.refund.reason, "daily_refund_cap_reached");
  assert.equal(r.refunds.length, 0);
  const f = solRig({ seller: { onRead: (n, s) => { if (n === 3) s.price = 12_000n; } } });
  f.state.refund = "failed";
  const h = await agentPaysSolana(f.buy);
  const jf = (await (await f.buy.handle(paidReq(h.header))).json()) as Record<string, any>;
  assert.equal(jf.refund.status, "failed");
  // sent again: stopped before any settlement (the raised price, or the spent key), and never refunded twice
  assert.ok([402, 409].includes((await f.buy.handle(paidReq(h.header))).status));
  assert.equal(f.fac.settles, 1);
  assert.equal(f.refunds.length, 0);
});

test("solana: a quote whose 402 body is huge still reads the x402 header, without reading the whole body", async () => {
  const r = solRig();
  const huge = "x".repeat(2_000_000);
  const orig = solSellerFetch(r.seller, r.fetched);
  const fetchHuge = (async (u: string | URL, init?: RequestInit) => {
    const res = await orig(u, init);
    return new Response(huge, { status: res.status, headers: res.headers });
  }) as unknown as typeof fetch;
  const text = await readTextCapped(await fetchHuge(S_URL), QUOTE_MAX_BODY_BYTES);
  assert.equal(text, "");
});

test("solana: a payment to another address or for another amount is refused by verify, nothing settled", async () => {
  const r = solRig();
  const { req } = await agentPaysSolana(r.buy);
  const tx = await transferTx(agent, String(req.extra?.feePayer), SELLER2, BigInt(req.amount));
  const payload = { x402Version: 2, accepted: req, payload: { transaction: tx } } as unknown as PaymentPayload;
  const res = await r.buy.handle(paidReq(encodePaymentSignatureHeader(payload)));
  assert.equal(res.status, 402);
  assert.equal(((await res.json()) as Record<string, any>).reason, "invalid_payment");
  assert.equal(r.fac.settles, 0);
});

test("solana: x402 v1 payments are refused (v1 matching ignores the amount)", async () => {
  const r = solRig();
  const { header } = await agentPaysSolana(r.buy);
  const p = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  p.x402Version = 1;
  const res = await r.buy.handle(paidReq(Buffer.from(JSON.stringify(p)).toString("base64")));
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as Record<string, any>).reason, "unsupported_x402_version");
  assert.equal(r.fac.settles, 0);
});

// ================= entry checks =================

test("a host vet402 never paid is refused without contacting it", async () => {
  const r = solRig();
  const res = await r.buy.handle(new Request(buyUrl("https://unknown.example/x")));
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as Record<string, any>).reason, "seller_not_allowlisted");
  assert.equal(r.fetched.length, 0);
  for (const bad of ["http://seller.test/x", "https://127.0.0.1/x", "https://vet402.com/x", "https://user:pw@seller.test/x"]) {
    const b = await r.buy.handle(new Request(buyUrl(bad)));
    assert.equal(b.status, 400, bad);
  }
  assert.equal(r.fetched.length, 0);
});

test("flag off: nothing is read, quoted, settled, paid or written", async () => {
  const r = solRig({ enabled: false });
  const res = await r.buy.handle(new Request(buyUrl(S_URL)));
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as Record<string, any>).reason, "proxy_buy_disabled");
  const paid = await r.buy.handle(paidReq("eyJ4IjoxfQ=="));
  assert.equal(paid.status, 503);
  assert.equal(r.fetched.length, 0);
  assert.equal(r.fac.settles, 0);
  assert.deepEqual(readdirSync(r.dir).filter((f) => f !== "proxy-buy.lock"), []);
});

test("a second process cannot open the same data directory", () => {
  const r = solRig();
  assert.throws(() => new Books({ dataDir: r.dir, lock: true }), /another proxy-buy process/);
  r.books.release();
  const again = new Books({ dataDir: r.dir, lock: true });
  again.release();
});

test("records: unknown or malformed ids are 404", async () => {
  const r = solRig();
  assert.equal((await r.buy.handle(new Request(`${ORIGIN}/v1/buy/records/${"a".repeat(32)}`))).status, 404);
  assert.equal((await r.buy.handle(new Request(`${ORIGIN}/v1/buy/records/../../etc`))).status, 404);
  assert.equal((await r.buy.handle(new Request(buyUrl(S_URL), { method: "POST" }))).status, 405);
});

test("confirmSolanaTransfer: exact amount into the receive wallet, failed tx and wrong amount refused, timeout refused", async () => {
  const tx = (payToDelta: string, err: unknown = null) => ({
    meta: {
      err,
      preBalances: [0],
      postBalances: [0],
      preTokenBalances: [{ owner: RECEIVE, mint: USDC_MINT, uiTokenAmount: { amount: "0" } }],
      postTokenBalances: [{ owner: RECEIVE, mint: USDC_MINT, uiTokenAmount: { amount: payToDelta } }],
    },
    transaction: { message: { accountKeys: [{ pubkey: VET_FAC, signer: true, writable: true }], instructions: [] } },
  });
  const rpcWith = (v: unknown) => async () => v;
  const noSleep = async () => undefined;
  assert.deepEqual(await confirmSolanaTransfer(rpcWith(tx("15000")), "sig", agent.address, RECEIVE, 15_000n, { sleep: noSleep }), { ok: true });
  assert.equal((await confirmSolanaTransfer(rpcWith(tx("14999")), "sig", agent.address, RECEIVE, 15_000n, { sleep: noSleep })).ok, false);
  assert.equal((await confirmSolanaTransfer(rpcWith(tx("15000", { InstructionError: [0, "x"] })), "sig", agent.address, RECEIVE, 15_000n, { sleep: noSleep })).ok, false);
  assert.equal((await confirmSolanaTransfer(rpcWith(null), "sig", agent.address, RECEIVE, 15_000n, { timeoutMs: 0, sleep: noSleep })).ok, false);
  // a facilitator that names no payer: the receive wallet's increase still decides
  assert.deepEqual(await confirmSolanaTransfer(rpcWith(tx("15000")), "sig", null, RECEIVE, 15_000n, { sleep: noSleep }), { ok: true });
  assert.equal((await confirmSolanaTransfer(rpcWith(tx("1")), "sig", null, RECEIVE, 15_000n, { sleep: noSleep })).ok, false);
});

// ================= Tempo =================


test("tempo: the challenge asks seller price + 0.005 to vet402's receive wallet on 4217 in USDC.e", async () => {
  const r = tRig();
  const res = await r.buy.handle(new Request(buyUrl(T_URL)));
  assert.equal(res.status, 402);
  const www = res.headers.get("www-authenticate")!;
  const req = JSON.parse(Buffer.from(/request="([^"]+)"/.exec(www)![1]!, "base64url").toString("utf8"));
  assert.equal(req.amount, "13000");
  assert.equal(req.currency, USDC_E);
  assert.equal(req.recipient.toLowerCase(), T_RECEIVE.toLowerCase());
  assert.equal(req.methodDetails.chainId, 4217);
  assert.match(req.externalId, /^vet402-buy:[0-9a-f]{32}$/);
  const j = (await res.json()) as Record<string, any>;
  assert.equal(j.buy.offers.tempo.total, "0.013000");
  assert.equal(j.buy.offers.solana.refused, "chain_not_offered");
  assert.equal(r.chain.broadcasts, 0);
});

test("tempo: success broadcasts the agent's payment, pays the seller, returns the binary answer byte for byte", async () => {
  const r = tRig();
  const cred = await agentPaysTempo(r);
  const res = await r.buy.handle(tPaid(cred));
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), r.seller.paidBody);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.match(res.headers.get("x-vet402-customer-tx")!, /^0x[0-9a-f]{64}$/);
  assert.match(res.headers.get("x-vet402-seller-tx")!, /^0x[0-9a-f]{64}$/);
  assert.ok(res.headers.get("payment-receipt"));
  assert.equal(r.chain.broadcasts, 1, "only the agent's payment is broadcast by vet402; the seller broadcasts vet402's");
  assert.deepEqual(r.chain.sent.map((s) => [s.to, s.amount]), [[T_RECEIVE.toLowerCase(), 13_000n]]);
  assert.equal(r.seller.paidRequests, 1);
  const rec = (await (await r.buy.handle(new Request(res.headers.get("x-vet402-record")!))).json()) as Record<string, any>;
  assert.equal(rec.outcome, "delivered");
  assert.equal(rec.answer.bodyBytes, 7);
  assert.equal(rec.chain, "tempo");
});

test("tempo: the seller answers 500 after being paid -> 502 not_delivered, recorded", async () => {
  const r = tRig({ seller: { paidStatus: 500, paidBody: Buffer.from("boom") } });
  const cred = await agentPaysTempo(r);
  const res = await r.buy.handle(tPaid(cred));
  assert.equal(res.status, 502);
  const j = (await res.json()) as Record<string, any>;
  assert.equal(j.error, "not_delivered");
  assert.equal(j.sellerStatus, 500);
  assert.equal(r.seller.paidRequests, 1);
});

test("tempo: the seller raised its price after the agent signed -> 402, nothing broadcast or paid", async () => {
  const r = tRig();
  const cred = await agentPaysTempo(r);
  r.seller.price = "9000";
  const res = await r.buy.handle(tPaid(cred));
  assert.equal(res.status, 402);
  const j = (await res.json()) as Record<string, any>;
  assert.equal(j.reason, "price_changed_or_invalid");
  assert.equal(j.charged, false);
  assert.equal(r.chain.broadcasts, 0);
  assert.equal(r.seller.paidRequests, 0);
});

test("tempo: a credential signed for one seller cannot buy from another at the same price", async () => {
  const r = tRig();
  const cred = await agentPaysTempo(r);
  const res = await r.buy.handle(tPaid(cred, `${T_URL}?city=other`));
  assert.equal(res.status, 402);
  assert.equal(r.chain.broadcasts, 0);
});

test("tempo: price raised between vet402's re-read and its payment -> payOne refuses, seller not paid, recorded", async () => {
  // unpaid reads: 1 = agent's 402, 2 = paid re-read, 3 = payOne's read right before signing
  const r = tRig({ seller: { onRead: (n, s) => { if (n === 3) s.price = "9000"; } } });
  const cred = await agentPaysTempo(r);
  const res = await r.buy.handle(tPaid(cred));
  assert.equal(res.status, 502);
  const j = (await res.json()) as Record<string, any>;
  assert.equal(j.error, "seller_not_paid");
  assert.match(j.reason, /price_raised/);
  assert.equal(r.seller.paidRequests, 0);
  // the refund: a real signed Tempo transfer, read back and "mined" by the fake RPC
  assert.equal(j.refund.status, "sent");
  assert.equal(j.refund.to.toLowerCase(), tAgent.address.toLowerCase());
  assert.equal(j.refund.amountAtomic, "13000");
  assert.match(res.headers.get("x-vet402-refund-tx")!, /^0x[0-9a-f]{64}$/);
  assert.equal(r.chain.broadcasts, 2, "the agent's payment, then the refund");
  assert.deepEqual(r.chain.sent.map((x) => [x.from, x.to, x.amount]), [
    [tAgent.address.toLowerCase(), T_RECEIVE.toLowerCase(), 13_000n],
    [tProxy.address.toLowerCase(), tAgent.address.toLowerCase(), 13_000n],
  ]);
  // the refund does not count as unexplained outflow for the next purchase of the day
  r.state.outflow = 13_000n + 31n;
  r.seller.onRead = undefined;
  r.seller.price = "8000";
  const cred2 = await agentPaysTempo(r);
  assert.equal((await r.buy.handle(tPaid(cred2))).status, 200);
});

test("tempo: recipient changed to an address vet402 never paid -> 403 before any broadcast", async () => {
  const r = tRig();
  const cred = await agentPaysTempo(r);
  r.seller.recipient = T_OTHER;
  const res = await r.buy.handle(tPaid(cred));
  assert.equal(res.status, 403);
  assert.equal(((await res.json()) as Record<string, any>).reason, "payto_not_allowlisted");
  assert.equal(r.chain.broadcasts, 0);
});

test("tempo: recipient changed between vet402's re-read and its payment -> recipient_mismatch, seller not paid", async () => {
  const r = tRig({ seller: { onRead: (n, s) => { if (n === 3) s.recipient = T_OTHER; } } });
  const cred = await agentPaysTempo(r);
  const res = await r.buy.handle(tPaid(cred));
  assert.equal(res.status, 502);
  const j = (await res.json()) as Record<string, any>;
  assert.match(j.reason, /recipient_mismatch/);
  assert.equal(r.seller.paidRequests, 0);
  assert.equal(j.refund.status, "sent");
});

test("tempo: the same credential sent twice at once is broadcast and paid once; the other is 409", async () => {
  const r = tRig();
  const cred = await agentPaysTempo(r);
  const [a, b] = await Promise.all([r.buy.handle(tPaid(cred)), r.buy.handle(tPaid(cred))]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(r.chain.broadcasts, 1);
  assert.equal(r.seller.paidRequests, 1);
  assert.equal((await r.buy.handle(tPaid(cred))).status, 409);
});

test("tempo: daily cap reached -> 503 before the broadcast", async () => {
  const r = tRig({ dailyCap: 9_000n }); // 8000 + fee reserve 2000 > 9000
  const cred = await agentPaysTempo(r);
  const res = await r.buy.handle(tPaid(cred));
  assert.equal(res.status, 503);
  const j = (await res.json()) as Record<string, any>;
  assert.equal(j.reason, "daily_cap_reached");
  assert.equal(j.charged, false);
  assert.equal(r.chain.broadcasts, 0);
});

test("tempo: more left the proxy wallet on chain than its ledger shows -> 503 before the broadcast", async () => {
  const r = tRig();
  r.state.outflow = 1n;
  const cred = await agentPaysTempo(r);
  const res = await r.buy.handle(tPaid(cred));
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as Record<string, any>).reason, "chain_spend_exceeds_ledger");
  assert.equal(r.chain.broadcasts, 0);
});

test("tempo: a push credential (already broadcast by the agent) is refused", async () => {
  const r = tRig();
  const cred = await agentPaysTempo(r);
  const c = JSON.parse(Buffer.from(cred.replace(/^Payment\s+/, ""), "base64url").toString("utf8"));
  c.payload = { type: "hash", hash: `0x${"ab".repeat(32)}` };
  const res = await r.buy.handle(tPaid(`Payment ${b64url(c)}`));
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as Record<string, any>).reason, "pull_only");
  assert.equal(r.chain.broadcasts, 0);
});

test("tempo: the agent's transfer is not found on chain after the broadcast -> seller not paid, recorded", async () => {
  const r = tRig();
  r.state.confirm = false;
  const cred = await agentPaysTempo(r);
  const res = await r.buy.handle(tPaid(cred));
  assert.equal(res.status, 502);
  assert.equal(((await res.json()) as Record<string, any>).error, "customer_payment_unconfirmed");
  assert.equal(r.seller.paidRequests, 0);
});

test("tempo: a chain read fails inside the seller payment after the agent paid (before anything is signed) -> refunded, recorded, not retried", async () => {
  const r = tRig();
  r.state.failBalanceAt = 2; // 1 = headroom before the broadcast, 2 = payOne's own balance read
  const cred = await agentPaysTempo(r);
  const res = await r.buy.handle(tPaid(cred));
  assert.equal(res.status, 502);
  const j = (await res.json()) as Record<string, any>;
  assert.equal(j.error, "seller_not_paid");
  assert.equal(j.reason, "seller_payment_error");
  assert.doesNotMatch(JSON.stringify(j), /rpc down/, "the error text itself is not shown");
  assert.equal(j.refund.status, "sent");
  assert.equal(r.seller.paidRequests, 0);
  const rec = (await (await r.buy.handle(new Request(j.record))).json()) as Record<string, any>;
  assert.equal(rec.refund.status, "sent");
  assert.equal((await r.buy.handle(tPaid(cred))).status, 409);
  assert.equal(r.chain.broadcasts, 2);
});

test("tempo: the same signed transaction in a re-encoded credential is the same payment -> 409", async () => {
  const r = tRig();
  const cred = await agentPaysTempo(r);
  assert.equal((await r.buy.handle(tPaid(cred))).status, 200);
  const c = JSON.parse(Buffer.from(cred.replace(/^Payment\s+/, ""), "base64url").toString("utf8"));
  const re = `Payment ${Buffer.from(JSON.stringify({ extra: 1, ...c })).toString("base64url")}`;
  const again = await r.buy.handle(tPaid(re));
  assert.equal(again.status, 409);
  assert.equal(r.chain.broadcasts, 1);
});

test("tempo: flag off -> nothing read, broadcast or written", async () => {
  const r = tRig({ enabled: false });
  assert.equal((await r.buy.handle(new Request(buyUrl(T_URL)))).status, 503);
  assert.equal((await r.buy.handle(tPaid("Payment eyJ4IjoxfQ"))).status, 503);
  assert.equal(r.fetched.length, 0);
  assert.equal(r.chain.broadcasts, 0);
  assert.equal(existsSync(join(r.dir, "records.jsonl")), false);
});

// ================= allowlist and config =================

test("allowlist from the committed data: only settled purchases, host and payTo must both match", () => {
  const a = loadAllowlist(join(import.meta.dirname, "..", "data"));
  const sol = a.entries.filter((e) => e.chain === "solana");
  const tem = a.entries.filter((e) => e.chain === "tempo");
  assert.ok(sol.length > 50, `solana pairs ${sol.length}`);
  assert.ok(tem.length > 10, `tempo pairs ${tem.length}`);
  for (const e of a.entries) assert.ok(e.settled >= 1);
  const one = sol[0]!;
  assert.ok(a.find("solana", one.host, one.payTo));
  assert.equal(a.find("solana", one.host, SELLER2), null);
  assert.equal(a.find("tempo", tem[0]!.host, tem[0]!.payTo.toUpperCase().replace("0X", "0x")) !== null, true);
});

test("config: keys come from env, are never printed, and the census payers are refused", async () => {
  const kp = generateKeyPairSync("ed25519");
  const priv = kp.privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = kp.publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const keyJson = JSON.stringify([...priv, ...pub]);
  const sol = await createKeyPairSignerFromBytes(Uint8Array.from([...priv, ...pub]));
  const tKey = generatePrivateKey();
  const env = {
    VET402_PROXY_BUY_ENABLED: "1",
    VET402_PROXY_PUBLIC_ORIGIN: "https://buy.example.com",
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
  assert.equal(c.tempo!.dailyCapAtomic, 2_000_000n);
  const printed = JSON.stringify(describeConfig(c));
  assert.equal(printed.includes(tKey.slice(2)), false);
  assert.equal(printed.includes(keyJson), false);
  assert.equal(printed.includes("m".repeat(40)), false);
  // a malformed key: the error does not quote it
  assert.throws(() => configFromEnv({ ...env, VET402_PROXY_SOLANA_PAYER_KEY: "[1,2,secretish" }), (e: Error) => !e.message.includes("secretish"));
  assert.throws(() => configFromEnv({ ...env, VET402_PROXY_SOLANA_PAYER: "9VaAPD1CPE4i8pquaRwE7LvZXMmvGdgffD4Q8xJgaQRu" }), /census payer/);
  assert.throws(() => configFromEnv({ ...env, VET402_PROXY_TEMPO_PAYER: "0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51" }), /census payer/);
  assert.throws(() => configFromEnv({ ...env, VET402_PROXY_SOLANA_DAILY_CAP: "6.00" }), /at most/);
  assert.throws(() => configFromEnv({ ...env, VET402_PROXY_TEMPO_RECEIVE: env.VET402_PROXY_TEMPO_PAYER }), /must differ/);
  assert.equal(configFromEnv({ ...env, VET402_PROXY_BUY_ENABLED: "true" }).enabled, false, "only the exact value 1 switches it on");
});

// ================= books: day boundary, refunds =================

const caps = { payer: "", dailyCapAtomic: 2_000_000n, dailyMaxPurchases: 100, dailyRefundCapAtomic: 200_000n, maxRefundAtomic: 105_000n };

test("UTC day boundary: a purchase in flight keeps its day ledger; the next day opens only when none is in flight", async () => {
  const dir = mkdtempSync(join(tmpdir(), "proxy-buy-day-"));
  const b = new Books({ dataDir: dir, solana: { ...caps, payer: proxyPayer.address, maxPerCallAtomic: 100_000n }, tempo: { ...caps, payer: tProxy.address } });
  const d1 = new Date("2026-10-01T23:59:59Z");
  const d2 = new Date("2026-10-02T00:00:01Z");
  // Solana
  assert.equal(b.claim("k1", "solana", 10_000n, 0n), true);
  const h = b.solanaHeadroom(d1, { usdcAtomic: 1_000_000n, lamports: 10_000_000n }, "k1", 10_000n, 15_000n);
  assert.ok(h.ok);
  assert.equal(b.solanaBudget(d2, 1_000_000n, "k2").day, "2026-10-01", "k1 is in flight: the new day waits");
  b.done("k1");
  assert.equal(b.solanaBudget(d2, 1_000_000n, "k2").day, "2026-10-02");
  // Tempo: the start block of the new day is read only when the old day's purchases are over
  let head = 100n;
  assert.equal(b.claim("t1", "tempo", 8_000n, 2_000n), true);
  const t = await b.tempoHeadroom(d1, async () => head, "t1", { amount: 8_000n, feeReserve: 2_000n, refundTotal: 13_000n }, { spentSinceStart: async () => 0n, balance: async () => 1_000_000n });
  assert.ok(t.ok);
  head = 200n;
  assert.equal((await b.tempoLedger(d2, async () => head, "t2")).day, "2026-10-01");
  b.done("t1");
  const nd = await b.tempoLedger(d2, async () => head, "t2");
  assert.equal(nd.day, "2026-10-02");
  assert.equal(nd.startBlock, 200n);
});

test("refunds: one per payment key, also after a restart; per-refund and daily caps; refunds are not counted as unexplained Tempo outflow", () => {
  const dir = mkdtempSync(join(tmpdir(), "proxy-buy-refund-"));
  const now = new Date("2026-10-01T10:00:00Z");
  const b = new Books({ dataDir: dir, tempo: { ...caps, payer: tProxy.address } });
  assert.deepEqual(b.refundClaim("p1", "tempo", "2026-10-01", tAgent.address, 13_000n, now), { ok: true });
  b.refundResult("p1", { status: "sent", tx: "0xabc", feePaid: "31" }, now);
  assert.deepEqual(b.refundClaim("p1", "tempo", "2026-10-01", tAgent.address, 13_000n, now), { ok: false, reason: "already_refunded" });
  assert.deepEqual(b.refundClaim("p2", "tempo", "2026-10-01", tAgent.address, 105_001n, now), { ok: false, reason: "refund_over_cap" });
  assert.equal(b.tempoRefundOutflow("2026-10-01"), 13_031n);
  const b2 = new Books({ dataDir: dir, tempo: { ...caps, payer: tProxy.address } });
  assert.deepEqual(b2.refundClaim("p1", "tempo", "2026-10-01", tAgent.address, 13_000n, now), { ok: false, reason: "already_refunded" });
  // daily cap: 200_000 per day; 13_000 already out
  assert.deepEqual(b2.refundClaim("p3", "tempo", "2026-10-01", tAgent.address, 100_000n, now), { ok: true });
  assert.deepEqual(b2.refundClaim("p4", "tempo", "2026-10-01", tAgent.address, 100_000n, now), { ok: false, reason: "daily_refund_cap_reached" });
  assert.deepEqual(b2.refundClaim("p5", "tempo", "2026-10-02", tAgent.address, 100_000n, now), { ok: true });
  // a pending refund (no result yet) counts with the fee reserve
  assert.equal(b2.tempoRefundOutflow("2026-10-01"), 13_031n + 100_000n + 2_000n);
});

test("solana refund: exactly one USDC transfer to the agent's account, read back before it is sent, confirmed on chain", async () => {
  const sent: string[] = [];
  const rpc = async (method: string, params: unknown[]) => {
    if (method === "getLatestBlockhash") return { value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10 } };
    if (method === "sendTransaction") {
      sent.push(String(params[0]));
      return "sig";
    }
    if (method === "getTransaction") {
      return {
        meta: {
          err: null,
          preBalances: [0],
          postBalances: [0],
          preTokenBalances: [{ owner: agent.address, mint: USDC_MINT, uiTokenAmount: { amount: "100" } }],
          postTokenBalances: [{ owner: agent.address, mint: USDC_MINT, uiTokenAmount: { amount: "15100" } }],
        },
        transaction: { message: { accountKeys: [{ pubkey: proxyPayer.address, signer: true, writable: true }], instructions: [] } },
      };
    }
    throw new Error(`unhandled ${method}`);
  };
  const out = await sendSolanaRefund({ rpc, signer: proxyPayer, sleep: async () => undefined }, agent.address, 15_000n);
  assert.equal(out.status, "sent");
  assert.equal(sent.length, 1);
  assert.equal(await checkSolanaRefundTx(sent[0]!, { payer: proxyPayer.address, to: agent.address, amount: 15_000n }), null);
  assert.match((await checkSolanaRefundTx(sent[0]!, { payer: proxyPayer.address, to: agent.address, amount: 15_001n }))!, /amount/);
  assert.match((await checkSolanaRefundTx(sent[0]!, { payer: proxyPayer.address, to: SELLER, amount: 15_000n }))!, /destination/);
  // to itself, or an off-curve address: refused before anything is built
  assert.equal((await sendSolanaRefund({ rpc, signer: proxyPayer }, proxyPayer.address, 15_000n)).status, "failed");
  // an RPC that cannot give a blockhash: failed, nothing sent
  const down = async () => {
    throw new Error("https://rpc.example.test/?api-key=SECRET");
  };
  const f = await sendSolanaRefund({ rpc: down, signer: proxyPayer }, agent.address, 15_000n);
  assert.deepEqual(f, { status: "failed", reason: "rpc_error", tx: null });
});

test("reasons: URLs and credentials are removed; only offer-level refusal details are shown", () => {
  assert.equal(redact("POST https://rpc.x.test/v2/abc?api-key=K failed"), "POST <url> failed");
  assert.equal(redact("token=abc123 bad"), "token=<redacted> bad");
  assert.equal(refusalReason({ refused: "price_raised", detail: "amount 12000 > recorded 10000" }), "price_raised: amount 12000 > recorded 10000");
  assert.equal(refusalReason({ refused: "ledger_unreadable", detail: "cannot read balances: https://rpc/KEY" }), "ledger_unreadable");
  assert.equal(refusalReason({ refused: "tx_check_failed", detail: "payload not created: https://rpc/KEY" }), "tx_check_failed");
});
