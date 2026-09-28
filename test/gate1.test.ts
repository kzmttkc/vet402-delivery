import { test } from "node:test";
import assert from "node:assert/strict";
import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
} from "@solana/kit";
import { getTransferCheckedInstruction } from "@solana-program/token";
import { MEMO_PROGRAM, PAYER_ADDRESS, SOLANA_MAINNET, USDC_MINT } from "../src/constants.js";
import { Budget, checkAccept, type SolAccept } from "../src/guard.js";
import { payOne, type PayDeps, type PlanEntry } from "../src/pay.js";
import { checkPaymentTransaction, usdcAta } from "../src/txcheck.js";

const SELLER = (await generateKeyPairSigner()).address;
const OTHER = (await generateKeyPairSigner()).address;
const FACILITATOR = (await generateKeyPairSigner()).address;
const FAKE_MINT = (await generateKeyPairSigner()).address;

function accept(over: Partial<SolAccept> = {}): SolAccept {
  return { scheme: "exact", network: SOLANA_MAINNET, amount: "10000", asset: USDC_MINT, payTo: SELLER, extra: { feePayer: FACILITATOR }, ...over };
}

// ---------- checkAccept (pure) ----------

test("over-price accept is refused", () => {
  assert.equal(checkAccept(accept({ amount: "100001" }), { payer: PAYER_ADDRESS, lockedPayTo: SELLER })?.refused, "price_over_cap");
  assert.equal(checkAccept(accept({ amount: "100000" }), { payer: PAYER_ADDRESS, lockedPayTo: SELLER }), null);
});

test("payTo different from the recorded 402 is refused", () => {
  assert.equal(checkAccept(accept({ payTo: OTHER }), { payer: PAYER_ADDRESS, lockedPayTo: SELLER })?.refused, "payto_mismatch");
});

test("non-USDC mint is refused", () => {
  assert.equal(checkAccept(accept({ asset: FAKE_MINT }), { payer: PAYER_ADDRESS, lockedPayTo: SELLER })?.refused, "mint_mismatch");
});

test("fee payer = vet402 is refused; missing fee payer is refused", () => {
  assert.equal(checkAccept(accept({ extra: { feePayer: PAYER_ADDRESS } }), { payer: PAYER_ADDRESS, lockedPayTo: SELLER })?.refused, "fee_payer_is_self");
  assert.equal(checkAccept(accept({ extra: {} }), { payer: PAYER_ADDRESS, lockedPayTo: SELLER })?.refused, "fee_payer_missing");
});

test("price raised above the recorded amount is refused; off-curve payTo is refused", async () => {
  assert.equal(checkAccept(accept({ amount: "20000" }), { payer: PAYER_ADDRESS, lockedPayTo: SELLER, lockedAmount: "10000" })?.refused, "price_raised");
  const ata = await usdcAta(SELLER);
  assert.equal(checkAccept(accept({ payTo: ata }), { payer: PAYER_ADDRESS, lockedPayTo: ata })?.refused, "payto_off_curve");
});

// ---------- Budget ----------

test("budget: per-purchase, count and total caps", () => {
  const b = new Budget(null);
  assert.equal((b.reserve(100_001n, "h0") as { refused: string }).refused, "price_over_cap");
  for (let i = 0; i < 10; i++) assert.ok("ok" in b.reserve(100_000n, `h${i}`), `purchase ${i}`);
  assert.equal(b.spent, 1_000_000n);
  assert.equal((b.reserve(1n, "h10") as { refused: string }).refused, "purchase_count_reached");

  const t = new Budget(null, 1_000_000n, 20); // count cap out of the way: only the total cap can trip
  for (let i = 0; i < 9; i++) t.reserve(100_000n, `h${i}`); // 0.90
  assert.ok("ok" in t.reserve(50_000n, "h9a")); // 0.95
  assert.equal((t.reserve(100_000n, "h9b") as { refused: string }).refused, "total_cap_reached");
});

test("budget: same host twice is refused; chain spend raises the floor", () => {
  const b = new Budget(null);
  assert.ok("ok" in b.reserve(10_000n, "a"));
  assert.equal((b.reserve(10_000n, "a") as { refused: string }).refused, "already_bought");
  const c = new Budget(null);
  c.setBaselineIfMissing(50_000_000n);
  // chain says 0.95 already left the wallet, ledger says 0
  assert.equal((c.reserve(100_000n, "x", 49_050_000n) as { refused: string }).refused, "total_cap_reached");
});

// ---------- payOne: refusals happen before the signer is touched ----------

function fake402(accepts: Record<string, unknown>[]): typeof fetch {
  return (async () => {
    const pr = { x402Version: 2, resource: { url: "https://seller.test/x" }, accepts };
    return new Response(JSON.stringify({}), {
      status: 402,
      headers: { "content-type": "application/json", "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") },
    });
  }) as unknown as typeof fetch;
}

