/**
 * The EVM lanes decide "settled" from the chain, never from the seller's settlement header; a call the seller
 * said was free is not a failure; vet402's own wrong request is never counted against the seller.
 * Examples are the 2026-09-30 Arbitrum run (payer 0x9B59…4E51): payTo, price, response and the tx read on chain.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDeclaredPatches, loadLaneRecords, loadLaneRecordsChecked, payStopForUnreadableLines, readDeclaredPatches, readJsonl, type DeclaredPatch } from "../src/evm/lane-records.js";
import { spawnSync } from "node:child_process";
import { buildLanePublic as buildLanePublic2, statusOf } from "../src/evm/site.js";
import { getAddress, type Hex } from "viem";
import { chainCheckRecords, mergeReadings, readRanges, uncheckedPurchases, type EvmOutTx } from "../src/evm/chaincheck.js";
import { EVM_CHAINS } from "../src/evm/chains.js";
import type { ChainBuyRecord } from "../src/evm/evm-buy.js";
import { INPUT_4XX_RETRY_MS, SCHEMA_KEYWORDS, declarationFrom, namesInSentence, strongNamesInSentence, holdAfter4xx, laneInputProblem, lastPaidByListing, mergeDeclarations, missingRequired, repairLaneRequest, sellerSaidFree, sentParamNames, SELLER_4XX_RETRY_MS } from "../src/evm/lane-input.js";
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
/** A last answer from now: within every hold (a fixed date would age out of the 30-day hold). */
const NOW_ISO = new Date().toISOString();
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
  const r1 = repairLaneRequest(social, { resource: social.resource, method: "GET", query: { username: "yoga_with_adriene" }, body: null }, "2026-10-01", { status: 404, requestKey: null, at: NOW_ISO, inputError: true, declaredCount: 1 });
  assert.ok(r1.ok && r1.request.resource === "https://socialintel.dev/v1/user/yoga_with_adriene");
  const carbon = { resource: "https://api.carbon-cashmere.de/v1/bittensor-derivatives/alpha-price-history/:netuid", extensions: { bazaar: { info: { input: { method: "GET", pathParams: { netuid: "1" }, type: "http" } } } } };
  const r2 = repairLaneRequest(carbon, { resource: carbon.resource, method: "GET", query: null, body: null }, "2026-10-01", { status: 422, requestKey: null, at: NOW_ISO, inputError: true, declaredCount: 1 });
  assert.ok(r2.ok && r2.request.resource.endsWith("/alpha-price-history/1"));
  const noValue = repairLaneRequest({ resource: "https://x.test/u/:id" }, { resource: "https://x.test/u/:id", method: "GET", query: null, body: null }, "2026-10-01");
  assert.deepEqual(noValue, { ok: false, reason: "path_placeholder", param: "id" });
  // quickintel's Dexter listing declares the body (chain, tokenAddress): sent instead of {}.
  const qi = { resource: "https://x402.quickintel.io/v1/scan/full", accepts: [{ outputSchema: { input: { method: "POST", body: { chain: "base", tokenAddress: "0xa4a2e2ca3fbfe21aed83471d28b6f65a233c6e00" } } } }] };
  const r3 = repairLaneRequest(qi as never, { resource: qi.resource, method: "POST", query: null, body: {} }, "2026-10-01", { status: 400, requestKey: null, at: NOW_ISO, inputError: true, declaredCount: 1 });
  assert.ok(r3.ok);
  assert.deepEqual(r3.ok && r3.request.body, { chain: "base", tokenAddress: "0xa4a2e2ca3fbfe21aed83471d28b6f65a233c6e00" });
  // openwebninja: email_domain is required and nothing names a value: not bought again after the 400.
  const ow = { resource: "https://x402.openwebninja.com/email-search/search-emails", inputSchema: { properties: { email_domain: { type: "string" }, query: { type: "string" } }, required: ["email_domain", "query"] }, extensions: { bazaar: { info: { input: { method: "GET", queryParams: { type: "object", properties: { email_domain: { type: "string" }, query: { type: "string" } }, required: ["email_domain", "query"] } } } } } };
  const r4 = repairLaneRequest(ow, { resource: ow.resource, method: "GET", query: null, body: null }, "2026-10-01", { status: 400, requestKey: null, at: NOW_ISO, inputError: true, declaredCount: 1 });
  assert.equal(r4.ok, false);
  // Plan: the listing goes to the group's input skips, and the row says so in neutral words.
  const accept = { scheme: "exact", network: ARB.caip2, amount: "3000", asset: ARB.asset, payTo: openweb.payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
  const g = groupByPayTo([{ ...ow, accepts: [accept] }], ARB, { maxPerAtomic: 100_000n, today: "2026-10-01", lastPaid: new Map([[ow.resource, { status: 400, requestKey: null, at: NOW_ISO, inputError: true, declaredCount: 1 }]]) });
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
  assert.match(lane, /checkLaneFiles\(r\.lane, payer, resultsDir\)/, "every paying run ends with the chain check");
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
  const first = repairLaneRequest(social, req, "2026-10-01", { status: 404, requestKey: null, at: NOW_ISO, inputError: true, declaredCount: 1 });
  assert.ok(first.ok && first.changed, "the old record sent the catalog's request: the filled one is new, so it is bought once");
  const sent = first.ok ? first.requestKey : "";
  // That filled request answered 404 too: the next run fills it the same way and does not buy it.
  assert.deepEqual(repairLaneRequest(social, req, "2026-10-01", { status: 404, requestKey: sent, at: NOW_ISO, inputError: true, declaredCount: 1 }), { ok: false, reason: "input_unchanged_after_input_error", param: null });
  // A 200 last time, or a different request now: bought.
  assert.equal(repairLaneRequest(social, req, "2026-10-01", { status: 200, requestKey: sent, at: NOW_ISO, inputError: false }).ok, true);
  assert.equal(repairLaneRequest(social, req, "2026-10-01", { status: 404, requestKey: "f".repeat(64), at: NOW_ISO, inputError: true, declaredCount: 1 }).ok, true);
  // The plan looks the listing up by its catalog URL and carries it to the entry and the record.
  const accept = { scheme: "exact", network: ARB.caip2, amount: "10000", asset: ARB.asset, payTo: social.resource && "0xB1Acd9E0269023546074400A434e703B646AaBBa", maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } };
  const listing = { ...social, accepts: [accept] };
  const g1 = groupByPayTo([listing], ARB, { maxPerAtomic: 100_000n, today: "2026-10-01", lastPaid: new Map([[social.resource, { status: 404, requestKey: null, at: NOW_ISO, inputError: true, declaredCount: 1 }]]) });
  assert.equal(g1[0]!.options[0]!.listingResource, social.resource);
  assert.equal(g1[0]!.options[0]!.resource, "https://socialintel.dev/v1/user/yoga_with_adriene");
  const g2 = groupByPayTo([listing], ARB, { maxPerAtomic: 100_000n, today: "2026-10-01", lastPaid: new Map([[social.resource, { status: 404, requestKey: sent, at: NOW_ISO, inputError: true, declaredCount: 1 }]]) });
  assert.equal(g2[0]!.options.length, 0);
  assert.match(g2[0]!.inputSkipped![0]!.why, /input_unchanged_after_input_error/);
  const lane = readFileSync(new URL("../scripts/evm-lane.ts", import.meta.url), "utf8");
  assert.match(lane, /return lastPaidByListing\(recordsRead\.rows\.filter/);
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

test("review of a44d5aa [mid]: vet402's own wrong request is held (30 days since 2292a17's review); a seller-side 4xx is bought again every 7 days", () => {
  const at = "2026-10-01T00:00:00Z";
  const t0 = Date.parse(at);
  // vet402's own wrong request: held for 30 days (review of 2292a17: no stop is for good any more).
  assert.equal(holdAfter4xx({ status: 400, requestKey: null, at, inputError: true, declaredCount: 1 }, t0 + 29 * 86_400_000), "input_unchanged_after_input_error");
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
  assert.match(lane, /return lastPaidByListing\(recordsRead\.rows\.filter/);
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

test("turned rule, stopping: vet402's 4xx is held (30 days) only on a listing that declares parameters; one that declares none is re-bought every 7 days", () => {
  const body = '"address" is required';
  const noDecl = { ...bazaar, settledOnChain: true, response: resp(400, body), body };
  const withDecl = { ...noDecl, declaredParams: ["address"] };
  const a = lastPaidByListing([noDecl]).get(bazaar.resource)!;
  assert.equal(a.inputError, true);
  assert.equal(a.declaredCount, 0);
  assert.equal(holdAfter4xx(a, Date.parse(bazaar.at) + SELLER_4XX_RETRY_MS), null, "no declarations: bought again after 7 days");
  assert.equal(holdAfter4xx(a, Date.parse(bazaar.at) + 86_400_000), "unchanged_after_seller_4xx_within_7_days");
  const b = lastPaidByListing([withDecl]).get(bazaar.resource)!;
  assert.equal(holdAfter4xx(b, Date.parse(bazaar.at) + 29 * 86_400_000), "input_unchanged_after_input_error", "declared: held until the request changes, or 30 days");
});

// ---------- rule 0: a required input vet402 did not send (review of b6601a3) ----------
// The documents below are excerpts of what the catalogs and the sellers' unpaid 402s served on 2026-10-02 (read
// with scripts/evm-declare.ts; nothing paid), cut to the parts that declare inputs.

/** Dexter catalog, x402.quickintel.io/v1/scan/full: an example body, no "required". */
const QI_DEXTER = { resource: "https://x402.quickintel.io/v1/scan/full", method: "POST", metadata: { input: { body: { chain: "base", tokenAddress: "0xa4a2e2ca3fbfe21aed83471d28b6f65a233c6e00" }, type: "http", method: "POST", bodyType: "json" } }, accepts: [{ network: "eip155:8453", outputSchema: { input: { body: { chain: "base", tokenAddress: "0xa4a2e2ca3fbfe21aed83471d28b6f65a233c6e00" }, type: "http", method: "POST", bodyType: "json" } } }] };
/** quickintel's own 402 body: the Bazaar schema marks chain and tokenAddress required. */
const QI_402 = { x402Version: 2, extensions: { bazaar: { info: { input: { type: "http", method: "POST", bodyType: "json", body: { chain: "base", tokenAddress: "0xa4a2e2ca3fbfe21aed83471d28b6f65a233c6e00" } } }, schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { input: { type: "object", required: ["chain", "tokenAddress"], properties: { chain: { type: "string", description: 'Blockchain network name (e.g., "eth", "bsc", "base", "sol"). See docs for all 63 supported chains.' }, tokenAddress: { type: "string", description: "Token contract address to scan. EVM: 0x-prefixed hex. Solana: base58." } } } } } } } };
/** Dexter catalog, oracle.the-undesirables.com/api/v1/grade-or-not: declares no input at all. */
const UND_DEXTER = { resource: "https://oracle.the-undesirables.com/api/v1/grade-or-not", method: "GET", metadata: { description: "Checks whether something should be graded or not.", displayName: "Grade or Not" }, accepts: [{ network: "eip155:4663", outputSchema: null }] };
/** the-undesirables' own 402 (PAYMENT-REQUIRED header and body alike): queryParams with required ["card_name"]. */
const UND_402 = { x402Version: 2, extensions: { bazaar: { info: { input: { type: "http", queryParams: { card_name: "Base Set Charizard Holo", predicted_grade: 8.5 }, method: "GET" } }, schema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { input: { type: "object", properties: { type: { type: "string", const: "http" }, method: { type: "string", enum: ["GET", "HEAD", "DELETE"] }, queryParams: { type: "object", properties: { card_name: { type: "string", description: "Card name to evaluate" }, raw_price: { type: "number" }, predicted_grade: { type: "number" }, service_tier: { type: "string" } }, required: ["card_name"] } }, required: ["type", "method"], additionalProperties: false } } } } } };

test("rule 0, the catalogs and 402s as served: quickintel requires chain and tokenAddress, the-undesirables requires card_name (in the 402, not the catalog)", () => {
  const qiCat = declarationFrom(QI_DEXTER, "catalog (dexter)");
  assert.deepEqual(qiCat.required, [], "the Dexter catalog gives an example body, not a required list");
  assert.deepEqual(qiCat.declared.sort(), ["chain", "tokenAddress"]);
  const qi = mergeDeclarations([qiCat, declarationFrom(QI_402, "402")]);
  assert.deepEqual(qi.required.sort(), ["chain", "tokenAddress"]);
  assert.deepEqual(qi.requiredFrom, ["402:extensions.bazaar.schema.input"]);
  const undCat = declarationFrom(UND_DEXTER, "catalog (dexter)");
  assert.deepEqual(undCat, { declared: [], required: [], from: [], requiredFrom: [] }, "the catalog declares nothing");
  const und = mergeDeclarations([undCat, declarationFrom(UND_402, "402")]);
  assert.deepEqual(und.required, ["card_name"], "type and method are the schema's own, not inputs");
  assert.deepEqual(und.requiredFrom, ["402:extensions.bazaar.schema.input.properties.queryParams"]);
});

test("rule 0: quickintel (sent {}, lacking chain and tokenAddress) and the-undesirables (no card_name) are vet402's, before the name rule", () => {
  const qi = mergeDeclarations([declarationFrom(QI_DEXTER, "catalog"), declarationFrom(QI_402, "402")]);
  const q = { ...byHost("quickintel"), requiredParams: qi.required, declaredParams: qi.declared, requiredFrom: qi.requiredFrom, sentParams: [] as string[] };
  assert.equal(laneInputProblem(q)?.kind, "missing_input");
  assert.match(laneInputProblem(q)!.detail, /did not send chain, tokenAddress/);
  assert.equal(classifyRecord(q).rule, "input:missing_input:settled");
  const UND_BODY = '{"detail":[{"type":"missing","loc":["query","card_name"],"msg":"Field required","input":null}]}';
  const und = mergeDeclarations([declarationFrom(UND_DEXTER, "catalog"), declarationFrom(UND_402, "402")]);
  const u = { ...base({ resource: UND_DEXTER.resource, payTo: "0x642e8a7c289381f24f0395e0539f0ba41c74cc1b", amountAtomic: "100000", at: "2026-09-30T12:32:27Z", response: resp(422, UND_BODY), body: UND_BODY }), requiredParams: und.required, declaredParams: und.declared, sentParams: [] as string[] };
  assert.equal(laneInputProblem(u)?.kind, "missing_input");
  assert.equal(classifyRecord(u).cause, "vet402");
  // Without what was sent, or without a required list, rule 0 says nothing and the name rule decides.
  assert.deepEqual(missingRequired({ requiredParams: ["card_name"] }), []);
  assert.equal(laneInputProblem({ ...u, sentParams: undefined, requiredParams: undefined, declaredParams: undefined }), null, "card_name alone is not an allowed name");
  // Sent everything required: rule 0 does not apply; the seller's own 422 stays the seller's.
  assert.deepEqual(missingRequired({ requiredParams: ["card_name"], sentParams: ["card_name"] }), []);
  assert.deepEqual(missingRequired({ requiredParams: ["tokenAddress"], sentParams: ["token_address"] }), [], "snake and camel are one name");
});

test("rule 0: the hold is lifted when vet402 fills the input (the request changes)", () => {
  const qi = mergeDeclarations([declarationFrom(QI_DEXTER, "catalog"), declarationFrom(QI_402, "402")]);
  const rec = { ...byHost("quickintel"), requiredParams: qi.required, declaredParams: qi.declared, sentParams: [] as string[] };
  const last = lastPaidByListing([rec]).get(rec.resource)!;
  assert.equal(last.inputError, true);
  assert.ok((last.declaredCount ?? 0) > 0);
  assert.equal(holdAfter4xx(last, Date.parse(rec.at) + 29 * 86_400_000), "input_unchanged_after_input_error");
  // The same {} again: not bought. Filled from the listing (chain, tokenAddress): a different request, bought.
  const same = repairLaneRequest({ resource: QI_DEXTER.resource }, { resource: QI_DEXTER.resource, method: "POST", query: null, body: {} }, "2026-10-02", last);
  assert.equal(same.ok, false);
  const filled = repairLaneRequest(QI_DEXTER as never, { resource: QI_DEXTER.resource, method: "POST", query: null, body: {} }, "2026-10-02", last);
  assert.ok(filled.ok, "filled with chain and tokenAddress: bought");
  assert.deepEqual(filled.ok && filled.request.body, { chain: "base", tokenAddress: "0xa4a2e2ca3fbfe21aed83471d28b6f65a233c6e00" });
});

test("rule 0, the record: a purchase keeps the names it sent (never values), what was declared required and where it was read", () => {
  const buy = readFileSync(new URL("../src/evm/evm-buy.ts", import.meta.url), "utf8");
  assert.match(buy, /sentParams: \[\.\.\.new Set\(\[\.\.\.Object\.keys\(e\.query \?\? \{\}\)/);
  assert.match(buy, /\.\.\.\(e\.requiredFrom\?\.length \? \{ requiredFrom: e\.requiredFrom \} : \{\}\)/);
  const plan = readFileSync(new URL("../src/evm/lane-plan.ts", import.meta.url), "utf8");
  assert.match(plan, /declarationFrom\(d, "402"\)/, "the live 402's declaration is read at plan time");
  const records = readFileSync(new URL("../src/evm/lane-records.ts", import.meta.url), "utf8");
  assert.match(records, /if \(out\[k\] === undefined && p\[k\] !== undefined\)/, "a backfill never overrides the record");
  assert.deepEqual(sentParamNames({ method: "POST", query: { a: "1" }, body: { chain: "base" } }).sort(), ["a", "chain"]);
  assert.deepEqual(sentParamNames({ method: "GET", query: null, body: { ignored: 1 } }), []);
});

// ---------- review of 709d71c ----------

/** CDP listing api.loyalspark.online/x402-gateway/recipient-api/offers, as served on 2026-10-02 (input parts only). */
const LOYALSPARK = { resource: "https://api.loyalspark.online/x402-gateway/recipient-api/offers", extensions: { bazaar: { info: { input: { headers: { "x-api-key": "rwk_..." }, method: "GET", queryParams: { token_address: "0x0000000000000000000000000000000000000001" }, type: "http" } }, schema: { properties: { input: { additionalProperties: false, properties: { headers: { additionalProperties: { type: "string" }, type: "object" }, method: { enum: ["GET", "HEAD", "DELETE"], type: "string" }, queryParams: { additionalProperties: { type: "string" }, type: "object" }, type: { const: "http", type: "string" } }, required: ["type", "method"], type: "object" } } } } } };
/** CDP listing intel.twzrd.xyz (same shape: an empty example map, and a schema queryParams with additionalProperties). */
const TWZRD = { resource: "https://intel.twzrd.xyz/v1/intel/quick", extensions: { bazaar: { info: { input: { discoverable: true, method: "GET", pathParams: { solana_address: "Solana wallet address (base58-encoded public key, 43–44 characters)" }, queryParams: {}, type: "http" } }, schema: { properties: { input: { additionalProperties: false, properties: { method: { enum: ["GET", "HEAD", "DELETE"], type: "string" }, queryParams: { additionalProperties: { type: "string" }, type: "object" }, type: { const: "http", type: "string" } }, required: ["type", "method"], type: "object" } } } } } };

test("schema words are never names: additionalProperties, items, format... from a schema-shaped part declare nothing", () => {
  const schemaOnly = { extensions: { bazaar: { schema: LOYALSPARK.extensions.bazaar.schema } } };
  assert.deepEqual(declarationFrom(schemaOnly, "catalog").declared, [], "loyalspark: the schema part declares nothing");
  assert.deepEqual(declarationFrom(TWZRD, "catalog").declared, [], "twzrd: nothing at all");
  // loyalspark's own example map does name token_address: that one is a real declaration.
  assert.deepEqual(declarationFrom(LOYALSPARK, "catalog").declared, ["token_address"]);
  for (const kw of ["additionalProperties", "items", "format", "type", "properties", "required", "$schema", "enum", "default"]) assert.ok(SCHEMA_KEYWORDS.has(kw), kw);
  assert.deepEqual(declarationFrom({ inputSchema: { type: "object", items: { type: "string" }, format: "uri" } }, "c").declared, []);
  // Missing "address" on a listing whose only "declaration" was a schema word: the allowed words apply again.
  assert.equal(answer400('missing "address"', declarationFrom(TWZRD, "catalog").declared)?.kind, "missing_input");
  // And never a name in an answer either.
  assert.equal(answer400('"additionalProperties" is required'), null);
});

test("a parameter named body is a name; a body that holds the parameters is a part", () => {
  const named = { extensions: { bazaar: { schema: { properties: { input: { type: "object", properties: { type: { type: "string" }, method: { type: "string" }, body: { type: "string", description: "the text" } }, required: ["type", "method", "body"] } } } } } };
  const d1 = declarationFrom(named, "402");
  assert.deepEqual(d1.required, ["body"]);
  const part = { extensions: { bazaar: { schema: { properties: { input: { type: "object", properties: { type: { type: "string" }, method: { type: "string" }, body: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }, required: ["type", "method", "body"] } } } } } };
  const d2 = declarationFrom(part, "402");
  assert.deepEqual(d2.required, ["text"], "body is the part; its required text is the name");
  assert.ok(!d2.declared.includes("body"));
});

test("rule 0 comes after the 404 check: a 404 stays the seller's (re-bought every 7 days) even when a required input was not sent", () => {
  const body = '{"detail":"Not Found"}';
  const rec = { ...bazaar, response: resp(404, body), body, requiredParams: ["card_name"], sentParams: [] as string[], declaredParams: ["card_name"] };
  assert.equal(laneInputProblem(rec), null);
  const last = lastPaidByListing([rec]).get(bazaar.resource)!;
  assert.equal(last.inputError, false);
  assert.equal(holdAfter4xx(last, Date.parse(bazaar.at) + SELLER_4XX_RETRY_MS), null);
  // A slot left in the URL is still vet402's on a 404 (unchanged).
  assert.equal(laneInputProblem(byHost("socialintel"))?.kind, "path_placeholder");
});

const TRACKED = readFileSync(new URL("../results/evm/declared-inputs.jsonl", import.meta.url), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as DeclaredPatch);
const UND_BODY_0930 = '{"detail":[{"type":"missing","loc":["query","card_name"],"msg":"Field required","input":null}]}';
const und0930 = { ...base({ resource: "https://oracle.the-undesirables.com/api/v1/grade-or-not", payTo: "0x642e8a7C289381f24f0395e0539f0bA41c74Cc1B", amountAtomic: "100000", at: "2026-09-30T12:32:27.708Z", response: resp(422, UND_BODY_0930), body: UND_BODY_0930 }), lane: "robinhood" };

test("rule 0's material is tracked (results/evm/declared-inputs.jsonl): names and sources only, and it reaches the 2026-09-30 records", () => {
  assert.equal(TRACKED.length, 10);
  for (const p of TRACKED) for (const v of [...(p.sentParams ?? []), ...(p.requiredParams ?? []), ...(p.declaredParams ?? [])]) assert.match(v, /^[A-Za-z_$][\w$.-]*$/, "names only, never values");
  const [q] = applyDeclaredPatches([byHost("quickintel")], TRACKED);
  assert.deepEqual(q!.requiredParams, ["chain", "tokenAddress"]);
  assert.deepEqual(q!.sentParams, []);
  assert.equal(classifyRecord(q!).rule, "input:missing_input:settled");
  const [u] = applyDeclaredPatches([und0930], TRACKED);
  assert.deepEqual(u!.requiredParams, ["card_name"]);
  assert.equal(classifyRecord(u!).cause, "vet402");
  // A record that keeps its own material is never overridden by a patch.
  const own = { ...byHost("quickintel"), requiredParams: ["x"], sentParams: ["x"] };
  assert.deepEqual(applyDeclaredPatches([own], TRACKED)[0]!.requiredParams, ["x"]);
  // The tracked file is not ignored by git.
  const gi = readFileSync(new URL("../.gitignore", import.meta.url), "utf8");
  assert.match(gi, /^!results\/evm\/declared-inputs\.jsonl$/m);
});

test("the lane's next plan reads the same material: on 2026-10-08 the-undesirables stays stopped (the same empty GET is not bought again)", () => {
  const lane = readFileSync(new URL("../scripts/evm-lane.ts", import.meta.url), "utf8");
  assert.match(lane, /return lastPaidByListing\(recordsRead\.rows\.filter/);
  const last = lastPaidByListing(applyDeclaredPatches([und0930], TRACKED)).get(und0930.resource)!;
  assert.equal(last.inputError, true);
  const oct8 = Date.parse("2026-10-08T03:00:00Z");
  assert.equal(holdAfter4xx(last, oct8), "input_unchanged_after_input_error");
  const dexterListing = { resource: und0930.resource, method: "GET" };
  const again = repairLaneRequest(dexterListing as never, { resource: und0930.resource, method: "GET", query: null, body: null }, "2026-10-08", last, oct8);
  assert.deepEqual(again, { ok: false, reason: "input_unchanged_after_input_error", param: null });
  // Without the material (the raw record, as before this fix) it would have been bought again on 10-08.
  const raw = lastPaidByListing([und0930]).get(und0930.resource)!;
  assert.equal(holdAfter4xx(raw, oct8), null);
  // loadLaneRecords applies the tracked file from a results directory.
  const dir = mkdtempSync(join(tmpdir(), "vet402-lane-records-"));
  try {
    writeFileSync(join(dir, "robinhood-purchases.jsonl"), JSON.stringify(und0930) + "\n");
    writeFileSync(join(dir, "declared-inputs.jsonl"), TRACKED.map((p) => JSON.stringify(p)).join("\n") + "\n");
    const rows = loadLaneRecords(["robinhood"], dir, ["purchases"]);
    assert.deepEqual(rows[0]!.requiredParams, ["card_name"]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("evm-declare: a 402 header that does not decode does not hide the body's declaration", () => {
  const src = readFileSync(new URL("../scripts/evm-declare.ts", import.meta.url), "utf8");
  assert.match(src, /try \{\s*if \(h\) docs\.push\(JSON\.parse\(Buffer\.from\(h, "base64"\)\.toString\("utf8"\)\)\);\s*\} catch/);
  assert.match(src, /results\/evm\/\$\{DECLARED_INPUTS_FILE\}/, "writes the tracked file");
});

test("chain check ranges: one range per run of purchases; a lane that buys again weeks later is not read over every block in between", () => {
  const sent = (at: string, outcome = "sent") => ({ agentId: "a", resource: `https://s.test/${at}`, method: "GET", at, outcome }) as unknown as ChainBuyRecord;
  const r = readRanges([sent("2026-09-30T12:00:00.000Z"), sent("2026-09-30T12:40:00.000Z"), sent("2026-09-30T08:00:00.000Z"), sent("2026-10-20T01:00:00.000Z"), sent("2026-10-21T00:00:00.000Z", "refused")]);
  assert.equal(r.length, 3, JSON.stringify(r));
  assert.deepEqual(r.map((x) => new Date(x.fromMs).toISOString()), ["2026-09-30T08:00:00.000Z", "2026-09-30T12:00:00.000Z", "2026-10-20T01:00:00.000Z"]);
  assert.ok(r[1]!.toMs > Date.parse("2026-09-30T12:40:00.000Z"), "two purchases 40 minutes apart are one range");
  assert.ok(r.every((x) => x.toMs - x.fromMs < 3 * 3_600_000), "no range spans the weeks between");
  assert.deepEqual(readRanges([sent("2026-09-30T12:00:00.000Z", "refused")]), []);
});


// ---------- review of b9e9f14 ----------

/** CDP api.exa.ai/search, Dexter's metadata of the same, CDP wiki.use.x402atlas.com/summary, PayAI api.delx.ai (2026-10-02, input parts). */
const EXA_CDP = { resource: "https://api.exa.ai/search", extensions: { bazaar: { info: { input: { body: { numResults: 10, query: "example search query", type: "auto" }, bodyType: "json", method: "POST", type: "http" } }, schema: { properties: { input: { additionalProperties: false, properties: { body: { properties: { contents: { description: "Content fields to include: text, highlights, summary", type: "object" }, numResults: { description: "Number of results to return (max 10 for x402)", type: "number" }, query: { description: "Search query", type: "string" }, type: { description: "Search type: auto, keyword, neural, deep-lite, deep, deep-reasoning", type: "string" } }, required: ["query"], type: "object" }, bodyType: { type: "string" }, method: { type: "string" }, type: { type: "string" } }, type: "object" } } } } } };
const EXA_DEXTER = { resource: "https://api.exa.ai/search", metadata: { input: { body: { type: "auto", query: "example search query", numResults: 10 }, type: "http", method: "POST", bodyType: "json" } } };
const ATLAS = { resource: "https://wiki.use.x402atlas.com/summary", extensions: { bazaar: { info: { input: { method: "GET", queryParams: { redirect: "true", title: "Albert Einstein" }, type: "http" } }, schema: { properties: { input: { additionalProperties: false, properties: { method: { enum: ["GET"], type: "string" }, queryParams: { properties: { redirect: { default: "true", description: "Set to false to disable redirect following.", type: "string" }, title: { description: "Wikipedia article title (e.g. Albert Einstein).", maxLength: 300, type: "string" } }, required: ["title"], type: "object" }, type: { const: "http", type: "string" } }, type: "object" } } } } } };
const DELX = { resource: "https://api.delx.ai/api/v1/x402/usgs-quake-stub-parse", inputSchema: { body: { properties: { mag: 4.2, place: "10km N of X" } }, type: "http", method: "POST", bodyType: "json" } };

test("names stay names: an example map with type:\"auto\" is a map; a required title survives; twzrd stays []", () => {
  const exa = declarationFrom(EXA_CDP, "catalog");
  for (const n of ["query", "numResults", "type"]) assert.ok(exa.declared.includes(n), n);
  assert.deepEqual(exa.required, ["query"]);
  assert.deepEqual(declarationFrom(EXA_DEXTER, "catalog").declared.sort(), ["numResults", "query", "type"]);
  assert.deepEqual(declarationFrom(ATLAS, "catalog").required, ["title"]);
  assert.ok(declarationFrom(ATLAS, "catalog").declared.includes("title"));
  assert.deepEqual(declarationFrom(TWZRD, "catalog").declared, []);
  // A body whose parameter is literally named "properties" (USGS style), with values not schemas: the name stays.
  assert.deepEqual(declarationFrom(DELX, "catalog").declared, ["properties"]);
  // Schema structure is still not a name: the loyalspark schema part.
  assert.deepEqual(declarationFrom({ extensions: { bazaar: { schema: LOYALSPARK.extensions.bazaar.schema } } }, "catalog").declared, []);
  // type is a schema only with a JSON Schema type value.
  assert.deepEqual(declarationFrom({ inputSchema: { type: "object", properties: { format: { type: "string" }, items: { type: "array" } }, required: ["format"] } }, "c").required, ["format"]);
});

test("answers: a schema word is a missing name when the listing declares it; 'required parameter' never yields 'eter'", () => {
  assert.equal(answer400('"type" is required', ["query", "type"])?.kind, "missing_input");
  assert.equal(answer400('"title" is required', ["title"])?.kind, "missing_input");
  assert.equal(answer400('"type" is required'), null, "undeclared: not a name");
  for (const t of ["Missing required parameter: wallet", "Missing required param: wallet", "required parameter 'wallet' is missing"]) {
    assert.deepEqual(namesInSentence(t), ["wallet"], t);
    assert.equal(answer400(t, ["wallet"])?.kind, "missing_input", t);
  }
});

test("every line of the tracked results/evm/declared-inputs.jsonl parses", () => {
  const f = new URL("../results/evm/declared-inputs.jsonl", import.meta.url).pathname;
  const { rows, problems } = readJsonl<DeclaredPatch>(f);
  assert.deepEqual(problems, []);
  assert.ok(rows.length > 0);
});

test("a line that does not parse is skipped and reported with its file and line; the purchase whose material it held is withheld, never the seller's", () => {
  const dir = mkdtempSync(join(tmpdir(), "vet402-broken-lines-"));
  try {
    const qi = { ...byHost("quickintel"), lane: "arbitrum" };
    writeFileSync(join(dir, "arbitrum-purchases.jsonl"), JSON.stringify(qi) + "\n{not json\n");
    const good = TRACKED.find((p) => p.lane === "arbitrum" && p.resource.includes("quickintel"))!;
    // The patch line of quickintel is cut: its key fields can still be read.
    writeFileSync(join(dir, "declared-inputs.jsonl"), JSON.stringify(good).slice(0, -12) + "\n");
    const { rows, problems } = loadLaneRecordsChecked(["arbitrum"], dir, ["purchases"]);
    assert.deepEqual(problems.map((p) => [p.file.endsWith("arbitrum-purchases.jsonl") || p.file.endsWith("declared-inputs.jsonl"), p.line]), [[true, 2], [true, 1]]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.materialLost, true);
    // On the page: withheld (not settled_vet402_input read without its material, not the seller's settled_no_answer).
    const dry = { generatedAt: "2026-09-30T06:20:02Z", catalogs: {}, arbitrum: { payTosInCatalogs: 1, payTosWithLive402: 1, choices: [{ payTo: qi.payTo!, catalogListings: 1, hosts: ["x402.quickintel.io"], chosen: { resource: qi.resource, liveAmount: qi.amountAtomic! } }] } };
    const l = buildLanePublic2("arbitrum", dry, rows.map((r) => ({ ...r, cause: classifyRecord(r) })) as never);
    assert.equal(l.rows[0]!.status, "withheld");
    // A broken line whose purchase cannot be named: every 4xx purchase without material is withheld.
    writeFileSync(join(dir, "declared-inputs.jsonl"), "{broken\n");
    assert.equal(loadLaneRecordsChecked(["arbitrum"], dir, ["purchases"]).rows[0]!.materialLost, true);
  } finally {
    rmSync(dir, { recursive: true });
  }
  const pub = readFileSync(new URL("../scripts/evm-publish.ts", import.meta.url), "utf8");
  assert.match(pub, /process\.exitCode = 3;/);
  assert.match(pub, /console\.error\(`ALERT \$\{p\.file\}:\$\{p\.line\}: not JSON, skipped/);
});

test("the tracked file wins over a local one; a local patch is used only for purchases the tracked file does not have, never mixed", () => {
  const dir = mkdtempSync(join(tmpdir(), "vet402-patch-order-"));
  try {
    const k = { lane: "arbitrum", agentId: "payto:A", at: "2026-10-04T00:00:00Z", resource: "https://s.test/a" };
    const k2 = { ...k, agentId: "payto:B" };
    writeFileSync(join(dir, "declared-inputs.jsonl"), JSON.stringify({ ...k, requiredParams: ["x"] }) + "\n");
    writeFileSync(join(dir, "arbitrum-declared.jsonl"), [JSON.stringify({ ...k, requiredParams: ["y"], sentParams: ["z"] }), JSON.stringify({ ...k2, requiredParams: ["w"] })].join("\n") + "\n");
    const { patches } = readDeclaredPatches(["arbitrum"], dir);
    const a = patches.filter((p) => p.agentId === "payto:A");
    assert.equal(a.length, 1, "one source for purchase A");
    assert.deepEqual(a[0]!.requiredParams, ["x"]);
    assert.equal(a[0]!.sentParams, undefined, "the local sentParams is not mixed into the tracked patch");
    assert.deepEqual(patches.find((p) => p.agentId === "payto:B")!.requiredParams, ["w"]);
  } finally {
    rmSync(dir, { recursive: true });
  }
});


// ---------- review of 1a7c199 ----------

test("'x is missing' is a missing input only with quotes or after an input word; the seller's missing data is not", () => {
  for (const [t, d] of [["Data for this wallet is missing", ["wallet"]], ["Price history for the symbol is missing", ["symbol"]], ["Indexed history for this chain is missing", ["chain"]]] as [string, string[]][]) {
    assert.equal(answer400(t, d), null, t);
    const rec = { ...bazaar, settledOnChain: true, response: resp(400, t), body: t, declaredParams: d };
    assert.equal(classifyRecord(rec).cause, "seller_config", t);
    assert.equal(lastPaidByListing([rec]).get(bazaar.resource)!.inputError, false, `${t}: never stopped for good`);
  }
  for (const t of ["required parameter 'wallet' is missing", '"wallet" is missing', "parameter wallet is missing"]) {
    assert.deepEqual(namesInSentence(t), ["wallet"], t);
    assert.equal(answer400(t, ["wallet"])?.kind, "missing_input", t);
  }
});

/** PayAI data.intel.rallylive.ca/mcp/tools/weather_now_toronto (2026-10-02): an MCP tool description as inputSchema. */
const MCP_LISTING = { resource: "https://data.intel.rallylive.ca/mcp/tools/weather_now_toronto", inputSchema: { type: "mcp", example: { query: "now" }, toolName: "weather_now_toronto", transport: "streamable-http", description: "Current weather in Toronto right now.", inputSchema: { type: "object", required: ["query"], properties: { query: { type: "string", description: "Ignored (fixed city); send 'now'" } } } } };

test("an MCP tool description and a nested http description are read as descriptions: type, toolName, description, example, method are never names", () => {
  const d = declarationFrom(MCP_LISTING, "catalog");
  assert.deepEqual(d.declared, ["query"]);
  assert.deepEqual(d.required, ["query"]);
  const nested = { resource: "https://s.test/x", extensions: { bazaar: { info: { input: { type: "http", method: "GET", queryParams: { type: "http", method: "GET", queryParams: { city: "Paris" } } } } } } };
  assert.deepEqual(declarationFrom(nested, "catalog").declared, ["city"]);
  // A JSON-RPC body whose parameter is named method stays a map (no type http/mcp).
  assert.deepEqual(declarationFrom({ resource: "https://s.test/rpc", extensions: { bazaar: { info: { input: { type: "http", method: "POST", body: { id: 1, method: "eth_blockNumber", params: [], jsonrpc: "2.0" } } } } } }, "catalog").declared.sort(), ["id", "jsonrpc", "method", "params"]);
});

test("--pay stops before any purchase when a line of the lane's records does not parse (exit 4, ALERT with file and line); nothing is read or bought", () => {
  assert.match(payStopForUnreadableLines([{ file: "results/evm/robinhood-purchases.jsonl", line: 2, error: "x" }])!, /^ALERT results\/evm\/robinhood-purchases\.jsonl:2: not JSON/);
  assert.equal(payStopForUnreadableLines([]), null);
  // The real script, in a copy of results with one broken line. The key directory is empty: if the stop did not
  // happen first, the script could not even read the payer's address, let alone sign (no money can move here).
  const dir = mkdtempSync(join(tmpdir(), "vet402-pay-stop-"));
  const keys = mkdtempSync(join(tmpdir(), "vet402-no-keys-"));
  try {
    mkdirSync(join(dir, "results", "evm"), { recursive: true });
    writeFileSync(join(dir, "results", "evm", "robinhood-purchases.jsonl"), JSON.stringify(und0930) + "\n{broken\n");
    // A ledger that holds the purchases (the ledger check passes), so the unreadable line is what stops the run.
    writeFileSync(join(dir, "results", "evm", "robinhood-ledger.json"), JSON.stringify({ baselineAtomic: null, spentAtomic: "0", purchases: [{ key: "a", amount: "0", at: "x" }, { key: "b", amount: "0", at: "x" }] }));
    const script = new URL("../scripts/evm-lane.ts", import.meta.url).pathname;
    const tsx = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
    // --pay reads its records where its ledger is (src/evm/run-dir.ts); here the copy, named explicitly.
    const results = join(dir, "results", "evm");
    const r = spawnSync(tsx, [script, "--lane", "robinhood", "--pay"], { cwd: dir, encoding: "utf8", env: { ...process.env, VET402_EVM_PAY: "robinhood", EVM_KEY_DIR: keys, VET402_EVM_RESULTS_DIR: results }, timeout: 60_000 });
    assert.equal(r.status, 4, r.stderr);
    assert.ok(r.stderr.includes(`ALERT ${join(results, "robinhood-purchases.jsonl")}:2: not JSON`), r.stderr);
    assert.match(r.stderr, /--pay stops before any purchase/);
    assert.doesNotMatch(r.stderr + r.stdout, /\[pay\] lane |evm\.pub|catalog /, "stopped before the key, the catalogs and the preflight ([pay] lane ...)");
  } finally {
    rmSync(dir, { recursive: true });
    rmSync(keys, { recursive: true });
  }
  // The stop is before the payer's address, the catalogs and every purchase in the script; a dry run goes on with a warning.
  const src = readFileSync(new URL("../scripts/evm-lane.ts", import.meta.url), "utf8");
  assert.ok(src.indexOf("process.exit(4)") < src.indexOf("const payer: Address = readPublicAddress();"));
  assert.ok(src.indexOf("process.exit(4)") < src.indexOf("await catalogs()"));
  assert.match(src, /a paying run would stop here \(dry run goes on\)/);
});

test("evm-publish exit 3: the daily run says what happened (wrote the page, N withheld, which lines), and does not HALT", () => {
  const pub = readFileSync(new URL("../scripts/evm-publish.ts", import.meta.url), "utf8");
  assert.match(pub, /wrote \$\{dataDir\}\/evm\/\$\{lane\}\.json with \$\{lost\} purchase\(s\) withheld\$\{unnamed\}: unreadable line\(s\) in \$\{where\}/);
  const sh = readFileSync(new URL("../scripts/daily/run.sh", import.meta.url), "utf8");
  assert.match(sh, /if \[ "\$rc" -eq 3 \]; then\n\s+# The page is written; some line of the lane's records did not parse/);
  assert.match(sh, /notice "EVM lane page: \$\(cat "\$REPO\/results\/evm\/\$lane-publish-alert\.txt"/);
});


// ---------- review of 2292a17: a misreading costs at most a small purchase every 30 days ----------

test("no stop is for good: vet402's own 4xx on a listing that declares parameters holds on day 29 and lifts on day 30; the seller's, 7 days", () => {
  assert.equal(INPUT_4XX_RETRY_MS, 30 * 86_400_000);
  const body = '"address" is required';
  const rec = { ...bazaar, settledOnChain: true, response: resp(400, body), body, declaredParams: ["address"] };
  const last = lastPaidByListing([rec]).get(bazaar.resource)!;
  assert.equal(last.inputError, true);
  const t0 = Date.parse(bazaar.at);
  assert.equal(holdAfter4xx(last, t0 + 29 * 86_400_000), "input_unchanged_after_input_error", "day 29: held");
  assert.equal(holdAfter4xx(last, t0 + 30 * 86_400_000), null, "day 30: the same request is bought once more");
  // The request itself: the same unchanged request is refused on day 29 and bought on day 30.
  const listing = { resource: bazaar.resource, method: "GET" };
  const req = { resource: bazaar.resource, method: "GET" as const, query: null, body: null };
  assert.equal(repairLaneRequest(listing as never, req, "2026-10-29", last, t0 + 29 * 86_400_000).ok, false);
  assert.equal(repairLaneRequest(listing as never, req, "2026-10-30", last, t0 + 30 * 86_400_000).ok, true);
  // The seller's 4xx: 7 days, as before.
  const seller = lastPaidByListing([{ ...rec, body: "upstream data missing", response: resp(400, "upstream data missing") }]).get(bazaar.resource)!;
  assert.equal(holdAfter4xx(seller, t0 + SELLER_4XX_RETRY_MS), null);
});

/** CDP api.loopholetape.com/mcp#launches_since#launches_since (accepts eip155:4663), 2026-10-02: an MCP listing. */
const LOOPHOLE = { resource: "https://api.loopholetape.com/mcp#launches_since#launches_since", extensions: { bazaar: { info: { input: { type: "mcp", toolName: "launches_since", transport: "streamable-http", description: "New pump.fun memecoin launches since a cursor", example: { limit: 100, since: null }, inputSchema: { properties: { limit: { default: 100, type: "integer" }, min_p_grad: { default: 0, type: "number" }, no_avoid: { default: false, type: "boolean" }, since: { type: "number" } }, type: "object" } } }, schema: { properties: { input: { additionalProperties: false, properties: { description: { type: "string" }, example: { type: "object" }, inputSchema: { type: "object" }, toolName: { type: "string" }, transport: { enum: ["streamable-http", "sse"], type: "string" }, type: { const: "mcp", type: "string" } }, required: ["type", "toolName", "inputSchema"], type: "object" } } } } } };
/** CDP x402.freeq.one/tools/token_price, 2026-10-02: an http description schema with toolName, transport, description, mcpServerUrl. */
const FREEQ = { resource: "https://x402.freeq.one/tools/token_price", extensions: { bazaar: { schema: { properties: { input: { additionalProperties: false, properties: { body: { description: "JSON request body. See GET /tools for the parameter catalog.", properties: { symbol: { description: "Token symbol, e.g. ETH", example: "ETH", type: "string" } }, type: "object" }, bodyType: { enum: ["json", "form-data", "text"], type: "string" }, description: { type: "string" }, headers: { additionalProperties: { type: "string" }, type: "object" }, mcpServerUrl: { type: "string" }, method: { enum: ["POST"], type: "string" }, queryParams: { additionalProperties: { type: "string" }, type: "object" }, toolName: { type: "string" }, transport: { type: "string" }, type: { const: "http", type: "string" } }, required: ["type", "method", "bodyType", "body"], type: "object" } } } } } };

test("a schema of an input description (type fixed to http or mcp) names nothing itself: loopholetape, freeq", () => {
  const lt = declarationFrom(LOOPHOLE, "catalog");
  assert.deepEqual(lt.required, [], "toolName and inputSchema are not required parameters");
  assert.deepEqual(lt.declared.sort(), ["limit", "min_p_grad", "no_avoid", "since"]);
  const fq = declarationFrom(FREEQ, "catalog");
  assert.deepEqual(fq.declared, ["symbol"]);
  for (const w of ["toolName", "transport", "description", "mcpServerUrl", "body", "type", "method"]) assert.ok(!fq.declared.includes(w) && !fq.required.includes(w), w);
  // Nested in a part, with type as an enum.
  const nested = { extensions: { bazaar: { schema: { properties: { input: { type: "object", properties: { type: { enum: ["http"] }, method: { enum: ["GET"] }, queryParams: { type: "object", properties: { type: { enum: ["http"] }, queryParams: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } } } } } } } } };
  assert.deepEqual(declarationFrom(nested, "catalog").required, ["city"]);
});

test("content words: the seller's missing data stays the seller's even with the name declared; the input forms are vet402's", () => {
  for (const t of ["Missing data for wallet", "missing wallet data", "Missing wallet history", "Missing chain support", "missing address balance", "Missing data for address 0xabc", "Data for 'wallet' is missing", "The wallet is required to have at least one transaction"]) {
    assert.equal(answer400(t, ["wallet", "address", "chain"]), null, t);
  }
  for (const [t, d] of [["The wallet parameter is missing", ["wallet"]], ["wallet parameter is missing", ["wallet"]], ["Parameters wallet and symbol are missing", ["wallet", "symbol"]], ["Key wallet is missing", ["wallet"]], ["Missing value for wallet", ["wallet"]]] as [string, string[]][]) {
    assert.equal(answer400(t, d)?.kind, "missing_input", t);
  }
  assert.deepEqual(namesInSentence("Missing value for wallet"), ["wallet"], "value is not a name when 'for x' follows");
});

test("a purchase whose every line is unreadable is withheld and counted, never 'not bought yet'; a line naming nothing is counted apart", () => {
  const dir = mkdtempSync(join(tmpdir(), "vet402-all-lines-broken-"));
  try {
    const qi = { ...byHost("quickintel"), lane: "arbitrum" };
    const cut = JSON.stringify(qi).slice(0, -40);
    writeFileSync(join(dir, "arbitrum-purchases.jsonl"), cut + "\n");
    writeFileSync(join(dir, "arbitrum-chaincheck.jsonl"), cut + "\n{x\n");
    const got = loadLaneRecordsChecked(["arbitrum"], dir);
    assert.equal(got.rows.length, 1);
    assert.equal(got.rows[0]!.materialLost, true);
    assert.equal(got.unnamedLines, 1, "the {x line names no purchase");
    assert.deepEqual(uncheckedPurchases(got.rows), [], "a withheld placeholder does not ask for a chain check");
    const dry = { generatedAt: "2026-09-30T06:20:02Z", catalogs: {}, arbitrum: { payTosInCatalogs: 1, payTosWithLive402: 1, choices: [{ payTo: qi.payTo!, catalogListings: 1, hosts: ["x402.quickintel.io"], chosen: { resource: qi.resource, liveAmount: qi.amountAtomic! } }] } };
    const l = buildLanePublic2("arbitrum", dry, got.rows.map((r) => ({ ...r, cause: classifyRecord(r) })) as never);
    assert.equal(l.rows[0]!.status, "withheld");
  } finally {
    rmSync(dir, { recursive: true });
  }
});


// ---------- review of 9449a11 ----------

test("validator texts name the input even with a content word in them; the seller's missing content stays the seller's", () => {
  for (const [t, d] of [["data must have required property 'wallet'", ["wallet"]], ["data/body must have required property 'wallet'", ["wallet"]], ["Invalid request data: wallet is required", ["wallet"]], ["price is required", ["price"]], ["quote is required", ["quote"]], ['"history" is required', ["history"]], ["Missing required field: wallet (wallet address for balance lookup)", ["wallet"]]] as [string, string[]][]) {
    assert.equal(answer400(t, d)?.kind, "missing_input", t);
  }
  for (const t of ["Missing data for wallet", "missing wallet data", "Missing wallet history", "Missing chain support", "missing address balance", "Missing data for address 0xabc", "Data for 'wallet' is missing", "The wallet is required to have at least one transaction"]) {
    assert.equal(answer400(t, ["wallet", "address", "chain"]), null, t);
  }
  assert.deepEqual(strongNamesInSentence("Data for 'wallet' is missing"), [], "after 'for', the quoted name only says whose data");
  assert.deepEqual(strongNamesInSentence("The wallet is required to have at least one transaction"), [], "'required to' is a condition, not a missing input");
});

test("a last answer with no readable time is never a hold without end: not held, and said", () => {
  const said: string[] = [];
  for (const at of [null, "not a date"]) {
    assert.equal(holdAfter4xx({ status: 400, requestKey: null, at, inputError: true, declaredCount: 1 }, Date.now(), (x) => said.push(x)), null);
    assert.equal(holdAfter4xx({ status: 404, requestKey: null, at, inputError: false }, Date.now(), (x) => said.push(x)), null);
  }
  assert.equal(said.length, 4);
  assert.match(said[0]!, /^ALERT holdAfter4xx: the last answer \(400\) has no readable time \(null\); not held$/);
});


// ---------- review of 32f98e0 ----------

test("Rails, marshmallow, webargs, DRF, and '<input word> for x', 'x is required to <verb>': vet402's when declared; the seller's content stays the seller's", () => {
  for (const [t, d] of [
    ["Value for 'wallet' is missing", ["wallet"]],
    ["Missing required parameter for 'wallet'", ["wallet"]],
    ["'wallet' is required to proceed", ["wallet"]],
    ['"address" is required to continue', ["address"]],
    ["wallet is required to be a 0x address", ["wallet"]],
    ["Missing a value for symbol", ["symbol"]],
    ["param is missing or the value is empty: wallet", ["wallet"]],
    ['{"wallet":["Missing data for required field."]}', ["wallet"]],
    ['{"wallet":["This field is required."]}', ["wallet"]],
  ] as [string, string[]][]) {
    assert.equal(answer400(t, d)?.kind, "missing_input", t);
  }
  // ("contain funds" alone is a doubtful phrase since d02bbaa's review: vet402's; "contain at least ... funds" is the seller's.)
  for (const t of ["Data for 'wallet' is missing", "The wallet is required to have at least one transaction", "The wallet is required to contain at least 10 funds", "The pool is required to hold 100 USDC"]) { // ("hold liquidity" has no asset noun: vet402's since 99344e5's review)
    assert.equal(answer400(t, ["wallet", "pool"]), null, t);
  }
  // A field message whose key is the request itself, or a message with no key, names nothing.
  assert.equal(answer400('{"non_field_errors":["This field is required."]}'), null);
  assert.equal(answer400('{"error":"Required"}'), null);
});


// ---------- review of 38edafe ----------

test("'x is required to <verb>' is an input only for proceed, continue, be a/an, be provided; a field message under headers is the seller's", () => {
  for (const t of ["The wallet is required to own at least one NFT", "The address is required to be on the allowlist", "wallet is required to be whitelisted", "The wallet is required to stake"]) {
    assert.equal(answer400(t, ["wallet", "address"]), null, t);
  }
  for (const [t, d] of [["'wallet' is required to proceed", ["wallet"]], ['"address" is required to continue', ["address"]], ["wallet is required to be a 0x address", ["wallet"]], ["wallet is required to be a valid address", ["wallet"]], ["wallet is required to be provided", ["wallet"]]] as [string, string[]][]) {
    assert.equal(answer400(t, d)?.kind, "missing_input", t);
  }
  assert.equal(answer400('{"headers":{"wallet":["Missing data for required field."]}}', ["wallet"]), null);
  assert.equal(answer400('{"wallet":["Missing data for required field."]}', ["wallet"])?.kind, "missing_input");
});

test("no control character other than tab, newline and carriage return in src, scripts and test", () => {
  const bad: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      if (e === "node_modules") continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(readFileSync(p, "utf8"))) bad.push(p);
    }
  };
  for (const d of ["src", "scripts", "test"]) walk(new URL(`../${d}`, import.meta.url).pathname);
  assert.deepEqual(bad, []);
});


// ---------- review of 959121c (the verb rule turned the right way) ----------

test("'x is required to <verb>' is the seller's only for a condition on content; every other verb reads x as the input, and a settled purchase is never shown as the seller's failure", () => {
  const ten = ["wallet is required to check the balance", "'address' is required to access this resource", "The 'symbol' field is required to get a quote", "wallet is required to query balances", "wallet is required to fetch data", "wallet is required to look up the price", "wallet is required to use this endpoint", "wallet is required to perform a search", "wallet is required to scrape", "wallet is required to complete the request"];
  for (const t of ten) {
    const name = (/(wallet|address|symbol)/.exec(t) ?? [])[1]!;
    for (const declared of [undefined, [name]]) {
      assert.equal(answer400(t, declared)?.kind, "missing_input", `${t} (declared ${declared ?? "none"})`);
      const rec = { ...bazaar, settledOnChain: true, response: resp(400, t), body: t, ...(declared ? { declaredParams: declared } : {}) };
      const cause = classifyRecord(rec);
      assert.equal(cause.rule, "input:missing_input:settled", t);
      const status = statusOf({ ...rec, cause } as never);
      assert.equal(status, "settled_vet402_input", t);
      assert.notEqual(status, "settled_no_answer");
    }
  }
  for (const t of ["The wallet is required to own at least one NFT", "The address is required to be on the allowlist", "wallet is required to be whitelisted", "The wallet is required to stake", "wallet is required to hold 100 USDC"]) {
    assert.equal(answer400(t, ["wallet", "address"]), null, t);
  }
});

test("a sentence all in capitals is read without case; a quoted ALL_CAPS name stays a setting name", () => {
  assert.equal(answer400("WALLET IS REQUIRED TO PROCEED", ["wallet"])?.kind, "missing_input");
  assert.equal(answer400("WALLET IS REQUIRED TO PROCEED")?.kind, "missing_input");
  assert.equal(answer400("MISSING REQUIRED FIELD: WALLET", ["wallet"])?.kind, "missing_input");
  assert.equal(answer400('"DB_HOST" IS REQUIRED'), null);
  assert.equal(answer400("Missing required field: DB_HOST"), null, "mixed case: an ALL_CAPS name is a setting name, as before");
});


// ---------- review of d02bbaa: a doubtful phrase falls on vet402's side ----------

test("'x is required to <phrase>' is the seller's only for the listed content conditions; every doubtful phrase is vet402's, and settled it is never a failure", () => {
  const vet = ["have access to this endpoint", "have been provided", "have a valid format", "have 0x prefix", "contain 42 characters", "be verified before calling", "be registered as a query parameter", "be active", "be eligible",
    "check the balance", "access this resource", "get a quote", "query balances", "fetch data", "look up the price", "use this endpoint", "perform a search", "scrape", "complete the request"];
  for (const phrase of vet) {
    const t = `wallet is required to ${phrase}`;
    for (const declared of [undefined, ["wallet"]]) {
      assert.equal(answer400(t, declared)?.kind, "missing_input", `${t} (declared ${declared ?? "none"})`);
      const rec = { ...bazaar, settledOnChain: true, response: resp(400, t), body: t, ...(declared ? { declaredParams: declared } : {}) };
      const cause = classifyRecord(rec);
      assert.equal(statusOf({ ...rec, cause } as never), "settled_vet402_input", t);
    }
  }
  const seller = ["own at least one NFT", "be on the allowlist", "be whitelisted", "stake", "hold 100 USDC", "hold at least 1 token", "have at least one transaction", "have a sufficient balance", "contain at least 1 token"];
  for (const phrase of seller) {
    const t = `wallet is required to ${phrase}`;
    assert.equal(answer400(t, ["wallet"]), null, t);
    assert.equal(answer400(t), null, `${t} (no declarations)`);
  }
});


// ---------- review of 99344e5: a seller-side phrase needs an asset noun ----------

test("'required to' phrases: the seller's only with an asset noun; settled, the seller's is a negative settled_no_answer and vet402's never is (statusOf, isNegative)", () => {
  const vet = ["have at least one query parameter", "have at least one of the following parameters", "have at least 1 character", "own the request", "hold the request", "have at least 3 characters", "have at least one letter"];
  const sentences = [...vet.map((p) => `wallet is required to ${p}`), "query is required to have at least 3 characters", "symbol is required to have at least one letter"];
  for (const t of [...sentences, ...sentences.map((x) => x.toUpperCase())]) {
    const name = (/(wallet|query|symbol)/i.exec(t) ?? [])[1]!.toLowerCase();
    const rec = { ...bazaar, settledOnChain: true, response: resp(400, t), body: t, declaredParams: [name] };
    assert.equal(answer400(t, [name])?.kind, "missing_input", t);
    const cause = classifyRecord(rec);
    const status = statusOf({ ...rec, cause } as never);
    assert.equal(status, "settled_vet402_input", t);
    assert.equal(isNegative(status, cause), false, t);
  }
  const seller = ["own at least one NFT", "hold 100 USDC", "hold at least 1 token", "stake", "stake 100 tokens", "have at least one transaction", "have a sufficient balance", "contain at least 1 token", "be whitelisted", "be on the allowlist"];
  for (const t of [...seller.map((p) => `wallet is required to ${p}`), ...seller.map((p) => `WALLET IS REQUIRED TO ${p.toUpperCase()}`)]) {
    const rec = { ...bazaar, settledOnChain: true, response: resp(400, t), body: t, declaredParams: ["wallet"] };
    assert.equal(answer400(t, ["wallet"]), null, t);
    const cause = classifyRecord(rec);
    assert.equal(cause.cause, "seller_config", t);
    const status = statusOf({ ...rec, cause } as never);
    assert.equal(status, "settled_no_answer", t);
    assert.equal(isNegative(status, cause), true, t);
  }
});


// ---------- review of 638d1e8: an asset noun counts only where it ends the phrase ----------

test("an asset noun followed by another noun (token address, share link, eth-address) is an input; settled, never a failure; the seller's content stays negative", () => {
  const vet = ["have at least one token address", "own at least one token parameter", "have at least one share link", "have at least one coin symbol", "have at least one transaction hash", "have at least one ETH address", "have at least one eth-address", "have at least one SOL address", "have at least one fund id", "hold a token address", "contain at least one token address", "own at least one NFT contract address", "have at least one token standard", "own a coin type", "be a SOL-compatible value", "hold liquidity", "hold USDC", "hold"];
  for (const p of vet) {
    const t = `wallet is required to ${p}`;
    const rec = { ...bazaar, settledOnChain: true, response: resp(400, t), body: t, declaredParams: ["wallet"] };
    assert.equal(answer400(t, ["wallet"])?.kind, "missing_input", t);
    const cause = classifyRecord(rec);
    const status = statusOf({ ...rec, cause } as never);
    assert.equal(status, "settled_vet402_input", t);
    assert.equal(isNegative(status, cause), false, t);
  }
  const seller = ["own at least one NFT", "hold 100 USDC", "hold at least 1 token", "stake", "stake 100 tokens", "have at least one transaction", "have a sufficient balance", "contain at least 1 token", "be whitelisted", "be on the allowlist", "hold 5 ETH in the wallet", "have at least one transaction, then retry", "own at least 2 NFTs and 1 token"];
  for (const p of seller) {
    const t = `wallet is required to ${p}`;
    const rec = { ...bazaar, settledOnChain: true, response: resp(400, t), body: t, declaredParams: ["wallet"] };
    assert.equal(answer400(t, ["wallet"]), null, t);
    const cause = classifyRecord(rec);
    const status = statusOf({ ...rec, cause } as never);
    assert.equal(status, "settled_no_answer", t);
    assert.equal(isNegative(status, cause), true, t);
  }
});
