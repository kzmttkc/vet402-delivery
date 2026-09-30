/**
 * Sixth review: its reproductions and the other items, now asserting the fixed behaviour.
 *   R1/S1  the recorded last valid block height can be a few blocks below the real one: a transaction counts as
 *          expired only when the finalized height is EXPIRY_MARGIN_BLOCKS past it, so a payment landing a few blocks
 *          late is found (no refund while the seller is paid).
 *   R2     any transaction version is read (MAX_TX_VERSION) and compared by its raw message hash; one that cannot
 *          be read keeps the answer at "pending" with the reason (reported), never "not vet402's".
 *   M2     "dead" needs the node's history to reach the window's start (getFirstAvailableBlock).
 *   Durable nonce: an agent payment that advances a durable nonce is refused; vet402 never sends one.
 *   A delivered purchase whose seller payment stays unseen is reported with the reason.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
  type KeyPairSigner,
} from "@solana/kit";
import { getTransferCheckedInstruction } from "@solana-program/token";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import { jsonRpc, type Rpc } from "../src/chain.js";
import { USDC_MINT } from "../src/constants.js";
import { usdcAta } from "../src/txcheck.js";
import { decodeSolanaTx, EXPIRY_MARGIN_BLOCKS, MAX_TX_VERSION, rawMessageHash, solanaTxFate } from "../src/proxy-buy/fate.js";
import { agent, agentPaysSolana, buyUrl, PAYER_ATA, paidReq, proxyPayer, RECEIVE, RECEIVE_ATA, S_URL, SELLER, SELLER_FAC, solRig, transferTx, VET_FAC } from "./proxy-buy-fakes.js";

const nowS = () => Math.floor(Date.now() / 1000);

/** A USDC transfer that first advances a durable nonce (System AdvanceNonceAccount). */
async function nonceTransferTx(from: KeyPairSigner, feePayer: string, payTo: string, amount: bigint): Promise<string> {
  const src = await usdcAta(from.address);
  const dst = await usdcAta(payTo);
  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(feePayer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 0n }, m),
    (m) =>
      appendTransactionMessageInstructions(
        [
          { programAddress: address("11111111111111111111111111111111"), data: new Uint8Array([4, 0, 0, 0]) },
          getTransferCheckedInstruction({ source: address(src), mint: address(USDC_MINT), destination: address(dst), authority: from, amount, decimals: 6 }),
        ],
        m,
      ),
  );
  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(tx));
}

test("zz6-R1: a transaction landing a few blocks past the recorded last valid height is found, never called dead", async () => {
  const tx = await transferTx(agent, VET_FAC, RECEIVE, 105_000n);
  const mine = decodeSolanaTx(tx)!;
  const cur = { slot: 1101, height: 101, landed: false };
  const rpc: Rpc = async (method, params) => {
    if (method === "getSlot") return cur.slot + 30;
    if (method === "getEpochInfo") return { absoluteSlot: cur.slot, blockHeight: cur.height };
    if (method === "getFirstAvailableBlock") return 0;
    if (method === "getSignaturesForAddress") {
      const list: { signature: string; slot: number; blockTime: number }[] = [{ signature: "old", slot: 900, blockTime: nowS() - 5000 }];
      if (cur.landed) list.unshift({ signature: "MINE", slot: 1102, blockTime: nowS() });
      return list;
    }
    if (method === "getTransaction") return { meta: { err: null }, transaction: [(params as [string])[0] === "MINE" ? tx : tx.replace(/A/g, "B"), "base64"] };
    throw new Error(method);
  };
  const q = { messageHash: mine.messageHash, blockhash: mine.blockhash, account: RECEIVE_ATA, minSlot: 990, lastValidBlockHeight: 100, anchor: "old" };
  // bound 100, real last includable height 103: at finalized height 101 nothing is recorded yet
  assert.deepEqual(await solanaTxFate(rpc, q), { fate: "pending" });
  cur.landed = true; // lands at height 102
  Object.assign(cur, { slot: 1108, height: 108 });
  assert.deepEqual(await solanaTxFate(rpc, q), { fate: "landed", tx: "MINE" });
  // one that never lands: expired only past the margin, dead only on the look after that
  cur.landed = false;
  Object.assign(cur, { slot: 1400, height: 100 + EXPIRY_MARGIN_BLOCKS });
  assert.deepEqual(await solanaTxFate(rpc, q), { fate: "pending" });
  Object.assign(cur, { slot: 1401, height: 101 + EXPIRY_MARGIN_BLOCKS });
  assert.deepEqual(await solanaTxFate(rpc, q), { fate: "pending", expiredSlot: 1401 });
  assert.deepEqual(await solanaTxFate(rpc, { ...q, expiredSlot: 1401 }), { fate: "dead" });
});

