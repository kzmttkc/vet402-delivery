import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import { authorizationHeader, payOne, runPlan, stopReason, type PayDeps, type PayOutcome } from "../src/tempo/pay.js";
import { Credential } from "mppx";
import { breakdown, parseCsv, type LedgerRow } from "../src/tempo/l1-breakdown.js";
import type { PlanEntry } from "../src/tempo/census.js";
import { loadSigner, signerFor, type Signer } from "../src/tempo/chain.js";

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
    const challenge = () =>
      new Response("{}", { status: 402, headers: { "www-authenticate": challengeHeader(o.liveReq ?? goodReq()) } });
    if (!auth) return challenge();
    // Parse the Authorization header the way an MPP server does; unreadable -> 402 malformed-credential.
    try {
      Credential.deserialize(auth);
    } catch {
      return new Response(JSON.stringify({ type: "https://paymentauth.org/problems/malformed-credential", detail: "Credential is malformed" }), {
        status: 402,
        headers: { "content-type": "application/problem+json", "www-authenticate": challengeHeader(o.liveReq ?? goodReq()) },
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: o.paidStatus ?? 200, headers: { "content-type": "application/json" } });
  };
  const real = signerFor(throwaway, fakeRpc);
  const signer: Signer = {
    address: throwaway.address,
    async credentialFor(res, id, recipient) {
      signCalls.n++;
      if (o.signed) return { credential: "Payment eyJ4IjoxfQ", serializedTx: await o.signed() };
      // the real mppx credential, exactly what --pay sends
      return real.credentialFor(res, id, recipient);
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
    now: () => new Date(),
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
  // one scheme token, and a credential an MPP server can read
  assert.match(f.calls[1]!.auth!, /^Payment eyJ/);
  assert.doesNotMatch(f.calls[1]!.auth!, /^Payment\s+Payment/i);
  const cred = Credential.deserialize<{ type: string }>(f.calls[1]!.auth!);
  assert.equal(cred.payload.type, "transaction");
  // the 2026-09-28 bug: prefixing mppx's credential again makes it unreadable to the server
  assert.throws(() => Credential.deserialize(`Payment ${f.calls[1]!.auth!}`));
  const saved = JSON.parse(readFileSync(f.path, "utf8"));
  assert.equal(saved.entries[0].status, "sent");
  assert.equal(saved.entries[0].delivered, true);
});

test("authorizationHeader never doubles the Payment scheme", () => {
  assert.equal(authorizationHeader("Payment eyJhIjoxfQ"), "Payment eyJhIjoxfQ");
  assert.equal(authorizationHeader("payment eyJhIjoxfQ"), "payment eyJhIjoxfQ");
  assert.equal(authorizationHeader("eyJhIjoxfQ"), "Payment eyJhIjoxfQ");
});

