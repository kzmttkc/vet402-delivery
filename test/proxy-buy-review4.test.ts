/**
 * Fourth review: its reproductions (R1 to R5), now asserting the fixed behaviour, and the smaller items.
 *   R1  the window's upper end is the slot of the first answer that said the blockhash expired, kept with the facts:
 *       later traffic on the account is skipped unread, so the purchase is decided (landed or dead).
 *   R2  a getSlot answer behind the node that answers isBlockhashValid cannot hide a landed payment; "dead" needs a
 *       second look DEAD_CONFIRM_SLOTS later; the reads ask for an answer at least as recent as the slot read first.
 *   R3  a refund waiting for the next UTC day's account creations is not a failure and is tried again that day.
 *   R4  a floor raise leaves out what recently closed purchases, and delivered purchases whose seller payment is
 *       not seen yet, may still take out of the wallet.
 *   R5  once vet402's payment to the seller is decidable, the seller is served again.
 * Also: refunds are looked up by their signature; the run's read budget; a search cut short is looked at again
 * later; the agent's settled transaction must be the one it signed; Tempo off means nothing Tempo is built.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSigner } from "@solana/kit";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Rpc } from "../src/chain.js";
import { USDC_MINT } from "../src/constants.js";
import { configFromEnv } from "../src/proxy-buy/config.js";
import { DEAD_CONFIRM_SLOTS, decodeSolanaTx, solanaTxFate } from "../src/proxy-buy/fate.js";
import { ACCOUNT_CREATION_WAIT, refundAgent, sendSolanaRefund } from "../src/proxy-buy/refund.js";
import { Store } from "../src/proxy-buy/store.js";
import { buildProxyBuy, confirmSolanaTransfer } from "../src/proxy-buy/wire.js";
import { agent, agentPaysSolana, allowlist, PAYER_ATA, paidReq, proxyPayer, RECEIVE, SELLER, SELLER_FAC, solRig, testSql, transferTx, VET_FAC } from "./proxy-buy-fakes.js";

/**
 * A chain seen through one RPC: `later` signatures after the landing (newest first), then vet402's (if it landed),
 * then history. isBlockhashValid answers from a node at `slotNow`; getSlot may come from a node behind it.
 */
async function chainRpc(o: { mineTx: string | null; mineSlot: number; later: number; laterFrom: number; slotNow: number; valid: boolean; laggingSlot?: number }) {
  const other = await generateKeyPairSigner();
  const foreign = await transferTx(other, SELLER_FAC, SELLER, 1n, "ffffffffffffffffffffffffffffffff");
  const now = Math.floor(Date.now() / 1000);
  const sigs = [
    ...Array.from({ length: o.later }, (_, i) => ({ signature: `later${i}`, slot: o.laterFrom - i, blockTime: now })),
    ...(o.mineTx ? [{ signature: "MINE", slot: o.mineSlot, blockTime: now }] : []),
    ...Array.from({ length: 20 }, (_, i) => ({ signature: `old${i}`, slot: 10 - i, blockTime: now - 10_000 })),
  ];
  const calls: Record<string, number> = {};
  const minContext: unknown[] = [];
  const rpc: Rpc = async (method, params) => {
    calls[method] = (calls[method] ?? 0) + 1;
    if (method === "getSignaturesForAddress") {
      const p = (params as [string, { limit: number; before?: string; minContextSlot?: number }])[1];
      minContext.push(p.minContextSlot);
      const start = p.before ? sigs.findIndex((s) => s.signature === p.before) + 1 : 0;
      return sigs.slice(start, start + p.limit);
    }
    if (method === "getTransaction") {
      const sig = (params as [string])[0];
      return { meta: { err: null }, transaction: [sig === "MINE" ? o.mineTx : foreign, "base64"] };
    }
    if (method === "isBlockhashValid") return { context: { slot: o.slotNow }, value: o.valid };
    if (method === "getSlot") return o.laggingSlot ?? o.slotNow;
    throw new Error(method);
  };
  return { rpc, calls, minContext };
}

