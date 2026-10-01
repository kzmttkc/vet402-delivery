/**
 * The example escrow (programs/delivery-escrow-example) on a local solana-test-validator, with observation-roots
 * holding the real roots of 2026-09-28 to 2026-09-30 and the real published records (data/records) and proofs.
 *
 *   npm run program:build && npm run program:test
 *
 * Needs solana-test-validator on PATH (or SOLANA_BIN pointing at its folder). Its own ports, so it can run next
 * to program.test.ts.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import type { Hex } from "viem";
import { jsonRpc, type Rpc } from "../../src/chain.js";
import { observationDigest } from "../../src/receipt/eip712.js";
import { leafHash } from "../../src/receipt/merkle.js";
import { fieldsFromObservation, initializeIx, postRootIx, ROOTS_PROGRAM as ROOTS } from "../../src/receipt/roots-program.js";
import { postRootArgsFromRecord, sendPostRoot } from "../../src/receipt/roots-post.js";
import { customError, sendIxs, simulateIxs } from "../../src/receipt/roots-tx.js";
import type { Observation } from "../../src/receipt/types.js";
import {
  ALL_STRING_FIELDS,
  decodeEscrow,
  decodeTokenAccount,
  depositIx,
  ESCROW_EXAMPLE_PROGRAM as ESCROW,
  escrowPda,
  purchaseOf,
  reclaimIx,
  settleIx,
  settleWithRecordIx,
  vaultPda,
  type Purchase,
} from "../../src/escrow/escrow-program.js";
import { ata, createAtaIx, createMintIxs, mintToIx, transferLamportsIx } from "../../src/escrow/test-token.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const DEPLOY = join(REPO, "solana-program/target/deploy");
const PORT = Number(process.env.ESCROW_VALIDATOR_PORT ?? 18999);
const URL = `http://127.0.0.1:${PORT}`;
const bin = (name: string) => (process.env.SOLANA_BIN ? join(process.env.SOLANA_BIN, name) : name);

// Anchor custom errors start at 6000, in declaration order.
const X = { ZeroAmount: 6000, DeadlinePassed: 6001, PayToNotSeller: 6002, NotTokenAccount: 6003, OtherPurchase: 6004, OtherAmount: 6005, VerdictSettlesNothing: 6006, WrongDestination: 6007, DeadlineNotReached: 6008 };
const ROOTS_NOT_IN_ROOT = 6009;
const ANCHOR_CONSTRAINT_HAS_ONE = 2001;

const DAYS = ["2026-09-28", "2026-09-29", "2026-09-30"] as const;
function readDay(day: string): Observation[] {
  const dir = join(REPO, "data/records", day);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Observation)
    .sort((a, b) => a.observer.sequence - b.observer.sequence);
}
const records = DAYS.flatMap((d) => readDay(d)).filter((o) => o.payment.network.startsWith("solana:"));
const delivered = records.filter((o) => o.verdict.code === "DELIVERED");
const notDelivered = records.filter((o) => o.verdict.code === "NOT_DELIVERED");

let validator: ChildProcess;
let ledger: string;
let rpc: Rpc;
let upgradeAuthority: KeyPairSigner;
let poster: KeyPairSigner;
let buyer: KeyPairSigner;
let cranker: KeyPairSigner;
let mintKey: KeyPairSigner;
let mint: string;
let buyerTokens: string;

async function airdrop(to: string, sol: number) {
  const sig = (await rpc("requestAirdrop", [to, sol * 1e9])) as string;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const st = (await rpc("getSignatureStatuses", [[sig]])) as { value: ({ confirmationStatus: string | null } | null)[] };
    if (st.value[0]?.confirmationStatus === "confirmed" || st.value[0]?.confirmationStatus === "finalized") return;
  }
  throw new Error("airdrop not confirmed");
}

async function accountData(addr: string): Promise<Uint8Array | null> {
  const r = (await rpc("getAccountInfo", [addr, { encoding: "base64", commitment: "confirmed" }])) as { value: { data: [string, string] } | null };
  return r.value ? Uint8Array.from(Buffer.from(r.value.data[0], "base64")) : null;
}
async function tokenBalance(addr: string): Promise<bigint> {
  const d = await accountData(addr);
  return d ? decodeTokenAccount(d).amount : 0n;
}
async function lamports(addr: string): Promise<bigint> {
  return BigInt(((await rpc("getBalance", [addr, { commitment: "confirmed" }])) as { value: number }).value);
}
async function chainTime(): Promise<bigint> {
  const slot = (await rpc("getSlot", [{ commitment: "confirmed" }])) as number;
  return BigInt((await rpc("getBlockTime", [slot])) as number);
}

async function ensureAta(owner: string): Promise<string> {
  const r = await sendIxs(rpc, cranker, [await createAtaIx(cranker, owner, mint)]);
  assert.equal(r.err, null, r.logs.join("\n"));
  return ata(owner, mint);
}

async function deposit(p: Purchase, opts: { by?: KeyPairSigner; tokens?: string; deadline?: bigint } = {}) {
  const by = opts.by ?? buyer;
  return sendIxs(rpc, by, [
    await depositIx({ program: ESCROW, buyer: by.address, buyerTokens: opts.tokens ?? buyerTokens, mint, purchase: p, deadline: opts.deadline ?? (await chainTime()) + 3600n }),
  ]);
}

before(async () => {
  upgradeAuthority = await generateKeyPairSigner();
  poster = await generateKeyPairSigner();
  buyer = await generateKeyPairSigner();
  cranker = await generateKeyPairSigner();
  mintKey = await generateKeyPairSigner();
  mint = mintKey.address;
  ledger = mkdtempSync(join(tmpdir(), "escrow-ledger-"));
  validator = spawn(
    bin("solana-test-validator"),
    [
      "--reset",
      "--quiet",
      "--ledger", ledger,
      "--rpc-port", String(PORT),
      "--faucet-port", String(PORT + 1012),
      "--gossip-port", String(PORT + 15),
      "--dynamic-port-range", `${PORT + 20}-${PORT + 60}`,
      "--upgradeable-program", ROOTS, join(DEPLOY, "observation_roots.so"), upgradeAuthority.address,
      "--bpf-program", ESCROW, join(DEPLOY, "delivery_escrow_example.so"),
    ],
    { stdio: "ignore" },
  );
  rpc = jsonRpc(URL);
  for (let i = 0; ; i++) {
    try {
      if ((await rpc("getHealth", [])) === "ok") break;
    } catch {
      /* not up yet */
    }
    if (i > 120) throw new Error("validator did not start");
    await new Promise((r) => setTimeout(r, 500));
  }
  for (const k of [upgradeAuthority, poster, buyer, cranker]) await airdrop(k.address, 20);

  // observation-roots: initialize, then post the three real roots.
  const init = await sendIxs(rpc, upgradeAuthority, [await initializeIx({ program: ROOTS, payer: upgradeAuthority.address, authority: poster.address })]);
  assert.equal(init.err, null, init.logs.join("\n"));
  for (const day of DAYS) {
    const sent = await sendPostRoot({ rpc, program: ROOTS, feePayer: poster.address, loadSigner: async () => poster, pollMs: 400 }, postRootArgsFromRecord(readDay(day)[0]!));
    assert.equal(sent.state, "posted");
  }

  // A 6-decimal test token standing in for USDC; the buyer holds 1,000 of it.
  const rent = BigInt((await rpc("getMinimumBalanceForRentExemption", [82])) as number);
  const m = await sendIxs(rpc, cranker, createMintIxs({ payer: cranker.address, mint: mintKey, authority: cranker.address, rentLamports: rent }), [mintKey]);
  assert.equal(m.err, null, m.logs.join("\n"));
  buyerTokens = await ensureAta(buyer.address);
  const mt = await sendIxs(rpc, cranker, [await mintToIx({ mint, to: buyerTokens, authority: cranker, amount: 1_000_000_000n })]);
  assert.equal(mt.err, null, mt.logs.join("\n"));
});

