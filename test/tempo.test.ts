import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { custom, encodeFunctionData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Abis, Transaction } from "viem/tempo";
import {
  FEE_RESERVE_ATOMIC,
  PATH_USD,
  PAYER_ADDRESS,
  TEMPO_MAINNET_CHAIN_ID,
  USDC_E,
} from "../src/tempo/constants.js";
import { mppChallengesFromHeader, parseWwwAuthenticate, tempoChargeRequest } from "../src/tempo/challenge.js";
import { checkCharge, pickTempoCharge } from "../src/tempo/guard.js";
import { Ledger } from "../src/tempo/ledger.js";
import { buildRequest, chooseEndpoint, fillPath, type MercatorService } from "../src/tempo/mercator.js";
import { checkSignedTransfer } from "../src/tempo/txcheck.js";
import { payOne, type PayDeps } from "../src/tempo/pay.js";
import { breakdown, parseCsv, type LedgerRow } from "../src/tempo/l1-breakdown.js";
import type { PlanEntry } from "../src/tempo/census.js";
import { signerFor, type Signer } from "../src/tempo/chain.js";

const SELLER = "0x060b0fB0Be9d90557577B3AEE480711067149Ff0";
const OTHER = "0x1111111111111111111111111111111111111111";

function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function challengeHeader(req: Record<string, unknown>, extra = "", id = "abc"): string {
  return `Payment id="${id}", realm="svc.example", method="tempo", intent="charge", request="${b64url(req)}", expires="2099-01-01T00:00:00Z"${extra}`;
}
const goodReq = (over: Record<string, unknown> = {}) => ({
  amount: "6000",
  currency: USDC_E,
  recipient: SELLER,
  methodDetails: { chainId: TEMPO_MAINNET_CHAIN_ID },
  ...over,
});
const one = (h: string) => mppChallengesFromHeader(h)[0]!;

// ---------- challenge parsing ----------

test("parses the live openweather challenge (captured 2026-09-28)", () => {
  const h =
    'Payment id="Nj-GLXw3oMT93iz6wt7pDR7-SRWicOc-ggLTARwNRJk", realm="openweather.mpp.paywithlocus.com", method="tempo", intent="charge", request="eyJhbW91bnQiOiI2MDAwIiwiY3VycmVuY3kiOiIweDIwYzAwMDAwMDAwMDAwMDAwMDAwMDAwMGI5NTM3ZDExYzYwZThiNTAiLCJtZXRob2REZXRhaWxzIjp7ImNoYWluSWQiOjQyMTd9LCJyZWNpcGllbnQiOiIweDA2MGIwZkIwQmU5ZDkwNTU3NTc3QjNBRUU0ODA3MTEwNjcxNDlGZjAifQ", description="Locus MPP: openweather/current-weather", expires="2026-09-28T07:06:32.217Z"';
  const [c] = mppChallengesFromHeader(h);
  const r = tempoChargeRequest(c!)!;
  assert.equal(r.amount, "6000");
  assert.equal(r.currency, USDC_E);
  assert.equal(r.chainId, 4217);
  assert.equal(r.feePayer, false);
  assert.equal(r.recipient?.toLowerCase(), SELLER.toLowerCase());
  assert.equal(c!.params.description, "Locus MPP: openweather/current-weather");
});

test("splits several challenges joined into one header, skipping other schemes", () => {
  const h = `Bearer realm="x, y", ${challengeHeader(goodReq(), "", "a")}, ${challengeHeader(goodReq({ amount: "7" }), "", "b")}`;
  assert.equal(parseWwwAuthenticate(h).length, 3);
  const cs = mppChallengesFromHeader(h);
  assert.deepEqual(cs.map((c) => c.id), ["a", "b"]);
  assert.equal(tempoChargeRequest(cs[1]!)!.amount, "7");
});

