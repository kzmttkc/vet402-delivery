import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeAbiParameters, encodeEventTopics, parseAbi } from "viem";
import { readUsdcTransfer } from "../src/evm/erc8004.js";
import { extractSellerPrice, tickerRoot } from "../src/robinhood/stock-check.js";
import { getAddress, hexToString, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Budget } from "../src/guard.js";
import { EVM_CHAINS, LANES } from "../src/evm/chains.js";
import { buyOneOnChain, checkChainAccept, createChainPayment, fencedChainSigner, type ChainBuyDeps, type ChainBuyEntry, type ChainBuyRecord, type EvmAccept, type TypedDataSigner } from "../src/evm/evm-buy.js";
import { classifyRecord, predictFacilitator } from "../src/evm/settle-cause.js";
import { fundingProblem, payGateProblem } from "../src/evm/chains.js";
import { anchorFees } from "../src/evm/evm-anchor.js";
import { inCoreSession } from "../src/robinhood/stock-check.js";
import { buildLanePublic, unpublishableRows, withholdUnnotified } from "../src/evm/site.js";
import { buyOne, checkBaseAccept, type BuyEntry } from "../src/evm/base-buy.js";
import { groupByPayTo, stockEntries } from "../src/evm/lane-plan.js";
import { anchorText, assertAnchorOnly, buildAnchorTx, dayNumber, dayRoot, parseAnchorText, recordDigest } from "../src/evm/evm-anchor.js";
import { verifyInclusion } from "../src/receipt/merkle.js";
import { checkAgainstDirectory, compareStockAnswer, effectiveMultiplier, STOCK_REFS, type StockReference } from "../src/robinhood/stock-check.js";
import { renderArbitrumPage, renderRobinhoodPage, type LanePublic } from "../src/evm/site.js";

const RH = EVM_CHAINS.robinhood;
const ARB = EVM_CHAINS.arbitrum;
const BASE = EVM_CHAINS.base;
const PAYER = getAddress("0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51");
const SELLER = getAddress("0xeF2a4B6756895aAf1374640dcFCD4947959442ab");
const OTHER = getAddress("0x1111111111111111111111111111111111111111");
const TX = ("0x" + "cd".repeat(32)) as Hex;

const acc = (over: Partial<EvmAccept> = {}): EvmAccept => ({
  scheme: "exact",
  network: RH.caip2,
  amount: "50000",
  asset: RH.asset,
  payTo: SELLER,
  maxTimeoutSeconds: 300,
  extra: { name: "Global Dollar", version: "1" },
  ...over,
});
const ctx = { payer: PAYER, lockedPayTo: SELLER, lockedAmount: "50000", maxPerAtomic: LANES.robinhood.maxPerAtomic };

// ---------- accept checks per chain ----------

test("Robinhood accept: only USDG exact on 4663, the Global Dollar domain, EIP-3009, under the lane cap", () => {
  assert.equal(checkChainAccept(RH, acc(), ctx), null);
  assert.equal(checkChainAccept(RH, acc({ asset: BASE.asset }), ctx)?.refused, "asset_mismatch");
  assert.equal(checkChainAccept(RH, acc({ network: BASE.caip2 }), ctx)?.refused, "network_mismatch");
  assert.equal(checkChainAccept(RH, acc({ extra: { name: "USD Coin", version: "2" } }), ctx)?.refused, "domain_mismatch");
  assert.equal(checkChainAccept(RH, acc({ extra: { name: "Global Dollar", version: "1", assetTransferMethod: "permit2" } }), ctx)?.refused, "not_eip3009");
  assert.equal(checkChainAccept(RH, acc({ amount: "100001" }), { ...ctx, lockedAmount: "100001" })?.refused, "price_over_cap");
  assert.equal(checkChainAccept(RH, acc({ amount: "60000" }), ctx)?.refused, "price_raised");
  assert.equal(checkChainAccept(RH, acc({ payTo: OTHER }), ctx)?.refused, "payto_mismatch");
  assert.equal(checkChainAccept(RH, null, ctx)?.refused, "no_robinhood_accept");
  assert.equal(checkChainAccept(RH, acc({ maxTimeoutSeconds: undefined }), ctx)?.refused, "timeout_invalid");
});

test("Arbitrum accept: the payTo must be the same address as the 402's Base accept", () => {
  const a = acc({ network: ARB.caip2, asset: ARB.asset, extra: { name: "USD Coin", version: "2" } });
  assert.equal(checkChainAccept(ARB, a, { ...ctx, crossChainPayTo: { network: BASE.caip2, payTo: SELLER } }), null);
  assert.equal(checkChainAccept(ARB, a, { ...ctx, crossChainPayTo: { network: BASE.caip2, payTo: OTHER } })?.refused, "payto_differs_across_chains");
  assert.equal(checkChainAccept(ARB, a, { ...ctx, crossChainPayTo: { network: BASE.caip2, payTo: null } })?.refused, "payto_differs_across_chains");
});

test("lanes: separate ledgers and caps; the old Base lane (results/base-ledger.json) is not one of them", () => {
  const ledgers = Object.values(LANES).map((l) => l.ledger);
  assert.equal(new Set(ledgers).size, ledgers.length);
  assert.ok(!ledgers.includes("results/base-ledger.json"));
  for (const l of Object.values(LANES)) assert.ok(l.maxPerAtomic <= 100_000n && l.maxTotalAtomic <= 2_000_000n, l.id);
});

// ---------- signing ----------

const throwaway = () => privateKeyToAccount(generatePrivateKey());

test("fenced signer on Robinhood: Global Dollar domain, chain 4663, the USDG contract, the locked payTo and amount, once", async () => {
  const k = throwaway();
  const spy: TypedDataSigner = { address: k.address, signTypedData: async () => "0x01" as Hex };
  const typed = (over: { chainId?: number; name?: string; to?: Address; token?: Address } = {}) => ({
    domain: { name: over.name ?? "Global Dollar", version: "1", chainId: over.chainId ?? 4663, verifyingContract: over.token ?? RH.asset },
    types: {},
    primaryType: "TransferWithAuthorization",
    message: { from: k.address, to: over.to ?? SELLER, value: 50000n, validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + 300), nonce: "0x" + "00".repeat(32) },
  });
  const lock = { payTo: SELLER, amount: "50000" };
  await assert.rejects(fencedChainSigner(RH, spy, lock).signTypedData(typed({ chainId: 8453 })), /chainId/);
  await assert.rejects(fencedChainSigner(RH, spy, lock).signTypedData(typed({ name: "USD Coin" })), /domain/);
  await assert.rejects(fencedChainSigner(RH, spy, lock).signTypedData(typed({ token: BASE.asset })), /verifyingContract/);
  await assert.rejects(fencedChainSigner(RH, spy, lock).signTypedData(typed({ to: OTHER })), /locked payTo/);
  const f = fencedChainSigner(RH, spy, lock);
  await f.signTypedData(typed());
  await assert.rejects(f.signTypedData(typed()), /already signed/);
});

test("createChainPayment on Robinhood: a real EIP-3009 signature over USDG (a token the x402 library does not know), verified", async () => {
  const k = throwaway();
  const pr = { x402Version: 2, resource: { url: "https://seller.test/x" }, accepts: [acc()] } as never;
  const p = await createChainPayment(RH, k, pr, acc(), LANES.robinhood.maxPerAtomic);
  assert.equal(p.authorization.to, SELLER);
  assert.equal(p.authorization.value, "50000");
  assert.ok(Object.keys(p.headers).length > 0);
});

// ---------- buyOneOnChain ----------

