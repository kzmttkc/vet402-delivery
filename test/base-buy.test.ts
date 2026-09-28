import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Budget } from "../src/guard.js";
import {
  buyOne,
  checkBaseAccept,
  createBasePayment,
  fencedSigner,
  type BuyDeps,
  type BuyEntry,
  type BuyRecord,
  type EvmAccept,
  type TypedDataSigner,
} from "../src/evm/base-buy.js";
import { feedbackEligibility } from "../src/evm/base-feedback.js";
import { planCandidates, type ExportRow } from "../src/evm/base-candidates.js";
import { BASE_USDC } from "../src/evm/erc8004.js";

const PAYER = getAddress("0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51");
const SELLER = getAddress("0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0");
const OTHER = getAddress("0x1111111111111111111111111111111111111111");
const TX = ("0x" + "ab".repeat(32)) as Hex;

const acc = (over: Partial<EvmAccept> = {}): EvmAccept => ({
  scheme: "exact",
  network: "eip155:8453",
  amount: "1000",
  asset: BASE_USDC,
  payTo: SELLER,
  maxTimeoutSeconds: 300,
  extra: { name: "USD Coin", version: "2" },
  ...over,
});
const ctx = { payer: PAYER, lockedPayTo: SELLER, lockedAmount: "1000", agentWallet: SELLER };

// ---------- caps ----------

test("per-purchase cap: 0.10 passes, 0.100001 is refused before any signature", () => {
  assert.equal(checkBaseAccept(acc({ amount: "100000" }), { ...ctx, lockedAmount: "100000" }), null);
  assert.equal(checkBaseAccept(acc({ amount: "100001" }), { ...ctx, lockedAmount: "100001" })?.refused, "price_over_cap");
  assert.equal(checkBaseAccept(acc({ amount: "2000" }), ctx)?.refused, "price_raised");
});

test("total 1.00, 10 purchases, one per seller (ledger)", () => {
  const b = new Budget(null);
  for (let i = 0; i < 10; i++) assert.ok("ok" in b.reserve(100_000n, `base-payto:${i}`), `purchase ${i}`);
  assert.equal((b.reserve(1n, "base-payto:x") as { refused: string }).refused, "purchase_count_reached");
  const t = new Budget(null, 1_000_000n, 100);
  for (let i = 0; i < 10; i++) t.reserve(100_000n, `k${i}`);
  assert.equal((t.reserve(1n, "k-last") as { refused: string }).refused, "total_cap_reached");
  const o = new Budget(null);
  o.reserve(1000n, "base-payto:0xabc");
  assert.equal((o.reserve(1000n, "base-payto:0xabc") as { refused: string }).refused, "already_bought");
});

// ---------- payTo lock ----------

test("payTo mismatch and payTo != agentWallet are refused", () => {
  assert.equal(checkBaseAccept(acc({ payTo: OTHER }), ctx)?.refused, "payto_mismatch");
  assert.equal(checkBaseAccept(acc(), { ...ctx, agentWallet: OTHER })?.refused, "payto_not_agent_wallet");
  assert.equal(checkBaseAccept(acc({ payTo: PAYER }), { ...ctx, lockedPayTo: PAYER, agentWallet: PAYER })?.refused, "self_dealing");
});

test("only EIP-3009 on Base USDC with the USDC domain and a short validity", () => {
  assert.equal(checkBaseAccept(acc({ extra: { name: "USD Coin", version: "2", assetTransferMethod: "permit2" } }), ctx)?.refused, "not_eip3009");
  assert.equal(checkBaseAccept(acc({ asset: OTHER }), ctx)?.refused, "asset_mismatch");
  assert.equal(checkBaseAccept(acc({ network: "eip155:1" }), ctx)?.refused, "network_mismatch");
  assert.equal(checkBaseAccept(acc({ extra: { name: "USDC", version: "2" } }), ctx)?.refused, "domain_mismatch");
  assert.equal(checkBaseAccept(acc({ maxTimeoutSeconds: 86400 }), ctx)?.refused, "timeout_invalid");
});

// ---------- the fenced signer ----------

