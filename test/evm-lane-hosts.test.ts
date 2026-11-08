/**
 * Acceptance tests for the Robinhood Chain host run (scripts/evm-lane.ts --lane robinhood --hosts).
 * Written before the implementation and fixed: the implementation changes to pass them, not the other way round.
 *
 * The run: the cheapest hosts that list an exact USDG accept on Robinhood Chain, one purchase per host,
 * EIP-3009 only, each price in [0.0044, 0.01] USDG, at most 10 purchases and 0.06 USDG in total for the run,
 * held in its own persistent ledger on top of the robinhood lane's ledger.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Budget } from "../src/guard.js";
import { EVM_CHAINS } from "../src/evm/chains.js";
import { buyOneOnChain, checkChainAccept, createChainPayment, fencedChainSigner, type ChainBuyDeps, type ChainBuyEntry, type EvmAccept, type TypedDataSigner } from "../src/evm/evm-buy.js";
import { HOSTS_RUN, RunBudget, acquireHostRunLock, confirmLiveHosts, keepPlanned, groupByHost, hostLedgerKey, hostRunLedgerProblem, pickHostEntries, type HostChoice } from "../src/evm/lane-hosts.js";

const RH = EVM_CHAINS.robinhood;
const PAYER = getAddress("0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51");
const S1 = getAddress("0x50ab2018c06c6E4eAA9BA52057Eb55eD284912fc");
const S2 = getAddress("0x3574999dd4c96eB73Bd6e11D4177010C83E14f5b");
const PERMIT2 = getAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3");

const rhA = (payTo: string, amount: string, extra: Record<string, unknown> = { name: "Global Dollar", version: "1" }) => ({
  scheme: "exact",
  network: "eip155:4663",
  asset: RH.asset,
  payTo,
  amount,
  maxTimeoutSeconds: 300,
  extra,
});
const listing = (resource: string, accepts: Record<string, unknown>[]) => ({ resource, method: "GET", accepts }) as never;
const acc = (over: Partial<EvmAccept> = {}): EvmAccept => ({
  scheme: "exact",
  network: RH.caip2,
  amount: "5000",
  asset: RH.asset,
  payTo: S1,
  maxTimeoutSeconds: 300,
  extra: { name: "Global Dollar", version: "1" },
  ...over,
});

// ---------- the approved limits ----------

test("run limits are the approved ones: 0.06 USDG in total, 10 purchases, 0.0044 to 0.01 each", () => {
  assert.equal(HOSTS_RUN.maxTotalAtomic, 60_000n);
  assert.equal(HOSTS_RUN.maxCount, 10);
  assert.equal(HOSTS_RUN.minAtomic, 4_400n);
  assert.equal(HOSTS_RUN.maxPerAtomic, 10_000n);
  assert.equal(hostLedgerKey("API.Example.com"), "robinhood-host:api.example.com");
});

// ---------- planning ----------

test("groupByHost: one group per host, only options priced within [min, maxPer], cheapest first", () => {
  const g = groupByHost(
    [
      listing("https://b.test/expensive", [rhA(S1, "20000")]),
      listing("https://b.test/under-floor", [rhA(S1, "1000")]),
      listing("https://b.test/cheap", [rhA(S1, "5000")]),
      listing("https://b.test/mid", [rhA(S1, "6795")]),
      listing("https://a.test/x", [rhA(S2, "10000")]),
      listing("https://own.vet402.com/x", [rhA(S2, "5000")]),
      listing("https://c.test/other-chain", [{ ...rhA(S2, "5000"), network: "eip155:8453" }]),
    ],
    RH,
    { minAtomic: 4_400n, maxPerAtomic: 10_000n, ownHosts: ["vet402.com"] },
  );
  assert.deepEqual(g.map((x) => x.host), ["a.test", "b.test"], "sorted by host; own hosts and other chains left out");
  const b = g.find((x) => x.host === "b.test")!;
  assert.equal(b.listings, 4);
  assert.deepEqual(b.options.map((o) => o.amount), ["5000", "6795"], "under the floor and over the cap are not options");
  assert.equal(b.options[0]!.payTo, S1);
});

test("groupByHost: two hosts on one payTo stay two groups, each option keeps its own payTo", () => {
  const g = groupByHost([listing("https://macro.test/a", [rhA(S1, "5000")]), listing("https://onchain.test/b", [rhA(S1, "5000")]), listing("https://onchain.test/c", [rhA(S2, "5000")])], RH, {
    minAtomic: 4_400n,
    maxPerAtomic: 10_000n,
  });
  assert.equal(g.length, 2);
  const o = g.find((x) => x.host === "onchain.test")!;
  assert.deepEqual(o.options.map((x) => x.payTo).sort(), [S1, S2].sort());
});

test("checkChainAccept: a live price under the floor is refused (price_under_floor); Permit2 is refused (not_eip3009)", () => {
  const ctx = { payer: PAYER, lockedPayTo: S1, lockedAmount: "5000", maxPerAtomic: 10_000n, minAtomic: 4_400n };
  assert.equal(checkChainAccept(RH, acc(), ctx), null);
  assert.equal(checkChainAccept(RH, acc({ amount: "4399" }), ctx)?.refused, "price_under_floor");
  assert.equal(checkChainAccept(RH, acc({ amount: "4400" }), ctx), null);
  assert.equal(checkChainAccept(RH, acc({ amount: "10001" }), { ...ctx, lockedAmount: "20000" })?.refused, "price_over_cap");
  assert.equal(checkChainAccept(RH, acc({ extra: { name: "Global Dollar", version: "1", assetTransferMethod: "permit2" } }), ctx)?.refused, "not_eip3009");
  assert.equal(checkChainAccept(RH, acc({ amount: "1000" }), { payer: PAYER, lockedPayTo: S1 }), null, "without minAtomic nothing changes for the other lanes");
});

test("confirmLiveHosts: locks each option's own payTo and price; moves to the next option when the live 402 refuses", async () => {
  const groups = groupByHost([listing("https://h.test/a", [rhA(S1, "5000")]), listing("https://h.test/b", [rhA(S2, "6000")]), listing("https://dead.test/a", [rhA(S1, "5000")])], RH, {
    minAtomic: 4_400n,
    maxPerAtomic: 10_000n,
  });
  const live: Record<string, { status: number | null; accepts: EvmAccept[] }> = {
    "https://h.test/a": { status: 402, accepts: [acc({ payTo: S1, amount: "5000", extra: { assetTransferMethod: "permit2", name: "Global Dollar", version: "1" } })] },
    "https://h.test/b": { status: 402, accepts: [acc({ payTo: S2, amount: "5500" })] },
    "https://dead.test/a": { status: 502, accepts: [] },
  };
  const probe = async (o: { resource: string }) => ({ ...(live[new URL(o.resource).origin + new URL(o.resource).pathname] ?? { status: null, accepts: [] }), raw: "" });
  const ch = await confirmLiveHosts(groups, RH, probe, { payer: PAYER, minAtomic: 4_400n, maxPerAtomic: 10_000n });
  const h = ch.find((c) => c.host === "h.test")!;
  assert.equal(h.chosen?.payTo, S2);
  assert.equal(h.chosen?.liveAmount, "5500");
  assert.match(h.tried[0]!.why, /^not_eip3009/);
  assert.equal(ch.find((c) => c.host === "dead.test")!.chosen, null);
});

// ---------- choosing the run ----------

const choice = (host: string, amount: string, payTo: Address = S1, liveAmount = amount): HostChoice =>
  ({
    host,
    listings: 1,
    tried: [],
    chosen: {
      resource: `https://${host}/r`,
      listingResource: `https://${host}/r`,
      method: "GET",
      query: null,
      body: null,
      payTo,
      amount,
      liveAmount,
      raw402: "",
      simple: true,
      declaredParams: [],
      inputDate: "2026-11-08",
      datedParams: [],
      declaration: { declared: [], required: [], from: [], requiredFrom: [] },
    },
  }) as unknown as HostChoice;

test("pickHostEntries: the catalog's ten cheapest hosts on 2026-11-08 make 0.056795 USDG, ten entries, one ledger key per host", () => {
  const hosts = ["agent402.tools", "api.loopholetape.com", "coord.taifoon.dev", "gateway.spraay.app", "hosaka-agents.vercel.app", "macropulse.t.com", "onchainpulse.t.com", "wafermap.xyz"];
  const ch = [
    ...hosts.map((h) => choice(h, "5000")),
    choice("www.taifoon.io", "6795", S2),
    choice("whaletape.xyz", "10000"),
    choice("apexfaucet.xyz", "10000"),
    choice("api.sys84.org", "10000"),
  ];
  const r = pickHostEntries(ch, { maxTotalAtomic: HOSTS_RUN.maxTotalAtomic, maxCount: HOSTS_RUN.maxCount });
  assert.equal(r.entries.length, 10);
  assert.equal(r.totalAtomic, 56_795n);
  assert.ok(r.totalAtomic <= 60_000n);
  assert.deepEqual(new Set(r.entries.map((e) => e.ledgerKey)).size, 10);
  assert.equal(r.entries[0]!.ledgerKey, "robinhood-host:agent402.tools", "cheapest first, then by host");
  assert.equal(r.entries[8]!.lock.amount, "6795");
  assert.equal(r.entries[8]!.lock.payTo, S2);
  assert.equal(r.entries[9]!.ledgerKey, "robinhood-host:apexfaucet.xyz");
  assert.equal(r.entries[0]!.agentId, "host:agent402.tools");
  assert.deepEqual(r.left.map((x) => x.host).sort(), ["api.sys84.org", "whaletape.xyz"]);
});

test("pickHostEntries: never over the run total; a host that would cross it is left out and a cheaper one after it may still fit", () => {
  const ch = [choice("a.test", "10000"), choice("b.test", "10000"), choice("c.test", "10000"), choice("d.test", "10000"), choice("e.test", "10000"), choice("f.test", "9000"), choice("g.test", "10000")];
  const r = pickHostEntries(ch, { maxTotalAtomic: 60_000n, maxCount: 10 });
  assert.ok(r.totalAtomic <= 60_000n);
  assert.equal(r.totalAtomic, 59_000n);
  assert.equal(r.entries.length, 6);
  assert.ok(r.left.some((x) => x.host === "g.test" && /total/.test(x.why)));
});

test("pickHostEntries: at most maxCount entries; the live price is used when lower, never a higher one; hosts without a confirmed 402 are skipped", () => {
  const many = Array.from({ length: 12 }, (_, i) => choice(`h${String(i).padStart(2, "0")}.test`, "4400"));
  const r = pickHostEntries([...many, { host: "none.test", listings: 1, tried: [], chosen: null } as HostChoice], { maxTotalAtomic: 60_000n, maxCount: 10 });
  assert.equal(r.entries.length, 10);
  assert.ok(r.left.some((x) => /count/.test(x.why)));
  const lower = pickHostEntries([choice("x.test", "6000", S1, "5000")], { maxTotalAtomic: 60_000n, maxCount: 10 });
  assert.equal(lower.entries[0]!.lock.amount, "5000");
  const higher = pickHostEntries([choice("y.test", "5000", S1, "6000")], { maxTotalAtomic: 60_000n, maxCount: 10 });
  assert.equal(higher.entries[0]!.lock.amount, "5000", "the lock keeps the lower catalog price; buyOneOnChain then refuses price_raised");
});

// ---------- the run's own ledger on top of the lane's ----------

test("RunBudget: the run ledger stops the 11th purchase and anything past 0.06, persists across runs, and never double-pays a host", () => {
  const dir = mkdtempSync(join(tmpdir(), "rh-hosts-"));
  try {
    const runFile = join(dir, "robinhood-hosts-ledger.json");
    const laneFile = join(dir, "robinhood-ledger.json");
    const make = () => new RunBudget(new Budget(runFile, HOSTS_RUN.maxTotalAtomic, HOSTS_RUN.maxCount, HOSTS_RUN.maxPerAtomic), new Budget(laneFile, 1_000_000n, 30, 100_000n));
    const b = make();
    b.setBaselineIfMissing(1_414_936n);
    for (let i = 0; i < 10; i++) {
      const r = b.reserve(5_000n, hostLedgerKey(`h${i}.test`), null);
      assert.ok("ok" in r, `purchase ${i + 1}`);
      if ("ok" in r) b.commit(r.id);
    }
    assert.equal(b.count, 10);
    assert.equal(b.spent, 50_000n);
    const eleventh = b.reserve(5_000n, hostLedgerKey("h10.test"), null);
    assert.ok("refused" in eleventh && eleventh.refused === "purchase_count_reached");

    // A new process reads the same files: the same host is never bought again, the count still holds.
    const again = make();
    const dup = again.reserve(5_000n, hostLedgerKey("h0.test"), null);
    assert.ok("refused" in dup && dup.refused === "already_bought");
    assert.equal(again.count, 10);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RunBudget: total cap and per-purchase cap of the run; a lane refusal gives the run reservation back", () => {
  const dir = mkdtempSync(join(tmpdir(), "rh-hosts-"));
  try {
    const run = new Budget(join(dir, "run.json"), 60_000n, 10, 10_000n);
    const lane = new Budget(join(dir, "lane.json"), 1_000_000n, 30, 100_000n);
    const b = new RunBudget(run, lane);
    const over = b.reserve(10_001n, hostLedgerKey("big.test"), null);
    assert.ok("refused" in over && over.refused === "price_over_cap");
    for (let i = 0; i < 6; i++) {
      const r = b.reserve(10_000n, hostLedgerKey(`t${i}.test`), null);
      assert.ok("ok" in r);
      if ("ok" in r) b.commit(r.id);
    }
    const cross = b.reserve(4_400n, hostLedgerKey("t6.test"), null);
    assert.ok("refused" in cross && cross.refused === "total_cap_reached");
    assert.equal(run.spent, 60_000n);
    assert.equal(lane.spent, 60_000n, "the lane ledger holds every run purchase too");

    // The lane already holds this key (bought by the lane before): the run must not keep a reservation for it.
    const dir2 = mkdtempSync(join(tmpdir(), "rh-hosts-"));
    try {
      const lane2 = new Budget(join(dir2, "lane.json"), 1_000_000n, 30, 100_000n);
      const pre = lane2.reserve(5_000n, hostLedgerKey("seen.test"), null);
      if ("ok" in pre) lane2.commit(pre.id);
      const run2 = new Budget(join(dir2, "run.json"), 60_000n, 10, 10_000n);
      const b2 = new RunBudget(run2, lane2);
      const r = b2.reserve(5_000n, hostLedgerKey("seen.test"), null);
      assert.ok("refused" in r && r.refused === "already_bought");
      assert.equal(run2.count, 0, "released from the run ledger");
      assert.equal(run2.spent, 0n);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }

    // release() gives back both sides (nothing signed left the process).
    const run3 = new Budget(null, 60_000n, 10, 10_000n);
    const lane3 = new Budget(null, 1_000_000n, 30, 100_000n);
    const b3 = new RunBudget(run3, lane3);
    const r3 = b3.reserve(5_000n, hostLedgerKey("r.test"), null);
    assert.ok("ok" in r3);
    if ("ok" in r3) b3.release(r3.id);
    assert.equal(run3.count + lane3.count, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- the signer ----------

test("the fenced signer signs only the one TransferWithAuthorization: a Permit2 or EIP-2612 permit is refused", async () => {
  const inner = privateKeyToAccount(generatePrivateKey());
  const lock = { payTo: S1, amount: "5000", maxPerAtomic: HOSTS_RUN.maxPerAtomic };
  const permit2 = fencedChainSigner(RH, inner, lock);
  await assert.rejects(
    permit2.signTypedData({
      domain: { name: "Permit2", chainId: RH.chainId, verifyingContract: PERMIT2 },
      types: { PermitWitnessTransferFrom: [{ name: "spender", type: "address" }] },
      primaryType: "PermitWitnessTransferFrom",
      message: { spender: S1 },
    }),
    /fenced signer refused/,
  );
  const permit = fencedChainSigner(RH, inner, lock);
  await assert.rejects(
    permit.signTypedData({
      domain: { name: RH.domain.name, version: RH.domain.version, chainId: RH.chainId, verifyingContract: RH.asset },
      types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
      primaryType: "Permit",
      message: { owner: inner.address, spender: PERMIT2, value: 2n ** 256n - 1n, nonce: 0n, deadline: 9_999_999_999n },
    }),
    /fenced signer refused/,
  );
  assert.equal(permit2.signed + permit.signed, 0);
});

// ---------- the purchase itself, through RunBudget and the floor ----------

const TX = ("0x" + "cd".repeat(32)) as Hex;

function fake402(accepts: EvmAccept[]) {
  let paidCalls = 0;
  const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    if (h.has("PAYMENT-SIGNATURE") || h.has("X-PAYMENT")) {
      paidCalls++;
      const settle = Buffer.from(JSON.stringify({ success: true, transaction: TX, network: RH.caip2 })).toString("base64");
      return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json", "PAYMENT-RESPONSE": settle } });
    }
    const pr = { x402Version: 2, resource: { url: "https://seller.test/x" }, accepts };
    return new Response("{}", { status: 402, headers: { "content-type": "application/json", "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") } });
  }) as unknown as typeof fetch;
  return { f, paid: () => paidCalls };
}

const hostEntry = (amount = "5000"): ChainBuyEntry => ({ agentId: "host:seller.test", resource: "https://seller.test/x", method: "GET", query: null, body: null, ledgerKey: hostLedgerKey("seller.test"), lock: { payTo: S1, amount } });

function hostDeps(f: typeof fetch, signer?: TypedDataSigner) {
  const k = privateKeyToAccount(generatePrivateKey());
  let signs = 0;
  const run = new Budget(null, HOSTS_RUN.maxTotalAtomic, HOSTS_RUN.maxCount, HOSTS_RUN.maxPerAtomic);
  const lane = new Budget(null, 1_000_000n, 30, 100_000n);
  const d: ChainBuyDeps = {
    fetch: f,
    payer: k.address,
    signer: signer ?? { address: k.address, signTypedData: async (m) => (signs++, k.signTypedData(m as never)) },
    budget: new RunBudget(run, lane),
    readAssetBalance: async () => 1_414_936n,
    verifySettlement: async () => ({ ok: true, from: k.address }),
    dryRun: false,
    maxPerAtomic: HOSTS_RUN.maxPerAtomic,
    minAtomic: HOSTS_RUN.minAtomic,
  };
  return { d, run, lane, signs: () => signs };
}

test("buyOneOnChain with the host run: a live price under the floor or above the lock is refused before any signature or reservation", async () => {
  for (const [live, why] of [["4000", "price_under_floor"], ["6000", "price_raised"], ["10001", "price_over_cap"]] as const) {
    const s = fake402([acc({ amount: live })]);
    const x = hostDeps(s.f);
    const r = await buyOneOnChain(RH, hostEntry(live === "10001" ? "20000" : "5000"), x.d);
    assert.equal(r.refusal?.refused, why, live);
    assert.equal(x.signs(), 0);
    assert.equal(s.paid(), 0);
    assert.equal(x.run.count + x.lane.count, 0);
  }
});

test("buyOneOnChain with the host run: a good purchase lands in both ledgers once; the same host again is already_bought", async () => {
  const s = fake402([acc({ amount: "5000" })]);
  const x = hostDeps(s.f);
  const r = await buyOneOnChain(RH, hostEntry(), x.d);
  assert.equal(r.outcome, "sent");
  assert.equal(r.delivered, true);
  assert.equal(x.run.count, 1);
  assert.equal(x.lane.count, 1);
  assert.equal(x.run.spent, 5_000n);
  const again = await buyOneOnChain(RH, hostEntry(), x.d);
  assert.equal(again.refusal?.refused, "already_bought");
  assert.equal(s.paid(), 1);
});

test("buyOneOnChain with the host run: when the payload cannot be made, both reservations are given back", async () => {
  const s = fake402([acc({ amount: "5000" })]);
  const k = privateKeyToAccount(generatePrivateKey());
  const x = hostDeps(s.f, { address: k.address, signTypedData: async () => { throw new Error("no"); } });
  const r = await buyOneOnChain(RH, hostEntry(), { ...x.d, payer: k.address });
  assert.equal(r.outcome, "not_sent");
  assert.equal(r.refusal?.refused, "payload_check_failed");
  assert.equal(x.run.count + x.lane.count, 0);
  assert.equal(x.run.spent + x.lane.spent, 0n);
  assert.equal(s.paid(), 0);
});

test("createChainPayment refuses an accept above the host run's per-purchase cap", async () => {
  const k = privateKeyToAccount(generatePrivateKey());
  const pr = { x402Version: 2, resource: { url: "https://seller.test/x" }, accepts: [acc({ amount: "10001" })] } as never;
  await assert.rejects(createChainPayment(RH, k, pr, acc({ amount: "10001" }), HOSTS_RUN.maxPerAtomic));
});

// ---------- the run ledger is checked against the records, and one paying run at a time ----------

test("hostRunLedgerProblem: stops when the records hold more sent host purchases than the run ledger, or the ledger is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rh-hosts-"));
  try {
    const rec = join(dir, "robinhood-purchases.jsonl");
    const led = join(dir, HOSTS_RUN.ledger);
    assert.equal(hostRunLedgerProblem(dir), null, "no records, no ledger");
    // Rows of the plain lane (payto: and stock: keys) do not count against the run ledger.
    writeFileSync(rec, [JSON.stringify({ agentId: `payto:${S1}`, outcome: "sent" }), JSON.stringify({ agentId: "stock:AAPL", outcome: "sent" }), JSON.stringify({ agentId: "host:a.test", outcome: "refused" })].join("\n") + "\n");
    assert.equal(hostRunLedgerProblem(dir), null);
    writeFileSync(rec, [JSON.stringify({ agentId: "host:a.test", outcome: "sent" }), JSON.stringify({ agentId: "host:b.test", outcome: "sent" })].join("\n") + "\n");
    assert.match(hostRunLedgerProblem(dir) ?? "", /does not exist/);
    writeFileSync(led, JSON.stringify({ baselineAtomic: "1", spentAtomic: "5000", purchases: [{ key: hostLedgerKey("a.test"), amount: "5000", at: "" }] }));
    assert.match(hostRunLedgerProblem(dir) ?? "", /2.*1|fewer/);
    writeFileSync(led, JSON.stringify({ baselineAtomic: "1", spentAtomic: "10000", purchases: [{ key: hostLedgerKey("a.test"), amount: "5000", at: "" }, { key: hostLedgerKey("b.test"), amount: "5000", at: "" }] }));
    assert.equal(hostRunLedgerProblem(dir), null);
    // An unreadable record line may be a purchase: it counts.
    writeFileSync(rec, [JSON.stringify({ agentId: "host:a.test", outcome: "sent" }), JSON.stringify({ agentId: "host:b.test", outcome: "sent" }), "{not json"].join("\n") + "\n");
    assert.notEqual(hostRunLedgerProblem(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireHostRunLock: one paying host run at a time; the lock is given back", () => {
  const dir = mkdtempSync(join(tmpdir(), "rh-hosts-"));
  try {
    const release = acquireHostRunLock(dir);
    assert.throws(() => acquireHostRunLock(dir), /another host run/);
    release();
    const again = acquireHostRunLock(dir);
    again();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- a paying run buys only what the sent plan says ----------

test("keepPlanned: only entries whose host, resource, method, payTo and amount equal a plan row are kept; any difference is dropped with the reason", () => {
  const picked = pickHostEntries([choice("a.test", "5000"), choice("b.test", "5000", S2), choice("c.test", "10000"), choice("d.test", "5000")], { maxTotalAtomic: 60_000n, maxCount: 10 }).entries;
  const plan = [
    { host: "a.test", resource: "https://a.test/r", method: "GET", payTo: S1.toLowerCase(), amountAtomic: "5000" },
    { host: "b.test", resource: "https://b.test/r", method: "GET", payTo: S1, amountAtomic: "5000" },
    { host: "c.test", resource: "https://c.test/r", method: "GET", payTo: S1, amountAtomic: "6000" },
    { host: "d.test", resource: "https://d.test/other", method: "GET", payTo: S1, amountAtomic: "5000" },
    { host: "e.test", resource: "https://e.test/r", method: "GET", payTo: S1, amountAtomic: "5000" },
  ];
  const r = keepPlanned(picked, plan);
  assert.deepEqual(r.entries.map((e) => e.agentId), ["host:a.test"], "payTo compared without case");
  const why = Object.fromEntries(r.dropped.map((d) => [d.host, d.why]));
  assert.match(why["b.test"]!, /payTo/);
  assert.match(why["c.test"]!, /amount/);
  assert.match(why["d.test"]!, /resource/);
  assert.equal(r.entries[0]!.lock.amount, "5000");
  assert.equal(keepPlanned([choice("z.test", "5000")].map((c) => pickHostEntries([c], { maxTotalAtomic: 60_000n, maxCount: 10 }).entries[0]!), plan).dropped[0]!.why, "not_in_plan");
  assert.equal(keepPlanned(picked, []).entries.length, 0, "an empty plan pays nothing");
});
