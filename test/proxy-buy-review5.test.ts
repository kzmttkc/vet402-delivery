/**
 * Fifth review: its reproductions (Z0 to Z4) and the other items, now asserting the fixed behaviour.
 *   Z0  expiry is read from the finalized block height against the transaction's last valid block height, not from
 *       isBlockhashValid (which also says false for a blockhash the node does not know yet).
 *   Z1  a seller that answers 500 and lands vet402's payment late: found, no refund, the books stay whole.
 *   Z2  a seller whose 402 names the blockhash (extra.recentBlockhash / recentSlot) is refused: at the price read,
 *       and again before vet402 signs.
 *   Z3  production wiring (solanaSide) hands the refund options through: a missing USDC account is created.
 *   Z4  more newer signatures than one look pages through: the walk resumes where it stopped (cursor).
 *   M1  every cron run reports what would refuse all new purchases (balance under the floor, a floor under one
 *       purchase, too little SOL for the open purchases' refunds).
 *   L2  a paid request whose payment header cannot be read gives the reconciler no turn; turns are spaced.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { createKeyPairSignerFromBytes, generateKeyPairSigner } from "@solana/kit";
import { jsonRpc, type Rpc } from "../src/chain.js";
import { decodeSolanaTx, solanaTxFate } from "../src/proxy-buy/fate.js";
import { REFUND_SOL_MIN_LAMPORTS } from "../src/proxy-buy/solana.js";
import { solanaSide } from "../src/proxy-buy/wire.js";
import { agentPaysSolana, buyUrl, PAYER_ATA, RECEIVE_ATA, paidReq, proxyPayer, S_URL, SELLER, SELLER_FAC, solRig, transferTx } from "./proxy-buy-fakes.js";

const nowS = () => Math.floor(Date.now() / 1000);

test("zz5-Z0: a blockhash the node does not know yet is not 'expired'; the payment that lands later is found", async () => {
  const tx = await transferTx(proxyPayer, SELLER_FAC, SELLER, 10_000n);
  const mine = decodeSolanaTx(tx)!;
  const cur = { slot: 1000, height: 90, listed: false };
  let reads = 0;
  const rpc: Rpc = async (method, params) => {
    if (method === "getSlot") return cur.slot;
    if (method === "isBlockhashValid") return { context: { slot: cur.slot }, value: false }; // "too new": never asked any more
    if (method === "getEpochInfo") return { absoluteSlot: cur.slot, blockHeight: cur.height };
    if (method === "getSignaturesForAddress") return [...(cur.listed ? [{ signature: "MINE", slot: 1195, blockTime: nowS() }] : []), { signature: "old", slot: 900, blockTime: nowS() - 5000 }];
    if (method === "getTransaction") {
      reads++;
      return { meta: { err: null }, transaction: [(params as [string])[0] === "MINE" ? tx : tx.replace(/A/g, "B"), "base64"] };
    }
    throw new Error(method);
  };
  const q = { messageHash: mine.messageHash, blockhash: mine.blockhash, account: PAYER_ATA, minSlot: 990, lastValidBlockHeight: 100 };
  assert.deepEqual(await solanaTxFate(rpc, q), { fate: "pending" }, "not expired: no window end is recorded");
  Object.assign(cur, { slot: 1100, height: 95 });
  assert.deepEqual(await solanaTxFate(rpc, q), { fate: "pending" });
  // the seller lands it at 1195 (height 99); the finalized height passes 100 at slot 1300
  Object.assign(cur, { slot: 1300, height: 101, listed: true });
  assert.deepEqual(await solanaTxFate(rpc, q), { fate: "landed", tx: "MINE" });
  assert.ok(reads >= 1);
});

test("zz5-Z1: the seller answers 500 and lands vet402's payment late -> found, no refund; later purchases go on; no wallet ALERT", async () => {
  const r = await solRig({ seller: { paidStatus: 500 }, sellerSettles: false, budgetMs: 4000 });
  let sellerTx: string | null = null;
  const orig = r.side.pay.createPayment;
  r.side.pay.createPayment = async (pr, a) => {
    const c = await orig(pr, a);
    sellerTx ??= c.txBase64; // the first purchase's payment is the one that lands late
    return c;
  };
  r.side.slot = async () => 990;
  r.side.heightBound = async () => ({ blockhash: "x", lastValidBlockHeight: 100 });
  let height = 80;
  let landed = false;
  const rpc: Rpc = async (method) => {
    if (method === "getSlot") return 1000 + height;
    if (method === "getEpochInfo") {
      height += 5;
      return { absoluteSlot: 1000 + height, blockHeight: height };
    }
    if (method === "getSignaturesForAddress") {
      const list = [{ signature: "old", slot: 900, blockTime: nowS() - 5000 }];
      if (height >= 95) {
        if (!landed) {
          landed = true;
          r.state.balance -= 10_000n; // vet402's payment to the seller lands at height 95
        }
        list.unshift({ signature: "SELLERTX", slot: 1095, blockTime: nowS() });
      }
      return list;
    }
    if (method === "getTransaction") return { meta: { err: null }, transaction: [sellerTx, "base64"] };
    throw new Error(method);
  };
  r.side.fate = (f) => solanaTxFate(rpc, f);
  const a = await agentPaysSolana(r.buy);
  const res = await r.buy.handle(paidReq(a.header));
  const body = (await res.json()) as { error?: string; refund?: unknown };
  assert.equal(res.status, 502);
  assert.equal(body.error, "not_delivered", JSON.stringify(body));
  assert.equal(body.refund, "none");
  assert.equal(landed, true);
  assert.equal(r.refunds.length, 0, "the seller was paid: no refund, nothing paid twice");
  const facts = (await r.sql.query<{ facts: { agent: { lastValidBlockHeight?: number }; seller: { lastValidBlockHeight?: number } } }>(`select facts from pb_purchase`)).rows[0]!.facts;
  assert.equal(facts.agent.lastValidBlockHeight, 100);
  assert.equal(facts.seller.lastValidBlockHeight, 100);
  // later purchases are not refused
  r.seller.paidStatus = 200;
  r.seller.price = 10_001n; // (the rig signs every seller payment with one fixed blockhash and memo: keep the messages apart)
  const b = await agentPaysSolana(r.buy, undefined, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal((await r.buy.handle(paidReq(b.header))).status, 200);
  const acts = await r.reconcile({ walletCheck: true });
  assert.equal(acts.filter((x) => x.action.startsWith("ALERT")).length, 0, JSON.stringify(acts));
});

/** The seller's 402 with extra.recentBlockhash added from the `fromRead`-th unpaid read on. */
function pinning(fromRead: number) {
  let n = 0;
  return (f: typeof fetch) =>
    (async (url: string | URL, init?: RequestInit) => {
      const res = await f(url, init);
      if (new Headers(init?.headers).has("PAYMENT-SIGNATURE") || res.status !== 402) return res;
      if (++n < fromRead) return res;
      const pr = JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED")!, "base64").toString("utf8")) as { accepts: { extra: Record<string, unknown> }[] };
      for (const a of pr.accepts) a.extra = { ...a.extra, recentBlockhash: "4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZAMdL4VZHirAn" };
      const h = new Headers(res.headers);
      h.set("PAYMENT-REQUIRED", Buffer.from(JSON.stringify(pr)).toString("base64"));
      return new Response("{}", { status: 402, headers: h });
    }) as unknown as typeof fetch;
}

