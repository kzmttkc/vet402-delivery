/**
 * The second independent review's reproductions (zz2-*), turned into checks of the fixed behaviour. Postgres runs
 * in process (PGlite); test/proxy-buy-pg.test.ts runs the concurrency ones against a real server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, custom, decodeFunctionData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { tempo as tempoChain } from "viem/chains";
import { Abis, Transaction } from "viem/tempo";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { solanaTxFate, tempoTxFate, decodeSolanaTx } from "../src/proxy-buy/fate.js";
import { reconcile } from "../src/proxy-buy/reconcile.js";
import { sendTempoRefund } from "../src/proxy-buy/refund.js";
import { solanaPaymentKey } from "../src/proxy-buy/solana.js";
import { Store } from "../src/proxy-buy/store.js";
import { tempoReads } from "../src/proxy-buy/wire.js";
import { TEMPO_MAINNET_CHAIN_ID, USDC_E } from "../src/tempo/constants.js";
import { agent, agentPaysSolana, PAYER_ATA, paidReq, RECEIVE, S_URL, solRig, testSql, transferTx, VET_FAC } from "./proxy-buy-fakes.js";

type J = Record<string, any>;

test("zz2-premise solana: a listed signature whose transaction the RPC does not serve yet is not proof of absence -> pending", async () => {
  const tx = await transferTx(agent, VET_FAC, RECEIVE, 15_000n);
  const d = decodeSolanaTx(tx)!;
  const rpc = async (m: string) => {
    if (m === "getSignaturesForAddress") return [{ signature: "LANDEDSIG" }, { signature: "other" }];
    if (m === "getTransaction") return null; // node behind: the transaction DID land, it is in the list
    if (m === "isBlockhashValid") return { value: false };
    throw new Error("unexpected " + m);
  };
  assert.deepEqual(await solanaTxFate(rpc as never, { messageHash: d.messageHash, blockhash: d.blockhash, account: "acct" }), { fate: "pending" });
});

test("zz2-premise tempo: a receipt read error (RPC 503) is not 'no receipt' -> pending", async () => {
  let n = 0;
  const client = {
    getTransactionReceipt: async () => {
      n++;
      throw new Error("HTTP 503 upstream https://rpc.example/key=SECRET");
    },
    getBlock: async () => ({ timestamp: 10_000n }),
    getTransactionCount: async () => 8,
  };
  const reads = tempoReads("http://127.0.0.1:1", client as never);
  const facts = { hash: "0x" + "ab".repeat(32), from: "0x" + "11".repeat(20), nonce: "7", nonceKey: "0", validBefore: "9000", sponsored: false, memo: null };
  assert.deepEqual(await tempoTxFate(reads, facts), { fate: "pending" });
  assert.ok(n >= 1);
  // a real "not found" is still an answer
  const notFound = Object.assign(new Error("not found"), { name: "TransactionReceiptNotFoundError" });
  const reads2 = tempoReads("http://127.0.0.1:1", { ...client, getTransactionReceipt: async () => { throw notFound; } } as never);
  assert.equal(await reads2.receipt("0xab"), null);
});

test("zz2-tempo-refund: the refund is one USDC.e transfer to the agent, and its facts carry a transfer search", async () => {
  const acct = privateKeyToAccount(generatePrivateKey());
  const to = privateKeyToAccount(generatePrivateKey()).address;
  let raw: Hex | null = null;
  const client = createClient({
    chain: tempoChain,
    transport: custom({
      async request({ method, params }: { method: string; params?: unknown[] }) {
        switch (method) {
          case "eth_chainId":
            return "0x1079";
          case "eth_call":
            return "0x";
          case "eth_estimateGas":
            return "0xc350";
          case "eth_getBlockByNumber":
            return { number: "0x10", timestamp: "0x68000000", baseFeePerGas: "0x1", hash: "0x" + "11".repeat(32), transactions: [] };
          case "eth_getTransactionCount":
            return "0x7";
          case "eth_sendRawTransactionSync":
            raw = (params as [Hex])[0];
            throw new Error("not sending in review");
        }
        throw new Error("unexpected " + method);
      },
    }),
  });
  let facts: J | null = null;
  await sendTempoRefund({ account: acct, client, verify: async () => ({ settled: false, detail: "receipt not found", feePaid: null }) }, to, 105_000n, async (f) => ((facts = f), true));
  const t = Transaction.deserialize(raw! as never) as J;
  const call = decodeFunctionData({ abi: Abis.tip20, data: t.calls[0].data });
  assert.equal(t.chainId, TEMPO_MAINNET_CHAIN_ID);
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].to.toLowerCase(), USDC_E.toLowerCase());
  assert.equal(String(call.args![0]).toLowerCase(), to.toLowerCase());
  assert.equal(call.args![1], 105_000n);
  assert.deepEqual(facts!.facts.search, { recipient: to.toLowerCase(), amount: "105000", fromBlock: "16" });
});

test("zz2-refundcap: with the default caps, 21 purchases whose seller never settles -> every one admitted is refunded, the rest refused before any charge", async () => {
  const r = await solRig({ seller: { price: 100_000n, paidStatus: 500, paidBody: "boom" }, sellerSettles: false, balance: 10_000_000n });
  const statuses: number[] = [];
  for (let i = 0; i < 21; i++) {
    const memo = i.toString(16).padStart(2, "0").repeat(16);
    const { header } = await agentPaysSolana(r.buy, S_URL, memo);
    const res = await r.buy.handle(paidReq(header));
    statuses.push(res.status);
    const b = (await res.json()) as J;
    if (res.status === 502) assert.equal(b.refund.status, "sent");
    else assert.equal(b.charged, false);
  }
  const rows = (await r.sql.query<J>(`select state, record->'refund'->>'status' as rs from pb_purchase`)).rows;
  assert.equal(rows.filter((x) => x.rs === "refused").length, 0, "no paid purchase is left without its refund");
  assert.equal(rows.filter((x) => x.state !== "done").length, 0);
  assert.equal(r.refunds.length, statuses.filter((s) => s === 502).length);
  assert.ok(statuses.includes(503), "the day's refund room runs out before a charge, not after");
  assert.deepEqual(await r.reconcile(), []);
});

test("zz2-stuck: settle answers success:false with a signature that never lands -> the agent's own transaction decides (dead: no charge); the next request goes through", async () => {
  const r = await solRig({ staleMs: 0 });
  (r.fac as J).settle = async (_p: unknown, req: J) => ({ success: false, errorReason: "transaction_confirmation_timeout", transaction: "DROPPEDSIG", network: req.network });
  r.state.confirm = "timeout";
  const { header } = await agentPaysSolana(r.buy);
  const first = await r.buy.handle(paidReq(header));
  assert.equal(first.status, 502);
  const acts = await r.reconcile();
  assert.deepEqual(acts.map((a) => a.action), ["closed: agent payment dead, no charge"]);
  r.state.confirm = "ok";
  const { header: h2 } = await agentPaysSolana(r.buy, S_URL, "ab".repeat(16));
  const fresh = await solRig({ sql: r.sql, staleMs: 0 });
  const res2 = await fresh.buy.handle(paidReq(h2));
  assert.equal(res2.status, 200);
});

test("H2: a purchase that cannot be settled yet holds up only the same agent and the same seller", async () => {
  const r = await solRig({ sellerSettles: false, seller: { paidStatus: 402, paidBody: "{}" }, staleMs: 0 });
  r.chain.blockhashValid = true; // vet402's payment to the seller can still land: the purchase stays open
  const a = await agentPaysSolana(r.buy, S_URL, "a1".repeat(16));
  assert.equal(((await (await r.buy.handle(paidReq(a.header))).json()) as J).error, "seller_payment_pending");
  const b = await agentPaysSolana(r.buy, S_URL, "a2".repeat(16));
  const rb = await r.buy.handle(paidReq(b.header));
  assert.equal(rb.status, 503);
  assert.equal(((await rb.json()) as J).reason, "reconcile_pending");
  // the same database, another seller host for this agent is still held (same agent); a different agent and seller is not
  const n = await r.store.blockingFor(new Date(), 0, { agent: "someone-else", host: "other.test" });
  assert.equal(n, 0);
  assert.equal(await r.store.blockingFor(new Date(), 0, { agent: agent.address, host: "other.test" }), 1);
  assert.equal(await r.store.blockingFor(new Date(), 0, { agent: "someone-else", host: "seller.test" }), 1);
});

test("H1: four reconcilers at once on a refund whose first attempt is proven dead -> exactly one new refund", async () => {
  const sql = await testSql();
  const s = new Store(sql);
  const now = new Date("2026-09-30T00:00:00Z");
  const day = "2026-09-30";
  const caps = { cap: 500_000n, maxCount: 3, refundCap: 300_000n };
  await s.claim({ id: "d1", chain: "solana", target: "https://x.test/", sellerAmount: 100_000n, feeReserve: 0n, total: 105_000n, facts: {}, now });
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
  const rf = await s.getRefund("d1");
  assert.equal(rf!.status, "sent");
  assert.equal(rf!.attempt, 2);
  assert.equal((await s.get("d1"))!.state, "done");
});

test("H3: a refund that keeps dying stops after the attempt limit and is reported as stuck", async () => {
  const r = await solRig({ seller: { onRead: (n, s) => void (n === 3 && (s.price = 12_000n)) } });
  r.state.refund = "unknown"; // never lands; its blockhash expires (dead) each time
  const { header } = await agentPaysSolana(r.buy);
  await r.buy.handle(paidReq(header));
  const id = solanaPaymentKey(decodePaymentSignatureHeader(header));
  const seen: string[] = [];
  // each run an hour later than the last (a run marks what it touched with its own time)
  for (let i = 0; i < 5; i++) seen.push(...(await r.reconcile({ now: new Date(Date.now() + 3_600_000 * (i + 2)) })).map((a) => a.action));
  const rf = await r.store.getRefund(id);
  assert.equal(rf!.status, "stuck");
  assert.equal(rf!.attempt, 3);
  assert.ok(seen.some((a) => a.startsWith("ALERT refund stuck")));
  assert.equal((await r.store.get(id))!.state, "refund_pending", "still owed; not closed as refunded");
});
