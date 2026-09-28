import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeFunctionData, encodeAbiParameters, getAddress, keccak256, pad, toFunctionSelector, type Hex } from "viem";
import { decide, isDelivered, shellQuote, vet402Check, type Purchase } from "../src/check/vet402-check.js";
import {
  BASE_USDC,
  buildGiveFeedbackArgs,
  encodeGiveFeedback,
  preflight,
  readUsdcTransfer,
  reputationAbi,
  TAG1,
  verifyDataUri,
  type FeedbackInput,
} from "../src/evm/erc8004.js";

// ---------- decide (pure) ----------

const p = (over: Partial<Purchase>): Purchase => ({
  attemptedAt: "2026-09-21T12:00:00Z",
  status: "settled",
  amountUnits: "1000",
  txHash: "0xaa",
  httpStatusPaid: 200,
  l2Schema: "match",
  network: "eip155:8453",
  ...over,
});

test("latest settled purchase delivered -> delivered, with its tx", () => {
  const d = decide([p({ status: "settle_failed", txHash: null, httpStatusPaid: 402 }), p({ txHash: "0x01" }), p({ txHash: "0x02", httpStatusPaid: 500 })]);
  assert.equal(d.verdict, "delivered");
  assert.equal(d.lastDelivery?.txHash, "0x01");
});

test("latest settled purchase paid but not delivered -> not_delivered", () => {
  const d = decide([p({ txHash: "0x09", httpStatusPaid: 500 }), p({ txHash: "0x01" })]);
  assert.equal(d.verdict, "not_delivered");
  assert.equal(d.lastSettled?.txHash, "0x09");
  assert.equal(d.lastDelivery?.txHash, "0x01");
});

test("settled 4xx is inconclusive: skipped, older decisive purchase decides; alone it is unverified", () => {
  assert.equal(decide([p({ txHash: "0x4", httpStatusPaid: 400 }), p({ txHash: "0x01" })]).verdict, "delivered");
  assert.equal(decide([p({ txHash: "0x4", httpStatusPaid: 400 })]).verdict, "unverified");
});

test("no settled purchase -> unverified (a failed settle is not evidence against the seller)", () => {
  assert.equal(decide([]).verdict, "unverified");
  assert.equal(decide([p({ status: "settle_failed", httpStatusPaid: 402 })]).verdict, "unverified");
});

test("delivered = settled + 2xx, as the observatory counts it; an L2 mismatch is still a delivery", () => {
  assert.equal(isDelivered(p({ l2Schema: "mismatch" })), true);
  assert.equal(isDelivered(p({ httpStatusPaid: 500 })), false);
  assert.equal(isDelivered(p({ status: "settle_failed" })), false);
});

test("shellQuote keeps a URL a single argument", () => {
  assert.equal(shellQuote("https://a.b/c?x=1&y='z'"), `'https://a.b/c?x=1&y='\\''z'\\'''`);
});

// ---------- vet402Check with a fake network ----------