const throwaway = () => privateKeyToAccount(generatePrivateKey());
const typed = (from: Address, over: { to?: Address; value?: bigint; primaryType?: string; chainId?: number } = {}) => ({
  domain: { name: "USD Coin", version: "2", chainId: over.chainId ?? 8453, verifyingContract: BASE_USDC },
  types: {},
  primaryType: over.primaryType ?? "TransferWithAuthorization",
  message: { from, to: over.to ?? SELLER, value: over.value ?? 1000n, validAfter: 0n, validBefore: BigInt(Math.floor(Date.now() / 1000) + 300), nonce: "0x" + "00".repeat(32) },
});

test("fenced signer signs only the locked transfer, once", async () => {
  const k = throwaway();
  const spy: TypedDataSigner = { address: k.address, signTypedData: async () => "0x01" as Hex };
  await assert.rejects(fencedSigner(spy, { payTo: SELLER, amount: "1000" }).signTypedData(typed(k.address, { to: OTHER })), /locked payTo/);
  await assert.rejects(fencedSigner(spy, { payTo: SELLER, amount: "1000" }).signTypedData(typed(k.address, { value: 2000n })), /value/);
  await assert.rejects(fencedSigner(spy, { payTo: SELLER, amount: "1000" }).signTypedData(typed(k.address, { primaryType: "PermitWitnessTransferFrom" })), /primaryType/);
  await assert.rejects(fencedSigner(spy, { payTo: SELLER, amount: "1000" }).signTypedData(typed(k.address, { chainId: 1 })), /chainId/);
  const f = fencedSigner(spy, { payTo: SELLER, amount: "1000" });
  await f.signTypedData(typed(k.address));
  await assert.rejects(f.signTypedData(typed(k.address)), /already signed/);
});

test("createBasePayment: real EIP-3009 signature, verified, locked fields", async () => {
  const k = throwaway();
  const pr = { x402Version: 2, resource: { url: "https://seller.test/x" }, accepts: [acc()] } as never;
  const p = await createBasePayment(k, pr, acc());
  assert.equal(p.authorization.to, SELLER);
  assert.equal(p.authorization.value, "1000");
  assert.equal(getAddress(p.authorization.from), k.address);
  assert.ok(Object.keys(p.headers).length > 0);
});

// ---------- buyOne ----------

function fake402(accepts: EvmAccept[], paid?: { status: number; body: string; tx?: string }) {
  let paidCalls = 0;
  const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    if (h.has("PAYMENT-SIGNATURE") || h.has("X-PAYMENT")) {
      paidCalls++;
      const settle = Buffer.from(JSON.stringify({ success: true, transaction: paid?.tx ?? TX, network: "eip155:8453" })).toString("base64");
      return new Response(paid?.body ?? "{}", { status: paid?.status ?? 200, headers: { "content-type": "application/json", "PAYMENT-RESPONSE": settle } });
    }
    const pr = { x402Version: 2, resource: { url: "https://seller.test/x" }, accepts };
    return new Response("{}", { status: 402, headers: { "content-type": "application/json", "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") } });
  }) as unknown as typeof fetch;
  return { f, paid: () => paidCalls };
}

const entry = (over: Partial<BuyEntry> = {}): BuyEntry => ({
  agentId: "94639",
  resource: "https://seller.test/x",
  method: "GET",
  query: null,
  body: null,
  agentWallet: SELLER,
  lock: { payTo: SELLER, amount: "1000" },
  ...over,
});

function deps(f: typeof fetch, over: Partial<BuyDeps> = {}) {
  const k = throwaway();
  let signs = 0;
  const signer: TypedDataSigner = { address: k.address, signTypedData: async (m) => (signs++, k.signTypedData(m as never)) };
  const d: BuyDeps = {
    fetch: f,
    payer: k.address,
    signer,
    budget: new Budget(null),
    readUsdcBalance: async () => 5_000_000n,
    readAgentWallet: async () => SELLER,
    verifySettlement: async () => ({ ok: true, from: k.address }),
    dryRun: false,
    ...over,
  };
  return { d, signs: () => signs };
}

test("buyOne: payTo in the live 402 differs from the lock -> refused, nothing signed or sent", async () => {
  const s = fake402([acc({ payTo: OTHER })]);
  const x = deps(s.f);
  const r = await buyOne(entry(), x.d);
  assert.equal(r.refusal?.refused, "payto_mismatch");
  assert.equal(x.signs(), 0);
  assert.equal(s.paid(), 0);
});

