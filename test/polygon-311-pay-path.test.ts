/**
 * 3.11 on the purchase functions themselves: createChainPayment and buyOneOnChain for Polygon (eip155:137) and
 * Monad (eip155:143), paying mode (dryRun false).
 *
 * The chain specs are written out here from the 3.11 memo's library values instead of read from EVM_CHAINS, so this
 * file loads and runs on a tree that has no Polygon or Monad entry: on such a tree the assertions below fail by what
 * the purchase path does (it signs), not by a missing import. The signer is a throwaway key that holds nothing on
 * any chain; the seller is an in-process fetch; nothing leaves the process and no real key is read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { EVM_CHAINS, type EvmChainSpec } from "../src/evm/chains.js";
import { buyOneOnChain, createChainPayment, type ChainBuyDeps, type ChainBuyEntry, type EvmAccept, type TypedDataSigner } from "../src/evm/evm-buy.js";
import { Budget } from "../src/guard.js";

const SELLER = getAddress("0x50ab2018c06c6E4eAA9BA52057Eb55eD284912fc");
const POLYGON_USDC = getAddress("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359");
const MONAD_USDC = getAddress("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
const TX = `0x${"ab".repeat(32)}` as Hex;
const PRICE = "5000";

/** Polygon PoS as the lane must hold it (3.11 memo, @x402/evm 2.27.0 values). */
const POLYGON = {
  ...EVM_CHAINS.base,
  key: "polygon",
  label: "Polygon",
  caip2: "eip155:137",
  chainId: 137,
  v1Names: ["polygon", "polygon-pos"],
  asset: POLYGON_USDC,
  assetSymbol: "USDC",
  assetDecimals: 6,
  domain: { name: "USD Coin", version: "2" },
  libraryDefaultAsset: true,
} as unknown as EvmChainSpec;

/** Monad as a caller could build it: the purchase path must refuse it while 3.11.0 is FAIL. */
const MONAD = { ...POLYGON, key: "monad", label: "Monad", caip2: "eip155:143", chainId: 143, v1Names: ["monad"], asset: MONAD_USDC, domain: { name: "USDC", version: "2" } } as unknown as EvmChainSpec;

const accept = (spec: EvmChainSpec, over: Partial<EvmAccept> = {}): EvmAccept => ({
  scheme: "exact",
  network: spec.caip2,
  amount: PRICE,
  asset: spec.asset,
  payTo: SELLER,
  maxTimeoutSeconds: 300,
  extra: { ...spec.domain },
  ...over,
});

const entry: ChainBuyEntry = { agentId: "host:seller.test", resource: "https://seller.test/x", method: "GET", query: null, body: null, lock: { payTo: SELLER, amount: PRICE } };

/** An in-process seller: 402 first; a paid request gets `paid` (status, body, settle header). */
function seller(spec: EvmChainSpec, paid: { status: number; body: string; settle: Record<string, unknown> | null } = { status: 200, body: '{"ok":true}', settle: { success: true, transaction: TX, network: spec.caip2 } }) {
  let paidCalls = 0;
  const f = (async (_u: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    if (h.has("PAYMENT-SIGNATURE") || h.has("X-PAYMENT")) {
      paidCalls++;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (paid.settle) headers["PAYMENT-RESPONSE"] = Buffer.from(JSON.stringify(paid.settle)).toString("base64");
      return new Response(paid.body, { status: paid.status, headers });
    }
    const pr = { x402Version: 2, resource: { url: entry.resource }, accepts: [accept(spec)] };
    return new Response("{}", { status: 402, headers: { "content-type": "application/json", "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") } });
  }) as unknown as typeof fetch;
  return { f, paid: () => paidCalls };
}

/** A throwaway signer that counts every signature request. */
function spySigner() {
  const k = privateKeyToAccount(generatePrivateKey());
  let signs = 0;
  const signer: TypedDataSigner = { address: k.address, signTypedData: async (m) => (signs++, k.signTypedData(m as never)) };
  return { signer, address: k.address as Address, signs: () => signs };
}