test("payOne: a paid 402 with no receipt on chain reports no tx hash and records the problem", async () => {
  const f = fakeDeps({});
  f.deps.fetchImpl = async (url, init) => {
    const auth = new Headers(init?.headers).get("authorization");
    f.calls.push({ url, auth });
    const www = challengeHeader(goodReq());
    if (!auth) return new Response("{}", { status: 402, headers: { "www-authenticate": www } });
    return new Response(JSON.stringify({ type: "https://paymentauth.org/problems/verification-failed", detail: "nope" }), { status: 402, headers: { "www-authenticate": www } });
  };
  f.deps.verify = async () => ({ settled: false, detail: "receipt not found", feePaid: null });
  const out = await payOne(planEntry, f.deps);
  assert.equal(out.httpStatus, 402);
  assert.equal(out.settled, false);
  assert.equal(out.txHash, null);
  assert.match(out.detail!, /verification-failed/);
  assert.match(JSON.parse(readFileSync(f.path, "utf8")).entries[0].note, /verification-failed/);
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

// ---------- review B1: stop conditions ----------

test("payOne: on-chain outflow above the ledger -> chain_spend_exceeds_ledger, nothing reserved or signed", async () => {
  const f = fakeDeps({});
  f.deps.chainSpent = async () => 1n; // ledger is empty: committed 0
  const out = await payOne(planEntry, f.deps);
  assert.equal(out.refusal?.refused, "chain_spend_exceeds_ledger");
  assert.equal(f.signCalls.n, 0);
  assert.equal(f.deps.ledger.count(), 0);
});

test("payOne: outflow equal to the ledger is not a stop", async () => {
  const f = fakeDeps({});
  f.deps.ledger.reserve({ key: "earlier", url: "u", recipient: SELLER, amount: 5_000n, sponsored: true });
  f.deps.chainSpent = async () => 5_000n;
  assert.equal((await payOne(planEntry, f.deps)).result, "sent");
});

test("stopReason: which outcomes stop the run", () => {
  const sent = (o: Partial<PayOutcome>): PayOutcome => ({ serviceId: "s", result: "sent", settled: true, delivered: true, ...o });
  const ref = (r: string): PayOutcome => ({ serviceId: "s", result: "refused", refusal: { refused: r as never, detail: "" } });
  assert.equal(stopReason(ref("tx_check_failed")), "tx_check_failed");
  assert.equal(stopReason(ref("chain_spend_exceeds_ledger")), "chain_spend_exceeds_ledger");
  assert.equal(stopReason(ref("total_cap_reached")), "total_cap_reached");
  assert.equal(stopReason(ref("insufficient_balance")), "insufficient_balance");
  assert.equal(stopReason({ serviceId: "s", result: "unknown" }), "outcome_unknown");
  assert.equal(stopReason(sent({ settled: false, delivered: false })), "not_settled");
  assert.equal(stopReason(sent({ feePaid: String(FEE_RESERVE_ATOMIC + 1n) })), "fee_over_reserve");
  // not stops: a per-seller refusal, a delivered purchase, a paid 4xx that settled, a fee at the reserve
  assert.equal(stopReason(ref("recipient_mismatch")), null);
  assert.equal(stopReason(ref("price_raised")), null);
  assert.equal(stopReason(sent({})), null);
  assert.equal(stopReason(sent({ httpStatus: 400, delivered: false })), null);
  assert.equal(stopReason(sent({ feePaid: String(FEE_RESERVE_ATOMIC) })), null);
});

const second: PlanEntry = { ...planEntry, serviceId: "second" };

async function runTwo(setup: (f: ReturnType<typeof fakeDeps>) => void, o: Parameters<typeof fakeDeps>[0] = {}) {
  const f = fakeDeps(o);
  setup(f);
  const r = await runPlan([planEntry, second], f.deps);
  return { f, r };
}

test("runPlan: tx_check_failed stops the run before the next entry", async () => {
  const { f, r } = await runTwo(() => undefined, { signed: () => signedTransfer({ to: OTHER }) });
  assert.deepEqual(r.stopped, { serviceId: "openweather", reason: "tx_check_failed" });
  assert.equal(r.outcomes.length, 1);
  assert.equal(f.signCalls.n, 1);
});

test("runPlan: chain_spend_exceeds_ledger stops the run", async () => {
  const { f, r } = await runTwo((f) => (f.deps.chainSpent = async () => 1n));
  assert.equal(r.stopped?.reason, "chain_spend_exceeds_ledger");
  assert.equal(r.outcomes.length, 1);
  assert.equal(f.signCalls.n, 0);
});

test("runPlan: an unknown outcome (paid request threw) stops the run", async () => {
  const { f, r } = await runTwo((f) => {
    const inner = f.deps.fetchImpl;
    f.deps.fetchImpl = async (url, init) => {
      if (new Headers(init?.headers).get("authorization")) throw new Error("socket hang up");
      return inner(url, init);
    };
  });
  assert.equal(r.stopped?.reason, "outcome_unknown");
  assert.equal(r.outcomes.length, 1);
  assert.equal(JSON.parse(readFileSync(f.path, "utf8")).entries[0].status, "unknown");
});

test("runPlan: settled === false stops the run", async () => {
  const { r } = await runTwo((f) => (f.deps.verify = async () => ({ settled: false, detail: "no matching transfer", feePaid: null })));
  assert.equal(r.stopped?.reason, "not_settled");
  assert.equal(r.outcomes.length, 1);
});

test("runPlan: a fee above FEE_RESERVE_ATOMIC stops the run", async () => {
  const { r } = await runTwo(
    (f) => (f.deps.verify = async () => ({ settled: true, detail: "transfer found", feePaid: String(FEE_RESERVE_ATOMIC + 1n) })),
  );
  assert.equal(r.stopped?.reason, "fee_over_reserve");
  assert.equal(r.outcomes.length, 1);
});

test("runPlan: normal outcomes do not stop the run", async () => {
  const { r } = await runTwo(() => undefined);
  assert.equal(r.stopped, null);
  assert.equal(r.outcomes.length, 2);
  assert.ok(r.outcomes.every((o) => o.delivered === true));
});

test("runPlan: a per-seller refusal does not stop the run", async () => {
  const f = fakeDeps({});
  const moved: PlanEntry = { ...planEntry, serviceId: "moved", lockedRecipient: OTHER, allowlist: [] };
  const r = await runPlan([moved, second], f.deps);
  assert.equal(r.outcomes[0]!.refusal?.refused, "recipient_mismatch");
  assert.equal(r.stopped, null);
  assert.equal(r.outcomes.length, 2);
});

// ---------- review W4: ledger lock ----------

test("ledger lock: a second process cannot open the same ledger until the first releases", () => {
  const path = join(mkdtempSync(join(tmpdir(), "tempo-lock-")), "ledger.json");
  const a = new Ledger(path, PAYER_ADDRESS, 30_000n, { lock: true });
  assert.ok(existsSync(`${path}.lock`));
  assert.throws(() => new Ledger(path, PAYER_ADDRESS, 30_000n, { lock: true }), /lock exists|holds this ledger/);
  a.release();
  assert.ok(!existsSync(`${path}.lock`));
  const b = new Ledger(path, PAYER_ADDRESS, 30_000n, { lock: true });
  b.release();
  b.release(); // idempotent
});

test("ledger lock: released when the ledger fails to load", () => {
  const path = join(mkdtempSync(join(tmpdir(), "tempo-lock-")), "ledger.json");
  writeFileSync(path, JSON.stringify({ version: 1, payer: OTHER, capAtomic: "1", entries: [] }));
  assert.throws(() => new Ledger(path, PAYER_ADDRESS, 30_000n, { lock: true }), /payer differs/);
  assert.ok(!existsSync(`${path}.lock`));
});

// ---------- review W3: key file errors do not echo the file ----------

test("loadSigner: an unreadable key file fails with a fixed message that does not quote it", () => {
  const dir = mkdtempSync(join(tmpdir(), "tempo-key-"));
  const file = join(dir, "evm.json");
  const secretish = "0xdeadbeef-not-json-SECRET";
  writeFileSync(file, `{"privateKey": ${secretish}`);
  assert.throws(
    () => loadSigner(file),
    (e: Error) => /unreadable key file/.test(e.message) && !e.message.includes("SECRET") && !e.message.includes("deadbeef"),
  );
  assert.throws(() => loadSigner(join(dir, "missing.json")), /unreadable key file/);
});

// ---------- payOne: the tx of a paid response that carries none (2026-09-29, kicksdb) ----------

const sponsoredEntry: PlanEntry = { ...planEntry, sponsored: true };
const sponsoredReq = () => goodReq({ methodDetails: { chainId: 4217, feePayer: true } });
const FOUND = `0x${"d2".repeat(32)}`;

function withSearch(f: ReturnType<typeof fakeDeps>, results: string[][], known: string[] = []) {
  const seen: { from: bigint; exp: unknown }[] = [];
  let i = 0;
  f.deps.findTx = {
    head: async () => 41_772_500n,
    search: async (exp, from) => (seen.push({ from, exp }), results[Math.min(i++, results.length - 1)]!),
    known: () => known,
    tries: 3,
    waitMs: 0,
    sleep: async () => undefined,
  };
  const verified: string[] = [];
  f.deps.verify = async (h) => (verified.push(h), h === FOUND ? { settled: true, detail: "transfer found", feePaid: null } : { settled: false, detail: "receipt not found", feePaid: null });
  return { seen, verified };
}

test("payOne: a sponsored purchase answered 500 without a receipt finds its tx on chain (chain_search) and records it", async () => {
  const f = fakeDeps({ liveReq: sponsoredReq(), paidStatus: 500 });
  const s = withSearch(f, [[], [FOUND.toUpperCase().replace("0X", "0x")]]);
  const out = await payOne(sponsoredEntry, f.deps);
  assert.equal(out.result, "sent");
  assert.equal(out.httpStatus, 500);
  assert.equal(out.txHash, FOUND);
  assert.equal(out.txHashSource, "chain_search");
  assert.equal(out.settled, true);
  assert.equal(out.delivered, false);
  assert.deepEqual(s.verified, [FOUND]);
  assert.equal(s.seen[0]!.from, 41_772_500n);
  assert.deepEqual(s.seen[0]!.exp, { payer: throwaway.address, recipient: SELLER, amount: 6000n });
  const e = JSON.parse(readFileSync(f.path, "utf8")).entries[0];
  assert.equal(e.txHash, FOUND);
  assert.equal(e.settled, true);
});

test("payOne: without findTx a sponsored 500 stays settled null, as before", async () => {
  const f = fakeDeps({ liveReq: sponsoredReq(), paidStatus: 500 });
  const out = await payOne(sponsoredEntry, f.deps);
  assert.equal(out.txHash, null);
  assert.equal(out.settled, null);
});

test("payOne: two unrecorded transfers that fit, or only a tx another record carries, are not taken", async () => {
  const other = `0x${"aa".repeat(32)}`;
  const f1 = fakeDeps({ liveReq: sponsoredReq(), paidStatus: 500 });
  withSearch(f1, [[FOUND, other]]);
  const o1 = await payOne(sponsoredEntry, f1.deps);
  assert.equal(o1.txHash, null);
  assert.equal(o1.settled, null);
  const f2 = fakeDeps({ liveReq: sponsoredReq(), paidStatus: 500 });
  const s2 = withSearch(f2, [[other]], [other]);
  const o2 = await payOne(sponsoredEntry, f2.deps);
  assert.equal(o2.txHash, null);
  assert.deepEqual(s2.verified, []);
});

test("payOne: a failing search or head read changes nothing but the tx lookup", async () => {
  const f = fakeDeps({ liveReq: sponsoredReq(), paidStatus: 500 });
  withSearch(f, [[FOUND]]);
  f.deps.findTx!.head = async () => {
    throw new Error("rpc down");
  };
  const out = await payOne(sponsoredEntry, f.deps);
  assert.equal(out.result, "sent");
  assert.equal(out.settled, null);
  const g = fakeDeps({ liveReq: sponsoredReq(), paidStatus: 500 });
  withSearch(g, [[FOUND]]);
  g.deps.findTx!.search = async () => {
    throw new Error("rpc down");
  };
  const o2 = await payOne(sponsoredEntry, g.deps);
  assert.equal(o2.result, "sent");
  assert.equal(o2.settled, null);
});

test("payOne: unsponsored, the signed envelope not on chain, the search finds the transfer", async () => {
  const f = fakeDeps({ paidStatus: 502 });
  withSearch(f, [[FOUND]]);
  const out = await payOne(planEntry, f.deps);
  assert.equal(out.txHash, FOUND);
  assert.equal(out.settled, true);
  assert.equal(out.txHashSource, "chain_search");
});

test("payOne: a throwing known() or verify of the found tx leaves the outcome as without the search", async () => {
  const f = fakeDeps({ liveReq: sponsoredReq(), paidStatus: 500 });
  withSearch(f, [[FOUND]]);
  f.deps.findTx!.known = () => {
    throw new Error("a day ledger is missing");
  };
  const o1 = await payOne(sponsoredEntry, f.deps);
  assert.equal(o1.result, "sent");
  assert.equal(o1.settled, null);
  const g = fakeDeps({ liveReq: sponsoredReq(), paidStatus: 500 });
  withSearch(g, [[FOUND]]);
  g.deps.verify = async () => {
    throw new Error("rpc down");
  };
  const o2 = await payOne(sponsoredEntry, g.deps);
  assert.equal(o2.result, "sent");
  assert.equal(o2.settled, null);
});
