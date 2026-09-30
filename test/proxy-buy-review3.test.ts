/**
 * Third review: the attacks it reproduced, now asserting the fixed behaviour.
 *  Solana
 *   S1. a flood of signatures on the searched account: bounded reads, a slot window, a deadline, "pending" with
 *       `capped` (never "dead" on a partial read), and an ALERT from the reconciler.
 *   S2. a refund to an off-curve owner is built and sent; a refund that can never be built is "stuck" at once, and
 *       failures before sending are counted until "stuck".
 *   S3. the seller's PAYMENT-RESPONSE names an earlier settled payment: ignored; vet402's own payment decides.
 *   SOL for refunds is reserved across open purchases.
 *  Tempo (off by default)
 *   A.  two concurrent purchases at one price: one's unpaid seller payment is never taken for the other's.
 *   B.  a credential with no validBefore (or one far ahead) is refused before anything is claimed.
 *   B2. undecidable rows no longer hide a newer purchase that owes a refund; long-open rows are reported.
 *   An answer whose first chunk passes the read cap is "too large", not "empty".
 *  Both: the request limit is counted in the database; a transaction found on chain belongs to one purchase.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSigner, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { encodePaymentResponseHeader } from "@x402/core/http";
import { Credential } from "mppx";
import type { Hex } from "viem";
import { Transaction } from "viem/tempo";
import { waitForSettlement, type Rpc } from "../src/chain.js";
import { SOLANA_MAINNET, USDC_MINT } from "../src/constants.js";
import { usdcAta } from "../src/txcheck.js";
import { signerFor } from "../src/tempo/chain.js";
import { configFromEnv } from "../src/proxy-buy/config.js";
import { BUY_FEE_ATOMIC } from "../src/proxy-buy/constants.js";
import { decodeSolanaTx, decodeTempoTx, SOLANA_FATE_MAX_TX_READS, solanaTxFate } from "../src/proxy-buy/fate.js";
import { createProxyBuy } from "../src/proxy-buy/handler.js";
import { checkSolanaRefundTx, refundAgent, sendSolanaRefund } from "../src/proxy-buy/refund.js";
import { REFUND_SOL_MIN_LAMPORTS } from "../src/proxy-buy/solana.js";
import { MAX_REFUND_FAILURES_BEFORE_SEND, Store } from "../src/proxy-buy/store.js";
import {
  agent,
  agentPaysSolana,
  agentPaysTempo,
  allowlist,
  buyUrl,
  CAPS,
  ORIGIN,
  PAYER_ATA,
  paidReq,
  proxyPayer,
  S_URL,
  SELLER,
  solRig,
  T_RECEIVE,
  T_SELLER,
  T_URL,
  tAgent,
  testSql,
  tPaid,
  tProxy,
  transferTx,
  tRig,
} from "./proxy-buy-fakes.js";

// ---------------- Solana ----------------

async function floodRpc(o: { sigs: { signature: string; slot?: number; blockTime?: number }[]; valid: boolean; slotNow: number }) {
  const other = await generateKeyPairSigner();
  const foreign = await transferTx(other, other.address, SELLER, 1n, "ffffffffffffffffffffffffffffffff");
  const calls: Record<string, number> = {};
  const rpc: Rpc = async (method, params) => {
    calls[method] = (calls[method] ?? 0) + 1;
    if (method === "getSignaturesForAddress") {
      const p = (params as [string, { limit: number; before?: string }])[1];
      const start = p.before ? o.sigs.findIndex((s) => s.signature === p.before) + 1 : 0;
      return o.sigs.slice(start, start + p.limit);
    }
    if (method === "getTransaction") return { meta: { err: null }, transaction: [foreign, "base64"] };
    if (method === "getEpochInfo") return { absoluteSlot: o.slotNow, blockHeight: o.valid ? 50 : 1000 }; // last valid height 100 (+300 margin)
    if (method === "getFirstAvailableBlock") return 0;
    if (method === "getSlot") return o.slotNow;
    throw new Error(method);
  };
  return { rpc, calls };
}

test("zz3-S1: 1100 fresh signatures inside the window -> 'pending' capped at the read limit, never 'dead', bounded reads", async () => {
  const mine = decodeSolanaTx(await transferTx(proxyPayer, SELLER, SELLER, 10_000n))!;
  const now = Math.floor(Date.now() / 1000);
  const { rpc, calls } = await floodRpc({ sigs: Array.from({ length: 1100 }, (_, i) => ({ signature: `sig${i}`, slot: 1000 - i / 100, blockTime: now })), valid: false, slotNow: 2000 });
  const f = await solanaTxFate(rpc, { messageHash: mine.messageHash, blockhash: mine.blockhash, account: PAYER_ATA, since: now - 600, minSlot: 900, lastValidBlockHeight: 100 });
  assert.deepEqual(f, { fate: "pending", capped: "tx_reads", expiredSlot: 2000 });
  assert.ok((calls.getTransaction ?? 0) <= SOLANA_FATE_MAX_TX_READS, JSON.stringify(calls));
});

test("zz3-S1: signatures after the blockhash expired are skipped unread; below minSlot the search stops; the deadline stops it", async () => {
  const mine = decodeSolanaTx(await transferTx(proxyPayer, SELLER, SELLER, 10_000n))!;
  const q = { messageHash: mine.messageHash, blockhash: mine.blockhash, account: PAYER_ATA, minSlot: 500, expiredSlot: 800, lastValidBlockHeight: 100, anchor: "old0" };
  // 1100 signatures landed after expiry (slot > 800), then 3 in the window, then history before minSlot
  const sigs = [
    ...Array.from({ length: 1100 }, (_, i) => ({ signature: `late${i}`, slot: 900 })),
    ...Array.from({ length: 3 }, (_, i) => ({ signature: `in${i}`, slot: 700 })),
    ...Array.from({ length: 50 }, (_, i) => ({ signature: `old${i}`, slot: 100 })),
  ];
  const a = await floodRpc({ sigs, valid: false, slotNow: 900 });
  assert.deepEqual(await solanaTxFate(a.rpc, q), { fate: "dead" });
  assert.equal(a.calls.getTransaction, 3, "only the three signatures inside the window are read");
  // still valid: never dead, whatever the history
  const b = await floodRpc({ sigs, valid: true, slotNow: 900 });
  assert.equal((await solanaTxFate(b.rpc, q)).fate, "pending");
  // past the deadline: nothing is read, pending with the reason
  const c = await floodRpc({ sigs, valid: false, slotNow: 900 });
  assert.deepEqual(await solanaTxFate(c.rpc, { ...q, deadline: Date.now() - 1 }), { fate: "pending", capped: "deadline", expiredSlot: 800 });
  assert.equal(c.calls.getTransaction ?? 0, 0);
});

test("zz3-S1: a cut-short search is reported by the reconciler as an ALERT", async () => {
  const r = await solRig({ seller: { paidStatus: 500 }, sellerSettles: false, budgetMs: 300 });
  r.chain.blockhashValid = true; // the seller payment can still land
  const { header } = await agentPaysSolana(r.buy);
  const res = await r.buy.handle(paidReq(header));
  assert.equal(res.status, 502);
  assert.equal(((await res.json()) as { error: string }).error, "seller_payment_pending");
  r.side.fate = async () => ({ fate: "pending", capped: "tx_reads" });
  const acts = await r.reconcile();
  assert.ok(acts.some((a) => a.action.startsWith("ALERT waiting: vet402's payment to the seller can still land; the chain search was cut short (tx_reads)")), JSON.stringify(acts));
  assert.equal(r.refunds.length, 0, "no refund on a partial read");
});

test("zz3-S2: a refund to an off-curve owner (a program-owned vault) is built, checked and sent to ATA(owner)", async () => {
  const pdaOwner = await usdcAta(agent.address); // an off-curve address
  const sent: string[] = [];
  const rpc: Rpc = async (method, params) => {
    if (method === "getLatestBlockhash") return { context: { slot: 5 }, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 10 } };
    if (method === "getSignaturesForAddress") return [];
    if (method === "getAccountInfo") return { value: null };
    if (method === "sendTransaction") {
      sent.push(String((params as unknown[])[0]));
      return "sig";
    }
    if (method === "getTransaction") return null;
    throw new Error(method);
  };
  const out = await sendSolanaRefund({ rpc, signer: proxyPayer, timeoutMs: 0, sleep: async () => undefined }, pdaOwner, 105_000n, async () => true, { mayCreateAccount: async () => true });
  assert.equal(out.status, "unknown", "sent and not confirmed yet: the reconciler decides");
  assert.equal(sent.length, 1);
  assert.equal(await checkSolanaRefundTx(sent[0]!, { payer: proxyPayer.address, to: pdaOwner, amount: 105_000n }), null);
  const msg = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(getBase64Encoder().encode(sent[0]!)).messageBytes);
  assert.equal(msg.instructions.length, 2, "creates ATA(owner), then transfers");
  assert.ok(msg.staticAccounts.map(String).includes(await usdcAta(pdaOwner)));
});

test("zz3-S2: a refund that can never be built is 'stuck' at once; failures before sending are counted until 'stuck'", async () => {
  const store = new Store(await testSql());
  const now = () => new Date();
  const send = (to: string, amount: bigint, bs: Parameters<typeof sendSolanaRefund>[3], o?: Parameters<typeof sendSolanaRefund>[4]) =>
    sendSolanaRefund({ rpc: async () => { throw new Error("https://rpc.example.test/KEY down"); }, signer: proxyPayer }, to, amount, bs, o);
  const bad = await refundAgent(store, send, { id: "p1", chain: "solana", day: "2026-09-30", to: "not-an-address", amount: 105_000n, maxRefund: 105_000n, now });
  assert.deepEqual([bad.status, bad.reason], ["stuck", "refund_to_invalid"]);
  assert.equal((await store.getRefund("p1"))!.status, "stuck");
  // a read that keeps failing: counted, then stuck
  const seen: string[] = [];
  let r = await refundAgent(store, send, { id: "p2", chain: "solana", day: "2026-09-30", to: agent.address, amount: 105_000n, maxRefund: 105_000n, now });
  seen.push(r.status);
  for (let i = 0; i < MAX_REFUND_FAILURES_BEFORE_SEND + 2; i++) {
    r = await refundAgent(store, send, { id: "p2", chain: "solana", day: "2026-09-30", to: agent.address, amount: 105_000n, maxRefund: 105_000n, now, retry: true });
    seen.push(r.status);
  }
  const row = (await store.getRefund("p2"))!;
  assert.equal(row.status, "stuck", JSON.stringify(seen));
  assert.equal(row.failures, MAX_REFUND_FAILURES_BEFORE_SEND);
  assert.equal(row.attempt, 1, "nothing was ever sent");
  assert.equal(seen.at(-1), "stuck");
});

test("zz3-S2: the reconciler reports a stuck refund", async () => {
  const r = await solRig({ seller: { paidStatus: 500 }, sellerSettles: false });
  const { header } = await agentPaysSolana(r.buy);
  r.side.refund = async () => ({ status: "failed", reason: "refund_to_invalid", tx: null, permanent: true });
  const res = await r.buy.handle(paidReq(header));
  const body = (await res.json()) as { error: string; refund: { status: string } };
  assert.equal(body.error, "seller_not_paid");
  assert.equal(body.refund.status, "stuck");
  const acts = await r.reconcile();
  assert.ok(acts.some((a) => a.action.startsWith("ALERT refund stuck")), JSON.stringify(acts));
});

test("zz3-S3: the seller answers 500 naming an earlier settled payment -> ignored; vet402's payment is dead -> refund", async () => {
  const OLD = "5".repeat(88);
  const r = await solRig({
    wrapSeller: (f) =>
      (async (url: string | URL, init?: RequestInit) => {
        const res = await f(url, init);
        if (!new Headers(init?.headers).has("PAYMENT-SIGNATURE")) return res;
        const h = new Headers(res.headers);
        h.set("PAYMENT-RESPONSE", encodePaymentResponseHeader({ success: true, transaction: OLD, network: SOLANA_MAINNET } as never));
        return new Response("upstream error", { status: 500, headers: h }); // this payment was never settled
      }) as unknown as typeof fetch,
  });
  // production waitForSettlement over an RPC that serves the earlier, settled vet402 -> seller transfer under OLD
  const rpc: Rpc = async (method, params) => {
    if (method === "getTransaction" && (params as [string])[0] === OLD) {
      const bal = (owner: string, amount: string) => ({ owner, mint: USDC_MINT, uiTokenAmount: { amount } });
      return {
        meta: { err: null, preBalances: [0], postBalances: [0], preTokenBalances: [bal(proxyPayer.address, "5000000"), bal(SELLER, "0")], postTokenBalances: [bal(proxyPayer.address, "4990000"), bal(SELLER, "10000")] },
        transaction: { message: { accountKeys: [{ pubkey: "fac", signer: true, writable: true }], instructions: [] } },
      };
    }
    return null;
  };
  r.side.pay.waitForSettlement = (sig, memo, payTo) => waitForSettlement({ rpc, signature: sig, memo, payer: proxyPayer.address, payerUsdcAta: PAYER_ATA, payTo, timeoutMs: 500, intervalMs: 10 });
  const { header } = await agentPaysSolana(r.buy);
  const res = await r.buy.handle(paidReq(header));
  const body = (await res.json()) as { error: string; refund: { status: string; amountAtomic: string } };
  const rows = await r.sql.query<{ state: string; record: { outcome: string; sellerPayment: unknown } }>(`select state, record from pb_purchase`);
  assert.equal(res.status, 502);
  assert.equal(body.error, "seller_not_paid");
  assert.equal(body.refund.status, "sent");
  assert.equal(r.refunds.length, 1);
  assert.equal(rows.rows[0]!.state, "done");
  assert.equal(rows.rows[0]!.record.outcome, "seller_not_paid");
  assert.ok(!JSON.stringify(rows.rows[0]!.record).includes(OLD), "the transaction the seller named is not recorded as vet402's payment");
});

test("zz3-S3: a delivered answer records the seller payment found by vet402's own message, not the one the seller names", async () => {
  const r = await solRig({
    wrapSeller: (f) =>
      (async (url: string | URL, init?: RequestInit) => {
        const res = await f(url, init);
        if (!new Headers(init?.headers).has("PAYMENT-SIGNATURE")) return res;
        const h = new Headers(res.headers);
        h.set("PAYMENT-RESPONSE", encodePaymentResponseHeader({ success: true, transaction: "4".repeat(88), network: SOLANA_MAINNET } as never));
        return new Response(await res.arrayBuffer(), { status: 200, headers: h });
      }) as unknown as typeof fetch,
  });
  const { header } = await agentPaysSolana(r.buy);
  const res = await r.buy.handle(paidReq(header));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-vet402-seller-tx"), "sellertx1");
  assert.equal(res.headers.get("x-vet402-seller-settled"), "true");
});

test("zz3-low: SOL for refunds is reserved across open purchases (fee and account rent for each)", async () => {
  const store = new Store(await testSql());
  const now = new Date();
  const base = { chain: "solana" as const, target: S_URL, sellerAmount: 10_000n, feeReserve: 0n, total: 15_000n, facts: {}, now };
  assert.ok(await store.claim({ ...base, id: "a1" }));
  assert.ok(await store.claim({ ...base, id: "a2" }));
  const admit = (id: string) =>
    store.admit(id, { chain: "solana", payer: proxyPayer.address, day: "2026-09-30", caps: CAPS, need: 15_000n, balance: 5_000_000n, lamports: { have: REFUND_SOL_MIN_LAMPORTS * 3n / 2n, perPurchase: REFUND_SOL_MIN_LAMPORTS }, now });
  assert.deepEqual(await admit("a1"), { ok: true });
  const second = await admit("a2");
  assert.equal(second.ok, false);
  assert.equal((second as { reason: string }).reason, "refund_fee_unavailable");
});

// ---------------- Tempo ----------------

test("zz3-A: concurrent same-price purchases -> A's unpaid seller payment is not taken for B's; A is refunded once it is dead", async () => {
  let paid = 0;
  let bMined!: () => void;
  const bMinedP = new Promise<void>((res) => (bMined = res));
  let aAtSeller!: () => void;
  const aAtSellerP = new Promise<void>((res) => (aAtSeller = res));
  const r = await tRig({
    budgetMs: 1_500,
    wrapSeller: (f) =>
      (async (url: string, init?: RequestInit) => {
        const auth = new Headers(init?.headers).get("authorization");
        if (!auth) return f(url, init);
        const n = ++paid;
        if (n === 1) {
          // A: the seller keeps vet402's credential and never broadcasts it; answers 500 once B has settled
          aAtSeller();
          await bMinedP;
          return new Response("busy", { status: 500 });
        }
        const res = await f(url, init); // B: mined, 200
        bMined();
        return res;
      }) as unknown as typeof fetch,
  });
  // the transfer search payOne itself may run, over the fake chain (it finds B's transfer for A)
  (r.side.pay as { findTx?: unknown }).findTx = {
    head: async () => BigInt(r.chain.sent.length),
    search: async (exp: { payer: string; recipient: string; amount: bigint }, from: bigint) =>
      r.chain.sent.slice(Number(from)).filter((s) => s.from === exp.payer.toLowerCase() && s.to === exp.recipient.toLowerCase() && s.amount === exp.amount).map((s) => s.hash),
    tries: 1,
    waitMs: 1,
  };
  const credA = await agentPaysTempo(r);
  const pA = r.buy.handle(tPaid(credA));
  await aAtSellerP;
  const credB = await agentPaysTempo(r);
  const resB = await r.buy.handle(tPaid(credB));
  const resA = await pA;
  assert.equal(resB.status, 200);
  const bodyA = (await resA.json()) as Record<string, unknown>;
  assert.equal(resA.status, 502);
  assert.equal(bodyA.error, "seller_payment_pending", JSON.stringify(bodyA));
  const rows = async () => (await r.sql.query<{ id: string; state: string; record: { outcome: string; sellerPayment: { tx: string | null } | null; refund: unknown } }>(`select id, state, record from pb_purchase order by created_at`)).rows;
  const b = (await rows()).find((x) => x.record?.outcome === "delivered")!;
  const a = (await rows()).find((x) => x.id !== b.id)!;
  assert.equal(a.state, "seller_unsettled");
  assert.notEqual(a.record.sellerPayment?.tx ?? null, b.record.sellerPayment?.tx, "A never takes B's transaction");
  // A's payment to the seller passes its validBefore unbroadcast: dead, so A is refunded (in full, to the agent)
  r.chain.timeShift = 120;
  const acts = await r.reconcile();
  assert.ok(acts.some((x) => x.id === a.id && x.action === 'refund: "sent"'), JSON.stringify(acts));
  const aDone = (await rows()).find((x) => x.id === a.id)!;
  assert.equal(aDone.state, "done");
  assert.equal(aDone.record.outcome, "seller_not_paid");
  const refundsToAgent = r.chain.sent.filter((s) => s.from === tProxy.address.toLowerCase() && s.to === tAgent.address.toLowerCase());
  assert.equal(refundsToAgent.length, 1);
  assert.equal(refundsToAgent[0]!.amount, 8000n + BUY_FEE_ATOMIC);
  assert.equal(r.chain.sent.filter((s) => s.from === tProxy.address.toLowerCase() && s.to === T_SELLER.toLowerCase()).length, 1, "vet402 paid the seller once (for B)");
});

/** A pull credential for vet402's challenge whose transaction has nonce key 7 and the given validBefore (none: omitted). */
async function credentialWith(r: Awaited<ReturnType<typeof tRig>>, validBefore: number | null): Promise<string> {
  const res = await r.buy.handle(new Request(buyUrl(T_URL)));
  assert.equal(res.status, 402);
  const id = /id="([^"]+)"/.exec(res.headers.get("www-authenticate")!)![1]!;
  const { credential } = await signerFor(tAgent, r.rpc).credentialFor(res, id, T_RECEIVE);
  const c = Credential.deserialize<{ signature: string; type: string }>(credential);
  const t = Transaction.deserialize(c.payload.signature as never) as Record<string, unknown>;
  const tx = {
    type: "tempo" as const,
    chainId: t.chainId,
    calls: t.calls,
    nonce: 0,
    nonceKey: 7n,
    gas: t.gas,
    maxFeePerGas: t.maxFeePerGas,
    maxPriorityFeePerGas: t.maxPriorityFeePerGas ?? 0n,
    ...(t.feeToken ? { feeToken: t.feeToken } : {}),
    ...(validBefore !== null ? { validBefore } : {}),
  };
  const signed = (await tAgent.signTransaction!(tx as never, { serializer: Transaction.serialize as never })) as Hex;
  return Credential.serialize({ ...(c as object), payload: { type: "transaction", signature: signed } } as never);
}