function fake402(accepts: EvmAccept[], paid?: { status: number; body: string; settle?: Record<string, unknown> | null }) {
  let paidCalls = 0;
  const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    if (h.has("PAYMENT-SIGNATURE") || h.has("X-PAYMENT")) {
      paidCalls++;
      const headers: Record<string, string> = { "content-type": "application/json" };
      const settle = paid?.settle === undefined ? { success: true, transaction: TX, network: RH.caip2 } : paid.settle;
      if (settle) headers["PAYMENT-RESPONSE"] = Buffer.from(JSON.stringify(settle)).toString("base64");
      return new Response(paid?.body ?? '{"ticker":"AAPL","price":330.1}', { status: paid?.status ?? 200, headers });
    }
    const pr = { x402Version: 2, resource: { url: "https://seller.test/x" }, accepts };
    return new Response("{}", { status: 402, headers: { "content-type": "application/json", "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") } });
  }) as unknown as typeof fetch;
  return { f, paid: () => paidCalls };
}

const entry = (over: Partial<ChainBuyEntry> = {}): ChainBuyEntry => ({ agentId: `payto:${SELLER}`, resource: "https://seller.test/x", method: "GET", query: null, body: null, lock: { payTo: SELLER, amount: "50000" }, ...over });

function deps(f: typeof fetch, over: Partial<ChainBuyDeps> = {}) {
  const k = throwaway();
  let signs = 0;
  const signer: TypedDataSigner = { address: k.address, signTypedData: async (m) => (signs++, k.signTypedData(m as never)) };
  const d: ChainBuyDeps = {
    fetch: f,
    payer: k.address,
    signer,
    budget: new Budget(null, LANES.robinhood.maxTotalAtomic, LANES.robinhood.maxCount, LANES.robinhood.maxPerAtomic),
    readAssetBalance: async () => 1_000_000n,
    verifySettlement: async () => ({ ok: true, from: k.address }),
    dryRun: false,
    maxPerAtomic: LANES.robinhood.maxPerAtomic,
    ...over,
  };
  return { d, signs: () => signs };
}

test("Robinhood dry run: signs with the throwaway key, sends nothing", async () => {
  const s = fake402([acc()]);
  const x = deps(s.f, { dryRun: true });
  const r = await buyOneOnChain(RH, entry(), x.d);
  assert.equal(r.outcome, "would_pay");
  assert.equal(x.signs(), 1);
  assert.equal(s.paid(), 0);
});

test("Robinhood: one purchase per payTo; the stock entries use their own keys, one per ticker", async () => {
  const s = fake402([acc()]);
  const x = deps(s.f, { dryRun: true });
  assert.equal((await buyOneOnChain(RH, entry(), x.d)).outcome, "would_pay");
  assert.equal((await buyOneOnChain(RH, entry(), x.d)).refusal?.refused, "already_bought");
  const stock = stockEntries(SELLER, "50000");
  assert.deepEqual(stock.map((e) => e.query?.ticker), STOCK_REFS.map((r) => r.ticker));
  for (const e of stock) assert.equal((await buyOneOnChain(RH, e, x.d)).outcome, "would_pay", e.agentId);
  assert.equal((await buyOneOnChain(RH, stock[0]!, x.d)).refusal?.refused, "already_bought");
});

test("Arbitrum: a live 402 whose Base payTo differs is refused before any signature", async () => {
  const a = acc({ network: ARB.caip2, asset: ARB.asset, extra: { name: "USD Coin", version: "2" } });
  const b = acc({ network: BASE.caip2, asset: BASE.asset, payTo: OTHER, extra: { name: "USD Coin", version: "2" } });
  const s = fake402([b, a]);
  const x = deps(s.f);
  const r = await buyOneOnChain(ARB, entry({ sameSellerOn: BASE.caip2 }), x.d);
  assert.equal(r.refusal?.refused, "payto_differs_across_chains");
  assert.equal(x.signs(), 0);
  assert.equal(s.paid(), 0);
});

test("paid on Robinhood: settlement read back, answer kept for the stock check, PAYMENT-RESPONSE kept", async () => {
  const s = fake402([acc()]);
  const x = deps(s.f);
  const r = await buyOneOnChain(RH, entry(), x.d, { keepSettleResponse: true, keepBodyBytes: 1000 });
  assert.equal(r.outcome, "sent");
  assert.equal(r.delivered, true);
  assert.equal(r.settleResponse?.transaction, TX);
  assert.match(r.body ?? "", /330\.1/);
  assert.equal(typeof r.paidRequestMs, "number");
});

// ---------- why a paid purchase did not come back ----------

const sent = (over: Partial<ChainBuyRecord>): ChainBuyRecord => ({ agentId: "a", resource: "https://s.test/x", method: "GET", at: "2026-10-04T01:00:00Z", outcome: "sent", ...over });

test("classify: errorReason, chain read-back, body text, then the /supported lead, then route and receipt", () => {
  assert.equal(classifyRecord(sent({ delivered: true })).cause, "delivered");
  assert.equal(classifyRecord(sent({ settleResponse: { success: false, errorReason: "insufficient_funds" } })).cause, "vet402");
  assert.equal(classifyRecord(sent({ settleResponse: { success: false, errorReason: "invalid_network" } })).cause, "facilitator");
  assert.equal(classifyRecord(sent({ settleResponse: { success: false, errorReason: "invalid_exact_evm_payload_recipient_mismatch" } })).cause, "seller_config");
  assert.equal(classifyRecord(sent({ settledOnChain: true, response: { status: 500, contentType: null, bytes: 3, first300: "err" } })).rule, "settled_then_500");
  assert.equal(classifyRecord(sent({ settlementTx: TX, settlementCheck: "not verified: amount_mismatch", response: { status: 200, contentType: null, bytes: 2, first300: "{}" } })).cause, "seller_config");
  assert.equal(classifyRecord(sent({ response: { status: 402, contentType: null, bytes: 40, first300: '{"error":"network eip155:4663 not supported"}' } })).cause, "facilitator");
  const lead = classifyRecord(sent({ response: { status: 402, contentType: null, bytes: 2, first300: "{}" } }), { facilitator: "Dexter", problem: "Dexter's /supported lists Permit2 for exact on eip155:4663; ..." });
  assert.equal(lead.cause, "facilitator");
  assert.equal(lead.evidence, "supported_page");
  assert.match(lead.fix ?? "", /permit2/i);
  assert.equal(classifyRecord(sent({ response: { status: 404, contentType: null, bytes: 0, first300: "" } })).cause, "not_settled");
  assert.equal(classifyRecord(sent({ response: { status: 402, contentType: null, bytes: 2, first300: "{}" } })).cause, "not_settled");
  assert.equal(classifyRecord(sent({})).cause, "unconfirmed");
  assert.equal(classifyRecord({ ...sent({}), outcome: "would_pay" }).cause, "not_paid");
});

test("predictFacilitator: a Dexter 402 on Robinhood is a lead (Permit2 listed), an unknown 402 is none", () => {
  assert.match(predictFacilitator('{"extensions":{"facilitator":"DeXter"}}', RH.caip2, "50000").problem ?? "", /Permit2/);
  assert.equal(predictFacilitator("{}", RH.caip2, "50000").facilitator, null);
  assert.equal(predictFacilitator("ultravioleta", RH.caip2, "1000").problem, null);
});

// ---------- stock check ----------

const ref = (over: Partial<StockReference> = {}): StockReference => ({
  ticker: "ORCL", feed: STOCK_REFS[4]!.feed, token: STOCK_REFS[4]!.token, description: null,
  tokenPrice: 139.0518, answerRaw: "13905180000", decimals: 8, roundId: "1", updatedAt: 1_000, readAt: 1_000 + 3600, ageSec: 3600, stale: false, oraclePaused: false,
  multiplier: 1.00221, sharePrice: 139.0518 / 1.00221, ...over,
});

