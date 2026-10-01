/**
 * observation-roots and the delivery-gate example on a local solana-test-validator, with the real
 * published records of 2026-09-28, 2026-09-29 and 2026-09-30 (data/records) and their real proofs.
 *
 *   npm run program:build && npm run program:test
 *   npm run program:test:mainnet-features   # the validator copies mainnet's feature set (needs network)
 *
 * Needs solana-test-validator, solana and solana-keygen on PATH (or SOLANA_BIN pointing at their folder).
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { AccountRole, address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { keccak256, stringToBytes, type Hex } from "viem";
import { jsonRpc, type Rpc } from "../../src/chain.js";
import { observationDigest } from "../../src/receipt/eip712.js";
import {
  compactFields,
  configPda,
  dayRootPda,
  decodeConfig,
  decodeDayRoot,
  decodeVerifyResult,
  fieldsFromObservation,
  GATE_EXAMPLE_PROGRAM_DEVNET as GATE,
  initializeIx,
  postRootIx,
  requireDeliveredIx,
  acceptAuthorityIx,
  decodeProgramData,
  programDataAddress,
  proposeAuthorityIx,
  sameProgramBytes,
  ROOTS_PROGRAM as ROOTS,
  SYSTEM_PROGRAM,
  verifyIx,
  type ObservationFields,
  type StringFieldName,
} from "../../src/receipt/roots-program.js";
import { planPostRoot, postRootArgsFromRecord, sendPostRoot } from "../../src/receipt/roots-post.js";
import { customError, sendIxs, simulateIxs } from "../../src/receipt/roots-tx.js";
import type { Observation } from "../../src/receipt/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const DEPLOY = join(REPO, "solana-program/target/deploy");
const PORT = Number(process.env.VALIDATOR_PORT ?? 18899);
const URL = `http://127.0.0.1:${PORT}`;
const bin = (name: string) => (process.env.SOLANA_BIN ? join(process.env.SOLANA_BIN, name) : name);

// Error codes (Anchor custom errors start at 6000, in declaration order).
const E = { NotUpgradeAuthority: 6000, NotAuthority: 6001, InvalidDay: 6002, DayStillOpen: 6003, EmptyRoot: 6004, SequenceRangeMismatch: 6005, SequenceOutsideRoot: 6008, NotInRoot: 6009, NotPendingAuthority: 6012 };
const G = { OtherPurchase: 6000, NotDelivered: 6001 };
const ACCOUNT_NOT_INITIALIZED = 3012;

function readDay(day: string): Observation[] {
  const dir = join(REPO, "data/records", day);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Observation)
    .sort((a, b) => a.observer.sequence - b.observer.sequence);
}

const DAYS = ["2026-09-28", "2026-09-29", "2026-09-30"] as const;
/** Set to an RPC URL to start the validator with that cluster's feature set (e.g. mainnet). */
const FEATURES_FROM = process.env.ROOTS_FEATURES_FROM;
const records = Object.fromEntries(DAYS.map((d) => [d, readDay(d)])) as Record<(typeof DAYS)[number], Observation[]>;

let validator: ChildProcess;
let ledger: string;
let rpc: Rpc;
let upgradeAuthority: KeyPairSigner;
let poster: KeyPairSigner;
let stranger: KeyPairSigner;

async function airdrop(to: string, sol: number) {
  const sig = (await rpc("requestAirdrop", [to, sol * 1e9])) as string;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const st = (await rpc("getSignatureStatuses", [[sig]])) as { value: ({ confirmationStatus: string | null } | null)[] };
    if (st.value[0]?.confirmationStatus === "confirmed" || st.value[0]?.confirmationStatus === "finalized") return;
  }
  throw new Error("airdrop not confirmed");
}