function paying(f: typeof fetch, s: ReturnType<typeof spySigner>, over: Partial<ChainBuyDeps> = {}): ChainBuyDeps {
  return {
    fetch: f,
    payer: s.address,
    signer: s.signer,
    budget: new Budget(null, 60_000n, 10, 10_000n),
    readAssetBalance: async () => 1_000_000n,
    verifySettlement: async () => ({ ok: true, from: s.address }),
    dryRun: false,
    maxPerAtomic: 10_000n,
    ...over,
  };
}

/** The gates a paying Polygon run passes in, all passing: the outflow is within the ledger and the sign gate is clear. */
const gatesPass = { outflowCheck: { ledgerCommitted: 0n, chainSpent: 0n }, beforeSign: () => null };

test("3.11 pay path: the lane's Polygon spec is the one these tests write out (eip155:137, USDC, USD Coin v2)", () => {
  const p = (EVM_CHAINS as Record<string, EvmChainSpec>).polygon;
  assert.ok(p, "EVM_CHAINS has no polygon entry");
  assert.equal(p.caip2, POLYGON.caip2);
  assert.equal(p.chainId, POLYGON.chainId);
  assert.equal(p.asset, POLYGON.asset);
  assert.deepEqual(p.domain, POLYGON.domain);
  assert.equal((EVM_CHAINS as Record<string, unknown>).monad, undefined, "Monad has no chain entry while 3.11.0 is FAIL");
});

test("3.11 pay path: createChainPayment does not sign on Monad (eip155:143) while 3.11.0 is FAIL", async () => {
  const s = spySigner();
  const pr = { x402Version: 2, resource: { url: entry.resource }, accepts: [accept(MONAD)] } as never;
  await assert.rejects(createChainPayment(MONAD, s.signer, pr, accept(MONAD), 10_000n), /3\.11\.0 is FAIL/);
  assert.equal(s.signs(), 0, "a Monad EIP-3009 authorization was signed");
});

test("3.11 pay path: createChainPayment does not sign on Polygon without the 3.11 sign gate", async () => {
  const s = spySigner();
  const pr = { x402Version: 2, resource: { url: entry.resource }, accepts: [accept(POLYGON)] } as never;
  await assert.rejects(createChainPayment(POLYGON, s.signer, pr, accept(POLYGON), 10_000n), /3\.11 pay gates/);
  assert.equal(s.signs(), 0, "a Polygon EIP-3009 authorization was signed with no gate");
});

test("3.11 pay path: createChainPayment does not sign on Polygon when the sign gate names a stop", async () => {
  const s = spySigner();
  const pr = { x402Version: 2, resource: { url: entry.resource }, accepts: [accept(POLYGON)] } as never;
  const opts = { signGate: () => "Tempo is stopped (not_settled)" };
  await assert.rejects((createChainPayment as (...a: unknown[]) => Promise<unknown>)(POLYGON, s.signer, pr, accept(POLYGON), 10_000n, opts), /Tempo is stopped/);
  assert.equal(s.signs(), 0);
});

test("3.11 pay path: buyOneOnChain on Monad refuses before reading the seller, signing or paying", async () => {
  const s = spySigner();
  const sel = seller(MONAD);
  const r = await buyOneOnChain(MONAD, entry, paying(sel.f, s, gatesPass));
  assert.notEqual(r.outcome, "sent");
  assert.match(r.refusal?.detail ?? "", /3\.11\.0 is FAIL/);
  assert.equal(s.signs(), 0);
  assert.equal(sel.paid(), 0);
});

test("3.11 pay path: USDC that left the payer beyond the Polygon ledger stops buyOneOnChain before the signature (chain_spend_exceeds_ledger)", async () => {
  const s = spySigner();
  const sel = seller(POLYGON);
  const budget = new Budget(null, 60_000n, 10, 10_000n);
  const r = await buyOneOnChain(POLYGON, entry, paying(sel.f, s, { budget, beforeSign: () => null, outflowCheck: { ledgerCommitted: 0n, chainSpent: 5_000n } }));
  assert.equal(r.outcome, "refused");
  assert.equal(r.refusal?.refused, "chain_spend_exceeds_ledger");
  assert.match(r.refusal?.detail ?? "", /on-chain outflow 5000 > ledger 0/);
  assert.equal(s.signs(), 0);
  assert.equal(sel.paid(), 0);
  assert.equal(budget.count, 0, "nothing was reserved or committed");
});

