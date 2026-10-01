/**
 * The EVM lanes decide "settled" from the chain, never from the seller's settlement header; a call the seller
 * said was free is not a failure; vet402's own wrong request is never counted against the seller.
 * Examples are the 2026-09-30 Arbitrum run (payer 0x9B59…4E51): payTo, price, response and the tx read on chain.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getAddress, type Hex } from "viem";
import { chainCheckRecords, mergeReadings, uncheckedPurchases, type EvmOutTx } from "../src/evm/chaincheck.js";
import { EVM_CHAINS } from "../src/evm/chains.js";
import type { ChainBuyRecord } from "../src/evm/evm-buy.js";
import { laneInputProblem, repairLaneRequest, sellerSaidFree } from "../src/evm/lane-input.js";
import { groupByPayTo } from "../src/evm/lane-plan.js";
import { classifyRecord } from "../src/evm/settle-cause.js";
import { buildLanePublic, isNegative, unpublishableRows, withholdUnnotified } from "../src/evm/site.js";
import { lookup } from "../packages/check/src/check.js";

const PAYER = getAddress("0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51");
const ARB = EVM_CHAINS.arbitrum;

// ---- 2026-09-30 Arbitrum records, as the lane wrote them (no settlement header, or one without a tx) ----
const resp = (status: number, body: string) => ({ status, contentType: "application/json", bytes: body.length, first300: body.slice(0, 300) });
const base = (o: Partial<ChainBuyRecord> & { resource: string; payTo: string; amountAtomic: string; at: string }): ChainBuyRecord & { lane: string } => ({
  lane: "arbitrum",
  agentId: `payto:${o.payTo}`,
  method: "GET",
  outcome: "sent",
  payer: PAYER,
  settledOnChain: false,
  settlementTx: null,
  settlementCheck: "no settlement tx in the response",
  delivered: false,
  ...o,
});
const BAZAAR_BODY = '{"generatedAt":"2026-09-30T12:45:12.574Z","receipt":{"snapshotHash":"0a265d6f8b85821a"}}';
const bazaar = base({ resource: "https://x402-bazaar-rank.x402-bazaar-rank-worker.workers.dev/count", payTo: "0xECa891e34b3E5873181Fb779672564E198C55354", amountAtomic: "1000", at: "2026-09-30T12:45:04.842Z", response: resp(200, BAZAAR_BODY), body: BAZAAR_BODY, settleResponse: null });
const QI_BODY = `{"statusCode":400,"code":"FST_ERR_CTP_EMPTY_JSON_BODY","error":"Bad Request","message":"Body cannot be empty when content-type is set to 'application/json'"}`;
const quickintel = base({ resource: "https://x402.quickintel.io/v1/scan/full", method: "POST", payTo: "0x3dBDfB6E5dCFa8f51AA07bC3aDf18a62b186C362", amountAtomic: "30000", at: "2026-09-30T12:39:25.649Z", response: resp(400, QI_BODY), body: QI_BODY, settleResponse: { success: true, network: "eip155:42161" } });
const AGENTBIT_BODY = '{"success":true,"data":{"operation":"csv_to_json","result":[{"name":"Ada","age":"36"}]},"meta":{"tool":"convert-csv-json","loyalty":{"calls30d":0,"currentDiscountPercent":0,"nextTier":{"minCalls30d":100,"percent":10,"callsRemaining":100}},"first_call_free":true,"note":"Welcome! This first call was free; your payment authorization was never settled and no funds moved."}}';
const agentbit = base({ resource: "https://agentbit.app/v1/convert/csv-json", method: "POST", payTo: "0x4395C7e383b7e05665aad7f36ed77c01923Dd965", amountAtomic: "1000", at: "2026-09-30T12:39:29.032Z", response: resp(200, AGENTBIT_BODY), body: AGENTBIT_BODY });
const PLEXA_BODY = '{"chain":"base","amountIn":"5000000000","confidence":"medium","freeTrialApplied":true}';
const plexa = base({ resource: "https://api.getplexa.com/v1/quote", method: "POST", payTo: "0xd993eAfBA87cFfa2ca2CFF5A56EF89034575A7ef", amountAtomic: "20000", at: "2026-09-30T12:44:24.724Z", response: resp(200, PLEXA_BODY), body: PLEXA_BODY });
const PHION_BODY = '{"charged":false,"execution":{"status":"completed"},"replayed":true,"status":"completed"}';
const phion = base({ resource: "https://phion.systems/v1/execute", method: "POST", payTo: "0x7BEcA68DD9aC733D4de6b16d16B85Dc391c071e2", amountAtomic: "1000", at: "2026-09-30T12:41:18.528Z", response: resp(200, PHION_BODY), body: PHION_BODY });
const social = base({ resource: "https://socialintel.dev/v1/user/:username", payTo: "0xB1Acd9E0269023546074400A434e703B646AaBBa", amountAtomic: "10000", at: "2026-09-30T12:43:13.903Z", response: resp(404, '{"detail":"Not Found"}'), body: '{"detail":"Not Found"}' });
const CARBON_BODY = '{"detail":[{"type":"int_parsing","loc":["path","netuid"],"msg":"Input should be a valid integer, unable to parse string as an integer","input":":netuid"}]}';
const carbon = base({ resource: "https://api.carbon-cashmere.de/v1/bittensor-derivatives/alpha-price-history/:netuid", payTo: "0xf8b2dD46542175AD46e14e6133340E652665F2Ee", amountAtomic: "20000", at: "2026-09-30T12:45:33.892Z", response: resp(422, CARBON_BODY), body: CARBON_BODY });
const OW_BODY = `{"status":"ERROR","error":{"message":"Missing query. The 'query' parameter is required.","code":400}}`;
const openweb = base({ resource: "https://x402.openwebninja.com/email-search/search-emails", payTo: "0x3e7c9cA818f713F19e126E3B7B37B47dC1411570", amountAtomic: "3000", at: "2026-09-30T12:39:27.741Z", response: resp(400, OW_BODY), body: OW_BODY });
const ASTER_BODY = '{"success":true,"data":{"symbol":"BITCOIN","price":84942}}';
const asterpay = base({ resource: "https://x402.asterpay.io/v1/market/price/bitcoin", payTo: "0xd5f8481D8F25d3966d2010DBf9B47fFbdf745A9E", amountAtomic: "5000", at: "2026-09-30T12:43:58.215Z", response: resp(200, ASTER_BODY), body: ASTER_BODY, settleResponse: { success: true, payer: PAYER } });
const DELIVERED_TX = ("0x" + "11".repeat(32)) as Hex;
const delivered = base({ resource: "https://api.nativebtc.org/v1/mempool/stream-ticket", payTo: "0x0300E73759B357ceeE5A248d1801eCb8abf7A1d4", amountAtomic: "5000", at: "2026-09-30T12:38:38.160Z", response: resp(200, '{"success":true}'), body: '{"success":true}', settledOnChain: true, delivered: true, settlementTx: DELIVERED_TX, settlementCheck: "transfer" });

/** The USDC Transfer logs out of the payer read on Arbitrum One (the two the records did not have, and one they did). */
const chainTxs: EvmOutTx[] = [
  { tx: DELIVERED_TX, timeMs: Date.parse("2026-09-30T12:38:40Z"), transfers: [{ to: delivered.payTo!, amount: 5000n }], nonces: [] },
  { tx: "0x78140ce1d6e741094075ddcf27cdb2d617852ff40727ea85a23cdd3a1301b6f4", timeMs: Date.parse("2026-09-30T12:39:27Z"), transfers: [{ to: quickintel.payTo!, amount: 30000n }], nonces: [] },
  { tx: "0x8e885499269fdcae6501f6a35ff5611526df218548daa88d82e91deccee147d3", timeMs: Date.parse("2026-09-30T12:45:07Z"), transfers: [{ to: bazaar.payTo!, amount: 1000n }], nonces: [] },
];
const records = [delivered, quickintel, openweb, agentbit, phion, social, asterpay, plexa, bazaar, carbon];
const checked = chainCheckRecords(records, chainTxs, { payer: PAYER, checkedAt: "2026-10-01T12:00:00Z", readToMs: Date.parse("2026-10-01T12:00:00Z") });
const byHost = (h: string) => checked.records.find((r) => r.resource.includes(h))!;