test("feePayer true or an object means sponsored", () => {
  assert.equal(tempoChargeRequest(one(challengeHeader(goodReq({ methodDetails: { chainId: 4217, feePayer: true } }))))!.feePayer, true);
  assert.equal(tempoChargeRequest(one(challengeHeader(goodReq({ methodDetails: { chainId: 4217, feePayer: {} } }))))!.feePayer, true);
  assert.equal(tempoChargeRequest(one(challengeHeader(goodReq({ methodDetails: { chainId: 4217, feePayer: false } }))))!.feePayer, false);
});

// ---------- guard ----------

const ctx = { payer: PAYER_ADDRESS, now: new Date("2026-09-28T00:00:00Z") };

test("a correct mainnet USDC.e charge passes", () => {
  assert.equal(checkCharge(one(challengeHeader(goodReq())), ctx), null);
  assert.equal(checkCharge(one(challengeHeader(goodReq({ amount: "100000" }))), ctx), null);
});

test("over 0.10 is refused", () => {
  assert.equal(checkCharge(one(challengeHeader(goodReq({ amount: "100001" }))), ctx)?.refused, "price_over_cap");
});

test("Moderato testnet and other chains are refused; missing chainId is refused", () => {
  assert.equal(checkCharge(one(challengeHeader(goodReq({ methodDetails: { chainId: 42431 } }))), ctx)?.refused, "testnet_chain");
  assert.equal(checkCharge(one(challengeHeader(goodReq({ methodDetails: { chainId: 8453 } }))), ctx)?.refused, "chain_mismatch");
  assert.equal(checkCharge(one(challengeHeader(goodReq({ methodDetails: {} }))), ctx)?.refused, "chain_mismatch");
});

test("pathUSD (not USDC.e) is refused", () => {
  assert.equal(checkCharge(one(challengeHeader(goodReq({ currency: PATH_USD }))), ctx)?.refused, "currency_mismatch");
});

test("recipient and price are locked to the dry run", () => {
  const c = one(challengeHeader(goodReq({ recipient: OTHER })));
  assert.equal(checkCharge(c, { ...ctx, lockedRecipient: SELLER })?.refused, "recipient_mismatch");
  assert.equal(checkCharge(one(challengeHeader(goodReq({ amount: "7000" }))), { ...ctx, lockedAmount: "6000" })?.refused, "price_raised");
  assert.equal(checkCharge(one(challengeHeader(goodReq({ amount: "5000" }))), { ...ctx, lockedAmount: "6000", lockedRecipient: SELLER }), null);
});

test("Mercator recipient allowlist, self-dealing, splits, push-only and expiry are refused", () => {
  assert.equal(checkCharge(one(challengeHeader(goodReq())), { ...ctx, allowlist: [OTHER] })?.refused, "recipient_not_allowlisted");
  assert.equal(checkCharge(one(challengeHeader(goodReq({ recipient: PAYER_ADDRESS }))), ctx)?.refused, "self_dealing");
  assert.equal(
    checkCharge(one(challengeHeader(goodReq({ methodDetails: { chainId: 4217, splits: [{ recipient: OTHER, amount: "1" }] } }))), ctx)?.refused,
    "splits_refused",
  );
  assert.equal(
    checkCharge(one(challengeHeader(goodReq({ methodDetails: { chainId: 4217, supportedModes: ["push"] } }))), ctx)?.refused,
    "pull_unsupported",
  );
  const expired = mppChallengesFromHeader(challengeHeader(goodReq()).replace("2099-01-01", "2020-01-01"))[0]!;
  assert.equal(checkCharge(expired, ctx)?.refused, "expired");
  assert.equal(checkCharge(null, ctx)?.refused, "no_tempo_charge");
});

test("pickTempoCharge prefers mainnet USDC.e with the locked recipient", () => {
  const h = `${challengeHeader(goodReq({ methodDetails: { chainId: 42431 } }), "", "test")}, ${challengeHeader(goodReq(), "", "main")}`;
  assert.equal(pickTempoCharge(mppChallengesFromHeader(h), SELLER)?.id, "main");
});

// ---------- ledger ----------

