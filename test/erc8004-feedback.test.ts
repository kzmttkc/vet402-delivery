/**
 * ERC-8004 feedback writer for EVM chains, against a fake chain and a fake site (no network, no key):
 *  - input rows from the Base and Tempo files, one shape
 *  - the agent: exactly one agent whose agentWallet is the payTo (owner-only and shared wallets are not written)
 *  - the values: the 8004-solana words, value 1/0, no score
 *  - every gate refuses on its own; the Tempo fee in USDC.e; the per-chain caps
 *  - send writes the ledger before the tx leaves, at most two per run, and never re-writes the Base agents
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, stringToBytes, type Hex } from "viem";
import type { LoadedRecords } from "../src/receipt/publish.js";
import type { Observation } from "../src/receipt/types.js";
import {
  chooseEvmAgent,
  evmRefusals,
  evmValues,
  feeRefusal,
  MAX_WRITES_PER_RUN,
  normalizeEvmPurchases,
  tempoFeeAtomic,
  type AgentEntry,
  type EvmGateChecks,
  type EvmPurchase,
} from "../src/evm/rep-plan.js";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeFunctionData, encodeFunctionResult, getAddress, parseAbi } from "viem";
import { identityAbi, reputationAbi } from "../src/evm/erc8004.js";
import { assertIndexComplete, chainReader, indexRow, MULTICALL3, plan, readLedger, repChain, send, simulate, type RepDeps, type RepReader, type RepSender, type SimRead } from "../src/evm/rep-run.js";

const PAYER = "0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51";
const P = PAYER.toLowerCase();
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const txh = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

test("Tempo ledger, remeasure and Base purchase rows become one shape, lowercased", () => {
  const ledger = { version: 1, payer: PAYER, entries: [
    { status: "sent", url: "https://a.example/x", recipient: "0xAbCdEf0000000000000000000000000000000001", amount: "5000", reservedAt: "2026-09-28T08:00:00Z", httpStatus: 200, txHash: "0x" + "AB".repeat(32), settled: true, delivered: true },
    { status: "refused", url: "https://b.example/x", recipient: addr(2), amount: "1", reservedAt: "2026-09-28T08:00:00Z", txHash: txh(2), settled: false, delivered: false },
  ] };
  const rows = normalizeEvmPurchases(ledger, "tempo/ledger", PAYER);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.payTo, "0xabcdef0000000000000000000000000000000001");
  assert.equal(rows[0]!.tx, "0x" + "ab".repeat(32));
  assert.equal(rows[0]!.amountAtomic, "5000");
  const rem = { kind: "vet402-remeasure", payer: PAYER, rows: [{ at: "2026-09-29T08:00:00Z", url: "https://a.example/x", payTo: addr(1), outcome: "sent", settled: true, delivered: false, httpStatus: 404, tx: txh(3), priceUsdc: "0.030000" }] };
  assert.equal(normalizeEvmPurchases(rem, "remeasure/tempo-2026-09-29", PAYER)[0]!.amountAtomic, "30000");
  const baseRows = [{ payer: PAYER, outcome: "sent", at: "2026-09-28T08:16:44Z", resource: "https://s.example/api", payTo: addr(9), settlementTx: txh(9), settledOnChain: true, delivered: true, amountAtomic: "1000", response: { status: 200 } }];
  assert.equal(normalizeEvmPurchases(baseRows, "base/purchases", PAYER)[0]!.httpStatus, 200);
  assert.throws(() => normalizeEvmPurchases({ ...ledger, payer: addr(7) }, "tempo/ledger", PAYER), /payer/);
});

test("the agent is the one agent whose agentWallet is the payTo; owner-only or shared wallets are not chosen", () => {
  const idx: AgentEntry[] = [
    { agentId: 1n, owner: addr(1), agentWallet: addr(1) },
    { agentId: 2n, owner: addr(2), agentWallet: addr(3) },
    { agentId: 3n, owner: addr(4), agentWallet: addr(3) },
    { agentId: 4n, owner: addr(5), agentWallet: addr(6) },
    { agentId: 5n, owner: addr(0), agentWallet: addr(0) },
  ];
  assert.equal(chooseEvmAgent(idx, addr(1)).agentId, 1n);
  assert.equal(chooseEvmAgent(idx, addr(3)).agentId, null); // two agents share the wallet
  assert.deepEqual(chooseEvmAgent(idx, addr(3)).byWallet, ["2", "3"]);
  assert.equal(chooseEvmAgent(idx, addr(5)).agentId, null); // owner only
  assert.match(chooseEvmAgent(idx, addr(5)).detail, /owner match is not enough/);
  assert.equal(chooseEvmAgent(idx, addr(0)).agentId, null); // zero wallet never matches
  assert.equal(chooseEvmAgent(idx, addr(8)).agentId, null);
});

test("values are facts only: value 1/0, no decimals, the 8004-solana tags", () => {
  assert.deepEqual(evmValues("delivered"), { value: 1n, valueDecimals: 0, tag1: "x402-delivery", tag2: "delivered" });
  assert.deepEqual(evmValues("paid-not-delivered"), { value: 0n, valueDecimals: 0, tag1: "x402-delivery", tag2: "paid-not-delivered" });
});

const PASS: EvmGateChecks = {
  chain: "tempo",
  caip2: "eip155:4217",
  client: P,
  payTo: addr(1),
  hosts: ["s1.example"],
  pin: null,
  outcome: "delivered",
  agent: { agentId: 7n, agentWalletNow: addr(1), clientIsOwnerOrOperator: false },
  purchase: { tx: txh(1), status: "success", finalized: true, transferMatches: true, detail: "ok" },
  record: { id: "obs_2026-09-29_000001", published: true, fetchedOk: true, fetchedSha256: "aa", indexSha256: "aa", localSha256: "aa", paymentTx: txh(1), payer: PAYER, payTo: addr(1), network: "eip155:4217", verdict: "DELIVERED", verifiesOffline: true },
  lastIndexOnChain: 0n,
  inLedger: false,
};

test("every gate refuses on its own", () => {
  assert.deepEqual(evmRefusals(PASS), []);
  const cases: [string, Partial<EvmGateChecks> | ((c: EvmGateChecks) => EvmGateChecks), RegExp][] = [
    ["outcome", { outcome: null }, /no single outcome/],
    ["shared payTo, no pin", { hosts: ["a.example", "b.example"] }, /serves 2 hosts; the agent needs an operator pin/],
    ["pin names another agent", { pin: "8" }, /pin 8 is not the payTo's agent \(7\)/],
    ["no agent", { agent: null }, /no agent chosen/],
    ["wallet moved", (c) => ({ ...c, agent: { ...c.agent!, agentWalletNow: addr(2) } }), /agentWallet now/],
    ["owner writes", (c) => ({ ...c, agent: { ...c.agent!, clientIsOwnerOrOperator: true } }), /owns or operates/],
    ["operator unread", (c) => ({ ...c, agent: { ...c.agent!, clientIsOwnerOrOperator: null } }), /owns or operates/],
    ["reverted", (c) => ({ ...c, purchase: { ...c.purchase!, status: "reverted" } }), /reverted/],
    ["not final", (c) => ({ ...c, purchase: { ...c.purchase!, finalized: false } }), /not finalized/],
    ["no transfer", (c) => ({ ...c, purchase: { ...c.purchase!, transferMatches: false, detail: "no payment-token transfer" } }), /no payment-token transfer/],
    ["unpublished", (c) => ({ ...c, record: { ...c.record!, published: false } }), /not published/],
    ["fetch failed", (c) => ({ ...c, record: { ...c.record!, fetchedOk: false } }), /could not be fetched/],
    ["hash changed", (c) => ({ ...c, record: { ...c.record!, fetchedSha256: "bb" } }), /disagree/],
    ["other tx", (c) => ({ ...c, record: { ...c.record!, paymentTx: txh(2) } }), /not about the purchase/],
    ["other payTo", (c) => ({ ...c, record: { ...c.record!, payTo: addr(2) } }), /payer or payTo differs/],
    ["other chain", (c) => ({ ...c, record: { ...c.record!, network: "eip155:8453" } }), /not eip155:4217/],
    ["verdict", (c) => ({ ...c, record: { ...c.record!, verdict: "NOT_DELIVERED" } }), /does not back/],
    ["offline", (c) => ({ ...c, record: { ...c.record!, verifiesOffline: false } }), /does not verify offline/],
    ["already on chain", { lastIndexOnChain: 1n }, /already has 1 feedback/],
    ["chain unread", { lastIndexOnChain: null }, /could not read earlier feedback/],
    ["ledger", { inLedger: true }, /ledger already has/],
  ];
  for (const [name, change, re] of cases) {
    const c = typeof change === "function" ? change(PASS) : { ...PASS, ...change };
    const r = evmRefusals(c);
    assert.ok(r.some((x) => re.test(x)), `${name}: ${r.join("; ")}`);
  }
});

test("Tempo fee is ceil(gas * attodollars / 1e12) in USDC.e; each chain has its own cap", () => {
  assert.equal(tempoFeeAtomic(2_113_523n, 720_000_000n), 1522n);
  assert.equal(tempoFeeAtomic(1n, 1n), 1n);
  assert.equal(feeRefusal(1522n, 5000n, 16_000_000n), null);
  assert.match(feeRefusal(6000n, 5000n, 16_000_000n)!, /over the cap/);
  assert.match(feeRefusal(1522n, 5000n, 2000n)!, /below twice/);
  assert.match(feeRefusal(null, 5000n, 1n)!, /no fee estimate/);
  assert.match(feeRefusal(1n, 5000n, null)!, /not read/);
  const t = repChain("tempo", {});
  assert.equal(t.fee.kind, "tip20");
  assert.equal(t.fee.cap, 5000n);
  assert.equal(repChain("base", {}).fee.cap, 10_000_000_000_000n);
  assert.deepEqual([repChain("base", {}).chainId, t.chainId, repChain("robinhood", {}).chainId, repChain("arbitrum", {}).chainId], [8453, 4217, 4663, 42161]);
  // no Robinhood purchase token is named yet: no Robinhood purchase can pass the transfer check
  assert.equal(repChain("robinhood", {}).purchaseAssets.length, 0);
});

// ---------- fake chain + site ----------

function recordFor(n: number, payTo: string, verdict: "DELIVERED" | "NOT_DELIVERED", network = "eip155:4217") {
  const id = `obs_2026-09-29_${String(n).padStart(6, "0")}`;
  const obs = { id, resourceUrl: `https://s${n}.example/api?q=1`, verdict: { code: verdict }, payment: { network, transaction: txh(n), payer: PAYER, payTo } } as unknown as Observation;
  const text = JSON.stringify(obs);
  return { entry: { id, day: "2026-09-29", file: `2026-09-29/${id}.json`, sha256: createHash("sha256").update(text).digest("hex"), network, verdict, resourceUrl: obs.resourceUrl, host: `s${n}.example`, seller: `s${n}.example`, sequence: n }, obs, text };
}

function purchases(n: number, payTo: string, delivered: boolean): EvmPurchase[] {
  return ["2026-09-28", "2026-09-29"].map((day, i) => ({ source: "t", day, at: `${day}T08:00:00Z`, host: `s${n}.example`, url: `https://s${n}.example/api`, payTo, tx: i === 1 ? txh(n) : txh(1000 + n), settled: true, delivered, httpStatus: delivered ? 200 : 404, amountAtomic: "5000" }));
}

interface World {
  index: AgentEntry[];
  lastIndex: Map<string, bigint>;
  sim: SimRead;
  authz?: boolean | null;
}

function fakeReader(w: World): RepReader {
  return {
    chainId: async () => 4217,
    indexAgents: async () => w.index,
    agentWallet: async (id) => w.index.find((a) => a.agentId === id)?.agentWallet ?? null,
    isAuthorizedOrOwner: async () => (w.authz === undefined ? false : w.authz),
    lastIndex: async (id) => w.lastIndex.get(id.toString()) ?? 0n,
    purchase: async () => ({ status: "success", finalized: true, transferMatches: true, detail: "ok" }),
    simulate: async () => w.sim,
  };
}

function setup(nSellers: number) {
  const dir = mkdtempSync(join(tmpdir(), "rep-"));
  const index: AgentEntry[] = [];
  const recs = [];
  const ps: EvmPurchase[] = [];
  for (let n = 1; n <= nSellers; n++) {
    index.push({ agentId: BigInt(100 + n), owner: addr(n), agentWallet: addr(n) });
    recs.push(recordFor(n, addr(n), "DELIVERED"));
    ps.push(...purchases(n, addr(n), true));
  }
  const published = { index: {}, notified: {}, records: recs } as unknown as LoadedRecords;
  const texts = new Map(recs.map((r) => [`https://kzmttkc.github.io/vet402-delivery/records/${r.entry.id}.json`, r.text]));
  const w: World = { index, lastIndex: new Map(), sim: { ok: true, revertReason: null, gas: 2_100_000n, maxFeePerGas: 720_000_000n, l1Fee: 0n, costAtMax: 1815n, costNow: 1269n, feeBalance: 16_000_000n, blockNumber: 1n } };
  const events: string[] = [];
  const signedMaxFee = { v: 720_000_000n };
  const ledgerPath = join(dir, "ledger.json");
  const sender: RepSender = {
    sign: async (data, gas) => {
      events.push("sign");
      return { serialized: data, hash: keccak256(data), from: PAYER, gas, maxFeePerGas: signedMaxFee.v };
    },
    broadcast: async (s) => {
      const l = readLedger(ledgerPath);
      events.push(`broadcast:${Object.values(l).some((e) => e.tx === keccak256(s) && e.status === "sending") ? "ledger-first" : "NO-LEDGER"}`);
      return keccak256(s);
    },
    wait: async () => "success",
  };
  const d: RepDeps = {
    chain: repChain("tempo", {}),
    reader: fakeReader(w),
    writer: P,
    purchases: ps,
    published,
    ledgerPath,
    fetchImpl: (async (u: string) => (texts.has(u) ? new Response(texts.get(u)!, { status: 200 }) : new Response("no", { status: 404 }))) as unknown as typeof fetch,
    verifyRecord: async () => true,
    sender,
  };
  return { d, w, events, ledgerPath, recs, signedMaxFee };
}

test("plan: a clean seller is writable with the record URL and keccak256 of its bytes", async () => {
  const { d, recs } = setup(1);
  const [x] = await plan(d);
  assert.equal(x!.item.status, "writable", x!.item.refusals.join("; "));
  assert.equal(x!.item.args!.feedbackURI, `https://kzmttkc.github.io/vet402-delivery/records/${recs[0]!.entry.id}.json`);
  assert.equal(x!.item.args!.feedbackHash, keccak256(stringToBytes(recs[0]!.text)));
  assert.equal(x!.item.args!.endpoint, "https://s1.example/api");
  assert.deepEqual([x!.item.args!.value, x!.item.args!.tag1, x!.item.args!.tag2], ["1", "x402-delivery", "delivered"]);
  const sim = await simulate(d, [x!]);
  assert.equal(sim[0]!.simulated, true);
  assert.equal(sim[0]!.feeRefusal, null);
});

test("plan refuses a seller whose payTo has two agents, and a chain id that is not the configured one", async () => {
  const { d, w } = setup(1);
  w.index.push({ agentId: 999n, owner: addr(50), agentWallet: addr(1) });
  const [x] = await plan(d);
  assert.equal(x!.item.status, "refused");
  assert.match(x!.item.agent.detail, /2 agents/);
  await assert.rejects(plan({ ...d, reader: { ...d.reader, chainId: async () => 8453 } }), /not tempo 4217/);
});

test("send: ledger before broadcast, at most two per run, nothing twice", async () => {
  const { d, events, ledgerPath } = setup(3);
  const items = await plan(d);
  assert.equal(items.filter((x) => x.item.status === "writable").length, 3);
  const r = await send(d, items);
  assert.equal(r.filter((x) => x.sent).length, MAX_WRITES_PER_RUN);
  assert.match(r[2]!.status, /at most 2 writes per run/);
  assert.deepEqual(events.filter((e) => e.startsWith("broadcast")), ["broadcast:ledger-first", "broadcast:ledger-first"]);
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as Record<string, { status: string }>;
  assert.deepEqual(Object.keys(ledger).sort(), ["tempo:101", "tempo:102"]);
  assert.ok(Object.values(ledger).every((e) => e.status === "success"));
  // a second run: the two written agents are refused by the ledger, the third goes
  const again = await send(d, await plan(d));
  assert.equal(again.filter((x) => x.sent).length, 1);
  assert.ok(again.filter((x) => !x.sent).every((x) => /ledger already has/.test(x.status)));
});

test("send re-reads the chain, the record and the fee right before signing", async () => {
  const { d, w, events } = setup(1);
  const items = await plan(d);
  w.lastIndex.set("101", 1n);
  assert.match((await send(d, items))[0]!.status, /already has 1 feedback/);
  w.lastIndex.clear();
  w.sim = { ...w.sim, costAtMax: 9000n };
  assert.match((await send(d, items))[0]!.status, /over the cap/);
  w.sim = { ...w.sim, costAtMax: 1522n };
  const changed = { ...d, fetchImpl: (async () => new Response("changed", { status: 200 })) as unknown as typeof fetch };
  assert.match((await send(changed, items))[0]!.status, /hash changed/);
  assert.equal(events.length, 0); // nothing was signed
});

test("the Base agents written on 2026-09-28 are never written again, even if the chain read says 0", async () => {
  const root = join(import.meta.dirname, "..", "data", "base");
  const prior = new Set(Object.values(JSON.parse(readFileSync(join(root, "feedback-ledger.json"), "utf8")) as Record<string, { agentId: string }>).map((x) => x.agentId));
  assert.equal(prior.size, 7);
  const lines = readFileSync(join(root, "purchases.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { agentId: string; payTo: string });
  const ps = normalizeEvmPurchases(lines, "base/purchases", PAYER);
  // a fake index that binds every purchased payTo to exactly the agent it was bought from
  const index: AgentEntry[] = lines.map((l) => ({ agentId: BigInt(l.agentId), owner: l.payTo, agentWallet: l.payTo }));
  const { d } = setup(0);
  const base: RepDeps = { ...d, chain: repChain("base", {}), reader: { ...fakeReader({ index, lastIndex: new Map(), sim: { ok: true, revertReason: null, gas: 1n, maxFeePerGas: 1n, l1Fee: 0n, costAtMax: 1n, costNow: 1n, feeBalance: 10n ** 18n, blockNumber: 1n } }), chainId: async () => 8453 }, purchases: ps, priorAgentIds: prior };
  const items = await plan(base);
  const written = items.filter((x) => x.item.agent.agentId && prior.has(x.item.agent.agentId));
  assert.equal(written.length, 7);
  assert.ok(written.every((x) => x.item.inLedger && x.item.status === "refused"));
  assert.ok((await send(base, items)).every((x) => !x.sent));
});

test("a chain with no purchases reads nothing and plans nothing", async () => {
  const { d } = setup(0);
  const boom = () => {
    throw new Error("must not read");
  };
  const reader = { chainId: boom, indexAgents: boom, agentWallet: boom, isAuthorizedOrOwner: boom, lastIndex: boom, purchase: boom, simulate: boom } as unknown as RepReader;
  assert.deepEqual(await plan({ ...d, chain: repChain("arbitrum", {}), reader, purchases: [] }), []);
});

test("send judges the fee on the tx as signed, and re-reads owner/operator before signing", async () => {
  const a = setup(1);
  const items = await plan(a.d);
  a.signedMaxFee.v = 10_000_000_000n; // the node raised its fee between simulate and signing
  const r = await send(a.d, items);
  assert.match(r[0]!.status, /signed, not sent\): fee \d+ over the cap 5000/);
  assert.equal(a.events.filter((e) => e.startsWith("broadcast")).length, 0);
  assert.deepEqual(readLedger(a.ledgerPath), {});
  const b = setup(1);
  const items2 = await plan(b.d);
  b.w.authz = true;
  assert.match((await send(b.d, items2))[0]!.status, /now owns or operates/);
  b.w.authz = null;
  assert.match((await send(b.d, items2))[0]!.status, /could not read owner\/operator/);
  assert.equal(b.events.length, 0);
});

test("a payTo behind several hosts is written only with an operator pin that names its agent", async () => {
  const { d } = setup(1);
  const shared = [...d.purchases, ...d.purchases.map((p) => ({ ...p, host: "other.example", url: "https://other.example/api", tx: p.tx.replace(/^0x0/, "0xf") }))];
  const [x] = await plan({ ...d, purchases: shared });
  assert.equal(x!.item.status, "refused");
  assert.match(x!.item.refusals.join("; "), /serves 2 hosts/);
  const [y] = await plan({ ...d, purchases: shared, pins: new Map([[addr(1), "101"]]) });
  assert.equal(y!.item.status, "writable", y!.item.refusals.join("; "));
  const [z] = await plan({ ...d, purchases: shared, pins: new Map([[addr(1), "5"]]) });
  assert.match(z!.item.refusals.join("; "), /pin 5 is not the payTo's agent \(101\)/);
});

// ---------- the index against a fake JSON-RPC server (multicall3 aggregate3) ----------

const mcAbi = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
const SHARED = "0x00000000000000000000000000000000000000aa";
const NONEXISTENT = "0x7e273289" + "0".repeat(64); // ERC721NonexistentToken(uint256)

/** Agents 1..1199 exist; 5 and 700 share one agentWallet. mode: rpc errors on a batch, or a hole in the ids. */
async function fakeRegistry(mode: "ok" | "batch-error" | "hole", run: (reader: RepReader) => Promise<void>) {
  const N = 1200n;
  const walletOf = (id: bigint) => (id === 5n || id === 700n ? SHARED : getAddress("0x" + (id + 0x1000n).toString(16).padStart(40, "0")));
  const exists = (id: bigint) => id >= 1n && id < N && !(mode === "hole" && id === 800n);
  const one = (data: Hex): { ok: boolean; ret: Hex } => {
    const f = decodeFunctionData({ abi: [...identityAbi, ...reputationAbi], data });
    const id = f.args![0] as bigint;
    if (f.functionName === "ownerOf") return exists(id) ? { ok: true, ret: encodeFunctionResult({ abi: identityAbi, functionName: "ownerOf", result: "0x00000000000000000000000000000000000000bb" }) } : { ok: false, ret: NONEXISTENT as Hex };
    if (f.functionName === "getAgentWallet") return { ok: true, ret: encodeFunctionResult({ abi: identityAbi, functionName: "getAgentWallet", result: walletOf(id) }) };
    throw new Error(`unhandled ${f.functionName}`);
  };
  const srv = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const body = JSON.parse(b);
      const answer = (q: { id: number; method: string; params: [{ to: string; data?: Hex; input?: Hex }] }) => {
        if (q.method === "eth_chainId") return { jsonrpc: "2.0", id: q.id, result: "0x2105" };
        if (q.method !== "eth_call") return { jsonrpc: "2.0", id: q.id, error: { code: -32601, message: `no ${q.method}` } };
        const data = (q.params[0].data ?? q.params[0].input)!;
        if (q.params[0].to.toLowerCase() === MULTICALL3.toLowerCase()) {
          const calls = decodeFunctionData({ abi: mcAbi, data }).args![0] as readonly { callData: Hex }[];
          const ids = calls.map((c) => decodeFunctionData({ abi: identityAbi, data: c.callData }).args![0] as bigint);
          if (mode === "batch-error" && ids.some((i) => i >= 500n && i < 1000n)) return { jsonrpc: "2.0", id: q.id, error: { code: -32005, message: "rate limit exceeded" } };
          const r = calls.map((c) => {
            const o = one(c.callData);
            return { success: o.ok, returnData: o.ret };
          });
          return { jsonrpc: "2.0", id: q.id, result: encodeFunctionResult({ abi: mcAbi, functionName: "aggregate3", result: r }) };
        }
        const o = one(data);
        return o.ok ? { jsonrpc: "2.0", id: q.id, result: o.ret } : { jsonrpc: "2.0", id: q.id, error: { code: 3, message: "execution reverted", data: o.ret } };
      };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    await run(chainReader(repChain("base", { BASE_RPC_URL: url, BASE_RECEIPT_RPC_URL: url })));
  } finally {
    srv.close();
  }
}