test("chain: bazaar-rank (no PAYMENT-RESPONSE) and quickintel (success without a tx) settled; the transfer on chain decides", () => {
  const b = byHost("bazaar-rank");
  assert.equal(b.settledOnChain, true);
  assert.equal(b.settlementTx, "0x8e885499269fdcae6501f6a35ff5611526df218548daa88d82e91deccee147d3");
  assert.equal(b.chainCheck?.result, "transfer_found");
  assert.equal(b.delivered, true, "200 with a body and settled on chain: delivered");
  assert.equal(classifyRecord(b).cause, "delivered");
  const q = byHost("quickintel");
  assert.equal(q.settledOnChain, true);
  assert.equal(q.settlementTx, "0x78140ce1d6e741094075ddcf27cdb2d617852ff40727ea85a23cdd3a1301b6f4");
  assert.equal(q.delivered, false);
  assert.deepEqual(checked.summary.unmatched, [], "every transfer out of the payer has its purchase");
  assert.equal(checked.summary.added.length, 2);
  // Nothing on chain for the others: no_transfer, read from the chain, not from the missing header.
  for (const h of ["agentbit", "phion", "socialintel", "asterpay", "getplexa", "carbon-cashmere", "openwebninja"]) {
    assert.equal(byHost(h).chainCheck?.result, "no_transfer", h);
    assert.equal(byHost(h).settledOnChain, false, h);
  }
  // A transfer that two purchases could own is not given to either.
  const twin = { ...bazaar, at: "2026-09-30T12:45:05.000Z", agentId: "payto:twin" };
  const amb = chainCheckRecords([bazaar, twin], chainTxs.slice(2), { payer: PAYER, checkedAt: "x" });
  assert.equal(amb.records.filter((r) => r.settledOnChain).length, 0);
  assert.equal(amb.summary.ambiguous.length, 2);
  // A window still open when the chain was read is pending, and publish refuses it.
  const open = chainCheckRecords([agentbit], [], { payer: PAYER, checkedAt: "x", readToMs: Date.parse(agentbit.at) + 60_000 });
  assert.equal(open.records[0]!.chainCheck?.result, "pending");
  assert.equal(uncheckedPurchases(open.records).length, 1);
  assert.equal(uncheckedPurchases(checked.records).length, 0);
});