test("zz4-R1: a landed seller payment behind 250 later signatures is found; one that never landed is 'dead' on the second look", async () => {
  const tx = await transferTx(proxyPayer, SELLER_FAC, SELLER, 10_000n);
  const mine = decodeSolanaTx(tx)!;
  const q = { messageHash: mine.messageHash, blockhash: mine.blockhash, account: PAYER_ATA, minSlot: 1000 };
  // first look right after expiry (slot 1100): the window's upper end is kept
  const first = await chainRpc({ mineTx: null, mineSlot: 0, later: 5, laterFrom: 1090, slotNow: 1100, valid: false });
  assert.deepEqual(await solanaTxFate(first.rpc, q), { fate: "pending", expiredSlot: 1100 });
  // a later look, after 250 more signatures on the account (slots above 1100): skipped unread -> decided
  const dead = await chainRpc({ mineTx: null, mineSlot: 0, later: 250, laterFrom: 5000, slotNow: 5000, valid: false });
  assert.deepEqual(await solanaTxFate(dead.rpc, { ...q, expiredSlot: 1100 }), { fate: "dead" });
  assert.equal(dead.calls.getTransaction ?? 0, 0, "nothing above the window is read");
  const landed = await chainRpc({ mineTx: tx, mineSlot: 1005, later: 250, laterFrom: 5000, slotNow: 5000, valid: false });
  assert.deepEqual(await solanaTxFate(landed.rpc, { ...q, expiredSlot: 1100 }), { fate: "landed", tx: "MINE" });
  assert.equal(landed.calls.getTransaction, 1);
  // and 400 more later: still decided
  const later = await chainRpc({ mineTx: null, mineSlot: 0, later: 400, laterFrom: 9000, slotNow: 9000, valid: false });
  assert.deepEqual(await solanaTxFate(later.rpc, { ...q, expiredSlot: 1100 }), { fate: "dead" });
});

test("zz4-R2: getSlot from a node behind -> the landed payment is still found (the window ends at the slot of the answer that said 'expired')", async () => {
  const tx = await transferTx(proxyPayer, SELLER_FAC, SELLER, 10_000n);
  const mine = decodeSolanaTx(tx)!;
  const q = { messageHash: mine.messageHash, blockhash: mine.blockhash, account: PAYER_ATA, minSlot: 1000 };
  const r = await chainRpc({ mineTx: tx, mineSlot: 1150, later: 0, laterFrom: 0, slotNow: 1160, valid: false, laggingSlot: 1140 });
  assert.deepEqual(await solanaTxFate(r.rpc, q), { fate: "landed", tx: "MINE" });
  assert.deepEqual(r.minContext, [1140], "the signature list is asked for an answer at least as recent as the slot read first");
  // not landed: the first look never says "dead"; a look DEAD_CONFIRM_SLOTS later does
  const none = await chainRpc({ mineTx: null, mineSlot: 0, later: 0, laterFrom: 0, slotNow: 1160, valid: false, laggingSlot: 1140 });
  assert.deepEqual(await solanaTxFate(none.rpc, q), { fate: "pending", expiredSlot: 1160 });
  const soon = await chainRpc({ mineTx: null, mineSlot: 0, later: 0, laterFrom: 0, slotNow: 1160 + DEAD_CONFIRM_SLOTS - 1, valid: false });
  assert.equal((await solanaTxFate(soon.rpc, { ...q, expiredSlot: 1160 })).fate, "pending");
  const after = await chainRpc({ mineTx: null, mineSlot: 0, later: 0, laterFrom: 0, slotNow: 1160 + DEAD_CONFIRM_SLOTS, valid: false });
  assert.deepEqual(await solanaTxFate(after.rpc, { ...q, expiredSlot: 1160 }), { fate: "dead" });
});

