/**
 * Tenth review (a check of the ninth review's changes): its probes, now asserting the fixed behaviour.
 *   Q1  the agent search's end cases: an empty or quiet account, the agent's own settle as the anchor or next to it,
 *       a missing blockTime, a node's blockTime out of order (the lookback needs both time and slot to be past it).
 *   Q2  settling by hand while the reconciler, working from rows it listed earlier, starts the first refund: one wins,
 *       never both (the claim reads the purchase again under its lock; settle takes the refund row itself).
 *   Q3  a purchase whose refund cannot be made (no address) is not kept looking "changed" by the reconciler, so a
 *       person can settle it by hand.
 *   The runner says so when a previous proxy-alerts run still holds its lock.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Rpc } from "../src/chain.js";
import { AGENT_LOOKBACK_SECONDS, decodeSolanaTx, EXPIRY_MARGIN_BLOCKS, solanaTxFate, type Fate } from "../src/proxy-buy/fate.js";
import { reconcile } from "../src/proxy-buy/reconcile.js";
import { type RefundSender } from "../src/proxy-buy/refund.js";
import { settleByHand } from "../src/proxy-buy/resolve.js";
import { Store } from "../src/proxy-buy/store.js";
import { agent, RECEIVE, RECEIVE_ATA, testSql, transferTx, VET_FAC } from "./proxy-buy-fakes.js";

const ROOT = resolve(import.meta.dirname, "..");
const caps = { cap: 50_000_000n, maxCount: 1000, refundCap: 50_000_000n };
const t0 = new Date("2026-09-30T00:00:00Z");
const day = "2026-09-30";
const H = new Date(t0.getTime() + 3_600_000);

type Sig = { signature: string; slot: number; blockTime: number | null };

test("zz10-Q1: the agent search's end cases", async () => {
  const tx = await transferTx(agent, VET_FAC, RECEIVE, 105_000n);
  const mine = decodeSolanaTx(tx)!;
  const now = Math.floor(Date.now() / 1000);
  const past = now - AGENT_LOOKBACK_SECONDS;
  const rpcFor = (list: Sig[], hit: string | null): Rpc => async (method, params) => {
    if (method === "getSlot") return 900_000;
    if (method === "getEpochInfo") return { absoluteSlot: 900_000, blockHeight: 100 + EXPIRY_MARGIN_BLOCKS + 50 };
    if (method === "getFirstAvailableBlock") return 0;
    if (method === "getSignaturesForAddress") {
      const o = (params as [string, { limit: number; before?: string }])[1];
      const i = o.before ? list.findIndex((s) => s.signature === o.before) + 1 : 0;
      return list.slice(i, i + o.limit);
    }
    if (method === "getTransaction") return { meta: { err: null }, transaction: [(params as [string])[0] === hit ? tx : tx.replace(/A/g, "B"), "base64"] };
    throw new Error(method);
  };
  const base = { messageHash: mine.messageHash, blockhash: mine.blockhash, account: RECEIVE_ATA, minSlot: 800_000, lastValidBlockHeight: 100, pastAnchorUntil: past, expiredSlot: 900_000 };
  const run = (list: Sig[], hit: string | null, q: Record<string, unknown>) => solanaTxFate(rpcFor(list, hit), { ...base, ...q } as never);
  const landed: Fate = { fate: "landed", tx: "SELF" };
  assert.deepEqual(await run([], null, { anchor: null }), { fate: "dead" }, "empty account");
  assert.deepEqual(await run([{ signature: "N1", slot: 850_000, blockTime: now - 30 }], null, { anchor: null }), { fate: "dead" });
  assert.deepEqual(await run([{ signature: "SELF", slot: 850_000, blockTime: now - 30 }], "SELF", { anchor: null }), landed);
  assert.deepEqual(
    await run([{ signature: "N1", slot: 850_000, blockTime: now - 30 }, { signature: "OLD", slot: 10, blockTime: now - 90_000 }], null, { anchor: "GONE" }),
    { fate: "pending", capped: "anchor_not_reached", expiredSlot: 900_000 },
  );
  assert.deepEqual(await run([{ signature: "SELF", slot: 850_000, blockTime: now - 30 }, { signature: "OLD", slot: 10, blockTime: now - 90_000 }], "SELF", { anchor: "SELF" }), landed);
  assert.deepEqual(await run([{ signature: "A", slot: 850_000, blockTime: now - 30 }, { signature: "SELF", slot: 850_000, blockTime: now - 30 }, { signature: "OLD", slot: 10, blockTime: now - 90_000 }], "SELF", { anchor: "A" }), landed);
  assert.deepEqual(await run([{ signature: "A", slot: 850_000, blockTime: now - 30 }, { signature: "SELF", slot: 849_999, blockTime: null }, { signature: "OLD", slot: 10, blockTime: now - 90_000 }], "SELF", { anchor: "A" }), landed);
  // a node's blockTime out of order: the slot is not past the lookback yet, so the walk goes on
  assert.deepEqual(
    await run([{ signature: "A", slot: 850_000, blockTime: now - 30 }, { signature: "WEIRD", slot: 849_000, blockTime: past - 1 }, { signature: "SELF", slot: 848_000, blockTime: now - 40 }], "SELF", { anchor: "A" }),
    landed,
  );
  const busy: Sig[] = Array.from({ length: 12_000 }, (_, i) => ({ signature: `B${i}`, slot: 950_000 - i, blockTime: now }));
  assert.deepEqual(await run([...busy, { signature: "A", slot: 800_000, blockTime: now - 700 }], null, { anchor: "A" }), { fate: "pending", capped: "pages", expiredSlot: 900_000, cursor: "B9999" });
  const many: Sig[] = Array.from({ length: 500 }, (_, i) => ({ signature: `M${i}`, slot: 890_000 - i, blockTime: now - 60 }));
  assert.deepEqual(await run([...many, { signature: "A", slot: 800_000, blockTime: now - 700 }], null, { anchor: "A" }), { fate: "pending", capped: "tx_reads", expiredSlot: 900_000 });
  assert.deepEqual(await run([{ signature: "N", slot: 850_000, blockTime: now }, { signature: "A", slot: 800_000, blockTime: now - 90_000 }], null, { anchor: "A", pastAnchorUntil: undefined }), { fate: "dead" });
  assert.deepEqual(await run([{ signature: "A", slot: 10, blockTime: now - 90_000 }], null, { anchor: "A", expiredSlot: undefined }), { fate: "pending", expiredSlot: 900_000 });
});

async function toRefundPending(s: Store, id: string, payer: string | null = "AGENTOWNER"): Promise<void> {
  assert.ok(await s.claim({ id, chain: "solana", target: "https://x.test/", sellerHost: "x.test", agent: "AGENT", sellerAmount: 100_000n, feeReserve: 0n, total: 105_000n, facts: {}, now: t0 }));
  assert.deepEqual(await s.admit(id, { chain: "solana", payer: "PAYER", day, caps, need: 105_000n, balance: 500_000_000n, now: t0 }), { ok: true });
  assert.ok(await s.move(id, ["admitted"], "settling", { now: t0 }));
  const rec = { id, chain: "solana", at: t0.toISOString(), target: "", seller: { host: "x.test", payTo: "", priceAtomic: "100000" }, feeAtomic: "5000", totalAtomic: "105000", customer: { tx: "CUST" + id, payer, confirmed: true }, sellerPayment: null, answer: null, outcome: "in_progress", reason: null, refund: "none" } as const;
  assert.ok(await s.useCustomerTx(id, "solana", "CUST" + id, { facts: { customerTx: "CUST" + id, refundTo: payer }, record: rec as never, now: t0 }));
  assert.ok(await s.move(id, ["in_progress"], "refund_pending", { now: t0 }));
}

function ctxFor(store: Store, send: RefundSender, now: Date) {
  return { store, feeAtomic: 5_000n, now: () => now, recordUrl: (x: string) => x, caps, maxRefund: 2_000_000n, deadline: Date.now() + 60_000, staleMs: 330_000, walletCheck: false, recordAlerts: false, solana: { refund: send } as never };
}

test("zz10-Q2: settle by hand commits while a reconcile run that listed the purchase is on it -> no automatic refund", async () => {
  const s = new Store(await testSql());
  await toRefundPending(s, "n1");
  let sends = 0;
  const send: RefundSender = async (_to, _a, before) => {
    if (!(await before({ tx: `AUTO${sends}`, facts: {} }))) return { status: "failed", reason: "refund_taken_by_another_attempt", tx: null };
    sends++;
    return { status: "sent", tx: `AUTO${sends}` };
  };
  const orig = s.getRefund.bind(s);
  let settle: { ok: boolean; detail: string } | null = null;
  (s as unknown as { getRefund: typeof s.getRefund }).getRefund = async (x: string) => {
    if (!settle) settle = await settleByHand(new Store(s.sql), x, { reason: "refunded by hand", spent: 105_000n, refundTx: "HAND", now: H });
    return orig(x);
  };
  await reconcile(ctxFor(s, send, H) as never);
  assert.equal(settle!.ok, true, settle!.detail);
  assert.equal(sends, 0, "the reconciler sent no second refund");
  const rf = (await orig("n1"))!;
  assert.deepEqual([rf.status, rf.tx], ["sent", "HAND"]);
  assert.equal((await s.get("n1"))!.state, "done");
  // and the other order: the reconciler's claim first, then settle finds the refund taken
  const s2 = new Store(await testSql());
  await toRefundPending(s2, "n2");
  assert.deepEqual(await s2.refundClaim("n2", { chain: "solana", day, to: "AGENTOWNER", amount: 105_000n, maxRefund: 2_000_000n, now: H }), { ok: true });
  assert.equal((await settleByHand(s2, "n2", { reason: "x", spent: 105_000n, refundTx: "HAND", now: new Date(H.getTime() + 11 * 60_000) })).ok, true, "a pending (unsent) claim is closed with it");
  // a claim on a purchase already closed is refused
  assert.equal((await s2.refundClaim("n2", { chain: "solana", day, to: "AGENTOWNER", amount: 105_000n, maxRefund: 2_000_000n, now: H })).ok, false);
});

test("zz10-Q3: a purchase whose refund has no address is not kept 'changed' by the reconciler; a person can settle it", async () => {
  const s = new Store(await testSql());
  await toRefundPending(s, "u1", null);
  const send: RefundSender = async () => ({ status: "failed", reason: "x", tx: null });
  const now = new Date(t0.getTime() + 60 * 60_000);
  const acts = await reconcile(ctxFor(s, send, now) as never);
  assert.ok(acts.some((a) => a.id === "u1" && a.action.includes("payer_unknown")), JSON.stringify(acts));
  assert.equal((await s.get("u1"))!.updated_at, "2026-09-30T00:00:00.000000Z", "a look that changed nothing does not move updated_at");
  const r = await settleByHand(s, "u1", { reason: "refunded by hand to the address the agent gave", spent: 105_000n, refundTx: "HAND", now: new Date(now.getTime() + 4 * 60_000) });
  assert.equal(r.ok, true, r.detail);
  assert.deepEqual([(await s.getRefund("u1"))!.status, (await s.get("u1"))!.state], ["sent", "done"]);
});

test("zz10-low: run.sh proxy-alerts says so when a previous run still holds its lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pb-lock-"));
  const home = join(dir, "home");
  const state = join(dir, "state");
  mkdirSync(join(home, ".config", "vet402-daily"), { recursive: true });
  mkdirSync(state, { recursive: true });
  const alertsFile = join(dir, "ALERTS.md");
  writeFileSync(join(home, ".config", "vet402-daily", "env"), `VET402_ALERTS_FILE=${alertsFile}\n`);
  const env = { PATH: "/usr/bin:/bin", HOME: home, VET402_REPO: ROOT, VET402_DAILY_STATE: state, VET402_DAILY_LOGS: join(dir, "logs"), VET402_DAILY_NOTIFY: "0", VET402_DAILY_NOW: String(Math.floor(Date.parse("2026-10-01T03:00:00Z") / 1000)) };
  const holder: ChildProcess = spawn("/usr/bin/lockf", ["-k", join(state, "proxy-alerts.lock"), "/bin/sleep", "20"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 50 && !existsSync(join(state, "proxy-alerts.lock")); i++) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 200));
    const code = await new Promise<number>((ok) => spawn("/bin/bash", [join(ROOT, "scripts", "daily", "run.sh"), "proxy-alerts"], { env, stdio: "ignore" }).on("exit", (c) => ok(c ?? -1)));
    assert.equal(code, 0);
    assert.match(readFileSync(alertsFile, "utf8"), /proxy-alerts: the previous run still holds .*proxy-alerts\.lock/);
  } finally {
    holder.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
