/**
 * Eighth review: its reproductions (R8-A to R8-F) and the other items, now asserting the fixed behaviour.
 *   A/B  settling by hand is refused while a sent refund can still land, and for a purchase changed in the last ten
 *        minutes; without a refund transaction the refund row is closed with the purchase, not left open.
 *   C    a refund is sent at most three times (README).
 *   D    reopen-refund refuses a refund that can still land; of 20 concurrent reopens of a stuck one, one wins.
 *   E    an agent payment the agent settled itself before vet402 read the anchor and minSlot is found (and so
 *        refunded), not called dead: the agent's search reaches back AGENT_LOOKBACK_SECONDS past the anchor.
 *   F    a reconcile turn that runs out of its own reads does not resolve an open ALERT.
 *   M4   api/alerts gives the reconciler's last full run; the runner reports when it is late, and a read that is not
 *        the expected JSON; the alerts secret is its own and compared in constant time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Rpc } from "../src/chain.js";
import { alertsResponse, bearerMatches } from "../src/proxy-buy/alerts.js";
import { AGENT_LOOKBACK_SECONDS, decodeSolanaTx, EXPIRY_MARGIN_BLOCKS, solanaTxFate } from "../src/proxy-buy/fate.js";
import { reconcile } from "../src/proxy-buy/reconcile.js";
import { refundAgent, type RefundSender } from "../src/proxy-buy/refund.js";
import { reopenRefund, SETTLE_QUIET_MS, settleByHand } from "../src/proxy-buy/resolve.js";
import { Store } from "../src/proxy-buy/store.js";
import { failedItem, itemsFor, parseAnswer, toReport } from "../scripts/daily/proxy-alerts.js";
import { agent, RECEIVE, RECEIVE_ATA, testSql, transferTx, VET_FAC } from "./proxy-buy-fakes.js";

const caps = { cap: 2_000_000n, maxCount: 100, refundCap: 2_000_000n };
const t0 = new Date("2026-09-30T00:00:00Z");
const day = "2026-09-30";
const later = (ms: number) => new Date(t0.getTime() + ms);

async function toRefundPending(s: Store, id: string): Promise<void> {
  assert.ok(await s.claim({ id, chain: "solana", target: "https://x.test/", sellerHost: "x.test", agent: "AGENT", sellerAmount: 100_000n, feeReserve: 0n, total: 105_000n, facts: {}, now: t0 }));
  assert.deepEqual(await s.admit(id, { chain: "solana", payer: "PAYER", day, caps, need: 105_000n, balance: 5_000_000n, now: t0 }), { ok: true });
  assert.ok(await s.move(id, ["admitted"], "settling", { now: t0 }));
  const rec = { id, chain: "solana", at: t0.toISOString(), target: "", seller: { host: "x.test", payTo: "", priceAtomic: "100000" }, feeAtomic: "5000", totalAtomic: "105000", customer: { tx: "CUST" + id, payer: "AGENTOWNER", confirmed: true }, sellerPayment: null, answer: null, outcome: "in_progress", reason: null, refund: "none" } as const;
  assert.ok(await s.useCustomerTx(id, "solana", "CUST" + id, { facts: { customerTx: "CUST" + id, refundTo: "AGENTOWNER" }, record: rec as never, now: t0 }));
  assert.ok(await s.move(id, ["in_progress"], "refund_pending", { now: t0 }));
}

test("zz8-A: settle is refused while a sent refund can still land, and for a purchase changed in the last ten minutes", async () => {
  const s = new Store(await testSql());
  await toRefundPending(s, "p1");
  await s.refundClaim("p1", { chain: "solana", day, to: "AGENTOWNER", amount: 105_000n, maxRefund: 105_000n, now: t0 });
  assert.ok(await s.refundSending("p1", ["pending"], { tx: "LIVE", facts: {}, now: t0 }));
  for (const st of ["sending", "unknown"] as const) {
    if (st === "unknown") await s.refundSet("p1", ["sending"], "unknown", { tx: "LIVE", now: t0 });
    const r = await settleByHand(s, "p1", { reason: "refunded by hand", spent: 105_000n, refundTx: "HAND", now: later(3_600_000) });
    assert.equal(r.ok, false, st);
    assert.match(r.detail, /LIVE.*can still land/);
  }
  assert.equal((await s.get("p1"))!.state, "refund_pending");
  assert.equal((await s.getRefund("p1"))!.tx, "LIVE", "the live transaction stays on the books");
  // proven dead: now a person may close it; but not within ten minutes of the last change
  await s.refundSet("p1", ["unknown"], "dead", { tx: "LIVE", now: t0 });
  await s.move("p1", ["refund_pending"], "refund_pending", { now: later(3_600_000) });
  const soon = await settleByHand(s, "p1", { reason: "x", spent: 105_000n, refundTx: "HAND", now: later(3_600_000 + SETTLE_QUIET_MS - 1) });
  assert.equal(soon.ok, false);
  const ok = await settleByHand(s, "p1", { reason: "refunded by hand", spent: 105_000n, refundTx: "HAND", now: later(3_600_000 + SETTLE_QUIET_MS) });
  assert.equal(ok.ok, true, ok.detail);
  assert.deepEqual([(await s.getRefund("p1"))!.status, (await s.getRefund("p1"))!.tx], ["sent", "HAND"]);
});

test("zz8-B: settle without a refund transaction closes the refund row too (never left 'pending' or 'dead' with nobody on it)", async () => {
  const s = new Store(await testSql());
  await toRefundPending(s, "p2");
  await s.refundClaim("p2", { chain: "solana", day, to: "AGENTOWNER", amount: 105_000n, maxRefund: 105_000n, now: t0 });
  const r = await settleByHand(s, "p2", { reason: "the agent was paid back off chain", spent: 105_000n, now: later(3_600_000) });
  assert.equal(r.ok, true, r.detail);
  const rf = (await s.getRefund("p2"))!;
  assert.equal(rf.status, "closed");
  assert.match(rf.reason!, /settled by hand: the agent was paid back off chain/);
});

test("zz8-C: a refund is sent at most three times, then it is stuck (README)", async () => {
  const s = new Store(await testSql());
  await toRefundPending(s, "p3");
  let sends = 0;
  const send: RefundSender = async (_to, _amt, before) => {
    const tx = `R${sends}`;
    if (!(await before({ tx, facts: {} }))) return { status: "failed", reason: "refund_taken_by_another_attempt", tx: null };
    sends++;
    return { status: "unknown", reason: "refund_not_confirmed_in_time", tx };
  };
  let rec = await refundAgent(s, send, { id: "p3", chain: "solana", day, to: "AGENTOWNER", amount: 105_000n, maxRefund: 105_000n, now: () => t0 });
  for (let i = 0; i < 10 && rec.status !== "stuck"; i++) {
    const rf = (await s.getRefund("p3"))!;
    await s.refundSet("p3", ["sending", "unknown"], "dead", { reason: "refund_dead", tx: rf.tx, now: t0 });
    rec = await refundAgent(s, send, { id: "p3", chain: "solana", day, to: "AGENTOWNER", amount: 105_000n, maxRefund: 105_000n, now: () => t0, retry: true });
  }
  assert.equal(rec.status, "stuck");
  assert.equal(sends, 3);
});

test("zz8-D: reopen-refund refuses a refund that can still land; of 20 concurrent reopens of a stuck one, one wins", async () => {
  const s = new Store(await testSql());
  await toRefundPending(s, "p4");
  await s.refundClaim("p4", { chain: "solana", day, to: "AGENTOWNER", amount: 105_000n, maxRefund: 105_000n, now: t0 });
  assert.ok(await s.refundSending("p4", ["pending"], { tx: "L", facts: {}, now: t0 }));
  for (const st of ["sending", "unknown"] as const) {
    if (st === "unknown") await s.refundSet("p4", ["sending"], "unknown", { tx: "L", now: t0 });
    assert.equal((await reopenRefund(s, "p4", { reason: "x", now: t0 })).ok, false, st);
  }
  await s.refundSet("p4", ["unknown"], "stuck", { tx: "L", now: t0 });
  const rs = await Promise.all(Array.from({ length: 20 }, () => reopenRefund(s, "p4", { reason: "y", now: t0 })));
  assert.equal(rs.filter((r) => r.ok).length, 1);
});

test("zz8-E: an agent payment the agent settled itself before vet402 read the anchor is found, not called dead", async () => {
  const tx = await transferTx(agent, VET_FAC, RECEIVE, 105_000n);
  const mine = decodeSolanaTx(tx)!;
  const claimedAt = Math.floor(Date.now() / 1000);
  let reads = 0;
  // the agent's own settle (slot 100) is the newest signature on the receive account when vet402 reads the anchor
  const rpc: Rpc = async (method, params) => {
    if (method === "getSlot") return 3000;
    if (method === "getEpochInfo") return { absoluteSlot: 3000, blockHeight: 100 + EXPIRY_MARGIN_BLOCKS + 50 };
    if (method === "getFirstAvailableBlock") return 0;
    if (method === "getSignaturesForAddress") {
      return [
        { signature: "AGENT_SELF", slot: 100, blockTime: claimedAt - 30 },
        { signature: "older", slot: 50, blockTime: claimedAt - 3600 },
      ];
    }
    if (method === "getTransaction") {
      reads++;
      return { meta: { err: null }, transaction: [(params as [string])[0] === "AGENT_SELF" ? tx : tx.replace(/A/g, "B"), "base64"] };
    }
    throw new Error(method);
  };
  for (const anchor of ["AGENT_SELF", "older"]) {
    const q = { messageHash: mine.messageHash, blockhash: mine.blockhash, account: RECEIVE_ATA, minSlot: 150, lastValidBlockHeight: 100, anchor, pastAnchorUntil: claimedAt - AGENT_LOOKBACK_SECONDS };
    assert.deepEqual(await solanaTxFate(rpc, q), { fate: "landed", tx: "AGENT_SELF" }, anchor);
    assert.deepEqual(await solanaTxFate(rpc, { ...q, expiredSlot: 3000 }), { fate: "landed", tx: "AGENT_SELF" }, anchor);
  }
  assert.ok(reads >= 4);
  // and one that never landed is still dead: the walk passes the anchor and stops at the lookback time
  const none: Rpc = async (method, params) => {
    if (method === "getSignaturesForAddress") return [{ signature: "PRE", slot: 140, blockTime: claimedAt - 20 }, { signature: "older", slot: 50, blockTime: claimedAt - 3600 }];
    return rpc(method, params);
  };
  const q = { messageHash: mine.messageHash, blockhash: mine.blockhash, account: RECEIVE_ATA, minSlot: 150, lastValidBlockHeight: 100, anchor: "PRE", pastAnchorUntil: claimedAt - AGENT_LOOKBACK_SECONDS, expiredSlot: 3000 };
  assert.deepEqual(await solanaTxFate(none, q), { fate: "dead" });
  assert.deepEqual(await solanaTxFate(none, { ...q, anchor: "NOT_LISTED" }), { fate: "pending", capped: "anchor_not_reached", expiredSlot: 3000 });
});

test("zz8-F: a reconcile turn that runs out of its own reads leaves an open ALERT open", async () => {
  const s = new Store(await testSql());
  await toRefundPending(s, "p6");
  await s.move("p6", ["refund_pending"], "seller_unsettled", { facts: { seller: { messageHash: "h", blockhash: "b", account: "A", minSlot: 1, lastValidBlockHeight: 1, anchor: "x" } }, now: t0 });
  const base = { store: s, feeAtomic: 5000n, now: () => later(20 * 60_000), recordUrl: (x: string) => x, caps, maxRefund: 105_000n, deadline: Date.now() + 60_000, staleMs: 1, walletCheck: false };
  const side = (capped: string) => ({ fate: async () => ({ fate: "pending" as const, capped }) }) as never;
  await reconcile({ ...base, solana: side("anchor_not_reached") });
  assert.equal((await s.openAlerts()).length, 1);
  await s.sql.query(`update pb_purchase set checked_at = null where id = 'p6'`);
  await reconcile({ ...base, solana: side("run_budget") });
  assert.equal((await s.openAlerts()).length, 1, "a look cut short by the run's own budget says nothing about the alert");
});

test("zz8-M4: api/alerts says when the reconciler last ran in full; the alerts secret is its own", async () => {
  const s = new Store(await testSql());
  const secret = "read-only-alerts-secret-0123";
  const get = (auth?: string) => alertsResponse(new Request("https://x/api/alerts", auth ? { headers: { authorization: auth } } : {}), s, secret);
  assert.equal((await get()).status, 403);
  assert.equal((await get(`Bearer ${secret}x`)).status, 403);
  assert.equal(bearerMatches(`Bearer short`, "short"), false, "a secret under 16 characters is refused");
  const first = (await (await get(`Bearer ${secret}`)).json()) as { reconcilerLastRunAt: string | null; alerts: unknown[] };
  assert.equal(first.reconcilerLastRunAt, null);
  await reconcile({ store: s, feeAtomic: 5000n, now: () => t0, recordUrl: (x) => x, caps, maxRefund: 105_000n, deadline: Date.now() + 5000, staleMs: 1 });
  const second = (await (await get(`Bearer ${secret}`)).json()) as { reconcilerLastRunAt: string | null };
  assert.equal(second.reconcilerLastRunAt, "2026-09-30T00:00:00Z");
  // the request gate's short turn (walletCheck false) is not a full run
  await reconcile({ store: s, feeAtomic: 5000n, now: () => later(3_600_000), recordUrl: (x) => x, caps, maxRefund: 105_000n, deadline: Date.now() + 5000, staleMs: 1, walletCheck: false });
  assert.equal(((await (await get(`Bearer ${secret}`)).json()) as { reconcilerLastRunAt: string }).reconcilerLastRunAt, "2026-09-30T00:00:00Z");
});

test("zz8-M4: the runner reports a late reconciler and a read that is not the expected JSON, once and then daily", () => {
  assert.deepEqual(parseAnswer("<html>"), { error: "not JSON" });
  assert.deepEqual(parseAnswer(JSON.stringify({ ok: true })), { error: "no alerts list" });
  const now = new Date("2026-10-01T00:00:00Z");
  const fresh = itemsFor({ alerts: [], reconcilerLastRunAt: "2026-09-30T23:57:00Z" }, now);
  assert.equal(fresh.length, 0);
  // The cron runs every 30 minutes: two missed runs in a row are not late, three are (RECONCILER_LATE_MS, 95 min).
  assert.equal(itemsFor({ alerts: [], reconcilerLastRunAt: "2026-09-30T22:34:00Z" }, now).length, 0);
  const late = itemsFor({ alerts: [], reconcilerLastRunAt: "2026-09-30T22:20:00Z" }, now);
  assert.match(late[0]!.line, /the reconciler has not run in full since 2026-09-30T22:20:00Z/);
  assert.match(itemsFor({ alerts: [], reconcilerLastRunAt: null }, now)[0]!.line, /since \(never\)/);
  const a = toReport(late, { reported: {} }, now);
  assert.equal(a.lines.length, 1);
  assert.equal(toReport(late, a.state, new Date(now.getTime() + 15 * 60_000)).lines.length, 0);
  assert.equal(toReport(late, a.state, new Date(now.getTime() + 25 * 3_600_000)).lines.length, 1);
  assert.match(failedItem("not JSON").line, /could not be read \(not JSON\)/);
});