test("zz3-B: a credential with no validBefore, or one far ahead, is refused before anything is claimed or broadcast", async () => {
  const r = await tRig({ staleMs: 0 });
  let broadcasts = 0;
  const real = r.side.mpp.broadcastCredential.bind(r.side.mpp);
  r.side.mpp.broadcastCredential = async (c, o) => {
    broadcasts++;
    return real(c, o);
  };
  const none = await credentialWith(r, null);
  assert.equal(decodeTempoTx(Credential.deserialize<{ signature: string }>(none).payload.signature)!.validBefore, null);
  const far = await credentialWith(r, Math.floor(Date.now() / 1000) + 86_400);
  for (const cred of [none, far]) {
    const res = await r.buy.handle(tPaid(cred));
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, 400);
    assert.equal(body.reason, "valid_before_required");
    assert.equal(body.charged, false);
  }
  assert.equal(broadcasts, 0);
  assert.equal(r.chain.sent.length, 0, "no money moved");
  assert.equal((await r.sql.query(`select id from pb_purchase`)).rows.length, 0, "nothing claimed, nothing reserved");
  // an honest agent right after is served
  const ok = await r.buy.handle(tPaid(await agentPaysTempo(r)));
  assert.equal(ok.status, 200);
});

test("zz3-B2: 50 open rows that cannot be decided no longer hide a newer purchase that owes a refund; long-open rows are reported", async () => {
  const r = await tRig({ staleMs: 0 });
  const t0 = Date.now() - 3 * 3_600_000;
  for (let i = 0; i < 50; i++) {
    const id = `stuck${String(i).padStart(27, "0")}`;
    const at = new Date(t0 + i);
    await r.store.claim({ id, chain: "tempo", target: T_URL, sellerHost: `h${i}.test`, agent: `0x${String(i).padStart(40, "0")}`, sellerAmount: 1n, feeReserve: 0n, total: 5001n, now: at,
      facts: { agent: { hash: `0x${"ab".repeat(32)}`, from: `0x${String(i).padStart(40, "0")}`, nonce: "0", nonceKey: "7", validBefore: null, sponsored: false, memo: null } } });
    await r.sql.query(`update pb_purchase set state = 'settling', day = $2, updated_at = $3 where id = $1`, [id, at.toISOString().slice(0, 10), at.toISOString()]);
  }
  // a genuine purchase, newer: the agent paid, vet402 never handed a payment to the seller -> refund owed
  const g = "genuine000000000000000000000000";
  const gAt = new Date(t0 + 60_000);
  await r.store.claim({ id: g, chain: "tempo", target: T_URL, sellerHost: "g.test", agent: tAgent.address, sellerAmount: 8000n, feeReserve: 0n, total: 13000n, now: gAt, facts: { agent: { from: tAgent.address.toLowerCase() }, refundTo: tAgent.address } });
  await r.sql.query(`update pb_purchase set state = 'in_progress', day = $2, updated_at = $3 where id = $1`, [g, gAt.toISOString().slice(0, 10), gAt.toISOString()]);
  const first = await r.reconcile();
  assert.equal(first.filter((a) => a.action.startsWith("waiting")).length, 50);
  assert.equal(first.filter((a) => a.action.startsWith("ALERT open for")).length, 50, "each long-open row is reported");
  const second = await r.reconcile();
  assert.ok(second.some((a) => a.id === g && a.action === 'refund: "sent"'), JSON.stringify(second.filter((a) => a.id === g)));
  assert.equal((await r.store.get(g))!.state, "done");
  assert.equal((await r.store.getRefund(g))!.status, "sent");
});