after(() => {
  validator?.kill("SIGTERM");
  if (ledger) rmSync(ledger, { recursive: true, force: true });
});

describe("delivery-escrow-example", () => {
  test("DELIVERED: the seller is paid, and the vault and escrow close with their rent back to the buyer (one record of each day)", async () => {
    const days = new Set<string>();
    let maxBytes = 0;
    for (const o of delivered) {
      if (days.has(o.anchor!.day)) continue;
      days.add(o.anchor!.day);
      const p = purchaseOf(o);
      const sellerTokens = await ensureAta(p.payTo);
      const before = await tokenBalance(sellerTokens);
      const d = await deposit(p);
      assert.equal(d.err, null, d.logs.join("\n"));
      const escrow = await escrowPda(ESCROW, buyer.address, p.transaction);
      const e = decodeEscrow((await accountData(escrow))!);
      assert.equal(e.seller, p.payTo);
      assert.equal(e.amount, p.amount);
      const vault = await vaultPda(ESCROW, escrow);
      assert.equal(await tokenBalance(vault), p.amount);
      const buyerLamports = await lamports(buyer.address);
      // Anyone can settle: here a third key pays the fee.
      const s = await sendIxs(rpc, cranker, [await settleWithRecordIx({ program: ESCROW, rootsProgram: ROOTS, buyer: buyer.address, destination: sellerTokens, record: o })]);
      assert.equal(s.err, null, s.logs.join("\n"));
      assert.ok(s.logs.some((l) => l.includes("released") && l.includes("DELIVERED")), s.logs.join("\n"));
      maxBytes = Math.max(maxBytes, s.txBytes);
      assert.equal((await tokenBalance(sellerTokens)) - before, p.amount);
      assert.equal(await accountData(vault), null, "vault closed");
      assert.equal(await accountData(escrow), null, "escrow closed");
      assert.ok((await lamports(buyer.address)) > buyerLamports, "rent back to the buyer");
    }
    assert.equal(days.size, 3);
    console.log(`largest settle transaction ${maxBytes} bytes (limit 1232)`);
  });

  test("NOT_DELIVERED: every published Solana NOT_DELIVERED record returns the deposit to the buyer, and cannot pay the seller", async () => {
    assert.ok(notDelivered.length >= 10, `published NOT_DELIVERED Solana records: ${notDelivered.length}`);
    for (const o of notDelivered) {
      const p = purchaseOf(o);
      const sellerTokens = await ensureAta(p.payTo);
      const d = await deposit(p);
      assert.equal(d.err, null, `${o.id}: ${d.logs.join("\n")}`);
      const afterDeposit = await tokenBalance(buyerTokens);
      // Pointing the settlement at the seller is refused.
      const toSeller = await simulateIxs(rpc, cranker.address, [await settleWithRecordIx({ program: ESCROW, rootsProgram: ROOTS, buyer: buyer.address, destination: sellerTokens, record: o })]);
      assert.equal(customError(toSeller.err), X.WrongDestination, o.id);
      const s = await sendIxs(rpc, cranker, [await settleWithRecordIx({ program: ESCROW, rootsProgram: ROOTS, buyer: buyer.address, destination: buyerTokens, record: o })]);
      assert.equal(s.err, null, `${o.id}: ${s.logs.join("\n")}`);
      assert.ok(s.logs.some((l) => l.includes("refunded") && l.includes("NOT_DELIVERED")));
      assert.equal((await tokenBalance(buyerTokens)) - afterDeposit, p.amount, o.id);
    }
  });

  test("a tampered record, another purchase's record or another amount is refused, and the deposit stays", async () => {
    const nd = notDelivered[notDelivered.length - 1]!;
    const ok = delivered[delivered.length - 1]!;
    const other = delivered[delivered.length - 2]!;
    const p = purchaseOf(nd);
    assert.equal((await deposit(p)).err, null);
    const settle = async (record: Observation, fields: ReturnType<typeof fieldsFromObservation>, destination = buyerTokens) =>
      simulateIxs(rpc, cranker.address, [await settleWithRecordIx({ program: ESCROW, rootsProgram: ROOTS, buyer: buyer.address, destination, record, fields })]);
    const f = fieldsFromObservation(nd, ALL_STRING_FIELDS);
    // NOT_DELIVERED claimed as DELIVERED, to pay the seller: not in the root.
    const sellerTokens = await ensureAta(p.payTo);
    assert.equal(customError((await settle(nd, { ...f, verdict: "DELIVERED" }, sellerTokens)).err), ROOTS_NOT_IN_ROOT);
    // One bit of the proof.
    const bad = { ...nd, anchor: { ...nd.anchor!, proof: [`${nd.anchor!.proof[0]!.slice(0, -1)}${nd.anchor!.proof[0]!.endsWith("0") ? "1" : "0"}`, ...nd.anchor!.proof.slice(1)] } };
    assert.equal(customError((await settle(bad, f)).err), ROOTS_NOT_IN_ROOT);
    // A genuine DELIVERED record of another purchase, sent against this escrow.
    assert.notEqual(ok.payment.transaction, nd.payment.transaction);
    const wrong = await simulateIxs(rpc, cranker.address, [
      await settleIx({ program: ESCROW, rootsProgram: ROOTS, buyer: buyer.address, transaction: nd.payment.transaction, destination: sellerTokens, day: ok.anchor!.day, fields: fieldsFromObservation(ok, ALL_STRING_FIELDS), proof: ok.anchor!.proof }),
    ]);
    assert.equal(customError(wrong.err), X.OtherPurchase);
    // An escrow whose amount differs from the record's.
    const q = purchaseOf(other);
    assert.equal((await deposit({ ...q, amount: q.amount + 1n })).err, null);
    const otherSeller = await ensureAta(q.payTo);
    const amt = await simulateIxs(rpc, cranker.address, [await settleWithRecordIx({ program: ESCROW, rootsProgram: ROOTS, buyer: buyer.address, destination: otherSeller, record: other })]);
    assert.equal(customError(amt.err), X.OtherAmount);
    // Both deposits are still there.
    for (const t of [p.transaction, q.transaction]) assert.notEqual(await accountData(await escrowPda(ESCROW, buyer.address, t)), null);
    // The genuine record still settles.
    const s = await sendIxs(rpc, cranker, [await settleWithRecordIx({ program: ESCROW, rootsProgram: ROOTS, buyer: buyer.address, destination: buyerTokens, record: nd })]);
    assert.equal(s.err, null, s.logs.join("\n"));
  });

  test("UNCLEAR settles nothing (MISMATCH takes the same branch); after the deadline the buyer reclaims", async () => {
    // A copy of a real record with the verdict UNCLEAR, under a root of its own for a day with no published root.
    const base = delivered[0]!;
    const unclear: Observation = { ...base, verdict: { ...base.verdict, code: "UNCLEAR" } };
    const day = "2026-09-20";
    const root = leafHash(observationDigest(unclear));
    const seq = unclear.observer.sequence;
    const posted = await sendIxs(rpc, poster, [await postRootIx({ program: ROOTS, authority: poster.address, day, root, count: 1, seqStart: seq, seqEnd: seq, observer: base.anchor!.observerAddress as Hex })]);
    assert.equal(posted.err, null, posted.logs.join("\n"));
    const rec = { ...unclear, anchor: { ...unclear.anchor!, day, proof: [] as string[] } };
    const late = await generateKeyPairSigner();
    await airdrop(late.address, 2);
    const lateTokens = await ensureAta(late.address);
    assert.equal((await sendIxs(rpc, cranker, [await mintToIx({ mint, to: lateTokens, authority: cranker, amount: 5_000_000n })])).err, null);
    const p = purchaseOf(base);
    const deadline = (await chainTime()) + 20n; // room for the steps before the early reclaim when both validator tests run at once
    assert.equal((await deposit(p, { by: late, tokens: lateTokens, deadline })).err, null);
    for (const destination of [lateTokens, await ensureAta(p.payTo)]) {
      const s = await simulateIxs(rpc, cranker.address, [await settleWithRecordIx({ program: ESCROW, rootsProgram: ROOTS, buyer: late.address, destination, record: rec })]);
      assert.equal(customError(s.err), X.VerdictSettlesNothing);
    }
    const early = await sendIxs(rpc, late, [await reclaimIx({ program: ESCROW, buyer: late.address, transaction: p.transaction, destination: lateTokens })]);
    assert.equal(customError(early.err), X.DeadlineNotReached);
    while ((await chainTime()) < deadline + 1n) await new Promise((r) => setTimeout(r, 1000));
    // After the deadline, the same escrow signed by someone other than its buyer: refused (has_one = buyer).
    const real = await reclaimIx({ program: ESCROW, buyer: late.address, transaction: p.transaction, destination: lateTokens });
    const asStranger = { ...real, accounts: real.accounts!.map((m, i) => (i === 3 ? { ...m, address: cranker.address } : m)) };
    assert.equal(real.accounts![0]!.address, asStranger.accounts[0]!.address, "the real escrow");
    const stranger = await sendIxs(rpc, cranker, [asStranger]);
    assert.equal(customError(stranger.err), ANCHOR_CONSTRAINT_HAS_ONE);
    const r = await sendIxs(rpc, late, [await reclaimIx({ program: ESCROW, buyer: late.address, transaction: p.transaction, destination: lateTokens })]);
    assert.equal(r.err, null, r.logs.join("\n"));
    assert.equal(await tokenBalance(lateTokens), 5_000_000n);
  });

  test("deposit checks: payTo must be the seller's address, a positive amount, a future deadline", async () => {
    const o = delivered[1]!;
    const p = purchaseOf(o);
    const other = await generateKeyPairSigner();
    const ix0 = await depositIx({ program: ESCROW, buyer: buyer.address, buyerTokens, mint, purchase: p, deadline: (await chainTime()) + 60n });
    const ix = { ...ix0, accounts: ix0.accounts!.map((m, i) => (i === 3 ? { ...m, address: other.address } : m)) };
    assert.equal(customError((await sendIxs(rpc, buyer, [ix])).err), X.PayToNotSeller);
    assert.equal(customError((await deposit({ ...p, amount: 0n })).err), X.ZeroAmount);
    assert.equal(customError((await deposit(p, { deadline: (await chainTime()) - 10n })).err), X.DeadlinePassed);
  });

  test("lamports sent to the vault's address first, and tokens sent into the vault, do not block a deposit or its settlement", async () => {
    const o = delivered[2]!;
    const p = purchaseOf(o);
    const escrow = await escrowPda(ESCROW, buyer.address, p.transaction);
    const vault = await vaultPda(ESCROW, escrow);
    assert.equal((await sendIxs(rpc, cranker, [transferLamportsIx(cranker.address, vault, 1_000_000n)])).err, null);
    const d = await deposit(p);
    assert.equal(d.err, null, d.logs.join("\n"));
    const crankerTokens = await ensureAta(cranker.address);
    assert.equal((await sendIxs(rpc, cranker, [await mintToIx({ mint, to: crankerTokens, authority: cranker, amount: 7n })])).err, null);
    const { getTransferInstruction } = await import("@solana-program/token");
    assert.equal((await sendIxs(rpc, cranker, [getTransferInstruction({ source: crankerTokens as never, destination: vault, authority: cranker, amount: 7n })])).err, null);
    const sellerTokens = await ensureAta(p.payTo);
    const before = await tokenBalance(sellerTokens);
    const s = await sendIxs(rpc, cranker, [await settleWithRecordIx({ program: ESCROW, rootsProgram: ROOTS, buyer: buyer.address, destination: sellerTokens, record: o })]);
    assert.equal(s.err, null, s.logs.join("\n"));
    assert.equal((await tokenBalance(sellerTokens)) - before, p.amount + 7n);
    assert.equal(await accountData(vault), null);
  });
});