type Route = [RegExp, number, unknown];
function fakeFetch(routes: Route[], seen: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(`${init?.method ?? "GET"} ${url}`);
    for (const [re, status, body] of routes) if (re.test(url)) return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

const URL_OK = "https://api.example.com/v1/thing";
const OBS = "11111111-2222-3333-4444-555555555555";

test("check: delivered seller -> last delivery tx, gap vs Bazaar, pay command", async () => {
  const seen: string[] = [];
  const f = fakeFetch(
    [
      [/discovery\/search/, 200, { resources: [{ resource: URL_OK, quality: { l30DaysTotalCalls: 1072 } }] }],
      [/\/api\/v1\/resolve/, 200, { resource: { canonical_url: URL_OK, observatory_id: OBS } }],
      [/\/facts$/, 200, { facts: { l1: { n_attempts: 4, n_settled: 3, n_delivered: 3 }, settlement_30d_real: 899 } }],
      [/\/purchases$/, 200, { network: "eip155:8453", purchases: [{ attemptedAt: "2026-09-21T12:08:50Z", status: "settled", amountUnits: "1000", txHash: "0x6ddc", httpStatusPaid: 200, l2Schema: "match" }] }],
    ],
    seen,
  );
  const r = await vet402Check(URL_OK, { fetchImpl: f, maxAmountAtomic: "10000" });
  assert.equal(r.verdict, "delivered");
  assert.equal(r.lastDelivery?.txHash, "0x6ddc");
  assert.equal(r.lastDelivery?.explorer, "https://basescan.org/tx/0x6ddc");
  assert.deepEqual([r.counts.bazaarCalls30d, r.counts.onchainSettlements30dReal, r.counts.gap], [1072, 899, 173]);
  assert.equal(r.next.action, "pay");
  assert.equal(r.next.command, `npx awal@2.12.1 x402 pay '${URL_OK}' --max-amount 10000`);
  assert.ok(seen.every((s) => s.startsWith("GET ")), "only GETs");
  assert.ok(!seen.some((s) => /\/v1\/buy/.test(s)), "no buy preflight when delivered");
});

test("check: resolve returns a different URL of the same seller -> not used (exact match only)", async () => {
  const f = fakeFetch([
    [/discovery\/search/, 200, { resources: [] }],
    [/\/api\/v1\/resolve/, 200, { endpoints: [{ canonical_url: "https://api.example.com/other", observatory_id: OBS }] }],
    [/board\/verdicts\.json/, 200, { verdicts: [] }],
    [/\/v1\/buy/, 422, { verdict: "REFUSE", reason: "no_supported_accept", charged: false }],
  ]);
  const r = await vet402Check(URL_OK, { fetchImpl: f });
  assert.equal(r.verdict, "unverified");
  assert.equal(r.next.action, "do_not_pay");
  assert.equal(r.next.command, null);
  assert.match(r.next.reason, /422/);
});

test("check: unverified but vet402 can buy it -> buy_via_vet402 command", async () => {
  const f = fakeFetch([
    [/discovery\/search/, 200, { resources: [] }],
    [/\/api\/v1\/resolve/, 200, { endpoints: [] }],
    [/board\/verdicts\.json/, 200, { verdicts: [] }],
    [/\/v1\/buy/, 402, {}],
  ]);
  const r = await vet402Check(URL_OK, { fetchImpl: f, maxAmountAtomic: "60000" });
  assert.equal(r.verdict, "unverified");
  assert.equal(r.next.action, "buy_via_vet402");
  assert.equal(r.next.command, `npx awal@2.12.1 x402 pay 'https://vet402-algorand.vercel.app/v1/buy?url=${encodeURIComponent(URL_OK)}' --max-amount 60000`);
  assert.equal(r.counts.gap, null);
});

test("check: Algorand seller found on the vet402-algorand board", async () => {
  const f = fakeFetch([
    [/discovery\/search/, 200, { resources: [] }],
    [/\/api\/v1\/resolve/, 200, { endpoints: [] }],
    [/board\/verdicts\.json/, 200, { verdicts: [{ resource: URL_OK, class: "MISMATCH", purchaseTx: "ALGOTX", network: "algorand:mainnet", checkedAt: "2026-09-27T04:32:08Z" }] }],
  ]);
  const r = await vet402Check(URL_OK, { fetchImpl: f });
  assert.equal(r.verdict, "not_delivered");
  assert.equal(r.lastAttempt?.txHash, "ALGOTX");
  assert.equal(r.next.action, "do_not_pay");
});

test("check: a rate-limited or failed vet402 lookup throws instead of saying unverified", async () => {
  const f429 = fakeFetch([[/discovery/, 200, { resources: [] }], [/\/api\/v1\/resolve/, 429, { error: "rate_limited" }]]);
  await assert.rejects(vet402Check(URL_OK, { fetchImpl: f429 }), /HTTP 429/);
  const f500 = fakeFetch([
    [/discovery/, 200, { resources: [] }],
    [/\/api\/v1\/resolve/, 200, { resource: { canonical_url: URL_OK, observatory_id: OBS } }],
    [/\/facts$/, 500, {}],
    [/\/purchases$/, 200, { purchases: [] }],
  ]);
  await assert.rejects(vet402Check(URL_OK, { fetchImpl: f500 }), /HTTP 500\/200/);
});

test("check: caller-supplied Bazaar count skips the Bazaar request", async () => {
  const seen: string[] = [];
  const f = fakeFetch([[/\/api\/v1\/resolve/, 200, { endpoints: [] }], [/board/, 200, { verdicts: [] }], [/\/v1\/buy/, 422, {}]], seen);
  const r = await vet402Check(URL_OK, { fetchImpl: f, bazaarCalls30d: 5 });
  assert.equal(r.counts.bazaarCalls30d, 5);
  assert.ok(!seen.some((s) => /discovery/.test(s)));
});

// ---------- ERC-8004 feedback ----------

const SELLER = getAddress("0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0");
const PAYER = getAddress("0xc9c7b38c0942914fc8ea12063bc92dcd3b581670");
const CLIENT = getAddress("0x9b59abf3dc92e7f60a6eeb7c1dedc6deb0bb4e51");
const TX = "0xdd04604154ed4d93d359026c70cd16133e537ad079462fd6c7aca4428eb31693" as Hex;

const input = (over: Partial<FeedbackInput> = {}): FeedbackInput => ({
  chain: "base",
  agentId: 94639n,
  clientAddress: CLIENT,
  delivered: true,
  createdAt: "2026-09-28T00:00:00Z",
  purchase: {
    resource: "https://agent402.tools/api/skill/schema-guard",
    network: "eip155:8453",
    txHash: TX,
    fromAddress: PAYER,
    toAddress: SELLER,
    amountUnits: "4000",
    attemptedAt: "2026-09-22T06:01:07Z",
    httpStatusPaid: 200,
    l2Schema: "match",
    evidenceUrl: "https://vet402.com/x",
  },
  ...over,
});

test("feedback file carries the EIP-8004 proofOfPayment fields and the MUST fields", () => {
  const { file } = buildGiveFeedbackArgs(input());
  for (const k of ["agentRegistry", "agentId", "clientAddress", "createdAt", "value", "valueDecimals"]) assert.ok(k in file, k);
  assert.equal(file.agentRegistry, "eip155:8453:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432");
  assert.deepEqual(file.proofOfPayment, { fromAddress: PAYER, toAddress: SELLER, chainId: "8453", txHash: TX });
});

test("feedbackHash = keccak256(file bytes) and the data: URI round-trips; a tampered URI fails", () => {
  const { args, fileBytes, file } = buildGiveFeedbackArgs(input());
  assert.equal(args.feedbackHash, keccak256(fileBytes));
  const v = verifyDataUri(args.feedbackURI, args.feedbackHash);
  assert.ok(v.ok);
  assert.deepEqual(v.file, file);
  const tampered = args.feedbackURI.slice(0, -4) + "AAAA";
  assert.equal(verifyDataUri(tampered, args.feedbackHash).ok, false);
});

test("calldata uses the spec selector and decodes back to the same 8 args", () => {
  const { args } = buildGiveFeedbackArgs(input());
  const data = encodeGiveFeedback(args);
  assert.equal(data.slice(0, 10), toFunctionSelector("giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)"));
  const dec = decodeFunctionData({ abi: reputationAbi, data });
  assert.equal(dec.functionName, "giveFeedback");
  assert.deepEqual(dec.args, [94639n, 1n, 0, TAG1, "vet402-L1", "https://agent402.tools/api/skill/schema-guard", args.feedbackURI, args.feedbackHash]);
});

test("not delivered -> value 0", () => {
  const { args, file } = buildGiveFeedbackArgs(input({ delivered: false }));
  assert.equal(args.value, 0n);
  assert.equal(file.value, 0);
});

test("external feedbackURI keeps the hash of the same bytes", () => {
  const a = buildGiveFeedbackArgs(input(), "https://vet402.com/feedback/x.json");
  const b = buildGiveFeedbackArgs(input());
  assert.equal(a.args.feedbackURI, "https://vet402.com/feedback/x.json");
  assert.equal(a.args.feedbackHash, b.args.feedbackHash);
});

// ---------- purchase proof from the receipt ----------

const TRANSFER_TOPIC = keccak256(new TextEncoder().encode("Transfer(address,address,uint256)"));
function receipt(logs: { address: string; from: string; to: string; value: bigint }[], status: "success" | "reverted" = "success") {
  return {
    status,
    blockNumber: 1n,
    logs: logs.map((l) => ({
      address: l.address,
      topics: [TRANSFER_TOPIC, pad(l.from as Hex), pad(l.to as Hex)],
      data: encodeAbiParameters([{ type: "uint256" }], [l.value]),
    })),
  };
}
const rc = (r: unknown) => ({ getTransactionReceipt: async () => r }) as any;

test("readUsdcTransfer finds the USDC transfer to the seller", async () => {
  const r = await readUsdcTransfer(rc(receipt([{ address: BASE_USDC, from: PAYER, to: SELLER, value: 4000n }])), TX, { to: SELLER, amountUnits: "4000" });
  assert.equal(r.ok, true);
  assert.equal(r.from, PAYER);
});

test("readUsdcTransfer refuses wrong amount, wrong token, reverted tx", async () => {
  assert.equal((await readUsdcTransfer(rc(receipt([{ address: BASE_USDC, from: PAYER, to: SELLER, value: 5000n }])), TX, { to: SELLER, amountUnits: "4000" })).reason, "amount_mismatch");
  assert.equal((await readUsdcTransfer(rc(receipt([{ address: CLIENT, from: PAYER, to: SELLER, value: 4000n }])), TX, { to: SELLER })).reason, "no_usdc_transfer_to_seller");
  assert.equal((await readUsdcTransfer(rc(receipt([], "reverted")), TX, { to: SELLER })).reason, "tx_status_reverted");
});

// ---------- preflight binding ----------

function fakeReader(o: { owner?: string; wallet?: string; authorized?: boolean; missing?: boolean }) {
  return {
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "getIdentityRegistry") return "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
      if (functionName === "getVersion") return "2.0.0";
      if (functionName === "getLastIndex") return 0n;
      if (o.missing) throw new Error("ERC721NonexistentToken");
      if (functionName === "ownerOf") return o.owner;
      if (functionName === "getAgentWallet") return o.wallet;
      if (functionName === "isAuthorizedOrOwner") return o.authorized ?? false;
      throw new Error(functionName);
    },
  } as any;
}

