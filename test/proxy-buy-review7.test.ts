/**
 * Seventh review: its reproductions and the other items, now asserting the fixed behaviour.
 *   H1  a real mainnet v1 transaction (message first, 0x81, signatures at the end) is read and told apart.
 *   M1  a transaction is handed over only when vet402's node knows its blockhash; the recorded last valid height is
 *       read from a state at least as recent as the one that knew it.
 *   M2  "dead" needs the walk to reach the anchor (the account's newest signature before the hand-over); a refund
 *       whose status reads null is searched like any other transaction.
 *   M3  ALERTs are kept in pb_alert, served to the runner with the cron secret, written to the alert file by
 *       run.sh proxy-alerts, and cleared up with the resolve tools.
 *   D/L1  RPC errors are "pending" with a reason; with a minSlot the blockTime cut is not used.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { createKeyPairSignerFromBytes, generateKeyPairSigner } from "@solana/kit";
import type { Rpc } from "../src/chain.js";
import { alertsResponse } from "../src/proxy-buy/alerts.js";
import { decodeSolanaTx, EXPIRY_MARGIN_BLOCKS, rawMessageHash, solanaTxFate } from "../src/proxy-buy/fate.js";
import { alertKey } from "../src/proxy-buy/reconcile.js";
import { note, recheck, reopenRefund, settleByHand } from "../src/proxy-buy/resolve.js";
import { Store } from "../src/proxy-buy/store.js";
import { solanaSide } from "../src/proxy-buy/wire.js";
import { itemsFor, toReport, type ProxyAlert } from "../scripts/daily/proxy-alerts.js";
import { agent, agentPaysSolana, paidReq, PAYER_ATA, proxyPayer, RECEIVE, RECEIVE_ATA, SELLER, SELLER_FAC, solRig, testSql, transferTx, VET_FAC } from "./proxy-buy-fakes.js";

const ROOT = resolve(import.meta.dirname, "..");
const nowS = () => Math.floor(Date.now() / 1000);
const REAL_V1 = readFileSync(join(ROOT, "test", "fixtures", "proxy-buy", "solana-v1-tx.b64"), "utf8").trim(); // a mainnet v1 transaction, 2026-09-30
const EXPIRED = 100 + EXPIRY_MARGIN_BLOCKS + 50;

test("zz7-H1: a real mainnet v1 transaction on the account is read, told apart, and does not keep 'dead' away", async () => {
  const raw = Buffer.from(REAL_V1, "base64");
  assert.equal(raw[0], 0x81);
  const h = rawMessageHash(REAL_V1);
  assert.match(h!, /^[0-9a-f]{64}$/);
  // the message is everything but the signatures at the end (byte 1: how many)
  const { createHash } = await import("node:crypto");
  assert.equal(h, createHash("sha256").update(raw.subarray(0, raw.length - 64 * raw[1]!)).digest("hex"));
  const tx = await transferTx(proxyPayer, SELLER_FAC, SELLER, 10_000n);
  const mine = decodeSolanaTx(tx)!;
  const rpc: Rpc = async (method, params) => {
    if (method === "getSlot") return 2000;
    if (method === "getEpochInfo") return { absoluteSlot: 2000, blockHeight: EXPIRED };
    if (method === "getFirstAvailableBlock") return 0;
    if (method === "getSignaturesForAddress") return [{ signature: "V1DUST", slot: 1050, blockTime: nowS() }, { signature: "old", slot: 900, blockTime: nowS() - 5000 }];
    if (method === "getTransaction") return { meta: { err: null }, transaction: [(params as [string])[0] === "V1DUST" ? REAL_V1 : tx.replace(/A/g, "B"), "base64"] };
    throw new Error(method);
  };
  const q = { messageHash: mine.messageHash, blockhash: mine.blockhash, account: PAYER_ATA, minSlot: 990, lastValidBlockHeight: 100, anchor: "old" };
  assert.deepEqual(await solanaTxFate(rpc, q), { fate: "pending", expiredSlot: 2000 });
  assert.deepEqual(await solanaTxFate(rpc, { ...q, expiredSlot: 2000 }), { fate: "dead" });
});

test("zz7-M1: an agent payment whose blockhash vet402's node does not know is refused before any charge", async () => {
  const r = await solRig({ sleep: async () => undefined });
  let asked = 0;
  r.side.heightBound = async () => (asked++, { known: false as const });
  const a = await agentPaysSolana(r.buy);
  const res = await r.buy.handle(paidReq(a.header));
  const body = (await res.json()) as { reason: string; charged: boolean };
  assert.equal(res.status, 503);
  assert.equal(body.reason, "blockhash_not_known");
  assert.equal(body.charged, false);
  assert.equal(asked, 3, "a blockhash a little too new for the node gets two more tries");
  assert.equal(r.fac.settles, 0);
  assert.equal((await r.sql.query(`select id from pb_purchase`)).rows.length, 0);
});

test("zz7-M1: a seller payment whose blockhash the node does not know is not handed over; the agent is refunded; facts carry height and anchor", async () => {
  const r = await solRig({ sleep: async () => undefined });
  let calls = 0;
  r.side.heightBound = async () => (++calls === 1 ? { known: true as const, lastValidBlockHeight: 777 } : { known: false as const });
  r.side.anchor = async (account) => (account === RECEIVE_ATA ? "RECV_LAST" : "PAYER_LAST");
  const a = await agentPaysSolana(r.buy);
  const body = (await (await r.buy.handle(paidReq(a.header))).json()) as { error: string; refund: { status: string } };
  assert.equal(body.error, "seller_not_paid");
  assert.equal(body.refund.status, "sent");
  assert.equal(r.seller.paidRequests, 0, "nothing was handed to the seller");
  const facts = (await r.sql.query<{ facts: { agent: { lastValidBlockHeight: number; anchor: string } } }>(`select facts from pb_purchase`)).rows[0]!.facts;
  assert.deepEqual([facts.agent.lastValidBlockHeight, facts.agent.anchor], [777, "RECV_LAST"]);
});

function rpcServer(handler: (method: string, params: unknown[]) => unknown): Promise<{ url: string; calls: { method: string; params: unknown[] }[]; close: () => void }> {
  const calls: { method: string; params: unknown[] }[] = [];
  const srv = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(b) as { id: number; method: string; params: unknown[] };
      calls.push({ method, params });
      res.setHeader("content-type", "application/json");
      try {
        res.end(JSON.stringify({ jsonrpc: "2.0", id, result: handler(method, params) }));
      } catch (e) {
        res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -1, message: String(e) } }));
      }
    });
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, calls, close: () => srv.close() })));
}

test("zz7-M1: production heightBound asks isBlockhashValid (processed), then the newest blockhash from at least that state", async () => {
  let valid = false;
  const srv = await rpcServer((m) => {
    if (m === "isBlockhashValid") return { context: { slot: 1234 }, value: valid };
    if (m === "getLatestBlockhash") return { context: { slot: 1240 }, value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 5150 } };
    if (m === "getSignaturesForAddress") return [{ signature: "NEWEST" }];
    throw new Error(m);
  });
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const bytes = Uint8Array.from([...Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url"), ...Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url")]);
    const payer = (await createKeyPairSignerFromBytes(bytes)).address;
    const side = await solanaSide({ receive: (await generateKeyPairSigner()).address, payer, payerKey: bytes, rpcUrl: srv.url, facilitatorUrl: "http://127.0.0.1:9", dailyCapAtomic: 2_000_000n, dailyRefundCapAtomic: 2_000_000n }, []);
    assert.deepEqual(await side.heightBound!("BH"), { known: false });
    valid = true;
    assert.deepEqual(await side.heightBound!("BH"), { known: true, lastValidBlockHeight: 5150 });
    const latest = srv.calls.filter((c) => c.method === "getLatestBlockhash").at(-1)!;
    assert.deepEqual(latest.params, [{ commitment: "processed", minContextSlot: 1234 }]);
    assert.deepEqual(srv.calls.find((c) => c.method === "isBlockhashValid")!.params, ["BH", { commitment: "processed" }]);
    assert.equal(await side.anchor!(PAYER_ATA), "NEWEST");
  } finally {
    srv.close();
  }
});

test("zz7-M2: a listing that skips the window (the anchor is never reached) never says 'dead'", async () => {
  const tx = await transferTx(proxyPayer, SELLER_FAC, SELLER, 10_000n);
  const mine = decodeSolanaTx(tx)!;
  let listed = [{ signature: "old", slot: 900, blockTime: nowS() - 5000 }]; // the node lacks the recent window
  const rpc: Rpc = async (method) => {
    if (method === "getSlot") return 2000;
    if (method === "getEpochInfo") return { absoluteSlot: 2000, blockHeight: EXPIRED };
    if (method === "getFirstAvailableBlock") return 0; // long-term storage says it has everything
    if (method === "getSignaturesForAddress") return listed;
    if (method === "getTransaction") return { meta: { err: null }, transaction: [tx.replace(/A/g, "B"), "base64"] };
    throw new Error(method);
  };
  const q = { messageHash: mine.messageHash, blockhash: mine.blockhash, account: PAYER_ATA, minSlot: 990, lastValidBlockHeight: 100, expiredSlot: 2000, anchor: "PRE" };
  assert.deepEqual(await solanaTxFate(rpc, q), { fate: "pending", capped: "anchor_not_reached", expiredSlot: 2000 });
  listed = [{ signature: "PRE", slot: 985, blockTime: nowS() - 60 }, ...listed];
  assert.deepEqual(await solanaTxFate(rpc, q), { fate: "dead" });
});

test("zz7-M2: a refund whose status reads null (long-term storage error) is searched, not taken as dead", async () => {
  let listed: { signature: string; slot: number }[] = [];
  const rpc: Rpc = async (method) => {
    if (method === "getSlot") return 2000;
    if (method === "getSignatureStatuses") return { context: { slot: 2001 }, value: [null] };
    if (method === "getEpochInfo") return { absoluteSlot: 2000, blockHeight: EXPIRED };
    if (method === "getFirstAvailableBlock") return 0;
    if (method === "getSignaturesForAddress") return listed;
    throw new Error(method);
  };
  const q = { messageHash: "x", blockhash: "y", account: PAYER_ATA, minSlot: 990, lastValidBlockHeight: 100, expiredSlot: 2000, signature: "REFUND1", anchor: "PAYER_BEFORE" };
  assert.deepEqual(await solanaTxFate(rpc, q), { fate: "pending", capped: "anchor_not_reached", expiredSlot: 2000 });
  listed = [{ signature: "PAYER_BEFORE", slot: 980 }];
  assert.deepEqual(await solanaTxFate(rpc, q), { fate: "dead" });
});

test("zz7-D/L1: an RPC error is 'pending' with a reason; with a minSlot, an old blockTime does not end the walk", async () => {
  const q = { messageHash: "x", blockhash: "y", account: PAYER_ATA, minSlot: 1, lastValidBlockHeight: 1 };
  assert.deepEqual(await solanaTxFate(async () => { throw new Error("rpc getSlot: 429 Too Many Requests"); }, q), { fate: "pending", capped: "rpc_rate_limited" });
  assert.deepEqual(await solanaTxFate(async () => { throw new Error("fetch failed"); }, q), { fate: "pending", capped: "rpc_error" });
  const tx = await transferTx(agent, VET_FAC, RECEIVE, 105_000n);
  const mine = decodeSolanaTx(tx)!;
  const rpc: Rpc = async (method, params) => {
    if (method === "getSlot") return 2000;
    if (method === "getEpochInfo") return { absoluteSlot: 2000, blockHeight: 10 };
    // a wrong clock on the node: an hour-old blockTime inside the window
    if (method === "getSignaturesForAddress") return [{ signature: "MINE", slot: 1500, blockTime: nowS() - 3600 }];
    if (method === "getTransaction") return { meta: { err: null }, transaction: [(params as [string])[0] === "MINE" ? tx : "", "base64"] };
    throw new Error(method);
  };
  assert.deepEqual(await solanaTxFate(rpc, { messageHash: mine.messageHash, blockhash: mine.blockhash, account: RECEIVE_ATA, minSlot: 1000, since: nowS() - 120, lastValidBlockHeight: 100 }), { fate: "landed", tx: "MINE" });
});

test("zz7-M3: ALERTs are kept in pb_alert, resolved when gone, and served only with the read-only alerts secret", async () => {
  const r = await solRig({ seller: { paidStatus: 500 }, sellerSettles: false, budgetMs: 300 });
  r.chain.blockhashValid = true;
  const a = await agentPaysSolana(r.buy);
  assert.equal((await r.buy.handle(paidReq(a.header))).status, 502);
  r.side.fate = async () => ({ fate: "pending", capped: "rpc_rate_limited" });
  const acts = await r.reconcile();
  const alert = acts.find((x) => x.action.startsWith("ALERT"))!;
  const open = await r.store.openAlerts();
  assert.equal(open.length, 1);
  assert.equal(open[0]!.key, alertKey(alert.id, alert.action));
  assert.match(open[0]!.reason, /rpc_rate_limited/);
  // served with the secret only
  assert.equal((await alertsResponse(new Request("https://x/api/alerts"), r.store, "S3CRET-read-only-0123")).status, 403);
  assert.equal((await alertsResponse(new Request("https://x/api/alerts", { headers: { authorization: "Bearer nope" } }), r.store, "S3CRET-read-only-0123")).status, 403);
  assert.equal((await alertsResponse(new Request("https://x/api/alerts"), r.store, undefined)).status, 403);
  const ok = await alertsResponse(new Request("https://x/api/alerts", { headers: { authorization: "Bearer S3CRET-read-only-0123" } }), r.store, "S3CRET-read-only-0123");
  const served = (await ok.json()) as { alerts: ProxyAlert[] };
  assert.equal(served.alerts.length, 1);
  assert.equal(served.alerts[0]!.purchaseId, alert.id);
  // the chain answers again: the seller payment is dead, the agent refunded, the alert resolved
  r.side.fate = async () => ({ fate: "dead" });
  const later = await r.reconcile({ now: new Date(Date.now() + 5 * 3_600_000) });
  assert.equal((await r.store.openAlerts()).length, 0, JSON.stringify({ later, open: await r.store.openAlerts() }));
});

test("zz7-M3: the resolve tools: recheck, reopen a stuck refund, settle by hand, note", async () => {
  const r = await solRig({ seller: { paidStatus: 500 }, sellerSettles: false });
  r.side.refund = async () => ({ status: "failed", reason: "refund_to_invalid", tx: null, permanent: true });
  const a = await agentPaysSolana(r.buy);
  const body = (await (await r.buy.handle(paidReq(a.header))).json()) as { refund: { status: string }; record: string };
  assert.equal(body.refund.status, "stuck");
  const id = body.record.split("/").at(-1)!;
  await r.reconcile();
  assert.equal((await r.store.openAlerts()).length, 1);
  await note(r.store, id, "looked at it");
  assert.equal((await r.store.openAlerts())[0]!.note, "looked at it");
  // reopen, to another address: the next reconcile run sends
  const other = (await generateKeyPairSigner()).address;
  r.side.refund = async (to, amount, bs) => {
    await bs({ tx: "HANDTX", facts: {} });
    r.refunds.push({ to, amount });
    return { status: "sent", tx: "HANDTX" };
  };
  assert.deepEqual(await reopenRefund(r.store, id, { reason: "agent gave a new address", to: other, now: new Date() }), { ok: true, detail: "the next reconcile run sends a new refund attempt" });
  const acts = await r.reconcile();
  assert.ok(acts.some((x) => x.id === id && x.action.includes('"sent"')), JSON.stringify(acts));
  assert.deepEqual(r.refunds.at(-1), { to: other, amount: 15_000n });
  assert.equal((await r.store.get(id))!.state, "done");
  assert.equal((await r.store.openAlerts()).length, 0);
  assert.equal((await reopenRefund(r.store, id, { reason: "again", now: new Date() })).ok, false);
  // settle by hand: an open purchase closed with what a person found out
  const r2 = await solRig({ seller: { paidStatus: 500 }, sellerSettles: false, budgetMs: 300 });
  r2.chain.blockhashValid = true;
  const b = await agentPaysSolana(r2.buy);
  const bb = (await (await r2.buy.handle(paidReq(b.header))).json()) as { record: string };
  const id2 = bb.record.split("/").at(-1)!;
  assert.equal(await recheck(r2.store, id2), true);
  const floorBefore = (await r2.store.wallet("solana"))!.floor;
  const s = await settleByHand(r2.store, id2, { reason: "refunded by hand from the payer", spent: 15_000n, refundTx: "MANUAL", now: new Date(Date.now() + 11 * 60_000) });
  assert.equal(s.ok, true, s.detail);
  const rec = (await r2.store.getRecord(id2))!;
  assert.equal(rec.outcome, "settled_by_hand");
  assert.match(rec.reason!, /refunded by hand/);
  const rf2 = (await r2.store.getRefund(id2))!;
  assert.deepEqual([rf2.status, rf2.tx], ["sent", "MANUAL"], "the refund sent by hand takes the purchase's one refund row");
  assert.equal((await r2.store.wallet("solana"))!.floor, floorBefore, "the whole reservation was spent");
  assert.equal(await recheck(r2.store, id2), false, "closed: nothing to look at");
});

test("zz7-M3: the runner's report: new alerts once, again after a day, forgotten once resolved", () => {
  const a: ProxyAlert = { key: "k1", purchaseId: "p1", chain: "solana", reason: "ALERT refund stuck", firstAt: "2026-10-01T00:00:00Z", lastAt: "2026-10-01T00:00:00Z", count: 1 };
  const t0 = new Date("2026-10-01T00:05:00Z");
  const items = (at: Date, alerts: ProxyAlert[]) => itemsFor({ alerts, reconcilerLastRunAt: new Date(at.getTime() - 60_000).toISOString() }, at);
  const one = toReport(items(t0, [a]), { reported: {} }, t0);
  assert.equal(one.lines.length, 1);
  assert.match(one.lines[0]!, /^\[vet402_proxy_buy\] solana p1: ALERT refund stuck/);
  const t1 = new Date(t0.getTime() + 15 * 60_000);
  assert.equal(toReport(items(t1, [a]), one.state, t1).lines.length, 0);
  const t2 = new Date(t0.getTime() + 25 * 3_600_000);
  assert.equal(toReport(items(t2, [a]), one.state, t2).lines.length, 1);
  const t3 = new Date(t0.getTime() + 60_000);
  const gone = toReport(items(t3, []), one.state, t3);
  assert.deepEqual(gone.state.reported, {});
  const t4 = new Date(t0.getTime() + 120_000);
  assert.equal(toReport(items(t4, [a]), gone.state, t4).lines.length, 1);
});

function runSh(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((ok) => {
    const p = spawn("/bin/bash", [join(ROOT, "scripts", "daily", "run.sh"), ...args], { env, stdio: "ignore" });
    p.on("exit", (code) => ok(code ?? -1));
  });
}

test("zz7-M3: run.sh proxy-alerts writes new open alerts to the alert file once, never the secret", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-alerts-"));
  const home = join(dir, "home");
  mkdirSync(join(home, ".config", "vet402-daily"), { recursive: true });
  const alertsFile = join(dir, "ALERTS.md");
  let auth: string | undefined;
  const alerts: ProxyAlert[] = [{ key: "p9:ALERT refund stuck", purchaseId: "p9", chain: "solana", reason: "ALERT refund stuck after 3 attempts: needs a human", firstAt: "2026-10-01T00:00:00Z", lastAt: "2026-10-01T00:05:00Z", count: 2 }];
  const srv = http.createServer((req, res) => {
    auth = req.headers.authorization;
    if (req.headers.authorization !== "Bearer TOPSECRET") {
      res.statusCode = 403;
      return res.end("forbidden");
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ alerts, reconcilerLastRunAt: new Date().toISOString() }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/api/alerts`;
  writeFileSync(join(home, ".config", "vet402-daily", "env"), `VET402_ALERTS_FILE=${alertsFile}\nVET402_PROXY_ALERTS_URL=${url}\nVET402_PROXY_ALERTS_SECRET=TOPSECRET\n`);
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    VET402_REPO: ROOT,
    VET402_TSX: join(ROOT, "node_modules", ".bin", "tsx"),
    VET402_DAILY_STATE: join(dir, "state"),
    VET402_DAILY_LOGS: join(dir, "logs"),
    VET402_DAILY_NOTIFY: "0",
    VET402_DAILY_NOW: String(Math.floor(Date.parse("2026-10-01T03:00:00Z") / 1000)),
  };
  const logs = () => (existsSync(env.VET402_DAILY_LOGS) ? readdirSync(env.VET402_DAILY_LOGS).map((f) => readFileSync(join(env.VET402_DAILY_LOGS, f), "utf8")).join("\n") : "");
  try {
    assert.equal(await runSh(["proxy-alerts"], env), 0, logs());
    assert.equal(auth, "Bearer TOPSECRET");
    const text = readFileSync(alertsFile, "utf8");
    assert.match(text, /\[vet402_proxy_buy\] solana p9: ALERT refund stuck after 3 attempts: needs a human/);
    assert.equal(await runSh(["proxy-alerts"], env), 0);
    assert.equal(readFileSync(alertsFile, "utf8"), text, "the same open alert is not written again within a day");
    assert.doesNotMatch(readFileSync(alertsFile, "utf8") + logs(), /TOPSECRET/);
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