test("chain: a purchase with its EIP-3009 nonce is matched by AuthorizationUsed, even with another purchase to the same payTo and price", () => {
  const n1 = ("0x" + "a1".repeat(32)) as Hex;
  const n2 = ("0x" + "b2".repeat(32)) as Hex;
  const mk = (ticker: string, nonce: Hex, at: string) => ({ ...bazaar, agentId: `stock:${ticker}`, at, authorization: { nonce, validAfter: "0", validBefore: String(Math.floor(Date.parse(at) / 1000) + 300) } });
  const a = mk("AAPL", n1, "2026-10-04T15:00:00Z");
  const b = mk("TSLA", n2, "2026-10-04T15:01:00Z");
  const tx2 = ("0x" + "22".repeat(32)) as Hex;
  const r = chainCheckRecords([a, b], [{ tx: tx2, timeMs: Date.parse("2026-10-04T15:01:02Z"), transfers: [{ to: bazaar.payTo!, amount: 1000n }], nonces: [n2] }], { payer: PAYER, checkedAt: "x" });
  assert.equal(r.records[0]!.settledOnChain, false, "AAPL's nonce was never used");
  assert.equal(r.records[0]!.chainCheck?.result, "no_transfer");
  assert.equal(r.records[1]!.settlementTx, tx2);
  assert.equal(r.records[1]!.chainCheck?.by, "nonce");
});

test("free: agentbit (first_call_free), getplexa (freeTrialApplied), phion (charged:false) came back free, never a failure", () => {
  assert.equal(sellerSaidFree(AGENTBIT_BODY), "first_call_free=true");
  assert.equal(sellerSaidFree(PLEXA_BODY), "freeTrialApplied=true");
  assert.equal(sellerSaidFree(PHION_BODY), "charged=false");
  assert.equal(sellerSaidFree(ASTER_BODY), null);
  for (const h of ["agentbit", "getplexa", "phion"]) {
    const c = classifyRecord(byHost(h));
    assert.equal(c.cause, "seller_free", h);
    assert.equal(isNegative("free_delivered", c), false);
  }
  // The seller's word alone is not enough: without the chain check (or with a transfer) it is not "free".
  assert.notEqual(classifyRecord(agentbit).cause, "seller_free");
  // asterpay said success but nothing moved and it did not say free: undecided, not counted against it, withheld.
  assert.equal(classifyRecord(byHost("asterpay")).cause, "not_settled");
});