test("stock check: graded against the share price (feed / multiplier); stale, paused, wrong ticker give no verdict", () => {
  const share = 139.0518 / 1.00221;
  assert.equal(compareStockAnswer("ORCL", JSON.stringify({ ticker: "ORCL", price: share }), ref()).verdict, "agrees");
  const open = "2026-10-05T15:00:00Z"; // Monday 11:00 ET, in the core session
  assert.equal(compareStockAnswer("ORCL", JSON.stringify({ ticker: "ORCL", price: share * 1.01 }), ref(), open).verdict, "close");
  assert.equal(compareStockAnswer("ORCL", JSON.stringify({ ticker: "ORCL", price: share * 1.05 }), ref(), open).verdict, "differs");
  assert.equal(compareStockAnswer("ORCL", JSON.stringify({ data: { symbol: "orcl", current_price: "138.7" } }), ref()).verdict, "agrees");
  assert.equal(compareStockAnswer("ORCL", JSON.stringify({ ticker: "AAPL", price: share }), ref()).verdict, "wrong_ticker");
  assert.equal(compareStockAnswer("ORCL", "not json", ref()).verdict, "unreadable");
  assert.equal(compareStockAnswer("ORCL", JSON.stringify({ price: share }), ref({ stale: true })).verdict, "reference_stale");
  assert.equal(compareStockAnswer("ORCL", JSON.stringify({ price: share }), ref({ oraclePaused: true })).verdict, "reference_paused");
  assert.equal(compareStockAnswer("ORCL", JSON.stringify({ price: share }), ref({ tokenPrice: 0 })).verdict, "reference_invalid");
  // An answer that is the token price, not the share price, is nearer the token price.
  assert.equal(compareStockAnswer("ORCL", JSON.stringify({ price: 139.0518 }), ref()).nearer, "token_price");
});

test("stock check: the new multiplier applies from effectiveAt; fixed feeds must match Chainlink's directory", () => {
  assert.equal(effectiveMultiplier(10n, 20n, 100n, 99), 10n);
  assert.equal(effectiveMultiplier(10n, 20n, 100n, 100), 20n);
  assert.equal(effectiveMultiplier(10n, null, null, 100), 10n);
  const dir = STOCK_REFS.map((r) => ({ name: `Robinhood ${r.ticker} / USD`, proxyAddress: r.feed, heartbeat: 86400 }));
  assert.deepEqual(checkAgainstDirectory(STOCK_REFS, dir), []);
  assert.equal(checkAgainstDirectory(STOCK_REFS, dir.slice(1)).length, 1);
  assert.match(checkAgainstDirectory(STOCK_REFS, [{ ...dir[0]!, proxyAddress: OTHER }, ...dir.slice(1)])[0]!, /proxy/);
});

// ---------- daily root ----------

const line = (at: string, outcome = "sent", n = 1) => JSON.stringify({ at, outcome, resource: `https://s.test/${n}`, payTo: SELLER });

test("daily root: only sent purchases of a closed UTC day; the root proves each record; the text parses back", () => {
  const lines = [line("2026-10-04T01:00:00Z", "sent", 1), line("2026-10-04T02:00:00Z", "refused", 2), line("2026-10-04T03:00:00Z", "sent", 3), line("2026-10-05T00:00:01Z", "sent", 4)];
  const raw = (rec: unknown) => rec;
  assert.throws(() => dayRoot(RH, "2026-10-04", lines, "2026-10-04T23:59:59Z", raw), /not over/);
  const r = dayRoot(RH, "2026-10-04", lines, "2026-10-05T00:10:00Z", raw);
  assert.equal(r.n, 2);
  assert.ok(verifyInclusion(recordDigest(JSON.parse(lines[2]!)), r.proofs[1]!, r.root));
  assert.equal(recordDigest({ b: 1, a: 2 }), recordDigest({ a: 2, b: 1 }), "canonical: key order does not matter");
  const tx = buildAnchorTx(r, PAYER);
  assert.equal(tx.to, PAYER);
  assert.deepEqual(parseAnchorText(hexToString(tx.data)), { chain: RH.caip2, day: "2026-10-04", root: r.root, n: 2 });
  assert.equal(hexToString(tx.data), anchorText(r));
  assert.throws(() => dayRoot(RH, "2026-10-03", lines, "2026-10-05T00:10:00Z", raw), /no sent purchase/);
});

test("anchor transaction: value 0, to itself with exactly the text, or record() on the named registry; anything else refused", () => {
  const r = dayRoot(ARB, "2026-10-04", [line("2026-10-04T01:00:00Z")], "2026-10-05T00:00:00Z", (rec) => rec);
  const tx = buildAnchorTx(r, PAYER);
  assert.doesNotThrow(() => assertAnchorOnly(tx, r));
  assert.throws(() => assertAnchorOnly({ ...tx, value: 1n as 0n }, r), /value/);
  assert.throws(() => assertAnchorOnly({ ...tx, to: OTHER }, r), /to/);
  assert.throws(() => assertAnchorOnly({ ...tx, data: "0x00" }, r), /data/);
  const reg = buildAnchorTx(r, PAYER, OTHER);
  assert.equal(reg.mode, "registry");
  assert.doesNotThrow(() => assertAnchorOnly(reg, r, OTHER));
  assert.throws(() => assertAnchorOnly(reg, r, SELLER), /to/);
  assert.equal(dayNumber("1970-01-02"), 1);
});

// ---------- planning ----------

test("plan: one group per payTo on the chain; Arbitrum keeps only listings whose Base payTo is the same", () => {
  const l = (resource: string, accepts: Record<string, unknown>[]) => ({ resource, accepts }) as never;
  const rhA = { scheme: "exact", network: "eip155:4663", asset: RH.asset, payTo: SELLER, amount: "50000" };
  const arbA = (payTo: string) => ({ scheme: "exact", network: "eip155:42161", asset: ARB.asset, payTo, amount: "1000" });
  const baseA = (payTo: string) => ({ scheme: "exact", network: "eip155:8453", asset: BASE.asset, payTo, amount: "1000" });
  const g = groupByPayTo([l("https://a.test/1", [rhA]), l("https://a.test/2", [{ ...rhA, amount: "10000" }]), l("https://b.test/1", [{ ...rhA, amount: "200000" }])], RH, { maxPerAtomic: 100_000n });
  assert.equal(g.length, 1);
  assert.equal(g[0]!.listings, 3);
  assert.deepEqual(g[0]!.options.map((o) => o.amount), ["10000", "50000"], "cheapest first, over-cap listing not an option");
  const a = groupByPayTo([l("https://c.test/1", [arbA(SELLER), baseA(SELLER)]), l("https://d.test/1", [arbA(OTHER), baseA(SELLER)])], ARB, { sameOn: BASE, maxPerAtomic: 100_000n });
  assert.deepEqual(a.map((x) => x.payTo), [SELLER]);
});

// ---------- public pages ----------

const lanePublic = (lane: "robinhood" | "arbitrum", evil: string): LanePublic => ({
  kind: "vet402-evm-lane",
  lane,
  chain: EVM_CHAINS[lane].caip2,
  generatedAt: "2026-09-30T06:00:00Z",
  source: "purchases",
  catalogs: {},
  payTosInCatalogs: 2,
  payTosOffered: 1,
  rows: [
    { payTo: SELLER, hosts: [`h${evil}`], catalogListings: 1, resource: `https://x/${evil}`, livePrice: "50000", status: "not_settled", cause: { cause: "facilitator", rule: "r", evidence: "supported_page", fix: `fix ${evil}` }, settlementTx: `0x${evil}`, paidRequestMs: 1200, relayer: null, facilitatorLead: evil, skipped: null },
    { payTo: OTHER, hosts: ["ok.test"], catalogListings: 1, resource: null, livePrice: null, status: "not_offered_now", cause: null, settlementTx: null, paidRequestMs: null, relayer: null, facilitatorLead: null, skipped: evil },
  ],
  ...(lane === "arbitrum" ? { compare: [{ resource: `https://x/${evil}`, status: "delivered" as const, cause: null, settlementTx: TX, paidRequestMs: 900, relayer: null }] } : {}),
  ...(lane === "robinhood"
    ? { stock: [{ ticker: "ORCL", reference: { feed: STOCK_REFS[4]!.feed, token: STOCK_REFS[4]!.token, tokenPrice: 139, sharePrice: 138.7, multiplier: 1.0022, updatedAt: 1, readAt: 3601, stale: false, oraclePaused: false }, comparison: null }] }
    : {}),
});

