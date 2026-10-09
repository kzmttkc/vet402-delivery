/**
 * 0.2.0, with no network: diagnose (Solana and Base payments from fixed RPC answers, next to vet402's
 * purchases in the fixtures), the 402 against what vet402 paid (price_jump, payto_differs, asset_unseen),
 * named reasons and the hook's policy, --explain, and the MCP tool. Transaction ids for the buyer's own
 * payments are made at run time from a hash, so no made-up id sits in a file.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import type { Rpc } from "../../../src/chain.js";
import { classifyFailure } from "../../../src/rank/classify.js";
import { lookup } from "../src/check.js";
import { formatCheck, main } from "../src/cli.js";
import { diagnose, formatDiagnose, readBasePayment, type DiagnoseResult } from "../src/diagnose.js";
import { CheckBlockedError, CheckNeedsApprovalError, wrapFetchWithCheck, type CheckEvent } from "../src/hook.js";
import { handleMessage, TOOLS } from "../src/mcp.js";
import { applyPolicy, compareOffer, type RecordedPayment } from "../src/reasons.js";
import { PublicData } from "../src/sources.js";

const FX = join(import.meta.dirname, "fixtures");
const json = (f: string) => JSON.parse(readFileSync(join(FX, f), "utf8")) as any;
const RANK = json("verdict-rank.json");
const INDEX = json("verdict-records-index.json");
const NOTIFIED = json("verdict-notified.json");
const LANES = ["arbitrum", "robinhood"].map((l) => json(`verdict-lane-${l}.json`));
const RECORDED_TX = json("solana-rpc.json")["getTransaction snofPqfZEQ4NyfDepxepVUoYbfBujeq5C6uuK2xQFE38EYzk6yKkvEwvZKUa3cBjniN8QXQAdRZwjWWuQ9m4f8a"];

const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const XONA = "https://api.xona-agent.com/token/pumpfun-trending";
const XONA_PAYTO = "9VaDVp1Wb78G4Wm6VuTiMrpESjrUymXefQTHcJGRSTEA";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes: Buffer): string {
  let n = BigInt(`0x${bytes.toString("hex")}`);
  let s = "";
  while (n > 0n) (s = B58[Number(n % 58n)]! + s), (n /= 58n);
  for (const b of bytes) if (b === 0) s = `1${s}`;
  else break;
  return s;
}
/** A Solana-shaped signature (64 bytes) or address (32 bytes), made from a label. */
const sig = (label: string) => base58(createHash("sha512").update(label).digest());
const addr = (label: string) => base58(createHash("sha256").update(label).digest());
const evmHash = (label: string) => `0x${createHash("sha256").update(label).digest("hex")}`;

/** PublicData over the fixtures; `rank` can be a changed copy (served from memory through a fake loopback fetch). */
function data(rank: unknown = RANK, index: unknown = INDEX, reads: string[] = []): PublicData {
  const files: Record<string, unknown> = { "http://127.0.0.1/rank.json": rank, "http://127.0.0.1/index.json": index };
  for (const f of readdirSync(join(FX, "records"))) files[`http://127.0.0.1/records/${f}`] = JSON.parse(readFileSync(join(FX, "records", f), "utf8"));
  return new PublicData({
    sources: { rank: "http://127.0.0.1/rank.json", recordsIndex: "http://127.0.0.1/index.json", recordsBase: "http://127.0.0.1/records", lanes: [], notified: join(FX, "verdict-notified.json") },
    fetch: async (u: string) => (reads.push(u), u in files ? new Response(JSON.stringify(files[u])) : new Response("not found", { status: 404 })),
  });
}

/** A getTransaction answer: the recorded XONA purchase with another signature, time, payer and payee. */
function solanaTx(o: { at: string; payTo?: string; payer?: string; amount?: string; err?: unknown; mint?: string }): unknown {
  const t = structuredClone(RECORDED_TX);
  if (o.mint) for (const b of [...t.meta.preTokenBalances, ...t.meta.postTokenBalances]) b.mint = o.mint;
  t.blockTime = Math.floor(Date.parse(o.at) / 1000);
  const payTo = o.payTo ?? XONA_PAYTO;
  const payer = o.payer ?? addr("buyer");
  const amount = BigInt(o.amount ?? "100000");
  t.meta.preTokenBalances[0].owner = payTo;
  t.meta.postTokenBalances[0].owner = payTo;
  t.meta.preTokenBalances[1].owner = payer;
  t.meta.postTokenBalances[1].owner = payer;
  t.meta.preTokenBalances[0].uiTokenAmount.amount = "0";
  t.meta.postTokenBalances[0].uiTokenAmount.amount = String(amount);
  t.meta.preTokenBalances[1].uiTokenAmount.amount = "5000000";
  t.meta.postTokenBalances[1].uiTokenAmount.amount = String(5000000n - amount);
  if (o.err !== undefined) {
    t.meta.err = o.err;
    t.meta.postTokenBalances = structuredClone(t.meta.preTokenBalances);
  }
  return t;
}

