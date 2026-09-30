/**
 * vet402-check, with no network: the fixtures in fixtures/ are cut from the public data by
 * make-fixtures.ts (rank.json, the records index, two signed records byte for byte, and the Solana RPC
 * answers their verification reads).
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Challenge } from "mppx";
import type { Rpc } from "../../../src/chain.js";
import { sellerSlugs as siteSellerSlugs } from "../../../src/rank/html.js";
import { lookup, normalizeChain, sellerSlugs, type CheckResult } from "../src/check.js";
import { formatCheck, main } from "../src/cli.js";
import { carriesPayment, readOffers, wrapFetchWithCheck, type CheckEvent } from "../src/hook.js";
import { handleMessage, TOOLS } from "../src/mcp.js";
import { PublicData } from "../src/sources.js";
import { verifyRecord } from "../src/verify.js";

const PKG = join(import.meta.dirname, "..");
const FX = join(import.meta.dirname, "fixtures");
const rank = JSON.parse(readFileSync(join(FX, "rank.json"), "utf8")) as unknown;
const index = JSON.parse(readFileSync(join(FX, "records-index.json"), "utf8")) as unknown;
const rpcAnswers = JSON.parse(readFileSync(join(FX, "solana-rpc.json"), "utf8")) as Record<string, unknown>;

const XONA = "https://api.xona-agent.com/token/pumpfun-trending";
const XONA_PAYTO = "9VaDVp1Wb78G4Wm6VuTiMrpESjrUymXefQTHcJGRSTEA";
const NEG = "obs_2026-09-28_000164"; // XONA, NOT_DELIVERED
const POS = "obs_2026-09-28_000002"; // agent402.tools, DELIVERED

const fixtureData = (recordsBase = join(FX, "records")): PublicData =>
  new PublicData({
    sources: { rank: join(FX, "rank.json"), recordsIndex: join(FX, "records-index.json"), recordsBase },
    fetch: () => Promise.reject(new Error("no network in tests")),
  });

const replayRpc =
  (patch: (method: string, sig: string, answer: unknown) => unknown = (_m, _s, a) => a): ((network: string) => Rpc) =>
  () =>
  async (method, params) => {
    const sig = String(params[0]);
    const a = rpcAnswers[`${method} ${sig}`];
    if (a === undefined) throw new Error(`no recorded answer for ${method} ${sig}`);
    return patch(method, sig, structuredClone(a));
  };

// Words that would turn facts into advice. The check reports what vet402 recorded; it does not rate.
const ADVICE = /\b(safe|safer|unsafe|danger\w*|risk\w*|trust\w*|scam\w*|recommend\w*|avoid|should|reliable|legit\w*|fraud\w*)\b/i;

test("known seller with seller-side failures (XONA): counts, failure classes, grade, newest tx, negative records", () => {
  const r = lookup(rank, index, { url: XONA });
  assert.equal(r.found, true);
  const main = r.sellers.find((s) => s.page === "main")!;
  assert.equal(main.key, "api.xona-agent.com");
  assert.equal(main.tried, 4);
  assert.equal(main.settled, 4);
  assert.equal(main.delivered, 0);
  assert.deepEqual(main.sellerSideFailures, { paid_not_delivered: 4 });
  assert.equal(main.notCountedAgainstSeller.vet402OrFacilitator + main.notCountedAgainstSeller.causeUnknown, 0);
  assert.equal(main.grade, "measuring");
  assert.equal(main.last?.httpStatus, 500);
  assert.match(main.last?.explorer ?? "", /^https:\/\/solscan\.io\/tx\//);
  assert.equal(r.records.published, 3);
  assert.deepEqual(r.records.byVerdict, { NOT_DELIVERED: 3 });
  assert.equal(r.records.sameUrl, 3);
  assert.equal(r.records.newest[0]?.anchor?.status, "anchored");
  assert.match(r.summary, /4 settled, 0 came back with an answer/);
  assert.match(r.summary, /Grade: measuring/);
  assert.equal(main.sellerPage, "https://kzmttkc.github.io/vet402-delivery/seller/api.xona-agent.com.html");
});

test("known seller that delivered: Solana and Base on one page, Algorand on its own page", () => {
  const r = lookup(rank, index, { url: "https://agent402.tools/api/crypto-price" });
  assert.equal(r.found, true);
  const main = r.sellers.find((s) => s.page === "main")!;
  assert.equal(main.delivered, main.counted);
  assert.deepEqual(Object.keys(main.byChain).sort(), ["base", "solana"]);
  assert.deepEqual(r.records.byVerdict, { DELIVERED: 4 });
  const algo = r.sellers.find((s) => s.page === "algorand")!;
  assert.equal(algo.grade, "A");
  assert.ok(algo.notCountedAgainstSeller.vet402OrFacilitator > 0);
});

test("unknown seller: says vet402 has no record, and nothing else", () => {
  const r = lookup(rank, index, { url: "https://no-such-seller.example/api/x" });
  assert.equal(r.found, false);
  assert.deepEqual(r.sellers, []);
  assert.equal(r.records.published, 0);
  assert.match(r.summary, /^vet402 has no record of this seller: no-such-seller\.example is not in rank\.json of \d{4}-\d{2}-\d{2} and 14 published signed records\.$/);
});

test("chain filter: a chain vet402 did not buy on is reported as no record on that chain", () => {
  const r = lookup(rank, index, { url: "https://agent402.tools/api/crypto-price", chain: "tempo" });
  assert.equal(r.found, false);
  assert.match(r.summary, /no record of this seller on tempo: .* only for algorand, base, solana/);
  const b = lookup(rank, index, { url: "https://agent402.tools/api/crypto-price", chain: "eip155:8453" });
  assert.equal(b.found, true);
  assert.equal(b.asked.chain, "base");
  assert.deepEqual(b.sellers.map((s) => s.page), ["main"]);
  assert.equal(b.records.published, 1, "one signed record of agent402.tools on Base");
  assert.equal(b.records.newest[0]?.network, "eip155:8453");
  assert.throws(() => normalizeChain("eip155:1"), /unknown chain/);
});

test("payTo: the one vet402 recorded, and one it did not", () => {
  const same = lookup(rank, index, { url: XONA, payTo: XONA_PAYTO });
  assert.equal(same.payTo?.sameAsRecorded, true);
  const other = lookup(rank, index, { url: XONA, payTo: "11111111111111111111111111111111" });
  assert.equal(other.payTo?.sameAsRecorded, false);
  assert.match(other.summary, /is not one vet402 recorded for this seller \(9VaDVp1W/);
  const evmCase = lookup(rank, index, { url: "https://mpp.orthogonal.com/andi/v1/search", payTo: "0x09CBBB451CA48ED511C7FC07ED921D539CDE1227" });
  assert.equal(evmCase.payTo?.sameAsRecorded, true, "EVM addresses compare without case");
});

test("a shared host: the URL's path picks the service vet402 counts as its own seller", () => {
  const r = lookup(rank, index, { url: "https://mpp.orthogonal.com/andi/v1/search" });
  assert.deepEqual(r.sellers.map((s) => s.key), ["mpp.orthogonal.com#orth-andi"]);
  assert.ok(r.records.newest.every((x) => x.resourceUrl.startsWith("https://mpp.orthogonal.com/andi/")));
  const none = lookup(rank, index, { url: "https://mpp.orthogonal.com/other/path" });
  assert.equal(none.sellers.length, 2);
  assert.match(none.notes.join(" "), /fronts 2 services/);
});

test("seller page names follow the site's rule (src/rank/html.ts)", () => {
  const keys = ["api.xona-agent.com", "mpp.orthogonal.com#orth-andi", "A..B", ".x", "#", "a#b", "a_b"].sort();
  assert.deepEqual([...sellerSlugs(keys)], [...siteSellerSlugs(keys)]);
});

test("verify: a signed negative record passes every check, payment and Solana memo anchor included", async () => {
  const v = await verifyRecord(NEG, fixtureData(), { rpcFor: replayRpc() });
  assert.equal(v.result, "OK", JSON.stringify(v.lines, null, 1));
  assert.equal(v.verdict, "NOT_DELIVERED");
  for (const c of ["index", "key", "schema", "signature", "verdict", "merkle", "payment", "anchor"]) assert.equal(v.lines.find((l) => l.check === c)?.ok, true, c);
  const d = await verifyRecord(POS, fixtureData(), { rpcFor: replayRpc() });
  assert.equal(d.result, "OK");
  const off = await verifyRecord(NEG, fixtureData(), { offline: true });
  assert.equal(off.result, "OK_OFFLINE");
});

function tamperedCopy(id: string, edit: (text: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), "vet402-check-"));
  for (const f of readdirSync(join(FX, "records"))) copyFileSync(join(FX, "records", f), join(dir, f));
  const p = join(dir, `${id}.json`);
  writeFileSync(p, edit(readFileSync(p, "utf8")));
  return dir;
}

test("verify: one changed character in a signed field fails the signature and the index hash", async () => {
  const dir = tamperedCopy(NEG, (t) => t.replace('"code": "NOT_DELIVERED"', '"code": "DELIVERED"'));
  const v = await verifyRecord(NEG, fixtureData(dir), { offline: true });
  assert.equal(v.result, "FAIL");
  assert.equal(v.lines.find((l) => l.check === "index")?.ok, false);
  const one = tamperedCopy(NEG, (t) => t.replace("pumpfun-trending", "pumpfun-trendinG"));
  const w = await verifyRecord(NEG, fixtureData(one), { offline: true });
  assert.equal(w.result, "FAIL");
  assert.equal(w.lines.find((l) => l.check === "signature")?.ok, false);
});

test("verify: a changed Merkle proof fails merkle; a memo from another wallet fails anchor", async () => {
  const dir = tamperedCopy(NEG, (t) => {
    const o = JSON.parse(t);
    o.anchor.proof[0] = `0x${"00".repeat(32)}`;
    return JSON.stringify(o, null, 2);
  });
  const v = await verifyRecord(NEG, fixtureData(dir), { offline: true });
  assert.equal(v.lines.find((l) => l.check === "merkle")?.ok, false);
  assert.equal(v.result, "FAIL");
  const anchorTx = (JSON.parse(readFileSync(join(FX, "records", `${NEG}.json`), "utf8")) as { anchor: { tx: string } }).anchor.tx;
  const otherWallet = replayRpc((_m, sig, a) => {
    if (sig !== anchorTx) return a;
    const tx = a as { transaction: { message: { accountKeys: { pubkey: string }[] } } };
    tx.transaction.message.accountKeys[0]!.pubkey = "11111111111111111111111111111111";
    return tx;
  });
  const w = await verifyRecord(NEG, fixtureData(), { rpcFor: otherWallet });
  assert.equal(w.lines.find((l) => l.check === "anchor")?.ok, false);
  assert.equal(w.result, "FAIL");
});

// ---- the hook ----

const x402Body = { x402Version: 2, accepts: [{ scheme: "exact", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payTo: XONA_PAYTO, amount: "100000", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }] };

test("hook: a 402 is looked up before the client pays, and handed back as it came", async () => {
  const events: CheckEvent[] = [];
  const body = JSON.stringify(x402Body);
  const inner = async () => new Response(body, { status: 402, headers: { "content-type": "application/json" } });
  const wrapped = wrapFetchWithCheck(inner, { data: fixtureData(), onCheck: (e) => void events.push(e) });
  const res = await wrapped(XONA);
  assert.equal(res.status, 402);
  assert.equal(await res.text(), body, "the client still reads the 402 body");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.url, XONA);
  assert.equal(events[0]!.offers[0]?.chain, "solana");
  assert.equal(events[0]!.checks[0]?.payTo?.sameAsRecorded, true);
  assert.equal(events[0]!.checks[0]?.sellers[0]?.delivered, 0);
});

test("hook: the caller stops the payment by throwing; retries that carry a payment and non-402s pass through", async () => {
  let calls = 0;
  const inner = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls++;
    return carriesPayment(input, init) ? new Response("paid", { status: 200 }) : new Response(JSON.stringify(x402Body), { status: 402 });
  };
  let seen = 0;
  const wrapped = wrapFetchWithCheck(inner, {
    data: fixtureData(),
    onCheck: (e) => {
      seen++;
      if (e.checks.some((c) => c.sellers.some((s) => s.delivered === 0))) throw new Error("stopped by the caller's rule");
    },
  });
  await assert.rejects(wrapped(XONA), /stopped by the caller's rule/);
  const retry = await wrapped(new Request(XONA, { headers: { "PAYMENT-SIGNATURE": "x" } }));
  assert.equal(retry.status, 200);
  const mpp = await wrapped(XONA, { headers: { authorization: "Payment abc" } });
  assert.equal(mpp.status, 200);
  assert.equal(seen, 1);
  assert.equal(calls, 3);
});

test("hook: reads x402 PAYMENT-REQUIRED headers and MPP WWW-Authenticate challenges", async () => {
  const hdr = Buffer.from(JSON.stringify(x402Body)).toString("base64");
  const a = await readOffers(new Response(null, { status: 402, headers: { "payment-required": hdr } }));
  assert.deepEqual(a.map((o) => [o.protocol, o.chain, o.payTo]), [["x402", "solana", XONA_PAYTO]]);
  const challenge = Challenge.from({
    id: "test",
    realm: "mpp.orthogonal.com",
    method: "tempo",
    intent: "charge",
    request: { amount: "1000", currency: "0x20c000000000000000000000b9537d11c60e8b50", recipient: "0x09cbbb451ca48ed511c7fc07ed921d539cde1227" },
  });
  const b = await readOffers(new Response(null, { status: 402, headers: { "www-authenticate": Challenge.serialize(challenge) } }));
  assert.deepEqual(b.map((o) => [o.protocol, o.chain, o.payTo]), [["mpp", "tempo", "0x09cbbb451ca48ed511c7fc07ed921d539cde1227"]]);
});

// ---- the MCP server and the CLI ----

test("MCP: tools/list and tools/call over handleMessage", async () => {
  const data = fixtureData();
  const init = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } }, { data });
  assert.equal((init!.result as { protocolVersion: string }).protocolVersion, "2025-06-18");
  assert.equal(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, { data }), null);
  const list = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { data });
  assert.deepEqual((list!.result as { tools: { name: string }[] }).tools.map((t) => t.name), ["check_before_paying", "verify_record"]);
  const call = await handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "check_before_paying", arguments: { url: XONA } } }, { data });
  const res = call!.result as { structuredContent: CheckResult; isError?: boolean };
  assert.equal(res.isError, undefined);
  assert.equal(res.structuredContent.sellers[0]?.delivered, 0);
  const v = await handleMessage({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "verify_record", arguments: { record: NEG, offline: true } } }, { data });
  assert.equal((v!.result as { structuredContent: { result: string } }).structuredContent.result, "OK_OFFLINE");
  const bad = await handleMessage({ jsonrpc: "2.0", id: 5, method: "nope" }, { data });
  assert.equal((bad!.error as { code: number }).code, -32601);
});

function mcpSession(messages: object[]): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(PKG, "bin", "vet402-check.mjs"), "--mcp"], {
      env: { ...process.env, VET402_CHECK_RANK: join(FX, "rank.json"), VET402_CHECK_RECORDS_INDEX: join(FX, "records-index.json"), VET402_CHECK_RECORDS_BASE: join(FX, "records") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", () => {
      try {
        resolve(out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>));
      } catch (e) {
        reject(new Error(`${String(e)}; stdout ${out}; stderr ${err}`));
      }
    });
    for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
    child.stdin.end();
  });
}

test("MCP over stdio: the bin starts, lists both tools and answers a call", async () => {
  const replies = await mcpSession([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "check_before_paying", arguments: { url: "https://no-such-seller.example/x" } } },
  ]);
  const byId = new Map(replies.map((r) => [r.id, r]));
  assert.equal((byId.get(1)!.result as { serverInfo: { name: string } }).serverInfo.name, "vet402-check");
  assert.equal((byId.get(2)!.result as { tools: unknown[] }).tools.length, 2);
  const text = (byId.get(3)!.result as { content: { text: string }[] }).content[0]!.text;
  assert.match(text, /^vet402 has no record of this seller/);
});

test("CLI: exit 0 for a lookup, found or not; 1 when a record fails; 2 on bad input", async () => {
  const log = console.log;
  const err = console.error;
  const out: string[] = [];
  console.log = (s: string) => void out.push(String(s));
  console.error = (s: string) => void out.push(String(s));
  try {
    assert.equal(await main([XONA], fixtureData()), 0);
    assert.equal(await main(["https://no-such-seller.example/x", "--json"], fixtureData()), 0);
    assert.equal(await main(["verify", NEG, "--offline"], fixtureData()), 0);
    assert.equal(await main(["verify", NEG, "--offline"], fixtureData(tamperedCopy(NEG, (t) => t.replace("pumpfun", "pumpfuN")))), 1);
    assert.equal(await main(["--chain"], fixtureData()), 2);
    assert.equal(await main(["not a url"], fixtureData()), 2);
  } finally {
    console.log = log;
    console.error = err;
  }
  assert.match(out.join("\n"), /api\.xona-agent\.com/);
});

// ---- the words the check uses ----

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? (f === "fixtures" ? [] : walk(p)) : [p];
  });
}

test("facts only: no advice words in any answer, tool description or the package README", () => {
  const urls = [XONA, "https://agent402.tools/api/crypto-price", "https://no-such-seller.example/x", "https://mpp.orthogonal.com/andi/v1/search", "https://midax402.com/midas-ops/basic"];
  const texts = urls.flatMap((url) => {
    const r = lookup(rank, index, { url, payTo: "11111111111111111111111111111111" });
    return [r.summary, formatCheck(r), ...r.notes];
  });
  texts.push(...TOOLS.map((t) => `${t.title} ${t.description}`));
  texts.push(readFileSync(join(PKG, "README.md"), "utf8"));
  for (const t of texts) assert.equal(ADVICE.exec(t)?.[0], undefined, t.slice(0, 200));
});

// Built from parts so this file does not match itself.
const PLURAL = new RegExp(`\\b(${["w" + "e", "u" + "s", "o" + "ur", "o" + "urs"].join("|")})\\b`, "i");

test("public English: no first-person plural, no em dash, no Japanese in the package", () => {
  for (const p of walk(PKG)) {
    const t = readFileSync(p, "utf8");
    assert.equal(PLURAL.exec(t.replace(/https?:\/\/\S+/g, ""))?.[0], undefined, `${p}: first-person plural`);
    assert.equal(t.includes(String.fromCharCode(0x2014)), false, `${p}: em dash`);
    assert.equal(/[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/.test(t), false, `${p}: Japanese`);
  }
});