test("zz3-tempo: an answer whose first chunk alone passes the read cap is 'too large', never an empty answer", async () => {
  const big = new Uint8Array(6 * 1024 * 1024).fill(7);
  const r = await tRig({
    wrapSeller: (f) =>
      (async (url: string, init?: RequestInit) => {
        const res = await f(url, init);
        if (!new Headers(init?.headers).get("authorization")) return res;
        const one = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(big); // one chunk above the cap
            c.close();
          },
        });
        return new Response(one, { status: 200, headers: { "content-type": "application/octet-stream" } });
      }) as unknown as typeof fetch,
  });
  const res = await r.buy.handle(tPaid(await agentPaysTempo(r)));
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 502);
  assert.equal(body.error, "answer_too_large", JSON.stringify(body));
  const rec = (await r.sql.query<{ record: { outcome: string } }>(`select record from pb_purchase`)).rows[0]!.record;
  assert.equal(rec.outcome, "answer_too_large");
});

test("zz3-tempo: Tempo is off unless VET402_PROXY_TEMPO_ENABLED=1: no Tempo price, a Tempo payment gets 503, nothing is written", async () => {
  assert.equal(configFromEnv({}).tempoEnabled, false);
  assert.equal(configFromEnv({ VET402_PROXY_TEMPO_ENABLED: "1" }).tempoEnabled, true);
  const on = await tRig();
  const cred = await agentPaysTempo(on);
  const off = await tRig({ tempoEnabled: false, sql: on.sql });
  const unpaid = await off.buy.handle(new Request(buyUrl(T_URL)));
  assert.equal(unpaid.headers.get("www-authenticate"), null);
  assert.notEqual(unpaid.status, 402);
  const res = await off.buy.handle(tPaid(cred));
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(res.status, 503);
  assert.equal(body.reason, "tempo_disabled");
  assert.equal(body.charged, false);
  assert.equal((await off.sql.query(`select id from pb_purchase`)).rows.length, 0);
  assert.equal(on.chain.sent.length, 0);
});

