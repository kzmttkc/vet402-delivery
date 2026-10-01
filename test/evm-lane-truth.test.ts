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
import { holdAfter4xx, laneInputProblem, lastPaidByListing, repairLaneRequest, sellerSaidFree, SELLER_4XX_RETRY_MS } from "../src/evm/lane-input.js";
import { laneRequestKey } from "../src/evm/evm-buy.js";
import { groupByPayTo } from "../src/evm/lane-plan.js";
import { classifyRecord } from "../src/evm/settle-cause.js";
import { buildLanePublic, isNegative, unpublishableRows, withholdUnnotified } from "../src/evm/site.js";
import { lookup } from "../packages/check/src/check.js";

/**
 * The earlier seven vet402-side answers, as the rule of review a70363c reads them: six stay vet402's. "Missing url"
 * is the seller's: url is not one of the allowed names (ALLOWED_NAMES), so it is asserted on its own below.
 */
const EARLIER_SEVEN_KEPT = ["Missing input", "Missing required fields: wallet, chain", "missing arguments", "missing value for symbol", "missing queries", 'Missing "address"'];
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

test("vet402's request: socialintel (:username), carbon-cashmere (:netuid), openwebninja (no query) are vet402's; quickintel's 'Body cannot be empty' names nothing vet402 sends, so it is the seller's", () => {
  assert.equal(laneInputProblem(byHost("socialintel"))?.kind, "path_placeholder");
  assert.equal(laneInputProblem(byHost("carbon-cashmere"))?.kind, "path_placeholder");
  assert.equal(laneInputProblem(byHost("openwebninja"))?.kind, "missing_input");
  assert.equal(laneInputProblem(byHost("quickintel")), null, "Body is not an allowed name");
  assert.equal(classifyRecord(byHost("quickintel")).cause, "seller_config");
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
  const r1 = repairLaneRequest(social, { resource: social.resource, method: "GET", query: { username: "yoga_with_adriene" }, body: null }, "2026-10-01", { status: 404, requestKey: null, at: null, inputError: true, declaredCount: 1 });
  assert.ok(r1.ok && r1.request.resource === "https://socialintel.dev/v1/user/yoga_with_adriene");
  const carbon = { resource: "https://api.carbon-cashmere.de/v1/bittensor-derivatives/alpha-price-history/:netuid", extensions: { bazaar: { info: { input: { method: "GET", pathParams: { netuid: "1" }, type: "http" } } } } };
  const r2 = repairLaneRequest(carbon, { resource: carbon.resource, method: "GET", query: null, body: null }, "2026-10-01", { status: 422, requestKey: null, at: null, inputError: true, declaredCount: 1 });
  assert.ok(r2.ok && r2.request.resource.endsWith("/alpha-price-history/1"));
  const noValue = repairLaneRequest({ resource: "https://x.test/u/:id" }, { resource: "https://x.test/u/:id", method: "GET", query: null, body: null }, "2026-10-01");
  assert.deepEqual(noValue, { ok: false, reason: "path_placeholder", param: "id" });
  // quickintel's Dexter listing declares the body (chain, tokenAddress): sent instead of {}.
  const qi = { resource: "https://x402.quickintel.io/v1/scan/full", accepts: [{ outputSchema: { input: { method: "POST", body: { chain: "base", tokenAddress: "0xa4a2e2ca3fbfe21aed83471d28b6f65a233c6e00" } } } }] };
  const r3 = repairLaneRequest(qi as never, { resource: qi.resource, method: "POST", query: null, body: {} }, "2026-10-01", { status: 400, requestKey: null, at: null, inputError: true, declaredCount: 1 });
  assert.ok(r3.ok);
  assert.deepEqual(r3.ok && r3.request.body, { chain: "base", tokenAddress: "0xa4a2e2ca3fbfe21aed83471d28b6f65a233c6e00" });
  // openwebninja: email_domain is required and nothing names a value: not bought again after the 400.
  const ow = { resource: "https://x402.openwebninja.com/email-search/search-emails", inputSchema: { properties: { email_domain: { type: "string" }, query: { type: "string" } }, required: ["email_domain", "query"] }, extensions: { bazaar: { info: { input: { method: "GET", queryParams: { type: "object", properties: { email_domain: { type: "string" }, query: { type: "string" } }, required: ["email_domain", "query"] } } } } } };
  const r4 = repairLaneRequest(ow, { resource: ow.resource, method: "GET", query: null, body: null }, "2026-10-01", { status: 400, requestKey: null, at: null, inputError: true, declaredCount: 1 });
  assert.equal(r4.ok, false);
  // Plan: the listing goes to the group's input skips, and the row says so in neutral words.
  const accept = { scheme: "exact", network: ARB.caip2, amount: "3000", asset: ARB.asset, payTo: openweb.payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
  const g = groupByPayTo([{ ...ow, accepts: [accept] }], ARB, { maxPerAtomic: 100_000n, today: "2026-10-01", lastPaid: new Map([[ow.resource, { status: 400, requestKey: null, at: null, inputError: true, declaredCount: 1 }]]) });
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
  assert.equal(st("quickintel"), "withheld", "settled, then the seller's 400 that names nothing vet402 sends: untold, not published");
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
  // /v1/check for a settled purchase whose answer named an allowed name vet402 did not send: settled, never a
  // seller-side failure; agentbit's free call is not a try against it.
  const qiBody = '{"message":"\\"address\\" is required"}';
  const qiInput = { ...checked.records.find((x) => x.resource.includes("quickintel"))!, response: resp(400, qiBody), body: qiBody };
  const paid2 = paid.map((x) => (x.resource.includes("quickintel") ? { ...qiInput, lane: "arbitrum", cause: classifyRecord(qiInput) } : x));
  const l2 = withholdUnnotified(buildLanePublic("arbitrum", dry, paid2), new Set());
  assert.equal(l2.rows.find((x) => (x.resource ?? "").includes("quickintel"))!.status, "settled_vet402_input");
  const rank = JSON.parse(readFileSync(new URL("../site/rank.json", import.meta.url), "utf8")) as unknown;
  const index = JSON.parse(readFileSync(new URL("../data/records/index.json", import.meta.url), "utf8")) as unknown;
  const chk = (u: string) => lookup(rank, index, { url: u, chain: "arbitrum" }, [], [l2]).sellers.find((f) => f.page === "arbitrum")!;
  const qf = chk("https://x402.quickintel.io/v1/scan/full");
  assert.equal(qf.settled, 1);
  assert.deepEqual(qf.sellerSideFailures, {});
  assert.equal(qf.notCountedAgainstSeller.vet402OrFacilitator, 1);
  const af = chk("https://agentbit.app/v1/convert/csv-json");
  assert.equal(af.tried, 0);
  assert.equal(af.notCountedAgainstSeller.byRule.seller_said_free, 1);
  // Escrow counts withheld purchases only: here two (asterpay, quickintel).
  assert.equal(l.rows.filter((r) => r.status === "withheld").length, 2);
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

test("follow-up 1: a filled request that still got 400/404/422 is not bought again; the lookup is by the catalog URL", () => {
  const social = { resource: "https://socialintel.dev/v1/user/:username", extensions: { bazaar: { info: { input: { method: "GET", queryParams: { username: "yoga_with_adriene" }, type: "http" } } } } };
  const req = { resource: social.resource, method: "GET" as const, query: { username: "yoga_with_adriene" }, body: null };
  const first = repairLaneRequest(social, req, "2026-10-01", { status: 404, requestKey: null, at: null, inputError: true, declaredCount: 1 });
  assert.ok(first.ok && first.changed, "the old record sent the catalog's request: the filled one is new, so it is bought once");
  const sent = first.ok ? first.requestKey : "";
  // That filled request answered 404 too: the next run fills it the same way and does not buy it.
  assert.deepEqual(repairLaneRequest(social, req, "2026-10-01", { status: 404, requestKey: sent, at: null, inputError: true, declaredCount: 1 }), { ok: false, reason: "input_unchanged_after_input_error", param: null });
  // A 200 last time, or a different request now: bought.
  assert.equal(repairLaneRequest(social, req, "2026-10-01", { status: 200, requestKey: sent, at: null, inputError: false }).ok, true);
  assert.equal(repairLaneRequest(social, req, "2026-10-01", { status: 404, requestKey: "f".repeat(64), at: null, inputError: true, declaredCount: 1 }).ok, true);
  // The plan looks the listing up by its catalog URL and carries it to the entry and the record.
  const accept = { scheme: "exact", network: ARB.caip2, amount: "10000", asset: ARB.asset, payTo: social.resource && "0xB1Acd9E0269023546074400A434e703B646AaBBa", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
  const listing = { ...social, accepts: [accept] };
  const g1 = groupByPayTo([listing], ARB, { maxPerAtomic: 100_000n, today: "2026-10-01", lastPaid: new Map([[social.resource, { status: 404, requestKey: null, at: null, inputError: true, declaredCount: 1 }]]) });
  assert.equal(g1[0]!.options[0]!.listingResource, social.resource);
  assert.equal(g1[0]!.options[0]!.resource, "https://socialintel.dev/v1/user/yoga_with_adriene");
  const g2 = groupByPayTo([listing], ARB, { maxPerAtomic: 100_000n, today: "2026-10-01", lastPaid: new Map([[social.resource, { status: 404, requestKey: sent, at: null, inputError: true, declaredCount: 1 }]]) });
  assert.equal(g2[0]!.options.length, 0);
  assert.match(g2[0]!.inputSkipped![0]!.why, /input_unchanged_after_input_error/);
  const lane = readFileSync(new URL("../scripts/evm-lane.ts", import.meta.url), "utf8");
  assert.match(lane, /return lastPaidByListing\(rows\)/);
  const input = readFileSync(new URL("../src/evm/lane-input.ts", import.meta.url), "utf8");
  assert.match(input, /const k = r\.listingResource \?\? r\.resource;/);
  const buy = readFileSync(new URL("../src/evm/evm-buy.ts", import.meta.url), "utf8");
  assert.match(buy, /listingResource: e\.listingResource \?\? e\.resource,\s+requestKey: laneRequestKey\(e, e\.inputDate/);
});

test("follow-up 2: a bare 'missing' is vet402's input only next to query/body/param/field or a parameter the listing declares", () => {
  const r = (status: number, body: string, declaredParams?: string[]) => ({ resource: "https://s.test/a", response: resp(status, body), body, ...(declaredParams ? { declaredParams } : {}) });
  assert.equal(laneInputProblem(r(400, '{"error":"upstream data missing for this symbol"}')), null);
  assert.equal(laneInputProblem(r(400, '{"error":"resource missing"}')), null);
  assert.equal(laneInputProblem(r(400, '{"error":"missing query parameter"}'))?.kind, "missing_input");
  assert.equal(laneInputProblem(r(400, '{"error":"missing field"}')), null, "field is not an allowed name");
  assert.equal(laneInputProblem(r(400, '{"error":"missing: email_domain"}')), null, "an undeclared name is not enough");
  assert.equal(laneInputProblem(r(400, '{"error":"missing: email_domain"}', ["email_domain", "query"]))?.kind, "missing_input");
  assert.equal(laneInputProblem(r(400, '{"error":"missing API key query"}')), null, "authentication is never vet402's input");
  // The 2026-09-30 answers: openwebninja names query (allowed); quickintel names Body (not allowed).
  assert.equal(laneInputProblem(byHost("openwebninja"))?.kind, "missing_input");
  assert.equal(laneInputProblem(byHost("quickintel")), null);
});

test("follow-up 3: a tx already held by an earlier record is not given to a later one; the later one is ambiguous, not settled", () => {
  const a = { ...bazaar, settledOnChain: true, settlementTx: chainTxs[2]!.tx, delivered: true };
  const b = { ...bazaar, agentId: "payto:other", at: "2026-09-30T12:46:00Z", settledOnChain: true, settlementTx: chainTxs[2]!.tx, delivered: true };
  const r = chainCheckRecords([a, b], chainTxs.slice(2), { payer: PAYER, checkedAt: "x" });
  assert.equal(r.records[0]!.chainCheck?.result, "transfer_found");
  assert.equal(r.records[0]!.settledOnChain, true);
  assert.equal(r.records[1]!.chainCheck?.result, "ambiguous");
  assert.equal(r.records[1]!.settledOnChain, false);
  assert.equal(r.summary.ambiguous.length, 1);
  assert.equal(classifyRecord(r.records[1]!).cause, "unconfirmed", "never the seller's");
});

test("review of a44d5aa [high]: the seller's 'missing ...' answers to vet402's request are vet402's, settled or not", () => {
  const msgs = EARLIER_SEVEN_KEPT;
  for (const m of msgs) {
    const body = JSON.stringify({ error: m });
    const rec = { ...bazaar, settledOnChain: true, response: resp(400, body), body };
    assert.equal(laneInputProblem(rec)?.kind, "missing_input", m);
    const c = classifyRecord(rec);
    assert.equal(c.cause, "vet402", m);
    assert.equal(c.rule, "input:missing_input:settled", m);
    assert.equal(isNegative("settled_vet402_input", c), false, m);
    // The same words outside JSON as well.
    assert.equal(laneInputProblem({ resource: "https://s.test/a", response: resp(422, m), body: m })?.kind, "missing_input", `${m} (plain text)`);
  }
  for (const m of ["upstream data missing", "resource missing"]) {
    const body = JSON.stringify({ error: m });
    const rec = { ...bazaar, settledOnChain: true, response: resp(400, body), body };
    assert.equal(laneInputProblem(rec), null, m);
    assert.equal(classifyRecord(rec).cause, "seller_config", `${m}: settled, then a 400 that is not about the request`);
  }
});

test("review of a44d5aa [mid]: a request filled with today's date has the same fingerprint every day", () => {
  const listing = { resource: "https://d.test/rates", extensions: { bazaar: { info: { input: { method: "GET", queryParams: { type: "object", properties: { date: { type: "string" } }, required: ["date"] } } } } } };
  const req = { resource: listing.resource, method: "GET" as const, query: null, body: null };
  const day1 = repairLaneRequest(listing, req, "2026-10-01");
  const day2 = repairLaneRequest(listing, req, "2026-10-02");
  assert.ok(day1.ok && day2.ok);
  assert.equal(day1.ok && day1.request.query?.date, "2026-10-01");
  assert.deepEqual(day1.ok && day1.datedParams, ["date"]);
  assert.equal(day1.ok && day1.requestKey, day2.ok && day2.requestKey);
  // Yesterday's 400 that was vet402's request stops today's identical (date-filled) request.
  const sent = day1.ok ? day1.requestKey : "";
  const again = repairLaneRequest(listing, req, "2026-10-02", { status: 400, requestKey: sent, at: "2026-10-01T10:00:00Z", inputError: true, declaredCount: 1 }, Date.parse("2026-10-02T10:00:00Z"));
  assert.deepEqual(again, { ok: false, reason: "input_unchanged_after_input_error", param: null });
  // A different concrete date is a different request.
  assert.notEqual(laneRequestKey({ ...req, query: { date: "2026-09-01" } }, { date: "2026-10-01", params: ["date"] }), sent);
  // The buy side computes the same key from the entry (inputDate + datedParams) as the plan did.
  assert.equal(laneRequestKey(day1.ok ? day1.request : req, { date: "2026-10-01", params: ["date"] }), sent);
  const buy = readFileSync(new URL("../src/evm/evm-buy.ts", import.meta.url), "utf8");
  assert.match(buy, /requestKey: laneRequestKey\(e, e\.inputDate \? \{ date: e\.inputDate, params: e\.datedParams \?\? \[\] \} : null\)/);
});

test("review of a44d5aa [mid]: vet402's own wrong request stops for good; a seller-side 4xx is bought again every 7 days", () => {
  const at = "2026-10-01T00:00:00Z";
  const t0 = Date.parse(at);
  assert.equal(holdAfter4xx({ status: 400, requestKey: null, at, inputError: true, declaredCount: 1 }, t0 + 30 * 86_400_000), "input_unchanged_after_input_error");
  assert.equal(holdAfter4xx({ status: 404, requestKey: null, at, inputError: false }, t0 + SELLER_4XX_RETRY_MS - 1), "unchanged_after_seller_4xx_within_7_days");
  assert.equal(holdAfter4xx({ status: 404, requestKey: null, at, inputError: false }, t0 + SELLER_4XX_RETRY_MS), null);
  assert.equal(holdAfter4xx({ status: 500, requestKey: null, at, inputError: false }, t0), null);
  const listing = { resource: "https://s.test/item", extensions: { bazaar: { info: { input: { method: "GET", type: "http" } } } } };
  const req = { resource: listing.resource, method: "GET" as const, query: null, body: null };
  const key = laneRequestKey(req);
  const seller404 = { status: 404, requestKey: key, at, inputError: false };
  assert.equal(repairLaneRequest(listing, req, "2026-10-03", seller404, t0 + 2 * 86_400_000).ok, false);
  assert.equal(repairLaneRequest(listing, req, "2026-10-08", seller404, t0 + 7 * 86_400_000).ok, true, "7 days after the last answer");
  // That retry is the new last answer: held for the next 7 days, then bought again (every 7 days).
  const retried = { ...seller404, at: "2026-10-08T00:00:00Z" };
  assert.equal(repairLaneRequest(listing, req, "2026-10-09", retried, t0 + 8 * 86_400_000).ok, false);
  assert.equal(repairLaneRequest(listing, req, "2026-10-15", retried, t0 + 14 * 86_400_000).ok, true);
  // The lane script decides inputError from the record with the same reading as the pages.
  const lane = readFileSync(new URL("../scripts/evm-lane.ts", import.meta.url), "utf8");
  assert.match(lane, /return lastPaidByListing\(rows\)/);
});

test("review of a44d5aa [low]: a named tx carrying nonces goes only to the record whose nonce it carries; none matching makes all ambiguous", () => {
  const tx = chainTxs[2]!.tx;
  const nA = ("0x" + "a1".repeat(32)) as Hex;
  const nB = ("0x" + "b2".repeat(32)) as Hex;
  const withNonce = (n: Hex, at: string, id: string) => ({ ...bazaar, agentId: id, at, settledOnChain: true, settlementTx: tx, delivered: true, authorization: { nonce: n, validAfter: "0", validBefore: String(Math.floor(Date.parse(at) / 1000) + 300) } });
  const a = withNonce(nA, "2026-09-30T12:45:04Z", "a");
  const b = withNonce(nB, "2026-09-30T12:45:05Z", "b");
  const t = { ...chainTxs[2]!, nonces: [nB] };
  const r = chainCheckRecords([a, b], [t], { payer: PAYER, checkedAt: "x" });
  assert.equal(r.records[0]!.chainCheck?.result, "ambiguous", "the earlier record does not get a tx that carries another nonce");
  assert.equal(r.records[0]!.settledOnChain, false);
  assert.equal(r.records[1]!.chainCheck?.result, "transfer_found");
  assert.equal(r.records[1]!.settlementTx, tx);
  const none = chainCheckRecords([a, b], [{ ...t, nonces: [("0x" + "cc".repeat(32)) as Hex] }], { payer: PAYER, checkedAt: "x" });
  assert.deepEqual(none.records.map((x) => x.chainCheck?.result), ["ambiguous", "ambiguous"]);
  // The tx is not set aside (review of 7a967b8): no record's nonce owns it, so it is reported for a human.
  assert.deepEqual(none.summary.unmatched.map((u) => u.tx), [tx]);
  assert.deepEqual(none.summary.ambiguous.length, 2);
});

// ---------- review of 7a967b8 ----------

const PT = getAddress("0xECa891e34b3E5873181Fb779672564E198C55354");
const TT = ("0x" + "77".repeat(32)) as Hex;
const UU = ("0x" + "88".repeat(32)) as Hex;
const NA = ("0x" + "a1".repeat(32)) as Hex;
const NB = ("0x" + "b2".repeat(32)) as Hex;
const OK_BODY = '{"ok":true}';
const buyRec = (id: string, at: string, nonce: Hex, named: Hex | null, settled: boolean) => ({
  ...base({ resource: "https://s.test/x", payTo: PT, amountAtomic: "1000", at, response: resp(200, OK_BODY), body: OK_BODY }),
  agentId: id,
  settledOnChain: settled,
  delivered: settled,
  settlementTx: named,
  settlementCheck: settled ? "transfer" : "no settlement tx in the response",
  authorization: { nonce, validAfter: "0", validBefore: String(Math.floor(Date.parse(at) / 1000) + 600) },
});
const txT: EvmOutTx = { tx: TT, timeMs: Date.parse("2026-10-04T15:00:20Z"), transfers: [{ to: PT, amount: 1000n }], nonces: [NB] };
const txU: EvmOutTx = { tx: UU, timeMs: Date.parse("2026-10-04T15:00:10Z"), transfers: [{ to: PT, amount: 1000n }], nonces: [NA] };

test("review of 7a967b8 [high] example 1: A and B to the same seller and price; A's header names B's tx T (B's nonce), A's own tx U (A's nonce) is on chain", () => {
  const A = buyRec("A", "2026-10-04T15:00:00Z", NA, TT, true);
  const B = buyRec("B", "2026-10-04T15:00:15Z", NB, null, false);
  const r = chainCheckRecords([A, B], [txU, txT], { payer: PAYER, checkedAt: "x" });
  const [a, b] = r.records;
  assert.equal(a!.settlementTx, UU, "A gets its own tx by its own nonce");
  assert.equal(a!.chainCheck?.by, "nonce");
  assert.equal(classifyRecord(a!).cause, "delivered");
  assert.equal(b!.settlementTx, TT, "T stays free and goes to B by B's nonce");
  assert.equal(b!.chainCheck?.by, "nonce");
  assert.equal(classifyRecord(b!).cause, "delivered");
  assert.deepEqual(r.summary.unmatched, [], "U is assigned");
  // Both answers naming T: T is B's by nonce, U is A's.
  const both = chainCheckRecords([A, { ...B, settledOnChain: true, delivered: true, settlementTx: TT }], [txU, txT], { payer: PAYER, checkedAt: "x" });
  assert.deepEqual(both.records.map((x) => x.settlementTx), [UU, TT]);
});

test("review of 7a967b8 [high] example 2: only A names another nonce's tx; delivered in main stays delivered when A's own tx is on chain, and is never held against the seller when it is not", () => {
  const A = buyRec("A", "2026-10-04T15:00:00Z", NA, TT, true);
  const withOwn = chainCheckRecords([A], [txU, txT], { payer: PAYER, checkedAt: "x" });
  assert.equal(withOwn.records[0]!.settlementTx, UU);
  assert.equal(classifyRecord(withOwn.records[0]!).cause, "delivered", "no step back from main");
  assert.deepEqual(withOwn.summary.unmatched.map((u) => u.tx), [TT], "T carries a nonce no record signed: a human looks");
  const without = chainCheckRecords([A], [txT], { payer: PAYER, checkedAt: "x" });
  const c = classifyRecord(without.records[0]!);
  assert.equal(c.cause, "unconfirmed", "A's own authorization never moved money: vet402 cannot confirm it");
  assert.equal(isNegative("unconfirmed", c), false, "unconfirmed is vet402's side, never the seller's");
  // On the page: an untold seller's unconfirmed row is shown as unconfirmed, not withheld as a failure.
  const dry = { generatedAt: "2026-10-04T00:00:00Z", catalogs: {}, arbitrum: { payTosInCatalogs: 1, payTosWithLive402: 1, choices: [{ payTo: PT, catalogListings: 1, hosts: ["s.test"], chosen: { resource: "https://s.test/x", liveAmount: "1000" } }] } };
  const l = withholdUnnotified(buildLanePublic("arbitrum", dry, [{ ...without.records[0]!, lane: "arbitrum", cause: c }]), new Set());
  assert.equal(l.rows[0]!.status, "unconfirmed");
  assert.deepEqual(unpublishableRows(l, new Set()), []);
});

const answer400 = (body: string, declaredParams?: string[]) => laneInputProblem({ resource: "https://s.test/a", response: resp(400, body), body, ...(declaredParams ? { declaredParams } : {}) });

test("review of 7a967b8 [mid]: the seller's own broken side stays the seller's", () => {
  const sellerSide: [string, string[]?][] = [
    ["Missing 'OPENAI_API_KEY' environment variable"],
    ['missing "DATABASE_URL"'],
    ['missing "redis_url" in config'],
    ["Server misconfigured: missing env value"],
    ['{"error":"upstream data missing","url":"https://s.test/a?q=1"}'],
    ['{"error":"Token data missing","query":{"symbol":"ETH","required":true}}'],
    ["upstream response missing fields"],
    ['{"error":"upstream data missing for this symbol"}', ["symbol"]],
  ];
  for (const [body, declared] of sellerSide) {
    assert.equal(answer400(body, declared), null, body);
    const rec = { ...bazaar, settledOnChain: true, response: resp(400, body), body, ...(declared ? { declaredParams: declared } : {}) };
    assert.equal(classifyRecord(rec).cause, "seller_config", `${body}: settled, then the seller's own failure`);
  }
  // The earlier seven stay vet402's.
  for (const m of EARLIER_SEVEN_KEPT) {
    assert.equal(answer400(JSON.stringify({ error: m }))?.kind, "missing_input", m);
  }
});

test("review of 7a967b8 [high, existing]: a payment or header word elsewhere in the answer does not turn vet402's input error into the seller's", () => {
  assert.equal(answer400('{"error":"Missing required field: wallet","payment":{"scheme":"exact","network":"eip155:42161","amount":"1000"}}')?.kind, "missing_input");
  assert.equal(answer400('{"error":"query is required","hint":"see the x-request-id header"}')?.kind, "missing_input");
  assert.equal(answer400("query is required. Check the header docs.")?.kind, "missing_input");
  // In the same sentence, payment or authentication words still keep it off vet402's request.
  assert.equal(answer400('{"error":"payment header is required"}'), null);
  assert.equal(answer400('{"error":"missing authorization field"}'), null);
});

test("review of 7a967b8 [low]: the last answer per listing is the newest one, whichever lane file comes last", () => {
  const listing = "https://s.test/x";
  const rec = (lane: string, at: string, status: number) => ({ ...base({ resource: listing, payTo: PT, amountAtomic: "1000", at, response: resp(status, "{}"), body: "{}" }), lane });
  const m = lastPaidByListing([rec("arbitrum", "2026-10-05T10:00:00Z", 200), rec("base-compare", "2026-10-01T10:00:00Z", 404)]);
  assert.equal(m.get(listing)!.status, 200, "the older base-compare answer read later does not overwrite");
  assert.equal(m.get(listing)!.at, "2026-10-05T10:00:00Z");
  const m2 = lastPaidByListing([rec("arbitrum", "2026-10-01T10:00:00Z", 200), rec("base-compare", "2026-10-05T10:00:00Z", 404)]);
  assert.equal(m2.get(listing)!.status, 404);
});

test("review of 7a967b8 [low]: a catalog date equal to today is a value, not <today>; only what vet402 filled is", () => {
  const req = { resource: "https://d.test/rates", method: "GET" as const, query: { date: "2026-10-01" }, body: null };
  // The catalog gave the date; nothing was filled: no normalisation, and the next day it is the same catalog value.
  const listing = { resource: req.resource, extensions: { bazaar: { info: { input: { method: "GET", queryParams: { date: "2026-10-01" } } } } } };
  const r = repairLaneRequest(listing, req, "2026-10-01");
  assert.ok(r.ok);
  assert.deepEqual(r.ok && r.datedParams, []);
  assert.equal(r.ok && r.requestKey, laneRequestKey(req));
  assert.notEqual(laneRequestKey(req), laneRequestKey({ ...req, query: { date: "<today>" } }));
  // Only a parameter in datedParams is written as <today>.
  assert.equal(laneRequestKey(req, { date: "2026-10-01", params: [] }), laneRequestKey(req));
  assert.equal(laneRequestKey(req, { date: "2026-10-01", params: ["date"] }), laneRequestKey({ ...req, query: { date: "<today>" } }));
});

// ---------- review of 60bcce8: the seller's setting names, and the validators' standard texts ----------

test("names: a quoted name that is the seller's own setting stays the seller's, whatever the listing declares", () => {
  const names = ["secret_token", "db_password", "privateKey", "rpcUrl", "jwt_secret", "stripe_secret_key", "access_token", "Supabase_Url", "mnemonic", "payTo", "facilitatorUrl"];
  for (const n of names) {
    const body = `missing "${n}"`;
    for (const declared of [undefined, ["q", "address"]]) {
      assert.equal(answer400(body, declared), null, `${body} (declared ${declared?.join(",") ?? "none"})`);
      assert.equal(answer400(JSON.stringify({ error: body }), declared), null, `${body} in JSON`);
      const rec = { ...bazaar, settledOnChain: true, response: resp(400, body), body, ...(declared ? { declaredParams: declared } : {}) };
      assert.equal(classifyRecord(rec).cause, "seller_config", body);
    }
  }
  // A quoted name the listing does not declare, when it declares others, is not vet402's request either.
  assert.equal(answer400('missing "chain"', ["q", "address"]), null);
  assert.equal(answer400('missing "address"', ["q", "address"])?.kind, "missing_input", "declared: vet402's");
  // The earlier seven stay vet402's.
  for (const m of EARLIER_SEVEN_KEPT) {
    assert.equal(answer400(JSON.stringify({ error: m }))?.kind, "missing_input", m);
    assert.equal(answer400(m)?.kind, "missing_input", `${m} (plain)`);
  }
});

test("validators: Fastify's 'must have required property' and Zod's 'Required' with a field name are vet402's request, except for an auth or payment header", () => {
  // A missing header is never vet402's (it sends none): headers 'address' is the seller's (review of a70363c).
  assert.equal(answer400(JSON.stringify({ message: "headers must have required property 'address'" })), null);
  for (const where of ["querystring", "body", "params"]) {
    const body = JSON.stringify({ statusCode: 400, code: "FST_ERR_VALIDATION", error: "Bad Request", message: `${where} must have required property 'address'` });
    assert.equal(answer400(body)?.kind, "missing_input", where);
    assert.equal(classifyRecord({ ...bazaar, settledOnChain: true, response: resp(400, body), body }).rule, "input:missing_input:settled", where);
  }
  for (const h of ["authorization", "payment", "x-payment"]) {
    const body = JSON.stringify({ message: `headers must have required property '${h}'` });
    assert.equal(answer400(body), null, h);
  }
  // A "Required" that names nothing is the seller's (review of 99148bc).
  assert.equal(answer400('{"message":"Required"}'), null);
  assert.equal(answer400('[{"code":"invalid_type","expected":"string","received":"undefined","path":["address"],"message":"Required"}]')?.kind, "missing_input");
  assert.equal(answer400('[{"code":"invalid_type","expected":"string","received":"undefined","path":["headers","authorization"],"message":"Required"}]'), null);
  assert.equal(answer400('[{"code":"invalid_type","expected":"string","received":"undefined","path":["apiSecret"],"message":"Required"}]'), null);
  // A plain "Payment Required" is never this.
  assert.equal(answer400('{"error":"Payment Required"}'), null);
});

test("a seller-side reading re-buys every 7 days; only vet402's own wrong request stops for good", () => {
  const body = 'missing "secret_token"';
  const rec = { ...bazaar, settledOnChain: true, response: resp(400, body), body };
  const last = lastPaidByListing([rec]).get(bazaar.resource)!;
  assert.equal(last.inputError, false);
  assert.equal(holdAfter4xx(last, Date.parse(bazaar.at) + SELLER_4XX_RETRY_MS), null, "bought again after 7 days");
});

// ---------- review of 99148bc ----------

const zodIssue = (path: string[]) => JSON.stringify([{ code: "invalid_type", expected: "string", received: "undefined", path, message: "Required" }]);
const fastify = (where: string, name: string) => JSON.stringify({ statusCode: 400, code: "FST_ERR_VALIDATION", error: "Bad Request", message: `${where} must have required property '${name}'` });

test("Zod: every name (issue paths, fieldErrors keys) goes through quotedNameSide; a 'Required' with no name is the seller's", () => {
  for (const body of ['{"fieldErrors":{"STRIPE_SECRET_KEY":["Required"]}}', '{"error":{"fieldErrors":{"DB_HOST":["Required"]}}}', zodIssue(["STORE_ID"]), '{"error":"Required"}', '{"formErrors":["Required"],"fieldErrors":{}}']) {
    assert.equal(answer400(body), null, body);
    assert.equal(classifyRecord({ ...bazaar, settledOnChain: true, response: resp(400, body), body }).cause, "seller_config", body);
  }
  // A field name that is the request: vet402's, as before.
  assert.equal(answer400(zodIssue(["address"]))?.kind, "missing_input");
  assert.equal(answer400('{"fieldErrors":{"address":["Required"]}}')?.kind, "missing_input");
  // One seller setting among the names makes it the seller's.
  assert.equal(answer400('{"fieldErrors":{"address":["Required"],"DB_HOST":["Required"]}}'), null);
  // Declared by the listing: vet402's; not declared while others are: the seller's.
  assert.equal(answer400(zodIssue(["chain"]), ["q", "address"]), null);
  assert.equal(answer400(zodIssue(["chain"]), ["q", "chain"])?.kind, "missing_input");
});

test("Fastify: the name is read by quotedNameSide; token, x-access-token, x-auth-token, x-api-key and api-key headers are auth", () => {
  for (const name of ["db_password", "jwtSecret", "secret_token", "rpcUrl"]) {
    for (const where of ["querystring", "body", "params"]) assert.equal(answer400(fastify(where, name)), null, `${where} ${name}`);
  }
  assert.equal(answer400(fastify("querystring", "chain"), ["q", "address"]), null, "not declared while others are");
  for (const h of ["token", "x-access-token", "x-auth-token", "x-api-key", "api-key", "authorization", "payment", "x-payment"]) assert.equal(answer400(fastify("headers", h)), null, h);
  for (const where of ["querystring", "body", "params"]) assert.equal(answer400(fastify(where, "address"))?.kind, "missing_input", where);
  assert.equal(answer400(fastify("headers", "address")), null, "a missing header is the seller's");
});

test("unchanged by this review: the eleven setting names, the earlier seven, Fastify 'address', Zod path [address], Payment Required", () => {
  for (const n of ["secret_token", "db_password", "privateKey", "rpcUrl", "jwt_secret", "stripe_secret_key", "access_token", "Supabase_Url", "mnemonic", "payTo", "facilitatorUrl"]) {
    assert.equal(answer400(`missing "${n}"`), null, n);
    assert.equal(answer400(`missing "${n}"`, ["q", "address"]), null, n);
  }
  for (const m of EARLIER_SEVEN_KEPT) {
    assert.equal(answer400(JSON.stringify({ error: m }))?.kind, "missing_input", m);
  }
  assert.equal(answer400(fastify("querystring", "address"))?.kind, "missing_input");
  assert.equal(answer400(zodIssue(["address"]))?.kind, "missing_input");
  assert.equal(answer400('{"error":"Payment Required"}'), null);
});

test("intended: an undeclared quoted \"url\" or \"tokenAddress\" (vet402's on 4787123) is now the seller's; it is only re-bought every 7 days, never stopped for good", () => {
  for (const n of ["url", "tokenAddress"]) {
    assert.equal(answer400(`missing "${n}"`, ["q"]), null, n);
    const body = `missing "${n}"`;
    const last = lastPaidByListing([{ ...bazaar, settledOnChain: true, response: resp(400, body), body, declaredParams: ["q"] }]).get(bazaar.resource)!;
    assert.equal(last.inputError, false);
    assert.equal(holdAfter4xx(last, Date.parse(bazaar.at) + SELLER_4XX_RETRY_MS), null, `${n}: bought again after 7 days`);
  }
});

// ---------- review of a70363c: the rule turned around (an answer is vet402's only when every missing name is) ----------

const pyd = (loc: string[]) => JSON.stringify({ detail: [{ type: "missing", loc, msg: "Field required", input: null }] });

test("turned rule, seller's: every form that escaped, the validators' texts, pydantic, and every earlier seller-side example", () => {
  const sellers: [string, string, string[]?][] = [
    ...["payment", "signature", "auth", "txHash", "database"].map((n): [string, string] => [`Fastify '${n}'`, fastify("body", n)]),
    ...["x-signature", "x-402-payment", "x-authorization", "x-client-id", "x-session"].map((h): [string, string] => [`Fastify header '${h}'`, fastify("headers", h)]),
    ['Zod path ["signature"]', zodIssue(["signature"])],
    ['Zod path ["headers","x-signature"]', zodIssue(["headers", "x-signature"])],
    ['Zod path ["config","database"]', zodIssue(["config", "database"])],
    ['Zod path ["env","dbHost"]', zodIssue(["env", "dbHost"])],
    ["Zod fieldErrors signature", '{"fieldErrors":{"signature":["Required"]}}'],
    ["Zod fieldErrors login", '{"fieldErrors":{"login":["Required"]}}'],
    ["Server misconfigured + fieldErrors database", '{"error":"Server misconfigured","details":{"fieldErrors":{"database":["Required"]}}}'],
    ['Joi "\\"DATABASE_URL\\" is required"', '"\\"DATABASE_URL\\" is required"'],
    ['Joi "DB_HOST" is required', '"DB_HOST" is required'],
    ['Joi "RPC_URL" is required', '"RPC_URL" is required'],
    ["Yup STORE_ID is a required field", "STORE_ID is a required field"],
    ["Missing required field: DB_HOST", "Missing required field: DB_HOST"],
    ["token is required", "token is required"],
    ['pydantic loc ["body","SECRET"]', pyd(["body", "SECRET"])],
    ['pydantic loc ["header","x-api-key"]', pyd(["header", "x-api-key"])],
    ['pydantic loc ["header","authorization"]', pyd(["header", "authorization"])],
    // Earlier seller-side examples.
    ["env var", "Missing 'OPENAI_API_KEY' environment variable"],
    ["DATABASE_URL", 'missing "DATABASE_URL"'],
    ["redis_url in config", 'missing "redis_url" in config'],
    ["misconfigured env", "Server misconfigured: missing env value"],
    ["upstream + url key", '{"error":"upstream data missing","url":"https://s.test/a?q=1"}'],
    ["Token data + query key", '{"error":"Token data missing","query":{"symbol":"ETH","required":true}}'],
    ["upstream response", "upstream response missing fields"],
    ["upstream + declared symbol", '{"error":"upstream data missing for this symbol"}', ["symbol"]],
    ["Payment Required", '{"error":"Payment Required"}'],
    ['{"error":"Required"}', '{"error":"Required"}'],
    ['{"message":"Required"}', '{"message":"Required"}'],
    ["formErrors", '{"formErrors":["Required"],"fieldErrors":{}}'],
    ["fieldErrors STRIPE_SECRET_KEY", '{"fieldErrors":{"STRIPE_SECRET_KEY":["Required"]}}'],
    ["fieldErrors DB_HOST nested", '{"error":{"fieldErrors":{"DB_HOST":["Required"]}}}'],
    ['Zod path ["STORE_ID"]', zodIssue(["STORE_ID"])],
    ['Zod path ["headers","authorization"]', zodIssue(["headers", "authorization"])],
    ['Zod path ["apiSecret"]', zodIssue(["apiSecret"])],
    ["upstream data missing", "upstream data missing"],
    ["resource missing", "resource missing"],
    ...["secret_token", "db_password", "privateKey", "rpcUrl", "jwt_secret", "stripe_secret_key", "access_token", "Supabase_Url", "mnemonic", "payTo", "facilitatorUrl"].flatMap((n): [string, string, string[]?][] => [[`missing "${n}"`, `missing "${n}"`], [`missing "${n}" (q, address)`, `missing "${n}"`, ["q", "address"]]]),
    ...["db_password", "jwtSecret", "secret_token", "rpcUrl"].map((n): [string, string] => [`Fastify '${n}'`, fastify("querystring", n)]),
    ["Fastify 'chain' (q, address)", fastify("querystring", "chain"), ["q", "address"]],
    ...["token", "x-access-token", "x-auth-token", "x-api-key", "api-key", "authorization", "payment", "x-payment", "address"].map((h): [string, string] => [`Fastify header '${h}'`, fastify("headers", h)]),
    ["Missing url (url is not an allowed name)", JSON.stringify({ error: "Missing url" })],
  ];
  for (const [label, body, declared] of sellers) {
    assert.equal(answer400(body, declared), null, label);
    const rec = { ...bazaar, settledOnChain: true, response: resp(400, body), body, ...(declared ? { declaredParams: declared } : {}) };
    assert.equal(classifyRecord(rec).cause, "seller_config", label);
  }
});

test("turned rule, vet402's (unchanged): the earlier seven but url, Fastify and Zod 'address', pydantic loc [query,address], Joi '\"address\" is required'", () => {
  const vet: [string, string][] = [
    ...EARLIER_SEVEN_KEPT.map((m): [string, string] => [m, JSON.stringify({ error: m })]),
    ...["querystring", "body", "params"].map((w): [string, string] => [`Fastify ${w} 'address'`, fastify(w, "address")]),
    ['Zod path ["address"]', zodIssue(["address"])],
    ['pydantic loc ["query","address"]', pyd(["query", "address"])],
    ['Joi "address" is required', '"address" is required'],
  ];
  for (const [label, body] of vet) {
    assert.equal(answer400(body)?.kind, "missing_input", label);
    assert.equal(classifyRecord({ ...bazaar, settledOnChain: true, response: resp(400, body), body }).rule, "input:missing_input:settled", label);
  }
});

test("turned rule, declarations: a declared name (city) missing is vet402's in Joi, Fastify and Zod; an allowed word the listing does not declare is the seller's", () => {
  assert.equal(answer400('"city" is required', ["city"])?.kind, "missing_input");
  assert.equal(answer400(fastify("body", "city"), ["city"])?.kind, "missing_input");
  assert.equal(answer400(zodIssue(["city"]), ["city"])?.kind, "missing_input");
  assert.equal(answer400('missing "address"', ["city"]), null);
  // snake_case and camelCase are one name.
  assert.equal(answer400('"token_address" is required', ["tokenAddress"])?.kind, "missing_input");
});

test("turned rule, stopping: vet402's 4xx stops for good only on a listing that declares parameters; one that declares none is re-bought every 7 days", () => {
  const body = '"address" is required';
  const noDecl = { ...bazaar, settledOnChain: true, response: resp(400, body), body };
  const withDecl = { ...noDecl, declaredParams: ["address"] };
  const a = lastPaidByListing([noDecl]).get(bazaar.resource)!;
  assert.equal(a.inputError, true);
  assert.equal(a.declaredCount, 0);
  assert.equal(holdAfter4xx(a, Date.parse(bazaar.at) + SELLER_4XX_RETRY_MS), null, "no declarations: bought again after 7 days");
  assert.equal(holdAfter4xx(a, Date.parse(bazaar.at) + 86_400_000), "unchanged_after_seller_4xx_within_7_days");
  const b = lastPaidByListing([withDecl]).get(bazaar.resource)!;
  assert.equal(holdAfter4xx(b, Date.parse(bazaar.at) + 365 * 86_400_000), "input_unchanged_after_input_error", "declared: stopped until the request changes");
});