test("zz5-Z2: a seller whose 402 names the blockhash is refused before any charge", async () => {
  const r = await solRig({ wrapSeller: pinning(1) });
  const res = await r.buy.handle(new Request(buyUrl(S_URL)));
  const body = (await res.json()) as { offers: { solana: { refused: string } } };
  assert.equal(res.status, 422);
  assert.equal(body.offers.solana.refused, "seller_pins_blockhash");
});

test("zz5-Z2: a seller that starts naming the blockhash after the agent paid: vet402 signs nothing and refunds", async () => {
  // unpaid reads: 1 the agent's quote, 2 the paid request's quote, 3 payOne's re-read (now pinned)
  const r = await solRig({ wrapSeller: pinning(3) });
  let signed = 0;
  const orig = r.side.pay.createPayment;
  r.side.pay.createPayment = async (pr, a) => {
    signed++;
    return orig(pr, a);
  };
  const a = await agentPaysSolana(r.buy);
  const res = await r.buy.handle(paidReq(a.header));
  const body = (await res.json()) as { error: string; refund: { status: string } };
  assert.equal(body.error, "seller_not_paid", JSON.stringify(body));
  assert.equal(body.refund.status, "sent");
  assert.equal(signed, 0, "nothing was signed for the seller");
  assert.equal(r.sellerPays.length, 0);
});