// ---------------- both ----------------

test("zz3-low: the request limit is counted in the database, across instances", async () => {
  const sql = await testSql();
  const make = () =>
    createProxyBuy({
      enabled: true,
      publicOrigin: ORIGIN,
      feeAtomic: BUY_FEE_ATOMIC,
      allowlist,
      store: new Store(sql),
      caps: {},
      maxRefund: 105_000n,
      quoteDeps: { fetchImpl: fetch, ownAddresses: [], solanaPayer: null, tempoPayer: null },
      quotesPerMinute: 2,
    });
  const [one, two] = [make(), make()];
  const req = () => new Request(`${ORIGIN}/v1/buy`, { headers: { "x-real-ip": "203.0.113.9" } });
  assert.notEqual((await one.handle(req())).status, 429);
  assert.notEqual((await two.handle(req())).status, 429);
  assert.equal((await one.handle(req())).status, 429, "the third request in the minute is refused by the other instance's count");
  const other = new Request(`${ORIGIN}/v1/buy`, { headers: { "x-real-ip": "203.0.113.10" } });
  assert.notEqual((await two.handle(other)).status, 429);
  const keys = (await sql.query<{ key: string }>(`select key from pb_counter`)).rows.map((x) => x.key);
  assert.ok(keys.every((k) => !k.includes("203.0.113")), "addresses are stored hashed");
});

test("zz3-C1: a transaction found on chain belongs to one purchase only", async () => {
  const store = new Store(await testSql());
  const now = new Date();
  assert.equal(await store.bindTx("tempo", "0xAB", "p1", "seller", now), true);
  assert.equal(await store.bindTx("tempo", "0xab", "p1", "seller", now), true, "the same purchase again");
  assert.equal(await store.bindTx("tempo", "0xab", "p2", "seller", now), false);
  assert.deepEqual(await store.knownTxs("tempo", "p2", new Date(now.getTime() - 1000)), ["0xab"]);
  assert.deepEqual(await store.knownTxs("tempo", "p1", new Date(now.getTime() - 1000)), []);
});