test("zz6-S1: the seller lands vet402's payment a few blocks past the recorded height -> found, no refund", async () => {
  const r = await solRig({ seller: { paidStatus: 500 }, sellerSettles: false, budgetMs: 8000 });
  let sellerTx: string | null = null;
  const orig = r.side.pay.createPayment;
  r.side.pay.createPayment = async (pr, a) => {
    const c = await orig(pr, a);
    sellerTx ??= c.txBase64;
    return c;
  };
  r.side.slot = async () => 990;
  r.side.heightBound = async () => ({ known: true as const, lastValidBlockHeight: 100 });
  let height = 99;
  let landed = false;
  const rpc: Rpc = async (method, params) => {
    if (method === "getSlot") return 1030 + height;
    if (method === "getFirstAvailableBlock") return 0;
    if (method === "getEpochInfo") {
      height += 1;
      if (height >= 101 && !landed) {
        landed = true; // landed at height 102, above the recorded bound
        r.state.balance -= 10_000n;
      }
      return { absoluteSlot: 1000 + height, blockHeight: height };
    }
    if (method === "getSignaturesForAddress") {
      const list = [{ signature: "old", slot: 900, blockTime: nowS() - 5000 }];
      if (landed) list.unshift({ signature: "SELLERTX", slot: 1102, blockTime: nowS() });
      return list;
    }
    if (method === "getTransaction") return { meta: { err: null }, transaction: [(params as [string])[0] === "SELLERTX" ? sellerTx : sellerTx!.replace(/A/g, "B"), "base64"] };
    throw new Error(method);
  };
  r.side.fate = (f) => solanaTxFate(rpc, f);
  const a = await agentPaysSolana(r.buy);
  const res = await r.buy.handle(paidReq(a.header));
  const body = (await res.json()) as { error?: string; refund?: unknown };
  assert.equal(landed, true);
  assert.equal(body.error, "not_delivered", JSON.stringify(body));
  assert.equal(body.refund, "none");
  assert.equal(r.refunds.length, 0, "the seller was paid: no refund");
});

function rpcServer(handler: (method: string, params: unknown[]) => { result?: unknown; error?: { code: number; message: string } }): Promise<{ url: string; close: () => void }> {
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(b) as { id: number; method: string; params: unknown[] };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, ...handler(method, params) }));
    });
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close() })));
}

test("zz6-R2: a v1 transaction on the account is read (maxSupportedTransactionVersion 1) and told apart; one the RPC refuses is reported", async () => {
  const tx = await transferTx(proxyPayer, SELLER_FAC, SELLER, 10_000n);
  const mine = decodeSolanaTx(tx)!;
  const other = await transferTx(proxyPayer, SELLER_FAC, SELLER, 1n, "abababababababababababababababab");
  let refuseAll = false;
  const srv = await rpcServer((method, params) => {
    if (method === "getSlot") return { result: 2000 };
    if (method === "getEpochInfo") return { result: { absoluteSlot: 2000, blockHeight: 900 } };
    if (method === "getFirstAvailableBlock") return { result: 0 };
    if (method === "getSignaturesForAddress") return { result: [{ signature: "V1DUST", slot: 1050, blockTime: nowS() }, { signature: "old", slot: 900, blockTime: nowS() - 5000 }] };
    if (method === "getTransaction") {
      const v = (params[1] as { maxSupportedTransactionVersion: number }).maxSupportedTransactionVersion;
      if (refuseAll || v < 1) return { error: { code: -32015, message: "Transaction version (1) is not supported by the requesting client" } };
      return { result: { meta: { err: null }, transaction: [other, "base64"] } };
    }
    return { error: { code: -1, message: method } };
  });
  try {
    assert.equal(MAX_TX_VERSION, 1);
    const rpc = jsonRpc(srv.url);
    const q = { messageHash: mine.messageHash, blockhash: mine.blockhash, account: PAYER_ATA, minSlot: 990, lastValidBlockHeight: 100, anchor: "old" };
    assert.deepEqual(await solanaTxFate(rpc, q), { fate: "pending", expiredSlot: 2000 });
    assert.deepEqual(await solanaTxFate(rpc, { ...q, expiredSlot: 2000 }), { fate: "dead" });
    refuseAll = true;
    assert.deepEqual(await solanaTxFate(rpc, { ...q, expiredSlot: 2000 }), { fate: "pending", capped: "unreadable_tx:unsupported_version", expiredSlot: 2000 });
  } finally {
    srv.close();
  }
  // the raw message hash is the decoder's for a v0 transaction, and exists for a message the decoder does not know
  assert.equal(rawMessageHash(tx), mine.messageHash);
  const v1 = Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 7), Buffer.from([0x81, 1, 0, 0, 9, 9, 9])]).toString("base64");
  assert.equal(decodeSolanaTx(v1), null);
  assert.match(rawMessageHash(v1)!, /^[0-9a-f]{64}$/);
});