test("zz4-R2: a refund (vet402 paid its fee) is looked up by its signature over the whole history, not searched", async () => {
  let status: { err: unknown; confirmationStatus: string } | null = null;
  let slot = 500;
  const calls: string[] = [];
  const rpc: Rpc = async (method) => {
    calls.push(method);
    if (method === "getSlot") return slot;
    if (method === "getSignatureStatuses") return { context: { slot }, value: [status] };
    if (method === "isBlockhashValid") return { context: { slot }, value: false };
    throw new Error(method);
  };
  const q = { signature: "REFUNDSIG", messageHash: "m", blockhash: "b", account: PAYER_ATA };
  assert.deepEqual(await solanaTxFate(rpc, q), { fate: "pending", expiredSlot: 500 });
  slot = 500 + DEAD_CONFIRM_SLOTS;
  assert.deepEqual(await solanaTxFate(rpc, { ...q, expiredSlot: 500 }), { fate: "dead" });
  status = { err: null, confirmationStatus: "confirmed" };
  assert.deepEqual(await solanaTxFate(rpc, { ...q, expiredSlot: 500 }), { fate: "landed", tx: "REFUNDSIG" });
  assert.ok(!calls.includes("getSignaturesForAddress") && !calls.includes("getTransaction"));
});

test("zz4-R1: one reconcile run reads at most its budget of transactions", async () => {
  const tx = await transferTx(proxyPayer, SELLER_FAC, SELLER, 10_000n);
  const mine = decodeSolanaTx(tx)!;
  const r = await chainRpc({ mineTx: null, mineSlot: 0, later: 50, laterFrom: 1090, slotNow: 1200, valid: false });
  const budget = { reads: 3 };
  const f = await solanaTxFate(r.rpc, { messageHash: mine.messageHash, blockhash: mine.blockhash, account: PAYER_ATA, minSlot: 1000, expiredSlot: 1100, budget });
  assert.deepEqual(f, { fate: "pending", capped: "run_budget", expiredSlot: 1100 });
  assert.equal(budget.reads, 0);
  assert.equal(r.calls.getTransaction, 3);
});

test("zz4-R1: a purchase whose search was cut short is looked at again only after a while (and reported)", async () => {
  const r = await solRig({ seller: { paidStatus: 500 }, sellerSettles: false, budgetMs: 300 });
  r.chain.blockhashValid = true;
  const { header } = await agentPaysSolana(r.buy);
  assert.equal((await r.buy.handle(paidReq(header))).status, 502);
  r.side.fate = async () => ({ fate: "pending", capped: "tx_reads" });
  const first = await r.reconcile();
  assert.ok(first.some((a) => a.action.startsWith("ALERT waiting")), JSON.stringify(first));
  const again = await r.reconcile();
  assert.equal(again.length, 0, "not looked at again in the next run");
});

test("zz4-R3: a refund waiting for account creations is not a failure; it is tried again on the next UTC day", async () => {
  const store = new Store(await testSql());
  const d0 = new Date("2026-09-30T01:00:00Z");
  for (let i = 0; i < 10; i++) assert.equal(await store.bump(`refund-account:solana:2026-09-30`, 10, d0), true);
  const to = (await generateKeyPairSigner()).address;
  let sends = 0;
  let reads = 0;
  const rpc: Rpc = async (method) => {
    if (method === "getLatestBlockhash") {
      reads++;
      return { context: { slot: 100 }, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 200 } };
    }
    if (method === "getAccountInfo") return { value: null }; // the agent closed its USDC account
    if (method === "sendTransaction") {
      sends++;
      return "sig";
    }
    throw new Error(method);
  };
  const send = (t: string, a: bigint, b: Parameters<typeof sendSolanaRefund>[3], opts?: Parameters<typeof sendSolanaRefund>[4]) =>
    sendSolanaRefund({ rpc, signer: proxyPayer, timeoutMs: 0, sleep: async () => undefined }, t, a, b, opts);
  const o = { id: "r3", chain: "solana" as const, day: "2026-09-30", to, amount: 15_000n, maxRefund: 105_000n };
  const statuses: string[] = [(await refundAgent(store, send, { ...o, now: () => d0 })).status];
  for (let i = 1; i < 12; i++) statuses.push((await refundAgent(store, send, { ...o, now: () => new Date(d0.getTime() + i * 300_000), retry: true })).status);
  assert.ok(statuses.every((x) => x === "failed"), JSON.stringify(statuses));
  const row = (await store.getRefund("r3"))!;
  assert.deepEqual([row.status, row.reason, row.failures], ["failed", ACCOUNT_CREATION_WAIT, 0]);
  assert.equal(reads, 1, "nothing is tried again the same UTC day");
  // next UTC day: a creation is free again, and the refund is sent
  const next = await refundAgent(store, send, { ...o, now: () => new Date("2026-10-01T02:00:00Z"), retry: true });
  assert.equal(next.status, "unknown", "sent; the reconciler confirms it");
  assert.equal(sends, 1);
});