function localRpc(handler: (method: string, params: unknown) => unknown): Promise<{ url: string; close: () => void }> {
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const j = JSON.parse(b) as { id: number; method: string; params: unknown };
      res.setHeader("content-type", "application/json");
      try {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, result: handler(j.method, j.params) }));
      } catch (e) {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: j.id, error: { code: -1, message: String(e) } }));
      }
    });
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => srv.close() })));
}

test("zz5-Z3: production solanaSide hands mayCreateAccount through: a refund to a missing USDC account is built and sent", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const d = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");
  const x = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const bytes = Uint8Array.from([...d, ...x]);
  const payer = (await createKeyPairSignerFromBytes(bytes)).address;
  let sends = 0;
  const srv = await localRpc((m) => {
    if (m === "getLatestBlockhash") return { context: { slot: 100 }, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 200 } };
    if (m === "getAccountInfo") return { context: { slot: 100 }, value: null }; // the agent's USDC account does not exist
    if (m === "sendTransaction") {
      sends++;
      return "x";
    }
    // read back at once as failed on chain, so the test does not wait: the reconciler decides such a refund
    if (m === "getTransaction") return { meta: { err: { InstructionError: [0, "x"] }, preBalances: [0], postBalances: [0], preTokenBalances: [], postTokenBalances: [] }, transaction: { message: { accountKeys: [{ pubkey: payer }], instructions: [] } } };
    throw new Error(m);
  });
  try {
    const receive = (await generateKeyPairSigner()).address;
    const side = await solanaSide({ receive, payer, payerKey: bytes, rpcUrl: srv.url, facilitatorUrl: "http://127.0.0.1:9", dailyCapAtomic: 2_000_000n, dailyRefundCapAtomic: 2_000_000n }, []);
    const to = (await generateKeyPairSigner()).address;
    let asked = 0;
    const facts: Record<string, unknown>[] = [];
    const out = await side.refund(to, 15_000n, async (f) => (facts.push(f.facts), true), { mayCreateAccount: async () => (asked++, true) });
    assert.equal(asked, 1, "the option reached sendSolanaRefund");
    assert.equal(sends, 1);
    assert.equal(out.status, "unknown");
    assert.equal(facts[0]!.lastValidBlockHeight, 200, "the refund keeps its own last valid block height");
    assert.equal(typeof facts[0]!.signature, "string");
    // and the height bound reads the newest blockhash
    assert.deepEqual(await side.heightBound!(), { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 200 });
    assert.ok(jsonRpc);
  } finally {
    srv.close();
  }
});

test("zz5-Z4: 10,500 newer signatures above the window: the next look starts where this one stopped, and decides", async () => {
  const tx = await transferTx(proxyPayer, SELLER_FAC, SELLER, 10_000n);
  const mine = decodeSolanaTx(tx)!;
  const other = await generateKeyPairSigner();
  const foreign = await transferTx(other, SELLER_FAC, SELLER, 1n, "ffffffffffffffffffffffffffffffff");
  const sigs = [
    ...Array.from({ length: 10_500 }, (_, i) => ({ signature: `later${i}`, slot: 9000 - Math.floor(i / 10), blockTime: nowS() })),
    { signature: "inwin", slot: 1100, blockTime: nowS() },
    ...Array.from({ length: 20 }, (_, i) => ({ signature: `old${i}`, slot: 10 - i, blockTime: nowS() - 10_000 })),
  ];
  const calls: Record<string, number> = {};
  const rpc: Rpc = async (method, params) => {
    calls[method] = (calls[method] ?? 0) + 1;
    if (method === "getSignaturesForAddress") {
      const p = (params as [string, { limit: number; before?: string }])[1];
      const start = p.before ? sigs.findIndex((s) => s.signature === p.before) + 1 : 0;
      return sigs.slice(start, start + p.limit);
    }
    if (method === "getTransaction") return { meta: { err: null }, transaction: [foreign, "base64"] };
    if (method === "getEpochInfo") return { absoluteSlot: 9000, blockHeight: 200 };
    if (method === "getSlot") return 9000;
    throw new Error(method);
  };
  const q = { messageHash: mine.messageHash, blockhash: mine.blockhash, account: PAYER_ATA, minSlot: 1000, lastValidBlockHeight: 100, expiredSlot: 1160 };
  const first = await solanaTxFate(rpc, q);
  assert.deepEqual(first, { fate: "pending", capped: "pages", expiredSlot: 1160, cursor: "later9999" });
  assert.equal(calls.getTransaction ?? 0, 0, "nothing above the window is read");
  const second = await solanaTxFate(rpc, { ...q, cursor: "later9999" });
  assert.deepEqual(second, { fate: "dead" });
  assert.equal(calls.getTransaction, 1, "only the one signature inside the window");
});