test("fake RPC: the index holds every agent, so a shared agentWallet is seen as shared", async () => {
  await fakeRegistry("ok", async (reader) => {
    const idx = await reader.indexAgents();
    assert.equal(idx.length, 1199);
    assert.deepEqual(chooseEvmAgent(idx, SHARED).byWallet, ["5", "700"]);
    assert.equal(chooseEvmAgent(idx, SHARED).agentId, null);
  });
});

test("fake RPC: an RPC error on a multicall batch stops the run instead of dropping 500 agents", async () => {
  await fakeRegistry("batch-error", async (reader) => {
    await assert.rejects(reader.indexAgents(), /ownerOf\(\d+\) failed at or below the top id/);
  });
});

test("fake RPC: a missing id below the top stops the run", async () => {
  await fakeRegistry("hole", async (reader) => {
    await assert.rejects(reader.indexAgents(), /ownerOf\(800\) failed/);
  });
});

test("index rows and completeness are checked without a chain", () => {
  const ok = { status: "success" as const, result: addr(1) };
  const bad = { status: "failure" as const, error: new Error("rate limit exceeded") };
  assert.equal(indexRow("base", 1n, ok, ok).agentWallet, addr(1));
  assert.throws(() => indexRow("base", 2n, bad, ok), /ownerOf\(2\) failed/);
  assert.throws(() => indexRow("base", 3n, ok, bad), /getAgentWallet\(3\) failed/);
  const rows = [0n, 1n, 2n].map((i) => ({ agentId: i, owner: addr(1), agentWallet: addr(1) }));
  assert.doesNotThrow(() => assertIndexComplete("base", rows, 0n, 2n));
  assert.throws(() => assertIndexComplete("base", rows.slice(1), 0n, 2n), /expected 3/);
  assert.throws(() => assertIndexComplete("base", [rows[0]!, rows[0]!, rows[1]!], 0n, 2n), /2 distinct/);
});