test("zz4-R4: a seller payment that lands after its purchase closed does not strand later purchases", async () => {
  const store = new Store(await testSql());
  const caps = { cap: 2_000_000n, maxCount: 100, refundCap: 2_000_000n };
  const day = "2026-09-30";
  const t = (s: number) => new Date(Date.parse("2026-09-30T00:00:00Z") + s * 1000);
  const claim = (id: string, at: Date) => store.claim({ id, chain: "solana", target: "https://x.test/", sellerAmount: 10_000n, feeReserve: 0n, total: 15_000n, facts: {}, now: at });
  const admit = (id: string, balance: bigint, at: Date) => store.admit(id, { chain: "solana", payer: "P", day, caps, need: 15_000n, balance, balanceReadAt: at, now: at });
  const rec = { outcome: "delivered" } as never;
  let chain = 1_000_000n;
  // the review's sequence: A closes, B's balance read does not include A's seller payment yet
  assert.ok(await claim("A", t(0)));
  assert.deepEqual(await admit("A", chain, t(0)), { ok: true });
  await store.move("A", ["admitted"], "in_progress", { now: t(1) });
  assert.ok(await store.finish("A", ["in_progress"], { record: rec, spent: 10_000n, now: t(2) }));
  assert.ok(await claim("B", t(3)));
  assert.deepEqual(await admit("B", chain, t(3)), { ok: true });
  chain -= 10_000n; // A's seller payment lands now
  await store.move("B", ["admitted"], "in_progress", { now: t(4) });
  chain -= 10_000n; // B's
  assert.ok(await store.finish("B", ["in_progress"], { record: rec, spent: 10_000n, now: t(5) }));
  for (const [i, id] of ["C", "D", "E"].entries()) {
    assert.ok(await claim(id, t(10 + i)));
    assert.deepEqual(await admit(id, chain, t(10 + i)), { ok: true }, id);
    await store.release(id);
  }
  // the same, with A closed an hour before B but its seller payment still not seen on chain
  const s2 = new Store(await testSql());
  const claim2 = (id: string, at: Date) => s2.claim({ id, chain: "solana", target: "https://x.test/", sellerAmount: 10_000n, feeReserve: 0n, total: 15_000n, facts: {}, now: at });
  const admit2 = (id: string, balance: bigint, at: Date) => s2.admit(id, { chain: "solana", payer: "P", day, caps, need: 15_000n, balance, balanceReadAt: at, now: at });
  chain = 1_000_000n;
  assert.ok(await claim2("A", t(0)));
  assert.deepEqual(await admit2("A", chain, t(0)), { ok: true });
  await s2.move("A", ["admitted"], "in_progress", { now: t(1) });
  assert.ok(await s2.finish("A", ["in_progress"], { record: rec, spent: 10_000n, sellerOpen: true, now: t(2) }));
  assert.ok(await claim2("B", t(3600)));
  assert.deepEqual(await admit2("B", chain, t(3600)), { ok: true });
  assert.equal((await s2.wallet("solana"))!.floor, 975_000n, "the floor was not raised past A's open seller payment");
  chain -= 10_000n; // A's lands
  await s2.move("B", ["admitted"], "in_progress", { now: t(3601) });
  chain -= 10_000n;
  assert.ok(await s2.finish("B", ["in_progress"], { record: rec, spent: 10_000n, now: t(3602) }));
  assert.ok(await s2.sellerSeen("A", null));
  assert.ok(await claim2("C", t(7200)));
  assert.deepEqual(await admit2("C", chain, t(7200)), { ok: true });
  await s2.release("C");
  // a top-up once nothing is open or recent raises the floor again
  chain += 500_000n;
  assert.ok(await claim2("D", t(9000)));
  assert.deepEqual(await admit2("D", chain, t(9000)), { ok: true });
  assert.equal((await s2.wallet("solana"))!.floor, chain - 15_000n);
});