function tmpLedger(cap = 30_000n): { path: string; ledger: Ledger } {
  const path = join(mkdtempSync(join(tmpdir(), "tempo-ledger-")), "ledger.json");
  return { path, ledger: new Ledger(path, PAYER_ADDRESS, cap) };
}

test("ledger: per-call cap, one purchase per service, total cap counts fee reserve", () => {
  const { ledger } = tmpLedger(30_000n);
  assert.equal((ledger.reserve({ key: "a", url: "u", recipient: SELLER, amount: 100_001n, sponsored: true }) as { refused: string }).refused, "price_over_cap");
  assert.ok(!("refused" in ledger.reserve({ key: "a", url: "u", recipient: SELLER, amount: 20_000n, sponsored: false })));
  assert.equal(ledger.committed(), 20_000n + FEE_RESERVE_ATOMIC);
  assert.equal((ledger.reserve({ key: "a", url: "u", recipient: SELLER, amount: 1n, sponsored: true }) as { refused: string }).refused, "already_bought");
  // 22,000 committed; 8,000 sponsored fits exactly, 8,001 does not
  assert.equal((ledger.reserve({ key: "b", url: "u", recipient: SELLER, amount: 8_001n, sponsored: true }) as { refused: string }).refused, "total_cap_reached");
  assert.ok(!("refused" in ledger.reserve({ key: "b", url: "u", recipient: SELLER, amount: 8_000n, sponsored: true })));
});

test("ledger: on-chain outflow above the ledger closes the budget", () => {
  const { ledger } = tmpLedger(30_000n);
  assert.equal((ledger.reserve({ key: "a", url: "u", recipient: SELLER, amount: 1_000n, sponsored: true }, 29_500n) as { refused: string }).refused, "total_cap_reached");
});

test("ledger: persisted before signing, reloaded, released only if never sent", () => {
  const { path, ledger } = tmpLedger(30_000n);
  ledger.reserve({ key: "a", url: "u", recipient: SELLER, amount: 5_000n, sponsored: true });
  const reloaded = new Ledger(path, PAYER_ADDRESS, 30_000n);
  assert.equal(reloaded.committed(), 5_000n);
  reloaded.update("a", { status: "refused_before_sign" });
  assert.equal(new Ledger(path, PAYER_ADDRESS, 30_000n).committed(), 0n);
  reloaded.reserve({ key: "b", url: "u", recipient: SELLER, amount: 5_000n, sponsored: true });
  reloaded.update("b", { status: "sent" });
  assert.throws(() => reloaded.update("b", { status: "refused_before_sign" }));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).entries.length, 2);
  assert.throws(() => new Ledger(path, OTHER, 30_000n));
  assert.throws(() => new Ledger(null, PAYER_ADDRESS, 5_000_001n));
});

// ---------- signed transaction check ----------

const throwaway = privateKeyToAccount(generatePrivateKey());

async function signedTransfer(o: { to?: string; amount?: bigint; token?: string; chainId?: number; calls?: number; feeToken?: string } = {}): Promise<string> {
  const data = encodeFunctionData({ abi: Abis.tip20, functionName: "transfer", args: [(o.to ?? SELLER) as Hex, o.amount ?? 6000n] });
  const call = { to: (o.token ?? USDC_E) as Hex, data };
  const tx = {
    type: "tempo" as const,
    chainId: o.chainId ?? 4217,
    calls: Array.from({ length: o.calls ?? 1 }, () => call),
    nonce: 0,
    gas: 100_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
    nonceKey: 2n ** 256n - 1n,
    validBefore: 1_790_000_000,
    ...(o.feeToken ? { feeToken: o.feeToken as Hex } : {}),
  };
  return throwaway.signTransaction(tx as never, { serializer: Transaction.serialize as never });
}
const exp = (over: Partial<{ recipient: string; amount: bigint; sponsored: boolean; payer: string }> = {}) => ({
  payer: throwaway.address,
  recipient: SELLER,
  amount: 6000n,
  sponsored: false,
  ...over,
});