test("preflight: agentWallet = payTo binds; other wallet does not; missing agent has no owner", async () => {
  assert.equal((await preflight(fakeReader({ owner: CLIENT, wallet: SELLER }), input())).sellerBinding, "agentWallet");
  assert.equal((await preflight(fakeReader({ owner: SELLER, wallet: "0x0000000000000000000000000000000000000000" }), input())).sellerBinding, "owner");
  assert.equal((await preflight(fakeReader({ owner: CLIENT, wallet: CLIENT }), input())).sellerBinding, "none");
  const m = await preflight(fakeReader({ missing: true }), input());
  assert.equal(m.agentOwner, null);
  assert.equal(m.sellerBinding, "none");
});

// ---------- the writer cannot send ----------

test("no signing or sending path exists, and the private key file is never read", () => {
  for (const f of ["src/evm/erc8004.ts", "scripts/erc8004-simulate.ts", "src/check/vet402-check.ts", "scripts/vet402-check.ts"]) {
    const code = readFileSync(new URL(`../${f}`, import.meta.url), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n");
    for (const banned of ["sendTransaction", "sendRawTransaction", "writeContract", "createWalletClient", "privateKeyToAccount", "mnemonicToAccount", "signTransaction", "evm.json"]) {
      assert.ok(!code.includes(banned), `${f} contains ${banned}`);
    }
  }
});