test("Robinhood and Arbitrum pages: escaped, no scripts, links only from 0x+64 hex, English with no first person and no em dash", () => {
  const evil = `"><script>alert(1)</script>`;
  const report = JSON.parse(readFileSync(new URL("../site/rank.json", import.meta.url), "utf8"));
  for (const html of [renderRobinhoodPage(report, null as never, lanePublic("robinhood", evil)), renderArbitrumPage(report, null as never, lanePublic("arbitrum", evil))]) {
    assert.ok(!html.includes("<script>alert"), "escaped");
    assert.ok(!html.includes(`href="https://robinhoodchain.blockscout.com/tx/0x"`), "no link from a bad tx");
    const text = html.replace(/<[^>]+>/g, " ");
    assert.ok(!/[぀-ヿ一-鿿]/.test(text), "no Japanese");
    assert.ok(!text.includes("—"), "no em dash");
    assert.ok(!/\b(we|us|our)\b/i.test(text), "no first person plural");
  }
  const arb = renderArbitrumPage(report, null as never, lanePublic("arbitrum", evil));
  assert.ok(arb.includes(`https://basescan.org/tx/${TX}`), "the Base side links its settlement");
});

test("the lane script reads the key only on --pay with VET402_EVM_PAY; the anchor script only on --send with VET402_ANCHOR_SEND", () => {
  const lane = readFileSync(new URL("../scripts/evm-lane.ts", import.meta.url), "utf8");
  assert.match(lane, /const problem = payGateProblem\(laneArg, process\.env\.VET402_EVM_PAY\);\n  if \(problem\) throw/);
  assert.equal(lane.match(/loadEvmAccount\(\)/g)?.length, 1);
  assert.match(lane, /pay \? loadEvmAccount\(\) : privateKeyToAccount\(generatePrivateKey\(\)\)/);
  const anchor = readFileSync(new URL("../scripts/evm-anchor.ts", import.meta.url), "utf8");
  assert.match(anchor, /if \(send && process\.env\.VET402_ANCHOR_SEND !== lane\) throw/);
  assert.ok(!anchor.includes("loadEvmAccount"), "the daily root is never signed by the payer wallet");
  assert.equal(anchor.match(/loadRootsPoster\(\)/g)?.length, 1);
  assert.ok(anchor.indexOf("loadRootsPoster()") > anchor.indexOf("if (!send)"), "the key is read after the no-send exit");
});

// ---------- fixes before paying and publishing (review 2026-09-30) ----------

test("1: a payment that did not settle is 'sent, not settled', never 'settled, no answer', and no seller fault", () => {
  const dry = { generatedAt: "2026-10-04T00:00:00Z", catalogs: {}, robinhood: { payTosInCatalogs: 1, payTosWithLive402: 1, choices: [{ payTo: SELLER, catalogListings: 1, hosts: ["s.test"], chosen: { resource: "https://s.test/x", liveAmount: "1000" } }] } };
  const rec = (over: Partial<ChainBuyRecord>) => ({ ...sent({ resource: "https://s.test/x", payTo: SELLER, ...over }), lane: "robinhood", cause: classifyRecord(sent(over)) });
  const notSettled = buildLanePublic("robinhood", dry, [rec({ response: { status: 402, contentType: null, bytes: 2, first300: "{}" } })]);
  assert.equal(notSettled.rows[0]!.status, "not_settled");
  assert.notEqual(notSettled.rows[0]!.cause?.cause, "seller_config");
  const settled = buildLanePublic("robinhood", dry, [rec({ settledOnChain: true, settlementTx: TX, response: { status: 500, contentType: null, bytes: 1, first300: "e" } })]);
  assert.equal(settled.rows[0]!.status, "settled_no_answer");
  assert.equal(settled.rows[0]!.cause?.cause, "seller_config");
});

test("2: an RPC timeout while reading the settlement back is vet402's 'could not confirm', not the seller's setup", () => {
  const timeout = classifyRecord(sent({ settlementTx: TX, settlementCheck: "not verified: receipt not found in 60 s", response: { status: 200, contentType: null, bytes: 2, first300: "{}" } }));
  assert.equal(timeout.cause, "unconfirmed");
  assert.equal(classifyRecord(sent({ settlementTx: TX, settlementCheck: "not verified: fetch failed", response: { status: 200, contentType: null, bytes: 2, first300: "{}" } })).cause, "unconfirmed");
  for (const why of ["amount_mismatch", "no_usdc_transfer_to_seller"]) {
    assert.equal(classifyRecord(sent({ settlementTx: TX, settlementCheck: `not verified: ${why}`, response: { status: 200, contentType: null, bytes: 2, first300: "{}" } })).cause, "seller_config", why);
  }
});

test("3: negative results are withheld until the seller is in notified.json, and a lane file that shows them does not build", () => {
  const evil = "x";
  const l = lanePublic("arbitrum", evil);
  const neg = { ...l, rows: [{ ...l.rows[0]!, resource: "https://bad.test/x", hosts: ["bad.test"] }], compare: [{ resource: "https://bad.test/x", status: "settled_no_answer" as const, cause: null, settlementTx: TX, paidRequestMs: 1, relayer: null }] };
  assert.ok(unpublishableRows(neg, new Set()).length >= 2);
  const w = withholdUnnotified(neg, new Set());
  assert.equal(w.rows[0]!.status, "withheld");
  assert.equal(w.rows[0]!.cause, null);
  assert.equal(w.rows[0]!.facilitatorLead, null);
  assert.equal(w.compare!.find((c) => c.resource === "https://bad.test/x")!.status, "withheld");
  assert.deepEqual(unpublishableRows(w, new Set()), []);
  const told = withholdUnnotified(neg, new Set(["bad.test"]));
  assert.equal(told.rows[0]!.status, "not_settled");
  // A neutral skip (the 402 no longer lists the chain) stays; an accusation (wrong domain) is withheld.
  const skip = (why: string) => withholdUnnotified({ ...l, compare: [], rows: [{ ...l.rows[1]!, hosts: ["n.test"], skipped: why }] }, new Set()).rows[0]!;
  assert.equal(skip("the live 402 no longer offers Arbitrum One").skipped, "the live 402 no longer offers Arbitrum One");
  const accused = skip("the 402 names a token domain that is not the token's own");
  assert.equal(accused.skipped, null, "the accusation is not published");
  assert.equal(accused.status, "not_offered_now", "an unbought row is never shown as bought");
  // A stock verdict against the seller is withheld too.
  const r = lanePublic("robinhood", evil);
  const cmp = { ...compareStockAnswer("ORCL", JSON.stringify({ price: 150 }), ref(), "2026-10-05T15:00:00Z"), ticker: "ORCL" };
  const st = withholdUnnotified({ ...r, rows: [], stock: [{ ...r.stock![0]!, resource: "https://equity.lonestaroracle.xyz/equity", comparison: cmp }] }, new Set());
  assert.equal(st.stock![0]!.comparison, null);
  assert.equal(st.stock![0]!.withheld, true);
});