test("signed tx: the approved transfer passes", async () => {
  assert.equal(checkSignedTransfer(await signedTransfer(), exp()), null);
  assert.equal(checkSignedTransfer(await signedTransfer({ feeToken: USDC_E }), exp()), null);
});

test("signed tx: wrong recipient, amount, token, chain, call count, signer or fee token is rejected", async () => {
  assert.match(checkSignedTransfer(await signedTransfer({ to: OTHER }), exp())!, /not the recipient/);
  assert.match(checkSignedTransfer(await signedTransfer({ amount: 6001n }), exp())!, /amount/);
  assert.match(checkSignedTransfer(await signedTransfer({ token: PATH_USD }), exp())!, /not USDC.e/);
  assert.match(checkSignedTransfer(await signedTransfer({ chainId: 42431 }), exp())!, /not 4217/);
  assert.match(checkSignedTransfer(await signedTransfer({ calls: 2 }), exp())!, /expected 1 call/);
  assert.match(checkSignedTransfer(await signedTransfer(), exp({ payer: OTHER }))!, /not the payer/);
  assert.match(checkSignedTransfer(await signedTransfer({ feeToken: PATH_USD }), exp())!, /self-paid fee/);
  assert.match(checkSignedTransfer("0x02abcd", exp())!, /not a Tempo/);
});

// ---------- the real mppx signer, over a fake RPC (no network) ----------

const fakeRpc = custom({
  async request({ method }: { method: string }) {
    switch (method) {
      case "eth_chainId":
        return "0x1079";
      case "eth_getTransactionCount":
        return "0x0";
      case "eth_estimateGas":
        return "0xc350";
      case "eth_maxPriorityFeePerGas":
        return "0x0";
      case "eth_getBlockByNumber":
        return { baseFeePerGas: "0x23c34600", number: "0x1", timestamp: "0x6a", hash: `0x${"00".repeat(32)}`, transactions: [] };
      default:
        throw new Error(`unhandled ${method}`);
    }
  },
});

for (const sponsored of [false, true]) {
  test(`mppx pull credential (feePayer ${sponsored}) carries a tx that passes the signed-tx check`, async () => {
    const md = sponsored ? { chainId: 4217, feePayer: true } : { chainId: 4217 };
    const res = new Response("{}", { status: 402, headers: { "www-authenticate": challengeHeader(goodReq({ methodDetails: md })) } });
    const out = await signerFor(throwaway, fakeRpc).credentialFor(res, "abc", SELLER);
    assert.match(out.serializedTx, sponsored ? /^0x78/ : /^0x76/);
    assert.equal(checkSignedTransfer(out.serializedTx, exp({ sponsored })), null);
    assert.match(checkSignedTransfer(out.serializedTx, exp({ sponsored, recipient: OTHER }))!, /not the recipient/);
    assert.match(checkSignedTransfer(out.serializedTx, exp({ sponsored: !sponsored }))!, /envelope/);
  });
}

test("mppx signer refuses a challenge for another recipient than the lock", async () => {
  const res = new Response("{}", { status: 402, headers: { "www-authenticate": challengeHeader(goodReq({ recipient: OTHER })) } });
  await assert.rejects(signerFor(throwaway, fakeRpc).credentialFor(res, "abc", SELLER));
});

// ---------- endpoint choice ----------

const svc = (endpoints: MercatorService["endpoints"]): MercatorService => ({
  id: "svc",
  name: "Svc",
  serviceUrl: "https://svc.example/api/",
  endpoints,
});
const offer = (amount: string) => ({ protocol: "mpp", method: "tempo", intent: "charge", network: "eip155:4217", currency: USDC_E, amount, decimals: 6 });