test("buyOne: agentWallet changed on chain -> refused before the 402", async () => {
  const s = fake402([acc()]);
  const x = deps(s.f, { readAgentWallet: async () => OTHER });
  const r = await buyOne(entry(), x.d);
  assert.equal(r.refusal?.refused, "payto_not_agent_wallet");
  assert.equal(x.signs(), 0);
});

test("buyOne dry run: signs with the given key, sends nothing", async () => {
  const s = fake402([acc()]);
  const x = deps(s.f, { dryRun: true });
  const r = await buyOne(entry(), x.d);
  assert.equal(r.outcome, "would_pay");
  assert.equal(x.signs(), 1);
  assert.equal(s.paid(), 0);
});

// ---------- no feedback unless delivered ----------

async function paidRecord(paid: { status: number; body: string }, settled = true): Promise<{ r: BuyRecord; payer: Address }> {
  const s = fake402([acc()], paid);
  const x = deps(s.f, { verifySettlement: async () => (settled ? { ok: true } : { ok: false, reason: "no transfer" }) });
  x.d.verifySettlement = settled ? async () => ({ ok: true, from: x.d.payer }) : x.d.verifySettlement;
  const r = await buyOne(entry(), x.d);
  return { r, payer: x.d.payer };
}

test("delivered + settled -> feedback allowed; 500, empty body, unsettled, dry-run -> not written", async () => {
  const ok = await paidRecord({ status: 200, body: '{"a":1}' });
  assert.equal(ok.r.delivered, true);
  assert.equal(feedbackEligibility(ok.r, ok.payer).ok, true);

  const e500 = await paidRecord({ status: 500, body: "err" });
  assert.equal(e500.r.delivered, false);
  assert.match(feedbackEligibility(e500.r, e500.payer).reason, /not delivered/);

  const empty = await paidRecord({ status: 200, body: "  " });
  assert.equal(feedbackEligibility(empty.r, empty.payer).ok, false);

  const uns = await paidRecord({ status: 200, body: "{}" }, false);
  assert.equal(uns.r.settledOnChain, false);
  assert.match(feedbackEligibility(uns.r, uns.payer).reason, /not settled/);

  const dry: BuyRecord = { ...ok.r, outcome: "would_pay" };
  assert.equal(feedbackEligibility(dry, ok.payer).ok, false, "a dry-run record is never writable");
  assert.equal(feedbackEligibility(dry, ok.payer, { allowDryRunRecord: true }).placeholder, true);

  assert.match(feedbackEligibility(ok.r, PAYER === ok.payer ? OTHER : PAYER).reason, /not the submitter/);
});

// ---------- candidates ----------

test("candidates: one per agentWallet, only listings vet402 saw delivered", () => {
  const listing = (resource: string, payTo: string, amount = "1000") =>
    ({ resource, accepts: [{ scheme: "exact", network: "eip155:8453", asset: BASE_USDC, payTo, amount }] }) as never;
  const row = (key: string, status: string, http: string, at: string): ExportRow => ({
    attempted_at: at, resource_key: key, network: "eip155:8453", status, amount_units: "1000", tx_hash: TX, http_status_paid: http, l2_schema: "match", request_body: "none", request_query: "",
  });
  const c = planCandidates(
    [
      { agentId: "1", owner: SELLER, agentWallet: SELLER },
      { agentId: "2", owner: OTHER, agentWallet: SELLER },
      { agentId: "3", owner: OTHER, agentWallet: OTHER },
      { agentId: "4", owner: OTHER, agentWallet: "0x0000000000000000000000000000000000000000" },
    ],
    [listing("https://a.test/ok", SELLER), listing("https://b.test/bad", OTHER)],
    [row("a.test/ok", "settled", "200", "2026-09-20T00:00:00Z"), row("b.test/bad", "settled", "500", "2026-09-20T00:00:00Z")],
  );
  assert.equal(c[0]!.chosen?.resource, "https://a.test/ok");
  assert.match(c[1]!.excluded ?? "", /same agentWallet as agent 1/);
  assert.match(c[2]!.excluded ?? "", /no delivery/);
  assert.match(c[3]!.excluded ?? "", /agentWallet not set/);
});
