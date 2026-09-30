import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getAddress, hexToString, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Budget } from "../src/guard.js";
import { EVM_CHAINS, LANES } from "../src/evm/chains.js";
import { buyOneOnChain, checkChainAccept, createChainPayment, fencedChainSigner, type ChainBuyDeps, type ChainBuyEntry, type ChainBuyRecord, type EvmAccept, type TypedDataSigner } from "../src/evm/evm-buy.js";
import { classifyRecord, predictFacilitator } from "../src/evm/settle-cause.js";
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
  assert.equal(classifyRecord(sent({ response: { status: 404, contentType: null, bytes: 0, first300: "" } })).cause, "seller_config");
  assert.equal(classifyRecord(sent({ response: { status: 402, contentType: null, bytes: 2, first300: "{}" } })).cause, "unknown");
  assert.equal(classifyRecord(sent({})).rule, "no_response");
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
  assert.equal(compareStockAnswer("ORCL", JSON.stringify({ ticker: "ORCL", price: share * 1.01 }), ref()).verdict, "close");
  assert.equal(compareStockAnswer("ORCL", JSON.stringify({ ticker: "ORCL", price: share * 1.05 }), ref()).verdict, "differs");
  assert.equal(compareStockAnswer("ORCL", JSON.stringify({ data: { symbol: "orcl", current_price: "138.7" } }), ref()).verdict, "agrees");
  assert.equal(compareStockAnswer("ORCL", JSON.stringify({ ticker: "AAPL", price: share }), ref()).verdict, "wrong_ticker");
  assert.equal(compareStockAnswer("ORCL", "not json", ref()).verdict, "no_price");
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
  assert.throws(() => dayRoot(RH, "2026-10-04", lines, "2026-10-04T23:59:59Z"), /not over/);
  const r = dayRoot(RH, "2026-10-04", lines, "2026-10-05T00:10:00Z");
  assert.equal(r.n, 2);
  assert.ok(verifyInclusion(recordDigest(JSON.parse(lines[2]!)), r.proofs[1]!, r.root));
  assert.equal(recordDigest({ b: 1, a: 2 }), recordDigest({ a: 2, b: 1 }), "canonical: key order does not matter");
  const tx = buildAnchorTx(r, PAYER);
  assert.equal(tx.to, PAYER);
  assert.deepEqual(parseAnchorText(hexToString(tx.data)), { chain: RH.caip2, day: "2026-10-04", root: r.root, n: 2 });
  assert.equal(hexToString(tx.data), anchorText(r));
  assert.throws(() => dayRoot(RH, "2026-10-03", lines, "2026-10-05T00:10:00Z"), /no sent purchase/);
});

test("anchor transaction: value 0, to itself with exactly the text, or record() on the named registry; anything else refused", () => {
  const r = dayRoot(ARB, "2026-10-04", [line("2026-10-04T01:00:00Z")], "2026-10-05T00:00:00Z");
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
    { payTo: SELLER, hosts: [`h${evil}`], catalogListings: 1, resource: `https://x/${evil}`, livePrice: "50000", status: "not_delivered", cause: { cause: "facilitator", rule: "r", evidence: "supported_page", fix: `fix ${evil}` }, settlementTx: `0x${evil}`, paidRequestMs: 1200, relayer: null, facilitatorLead: evil, skipped: null },
    { payTo: OTHER, hosts: ["ok.test"], catalogListings: 1, resource: null, livePrice: null, status: "not_offered_now", cause: null, settlementTx: null, paidRequestMs: null, relayer: null, facilitatorLead: null, skipped: evil },
  ],
  ...(lane === "arbitrum" ? { compare: { [`https://x/${evil}`]: { status: "delivered" as const, cause: null, settlementTx: TX, paidRequestMs: 900, relayer: null } } } : {}),
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
  assert.match(lane, /if \(pay && process\.env\.VET402_EVM_PAY !== laneArg\) throw/);
  assert.equal(lane.match(/loadEvmAccount\(\)/g)?.length, 1);
  assert.match(lane, /pay \? loadEvmAccount\(\) : privateKeyToAccount\(generatePrivateKey\(\)\)/);
  const anchor = readFileSync(new URL("../scripts/evm-anchor.ts", import.meta.url), "utf8");
  assert.match(anchor, /if \(send && process\.env\.VET402_ANCHOR_SEND !== laneId\) throw/);
  assert.ok(anchor.indexOf("loadEvmAccount()") > anchor.indexOf("if (!send)"), "the key is read after the no-send exit");
});