test("zz6-M2: 'dead' needs the node's history to reach the window's start", async () => {
  const tx = await transferTx(proxyPayer, SELLER_FAC, SELLER, 10_000n);
  const mine = decodeSolanaTx(tx)!;
  let first = 5000;
  const rpc: Rpc = async (method) => {
    if (method === "getSlot") return 9000;
    if (method === "getEpochInfo") return { absoluteSlot: 9000, blockHeight: 1000 };
    if (method === "getFirstAvailableBlock") return first;
    if (method === "getSignaturesForAddress") return [];
    throw new Error(method);
  };
  const q = { messageHash: mine.messageHash, blockhash: mine.blockhash, account: PAYER_ATA, minSlot: 990, lastValidBlockHeight: 100, expiredSlot: 8000, anchor: null };
  assert.deepEqual(await solanaTxFate(rpc, q), { fate: "pending", capped: "history_pruned", expiredSlot: 8000 });
  const { minSlot: _m, ...noMin } = q;
  assert.deepEqual(await solanaTxFate(rpc, noMin), { fate: "pending", capped: "no_min_slot", expiredSlot: 8000 });
  first = 0;
  assert.deepEqual(await solanaTxFate(rpc, q), { fate: "dead" });
});

test("zz6-nonce: an agent payment that advances a durable nonce is refused before any charge", async () => {
  const r = await solRig();
  const q = await r.buy.handle(new Request(buyUrl(S_URL)));
  const pr = decodePaymentRequiredHeader(q.headers.get("PAYMENT-REQUIRED")!);
  const req = pr.accepts[0]!;
  const tx = await nonceTransferTx(agent, String(req.extra?.feePayer), req.payTo, BigInt(req.amount));
  assert.equal(decodeSolanaTx(tx)!.durableNonce, true);
  const payload = { x402Version: 2, resource: pr.resource, accepted: req, payload: { transaction: tx } } as PaymentPayload;
  const res = await r.buy.handle(paidReq(encodePaymentSignatureHeader(payload)));
  const body = (await res.json()) as { reason: string; charged: boolean };
  assert.equal(res.status, 400);
  assert.equal(body.reason, "durable_nonce_refused");
  assert.equal(body.charged, false);
  assert.equal(r.fac.settles, 0);
});

test("zz6-nonce: vet402 never hands a seller a durable-nonce payment (nothing sent, the agent refunded)", async () => {
  const r = await solRig();
  r.side.pay.createPayment = async () => {
    const tx = await nonceTransferTx(proxyPayer, SELLER_FAC, SELLER, 10_000n);
    return { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ x402Version: 2, payload: { transaction: tx } })).toString("base64") }, txBase64: tx };
  };
  const a = await agentPaysSolana(r.buy);
  const body = (await (await r.buy.handle(paidReq(a.header))).json()) as { error: string; refund: { status: string } };
  assert.equal(body.error, "seller_not_paid");
  assert.equal(body.refund.status, "sent");
  assert.equal(r.seller.paidRequests, 0, "nothing was handed to the seller");
});

test("zz6-H2: a delivered purchase whose seller payment stays unseen is reported with the reason", async () => {
  const r = await solRig({ sellerSettles: false, budgetMs: 300 });
  r.chain.blockhashValid = true;
  const a = await agentPaysSolana(r.buy);
  assert.equal((await r.buy.handle(paidReq(a.header))).status, 200);
  const soon = await r.reconcile();
  assert.ok(soon.some((x) => x.action.startsWith("waiting: a delivered purchase's seller payment")), JSON.stringify(soon));
  const late = await r.reconcile({ now: new Date(Date.now() + 3 * 3_600_000) });
  assert.ok(late.some((x) => x.action.startsWith("ALERT waiting: a delivered purchase's seller payment is not seen on chain yet; closed")), JSON.stringify(late));
  r.side.fate = async () => ({ fate: "pending", capped: "unreadable_tx:read_error" });
  const cut = await r.reconcile();
  assert.ok(cut.some((x) => x.action.endsWith("(unreadable_tx:read_error)") && x.action.startsWith("ALERT")), JSON.stringify(cut));
});