function depsWith(f: typeof fetch, budget = new Budget(null)) {
  let signerCalls = 0;
  let paidRequests = 0;
  const wrapped = (async (url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    if (h.has("PAYMENT-SIGNATURE") || h.has("X-PAYMENT")) paidRequests++;
    return f(url, init);
  }) as unknown as typeof fetch;
  const deps: PayDeps = {
    fetch: wrapped,
    payer: PAYER_ADDRESS,
    budget,
    createPayment: async () => {
      signerCalls++;
      throw new Error("signer must not be reached in this test");
    },
    checkTx: async () => ({ ok: false, detail: "unused" }),
    readBalances: async () => ({ lamports: 100_000_000n, usdcAtomic: 50_000_000n }),
    waitForSettlement: async () => null,
  };
  return { deps, counts: () => ({ signerCalls, paidRequests }) };
}

const entry: PlanEntry = {
  host: "seller.test",
  requestUrl: "https://seller.test/x",
  exampleInput: null,
  lock: { payTo: SELLER, amount: "10000", asset: USDC_MINT, network: SOLANA_MAINNET, feePayer: FACILITATOR },
};

const raw = (a: SolAccept) => ({ ...a }) as unknown as Record<string, unknown>;

for (const [name, acc, reason] of [
  ["over-price", accept({ amount: "150000" }), "price_over_cap"],
  ["payTo mismatch", accept({ payTo: OTHER }), "payto_mismatch"],
  ["mint mismatch", accept({ asset: FAKE_MINT }), "mint_mismatch"],
  ["fee payer is vet402", accept({ extra: { feePayer: PAYER_ADDRESS } }), "fee_payer_is_self"],
] as const) {
  test(`payOne refuses ${name} before signing or sending`, async () => {
    const { deps, counts } = depsWith(fake402([raw(acc)]));
    const rec = await payOne(entry, deps);
    assert.equal(rec.outcome, "refused");
    assert.equal(rec.refusal?.refused, reason);
    assert.deepEqual(counts(), { signerCalls: 0, paidRequests: 0 });
  });
}

test("payOne refuses when the total cap is reached, before signing or sending", async () => {
  const budget = new Budget(null);
  for (let i = 0; i < 9; i++) budget.reserve(100_000n, `prev${i}`); // 0.90 spent
  budget.reserve(95_000n, "prev9x"); // 0.995 spent, 10 purchases
  const { deps, counts } = depsWith(fake402([raw(accept())]), budget);
  const rec = await payOne(entry, deps);
  assert.equal(rec.outcome, "refused");
  assert.match(rec.refusal!.refused, /total_cap_reached|purchase_count_reached/);
  assert.deepEqual(counts(), { signerCalls: 0, paidRequests: 0 });

  const b3 = new Budget(null, 1_000_000n, 11); // allow 11 purchases so only the total cap can trip
  for (let i = 0; i < 9; i++) b3.reserve(100_000n, `q${i}`);
  b3.reserve(95_000n, "q9");
  const d3 = depsWith(fake402([raw(accept())]), b3);
  const r3 = await payOne(entry, d3.deps);
  assert.equal(r3.refusal?.refused, "total_cap_reached");
  assert.deepEqual(d3.counts(), { signerCalls: 0, paidRequests: 0 });
});

test("payOne: a transaction that fails the read-back is not sent and the budget is released", async () => {
  const budget = new Budget(null);
  const { deps, counts } = depsWith(fake402([raw(accept())]), budget);
  deps.createPayment = async () => ({ headers: { "PAYMENT-SIGNATURE": "x" }, txBase64: "AAAA" });
  deps.checkTx = async () => ({ ok: false, detail: "destination is not ATA(payTo)" });
  const rec = await payOne(entry, deps);
  assert.equal(rec.outcome, "not_sent");
  assert.equal(counts().paidRequests, 0);
  assert.equal(budget.spent, 0n);
});

// ---------- transaction read-back ----------

test("tx read-back accepts the expected transfer and rejects a wrong destination, amount or fee payer", async () => {
  const payer = await generateKeyPairSigner();
  const mk = async (feePayer: string, payTo: string, amount: bigint) => {
    const src = await usdcAta(payer.address);
    const dst = await usdcAta(payTo);
    const tx = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(address(feePayer), m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 0n }, m),
      (m) =>
        appendTransactionMessageInstructions(
          [
            getTransferCheckedInstruction({ source: address(src), mint: address(USDC_MINT), destination: address(dst), authority: payer, amount, decimals: 6 }),
            { programAddress: address(MEMO_PROGRAM), data: new TextEncoder().encode("00112233445566778899aabbccddeeff") },
          ],
          m,
        ),
    );
    return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(tx));
  };
  const a = accept();
  const good = await checkPaymentTransaction(await mk(FACILITATOR, SELLER, 10_000n), a, payer.address);
  assert.equal(good.ok, true, JSON.stringify(good));
  if (good.ok) assert.equal(good.facts.memo, "00112233445566778899aabbccddeeff");

  const wrongDest = await checkPaymentTransaction(await mk(FACILITATOR, OTHER, 10_000n), a, payer.address);
  assert.equal(wrongDest.ok, false);
  const wrongAmount = await checkPaymentTransaction(await mk(FACILITATOR, SELLER, 10_001n), a, payer.address);
  assert.equal(wrongAmount.ok, false);
  const selfFee = await checkPaymentTransaction(await mk(payer.address, SELLER, 10_000n), accept({ extra: { feePayer: payer.address } }), payer.address);
  assert.equal(selfFee.ok, false);
});