test("zz4-R4: a delivered purchase whose seller payment was not seen is closed 'seller open'; the reconciler clears it once decided", async () => {
  const r = await solRig({ sellerSettles: false, budgetMs: 300 });
  r.chain.blockhashValid = true; // not seen, can still land
  const { header } = await agentPaysSolana(r.buy);
  const res = await r.buy.handle(paidReq(header));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-vet402-seller-settled"), "unknown");
  const open = async () => (await r.sql.query<{ seller_open: boolean }>(`select seller_open from pb_purchase`)).rows[0]!.seller_open;
  assert.equal(await open(), true);
  r.chain.blockhashValid = false;
  const acts = await r.reconcile();
  assert.ok(acts.some((a) => a.action === "seller payment seen: dead"), JSON.stringify(acts));
  assert.equal(await open(), false);
});

test("zz4-R5: once vet402's payment to the seller is decidable, the seller is served again", async () => {
  const r = await solRig({ seller: { paidStatus: 500 }, sellerSettles: false, budgetMs: 300, staleMs: 0 });
  r.chain.blockhashValid = true;
  const first = await agentPaysSolana(r.buy);
  assert.equal((await r.buy.handle(paidReq(first.header))).status, 502);
  r.seller.paidStatus = 200;
  r.chain.blockhashValid = false; // vet402's payment to the seller is dead: the reconciler refunds
  const acts = await r.reconcile();
  assert.ok(acts.some((a) => a.action === 'refund: "sent"'), JSON.stringify(acts));
  const second = await agentPaysSolana(r.buy, undefined, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  const res = await r.buy.handle(paidReq(second.header));
  assert.notEqual(res.status, 503);
  assert.notEqual(((await res.clone().json().catch(() => ({}))) as { reason?: string }).reason, "reconcile_pending");
});

test("zz4-low: the agent's settled transaction must be the one it signed (message hash)", async () => {
  const mineTx = await transferTx(agent, VET_FAC, RECEIVE, 15_000n);
  const otherTx = await transferTx(agent, VET_FAC, RECEIVE, 15_000n, "abababababababababababababababab");
  const bal = (owner: string, amount: string) => ({ owner, mint: USDC_MINT, uiTokenAmount: { amount } });
  const rpcFor = (b64: string): Rpc => async (m) => {
    if (m !== "getTransaction") throw new Error(m);
    return { meta: { err: null, preTokenBalances: [bal(agent.address, "100000"), bal(RECEIVE, "0")], postTokenBalances: [bal(agent.address, "85000"), bal(RECEIVE, "15000")] }, transaction: [b64, "base64"] };
  };
  const hash = decodeSolanaTx(mineTx)!.messageHash;
  assert.deepEqual(await confirmSolanaTransfer(rpcFor(mineTx), "SIG", agent.address, RECEIVE, 15_000n, { messageHash: hash, timeoutMs: 0 }), { ok: true, payer: agent.address });
  assert.deepEqual(await confirmSolanaTransfer(rpcFor(otherTx), "SIG", agent.address, RECEIVE, 15_000n, { messageHash: hash, timeoutMs: 0 }), {
    ok: false,
    detail: "customer_tx_not_the_signed_payment",
    definite: false,
  });
});

test("zz4-low: with the Tempo flag off, nothing Tempo is built (neither requests nor the reconciler touch it)", async () => {
  const env = {
    VET402_PROXY_TEMPO_RECEIVE: privateKeyToAccount(generatePrivateKey()).address,
    VET402_PROXY_TEMPO_PAYER_KEY: "",
    VET402_PROXY_TEMPO_PAYER: "",
    VET402_PROXY_MPP_SECRET: "s".repeat(40),
  };
  const key = generatePrivateKey();
  env.VET402_PROXY_TEMPO_PAYER_KEY = key;
  env.VET402_PROXY_TEMPO_PAYER = privateKeyToAccount(key).address;
  const off = await buildProxyBuy(configFromEnv(env), { dataDir: "data", sql: await testSql(), allowlist });
  assert.equal(off.tempo, undefined);
  const on = await buildProxyBuy(configFromEnv({ ...env, VET402_PROXY_TEMPO_ENABLED: "1" }), { dataDir: "data", sql: await testSql(), allowlist });
  assert.ok(on.tempo);
});
