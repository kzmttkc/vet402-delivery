/**
 * 3.11 Polygon and Monad purchase lanes, with the 3.11.0 Monad verdict FAIL.
 * No real key, no payment, no --pay: dry runs, pure functions, and throwaway keys that never leave the process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { getAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { EVM_CHAINS, LANES, RUN_LANES, chainByCaip2, fundingProblem, fundingRegistryGate, payGateProblem } from "../src/evm/chains.js";
import { MONAD_311_STATUS, monadPurchaseBlockedReason } from "../src/evm/311-memo.js";
import { evmOutflowExceedsLedger } from "../src/evm/evm-ledger-guard.js";
import {
  evmSharesTempoPayer,
  independentReviewShipProblem,
  legalCheckMemoProblem,
  legalCheckMemoProblemWithCanonical,
  monadFundingGateProblem,
  ownerPayApprovalProblem,
  parsePolygonOwnerApproval,
  polygonPayGateProblem,
  publicChainCountClaimProblem,
  sharedPayerOutflowStop,
} from "../src/evm/evm-pay-gates.js";
import { assertPublicPagesChainCounts, chainCountClaimsInCopy, publishedEvmPurchaseChains, validatePublicPurchaseChainClaim } from "../src/evm/published-purchase-chains.js";
import { depositRequestCopyProblem } from "../src/evm/funding-request-gate.js";
import { firstPurchaseAnnounceFromLedgerProblem, firstPurchaseAnnounceProblem } from "../src/evm/first-purchase-announce.js";
import {
  evmSharedPayerLedgerCommitted,
  laneLedgerCommitted,
  polygonLogsRpc,
  polygonOutflowScanner,
  POLYGON_LOG_SPAN,
  POLYGON_OUTFLOW_START_BLOCK,
} from "../src/evm/evm-shared-payer-outflow.js";
import {
  resolveSharedEvmTempoStop,
  sharedEvmSignBlockedByTempo,
  tempoStoppedReasonFromJson,
} from "../src/evm/tempo-evm-payer-stop.js";
import { dayRoot, recordDigest } from "../src/evm/evm-anchor.js";
import { ROOTS_LANES } from "../src/evm/roots.js";
import {
  measurePolygonPolSpend,
  polLedgerEntriesFromFile,
  polygonDailyRootProblem,
  polygonPolSpendProblem,
  POLYGON_PAYER_START_NONCE,
  type PolSpendReader,
  type PolTxReading,
} from "../src/evm/polygon-anchor.js";
import { buyOneOnChain, checkChainAccept, createChainPayment, evmLaneStopsAfterRecord, type ChainBuyDeps, type ChainBuyEntry, type EvmAccept } from "../src/evm/evm-buy.js";
import { Budget } from "../src/guard.js";
import { HOSTS_RUN, pickHostEntries, type HostChoice } from "../src/evm/lane-hosts.js";
import { EXPECTED_ADDRESS } from "../src/evm/key.js";
import { PAYER_ADDRESS } from "../src/tempo/constants.js";

const PAYER = getAddress("0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51");
const SELLER = getAddress("0x50ab2018c06c6E4eAA9BA52057Eb55eD284912fc");
const POLYGON_USDC = getAddress("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359");
const MONAD_USDC = getAddress("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");

const polyAcc = (over: Partial<EvmAccept> = {}): EvmAccept => ({
  scheme: "exact",
  network: "eip155:137",
  amount: "5000",
  asset: POLYGON_USDC,
  payTo: SELLER,
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
  ...over,
});

const okApproval = { kind: "vet402-evm-polygon-owner-approval" as const, approvedTotalAtomic: "55000", approvedAt: "2026-11-10T00:00:00.000Z" };
const canonicalLegal = "legal ok for polygon 3.11 independent memo";
const canonicalShip = "SHIP polygon-evm-3.11\nscope eip155:137 trial host run";

test("3.11-1: Polygon eip155:137 is a purchase chain; eip155:1 and eip155:143 are not", () => {
  assert.equal(MONAD_311_STATUS, "FAIL");
  const poly = EVM_CHAINS.polygon;
  assert.equal(poly.caip2, "eip155:137");
  assert.equal(poly.asset, POLYGON_USDC);
  assert.equal(poly.domain.name, "USD Coin");
  assert.equal(chainByCaip2("eip155:137")?.key, "polygon");
  assert.equal(chainByCaip2("eip155:1"), null);
  assert.equal(chainByCaip2("eip155:143"), null);
  assert.equal(chainByCaip2("eip155:8453")?.key, "base");
  assert.ok(!("monad" in EVM_CHAINS));
  assert.ok(!("ethereum" in EVM_CHAINS));
  assert.ok(LANES.polygon);
  assert.equal(LANES.polygon.chain, "polygon");
  assert.deepEqual(RUN_LANES.polygon, ["polygon"]);
});

test("3.11-1: Monad purchase stays blocked while 3.11.0 is FAIL", () => {
  assert.match(monadPurchaseBlockedReason() ?? "", /FAIL/);
  assert.match(monadPurchaseBlockedReason() ?? "", /eip155:143/);
});

test("3.11-2: Polygon accept refuses price raise and Permit2 before any signature", () => {
  const spec = EVM_CHAINS.polygon;
  const ctx = { payer: PAYER, lockedPayTo: SELLER, lockedAmount: "5000", maxPerAtomic: 10_000n, minAtomic: 4_400n };
  assert.equal(checkChainAccept(spec, polyAcc(), ctx), null);
  assert.equal(checkChainAccept(spec, polyAcc({ amount: "6000" }), ctx)?.refused, "price_raised");
  assert.equal(checkChainAccept(spec, polyAcc({ extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" } }), ctx)?.refused, "not_eip3009");
  assert.equal(checkChainAccept(spec, polyAcc({ asset: MONAD_USDC }), ctx)?.refused, "asset_mismatch");
});

test("3.11-2: createChainPayment on Polygon is blocked in the copy stage (no EIP-3009)", async () => {
  const k = privateKeyToAccount(generatePrivateKey());
  const pr = { x402Version: 2, resource: { url: "https://seller.test/x" }, accepts: [polyAcc()] } as never;
  await assert.rejects(createChainPayment(EVM_CHAINS.polygon, k, pr, polyAcc({ payTo: SELLER }), 10_000n), /3\.11 pay gates/);
});

test("3.11-2: buyOneOnChain on Polygon dry-run would_pay without signing", async () => {
  const entry: ChainBuyEntry = {
    agentId: "host:test",
    resource: "https://test/x",
    method: "GET",
    query: null,
    body: null,
    lock: { payTo: SELLER, amount: "5000" },
  };
  const pr = { x402Version: 2, resource: { url: "https://test/x" }, accepts: [polyAcc()] };
  const fetch: typeof globalThis.fetch = async () =>
    new Response("", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(pr)).toString("base64") } });
  const budget = new Budget(null);
  const deps: ChainBuyDeps = {
    fetch,
    payer: PAYER,
    signer: kFromScratch(),
    budget,
    readAssetBalance: async () => 1_000_000n,
    verifySettlement: async () => ({ ok: true }),
    dryRun: true,
  };
  const r = await buyOneOnChain(EVM_CHAINS.polygon, entry, deps);
  assert.equal(r.outcome, "would_pay");
  assert.equal(r.authorization, undefined);
});

function kFromScratch() {
  const k = privateKeyToAccount(generatePrivateKey());
  return {
    address: k.address,
    signTypedData: (m: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }) =>
      k.signTypedData(m as never),
  };
}

test("3.11-2: buyOneOnChain refuses price_raised before signing", async () => {
  const entry: ChainBuyEntry = {
    agentId: "host:test",
    resource: "https://test/x",
    method: "GET",
    query: null,
    body: null,
    lock: { payTo: SELLER, amount: "5000" },
  };
  const live = polyAcc({ amount: "6000" });
  const pr = { x402Version: 2, resource: { url: "https://test/x" }, accepts: [live] };
  const fetch: typeof globalThis.fetch = async () =>
    new Response("", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(pr)).toString("base64") } });
  const deps: ChainBuyDeps = {
    fetch,
    payer: PAYER,
    signer: kFromScratch(),
    budget: new Budget(null),
    readAssetBalance: async () => 1_000_000n,
    verifySettlement: async () => ({ ok: true }),
    dryRun: true,
    minAtomic: 4_400n,
  };
  const r = await buyOneOnChain(EVM_CHAINS.polygon, entry, deps);
  assert.equal(r.outcome, "refused");
  assert.equal(r.refusal?.refused, "price_raised");
});

test("3.11-3: host run caps match Robinhood ceiling copy; cheapest hosts first", () => {
  assert.equal(HOSTS_RUN.maxTotalAtomic, 60_000n);
  assert.equal(LANES.polygon.maxTotalAtomic, 60_000n);
  assert.equal(LANES.polygon.maxCount, 10);
  const choices: HostChoice[] = [
    {
      host: "b.test",
      listings: 1,
      chosen: {
        resource: "https://b/x",
        method: "GET",
        payTo: SELLER,
        amount: "8000",
        liveAmount: "8000",
        raw402: "{}",
        listingResource: "https://b/x",
        inputDate: "2026-11-10",
        datedParams: [],
        declaredParams: [],
        declaration: { declared: [], required: [], from: [], requiredFrom: [] },
        query: null,
        body: null,
        simple: true,
      },
      tried: [],
    },
    {
      host: "a.test",
      listings: 1,
      chosen: {
        resource: "https://a/x",
        method: "GET",
        payTo: SELLER,
        amount: "5000",
        liveAmount: "5000",
        raw402: "{}",
        listingResource: "https://a/x",
        inputDate: "2026-11-10",
        datedParams: [],
        declaredParams: [],
        declaration: { declared: [], required: [], from: [], requiredFrom: [] },
        query: null,
        body: null,
        simple: true,
      },
      tried: [],
    },
  ];
  const r = pickHostEntries(choices, { maxTotalAtomic: HOSTS_RUN.maxTotalAtomic, maxCount: HOSTS_RUN.maxCount });
  assert.deepEqual(r.entries.map((e) => e.agentId), ["host:a.test", "host:b.test"]);
  assert.equal(r.totalAtomic, 13_000n);
});

test("3.11-3: owner approval is a record on disk, not env alone", () => {
  assert.equal(payGateProblem("polygon", "polygon"), null);
  assert.match(payGateProblem("polygon", undefined) ?? "", /polygon/);
  assert.match(ownerPayApprovalProblem(55_000n, null, {}) ?? "", /owner approval/i);
  assert.match(ownerPayApprovalProblem(55_000n, null, { VET402_EVM_OWNER_APPROVED_TOTAL: "55000" }) ?? "", /alone is not approval/i);
  assert.equal(ownerPayApprovalProblem(55_000n, okApproval, {}), null);
  assert.match(ownerPayApprovalProblem(55_000n, { ...okApproval, approvedTotalAtomic: "54000" }, {}) ?? "", /54000/);
});

test("3.11-3: Tempo and EVM share one payer; outflow stop applies to EVM signing", () => {
  assert.equal(PAYER_ADDRESS.toLowerCase(), EXPECTED_ADDRESS.toLowerCase());
  assert.equal(evmSharesTempoPayer(), true);
  assert.match(sharedPayerOutflowStop(1000n, 1001n) ?? "", /chain_spend_exceeds_ledger/);
  assert.equal(sharedPayerOutflowStop(1000n, 1000n), null);
});

test("3.11-3: buyOneOnChain honors shared payer outflow before signing", async () => {
  const entry: ChainBuyEntry = {
    agentId: "host:test",
    resource: "https://test/x",
    method: "GET",
    query: null,
    body: null,
    lock: { payTo: SELLER, amount: "5000" },
  };
  const pr = { x402Version: 2, resource: { url: "https://test/x" }, accepts: [polyAcc()] };
  const fetch: typeof globalThis.fetch = async () =>
    new Response("", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(pr)).toString("base64") } });
  const deps: ChainBuyDeps = {
    fetch,
    payer: PAYER,
    signer: kFromScratch(),
    budget: new Budget(null),
    readAssetBalance: async () => 1_000_000n,
    verifySettlement: async () => ({ ok: true }),
    dryRun: false,
    outflowCheck: { ledgerCommitted: 1000n, chainSpent: 1001n },
  };
  const r = await buyOneOnChain(EVM_CHAINS.polygon, entry, deps);
  assert.equal(r.outcome, "refused");
  assert.equal(r.refusal?.refused, "chain_spend_exceeds_ledger");
});

test("3.11-4: no funding request copy when eip155:137 is missing from the registry list", () => {
  assert.match(fundingRegistryGate("eip155:137", ["eip155:8453", "eip155:4663"]) ?? "", /137/);
  assert.equal(fundingRegistryGate("eip155:137", ["eip155:8453", "eip155:4663", "eip155:137"]), null);
  assert.match(monadFundingGateProblem("eip155:143", ["eip155:137", "eip155:143"]) ?? "", /FAIL/);
});

test("3.11-4: polygon pay gate enforces wallet registry before pay", () => {
  assert.match(
    polygonPayGateProblem({
      paying: true,
      plannedTotalAtomic: 10_000n,
      ownerApproval: okApproval,
      env: {},
      legalCheckMemo: canonicalLegal,
      reviewShip: canonicalShip,
      reviewShipCanonical: canonicalShip,
      legalCheckCanonical: canonicalLegal,
      registeredChains: ["eip155:8453"],
      ledgerCommitted: null,
      chainSpent: null,
    }) ?? "",
    /137/,
  );
});

const ALL_ADDED = ["eip155:4663", "eip155:137", "eip155:143", "eip155:42161"];

test("3.11-5: while Monad FAIL, 12 is refused even when every added chain were on the ledger; 11 (IG 10 + Robinhood) is refused", () => {
  assert.match(publicChainCountClaimProblem(12, ALL_ADDED) ?? "", /Monad 3\.11\.0 is FAIL/);
  assert.match(publicChainCountClaimProblem(11, ["eip155:4663"]) ?? "", /IG count stays 10 \(Robinhood is not added to it\)/);
  assert.match(publicChainCountClaimProblem(11, ["eip155:4663", "eip155:137"]) ?? "", /do not claim 11/);
  assert.match(publicChainCountClaimProblem(13, ALL_ADDED) ?? "", /product count is 12/);
  assert.equal(publicChainCountClaimProblem(10, []), null);
});

test("3.11-6: outflow above the lane ledger stops like Tempo chain_spend_exceeds_ledger", () => {
  assert.match(evmOutflowExceedsLedger(1000n, 1001n) ?? "", /chain_spend_exceeds_ledger/);
  assert.equal(evmOutflowExceedsLedger(1000n, 1000n), null);
});

test("3.11-6: polygon pay needs legal-check memo and independent SHIP", () => {
  assert.match(legalCheckMemoProblem(null) ?? "", /legal-check/);
  assert.match(independentReviewShipProblem("NO-SHIP", canonicalShip) ?? "", /SHIP/);
  assert.match(independentReviewShipProblem(canonicalShip, null) ?? "", /artifact on disk/);
  assert.match(independentReviewShipProblem("SHIP polygon\nx", canonicalShip) ?? "", /must match/);
  assert.equal(independentReviewShipProblem(canonicalShip, canonicalShip), null);
  assert.equal(
    polygonPayGateProblem({
      paying: true,
      plannedTotalAtomic: 55_000n,
      ownerApproval: okApproval,
      env: {},
      legalCheckMemo: canonicalLegal,
      reviewShip: canonicalShip,
      reviewShipCanonical: canonicalShip,
      legalCheckCanonical: canonicalLegal,
      registeredChains: ["eip155:137"],
      ledgerCommitted: 50_000n,
      chainSpent: 50_000n,
      polSpend: { ledgerWei: 0n, chainWei: 0n, offLedgerTxs: 0n },
      rootsLanes: ["polygon"],
    }),
    null,
  );
});

test("3.11-6: paying gate stops when on-chain outflow exceeds the Polygon lane ledger", () => {
  assert.match(
    polygonPayGateProblem({
      paying: true,
      plannedTotalAtomic: 10_000n,
      ownerApproval: okApproval,
      env: {},
      legalCheckMemo: canonicalLegal,
      reviewShip: canonicalShip,
      reviewShipCanonical: canonicalShip,
      legalCheckCanonical: canonicalLegal,
      registeredChains: ["eip155:137"],
      ledgerCommitted: 1000n,
      chainSpent: 1001n,
    }) ?? "",
    /chain_spend_exceeds_ledger/,
  );
});

const allPolygonGatesMet = {
  plannedTotalAtomic: 55_000n,
  ownerApproval: okApproval,
  env: {},
  legalCheckMemo: canonicalLegal,
  reviewShip: canonicalShip,
  reviewShipCanonical: canonicalShip,
  legalCheckCanonical: canonicalLegal,
  registeredChains: ["eip155:137"],
  ledgerCommitted: 5_000n,
  chainSpent: 5_000n,
  polSpend: { ledgerWei: 0n, chainWei: 0n, offLedgerTxs: 0n },
  paying: true,
};

test("3.11-6: Polygon daily-root fees are on the POL ledger; with every other gate met, no Polygon roots lane stops the paying run", () => {
  assert.equal(ROOTS_LANES.includes("polygon" as never), false, "Polygon is not a roots lane yet");
  assert.match(polygonDailyRootProblem() ?? "", /no daily-root path on Polygon/);
  assert.match(polygonPayGateProblem(allPolygonGatesMet) ?? "", /no daily-root path on Polygon: .*a root that can be checked/);
  const withRoots = { ...allPolygonGatesMet, rootsLanes: ["robinhood", "arbitrum", "polygon"] };
  // Once Polygon is a roots lane, that gate opens; the POL ledger gate still holds.
  assert.equal(polygonPayGateProblem(withRoots), null);
  assert.match(polygonPayGateProblem({ ...withRoots, polSpend: { ledgerWei: 0n, chainWei: 0n, offLedgerTxs: 1n } }) ?? "", /^chain_spend_exceeds_ledger: 1 Polygon transaction/);
  assert.match(polygonPayGateProblem({ ...withRoots, polSpend: { ledgerWei: 10n, chainWei: 11n, offLedgerTxs: 0n } }) ?? "", /^chain_spend_exceeds_ledger: Polygon POL outflow 11 wei > POL ledger 10 wei/);
  assert.match(polygonPayGateProblem({ ...withRoots, polSpend: null }) ?? "", /POL outflow from the payer was not measured/);
});

test("3.11-6: the payer pays the Polygon daily root, so a paying run needs POL for one anchor at Polygon's own fee cap", () => {
  const cap = EVM_CHAINS.polygon.anchorMaxFeeWei;
  assert.equal(cap, 120_000_000_000_000_000n);
  assert.notEqual(cap, EVM_CHAINS.robinhood.anchorMaxFeeWei, "the Robinhood cap is not Polygon's");
  assert.equal(EVM_CHAINS.polygon.nativeSymbol, "POL");
  assert.match(fundingProblem(LANES.polygon, 10_000n, 100_000n, 0n) ?? "", /^lane polygon: POL 0 wei < 120000000000000000 wei kept for the daily root on Polygon$/);
  assert.match(fundingProblem(LANES.polygon, 10_000n, 100_000n, cap - 1n) ?? "", /POL/);
  assert.equal(fundingProblem(LANES.polygon, 10_000n, 100_000n, cap), null);
  assert.match(fundingProblem(LANES.robinhood, 10_000n, 100_000n, 1n) ?? "", /ETH 1 wei/);
});

const H = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as const;
function polReader(nonce: bigint, mined: Record<string, PolTxReading>): PolSpendReader {
  return { nonce: async () => nonce, tx: async (h) => mined[h] ?? null };
}

test("3.11-6: POL that left the payer on Polygon is read from its nonce and receipts against the POL ledger", async () => {
  assert.equal(POLYGON_PAYER_START_NONCE, 0n);
  assert.deepEqual(polLedgerEntriesFromFile(null), []);
  assert.throws(() => polLedgerEntriesFromFile("{}"), /no entries/);
  assert.throws(() => polLedgerEntriesFromFile(JSON.stringify({ entries: [{ tx: "0x1", nonce: 0, boundWei: "1" }] })), /transaction hash/);
  const entry = { tx: H(1), nonce: 0, boundWei: "7200000000000000" };
  const fee = { from: PAYER, nonce: 0, feeWei: 4_800_000_000_000_000n, valueWei: 0n };
  // No Polygon transaction yet: nothing left, nothing on the ledger.
  assert.equal(polygonPolSpendProblem(await measurePolygonPolSpend(polReader(0n, {}), [], PAYER)), null);
  // A transaction the payer sent that is not on the ledger: its fee left outside it.
  const off = await measurePolygonPolSpend(polReader(1n, { [H(1)]: fee }), [], PAYER);
  assert.equal(off.offLedgerTxs, 1n);
  assert.match(polygonPolSpendProblem(off) ?? "", /^chain_spend_exceeds_ledger: 1 Polygon transaction/);
  // On the ledger, and within its bound.
  const on = await measurePolygonPolSpend(polReader(1n, { [H(1)]: fee }), [entry], PAYER);
  assert.deepEqual(on, { ledgerWei: 7_200_000_000_000_000n, chainWei: 4_800_000_000_000_000n, offLedgerTxs: 0n });
  assert.equal(polygonPolSpendProblem(on), null);
  // On the ledger, but the chain took more (a value sent with it) than the ledger holds.
  const over = await measurePolygonPolSpend(polReader(1n, { [H(1)]: { ...fee, valueWei: 3_000_000_000_000_000n } }), [entry], PAYER);
  assert.match(polygonPolSpendProblem(over) ?? "", /^chain_spend_exceeds_ledger: Polygon POL outflow 7800000000000000 wei > POL ledger 7200000000000000 wei/);
  // Written before it is signed and not mined yet: reserved, not a stop.
  assert.equal(polygonPolSpendProblem(await measurePolygonPolSpend(polReader(0n, {}), [entry], PAYER)), null);
  // The ledger's transaction was replaced by another at the same nonce: that one is off the ledger.
  assert.match(polygonPolSpendProblem(await measurePolygonPolSpend(polReader(1n, {}), [entry], PAYER)) ?? "", /not on the POL ledger/);
  await assert.rejects(measurePolygonPolSpend(polReader(1n, { [H(1)]: { ...fee, from: SELLER } }), [entry], PAYER), /not the payer's nonce 0/);
  await assert.rejects(measurePolygonPolSpend(polReader(2n, {}), [entry, { ...entry, tx: H(2) }], PAYER), /nonce 0 twice/);
});

test("3.11-6: a POL fee outside the ledger is chain_spend_exceeds_ledger and the paying Polygon lane stops before the next signature", async () => {
  const entry: ChainBuyEntry = { agentId: "host:test", resource: "https://test/x", method: "GET", query: null, body: null, lock: { payTo: SELLER, amount: "5000" } };
  const pr = { x402Version: 2, resource: { url: "https://test/x" }, accepts: [polyAcc()] };
  let paid = 0;
  let signed = 0;
  const fetch: typeof globalThis.fetch = async (_u, init) => {
    if (new Headers(init?.headers).has("payment-signature")) paid++;
    return new Response("", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(pr)).toString("base64") } });
  };
  const signer = { address: PAYER, signTypedData: async () => { signed++; throw new Error("signed"); } };
  // The payer has sent one Polygon transaction (a daily root), and the POL ledger is empty.
  const reader = polReader(1n, { [H(1)]: { from: PAYER, nonce: 0, feeWei: 4_800_000_000_000_000n, valueWei: 0n } });
  const rootsLanes = ["robinhood", "arbitrum", "polygon"];
  const beforeSign = async () => polygonPayGateProblem({ ...allPolygonGatesMet, rootsLanes, polSpend: await measurePolygonPolSpend(reader, [], PAYER) });
  const budget = new Budget(null);
  const rec = await buyOneOnChain(EVM_CHAINS.polygon, entry, {
    fetch,
    payer: PAYER,
    signer,
    budget,
    readAssetBalance: async () => 1_000_000n,
    verifySettlement: async () => ({ ok: true }),
    dryRun: false,
    outflowCheck: { ledgerCommitted: 5_000n, chainSpent: 5_000n },
    beforeSign,
  });
  assert.equal(rec.refusal?.refused, "chain_spend_exceeds_ledger");
  assert.match(rec.refusal?.detail ?? "", /not on the POL ledger/);
  assert.equal(evmLaneStopsAfterRecord(rec, true), true, "the lane signs nothing after it");
  assert.equal(signed, 0);
  assert.equal(paid, 0);
  assert.equal(budget.count, 0, "the reservation was released");
  // Control: the same fee on the ledger is not a stop.
  const onLedger = [{ tx: H(1), nonce: 0, boundWei: "7200000000000000" }];
  assert.equal(polygonPayGateProblem({ ...allPolygonGatesMet, rootsLanes, polSpend: await measurePolygonPolSpend(reader, onLedger, PAYER) }), null);
});

test("3.11-3: Tempo stop blocks shared payer EVM signing", () => {
  assert.equal(evmSharesTempoPayer(), true);
  assert.match(sharedEvmSignBlockedByTempo({ lastTempoStopReason: "not_settled" }) ?? "", /Tempo is stopped/);
  assert.match(sharedEvmSignBlockedByTempo({ haltPayBody: "not_settled from fixture" }) ?? "", /HALT-pay/);
  assert.match(
    polygonPayGateProblem({
      paying: true,
      plannedTotalAtomic: 10_000n,
      ownerApproval: okApproval,
      env: {},
      legalCheckMemo: canonicalLegal,
      reviewShip: canonicalShip,
      reviewShipCanonical: canonicalShip,
      legalCheckCanonical: canonicalLegal,
      registeredChains: ["eip155:137"],
      ledgerCommitted: 0n,
      chainSpent: 0n,
      lastTempoStopReason: "chain_spend_exceeds_ledger",
    }) ?? "",
    /Tempo/,
  );
});

test("3.11-4: deposit request copy uses monadFundingGateProblem for eip155:143", () => {
  assert.match(depositRequestCopyProblem("eip155:143", ["eip155:137", "eip155:143"], { need_deposit: true, generatedAt: new Date().toISOString() }, Date.now()) ?? "", /FAIL/);
  assert.match(depositRequestCopyProblem("eip155:137", ["eip155:8453"], { need_deposit: true, generatedAt: new Date().toISOString() }, Date.now()) ?? "", /137/);
});

test("3.11-2: buyOneOnChain refuses payTo mismatch before signing", async () => {
  const entry: ChainBuyEntry = {
    agentId: "host:test",
    resource: "https://test/x",
    method: "GET",
    query: null,
    body: null,
    lock: { payTo: SELLER, amount: "5000" },
  };
  const other = getAddress("0x1111111111111111111111111111111111111111");
  const pr = { x402Version: 2, resource: { url: "https://test/x" }, accepts: [polyAcc({ payTo: other })] };
  const fetch: typeof globalThis.fetch = async () =>
    new Response("", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(pr)).toString("base64") } });
  const r = await buyOneOnChain(EVM_CHAINS.polygon, entry, {
    fetch,
    payer: PAYER,
    signer: kFromScratch(),
    budget: new Budget(null),
    readAssetBalance: async () => 1_000_000n,
    verifySettlement: async () => ({ ok: true }),
    dryRun: true,
  });
  assert.equal(r.refusal?.refused, "payto_mismatch");
});

test("3.11-2: day root digests verify for a fixture purchase line", () => {
  const line = JSON.stringify({ at: "2026-11-09T12:00:00.000Z", outcome: "sent", host: "h", amount: "5000", delivered: true });
  const root = dayRoot(EVM_CHAINS.polygon, "2026-11-09", [line], "2026-11-10T12:00:00.000Z", (rec) => rec);
  assert.equal(root.n, 1);
  assert.equal(recordDigest(JSON.parse(line)), root.digests[0]);
});

test("3.11-6: paying lane run stops after chain_spend_exceeds_ledger", () => {
  assert.equal(evmLaneStopsAfterRecord({ refusal: { refused: "chain_spend_exceeds_ledger", detail: "x" } }, true), true);
  assert.equal(evmLaneStopsAfterRecord({ refusal: { refused: "chain_spend_exceeds_ledger", detail: "x" } }, false), false);
});

test("3.11-7: first-purchase announce blocked without published rows, for Monad FAIL, and for chains outside 3.11", () => {
  assert.match(firstPurchaseAnnounceProblem("eip155:137", 0) ?? "", /no published/);
  assert.match(firstPurchaseAnnounceProblem("eip155:143", 1) ?? "", /FAIL/);
  assert.match(firstPurchaseAnnounceProblem("eip155:1", 5) ?? "", /not a 3\.11 lane/);
  assert.equal(firstPurchaseAnnounceProblem("eip155:137", 3), null);
});

test("3.11-6: Polygon outflow is the sum of Transfer logs from the fixed start block, read in spans, each block once", async () => {
  assert.equal(evmSharedPayerLedgerCommitted("/nonexistent-empty-dir-311"), 0n);
  const dir = mkdtempSync(join(tmpdir(), "poly-ledger-"));
  writeFileSync(join(dir, "polygon-ledger.json"), JSON.stringify({ spentAtomic: "5000" }) + "\n");
  writeFileSync(join(dir, "robinhood-ledger.json"), JSON.stringify({ spentAtomic: "999999" }) + "\n");
  assert.equal(laneLedgerCommitted(dir, "polygon"), 5000n, "the Polygon ledger alone, not the sum of the EVM lanes");
  let head = POLYGON_OUTFLOW_START_BLOCK + 20_000n;
  const logs = [
    { block: POLYGON_OUTFLOW_START_BLOCK - 1n, amount: 7n }, // before the start: not this lane's
    { block: POLYGON_OUTFLOW_START_BLOCK, amount: 100n },
    { block: POLYGON_OUTFLOW_START_BLOCK + 15_000n, amount: 200n },
    { block: POLYGON_OUTFLOW_START_BLOCK + 25_000n, amount: 400n },
  ];
  const ranges: [bigint, bigint][] = [];
  const scan = polygonOutflowScanner({
    head: async () => head,
    outflow: async (from, to) => {
      ranges.push([from, to]);
      assert.ok(to - from + 1n <= POLYGON_LOG_SPAN, "each eth_getLogs range is under the RPC limit");
      return logs.filter((l) => l.block >= from && l.block <= to).reduce((n, l) => n + l.amount, 0n);
    },
  });
  assert.equal(await scan(), 300n);
  head += 10_000n;
  assert.equal(await scan(), 700n, "the next read adds only the new blocks");
  const seen = new Set<string>();
  for (const [a, b] of ranges) for (let x = a; x <= b; x += 1_000n) assert.ok(!seen.has(String(x)), "a block read twice"), seen.add(String(x));
  const failing = polygonOutflowScanner({ head: async () => head, outflow: async () => { throw new Error("rpc down"); } });
  await assert.rejects(failing(), /rpc down/);
  assert.equal(polygonLogsRpc({}), "https://polygon-bor-rpc.publicnode.com");
  assert.equal(polygonLogsRpc({ POLYGON_RPC_URL: "http://a" }), "http://a");
  assert.equal(polygonLogsRpc({ POLYGON_RPC_URL: "http://a", POLYGON_LOGS_RPC_URL: "http://b" }), "http://b");
});

test("3.11-6: a paying Polygon purchase without the outflow check, or with an unreadable one, is refused before signing and stops the lane", async () => {
  const entry: ChainBuyEntry = { agentId: "host:test", resource: "https://test/x", method: "GET", query: null, body: null, lock: { payTo: SELLER, amount: "5000" } };
  const pr = { x402Version: 2, resource: { url: "https://test/x" }, accepts: [polyAcc()] };
  let paid = 0;
  const fetch: typeof globalThis.fetch = async (_u, init) => {
    if (new Headers(init?.headers).has("payment-signature")) paid++;
    return new Response("", { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(pr)).toString("base64") } });
  };
  const base: ChainBuyDeps = { fetch, payer: PAYER, signer: kFromScratch(), budget: new Budget(null), readAssetBalance: async () => 1_000_000n, verifySettlement: async () => ({ ok: true }), dryRun: false, beforeSign: async () => null };
  const none = await buyOneOnChain(EVM_CHAINS.polygon, entry, base);
  assert.equal(none.refusal?.refused, "signing_blocked");
  assert.match(none.refusal?.detail ?? "", /outflow check/);
  const broken = await buyOneOnChain(EVM_CHAINS.polygon, entry, { ...base, outflowCheck: async () => { throw new Error("rpc down"); } });
  assert.equal(broken.refusal?.refused, "signing_blocked");
  assert.match(broken.refusal?.detail ?? "", /outflow unreadable: rpc down/);
  assert.equal(evmLaneStopsAfterRecord(broken, true), true);
  assert.equal(paid, 0);
});

test("3.11-4: deposit-request-gate script wires monadFundingGateProblem", () => {
  const script = readFileSync(new URL("../scripts/deposit-request-gate.ts", import.meta.url), "utf8");
  assert.match(script, /depositRequestCopyProblem/);
  assert.match(script, /monadFundingGateProblem|funding-request-gate/);
});

test("legalCheckMemoProblemWithCanonical rejects a copy that differs from canonical", () => {
  assert.match(legalCheckMemoProblemWithCanonical("copy", "canonical memo") ?? "", /must match/);
  assert.match(legalCheckMemoProblemWithCanonical("same", null) ?? "", /legal-check memo on disk/);
  assert.equal(legalCheckMemoProblemWithCanonical("same", "same"), null);
});

test("3.11-7: README does not claim Ethereum or Monad purchase lanes", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.ok(!/ethereum purchase lane/i.test(readme));
  assert.ok(!/monad.*buying/i.test(readme));
});

test("parsePolygonOwnerApproval accepts a valid record", () => {
  const raw = JSON.stringify(okApproval);
  assert.deepEqual(parsePolygonOwnerApproval(raw), okApproval);
  assert.equal(parsePolygonOwnerApproval("{}"), null);
});

test("evm-lane.ts accepts --lane polygon --hosts and wires pay gates on the purchase path", () => {
  const lane = readFileSync(new URL("../scripts/evm-lane.ts", import.meta.url), "utf8");
  assert.match(lane, /--lane robinhood \| arbitrum \| polygon/);
  assert.match(lane, /laneArg === "polygon"/);
  assert.match(lane, /console\.error\(`total\\t\$\{picked\.totalAtomic\}`\)/);
  assert.match(lane, /polygonPayGateProblem/);
  assert.match(lane, /laneLedgerCommitted/);
  assert.match(lane, /resolveSharedEvmTempoStop/);
  assert.match(lane, /polygonOutflowScanner/);
  assert.doesNotMatch(lane, /VET402_EVM_PAYER_OUTFLOW_ATOMIC/);
  assert.doesNotMatch(lane, /VET402_TEMPO_LAST_STOP/);
  assert.match(lane, /evmLaneStopsAfterRecord/);
});

test("3.11-6: Tempo not_settled from a remeasure file blocks the shared payer; the daily HALT-pay is read", () => {
  // The shape of results/remeasure/tempo-<date>.json on 2026-11-08 (runs[].stopped), trimmed to what is read.
  const fixture = JSON.stringify({ kind: "vet402-remeasure", version: 1, chain: "tempo", date: "2026-11-08", runs: [{ perPayTo: 1, stopped: "not_settled" }], rows: [] });
  assert.equal(tempoStoppedReasonFromJson(fixture), "not_settled");
  assert.match(sharedEvmSignBlockedByTempo({ lastTempoStopReason: "not_settled" }) ?? "", /Tempo is stopped/);
  const daily = mkdtempSync(join(tmpdir(), "vet402-daily-"));
  writeFileSync(join(daily, "HALT-pay"), "not_settled\n");
  const resolved = resolveSharedEvmTempoStop({ dailyStateDir: daily, extraJsonPaths: [] });
  assert.match(resolved.haltPayBody ?? "", /not_settled/);
});

/** A data dir with one published lane file per chain: `settled` rows carry a settlement tx. */
function ledgerDir(lanes: { lane: string; chain: string; settled: number }[]): string {
  const dir = mkdtempSync(join(tmpdir(), "vet402-ledger-"));
  mkdirSync(join(dir, "evm"), { recursive: true });
  for (const l of lanes) {
    const rows = Array.from({ length: l.settled }, (_, i) => ({ payTo: SELLER, status: "delivered", settlementTx: `0x${(i + 1).toString(16).padStart(64, "0")}` }));
    rows.push({ payTo: SELLER, status: "not_offered_now", settlementTx: null as unknown as string });
    writeFileSync(join(dir, "evm", `${l.lane}.json`), JSON.stringify({ kind: "vet402-evm-lane", lane: l.lane, chain: l.chain, rows }));
  }
  return dir;
}