test("4: the anchor is signed only within the chain's gas and fee caps and the wallet's ETH", () => {
  const rh = EVM_CHAINS.robinhood;
  const f = anchorFees(rh, 23_686n, { maxFeePerGas: 30_000_000n, maxPriorityFeePerGas: 0n }, 10n ** 15n);
  assert.equal(f.gas, 29_608n);
  assert.equal(f.boundWei, 29_608n * 30_000_000n);
  assert.throws(() => anchorFees(rh, 60_000n, { maxFeePerGas: 1n, maxPriorityFeePerGas: 0n }, 10n ** 15n), /gas/);
  assert.throws(() => anchorFees(rh, 23_686n, { maxFeePerGas: 10n ** 12n, maxPriorityFeePerGas: 0n }, 10n ** 18n), /fee bound/);
  assert.throws(() => anchorFees(rh, 23_686n, { maxFeePerGas: 30_000_000n, maxPriorityFeePerGas: 0n }, 1n), /ETH/);
  const src = readFileSync(new URL("../scripts/evm-anchor.ts", import.meta.url), "utf8");
  assert.match(src, /sendTransaction\(\{[^}]*gas: fees\.gas, maxFeePerGas: fees\.maxFeePerGas/);
  assert.ok(src.indexOf("anchorFees(") < src.indexOf("loadRootsPoster()"), "caps before the key is read");
});

test("5: a paying run never signs a purchase the wallet cannot cover; a lane with a daily root keeps ETH for it", async () => {
  const s = fake402([acc()]);
  const x = deps(s.f, { readAssetBalance: async () => 49_999n });
  const r = await buyOneOnChain(RH, entry(), x.d);
  assert.equal(r.refusal?.refused, "insufficient_balance");
  assert.equal(x.signs(), 0);
  assert.equal(x.d.budget.count, 0, "nothing reserved");
  const dry = await buyOneOnChain(RH, entry(), deps(s.f, { readAssetBalance: async () => 0n, dryRun: true }).d);
  assert.equal(dry.outcome, "would_pay");
  assert.equal(dry.balanceShort, true);
  assert.match(fundingProblem(LANES.robinhood, 478_192n, 478_191n, 10n ** 15n) ?? "", /USDG balance/);
  assert.match(fundingProblem(LANES.robinhood, 478_192n, 500_000n, 1n) ?? "", /ETH/);
  assert.equal(fundingProblem(LANES.robinhood, 478_192n, 500_000n, EVM_CHAINS.robinhood.anchorMaxFeeWei), null);
  assert.equal(fundingProblem(LANES["base-compare"], 1n, 1n, 0n), null, "no daily root on the Base side");
});

test("6: --pay --lane arbitrum pays on Base too, so VET402_EVM_PAY must name both lanes", () => {
  assert.equal(payGateProblem("robinhood", "robinhood"), null);
  assert.match(payGateProblem("arbitrum", "arbitrum") ?? "", /missing: base-compare/);
  assert.equal(payGateProblem("arbitrum", "arbitrum,base-compare"), null);
  assert.match(payGateProblem("robinhood", "arbitrum,base-compare") ?? "", /missing: robinhood/);
  assert.match(payGateProblem("arbitrum", undefined) ?? "", /Example: VET402_EVM_PAY=arbitrum,base-compare/);
  const lane = readFileSync(new URL("../scripts/evm-lane.ts", import.meta.url), "utf8");
  assert.match(lane, /payGateProblem\(laneArg, process\.env\.VET402_EVM_PAY\)/);
  assert.ok(lane.indexOf('preflight(LANES["base-compare"]') < lane.indexOf("results.push(await runLane(lane, arbEntries"), "both lanes checked before either signs");
});

test("7: Base stays fail-closed on agentWallet: an entry or a context without it is refused, nothing signed", async () => {
  assert.equal(checkBaseAccept(acc({ network: BASE.caip2, asset: BASE.asset, extra: { name: "USD Coin", version: "2" } }), { payer: PAYER, lockedPayTo: SELLER, lockedAmount: "50000", agentWallet: undefined as unknown as string })?.refused, "payto_not_agent_wallet");
  const s = fake402([acc({ network: BASE.caip2, asset: BASE.asset, extra: { name: "USD Coin", version: "2" } })]);
  const k = throwaway();
  let signs = 0;
  const r = await buyOne({ agentId: "1", resource: "https://seller.test/x", method: "GET", query: null, body: null, lock: { payTo: SELLER, amount: "50000" } } as unknown as BuyEntry, {
    fetch: s.f, payer: k.address, signer: { address: k.address, signTypedData: async (m) => (signs++, k.signTypedData(m as never)) }, budget: new Budget(null),
    readUsdcBalance: async () => 5_000_000n, readAgentWallet: async () => SELLER, verifySettlement: async () => ({ ok: true, from: k.address }), dryRun: true,
  });
  assert.equal(r.refusal?.refused, "payto_not_agent_wallet");
  assert.equal(signs, 0);
  assert.equal(s.paid(), 0);
});

test("8: no committed file still says a facilitator settles 'Permit2 only'", () => {
  for (const f of ["../results/evm/robinhood-dryrun.json", "../results/evm/arbitrum-dryrun.json", "../data/evm/robinhood.json", "../data/evm/arbitrum.json", "../site/robinhood.html", "../site/arbitrum.html", "../src/evm/settle-cause.ts"]) {
    assert.ok(!/Permit2 only/i.test(readFileSync(new URL(f, import.meta.url), "utf8")), f);
  }
});

test("9: outside the NYSE core session an answer more than 0.5% off is 'market_closed', not 'close' or 'differs'", () => {
  assert.equal(inCoreSession("2026-10-05T14:00:00Z"), true, "Mon 10:00 ET");
  assert.equal(inCoreSession("2026-10-05T13:29:00Z"), false, "Mon 9:29 ET");
  assert.equal(inCoreSession("2026-10-05T20:00:00Z"), false, "Mon 16:00 ET");
  assert.equal(inCoreSession("2026-10-04T15:00:00Z"), false, "Sunday");
  assert.equal(inCoreSession("2026-11-26T15:00:00Z"), false, "Thanksgiving");
  assert.equal(inCoreSession("2026-11-27T17:30:00Z"), true, "early close day, 12:30 ET");
  assert.equal(inCoreSession("2026-11-27T18:30:00Z"), false, "early close day, 13:30 ET");
  assert.equal(inCoreSession("2026-12-07T15:00:00Z"), true, "Mon 10:00 EST");
  assert.equal(inCoreSession("2027-01-04T15:00:00Z"), false, "no 2027 calendar yet: closed");
  const share = 139.0518 / 1.00221;
  const at = (iso?: string) => compareStockAnswer("ORCL", JSON.stringify({ ticker: "ORCL", price: share * 1.05 }), ref(), iso).verdict;
  assert.equal(at("2026-10-05T15:00:00Z"), "differs");
  assert.equal(at("2026-10-05T23:00:00Z"), "market_closed");
  assert.equal(at(undefined), "market_closed");
  assert.equal(compareStockAnswer("ORCL", JSON.stringify({ price: share }), ref(), "2026-10-04T15:00:00Z").verdict, "agrees", "a right answer is still right");
});

// ---------- publication evidence (review of 0389d6e) ----------

const tAbi = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);
const tlog = (from: string, to: string, value: bigint) => ({
  address: RH.asset,
  topics: encodeEventTopics({ abi: tAbi, eventName: "Transfer", args: { from: from as Hex, to: to as Hex } }),
  data: encodeAbiParameters([{ type: "uint256" }], [value]),
});
const receipt = (status: string, logs: unknown[]) => ({ getTransactionReceipt: async () => ({ status, logs, blockNumber: 1n }) }) as never;

test("6: only vet402's own Transfer counts; a batched settlement with another buyer's transfer first is still vet402's payment", async () => {
  const exp = { to: SELLER, amountUnits: "50000", asset: RH.asset, from: PAYER };
  const a = await readUsdcTransfer(receipt("success", [tlog(OTHER, SELLER, 7n), tlog(PAYER, SELLER, 50000n)]), TX, exp);
  assert.equal(a.ok, true);
  assert.equal(getAddress(a.from!), PAYER);
  const b = await readUsdcTransfer(receipt("success", [tlog(OTHER, SELLER, 50000n)]), TX, exp);
  assert.equal(b.reason, "no_usdc_transfer_to_seller", "another buyer's same-amount transfer is not vet402's");
  const c = await readUsdcTransfer(receipt("success", [tlog(OTHER, SELLER, 50000n), tlog(PAYER, SELLER, 49000n)]), TX, exp);
  assert.equal(c.reason, "amount_mismatch");
  const lane = readFileSync(new URL("../scripts/evm-lane.ts", import.meta.url), "utf8");
  assert.match(lane, /asset: c\.asset, from: payer \}/);
});

