/**
 * Ninth review (a check of the eighth review's changes): its probes, now asserting the fixed behaviour.
 *   P1  on a quiet receive account (its newest signature older than the lookback), an agent payment that never landed
 *       is still decided "dead": the walk reaches the anchor before the lookback time can end it.
 *   P2  settling by hand while the reconciler starts a new refund attempt: whichever writes first wins, the other
 *       changes nothing; never a closed purchase with a refund in flight, never two refunds.
 *   The alerts secret may not equal the cron's.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Rpc } from "../src/chain.js";
import { alertsResponse } from "../src/proxy-buy/alerts.js";
import { AGENT_LOOKBACK_SECONDS, decodeSolanaTx, EXPIRY_MARGIN_BLOCKS, solanaTxFate } from "../src/proxy-buy/fate.js";
import { SETTLE_QUIET_MS, settleByHand } from "../src/proxy-buy/resolve.js";
import { Store } from "../src/proxy-buy/store.js";
import { agent, RECEIVE, RECEIVE_ATA, testSql, transferTx, VET_FAC } from "./proxy-buy-fakes.js";

const caps = { cap: 2_000_000n, maxCount: 100, refundCap: 2_000_000n };
const t0 = new Date("2026-09-30T00:00:00Z");
const day = "2026-09-30";
const later = (ms: number) => new Date(t0.getTime() + ms);

test("zz9-P1: a quiet receive account (newest signature an hour old): an agent payment that never landed is dead; one the agent settled itself is found", async () => {
  const tx = await transferTx(agent, VET_FAC, RECEIVE, 105_000n);
  const mine = decodeSolanaTx(tx)!;
  const claimedAt = Math.floor(Date.now() / 1000);
  let list: { signature: string; slot: number; blockTime: number }[] = [{ signature: "LAST_HOUR_AGO", slot: 50, blockTime: claimedAt - 3600 }];
  const rpc: Rpc = async (method, params) => {
    if (method === "getSlot") return 3000;
    if (method === "getEpochInfo") return { absoluteSlot: 3000, blockHeight: 100 + EXPIRY_MARGIN_BLOCKS + 50 };
    if (method === "getFirstAvailableBlock") return 0;
    if (method === "getSignaturesForAddress") return list;
    if (method === "getTransaction") return { meta: { err: null }, transaction: [(params as [string])[0] === "SELF" ? tx : tx.replace(/A/g, "B"), "base64"] };
    throw new Error(method);
  };
  const q = { messageHash: mine.messageHash, blockhash: mine.blockhash, account: RECEIVE_ATA, minSlot: 150, lastValidBlockHeight: 100, anchor: "LAST_HOUR_AGO", pastAnchorUntil: claimedAt - AGENT_LOOKBACK_SECONDS, expiredSlot: 3000 };
  assert.deepEqual(await solanaTxFate(rpc, q), { fate: "dead" });
  const { pastAnchorUntil: _p, ...noPast } = q;
  assert.deepEqual(await solanaTxFate(rpc, noPast), { fate: "dead" }, "the same as without the lookback");
  // the agent settled it itself before vet402 read the anchor: it is the anchor (or, read with the old anchor, above it)
  list = [{ signature: "SELF", slot: 140, blockTime: claimedAt - 20 }, ...list];
  assert.deepEqual(await solanaTxFate(rpc, { ...q, anchor: "SELF" }), { fate: "landed", tx: "SELF" });
  assert.deepEqual(await solanaTxFate(rpc, q), { fate: "landed", tx: "SELF" });
});

async function toDeadRefund(s: Store, id: string): Promise<void> {
  assert.ok(await s.claim({ id, chain: "solana", target: "https://x.test/", sellerHost: "x.test", agent: "AGENT", sellerAmount: 100_000n, feeReserve: 0n, total: 105_000n, facts: {}, now: t0 }));
  assert.deepEqual(await s.admit(id, { chain: "solana", payer: "PAYER", day, caps, need: 105_000n, balance: 5_000_000n, now: t0 }), { ok: true });
  assert.ok(await s.move(id, ["admitted"], "settling", { now: t0 }));
  const rec = { id, chain: "solana", at: t0.toISOString(), target: "", seller: { host: "x.test", payTo: "", priceAtomic: "100000" }, feeAtomic: "5000", totalAtomic: "105000", customer: { tx: "CUST" + id, payer: "AGENTOWNER", confirmed: true }, sellerPayment: null, answer: null, outcome: "in_progress", reason: null, refund: "none" } as const;
  assert.ok(await s.useCustomerTx(id, "solana", "CUST" + id, { facts: { customerTx: "CUST" + id, refundTo: "AGENTOWNER" }, record: rec as never, now: t0 }));
  assert.ok(await s.move(id, ["in_progress"], "refund_pending", { now: t0 }));
  await s.refundClaim(id, { chain: "solana", day, to: "AGENTOWNER", amount: 105_000n, maxRefund: 105_000n, now: t0 });
  assert.ok(await s.refundSending(id, ["pending"], { tx: "R1", facts: {}, now: t0 }));
  await s.refundSet(id, ["sending"], "dead", { tx: "R1", now: t0 }); // R1 proven dead; quiet for an hour since
}

test("zz9-P2: the reconciler takes the refund between settle's read and its write -> settle changes nothing", async () => {
  const s = new Store(await testSql());
  await toDeadRefund(s, "p1");
  const at = later(3_600_000);
  const orig = s.getRefund.bind(s);
  let took = false;
  (s as unknown as { getRefund: typeof s.getRefund }).getRefund = async (x: string) => {
    const r = await orig(x);
    took = await s.refundSending(x, ["pending", "dead", "failed"], { tx: "R2_IN_FLIGHT", facts: {}, now: at }); // the cron's retry
    return r;
  };
  const out = await settleByHand(s, "p1", { reason: "refunded by hand", spent: 105_000n, refundTx: "HAND", now: at });
  assert.equal(took, true);
  assert.equal(out.ok, false);
  assert.match(out.detail, /refund moved meanwhile/);
  const rf = (await orig("p1"))!;
  assert.deepEqual([rf.status, rf.tx], ["sending", "R2_IN_FLIGHT"], "the attempt in flight stays on the books");
  assert.equal((await s.get("p1"))!.state, "refund_pending", "the purchase stays open for the reconciler");
});

test("zz9-P2: settle writes first -> the reconciler's new attempt cannot take the refund (nothing sent twice)", async () => {
  const s = new Store(await testSql());
  await toDeadRefund(s, "p2");
  const at = later(3_600_000);
  const out = await settleByHand(s, "p2", { reason: "refunded by hand", spent: 105_000n, refundTx: "HAND", now: at });
  assert.equal(out.ok, true, out.detail);
  assert.equal(await s.refundSending("p2", ["pending", "dead", "failed"], { tx: "R2", facts: {}, now: at }), false);
  const rf = (await s.getRefund("p2"))!;
  assert.deepEqual([rf.status, rf.tx], ["sent", "HAND"]);
  assert.equal((await s.get("p2"))!.state, "done");
});

test("zz9-P2: a refund row changed in the last ten minutes is not settled by hand; a sent one is left to the reconciler", async () => {
  const s = new Store(await testSql());
  await toDeadRefund(s, "p3");
  const at = later(3_600_000);
  await s.refundSet("p3", ["dead"], "dead", { tx: "R1", reason: "looked again", now: at });
  assert.equal((await settleByHand(s, "p3", { reason: "x", spent: 0n, now: new Date(at.getTime() + SETTLE_QUIET_MS - 1) })).ok, false);
  assert.equal((await settleByHand(s, "p3", { reason: "x", spent: 0n, now: new Date(at.getTime() + SETTLE_QUIET_MS) })).ok, true);
  const s2 = new Store(await testSql());
  await toDeadRefund(s2, "p4");
  assert.ok(await s2.refundSending("p4", ["dead"], { tx: "R2", facts: {}, now: t0 }));
  await s2.refundSet("p4", ["sending"], "sent", { tx: "R2", now: t0 });
  const sent = await settleByHand(s2, "p4", { reason: "x", spent: 0n, now: later(3_600_000) });
  assert.equal(sent.ok, false);
  assert.match(sent.detail, /refund was sent/);
});

test("zz9: the alerts secret may not be the cron's", async () => {
  const s = new Store(await testSql());
  const same = "one-secret-for-both-0123";
  const r = await alertsResponse(new Request("https://x/api/alerts", { headers: { authorization: `Bearer ${same}` } }), s, same, same);
  assert.equal(r.status, 503);
  const ok = await alertsResponse(new Request("https://x/api/alerts", { headers: { authorization: `Bearer ${same}` } }), s, same, "another-cron-secret-456789");
  assert.equal(ok.status, 200);
});