test("vet402's request: socialintel (:username), carbon-cashmere (:netuid), openwebninja (no query), quickintel (empty body) are vet402's, settled or not", () => {
  assert.equal(laneInputProblem(byHost("socialintel"))?.kind, "path_placeholder");
  assert.equal(laneInputProblem(byHost("carbon-cashmere"))?.kind, "path_placeholder");
  assert.equal(laneInputProblem(byHost("openwebninja"))?.kind, "missing_input");
  assert.equal(laneInputProblem(byHost("quickintel"))?.kind, "missing_input");
  assert.equal(classifyRecord(byHost("quickintel")).rule, "input:missing_input:settled");
  assert.equal(classifyRecord(byHost("socialintel")).rule, "input:path_placeholder");
  // Not input: a 404 with no slot, a 400 about payment or a key, a 500.
  assert.equal(laneInputProblem({ resource: "https://s.test/a", response: resp(404, "{}"), body: "{}" }), null);
  assert.equal(laneInputProblem({ resource: "https://s.test/a", response: resp(400, '{"error":"API key is required"}'), body: '{"error":"API key is required"}' }), null);
  assert.equal(laneInputProblem({ resource: "https://s.test/a", response: resp(500, '{"error":"missing"}'), body: '{"error":"missing"}' }), null);
  // A settled purchase that answered 500 is still the seller's.
  assert.equal(classifyRecord({ ...bazaar, settledOnChain: true, response: resp(500, "err") }).cause, "seller_config");
});