test("7: a reverted settlement, an unsupported token or network, and a pending one are never the seller's setup", () => {
  const rev = classifyRecord(sent({ settlementTx: TX, settlementCheck: "not verified: tx_status_reverted", response: { status: 500, contentType: null, bytes: 0, first300: "" } }));
  assert.equal(rev.cause, "not_settled");
  const by = (r: string) => classifyRecord(sent({ settleResponse: { success: false, errorReason: r }, response: { status: 402, contentType: null, bytes: 0, first300: "" } })).cause;
  for (const r of ["asset_not_deployed_contract", "erc20_approval_asset_mismatch", "unsupported_asset_transfer_method", "Asset not supported on this network", "invalid_exact_evm_eip3009_not_supported", "unsupported_payload_type"]) assert.equal(by(r), "facilitator", r);
  for (const r of ["settlement_pending", "invalid_exact_evm_transaction_failed"]) assert.equal(by(r), "unconfirmed", r);
  for (const r of ["invalid_exact_evm_insufficient_balance", "invalid_exact_evm_signature"]) assert.equal(by(r), "vet402", r);
  assert.equal(by("invalid_exact_evm_recipient_mismatch"), "seller_config");
});

test("8: every seller-facing fix says what vet402 saw, not what it guessed", () => {
  const texts = ["amount_mismatch", "no_usdc_transfer_to_seller"].map((w) => classifyRecord(sent({ settlementTx: TX, settlementCheck: `not verified: ${w}`, response: { status: 200, contentType: null, bytes: 2, first300: "{}" } })).fix ?? "");
  assert.match(texts[0]!, /different amount from vet402 to the payTo/);
  assert.match(texts[1]!, /no transfer from vet402 to the payTo/);
  const rm = classifyRecord(sent({ settleResponse: { success: false, errorReason: "invalid_exact_evm_recipient_mismatch" }, response: { status: 402, contentType: null, bytes: 0, first300: "" } })).fix ?? "";
  assert.match(rm, /^The facilitator reported/);
  assert.ok(!/did not pay the payTo/.test(readFileSync(new URL("../src/evm/settle-cause.ts", import.meta.url), "utf8")));
});

test("9: an answer vet402 cannot read is 'unreadable', never a verdict against the seller; readable shapes are read", () => {
  const r0 = { ...ref(), tokenPrice: 100.2, multiplier: 1.002, sharePrice: 100 };
  const open = "2026-11-02T15:00:00Z";
  const v = (b: string) => compareStockAnswer("ORCL", b, r0, open).verdict;
  assert.equal(v('{"data":{"quote":{"price":100}}}'), "agrees", "nested three levels");
  assert.equal(v('[{"symbol":"ORCL","price":100}]'), "agrees", "array");
  assert.equal(v('{"price":"$100.00"}'), "agrees", "dollar string");
  assert.equal(v('{"symbol":"ORCL.US","price":100}'), "agrees", "ticker with a suffix");
  assert.equal(v('{"symbol":"NYSE:ORCL","price":100}'), "agrees", "ticker with an exchange");
  assert.equal(v('{"symbol":"ORCL","close":100}'), "unreadable", "close is not read as the price");
  assert.equal(v('{"a":{"b":{"c":{"d":{"price":100}}}}}'), "unreadable", "deeper than three levels");
  assert.equal(v('{"symbol":"AAPL","price":100}'), "wrong_ticker");
  assert.equal(tickerRoot("brk.b"), "BRK");
  assert.deepEqual(extractSellerPrice('{"price":"1,234.50"}'), { ticker: null, price: 1234.5 });
  const l = lanePublic("robinhood", "x");
  const withVerdict = (verdict: string) => withholdUnnotified({ ...l, rows: [], stock: [{ ...l.stock![0]!, resource: "https://equity.lonestaroracle.xyz/equity", comparison: { ...compareStockAnswer("ORCL", "{}", r0, open), verdict: verdict as never } }] }, new Set()).stock![0]!;
  assert.notEqual(withVerdict("unreadable").comparison, null, "unreadable is published: it is vet402's limit");
  assert.equal(withVerdict("differs").comparison, null);
});

test("10: a payTo bought through another of its hosts shows, and is gated by, the host and resource actually bought", () => {
  const dry = { generatedAt: "2026-10-04T00:00:00Z", catalogs: {}, robinhood: { payTosInCatalogs: 1, payTosWithLive402: 1, choices: [{ payTo: SELLER, catalogListings: 12, hosts: ["equity.lonestaroracle.xyz", "options.lonestaroracle.xyz"], chosen: { resource: "https://options.lonestaroracle.xyz/flow", liveAmount: "10000" } }] } };
  const rec = (t: string) => ({ ...sent({ agentId: `stock:${t}`, resource: "https://equity.lonestaroracle.xyz/equity", payTo: SELLER, amountAtomic: "50000", response: { status: 402, contentType: null, bytes: 2, first300: "{}" } }), lane: "robinhood", cause: classifyRecord(sent({ response: { status: 402, contentType: null, bytes: 2, first300: "{}" } })) });
  const out = buildLanePublic("robinhood", dry, ["AAPL", "TSLA"].map(rec));
  const row = out.rows[0]!;
  assert.equal(row.resource, "https://equity.lonestaroracle.xyz/equity", "not options/flow");
  assert.equal(row.livePrice, "50000", "the price actually paid");
  assert.equal(row.hosts[0], "equity.lonestaroracle.xyz");
  assert.equal(row.purchases, 2);
  assert.equal(row.settled, 0);
  assert.equal(withholdUnnotified(out, new Set(["options.lonestaroracle.xyz"])).rows[0]!.status, "withheld", "telling another host of the payTo does not publish it");
  assert.equal(withholdUnnotified(out, new Set(["equity.lonestaroracle.xyz"])).rows[0]!.status, "not_settled");
});

test("16: a settlement vet402 could not read back is shown as such, not as 'no settlement'", () => {
  const dry = { generatedAt: "2026-10-04T00:00:00Z", catalogs: {}, robinhood: { payTosInCatalogs: 1, payTosWithLive402: 1, choices: [{ payTo: SELLER, catalogListings: 1, hosts: ["s.test"], chosen: { resource: "https://s.test/x", liveAmount: "1000" } }] } };
  const r = sent({ resource: "https://s.test/x", payTo: SELLER, settlementTx: TX, settlementCheck: "not verified: receipt not found in 60 s", response: { status: 200, contentType: null, bytes: 2, first300: "{}" } });
  const out = buildLanePublic("robinhood", dry, [{ ...r, lane: "robinhood", cause: classifyRecord(r) } as never]);
  assert.equal(out.rows[0]!.status, "unconfirmed");
  const html = renderRobinhoodPage(JSON.parse(readFileSync(new URL("../site/rank.json", import.meta.url), "utf8")), null as never, withholdUnnotified(out, new Set(["s.test"])));
  assert.ok(html.includes("vet402 could not read the settlement back"));
  assert.ok(!html.includes("no settlement came back"));
});

test("3b: a delivered row stays delivered for an untold seller; only a facilitator lead on it is dropped", () => {
  const l = lanePublic("arbitrum", "x");
  const d = { ...l, compare: [], rows: [{ ...l.rows[0]!, resource: "https://z.test/x", hosts: ["z.test"], status: "delivered" as const, cause: { cause: "delivered" as const, rule: "d", evidence: "chain" as const, fix: null }, facilitatorLead: "Dexter lists Permit2" }] };
  const w = withholdUnnotified(d, new Set()).rows[0]!;
  assert.equal(w.status, "delivered");
  assert.equal(w.facilitatorLead, null);
  assert.deepEqual(unpublishableRows(withholdUnnotified(d, new Set()), new Set()), []);
});