const rpcWith =
  (answers: Record<string, unknown | (() => unknown)>): ((network: string) => Rpc) =>
  () =>
  async (method) => {
    const a = answers[method];
    if (a === undefined) throw new Error(`no answer for ${method}`);
    return typeof a === "function" ? (a as () => unknown)() : structuredClone(a);
  };

const neverSeller = (d: DiagnoseResult) => {
  assert.notEqual(d.fault, "seller_side", JSON.stringify(d.reasons));
  assert.equal(d.evidence, null, "no evidence pack when the seller is not named");
};

// ---- criterion 2: a payment that did not settle never names the seller ----

test("diagnose: a payment that failed on chain for lack of funds is buyer_side; another failure is undetermined; neither names the seller", async () => {
  const tx = sig("buyer-no-funds");
  const funds = await diagnose({ tx, url: XONA, status: 500 }, data(), {
    rpcFor: rpcWith({ getTransaction: solanaTx({ at: "2026-09-29T09:00:00Z", err: { InstructionError: [2, { Custom: 1 }] } }) }),
  });
  assert.equal(funds.fault, "buyer_side");
  assert.equal(funds.payment?.settled, false);
  assert.equal(funds.reasons[0]?.code, "insufficient_funds");
  neverSeller(funds);
  const other = await diagnose({ tx, url: XONA, status: 500 }, data(), {
    rpcFor: rpcWith({ getTransaction: solanaTx({ at: "2026-09-29T09:00:00Z", err: { InstructionError: [0, "InvalidAccountData"] } }) }),
  });
  assert.equal(other.fault, "undetermined");
  assert.equal(other.reasons[0]?.code, "payment_failed_on_chain");
  neverSeller(other);
});

// ---- criterion 3: settled, and vet402's own purchases in the window also failed: seller_side with evidence ----