test("fillPath and buildRequest use Mercator's input example", () => {
  assert.equal(fillPath("/v1/items/{id}", { id: "x 1" })?.path, "/v1/items/x%201");
  assert.equal(fillPath("/v1/items/:id", {}), null);
  const get = buildRequest(svc([]), { method: "GET", path: "/w", inputExample: { location: "London", n: 3 } })!;
  assert.equal(get.url, "https://svc.example/api/w?location=London&n=3");
  assert.equal(get.body, null);
  const post = buildRequest(svc([]), { method: "POST", path: "/p/{id}", requestFormat: "json", inputExample: { id: "7", lat: 1 } })!;
  assert.equal(post.url, "https://svc.example/api/p/7");
  assert.equal(post.body, JSON.stringify({ lat: 1 }));
});

test("chooseEndpoint picks the cheapest fillable Tempo charge", () => {
  const s = svc([
    { method: "GET", path: "/a/{id}", paymentOffers: [offer("100")] }, // not fillable
    { method: "POST", path: "/b", paymentOffers: [offer("500")] },
    { method: "GET", path: "/c", inputExample: { q: "x" }, paymentOffers: [offer("500")] },
    { method: "GET", path: "/d", paymentOffers: [{ ...offer("1"), network: "eip155:42431" }] }, // testnet
  ]);
  assert.equal(chooseEndpoint(s)?.ep.path, "/c");
});

test("chooseEndpoint prefers a usable input over a cheaper blind POST, and falls back to dynamic prices", () => {
  const blindCheap = svc([
    { method: "POST", path: "/blind", paymentOffers: [offer("1")] },
    { method: "POST", path: "/ok", inputExample: { q: "x" }, paymentOffers: [offer("900")] },
  ]);
  const c = chooseEndpoint(blindCheap)!;
  assert.equal(c.ep.path, "/ok");
  assert.equal(c.usableInput, true);
  const dynamicOnly = svc([{ method: "POST", path: "/search", inputExample: { query: "x" }, paymentOffers: [{ ...offer("0"), amount: undefined as never }] }]);
  assert.equal(chooseEndpoint(dynamicOnly)?.ep.path, "/search");
  const noInput = svc([{ method: "POST", path: "/v1/messages", paymentOffers: [offer("5")] }]);
  assert.equal(chooseEndpoint(noInput)?.usableInput, false);
  const getNeedsArgs = svc([{ method: "GET", path: "/w", inputSchema: { required: ["city"] }, paymentOffers: [offer("5")] }]);
  assert.equal(chooseEndpoint(getNeedsArgs)?.usableInput, false);
});

// ---------- vouch Tempo L1 breakdown ----------

test("breakdown buckets settled rows by why they were not delivered", () => {
  const csv = [
    "attempted_at,resource_key,network,status,http_status_paid,latency_ms,request_body,tx_hash",
    't1,"a.example/x",eip155:4217,settled,200,10,empty,0x1',
    "t2,a.example/y,eip155:4217,settled,400,10,empty,0x2",
    "t3,a.example/z,eip155:4217,settled,,20400,empty,0x3",
    "t4,a.example/w,eip155:4217,settled,502,10,none,0x4",
    "t5,a.example/v,eip155:4217,settle_failed,400,10,empty,",
    "t6,b.example/v,eip155:8453,settled,400,10,empty,0x6",
  ].join("\n");
  const b = breakdown(parseCsv(csv) as unknown as LedgerRow[]);
  assert.equal(b.attempts, 5);
  assert.equal(b.settled, 4);
  assert.deepEqual(b.buckets, { delivered: 1, vet402_request_shape: 1, vet402_timeout: 1, seller_5xx: 1 });
});

// ---------- payOne ----------

interface FakeCall {
  url: string;
  auth: string | null;
}