test("publish decides causes and stock verdicts again with the current rules", () => {
  const src = readFileSync(new URL("../scripts/evm-publish.ts", import.meta.url), "utf8");
  assert.match(src, /const cause = classifyRecord\(r,/);
  assert.match(src, /compareStockAnswer\(ticker, r\.body, ref, r\.at\)/);
  assert.ok(src.indexOf("classifyRecord(r,") < src.indexOf("buildLanePublic(lane, dry, paid)"));
});

test("stock rows: a paid purchase that did not come back is 'bought', withheld for an untold seller, never 'not bought yet'", () => {
  const dry = { generatedAt: "2026-10-04T00:00:00Z", catalogs: {}, robinhood: { payTosInCatalogs: 1, payTosWithLive402: 1, choices: [], stockReferences: [ref()] } };
  const p = { ...sent({ agentId: "stock:ORCL", resource: "https://equity.lonestaroracle.xyz/equity", payTo: SELLER, response: { status: 402, contentType: null, bytes: 2, first300: "{}" } }), lane: "robinhood", cause: classifyRecord(sent({ response: { status: 402, contentType: null, bytes: 2, first300: "{}" } })) };
  const out = buildLanePublic("robinhood", dry, [p as never]);
  assert.equal(out.stock![0]!.status, "not_settled");
  assert.equal(unpublishableRows(out, new Set()).length, 1);
  const w = withholdUnnotified(out, new Set());
  assert.equal(w.stock![0]!.withheld, true);
  assert.deepEqual(unpublishableRows(w, new Set()), []);
  const html = renderRobinhoodPage(JSON.parse(readFileSync(new URL("../site/rank.json", import.meta.url), "utf8")), null as never, w);
  assert.ok(!html.includes("not bought yet"), "the bought ticker is not shown as not bought");
  assert.equal(withholdUnnotified(out, new Set(["equity.lonestaroracle.xyz"])).stock![0]!.status, "not_settled");
  const src = readFileSync(new URL("../scripts/evm-publish.ts", import.meta.url), "utf8");
  assert.match(src, /-paid-run\.json/);
});

test("withheld rows keep only neutral facts: no settled count; stock references are the ones read at purchase time", () => {
  const dry = { generatedAt: "2026-10-04T00:00:00Z", catalogs: {}, robinhood: { payTosInCatalogs: 1, payTosWithLive402: 1, choices: [{ payTo: SELLER, catalogListings: 12, hosts: ["equity.lonestaroracle.xyz"], chosen: { resource: "https://equity.lonestaroracle.xyz/equity", liveAmount: "50000" } }], stockReferences: [ref()] } };
  const later = { ...ref(), readAt: 999_999, updatedAt: 999_000, ageSec: 999 };
  const rec = (t: string) => ({ ...sent({ agentId: `stock:${t}`, resource: "https://equity.lonestaroracle.xyz/equity", payTo: SELLER, response: { status: 402, contentType: null, bytes: 2, first300: "{}" } }), lane: "robinhood", cause: classifyRecord(sent({ response: { status: 402, contentType: null, bytes: 2, first300: "{}" } })), stock: { ticker: t, verdict: "not_bought_yet", reference: later } });
  const out = buildLanePublic("robinhood", dry, [rec("ORCL"), rec("ORCL")] as never);
  assert.equal(out.stock![0]!.reference.readAt, 999_999);
  const w = withholdUnnotified(out, new Set()).rows[0]!;
  assert.equal(w.status, "withheld");
  assert.equal(w.purchases, 2);
  assert.equal(w.settled, undefined);
  const html = renderRobinhoodPage(JSON.parse(readFileSync(new URL("../site/rank.json", import.meta.url), "utf8")), null as never, withholdUnnotified(out, new Set()));
  assert.ok(!/settled on chain<\/span>/.test(html.replace(/came back/g, "")) || !html.includes("0 settled"), "no settled count on a withheld row");
  assert.ok(!html.includes("0 settled on chain"));
});

test("Base receipts are read from mainnet.base.org (publicnode rejects eth_getTransactionReceipt); unconfirmed rows can be read again", async () => {
  assert.equal(EVM_CHAINS.base.receiptRpc, "https://mainnet.base.org");
  const lane = readFileSync(new URL("../scripts/evm-lane.ts", import.meta.url), "utf8");
  assert.match(lane, /readUsdcTransfer\(receiptClient\(c\), tx,/);
  const { reverifyRecord } = await import("../src/evm/settle-cause.js");
  const r = sent({ payTo: SELLER, amountAtomic: "50000", settlementTx: TX, settledOnChain: false, delivered: false, settlementCheck: "not verified: receipt not found in 60 s", response: { status: 200, contentType: null, bytes: 12, first300: '{"ok":true}' } });
  const ok = reverifyRecord(r, { ok: true, from: PAYER }, PAYER);
  assert.equal(ok.settledOnChain, true);
  assert.equal(ok.delivered, true);
  assert.equal(classifyRecord(ok).cause, "delivered");
  const other = reverifyRecord(r, { ok: true, from: OTHER }, PAYER);
  assert.equal(other.settledOnChain, false, "only vet402's own transfer");
  const still = reverifyRecord(r, { ok: false, reason: "receipt unreadable: x" }, PAYER);
  assert.equal(classifyRecord(still).cause, "unconfirmed");
  const empty = reverifyRecord({ ...r, response: { status: 200, contentType: null, bytes: 0, first300: "" } }, { ok: true, from: PAYER }, PAYER);
  assert.equal(empty.delivered, false);
  assert.equal(classifyRecord(empty).cause, "seller_config", "settled with an empty answer");
  // The publish reads the re-read settlements through src/evm/lane-records.ts (purchases, reverify, chain check).
  const pub = readFileSync(new URL("../scripts/evm-publish.ts", import.meta.url), "utf8");
  assert.match(pub, /loadLaneRecordsChecked\(lanes\)/);
  const rec = readFileSync(new URL("../src/evm/lane-records.ts", import.meta.url), "utf8");
  assert.match(rec, /\["purchases", "reverify", "chaincheck"\]/);
});

test("secret gate: the public lane files and pages pass it (a seller URL is never a JSON key; currentMultiplier is allowed by value)", async () => {
  const { scanText } = await import("../src/daily/secret-gate.js").catch(() => ({ scanText: undefined }));
  const l = lanePublic("arbitrum", "x");
  const withToken = { ...l, compare: [{ resource: "https://a.test/v1/token_verdict_api/token_analysis_api", status: "not_bought_yet" as const, cause: null, settlementTx: null, paidRequestMs: null, relayer: null }] };
  const text = JSON.stringify(withToken, null, 2);
  assert.ok(!text.includes('"https://a.test/v1/token_verdict_api/token_analysis_api": {'), "the URL is a value, not a key");
  const allow = JSON.parse(readFileSync(new URL("../scripts/daily/secret-allow.json", import.meta.url), "utf8")) as { allow: { sha256: string; kind: string; reason: string }[] };
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256").update("currentMultiplier").digest("hex");
  const e = allow.allow.find((a) => a.sha256 === h);
  assert.equal(e?.kind, "opaque-40");
  assert.match(e?.reason ?? "", /docs\.robinhood\.com/);
  void scanText;
});

test("a purchase vet402 refused before paying is 'not bought' for an untold seller, never 'bought'", () => {
  const dry = { generatedAt: "2026-10-04T00:00:00Z", catalogs: {}, arbitrum: { payTosInCatalogs: 1, payTosWithLive402: 1, choices: [{ payTo: SELLER, catalogListings: 1, hosts: ["r.test"], chosen: { resource: "https://r.test/x", liveAmount: "1000" } }] } };
  const arb = { ...sent({ resource: "https://r.test/x", payTo: SELLER, settledOnChain: true, delivered: true, settlementTx: TX }), lane: "arbitrum", cause: { cause: "delivered", rule: "d", evidence: "chain", fix: null } };
  const baseRefused = { agentId: `payto:${SELLER}`, resource: "https://r.test/x", method: "GET", at: "2026-10-04T01:00:00Z", outcome: "refused", refusal: { refused: "no_base_accept", detail: "x" }, lane: "base-compare", cause: { cause: "not_paid", rule: "refused:no_base_accept", evidence: "none", fix: null } };
  const out = buildLanePublic("arbitrum", dry, [arb, baseRefused] as never);
  assert.equal(out.compare![0]!.status, "refused");
  const w = withholdUnnotified(out, new Set());
  assert.equal(w.compare![0]!.status, "not_offered_now");
  assert.deepEqual(unpublishableRows(w, new Set()), []);
  const row = withholdUnnotified({ ...out, rows: [{ ...out.rows[0]!, status: "refused" }] }, new Set()).rows[0]!;
  assert.equal(row.status, "not_offered_now");
});

test("the Base column follows the listing the paying run bought, even when the dry run had no plan for that payTo", () => {
  const dry = { generatedAt: "2026-10-04T00:00:00Z", catalogs: {}, arbitrum: { payTosInCatalogs: 1, payTosWithLive402: 0, choices: [{ payTo: SELLER, catalogListings: 1, hosts: ["f.test"], chosen: null }] } };
  const mk = (lane: string, tx: Hex) => ({ ...sent({ resource: "https://f.test/x", payTo: SELLER, amountAtomic: "1000", settledOnChain: true, delivered: true, settlementTx: tx }), lane, cause: { cause: "delivered", rule: "d", evidence: "chain", fix: null } });
  const out = buildLanePublic("arbitrum", dry, [mk("arbitrum", TX), mk("base-compare", ("0x" + "ef".repeat(32)) as Hex)] as never);
  assert.equal(out.rows[0]!.status, "delivered");
  assert.equal(out.compare!.find((c) => c.resource === "https://f.test/x")?.status, "delivered");
});


test("the ledger, not the hold, limits money: after a hold ends, the same seller is refused as already_bought by the real ledger (nothing signed, nothing paid)", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { holdAfter4xx, lastPaidByListing, INPUT_4XX_RETRY_MS, repairLaneRequest } = await import("../src/evm/lane-input.js");
  const dir = mkdtempSync(join(tmpdir(), "vet402-ledger-once-"));
  try {
    const ledger = join(dir, "robinhood-ledger.json");
    const body = '"address" is required';
    const s = fake402([acc()], { status: 400, body, settle: { success: true, transaction: TX, network: RH.caip2 } });
    // First paying run: the purchase goes through the real ledger file, and the seller's 400 reads as vet402's own wrong request.
    const run1 = deps(s.f, { budget: new Budget(ledger, LANES.robinhood.maxTotalAtomic, LANES.robinhood.maxCount, LANES.robinhood.maxPerAtomic) });
    const e = entry({ declaredParams: ["address"] });
    const first = await buyOneOnChain(RH, e, run1.d);
    assert.equal(first.outcome, "sent");
    assert.equal(s.paid(), 1);
    const last = lastPaidByListing([first]).get(first.resource)!;
    assert.equal(last.inputError, true);
    // 31 days later the hold has ended, and the plan would offer the same request again...
    const later = Date.parse(first.at) + INPUT_4XX_RETRY_MS + 86_400_000;
    assert.equal(holdAfter4xx(last, later), null);
    assert.equal(repairLaneRequest({ resource: e.resource } as never, { resource: e.resource, method: "GET", query: null, body: null }, "2026-11-01", last, later).ok, true);
    // ...but the next paying run reads the same ledger and refuses the seller before any signature.
    const run2 = deps(s.f, { budget: new Budget(ledger, LANES.robinhood.maxTotalAtomic, LANES.robinhood.maxCount, LANES.robinhood.maxPerAtomic) });
    const again = await buyOneOnChain(RH, e, run2.d);
    assert.equal(again.outcome, "refused");
    assert.equal(again.refusal?.refused, "already_bought");
    assert.equal(run2.signs(), 0, "nothing signed");
    assert.equal(s.paid(), 1, "nothing paid again");
  } finally {
    rmSync(dir, { recursive: true });
  }
});


test("--pay keeps its ledger beside the key: from another working tree it uses that ledger, and stops when the ledger holds fewer purchases than the records sent", async () => {
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { laneLedgerPath, ledgerBehindRecords, payResultsDir } = await import("../src/evm/run-dir.js");
  assert.equal(payResultsDir({}, "/home/x/vet402-solana/.keys"), "/home/x/vet402-solana/results/evm");
  assert.equal(payResultsDir({ VET402_EVM_RESULTS_DIR: "/elsewhere" }, "/home/x/vet402-solana/.keys"), "/elsewhere");
  assert.equal(laneLedgerPath(LANES.robinhood, "/r"), "/r/robinhood-ledger.json");
  // A production-like root (keys and results side by side) and another working tree as the cwd.
  const root = mkdtempSync(join(tmpdir(), "vet402-prod-root-"));
  const other = mkdtempSync(join(tmpdir(), "vet402-other-tree-"));
  try {
    const keys = join(root, ".keys");
    const results = join(root, "results", "evm");
    mkdirSync(keys, { recursive: true }); // empty: no evm.pub, so nothing can be signed whatever happens
    mkdirSync(results, { recursive: true });
    const sent = (i: number) => JSON.stringify({ lane: "robinhood", agentId: `payto:0x${String(i).padStart(40, "0")}`, at: `2026-09-30T12:0${i}:00Z`, resource: `https://s${i}.test/x`, method: "GET", outcome: "sent" });
    writeFileSync(join(results, "robinhood-purchases.jsonl"), [sent(1), sent(2)].join("\n") + "\n");
    assert.match(ledgerBehindRecords([LANES.robinhood], results)!, /robinhood-ledger\.json does not exist/);
    const script = new URL("../scripts/evm-lane.ts", import.meta.url).pathname;
    const tsx = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
    // Without VET402_EVM_RESULTS_DIR the root is the key's: the records there say 2 sent, the ledger is missing: stop.
    const env = { ...process.env, VET402_EVM_PAY: "robinhood", EVM_KEY_DIR: keys } as Record<string, string | undefined>;
    delete env.VET402_EVM_RESULTS_DIR;
    const stop = spawnSync(tsx, [script, "--lane", "robinhood", "--pay"], { cwd: other, encoding: "utf8", env: env as NodeJS.ProcessEnv, timeout: 60_000 });
    assert.equal(stop.status, 5, stop.stderr);
    assert.ok(stop.stderr.includes(`ALERT ${join(results, "robinhood-purchases.jsonl")} has 2 purchase(s) sent, but ${join(results, "robinhood-ledger.json")} does not exist`), stop.stderr);
    assert.match(stop.stderr, /--pay stops before any purchase/);
    // A ledger with fewer purchases than were sent: stop too.
    writeFileSync(join(results, "robinhood-ledger.json"), JSON.stringify({ baselineAtomic: null, spentAtomic: "1000", purchases: [{ key: "robinhood-payto:0x1", amount: "1000", at: "x" }] }));
    const short = spawnSync(tsx, [script, "--lane", "robinhood", "--pay"], { cwd: other, encoding: "utf8", env: env as NodeJS.ProcessEnv, timeout: 60_000 });
    assert.equal(short.status, 5, short.stderr);
    assert.match(short.stderr, /holds 1 purchase\(s\), fewer than the 2 sent/);
    // A whole ledger: the run goes on with the production results directory (and stops at the empty key directory,
    // before any purchase: the purchase function is never reached in this test).
    writeFileSync(join(results, "robinhood-ledger.json"), JSON.stringify({ baselineAtomic: null, spentAtomic: "2000", purchases: [{ key: "a", amount: "1000", at: "x" }, { key: "b", amount: "1000", at: "x" }] }));
    const go = spawnSync(tsx, [script, "--lane", "robinhood", "--pay"], { cwd: other, encoding: "utf8", env: env as NodeJS.ProcessEnv, timeout: 60_000 });
    assert.ok(go.stderr.includes(`[pay] results and ledgers: ${results}`), go.stderr);
    assert.notEqual(go.status, 0);
    assert.match(go.stderr, /evm\.pub/, "it stopped at reading the payer's address: nothing was bought");
  } finally {
    rmSync(root, { recursive: true });
    rmSync(other, { recursive: true });
  }
  const src = readFileSync(new URL("../scripts/evm-lane.ts", import.meta.url), "utf8");
  assert.match(src, /new Budget\(pay \? laneLedgerPath\(lane, resultsDir\) : null/);
  assert.match(src, /appendFileSync\(join\(resultsDir, `\$\{lane\.id\}-purchases\.jsonl`\)/);
  assert.ok(src.indexOf("process.exit(5)") < src.indexOf("const payer: Address = readPublicAddress();"), "the ledger check comes before the key");
});