test("3.11 pay path: a paying Polygon purchase with no outflow check, or an unreadable one, signs nothing", async () => {
  for (const outflowCheck of [undefined, () => Promise.reject(new Error("eth_getLogs refused"))] as const) {
    const s = spySigner();
    const sel = seller(POLYGON);
    const r = await buyOneOnChain(POLYGON, entry, paying(sel.f, s, { beforeSign: () => null, ...(outflowCheck ? { outflowCheck } : {}) }));
    assert.equal(r.outcome, "refused", String(outflowCheck));
    assert.equal(r.refusal?.refused, "signing_blocked");
    assert.equal(s.signs(), 0);
    assert.equal(sel.paid(), 0);
  }
});

test("3.11 pay path: a paying Polygon purchase with no sign gate signs nothing", async () => {
  const s = spySigner();
  const sel = seller(POLYGON);
  const r = await buyOneOnChain(POLYGON, entry, paying(sel.f, s, { outflowCheck: { ledgerCommitted: 0n, chainSpent: 0n } }));
  assert.notEqual(r.outcome, "sent");
  assert.equal(s.signs(), 0);
  assert.equal(sel.paid(), 0);
});

test("3.11 pay path: a Polygon spec under another key name is still gated (the gate keys on eip155:137, not the name)", async () => {
  const s = spySigner();
  const sel = seller(POLYGON);
  const renamed = { ...POLYGON, key: "polygon-pos" } as unknown as EvmChainSpec;
  const r = await buyOneOnChain(renamed, entry, paying(sel.f, s));
  assert.notEqual(r.outcome, "sent");
  assert.equal(s.signs(), 0);
  assert.equal(sel.paid(), 0);
});

// ---------- 3.11-2: delivered and not delivered are told apart on the paid answer ----------

const DELIVERY_CASES: { name: string; paid: { status: number; body: string; settle: Record<string, unknown> | null }; verified?: boolean; delivered: boolean; settledOnChain: boolean }[] = [
  { name: "200 with a body and a settlement read back on chain", paid: { status: 200, body: '{"ok":true}', settle: { success: true, transaction: TX, network: "eip155:137" } }, delivered: true, settledOnChain: true },
  { name: "200 with an empty body (settled, nothing came back)", paid: { status: 200, body: "", settle: { success: true, transaction: TX, network: "eip155:137" } }, delivered: false, settledOnChain: true },
  { name: "502 after settling", paid: { status: 502, body: "bad gateway", settle: { success: true, transaction: TX, network: "eip155:137" } }, delivered: false, settledOnChain: true },
  { name: "200 with a body but no settlement tx in the answer", paid: { status: 200, body: '{"ok":true}', settle: null }, delivered: false, settledOnChain: false },
  { name: "200 with a body, but the named tx is not a transfer from the payer", paid: { status: 200, body: '{"ok":true}', settle: { success: true, transaction: TX, network: "eip155:137" } }, verified: false, delivered: false, settledOnChain: false },
];

for (const c of DELIVERY_CASES) {
  test(`3.11-2 pay path: buyOneOnChain on Polygon, ${c.name}: delivered ${c.delivered}`, async () => {
    const s = spySigner();
    const sel = seller(POLYGON, c.paid);
    const verifySettlement = async () => (c.verified === false ? { ok: false, reason: "no Transfer from the payer in that tx" } : { ok: true, from: s.address });
    const r = await buyOneOnChain(POLYGON, entry, paying(sel.f, s, { ...gatesPass, verifySettlement }));
    assert.equal(r.outcome, "sent");
    assert.equal(s.signs(), 1, "one signature by the throwaway key, sent only to the in-process seller");
    assert.equal(sel.paid(), 1);
    assert.equal(r.settledOnChain, c.settledOnChain);
    assert.equal(r.delivered, c.delivered);
    assert.equal(r.response?.status, c.paid.status);
  });
}