test("next purchase: the slot and the inputs are filled from the listing; an input vet402 cannot fill after a 400/404/422 is not bought again", () => {
  const social = { resource: "https://socialintel.dev/v1/user/:username", extensions: { bazaar: { info: { input: { method: "GET", pathParams: { username: "test" }, queryParams: { username: "yoga_with_adriene" }, type: "http" } } } } };
  const r1 = repairLaneRequest(social, { resource: social.resource, method: "GET", query: { username: "yoga_with_adriene" }, body: null }, "2026-10-01", 404);
  assert.ok(r1.ok && r1.request.resource === "https://socialintel.dev/v1/user/yoga_with_adriene");
  const carbon = { resource: "https://api.carbon-cashmere.de/v1/bittensor-derivatives/alpha-price-history/:netuid", extensions: { bazaar: { info: { input: { method: "GET", pathParams: { netuid: "1" }, type: "http" } } } } };
  const r2 = repairLaneRequest(carbon, { resource: carbon.resource, method: "GET", query: null, body: null }, "2026-10-01", 422);
  assert.ok(r2.ok && r2.request.resource.endsWith("/alpha-price-history/1"));
  const noValue = repairLaneRequest({ resource: "https://x.test/u/:id" }, { resource: "https://x.test/u/:id", method: "GET", query: null, body: null }, "2026-10-01");
  assert.deepEqual(noValue, { ok: false, reason: "path_placeholder", param: "id" });
  // quickintel's Dexter listing declares the body (chain, tokenAddress): sent instead of {}.
  const qi = { resource: "https://x402.quickintel.io/v1/scan/full", accepts: [{ outputSchema: { input: { method: "POST", body: { chain: "base", tokenAddress: "0xa4a2e2ca3fbfe21aed83471d28b6f65a233c6e00" } } } }] };
  const r3 = repairLaneRequest(qi as never, { resource: qi.resource, method: "POST", query: null, body: {} }, "2026-10-01", 400);
  assert.ok(r3.ok);
  assert.deepEqual(r3.ok && r3.request.body, { chain: "base", tokenAddress: "0xa4a2e2ca3fbfe21aed83471d28b6f65a233c6e00" });
  // openwebninja: email_domain is required and nothing names a value: not bought again after the 400.
  const ow = { resource: "https://x402.openwebninja.com/email-search/search-emails", inputSchema: { properties: { email_domain: { type: "string" }, query: { type: "string" } }, required: ["email_domain", "query"] }, extensions: { bazaar: { info: { input: { method: "GET", queryParams: { type: "object", properties: { email_domain: { type: "string" }, query: { type: "string" } }, required: ["email_domain", "query"] } } } } } };
  const r4 = repairLaneRequest(ow, { resource: ow.resource, method: "GET", query: null, body: null }, "2026-10-01", 400);
  assert.equal(r4.ok, false);
  // Plan: the listing goes to the group's input skips, and the row says so in neutral words.
  const accept = { scheme: "exact", network: ARB.caip2, amount: "3000", asset: ARB.asset, payTo: openweb.payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
  const g = groupByPayTo([{ ...ow, accepts: [accept] }], ARB, { maxPerAtomic: 100_000n, today: "2026-10-01", lastStatus: new Map([[ow.resource, 400]]) });
  assert.equal(g[0]!.options.length, 0);
  assert.match(g[0]!.inputSkipped![0]!.why, /^input_unfillable: /);
});

test("site, /v1/check and escrow: the new reading reaches every page, and nothing negative is published for an untold seller", () => {
  const choice = (r: ChainBuyRecord) => ({ payTo: r.payTo!, catalogListings: 1, hosts: [new URL(r.resource).hostname], chosen: { resource: r.resource, liveAmount: r.amountAtomic! } });
  const dry = { generatedAt: "2026-09-30T06:20:02Z", catalogs: {}, arbitrum: { payTosInCatalogs: records.length, payTosWithLive402: records.length, choices: records.map(choice) } };
  const paid = checked.records.map((r) => ({ ...r, lane: "arbitrum", cause: classifyRecord(r) }));
  const l = withholdUnnotified(buildLanePublic("arbitrum", dry, paid), new Set());
  const st = (h: string) => l.rows.find((r) => (r.resource ?? "").includes(h))!.status;
  assert.equal(st("bazaar-rank"), "delivered");
  assert.equal(st("quickintel"), "settled_vet402_input");
  assert.equal(st("agentbit"), "free_delivered");
  assert.equal(st("getplexa"), "free_delivered");
  assert.equal(st("phion"), "free_delivered");
  assert.equal(st("socialintel"), "vet402_input");
  assert.equal(st("carbon-cashmere"), "vet402_input");
  assert.equal(st("openwebninja"), "vet402_input");
  assert.equal(st("asterpay"), "withheld", "undecided and untold: the result is not published");
  const held = l.rows.find((r) => (r.resource ?? "").includes("asterpay"))!;
  assert.equal(held.chainCheck, undefined, "a withheld row does not carry the chain reading");
  assert.equal(held.paymentResponseHeader, undefined);
  assert.deepEqual(unpublishableRows(l, new Set()), []);
  const row = l.rows.find((r) => (r.resource ?? "").includes("bazaar-rank"))!;
  assert.equal(row.chainCheck, "transfer_found");
  // /v1/check for quickintel: settled, never a seller-side failure; agentbit's free call is not a try against it.
  const rank = JSON.parse(readFileSync(new URL("../site/rank.json", import.meta.url), "utf8")) as unknown;
  const index = JSON.parse(readFileSync(new URL("../data/records/index.json", import.meta.url), "utf8")) as unknown;
  const chk = (u: string) => lookup(rank, index, { url: u, chain: "arbitrum" }, [], [l]).sellers.find((f) => f.page === "arbitrum")!;
  const qf = chk("https://x402.quickintel.io/v1/scan/full");
  assert.equal(qf.settled, 1);
  assert.deepEqual(qf.sellerSideFailures, {});
  assert.equal(qf.notCountedAgainstSeller.vet402OrFacilitator, 1);
  const af = chk("https://agentbit.app/v1/convert/csv-json");
  assert.equal(af.tried, 0);
  assert.equal(af.notCountedAgainstSeller.byRule.seller_said_free, 1);
  // Escrow counts withheld purchases only: here one (asterpay).
  assert.equal(l.rows.filter((r) => r.status === "withheld").length, 1);
});

test("publish: one reading per purchase (the later wins), and a sent purchase the chain has not decided stops the publish", () => {
  const later = { ...bazaar, settledOnChain: true };
  const m = mergeReadings([bazaar, quickintel, later]);
  assert.equal(m.length, 2);
  assert.equal(m[0]!.settledOnChain, true);
  const src = readFileSync(new URL("../scripts/evm-publish.ts", import.meta.url), "utf8");
  assert.match(src, /-chaincheck\.jsonl/);
  assert.match(src, /uncheckedPurchases\(raw\)/);
  const lane = readFileSync(new URL("../scripts/evm-lane.ts", import.meta.url), "utf8");
  assert.match(lane, /checkLaneFiles\(r\.lane, payer\)/, "every paying run ends with the chain check");
});

test("records keep the raw settlement header (which one, decoded, named a tx) and the EIP-3009 nonce, never the signature", () => {
  const src = readFileSync(new URL("../src/evm/evm-buy.ts", import.meta.url), "utf8");
  assert.match(src, /paid\.headers\.get\("payment-response"\)/);
  assert.match(src, /paid\.headers\.get\("x-payment-response"\)/);
  assert.match(src, /rec\.authorization = \{ nonce: created\.authorization\.nonce, validAfter/);
  assert.doesNotMatch(src, /rec\.(authorization|paymentResponseHeader)[^\n]*signature/);
});