test("3.11-5: the site build refuses a page that states 11 or 12 purchase chains, from the published ledger", () => {
  const dir = ledgerDir([{ lane: "robinhood", chain: "eip155:4663", settled: 2 }, { lane: "polygon", chain: "eip155:137", settled: 1 }, { lane: "monad", chain: "eip155:143", settled: 0 }]);
  const pub = publishedEvmPurchaseChains(dir);
  assert.deepEqual(pub, ["eip155:137", "eip155:4663"], "a lane file with no settled row is not a published chain");
  assert.deepEqual(chainCountClaimsInCopy("<p>vet402 buys on <b>12</b> chains, eleven purchase chains, 11-EVM-networks</p>"), [12, 11, 11]);
  assert.throws(() => assertPublicPagesChainCounts([["index.html", "<p>vet402 pays on 12 chains</p>"]], pub), /refusing to write the site: index\.html: do not claim 12/);
  assert.throws(() => assertPublicPagesChainCounts([["use.html", "Eleven purchase chains"]], pub), /use\.html: do not claim 11/);
  assert.doesNotThrow(() => assertPublicPagesChainCounts([["index.html", "<p>Solana, Base, Tempo, Arbitrum One, Robinhood Chain and Algorand</p>"]], pub));
  assert.match(validatePublicPurchaseChainClaim(12, pub) ?? "", /Monad/);
  // The site build calls it on every page before anything is written.
  const build = readFileSync(new URL("../scripts/build-site.ts", import.meta.url), "utf8");
  assert.match(build, /assertPublicPagesChainCounts\(pages, publishedEvmPurchaseChains\(join\(ROOT, "data"\)\)\);\nrmSync\(outDir/);
});

test("3.11-5: README and the built site in this tree state no purchase-chain count the ledger does not allow", () => {
  const pub = publishedEvmPurchaseChains(new URL("../data", import.meta.url).pathname);
  const pages: [string, string][] = [["README.md", readFileSync(new URL("../README.md", import.meta.url), "utf8")]];
  for (const n of ["index.html", "use.html", "method.html", "robinhood.html", "arbitrum.html"]) {
    const f = new URL(`../site/${n}`, import.meta.url);
    pages.push([n, readFileSync(f, "utf8")]);
  }
  assert.doesNotThrow(() => assertPublicPagesChainCounts(pages, pub));
});

test("3.11-4: this repository holds no copy of the operator's funding Stop hook (the hook that runs is the only judge)", () => {
  const hooks = new URL("../scripts/hooks/", import.meta.url).pathname;
  assert.equal(existsSync(join(hooks, "funding_request_gate.py")), false);
});

test("3.11-7: the announce gate counts published rows from the ledger; a count passed in is refused", () => {
  const gate = new URL("../scripts/first-purchase-announce-gate.ts", import.meta.url).pathname;
  const tsx = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
  const empty = ledgerDir([{ lane: "polygon", chain: "eip155:137", settled: 0 }]);
  const one = ledgerDir([{ lane: "polygon", chain: "eip155:137", settled: 1 }, { lane: "monad", chain: "eip155:143", settled: 3 }]);
  assert.equal(firstPurchaseAnnounceFromLedgerProblem("eip155:137", one).published, 1);
  const bad = spawnSync(tsx, [gate, "eip155:137", "--data", empty], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /no published purchase rows on eip155:137; do not announce .*nothing sent/);
  const passed = spawnSync(tsx, [gate, "eip155:137", "3", "--data", empty], { encoding: "utf8" });
  assert.equal(passed.status, 2, "a count on the command line is not read");
  assert.match(passed.stderr, /usage/);
  const monad = spawnSync(tsx, [gate, "eip155:143", "--data", one], { encoding: "utf8" });
  assert.equal(monad.status, 2);
  assert.match(monad.stderr, /Monad 3\.11\.0 is FAIL/);
  const ok = spawnSync(tsx, [gate, "eip155:137", "--data", one], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /1 published purchase row/);
});