test("zz5-Z4: the reconciler keeps the cursor with the purchase between runs", async () => {
  const r = await solRig({ seller: { paidStatus: 500 }, sellerSettles: false, budgetMs: 300 });
  r.chain.blockhashValid = true;
  const a = await agentPaysSolana(r.buy);
  assert.equal((await r.buy.handle(paidReq(a.header))).status, 502);
  r.side.fate = async (f) => (f.cursor ? { fate: "dead" } : { fate: "pending", capped: "pages", expiredSlot: 7, cursor: "C1" });
  await r.reconcile();
  const seller = (await r.sql.query<{ facts: { seller: { expiredSlot?: number; cursor?: string } } }>(`select facts from pb_purchase`)).rows[0]!.facts.seller;
  assert.deepEqual([seller.expiredSlot, seller.cursor], [7, "C1"]);
  // cut short: the next run 15 minutes later; then the kept cursor decides
  const later = await r.reconcile({ now: new Date(Date.now() + 3_600_000 + 16 * 60_000) });
  assert.ok(later.some((x) => x.action === 'refund: "sent"'), JSON.stringify(later));
});

test("zz5-M1: every cron run reports what refuses all new purchases", async () => {
  const r = await solRig();
  const a = await agentPaysSolana(r.buy);
  assert.equal((await r.buy.handle(paidReq(a.header))).status, 200);
  assert.deepEqual((await r.reconcile({ walletCheck: true })).filter((x) => x.action.startsWith("ALERT")), []);
  r.state.balance -= 1_000_000n; // money left the payer outside proxy buy
  r.state.lamports = REFUND_SOL_MIN_LAMPORTS - 1n;
  const acts = (await r.reconcile({ walletCheck: true })).map((x) => x.action);
  assert.ok(acts.some((x) => x.startsWith("ALERT chain_spend_exceeds_ledger")), JSON.stringify(acts));
  assert.ok(acts.some((x) => x.startsWith("ALERT refund_fee_unavailable")), JSON.stringify(acts));
  // a floor below one purchase's worst case
  await r.sql.query(`update pb_wallet set floor = 1000`);
  r.state.balance = 1000n;
  r.state.lamports = 10_000_000n;
  const low = (await r.reconcile({ walletCheck: true })).map((x) => x.action);
  assert.ok(low.some((x) => x.startsWith("ALERT insufficient_balance")), JSON.stringify(low));
  assert.ok(!low.some((x) => x.startsWith("ALERT chain_spend_exceeds_ledger")));
});

test("zz5-L2: an unreadable payment header gives the reconciler no turn; readable ones share one turn per window", async () => {
  const r = await solRig({ reconcileGateMs: 60_000, staleMs: 0 });
  r.fac.fail = "settle_throw"; // leaves an open purchase for the reconciler
  const a = await agentPaysSolana(r.buy);
  assert.equal((await r.buy.handle(paidReq(a.header))).status, 502);
  r.fac.fail = "none";
  let looks = 0;
  const orig = r.side.fate;
  // the reconciler's look at the open purchase: the agent's payment, searched on the receive account
  r.side.fate = async (f) => (f.account === RECEIVE_ATA && looks++, orig(f));
  const junk = await r.buy.handle(paidReq("not-a-payment"));
  assert.equal(junk.status, 400);
  assert.equal(looks, 0, "no chain read for a header that cannot be read");
  const b = await agentPaysSolana(r.buy, undefined, "cccccccccccccccccccccccccccccccc");
  await r.buy.handle(paidReq(b.header));
  const after1 = looks;
  assert.ok(after1 >= 1, "a readable paid request gives the reconciler a turn");
  const c = await agentPaysSolana(r.buy, undefined, "dddddddddddddddddddddddddddddddd");
  await r.buy.handle(paidReq(c.header));
  assert.equal(looks - after1, 0, "the next paid request in the same window does not");
});