function fakeDeps(o: {
  liveReq?: Record<string, unknown>;
  signed?: () => Promise<string>;
  paidStatus?: number;
  cap?: bigint;
}): { deps: PayDeps; calls: FakeCall[]; signCalls: { n: number }; path: string } {
  const calls: FakeCall[] = [];
  const signCalls = { n: 0 };
  const { path, ledger } = (() => {
    const p = join(mkdtempSync(join(tmpdir(), "tempo-pay-")), "ledger.json");
    return { path: p, ledger: new Ledger(p, throwaway.address, o.cap ?? 1_000_000n) };
  })();
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ url, auth });
    if (!auth) return new Response("{}", { status: 402, headers: { "www-authenticate": challengeHeader(o.liveReq ?? goodReq()) } });
    return new Response(JSON.stringify({ ok: true }), { status: o.paidStatus ?? 200, headers: { "content-type": "application/json" } });
  };
  const signer: Signer = {
    address: throwaway.address,
    async credentialFor() {
      signCalls.n++;
      const tx = await (o.signed ?? (() => signedTransfer()))();
      return { credential: "cred", serializedTx: tx };
    },
  };
  const deps: PayDeps = {
    fetchImpl,
    signer,
    ledger,
    payer: throwaway.address,
    balance: async () => 1_000_000n,
    chainSpent: async () => 0n,
    verify: async () => ({ settled: true, detail: "transfer found", feePaid: "30" }),
    now: () => new Date("2026-09-28T00:00:00Z"),
  };
  return { deps, calls, signCalls, path };
}

const planEntry: PlanEntry = {
  serviceId: "openweather",
  request: { url: "https://svc.example/w", method: "GET", body: null, contentType: null, inputSource: "none" },
  lockedRecipient: SELLER,
  lockedAmount: "6000",
  sponsored: false,
  allowlist: [SELLER],
};

test("payOne: happy path records settled and delivered with the tx hash of the signed envelope", async () => {
  const f = fakeDeps({});
  const out = await payOne(planEntry, f.deps);
  assert.equal(out.result, "sent");
  assert.equal(out.delivered, true);
  assert.equal(out.txHashSource, "signed_tx");
  assert.match(out.txHash!, /^0x[0-9a-f]{64}$/);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1]!.auth, "Payment cred");
  const saved = JSON.parse(readFileSync(f.path, "utf8"));
  assert.equal(saved.entries[0].status, "sent");
  assert.equal(saved.entries[0].delivered, true);
});

test("payOne: a paid 4xx is settled but not delivered", async () => {
  const f = fakeDeps({ paidStatus: 400 });
  const out = await payOne(planEntry, f.deps);
  assert.equal(out.settled, true);
  assert.equal(out.delivered, false);
});

test("payOne: recipient changed since the dry run -> refused, nothing signed or reserved", async () => {
  const f = fakeDeps({ liveReq: goodReq({ recipient: OTHER }) });
  const out = await payOne(planEntry, f.deps);
  assert.equal(out.refusal?.refused, "recipient_mismatch");
  assert.equal(f.signCalls.n, 0);
  assert.equal(f.deps.ledger.count(), 0);
  assert.equal(f.calls.length, 1);
});

test("payOne: price raised since the dry run -> refused", async () => {
  const f = fakeDeps({ liveReq: goodReq({ amount: "6001" }) });
  assert.equal((await payOne(planEntry, f.deps)).refusal?.refused, "price_raised");
  assert.equal(f.signCalls.n, 0);
});

test("payOne: signed tx to another address is never sent and the reservation is released", async () => {
  const f = fakeDeps({ signed: () => signedTransfer({ to: OTHER }) });
  const out = await payOne(planEntry, f.deps);
  assert.equal(out.refusal?.refused, "tx_check_failed");
  assert.equal(f.calls.length, 1); // only the unpaid probe
  assert.equal(f.deps.ledger.committed(), 0n);
});

test("payOne: total cap reached -> refused before signing", async () => {
  const f = fakeDeps({ cap: 7_000n }); // 6,000 + 2,000 fee reserve > 7,000
  const out = await payOne(planEntry, f.deps);
  assert.equal(out.refusal?.refused, "total_cap_reached");
  assert.equal(f.signCalls.n, 0);
});

test("payOne: insufficient balance -> refused before reserving", async () => {
  const f = fakeDeps({});
  f.deps.balance = async () => 7_999n;
  assert.equal((await payOne(planEntry, f.deps)).refusal?.refused, "insufficient_balance");
  assert.equal(f.deps.ledger.count(), 0);
});