test("diagnose: settled to XONA's payTo, HTTP 500, vet402's purchases within 24 hours also paid and unanswered: seller_side with an evidence pack", async () => {
  const tx = sig("buyer-paid-xona");
  const d = await diagnose({ tx, url: XONA, status: 500 }, data(), { rpcFor: rpcWith({ getTransaction: solanaTx({ at: "2026-09-29T09:00:00Z" }) }), now: Date.parse("2026-09-29T12:00:00Z") });
  assert.equal(d.fault, "seller_side", JSON.stringify(d.reasons));
  assert.equal(d.payment?.settled, true);
  assert.equal(d.payment?.payTo, XONA_PAYTO);
  assert.equal(d.payment?.amount, "100000");
  assert.equal(d.payment?.asset, USDC);
  assert.equal(d.payment?.at, "2026-09-29T09:00:00.000Z");
  assert.equal(d.seller.payToRecorded, true);
  assert.equal(d.rule?.id, "paid_not_delivered");
  assert.deepEqual(
    d.vet402.inWindow.map((p) => p.at),
    ["2026-09-30T02:20:28.238Z", "2026-09-29T10:10:06.071Z", "2026-09-29T08:18:22.097Z"],
    "only purchases within 24 hours, newest first",
  );
  assert.ok(d.vet402.inWindow.every((p) => p.result === "paid_not_delivered" && p.explorer?.startsWith("https://solscan.io/tx/")));
  assert.deepEqual(
    d.reasons.map((r) => r.code),
    ["paid_not_delivered", "vet402_same_failure_in_window"],
  );
  const e = d.evidence!;
  assert.equal(e.json.kind, "vet402-diagnose-evidence");
  assert.equal(e.json.payment.tx, tx);
  assert.equal(e.json.answerSeen.httpStatus, 500);
  assert.equal(e.json.vet402Purchases.length, 3);
  assert.ok(e.json.vet402Records.some((r) => r.id === "obs_2026-09-29_000210" && r.page.endsWith("/records/obs_2026-09-29_000210.html")), "the signed records of those days");
  assert.equal(e.json.preparedAt, "2026-09-29T12:00:00.000Z");
  assert.match(e.markdown, /^# Paid x402 call with no answer: api\.xona-agent\.com\n/);
  assert.ok(e.markdown.includes(`https://solscan.io/tx/${tx}`));
  assert.match(e.markdown, /Nothing was sent to anyone\.\n$/);
  assert.ok(e.markdown.includes("- HTTP status reported by the buyer: 500"), "the status is the buyer's report");
  assert.match(e.json.rule!.text, /^The buyer's payment settled, then the seller answered 5xx/);
  assert.ok(!e.json.rule!.text.includes("vet402's payment"));
  assert.match(formatDiagnose(d), /^fault: seller_side\n/);
});

test("diagnose: the rule is vet402's own (src/rank/classify.ts), imported: the same input gives the same rule", async () => {
  for (const status of [500, 502, 402, 404, 429]) {
    const d = await diagnose({ tx: sig(`rule-${status}`), url: XONA, status }, data(), { rpcFor: rpcWith({ getTransaction: solanaTx({ at: "2026-09-29T09:00:00Z" }) }) });
    const c = classifyFailure({
      chain: "solana", source: "t", host: "api.xona-agent.com", service: null, url: XONA, payTo: XONA_PAYTO, expectedPayTo: null, at: "", tried: true, settled: true, delivered: false,
      category: "settled_error_status", rawReason: `http ${status}`, detail: null, tx: null, priceUsdc: null, httpStatus: status, declaredMatch: null, bodyChecked: false, feedbackTx: null,
    });
    assert.deepEqual([d.rule?.id, d.rule?.fault], [c.rule, c.fault], String(status));
    if (c.fault !== "seller") neverSeller(d);
  }
});

// ---- criterion 4: settled, but vet402's purchases in the window were delivered ----

test("diagnose: settled and HTTP 500, but vet402 got an answer from the seller within 24 hours: not seller_side, and says why", async () => {
  const rank = structuredClone(RANK);
  const xona = rank.groups[0].ranking.find((s: any) => s.key === "api.xona-agent.com");
  for (const r of [...xona.recent, ...xona.sellerFailures]) if (r.at === "2026-09-29T10:10:06.071Z") Object.assign(r, { delivered: true, fault: undefined, rule: undefined, category: "delivered", httpStatus: 200 });
  xona.sellerFailures = xona.sellerFailures.filter((r: any) => r.at !== "2026-09-29T10:10:06.071Z");
  const d = await diagnose({ tx: sig("buyer-paid-xona"), url: XONA, status: 500 }, data(rank), { rpcFor: rpcWith({ getTransaction: solanaTx({ at: "2026-09-29T09:00:00Z" }) }) });
  assert.equal(d.fault, "undetermined");
  assert.ok(d.reasons.some((r) => r.code === "vet402_delivered_in_window" && r.detail.includes("2026-09-29T10:10:06.071Z")), JSON.stringify(d.reasons));
  neverSeller(d);
});

test("diagnose: other shortfalls stay undetermined: no status, a 4xx, another payTo, no vet402 purchase in the window, a 2xx", async () => {
  const run = (o: { status?: number; at?: string; payTo?: string }) =>
    diagnose({ tx: sig("short"), url: XONA, ...(o.status !== undefined ? { status: o.status } : {}) }, data(), {
      rpcFor: rpcWith({ getTransaction: solanaTx({ at: o.at ?? "2026-09-29T09:00:00Z", ...(o.payTo ? { payTo: o.payTo } : {}) }) }),
    });
  const cases: [Promise<DiagnoseResult>, string][] = [
    [run({}), "status_not_given"],
    [run({ status: 404 }), "paid_then_4xx"],
    [run({ status: 500, payTo: addr("someone-else") }), "payto_differs"],
    [run({ status: 500, at: "2026-10-20T00:00:00Z" }), "no_vet402_purchase_in_window"],
    [run({ status: 200 }), "answered_2xx"],
  ];
  for (const [p, code] of cases) {
    const d = await p;
    assert.equal(d.fault, "undetermined", code);
    assert.equal(d.reasons[0]?.code === code || d.reasons.some((r) => r.code === code), true, `${code}: ${JSON.stringify(d.reasons)}`);
    neverSeller(d);
  }
  const far = await run({ status: 500, at: "2026-10-20T00:00:00Z" });
  assert.equal(far.vet402.inWindow.length, 0);
  assert.equal(far.vet402.nearest[0]?.at, "2026-10-01T01:25:07.337Z", "the nearest purchases are shown");
});

// ---- criterion 5: RPC down, tx not found ----

test("diagnose: the RPC is down or has no such transaction: undetermined, no exception, the RPC URL not printed", async () => {
  const down = await diagnose({ tx: sig("down"), url: XONA, status: 500 }, data(), {
    rpcFor: () => async () => {
      throw new Error("fetch failed for https://rpc.example/?api-key=abc123");
    },
  });
  assert.equal(down.fault, "undetermined");
  assert.equal(down.payment?.read, "rpc_error");
  assert.equal(down.reasons[0]?.code, "tx_not_read");
  assert.ok(!JSON.stringify(down).includes("api-key"), "an RPC URL (which can hold a key) is not repeated");
  neverSeller(down);
  const missing = await diagnose({ tx: sig("missing"), url: XONA, status: 500 }, data(), { rpcFor: rpcWith({ getTransaction: () => null }) });
  assert.equal(missing.fault, "undetermined");
  assert.equal(missing.payment?.read, "not_found");
  assert.equal(missing.reasons[0]?.code, "tx_not_found");
  neverSeller(missing);
  const noRecord = await diagnose({ tx: sig("x"), url: XONA, status: 500 }, new PublicData({ sources: { rank: "http://127.0.0.1/none.json", recordsIndex: "http://127.0.0.1/none.json", recordsBase: FX, lanes: [], notified: "" }, fetch: () => Promise.reject(new Error("offline")) }), {
    rpcFor: rpcWith({ getTransaction: solanaTx({ at: "2026-09-29T09:00:00Z" }) }),
  });
  assert.equal(noRecord.fault, "undetermined", "vet402's record unreadable: nothing to compare with");
  assert.ok(noRecord.notes.some((n) => n.startsWith("vet402's public record could not be read")));
  await assert.rejects(diagnose({ tx: "not-a-tx", url: XONA }, data()), /neither a Solana signature nor a Base tx hash/);
});

test("diagnose on Base: Transfer log read for payTo, amount, asset and time; a reverted transaction is never seller_side", async () => {
  const tx = evmHash("base-payment");
  const token = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const to = "0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0";
  const from = "0x00000000000000000000000000000000000000b1";
  const pad = (a: string) => `0x${a.slice(2).padStart(64, "0")}`;
  const receipt = (status: string) => ({
    status,
    blockNumber: "0x10",
    logs: [{ address: token, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", pad(from), pad(to)], data: `0x${(10000).toString(16).padStart(64, "0")}` }],
  });
  const ok = await readBasePayment(rpcWith({ eth_getTransactionReceipt: receipt("0x1"), eth_getBlockByNumber: { timestamp: "0x68dbbf00" } })("eip155:8453"), tx);
  assert.deepEqual([ok.settled, ok.payTo, ok.payer, ok.amount, ok.asset, ok.at], [true, to, from, "10000", token, new Date(0x68dbbf00 * 1000).toISOString()]);
  const reverted = await diagnose({ tx, url: "https://agent402.tools/api/crypto-trending", status: 500 }, data(), { rpcFor: rpcWith({ eth_getTransactionReceipt: receipt("0x0"), eth_getBlockByNumber: { timestamp: "0x68dbbf00" } }) });
  assert.equal(reverted.payment?.chain, "base");
  assert.equal(reverted.payment?.settled, false);
  neverSeller(reverted);
});

// ---- review fixes: what rank.json's short list cannot show ----

test("diagnose: a DELIVERED signed record of the window's days keeps it undetermined (rank.json may no longer list that purchase)", async () => {
  const index = structuredClone(INDEX);
  const tmpl = index.records.find((e: any) => e.day === "2026-09-29");
  index.records.push({ ...tmpl, id: "obs_2026-09-29_999999", verdict: "DELIVERED", resourceUrl: XONA, host: "api.xona-agent.com", seller: "api.xona-agent.com", network: SOLANA });
  const d = await diagnose({ tx: sig("buyer-paid-xona"), url: XONA, status: 500 }, data(RANK, index), { rpcFor: rpcWith({ getTransaction: solanaTx({ at: "2026-09-29T09:00:00Z" }) }) });
  assert.equal(d.fault, "undetermined");
  assert.ok(d.reasons.some((r) => r.code === "vet402_delivered_record_in_window_days" && r.detail.includes("obs_2026-09-29_999999")), JSON.stringify(d.reasons));
  neverSeller(d);
});

test("diagnose: a payment older than rank.json's recent list reaches stays undetermined, even when only failures are listed for its days", async () => {
  const rank = structuredClone(RANK);
  const xona = rank.groups[0].ranking.find((s: any) => s.key === "api.xona-agent.com");
  // recent keeps only the newest purchases; sellerFailures still lists the older failures.
  xona.recent = xona.recent.filter((r: any) => r.at >= "2026-09-30");
  const d = await diagnose({ tx: sig("old-payment"), url: XONA, status: 500 }, data(rank), { rpcFor: rpcWith({ getTransaction: solanaTx({ at: "2026-09-29T09:00:00Z" }) }) });
  assert.ok(d.vet402.inWindow.length > 0, "the older failures are still in the window");
  assert.equal(d.fault, "undetermined");
  assert.ok(d.reasons.some((r) => r.code === "vet402_list_does_not_cover_window"), JSON.stringify(d.reasons));
  neverSeller(d);
});

test("diagnose: the same seller on two pages, only the other chain's page listing older purchases: undetermined (the reach is per chain)", async () => {
  const SYRAA = "https://api.syraa.fun/assets";
  const SYRAA_PAYTO = "53JhuF8bgxvUQ59nDG6kWs4awUQYCS3wswQmUsV5uC7t";
  const pay = () => ({ rpcFor: rpcWith({ getTransaction: solanaTx({ at: "2026-09-30T10:00:00Z", payTo: SYRAA_PAYTO }) }) });
  const pages = (rank: any) => rank.groups.filter((g: any) => g.ranking.some((s: any) => s.key === "api.syraa.fun")).map((g: any) => g.id);
  assert.deepEqual(pages(RANK), ["main", "algorand"], "syraa is on the Solana, Tempo and Base page and on the Algorand page");
  // Control: the Solana page's own list reaches back past the window, and its purchases there failed: seller_side.
  const full = await diagnose({ tx: sig("syraa"), url: SYRAA, status: 503 }, data(), pay());
  assert.equal(full.fault, "seller_side", JSON.stringify(full.reasons));
  // The Solana page lists only from 2026-09-30T02:18; the Algorand page's list reaches 2026-09-27.
  const rank = structuredClone(RANK);
  const main = rank.groups.find((g: any) => g.id === "main").ranking.find((s: any) => s.key === "api.syraa.fun");
  main.recent = main.recent.filter((r: any) => r.at >= "2026-09-30");
  const d = await diagnose({ tx: sig("syraa"), url: SYRAA, status: 503 }, data(rank), pay());
  assert.equal(d.fault, "undetermined");
  assert.ok(d.reasons.some((r) => r.code === "vet402_list_does_not_cover_window" && r.detail.includes("back to 2026-09-30T02:18")), JSON.stringify(d.reasons));
  assert.ok(d.vet402.inWindow.every((p) => p.chain === "solana"), "the purchases compared are this chain's only");
  neverSeller(d);
});

test("diagnose: two services on one host and a URL that matches neither: the payee picks the service; not one: undetermined", async () => {
  const rank = structuredClone(RANK);
  const b = rank.groups[0].ranking.find((x: any) => x.key === "api.xona-agent.com");
  const a = structuredClone(b);
  // A owns the payTo and has no purchase in the window; B (another payTo) failed in the window.
  Object.assign(a, { key: "api.xona-agent.com#a", service: "a", payTos: [XONA_PAYTO], sellerFailures: [], lastFailure: null });
  a.recent = [{ at: "2026-09-27T00:00:00.000Z", chain: "solana", url: "https://api.xona-agent.com/a/x", delivered: true, category: "delivered", tx: null }];
  a.last = a.recent[0];
  Object.assign(b, { key: "api.xona-agent.com#b", service: "b", payTos: [addr("service-b")] });
  for (const row of [...b.recent, ...b.sellerFailures, b.last, b.lastFailure].filter(Boolean)) row.url = "https://api.xona-agent.com/b/y";
  rank.groups[0].ranking.push(a);
  const pay = (payTo: string) => ({ rpcFor: rpcWith({ getTransaction: solanaTx({ at: "2026-09-29T09:00:00Z", payTo }) }) });
  const unmatched = await diagnose({ tx: sig("2svc"), url: "https://api.xona-agent.com/zzz/q", status: 500 }, data(rank), pay(XONA_PAYTO));
  assert.equal(unmatched.fault, "undetermined", JSON.stringify(unmatched.reasons));
  assert.deepEqual(unmatched.seller.keys, ["api.xona-agent.com#a"], "the payee narrows the host to service A");
  assert.ok(!unmatched.vet402.inWindow.some((p) => p.seller === "api.xona-agent.com#b"), "service B's failures are not compared");
  neverSeller(unmatched);
  // The payee is a payTo of neither service: no one service to compare with.
  const neither = await diagnose({ tx: sig("2svc"), url: "https://api.xona-agent.com/zzz/q", status: 500 }, data(rank), pay(addr("nobody")));
  assert.equal(neither.fault, "undetermined");
  assert.equal(neither.reasons[0]?.code, "payto_not_unique_to_one_service");
  neverSeller(neither);
  // Both services list the payee: not one service either.
  b.payTos = [XONA_PAYTO];
  const both = await diagnose({ tx: sig("2svc"), url: "https://api.xona-agent.com/zzz/q", status: 500 }, data(rank), pay(XONA_PAYTO));
  assert.equal(both.reasons[0]?.code, "payto_not_unique_to_one_service");
  neverSeller(both);
});

test("diagnose: vet402's own payment is left out of the window and of the signed records; Base hashes match without case", async () => {
  const own = "snofPqfZEQ4NyfDepxepVUoYbfBujeq5C6uuK2xQFE38EYzk6yKkvEwvZKUa3cBjniN8QXQAdRZwjWWuQ9m4f8a"; // obs_2026-09-28_000164
  const d = await diagnose({ tx: own, url: XONA, status: 500 }, data(), { rpcFor: rpcWith({ getTransaction: solanaTx({ at: "2026-09-28T08:28:55Z" }) }) });
  assert.ok(!d.vet402.records.some((r) => r.id === "obs_2026-09-28_000164"), JSON.stringify(d.vet402.records.map((r) => r.id)));
  assert.ok(![...d.vet402.inWindow, ...d.vet402.nearest].some((p) => p.tx === own));
  const fixRank = JSON.parse(readFileSync(join(FX, "rank.json"), "utf8"));
  const baseTx = "0x2c9f52315eeb527428dc2592edb469548b4dfcfd5ad745a3e145a05ed9802490";
  const upper = `0x${baseTx.slice(2).toUpperCase()}`;
  const receipt = { status: "0x1", blockNumber: "0x10", logs: [] };
  const b = await diagnose({ tx: upper, url: "https://agent402.tools/api/crypto-trending", status: 500 }, data(fixRank, json("records-index.json")), {
    rpcFor: rpcWith({ eth_getTransactionReceipt: receipt, eth_getBlockByNumber: { timestamp: `0x${Math.floor(Date.parse("2026-09-28T08:16:44Z") / 1000).toString(16)}` } }),
  });
  assert.ok(![...b.vet402.inWindow, ...b.vet402.nearest].some((p) => p.tx?.toLowerCase() === baseTx), "the same Base tx in another case is the same payment");
});

test("diagnose: a payment in an asset vet402 never paid the seller in, or below the least vet402 paid, is undetermined", async () => {
  const other = await diagnose({ tx: sig("other-asset"), url: XONA, status: 500 }, data(), {
    rpcFor: rpcWith({ getTransaction: solanaTx({ at: "2026-09-29T09:00:00Z", mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" }) }),
  });
  assert.equal(other.fault, "undetermined");
  assert.equal(other.reasons[0]?.code, "asset_unseen");
  neverSeller(other);
  const low = await diagnose({ tx: sig("low-amount"), url: XONA, status: 500 }, data(), { rpcFor: rpcWith({ getTransaction: solanaTx({ at: "2026-09-29T09:00:00Z", amount: "50000" }) }) });
  assert.equal(low.fault, "undetermined");
  assert.equal(low.reasons[0]?.code, "amount_below_recorded");
  assert.match(low.reasons[0]!.detail, /less than the least vet402 paid for this URL \(100000\)/);
  neverSeller(low);
});

// ---- criterion 6: the 402 against what vet402 paid ----

const paid = (amount: string, o: Partial<RecordedPayment> = {}): RecordedPayment => ({
  id: "obs_2026-09-28_000164", day: "2026-09-28", at: null, url: XONA, network: SOLANA, payTo: XONA_PAYTO, asset: USDC, amount, tx: "snofPqfZEQ4NyfDepxepVUoYbfBujeq5C6uuK2xQFE38EYzk6yKkvEwvZKUa3cBjniN8QXQAdRZwjWWuQ9m4f8a", verdict: "NOT_DELIVERED", json: "x", ...o,
});

test("compare: more than 10 times what vet402 paid is price_jump; 10 and 9 times are not; another asset is asset_unseen", () => {
  const records = [paid("100000"), paid("50000")];
  const at = (amount: string, asset = USDC) => compareOffer({ url: XONA, chain: "solana", amount, asset }, records).hits.map((h) => h.reason);
  assert.deepEqual(at("1000001"), ["price_jump"], "just over 10x");
  assert.deepEqual(at("1000000"), [], "exactly 10x");
  assert.deepEqual(at("900000"), [], "9x");
  assert.deepEqual(at("100000"), []);
  assert.deepEqual(at("100", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"), ["asset_unseen"]);
  const c = compareOffer({ url: XONA, chain: "solana", amount: "10000000", asset: USDC }, records);
  assert.equal(c.comparison.priceReference?.amount, "100000", "the highest amount paid is the reference");
  assert.equal(c.comparison.ratio, 100);
  assert.match(c.hits[0]!.detail, /100 times the most vet402 paid for this URL \(100000 on 2026-09-28, tx snofPq/);
  assert.deepEqual(compareOffer({ url: "https://api.xona-agent.com/other", chain: "solana", amount: "99999999", asset: USDC }, records).hits, [], "no record for this URL: no price_jump");
  assert.deepEqual(compareOffer({ url: XONA, chain: "solana", amount: "99999999", asset: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" }, []).hits, [], "no record at all: nothing said");
});

test("compare through the lookup: the signed record's amount, the 402's payTo (payto_differs), and the comparison facts", async () => {
  const d = data();
  const { checkBeforePaying } = await import("../src/check.js");
  const jump = await checkBeforePaying({ url: XONA, chain: "solana", amount: "1000001", asset: USDC }, d);
  assert.ok(jump.reasons.some((r) => r.reason === "price_jump"), JSON.stringify(jump.reasons));
  assert.equal(jump.comparison?.priceReference?.amount, "100000");
  const nine = await checkBeforePaying({ url: XONA, chain: "solana", amount: "900000", asset: USDC }, d);
  assert.ok(!nine.reasons.some((r) => r.reason === "price_jump"));
  assert.equal(nine.comparison?.ratio, 9);
  const other = await checkBeforePaying({ url: XONA, chain: "solana", payTo: addr("impostor") }, d);
  assert.ok(other.reasons.some((r) => r.reason === "payto_differs"));
  const same = await checkBeforePaying({ url: XONA, chain: "solana", payTo: XONA_PAYTO }, d);
  assert.ok(!same.reasons.some((r) => r.reason === "payto_differs"));
});

// ---- reasons ----

test("reasons: never_bought, stale, paid_not_delivered only for a seller vet402 has told (the avoid gate)", () => {
  const now = Date.parse("2026-10-20T00:00:00Z");
  const nobody = lookup(RANK, INDEX, { url: "https://nobody.example/x" }, [], LANES, NOTIFIED, { now });
  assert.deepEqual(nobody.reasons.map((r) => r.reason), ["never_bought"]);
  const xona = lookup(RANK, INDEX, { url: XONA, chain: "solana" }, [], LANES, NOTIFIED, { now });
  assert.deepEqual(xona.reasons.map((r) => r.reason).sort(), ["paid_not_delivered", "stale"]);
  assert.match(xona.reasons.find((r) => r.reason === "paid_not_delivered")!.detail, /^vet402's newest paid purchase from api\.xona-agent\.com on solana \(2026-10-01, tx .+\) settled and came back with no answer \(HTTP 500\); 6 of the 6 newest paid purchases listed did the same\.$/);
  const fresh = lookup(RANK, INDEX, { url: XONA, chain: "solana" }, [], LANES, NOTIFIED, { now: Date.parse("2026-10-02T00:00:00Z") });
  assert.ok(!fresh.reasons.some((r) => r.reason === "stale"));
  // syraa: the same failures, not told. No paid_not_delivered, and no word of a held verdict.
  const syraa = lookup(RANK, INDEX, { url: "https://api.syraa.fun/assets", chain: "solana" }, [], LANES, NOTIFIED, { now: Date.parse("2026-10-02T00:00:00Z") });
  assert.deepEqual(syraa.reasons, []);
  assert.ok(!JSON.stringify(syraa).includes('"avoid"'));
  assert.ok(!/\b(avoid|held)\b/i.test(formatCheck(syraa).replace(/not enough to say pay or avoid\./g, "")));
});

test("policy: the strictest action wins; a reason left out is allow", () => {
  const hits = [
    { reason: "stale" as const, detail: "a", evidence: [] },
    { reason: "price_jump" as const, detail: "b", evidence: [] },
  ];
  assert.equal(applyPolicy({}, hits).action, "allow");
  assert.equal(applyPolicy({ stale: "warn" }, hits).action, "warn");
  assert.equal(applyPolicy({ stale: "warn", price_jump: "ask_human" }, hits).action, "ask_human");
  assert.equal(applyPolicy({ stale: "block", price_jump: "ask_human" }, hits).action, "block");
});

// ---- the hook with a policy (real @x402/fetch, a spy signer) ----

function x402Server(url: string, payTo: string, amount: string): typeof fetch {
  const required = {
    x402Version: 2,
    resource: { url, description: "test", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: SOLANA, amount, asset: USDC, payTo, maxTimeoutSeconds: 60, extra: { feePayer: "11111111111111111111111111111111" } }],
  };
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (h.has("payment-signature") || h.has("x-payment")) return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 402, headers: { "content-type": "application/json", "payment-required": Buffer.from(JSON.stringify(required)).toString("base64") } });
  }) as typeof fetch;
}
function spyClient(): { client: x402Client; signed: () => number } {
  let n = 0;
  const client = x402Client.fromConfig({
    spendControls: false,
    schemes: [{ network: SOLANA, client: { scheme: "exact", createPaymentPayload: async (x402Version: number) => (n++, { x402Version, payload: { transaction: "signed-by-the-spy" } }) } }],
  });
  return { client, signed: () => n };
}

test("hook policy: price_jump blocks before signing; without a policy the same 402 is paid and only the rank.json reasons are in the event", async () => {
  const spy = spyClient();
  const pay = wrapFetchWithPayment(wrapFetchWithCheck(x402Server(XONA, XONA_PAYTO, "10000000"), { data: data(), policy: { price_jump: "block" } }) as typeof fetch, spy.client);
  await assert.rejects(pay(XONA), (e: unknown) => e instanceof CheckBlockedError && e.reasons.some((r) => r.reason === "price_jump") && /the policy blocks price_jump/.test(e.message));
  assert.equal(spy.signed(), 0);
  const events: CheckEvent[] = [];
  const spy2 = spyClient();
  const free = wrapFetchWithPayment(wrapFetchWithCheck(x402Server(XONA, XONA_PAYTO, "10000000"), { data: data(), onCheck: (e) => void events.push(e) }) as typeof fetch, spy2.client);
  assert.equal((await free(XONA)).status, 200);
  assert.equal(spy2.signed(), 1, "no policy: decided as in 0.1.2 (XONA is not stopped without block)");
  assert.ok(!events[0]!.reasons.some((r) => r.reason === "price_jump"), "no policy: no signed record read, no price comparison");
  assert.ok(events[0]!.reasons.some((r) => r.reason === "paid_not_delivered"), "the reasons from rank.json alone are there");
  assert.equal(events[0]!.decision, null);
});

test("hook without a policy reads no signed record (the same reads as 0.1.2); with one it does", async () => {
  for (const policy of [undefined, { price_jump: "block" as const }]) {
    const reads: string[] = [];
    const spy = spyClient();
    const pay = wrapFetchWithPayment(wrapFetchWithCheck(x402Server(XONA, XONA_PAYTO, "100000"), { data: data(RANK, INDEX, reads), ...(policy ? { policy } : { onCheck: () => undefined }) }) as typeof fetch, spy.client);
    assert.equal((await pay(XONA)).status, 200);
    const recordReads = reads.filter((u) => u.includes("/records/")).length;
    if (policy) assert.ok(recordReads > 0, "with a policy the signed records are read");
    else assert.equal(recordReads, 0, "without a policy no signed record is read");
  }
});

test("hook policy: payto_differs blocks; ask_human asks and goes on only on true; with no askHuman it stops; warn goes on", async () => {
  const spy = spyClient();
  const other = wrapFetchWithPayment(wrapFetchWithCheck(x402Server(XONA, addr("impostor"), "100000"), { data: data(), policy: { payto_differs: "block" } }) as typeof fetch, spy.client);
  await assert.rejects(other(XONA), (e: unknown) => e instanceof CheckBlockedError && e.reasons[0]?.reason === "payto_differs");
  assert.equal(spy.signed(), 0);
  const NEW = "https://nobody.example/paid";
  const asked: CheckEvent[] = [];
  for (const answer of [false, true]) {
    const s = spyClient();
    const f = wrapFetchWithPayment(wrapFetchWithCheck(x402Server(NEW, addr("new-seller"), "1000"), { data: data(), policy: { never_bought: "ask_human" }, askHuman: (e) => (asked.push(e), answer) }) as typeof fetch, s.client);
    if (answer) assert.equal((await f(NEW)).status, 200);
    else await assert.rejects(f(NEW), (e: unknown) => e instanceof CheckNeedsApprovalError && e instanceof CheckBlockedError);
    assert.equal(s.signed(), answer ? 1 : 0);
  }
  assert.equal(asked.length, 2);
  assert.equal(asked[0]!.decision?.action, "ask_human");
  const s3 = spyClient();
  const noHuman = wrapFetchWithPayment(wrapFetchWithCheck(x402Server(NEW, addr("new-seller"), "1000"), { data: data(), policy: { never_bought: "ask_human" } }) as typeof fetch, s3.client);
  await assert.rejects(noHuman(NEW), CheckNeedsApprovalError);
  assert.equal(s3.signed(), 0);
  const s4 = spyClient();
  const warn = wrapFetchWithPayment(wrapFetchWithCheck(x402Server(NEW, addr("new-seller"), "1000"), { data: data(), policy: { never_bought: "warn" } }) as typeof fetch, s4.client);
  assert.equal((await warn(NEW)).status, 200);
  assert.equal(s4.signed(), 1);
  assert.throws(() => wrapFetchWithCheck(fetch, { policy: { price_jumps: "block" } as never }), /unknown reason "price_jumps"/);
  assert.throws(() => wrapFetchWithCheck(fetch, { policy: { price_jump: "stop" } as never }), /is not one of allow, warn, block, ask_human/);
});

test('hook: block: "avoid" with a policy still throws the 0.1.2 error for XONA', async () => {
  const spy = spyClient();
  const pay = wrapFetchWithPayment(wrapFetchWithCheck(x402Server(XONA, XONA_PAYTO, "100000"), { data: data(), block: "avoid", policy: { stale: "warn" } }) as typeof fetch, spy.client);
  await assert.rejects(pay(XONA), (e: unknown) => e instanceof CheckBlockedError && e.reasons.length === 0 && /vet402's verdict for this seller is "avoid"/.test(e.message));
  assert.equal(spy.signed(), 0);
});

// ---- CLI and MCP ----

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const log = console.log;
  const err = console.error;
  const out: string[] = [];
  console.log = (s: string) => void out.push(String(s));
  console.error = (s: string) => void out.push(String(s));
  try {
    return { code: await fn(), out: out.join("\n") };
  } finally {
    console.log = log;
    console.error = err;
  }
}

test("CLI: --explain lists the purchases with date and tx; --amount compares; diagnose without --url is bad input", async () => {
  const ex = await capture(() => main([XONA, "--chain", "solana", "--explain", "--amount", "1000001", "--asset", USDC], data()));
  assert.equal(ex.code, 0, ex.out);
  assert.match(ex.out, /purchases listed in rank\.json/);
  assert.match(ex.out, /2026-10-01T01:25:07\.337Z solana paid_not_delivered HTTP 500 https:\/\/solscan\.io\/tx\//);
  assert.match(ex.out, /payments in signed records:\n {4}2026-09-28 NOT_DELIVERED paid 100000 of EPjF/);
  assert.match(ex.out, /reason price_jump: This 402 asks 1000001/);
  assert.equal((await capture(() => main(["diagnose", sig("x")], data()))).code, 2);
  assert.equal((await capture(() => main(["diagnose", sig("x"), "--url", XONA, "--status", "abc"], data()))).code, 2);
});

test("MCP: diagnose_failed_payment is listed, read-only, and answers with the fault", async () => {
  const tool = TOOLS.find((t) => t.name === "diagnose_failed_payment")!;
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.deepEqual(tool.inputSchema.required, ["tx", "url"]);
  const r = await handleMessage(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "diagnose_failed_payment", arguments: { tx: sig("buyer-paid-xona"), url: XONA, status: 500 } } },
    { data: data(), diagnose: { rpcFor: rpcWith({ getTransaction: solanaTx({ at: "2026-09-29T09:00:00Z" }) }) } },
  );
  const res = r!.result as { content: { text: string }[]; structuredContent: DiagnoseResult; isError?: boolean };
  assert.equal(res.isError, undefined);
  assert.equal(res.structuredContent.fault, "seller_side");
  assert.match(res.content[0]!.text, /^fault: seller_side\n/);
  const bad = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "diagnose_failed_payment", arguments: { tx: "nope", url: XONA } } }, { data: data() });
  assert.equal((bad!.result as { isError?: boolean }).isError, true);
});