before(async () => {
  upgradeAuthority = await generateKeyPairSigner();
  poster = await generateKeyPairSigner();
  stranger = await generateKeyPairSigner();
  ledger = mkdtempSync(join(tmpdir(), "roots-ledger-"));
  validator = spawn(
    bin("solana-test-validator"),
    [
      "--reset",
      "--quiet",
      "--ledger", ledger,
      "--rpc-port", String(PORT),
      "--faucet-port", String(PORT + 1012),
      "--dynamic-port-range", `${PORT + 20}-${PORT + 60}`,
      ...(FEATURES_FROM ? ["--clone-feature-set", "--url", FEATURES_FROM] : []),
      "--upgradeable-program", ROOTS, join(DEPLOY, "observation_roots.so"), upgradeAuthority.address,
      "--bpf-program", GATE, join(DEPLOY, "delivery_gate_example.so"),
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
  for (const k of [upgradeAuthority, poster, stranger]) await airdrop(k.address, 10);
});

after(() => {
  validator?.kill("SIGTERM");
  if (ledger) rmSync(ledger, { recursive: true, force: true });
});

const utcDay = (t: Date) => t.toISOString().slice(0, 10);

describe("initialize", () => {
  test("refused unless the signer is the program's upgrade authority", async () => {
    const r = await sendIxs(rpc, stranger, [await initializeIx({ program: ROOTS, payer: stranger.address, authority: stranger.address })]);
    assert.equal(customError(r.err), E.NotUpgradeAuthority);
  });

  test("the upgrade authority sets the posting authority, once", async () => {
    const r = await sendIxs(rpc, upgradeAuthority, [await initializeIx({ program: ROOTS, payer: upgradeAuthority.address, authority: poster.address })]);
    assert.equal(r.err, null, r.logs.join("\n"));
    const acc = (await rpc("getAccountInfo", [await configPda(ROOTS), { encoding: "base64", commitment: "confirmed" }])) as { value: { data: [string, string] } };
    assert.equal(decodeConfig(Buffer.from(acc.value.data[0], "base64")).authority, poster.address);
    const again = await sendIxs(rpc, upgradeAuthority, [await initializeIx({ program: ROOTS, payer: upgradeAuthority.address, authority: stranger.address })]);
    assert.notEqual(again.err, null, "a second initialize must fail");
  });
});

describe("post_root", () => {
  const args = () => postRootArgsFromRecord(records["2026-09-28"][0]!);

  test("refused for a signer that is not the posting authority", async () => {
    const r = await sendIxs(rpc, stranger, [await postRootIx({ ...args(), program: ROOTS, authority: stranger.address })]);
    assert.equal(customError(r.err), E.NotAuthority);
  });

  test("refused while the UTC day is still open", async () => {
    const r = await sendIxs(rpc, poster, [await postRootIx({ ...args(), day: utcDay(new Date()), program: ROOTS, authority: poster.address })]);
    assert.equal(customError(r.err), E.DayStillOpen);
  });

  test("refused for an invalid date, an empty root, or a sequence range that does not match the count", async () => {
    const bad = async (over: Partial<ReturnType<typeof args>>) =>
      customError((await sendIxs(rpc, poster, [await postRootIx({ ...args(), ...over, program: ROOTS, authority: poster.address })])).err);
    assert.equal(await bad({ day: "2026-02-30" }), E.InvalidDay);
    assert.equal(await bad({ count: 0, seqStart: 1, seqEnd: 0 }), E.EmptyRoot);
    assert.equal(await bad({ count: 164 }), E.SequenceRangeMismatch);
  });

  test("posts the real roots of every day through the anchor module (roots-post.ts)", async () => {
    // Someone sends lamports to the 2026-09-29 PDA first: the post must still go through.
    const data = new Uint8Array(12);
    new DataView(data.buffer).setUint32(0, 2, true);
    new DataView(data.buffer).setBigUint64(4, 1_000_000n, true);
    const pre = await sendIxs(rpc, stranger, [
      {
        programAddress: address(SYSTEM_PROGRAM),
        accounts: [
          { address: stranger.address, role: AccountRole.WRITABLE_SIGNER },
          { address: await dayRootPda(ROOTS, "2026-09-29"), role: AccountRole.WRITABLE },
        ],
        data,
      },
    ]);
    assert.equal(pre.err, null);
    for (const day of DAYS) {
      const a = postRootArgsFromRecord(records[day][0]!);
      const deps = { rpc, program: ROOTS, feePayer: poster.address, loadSigner: async () => poster, pollMs: 400 };
      const plan = await planPostRoot(deps, a);
      assert.equal(plan.state, "ready");
      if (plan.state === "ready") assert.ok(plan.spendLamports <= plan.rentLamports + plan.feeLamports);
      const sent = await sendPostRoot(deps, a);
      assert.equal(sent.state, "posted");
      const acc = (await rpc("getAccountInfo", [await dayRootPda(ROOTS, day), { encoding: "base64", commitment: "confirmed" }])) as { value: { data: [string, string] } };
      const onChain = decodeDayRoot(Buffer.from(acc.value.data[0], "base64"));
      assert.equal(onChain.root, a.root);
      assert.equal(onChain.count, a.count);
      assert.equal(Number(onChain.seqStart), a.seqStart);
      assert.equal(Number(onChain.seqEnd), a.seqEnd);
      assert.equal(onChain.observer.toLowerCase(), a.observer.toLowerCase());
      // Running it again finds the root and sends nothing.
      assert.equal((await sendPostRoot(deps, a)).state, "already-posted");
    }
  });

  test("a posted day cannot be overwritten, even by the authority", async () => {
    const a = args();
    const r = await sendIxs(rpc, poster, [await postRootIx({ ...a, root: `0x${"11".repeat(32)}` as Hex, program: ROOTS, authority: poster.address })]);
    assert.notEqual(r.err, null);
    assert.ok(r.logs.some((l) => l.includes("already in use")), r.logs.join("\n"));
    const deps = { rpc, program: ROOTS, feePayer: poster.address, loadSigner: async () => poster };
    await assert.rejects(planPostRoot(deps, { ...a, root: `0x${"11".repeat(32)}` as Hex }), /different root/);
  });
});

async function verifySim(day: string, fields: ObservationFields, proof: readonly string[]) {
  return simulateIxs(rpc, poster.address, [await verifyIx({ program: ROOTS, day, fields, proof })]);
}

describe("verify", () => {
  test("every published record of every day checks against its day's root, with the record's own verdict", async () => {
    let n = 0;
    let maxUnits = 0;
    for (const day of DAYS) {
      for (const o of records[day]) {
        const r = await verifySim(day, fieldsFromObservation(o), o.anchor!.proof);
        assert.equal(r.err, null, `${o.id}: ${JSON.stringify(r.err)} ${r.logs.join(" | ")}`);
        assert.equal(r.returnProgram, ROOTS);
        const v = decodeVerifyResult(r.returnData!);
        assert.equal(v.verdict, o.verdict.code, o.id);
        assert.equal(v.sequence, BigInt(o.observer.sequence));
        assert.equal(v.digest, observationDigest(o));
        assert.equal(v.day, Number(day.replaceAll("-", "")));
        maxUnits = Math.max(maxUnits, r.unitsConsumed ?? 0);
        n++;
      }
    }
    assert.equal(n, DAYS.reduce((t, d) => t + records[d].length, 0));
    console.log(`verified ${n} records; max compute units ${maxUnits}`);
  });

  test("a landed verify transaction carries the verdict in its return data", async () => {
    const o = records["2026-09-29"][0]!;
    const r = await sendIxs(rpc, poster, [await verifyIx({ program: ROOTS, day: "2026-09-29", fields: fieldsFromObservation(o), proof: o.anchor!.proof })]);
    assert.equal(r.err, null);
    assert.equal(decodeVerifyResult(r.returnData!).verdict, o.verdict.code);
  });

  test("hashed string fields give the same result in a smaller transaction", async () => {
    const o = records["2026-09-28"][0]!;
    const hashed: StringFieldName[] = ["id", "resourceUrl", "payer", "asset", "amount", "responseHash", "responseHashAlg", "responseHashEncoding"];
    const raw = await verifySim("2026-09-28", fieldsFromObservation(o), o.anchor!.proof);
    const small = await verifySim("2026-09-28", fieldsFromObservation(o, hashed), o.anchor!.proof);
    assert.equal(small.err, null);
    assert.deepEqual(decodeVerifyResult(small.returnData!), decodeVerifyResult(raw.returnData!));
  });

  test("tampered records and proofs fail", async () => {
    const nd = records["2026-09-28"].find((o) => o.verdict.code === "NOT_DELIVERED")!;
    assert.ok(nd, "the 2026-09-28 published set has a NOT_DELIVERED record");
    const f = fieldsFromObservation(nd);
    // A NOT_DELIVERED record claimed as DELIVERED.
    assert.equal(customError((await verifySim("2026-09-28", { ...f, verdict: "DELIVERED" }, nd.anchor!.proof)).err), E.NotInRoot);
    // Another seller, another amount, another transaction.
    assert.equal(customError((await verifySim("2026-09-28", { ...f, payTo: { raw: "11111111111111111111111111111111" } }, nd.anchor!.proof)).err), E.NotInRoot);
    assert.equal(customError((await verifySim("2026-09-28", { ...f, amount: { raw: "1" } }, nd.anchor!.proof)).err), E.NotInRoot);
    assert.equal(customError((await verifySim("2026-09-28", { ...f, transaction: { hashed: keccak256(stringToBytes("x")) } }, nd.anchor!.proof)).err), E.NotInRoot);
    // One bit of one sibling, a dropped sibling, an extra sibling.
    const p = [...nd.anchor!.proof];
    p[0] = `${p[0]!.slice(0, -1)}${p[0]!.endsWith("0") ? "1" : "0"}`;
    assert.equal(customError((await verifySim("2026-09-28", f, p)).err), E.NotInRoot);
    assert.equal(customError((await verifySim("2026-09-28", f, nd.anchor!.proof.slice(1))).err), E.NotInRoot);
    assert.equal(customError((await verifySim("2026-09-28", f, [...nd.anchor!.proof, `0x${"00".repeat(32)}`])).err), E.NotInRoot);
    // A record of one day against the other day's root.
    assert.equal(customError((await verifySim("2026-09-29", f, nd.anchor!.proof)).err), E.SequenceOutsideRoot);
    // A day with no root.
    assert.equal(customError((await verifySim("2026-09-27", f, nd.anchor!.proof)).err), ACCOUNT_NOT_INITIALIZED);
  });
});

describe("delivery-gate-example (CPI)", () => {
  const gate = async (o: Observation, over: { network?: string; payTo?: string; transaction?: string; fields?: ObservationFields } = {}) =>
    simulateIxs(rpc, poster.address, [
      await requireDeliveredIx({
        gate: GATE,
        program: ROOTS,
        network: over.network ?? o.payment.network,
        payTo: over.payTo ?? o.payment.payTo,
        transaction: over.transaction ?? o.payment.transaction,
        day: o.anchor!.day,
        fields: over.fields ?? fieldsFromObservation(o),
        proof: o.anchor!.proof,
      }),
    ]);

  test("passes for DELIVERED records of every day", async () => {
    let maxBytes = 0;
    let maxHashed = 0;
    for (const day of DAYS) {
      for (const o of records[day].filter((x) => x.verdict.code === "DELIVERED")) {
        const r = await gate(o);
        assert.equal(r.err, null, `${o.id}: ${r.logs.join(" | ")}`);
        assert.ok(r.logs.some((l) => l.includes("condition met")));
        maxBytes = Math.max(maxBytes, r.txBytes);
        // The long fields the gate does not compare can travel hashed.
        const h = await gate(o, { fields: compactFields(o) });
        assert.equal(h.err, null, `${o.id} (hashed): ${h.logs.join(" | ")}`);
        maxHashed = Math.max(maxHashed, h.txBytes);
      }
    }
    console.log(`largest gate transaction ${maxBytes} bytes raw, ${maxHashed} bytes with unused fields hashed (limit 1232)`);
  });

  test("a landed gate transaction", async () => {
    const o = records["2026-09-28"].find((x) => x.verdict.code === "DELIVERED")!;
    const r = await sendIxs(rpc, poster, [
      await requireDeliveredIx({ gate: GATE, program: ROOTS, network: o.payment.network, payTo: o.payment.payTo, transaction: o.payment.transaction, day: o.anchor!.day, fields: fieldsFromObservation(o), proof: o.anchor!.proof }),
    ]);
    assert.equal(r.err, null, r.logs.join("\n"));
  });

  test("refuses NOT_DELIVERED, another purchase, and a tampered record", async () => {
    for (const day of DAYS) {
      for (const o of records[day].filter((x) => x.verdict.code === "NOT_DELIVERED")) assert.equal(customError((await gate(o)).err), G.NotDelivered, o.id);
    }
    const o = records["2026-09-29"].find((x) => x.verdict.code === "DELIVERED")!;
    assert.equal(customError((await gate(o, { payTo: "11111111111111111111111111111111" })).err), G.OtherPurchase);
    assert.equal(customError((await gate(o, { transaction: "x" })).err), G.OtherPurchase);
    assert.equal(customError((await gate(o, { network: "eip155:8453" })).err), G.OtherPurchase);
    const nd = records["2026-09-29"].find((x) => x.verdict.code === "NOT_DELIVERED")!;
    assert.equal(customError((await gate(nd, { fields: { ...fieldsFromObservation(nd), verdict: "DELIVERED" } })).err), E.NotInRoot);
  });
});

describe("posting authority change (propose, then accept)", () => {
  const day = "2026-09-27";
  const a = () => ({ ...postRootArgsFromRecord(records["2026-09-28"][0]!), day });

  test("only the upgrade authority proposes, only the proposed key accepts, then only it can post", async () => {
    const next = await generateKeyPairSigner();
    await airdrop(next.address, 1);
    const propose = async (signer: KeyPairSigner, to: string) =>
      sendIxs(rpc, signer, [await proposeAuthorityIx({ program: ROOTS, upgradeAuthority: signer.address, newAuthority: to })]);
    const accept = async (signer: KeyPairSigner) => sendIxs(rpc, signer, [await acceptAuthorityIx({ program: ROOTS, newAuthority: signer.address })]);
    const config = async () =>
      decodeConfig(Buffer.from(((await rpc("getAccountInfo", [await configPda(ROOTS), { encoding: "base64", commitment: "confirmed" }])) as { value: { data: [string, string] } }).value.data[0], "base64"));

    assert.equal(customError((await propose(stranger, stranger.address)).err), E.NotUpgradeAuthority);
    assert.equal(customError((await propose(poster, next.address)).err), E.NotUpgradeAuthority); // the posting key cannot hand itself on
    assert.equal(customError((await accept(next)).err), E.NotPendingAuthority); // nothing proposed yet
    assert.equal((await propose(upgradeAuthority, next.address)).err, null);
    const pending = await config();
    assert.equal(pending.authority, poster.address); // nothing changes until the new key accepts
    assert.equal(pending.pendingAuthority, next.address);
    assert.equal(customError((await accept(stranger)).err), E.NotPendingAuthority);
    assert.equal((await accept(next)).err, null);
    const c = await config();
    assert.equal(c.authority, next.address);
    assert.equal(c.pendingAuthority, null);

    const old = await sendIxs(rpc, poster, [await postRootIx({ ...a(), program: ROOTS, authority: poster.address })]);
    assert.equal(customError(old.err), E.NotAuthority);
    const posted = await sendIxs(rpc, next, [await postRootIx({ ...a(), program: ROOTS, authority: next.address })]);
    assert.equal(posted.err, null, posted.logs.join("\n"));
  });
});

describe("deploying with the solana CLI", () => {
  test("the built .so deploys under this validator's feature set, and the on-chain program data hashes to the local file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "roots-deploy-"));
    try {
      const deployer = join(dir, "deployer.json");
      const programKey = join(dir, "program.json");
      execFileSync(bin("solana-keygen"), ["new", "--no-bip39-passphrase", "--silent", "-o", deployer]);
      execFileSync(bin("solana-keygen"), ["new", "--no-bip39-passphrase", "--silent", "-o", programKey]);
      const deployerAddr = execFileSync(bin("solana-keygen"), ["pubkey", deployer]).toString().trim();
      const programId = execFileSync(bin("solana-keygen"), ["pubkey", programKey]).toString().trim();
      await airdrop(deployerAddr, 5);
      const so = join(DEPLOY, "observation_roots.so");
      execFileSync(bin("solana"), ["program", "deploy", so, "--program-id", programKey, "--keypair", deployer, "--url", URL, "--commitment", "confirmed"], { stdio: "pipe" });
      const dumped = join(dir, "dumped.so");
      execFileSync(bin("solana"), ["program", "dump", programId, dumped, "--url", URL, "--commitment", "confirmed"], { stdio: "pipe" });
      const local = readFileSync(so);
      const onChain = readFileSync(dumped);
      assert.equal(statSync(dumped).size >= local.length, true);
      const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
      assert.equal(sha(onChain.subarray(0, local.length)), sha(local));
      assert.ok(onChain.subarray(local.length).every((x) => x === 0), "anything after the program is zero padding");
      // The same check scripts/roots-mainnet.ts makes, read over RPC.
      const pd = (await rpc("getAccountInfo", [await programDataAddress(programId), { encoding: "base64", commitment: "confirmed" }])) as { value: { data: [string, string] } };
      const decoded = decodeProgramData(Buffer.from(pd.value.data[0], "base64"));
      assert.equal(decoded.upgradeAuthority, deployerAddr);
      assert.ok(sameProgramBytes(decoded.program, local));
      const flipped = Buffer.from(local);
      flipped[1000] = flipped[1000]! ^ 1;
      assert.equal(sameProgramBytes(decoded.program, flipped), false);
      console.log(`deployed ${local.length} bytes with the CLI${FEATURES_FROM ? ` under the feature set of ${FEATURES_FROM}` : ""}; sha256 ${sha(local)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
