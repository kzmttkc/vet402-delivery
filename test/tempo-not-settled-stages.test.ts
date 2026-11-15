/**
 * Four delivery stages under not_settled_hold, build-receipts alignment, hold window end, and regressions.
 */
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { encodeFunctionData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Abis, Transaction } from "viem/tempo";
import { acquireRunLock } from "../src/first-buyer/lock.js";
import * as holdMod from "../src/remeasure/not-settled-hold.js";
import { RM_QUARANTINED, RM_TEMPO_MAX_PER_RUN_ATOMIC } from "../src/remeasure/constants.js";
import { dayLedgerPath, dryRunTempo, payTempo } from "../src/remeasure/tempo.js";
import type { ResultFile, RemeasureRow } from "../src/remeasure/results.js";
import { selectSlots, tempoFromLedger, type Target } from "../src/remeasure/targets.js";
import { TEMPO_MAINNET_CHAIN_ID, USDC_E, FEE_RESERVE_ATOMIC, normAddr } from "../src/tempo/constants.js";
import { mppChallengesFromHeader, tempoChargeRequest } from "../src/tempo/challenge.js";
import type { PlanEntry } from "../src/tempo/census.js";
import { Ledger } from "../src/tempo/ledger.js";
import { registerDayLedger, type KeyLedgerSet } from "../src/tempo/key-ledgers.js";
import type { Signer } from "../src/tempo/chain.js";
import { planVerdict } from "../src/daily/steps.js";

const FIX = join(import.meta.dirname, "fixtures", "tempo-not-settled-1108");
const FIX_JSON = join(FIX, "tempo-2026-11-08.json");
const CODEX_URL = "https://graph.codex.io/graphql";
const PLAN_DAY = "2026-11-08";
const REPO = join(import.meta.dirname, "..");
const MISSING_EVM_KEY = join(tmpdir(), "vet402-missing-evm-key-stages.json");
const FAKE_CODEX_PAYTO = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REAL_CODEX_PAYTO = "0xc12b5d802da90d14a8b35dec1cfb6fd5ceede60b";
const throwaway = privateKeyToAccount(generatePrivateKey());

function loadFixture(): ResultFile {
  return JSON.parse(readFileSync(FIX_JSON, "utf8")) as ResultFile;
}

function usdcAtomic(priceUsdc: string): string {
  const [w, f = ""] = priceUsdc.split(".");
  return (BigInt(w!) * 1_000_000n + BigInt(f.padEnd(6, "0"))).toString();
}

function derivedHoldDir(fakeCodexPayTo: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tempo-stages-derived-"));
  const file = loadFixture();
  const pay = normAddr(fakeCodexPayTo);
  const rows = file.rows.map((r, i) => (i === 28 ? { ...r, payTo: pay, expectedPayTo: pay, key: `${PLAN_DAY}|${pay}|0` } : r));
  writeFileSync(join(dir, "tempo-2026-11-08.json"), JSON.stringify({ ...file, rows }, null, 2) + "\n");
  return dir;
}

function codexRowFromFixture(file: ResultFile, payTo = FAKE_CODEX_PAYTO): RemeasureRow {
  const row = { ...file.rows[28]! };
  const pay = normAddr(payTo);
  return { ...row, payTo: pay, expectedPayTo: pay, key: `${PLAN_DAY}|${pay}|0` };
}

function requestForSentRow(r: RemeasureRow): PlanEntry["request"] {
  const isCodex = r.host === "graph.codex.io";
  return {
    url: r.requestUrl,
    method: isCodex ? "POST" : "GET",
    body: isCodex ? "{}" : null,
    contentType: isCodex ? "application/json" : null,
    inputSource: r.input?.source === "mercator_example" ? "mercator_example" : "none",
  };
}

function targetFromSentRow(r: RemeasureRow): Target {
  const payTo = normAddr(r.expectedPayTo);
  const amount = usdcAtomic(r.priceUsdc!);
  return {
    chain: "tempo",
    host: r.host,
    service: r.service,
    url: r.url,
    requestUrl: r.requestUrl,
    payTo,
    amountAtomic: amount,
    from: "fixture",
    tempo: {
      plan: {
        serviceId: r.service ?? r.host,
        request: requestForSentRow(r),
        lockedRecipient: payTo,
        lockedAmount: amount,
        sponsored: false,
        allowlist: [],
      },
      feeReserveAtomic: FEE_RESERVE_ATOMIC.toString(),
      censusHttpStatus: r.httpStatus,
    },
  };
}

function writeDayLedgerFromSent(remeasureDir: string, file: ResultFile): string {
  const path = dayLedgerPath(remeasureDir, file.date);
  mkdirSync(dirname(path), { recursive: true });
  const entries = file.rows
    .filter((r) => r.outcome === "sent")
    .map((r) => ({
      key: r.key,
      url: r.url,
      recipient: normAddr(r.payTo ?? r.expectedPayTo),
      amount: usdcAtomic(r.priceUsdc!),
      feeReserve: FEE_RESERVE_ATOMIC.toString(),
      status: "sent" as const,
      settled: r.settled,
      txHash: r.tx,
      reservedAt: r.at,
    }));
  writeFileSync(path, JSON.stringify({ version: 1, payer: file.payer, capAtomic: String(RM_TEMPO_MAX_PER_RUN_ATOMIC), entries }, null, 2) + "\n");
  return path;
}

function okTarget(): Target {
  const payTo = "0x3333333333333333333333333333333333333333";
  const okUrl = "https://ok.example/r";
  return {
    chain: "tempo",
    host: "ok.example",
    service: "ok",
    url: okUrl,
    requestUrl: okUrl,
    payTo,
    amountAtomic: "6000",
    from: "t",
    tempo: {
      plan: { serviceId: "ok", request: { url: okUrl, method: "GET", body: null, contentType: null, inputSource: "none" }, lockedRecipient: payTo, lockedAmount: "6000", sponsored: false, allowlist: [] },
      feeReserveAtomic: FEE_RESERVE_ATOMIC.toString(),
    },
  };
}

function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signedTransfer(to: string, amount: bigint): Promise<string> {
  const data = encodeFunctionData({ abi: Abis.tip20, functionName: "transfer", args: [to as Hex, amount] });
  const tx = { type: "tempo" as const, chainId: 4217, calls: [{ to: USDC_E as Hex, data }], nonce: 0, gas: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, nonceKey: 2n ** 256n - 1n, validBefore: 1_790_000_000 };
  return throwaway.signTransaction(tx as never, { serializer: Transaction.serialize as never });
}

function signerCounting(signs: Map<string, number>): Signer {
  return {
    address: throwaway.address,
    async credentialFor(res, _id, recipient) {
      const p = normAddr(recipient);
      signs.set(p, (signs.get(p) ?? 0) + 1);
      const amount = BigInt(tempoChargeRequest(mppChallengesFromHeader(res.headers.get("www-authenticate"))[0]!)!.amount);
      return { credential: "Payment eyJ4IjoxfQ", serializedTx: await signedTransfer(recipient, amount) };
    },
  };
}

function wwwAuth(recipient: string, amount: string): string {
  return `Payment id="x", realm="x", method="tempo", intent="charge", request="${b64url({ amount, currency: USDC_E, recipient, methodDetails: { chainId: TEMPO_MAINNET_CHAIN_ID } })}", expires="2099-01-01T00:00:00Z"`;
}

function stageFetch(fakePay: string, okPay: string): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url: string, init?: RequestInit) => {
    if (url === CODEX_URL) return new Response("{}", { status: 402, headers: { "www-authenticate": wwwAuth(fakePay, "1000") } });
    if (new Headers(init?.headers).get("authorization")) return new Response('{"ok":true}', { status: 200 });
    return new Response("{}", { status: 402, headers: { "www-authenticate": wwwAuth(okPay, "6000") } });
  };
}

function setupPayRoot(payer: string, ledgerDay: string): { root: string; set: KeyLedgerSet; ledger: Ledger } {
  const root = mkdtempSync(join(tmpdir(), "tempo-pay-"));
  const set: KeyLedgerSet = { census: join(root, "c.json"), remeasureDir: root };
  writeFileSync(set.census, JSON.stringify({ kind: "vet402-tempo-ledger", version: 1, payer, cap: String(RM_TEMPO_MAX_PER_RUN_ATOMIC), entries: [] }));
  registerDayLedger(set, ledgerDay, payer, RM_TEMPO_MAX_PER_RUN_ATOMIC);
  const ledger = new Ledger(dayLedgerPath(root, ledgerDay), payer, RM_TEMPO_MAX_PER_RUN_ATOMIC);
  return { root, set, ledger };
}

// ---------- 1. four stages ----------

test("stages: candidates through record under not_settled_hold", async () => {
  const dir = derivedHoldDir(FAKE_CODEX_PAYTO);
  const fixture = loadFixture();
  const fakeCodex = targetFromSentRow(codexRowFromFixture(fixture));
  const ok = okTarget();
  const fakePay = FAKE_CODEX_PAYTO.toLowerCase();
  const okPay = ok.payTo;
  const candidates = [fakeCodex, ok];
  const signs = new Map<string, number>();
  const planDay = "2026-11-09";
  const payRoots: string[] = [];
  try {
    // (b) plan
    const holds = holdMod.notSettledHoldsFromDir(dir, planDay);
    assert.ok(holds.has(fakePay));
    const sel = selectSlots(candidates, 1, holds);
    assert.ok(sel.excluded.some((e) => e.reason === "not_settled_hold" && e.payTo === fakePay));
    assert.equal(sel.slots.length, 1);
    assert.equal(sel.slots[0]!.target.payTo, okPay);

    let codexFetches = 0;
    const dryFetch = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url === CODEX_URL) {
        codexFetches++;
        return new Response("{}", { status: 402, headers: { "www-authenticate": wwwAuth(fakePay, "1000") } });
      }
      return stageFetch(fakePay, okPay)(url, init);
    };
    const dry = await dryRunTempo(sel.slots, dryFetch, { date: planDay, monthElsewhere: 0n, monthCommittedToday: 0n });
    assert.equal(codexFetches, 0);
    assert.equal(dry.stopped, null);

    let payCodexFetches = 0;
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url === CODEX_URL) {
        payCodexFetches++;
        return new Response("{}", { status: 402, headers: { "www-authenticate": wwwAuth(fakePay, "1000") } });
      }
      return stageFetch(fakePay, okPay)(url, init);
    };
    const verify = async (_h: string, e: { recipient: string }) =>
      normAddr(e.recipient) === fakePay ? { settled: false, detail: "unsettled", feePaid: "30" } : { settled: true, detail: "ok", feePaid: "30" };
    const payDeps = { fetchImpl, signer: signerCounting(signs), payer: throwaway.address, balance: async () => 10_000_000n, verify };
    const payCtx = (ledger: Ledger, set: KeyLedgerSet) => ({
      date: planDay,
      ledger,
      keyLedgers: set,
      chain: { outflowSinceCensusStart: async () => 0n, outflowSinceMonthStart: async () => 0n },
      monthElsewhere: 0n,
      sleep: async () => {},
      notSettledHolds: holds,
    });

    // (c) sign — planned slots
    let root: string;
    let set: KeyLedgerSet;
    let ledger: Ledger;
    ({ root, set, ledger } = setupPayRoot(throwaway.address, planDay));
    payRoots.push(root);
    const planned = await payTempo(sel.slots, payDeps, payCtx(ledger, set));
    ledger.release();
    assert.ok(!sel.slots.some((s) => normAddr(s.target.payTo) === fakePay));
    assert.equal(planned.stopped, null);

    const payCtxNoHold = (ledger: Ledger, set: KeyLedgerSet) => ({
      date: planDay,
      ledger,
      keyLedgers: set,
      chain: { outflowSinceCensusStart: async () => 0n, outflowSinceMonthStart: async () => 0n },
      monthElsewhere: 0n,
      sleep: async () => {},
    });

    // (c) sign — bypass without hold guard (proves the counter is wired)
    const slotsBypass = [{ target: fakeCodex, slot: 0 }, { target: ok, slot: 0 }];
    payCodexFetches = 0;
    signs.clear();
    ({ root, set, ledger } = setupPayRoot(throwaway.address, planDay));
    payRoots.push(root);
    const bypassOpen = await payTempo(slotsBypass, payDeps, payCtxNoHold(ledger, set));
    ledger.release();
    assert.ok(payCodexFetches >= 1);
    assert.equal(signs.get(fakePay) ?? 0, 1);
    assert.ok(bypassOpen.rows.some((r) => r.outcome === "sent" && normAddr(r.expectedPayTo) === fakePay));

    // (c) sign — same slots with notSettledHolds (guard blocks codex)
    payCodexFetches = 0;
    signs.clear();
    ({ root, set, ledger } = setupPayRoot(throwaway.address, planDay));
    payRoots.push(root);
    const bypass = await payTempo(slotsBypass, payDeps, payCtx(ledger, set));
    ledger.release();
    assert.equal(payCodexFetches, 0);
    assert.equal(signs.get(fakePay) ?? 0, 0);
    assert.equal(signs.get(okPay) ?? 0, 1);
    assert.equal(bypass.stopped, null);

    // (d) record — from guarded bypass run
    const ledgerJson = JSON.parse(readFileSync(dayLedgerPath(root, planDay), "utf8")) as { entries: { recipient: string }[] };
    assert.ok(!ledgerJson.entries.some((e) => normAddr(e.recipient) === fakePay));
    assert.ok(!bypass.rows.some((r) => r.outcome === "sent" && normAddr(r.expectedPayTo) === fakePay));
    const holdRow = bypass.rows.find((r) => normAddr(r.expectedPayTo) === fakePay);
    assert.ok(holdRow);
    assert.equal(holdRow!.outcome, "refused");
    assert.equal(holdRow!.reason, "not_settled_hold");
    assert.match(holdRow!.detail ?? "", /holdDate=2026-11-08/);
    assert.match(holdRow!.detail ?? "", new RegExp(`holdKey=${PLAN_DAY}\\|${fakePay}\\|0`));
    assert.equal(signs.get(fakePay) ?? 0, 0);
    assert.equal(signs.get(okPay) ?? 0, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const r of payRoots) rmSync(r, { recursive: true, force: true });
  }
});

test("scripts/remeasure.ts --pay: lockAndReadHolds reads holds under tempo.lock; finally still releases the lock", () => {
  const src = readFileSync(join(REPO, "scripts/remeasure.ts"), "utf8");
  const tempoFn = src.slice(src.indexOf("async function tempo("), src.indexOf("async function chainCheck"));
  const payBranch = tempoFn.slice(tempoFn.indexOf("const { realSleep }"));
  const lockNeedle =
    "const { release, holds: payNotSettledHolds } = lockAndReadHolds(() => lockOrExit(join(OUT, \"tempo.lock\")), OUT, DATE);";
  const lockIdx = payBranch.indexOf(lockNeedle);
  assert.ok(lockIdx >= 0, "tempo --pay uses lockAndReadHolds");
  const afterLock = payBranch.slice(lockIdx + lockNeedle.length);
  const tryOpen = afterLock.indexOf("try {");
  assert.ok(tryOpen >= 0, "try { follows lockAndReadHolds");
  assert.doesNotMatch(afterLock.slice(0, tryOpen), /notSettledStateFromDir\(OUT, DATE\)/, "holds are not read again before try");
  const tryBody = afterLock.slice(tryOpen + "try {".length);
  const finallyIdx = tryBody.indexOf("} finally {");
  assert.ok(finallyIdx >= 0, "try has a finally");
  assert.doesNotMatch(tryBody.slice(0, finallyIdx), /notSettledStateFromDir\(OUT, DATE\)\.holds/);
  assert.match(tryBody.slice(finallyIdx), /ledger\?\.release\(\)/);
  assert.match(tryBody.slice(finallyIdx), /release\(\)/);
  assert.match(payBranch, /notSettledHolds:\s*payNotSettledHolds/);
});

test("scripts/remeasure.ts passes lockAndReadHolds holds into payTempo", () => {
  const src = readFileSync(join(REPO, "scripts/remeasure.ts"), "utf8");
  const tempoFn = src.slice(src.indexOf("async function tempo("), src.indexOf("async function chainCheck"));
  const payBranch = tempoFn.slice(tempoFn.indexOf("const { realSleep }"));
  assert.match(
    payBranch,
    /const \{ release, holds: payNotSettledHolds \} = lockAndReadHolds\(\(\) => lockOrExit\(join\(OUT, "tempo\.lock"\)\), OUT, DATE\);/,
  );
  assert.match(payBranch, /notSettledHolds:\s*payNotSettledHolds/);
  assert.match(src, /await tempo\(slots,\s*reconcileTargets,\s*notSettledState\)/);
  assert.match(src, /const slots = selectSlots\(allTargets,\s*perPayTo,\s*notSettledState\?\.holds,\s*notSettledState\?\.ended\)/);
});

test("lockAndReadHolds: a throw while reading holds under tempo.lock releases the lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "tempo-larh-throw-"));
  const lockPath = join(dir, "tempo.lock");
  try {
    writeFileSync(join(dir, "tempo-2026-11-08.json"), "{\n");
    assert.throws(() => holdMod.lockAndReadHolds(() => acquireRunLock(lockPath), dir, "2026-11-09"));
    assert.ok(!existsSync(lockPath), "lock file removed after read failure");
    const release = acquireRunLock(lockPath);
    release();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lockAndReadHolds: valid tempo results return holds and release removes tempo.lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "tempo-larh-ok-"));
  const lockPath = join(dir, "tempo.lock");
  try {
    writeFileSync(join(dir, "tempo-2026-11-08.json"), readFileSync(FIX_JSON));
    const { release, holds } = holdMod.lockAndReadHolds(() => acquireRunLock(lockPath), dir, "2026-11-09");
    assert.ok(holds.size >= 1);
    assert.ok(existsSync(lockPath));
    release();
    assert.ok(!existsSync(lockPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 2. build-receipts ----------

test("build-receipts: skipped unsettled row matches notSettledHoldsFromDir payTos", () => {
  const fixture = loadFixture();
  const rm = mkdtempSync(join(tmpdir(), "tempo-br-rm-"));
  const out = mkdtempSync(join(tmpdir(), "tempo-br-out-"));
  try {
    const keyPath = join(rm, "attest.json");
    const pk = generatePrivateKey();
    writeFileSync(keyPath, `${JSON.stringify({ privateKey: pk })}\n`);
    writeFileSync(join(rm, "tempo-2026-11-08.json"), readFileSync(FIX_JSON));
    writeDayLedgerFromSent(rm, fixture);

    const r = spawnSync(
      process.execPath,
      ["--import", "tsx", join(REPO, "scripts/build-receipts.ts"), "--key", keyPath, "--out", out, "--day", "2026-11-08", "--remeasure-dir", rm, "--chains", "tempo"],
      { cwd: REPO, encoding: "utf8", env: { ...process.env, VET402_EVM_KEY_FILE: MISSING_EVM_KEY } },
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);

    const skipped = JSON.parse(readFileSync(join(out, "2026-11-08", "skipped.json"), "utf8")) as { row: string; reason: string }[];
    const row28 = skipped.find((s) => s.row === "rows[28]");
    assert.ok(row28);
    assert.match(row28!.reason, /not confirmed/);

    const built = readdirSync(join(out, "2026-11-08")).filter((f) => f.endsWith(".json") && f.startsWith("obs_"));
    assert.ok(built.length >= 1, "at least one receipt must be built");
    for (const f of built) {
      const text = readFileSync(join(out, "2026-11-08", f), "utf8");
      assert.ok(!text.includes(fixture.rows[28]!.key), `${f} must not reference rows[28] key`);
    }

    const holds = holdMod.notSettledHoldsFromDir(rm, "2026-11-09");
    assert.equal(holds.size, 1);
    assert.ok(holds.has(normAddr(REAL_CODEX_PAYTO)));
    const unsettledPayTos = new Set<string>();
    for (const s of skipped) {
      if (!/not confirmed/.test(s.reason)) continue;
      const m = /^rows\[(\d+)\]$/.exec(s.row);
      if (!m) continue;
      const row = fixture.rows[Number(m[1])]!;
      if (row.outcome === "sent" && row.settled === false) unsettledPayTos.add(normAddr(row.payTo ?? row.expectedPayTo));
    }
    assert.deepEqual(new Set(holds.keys()), unsettledPayTos);

    const ledgerPath = dayLedgerPath(rm, "2026-11-08");
    rmSync(ledgerPath);
    const holdsResultOnly = holdMod.notSettledHoldsFromDir(rm, "2026-11-09");
    assert.equal(holdsResultOnly.size, 1);
    assert.ok(holdsResultOnly.has(normAddr(REAL_CODEX_PAYTO)));

    writeDayLedgerFromSent(rm, fixture);
    rmSync(join(rm, "tempo-2026-11-08.json"));
    const holdsLedgerOnly = holdMod.notSettledHoldsFromDir(rm, "2026-11-09");
    assert.equal(holdsLedgerOnly.size, 1);
    assert.ok(holdsLedgerOnly.has(normAddr(REAL_CODEX_PAYTO)));
  } finally {
    rmSync(rm, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

// ---------- 3. hold ended ----------

test("hold ended: plan day 2026-11-16 slots fake codex with holdEnded line", () => {
  assert.equal(typeof holdMod.notSettledStateFromDir, "function");
  assert.equal(typeof holdMod.holdEndedLine, "function");
  const dir = derivedHoldDir(FAKE_CODEX_PAYTO);
  try {
    const fixture = loadFixture();
    const fakeCodex = targetFromSentRow(codexRowFromFixture(fixture));
    const state = holdMod.notSettledStateFromDir(dir, "2026-11-16");
    assert.equal(state.holds.size, 0);
    assert.ok(state.ended.has(FAKE_CODEX_PAYTO.toLowerCase()));
    const sel = selectSlots([fakeCodex, okTarget()], 1, state.holds, state.ended);
    assert.equal(sel.holdEnded.length, 1);
    assert.equal(sel.holdEnded[0]!.payTo, FAKE_CODEX_PAYTO.toLowerCase());
    assert.equal(sel.holdEnded[0]!.holdDate, "2026-11-08");
    const line = holdMod.holdEndedLine(sel.holdEnded[0]!);
    assert.match(line, new RegExp(FAKE_CODEX_PAYTO.slice(2), "i"));
    assert.match(line, /graph\.codex\.io/);
    assert.match(line, /2026-11-08/);
    assert.match(line, new RegExp(`${PLAN_DAY}\\|${FAKE_CODEX_PAYTO.toLowerCase()}\\|0`));
    assert.ok(!/\b(we|our)\b/i.test(line));
    assert.ok(!/[;—–]/.test(line));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hold ended: plan day 2026-11-15 stays on hold, not in ended", () => {
  assert.equal(typeof holdMod.notSettledStateFromDir, "function");
  const dir = derivedHoldDir(FAKE_CODEX_PAYTO);
  try {
    const state = holdMod.notSettledStateFromDir(dir, "2026-11-15");
    assert.ok(state.holds.has(FAKE_CODEX_PAYTO.toLowerCase()));
    assert.equal(state.ended.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hold ended: 2026-11-12 unsettled attempt keeps fake codex on hold at 2026-11-16", () => {
  assert.equal(typeof holdMod.notSettledStateFromDir, "function");
  const dir = derivedHoldDir(FAKE_CODEX_PAYTO);
  try {
    const fixture = loadFixture();
    const pay = normAddr(FAKE_CODEX_PAYTO);
    const row = {
      ...fixture.rows[28]!,
      payTo: pay,
      expectedPayTo: pay,
      outcome: "sent" as const,
      settled: false,
      at: "2026-11-12T12:00:00.000Z",
      key: `2026-11-12|${pay}|0`,
    };
    writeFileSync(join(dir, "tempo-2026-11-12.json"), JSON.stringify({ ...fixture, date: "2026-11-12", rows: [row] }));
    const state = holdMod.notSettledStateFromDir(dir, "2026-11-16");
    assert.ok(state.holds.has(pay));
    assert.equal(state.ended.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hold ended: settled true on 2026-11-10 clears ended on 2026-11-16", () => {
  assert.equal(typeof holdMod.notSettledStateFromDir, "function");
  const dir = derivedHoldDir(FAKE_CODEX_PAYTO);
  try {
    const healed = loadFixture();
    const pay = normAddr(FAKE_CODEX_PAYTO);
    const last = { ...healed.rows[28]!, payTo: pay, expectedPayTo: pay, settled: true, tx: `0x${"aa".repeat(32)}`, at: "2026-11-10T12:00:00.000Z", key: `2026-11-10|${pay}|0` };
    healed.date = "2026-11-10";
    healed.rows = [last];
    writeFileSync(join(dir, "tempo-2026-11-10.json"), JSON.stringify(healed));
    const state = holdMod.notSettledStateFromDir(dir, "2026-11-16");
    assert.equal(state.holds.size, 0);
    assert.equal(state.ended.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("scripts/remeasure.ts logs holdNoticeLines once on --pay only, dry-run JSON has holdEnded", () => {
  const src = readFileSync(join(REPO, "scripts/remeasure.ts"), "utf8");
  // Only the Tempo function: its dry-run branch (if (!PAY) ... return 0) and its --pay branch (after realSleep).
  const tempoFn = src.slice(src.indexOf("async function tempo("), src.indexOf("async function chainCheck"));
  const payStart = tempoFn.indexOf("const { realSleep }");
  assert.ok(tempoFn.length > 0 && payStart > 0, "Tempo function and its --pay branch are found");
  const dryBlock = tempoFn.slice(tempoFn.indexOf("if (!PAY) {"), payStart);
  assert.doesNotMatch(dryBlock, /holdNoticeLines/);
  assert.match(dryBlock, /holdEnded:\s*slotsAll\.holdEnded/);
  assert.match(dryBlock, /holdEndedUnreadable:\s*notSettledState\?\.unreadable \?\? \[\]/);
  const payBlock = tempoFn.slice(payStart, tempoFn.indexOf("lockOrExit("));
  const payLogs = [...payBlock.matchAll(/for \(const line of holdNoticeLines\(slotsAll\.holdEnded, notSettledState\?\.unreadable \?\? \[\]\)\) console\.log\(line\);/g)];
  assert.equal(payLogs.length, 1);
});

test("holdNoticeLines: plan day 2026-11-16 yields one ended line with codex fields, 2026-11-15 yields none", () => {
  const dir = derivedHoldDir(FAKE_CODEX_PAYTO);
  try {
    const fixture = loadFixture();
    const fakeCodex = targetFromSentRow(codexRowFromFixture(fixture));
    const fakePay = FAKE_CODEX_PAYTO.toLowerCase();
    const state16 = holdMod.notSettledStateFromDir(dir, "2026-11-16");
    const sel16 = selectSlots([fakeCodex, okTarget()], 1, state16.holds, state16.ended);
    const lines16 = holdMod.holdNoticeLines(sel16.holdEnded, state16.unreadable);
    assert.equal(lines16.length, 1);
    const line = lines16[0]!;
    assert.match(line, new RegExp(fakePay.slice(2), "i"));
    assert.match(line, /graph\.codex\.io/);
    assert.match(line, /2026-11-08/);
    assert.match(line, new RegExp(`${PLAN_DAY}\\|${fakePay}\\|0`));
    assert.ok(!/\b(we|our)\b/i.test(line));
    assert.ok(!/[;—–]/.test(line));

    const state15 = holdMod.notSettledStateFromDir(dir, "2026-11-15");
    const sel15 = selectSlots([fakeCodex, okTarget()], 1, state15.holds, state15.ended);
    assert.equal(holdMod.holdNoticeLines(sel15.holdEnded, state15.unreadable).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("not_settled_hold repurchase: 2026-11-16 holds allow codex send, 2026-11-15 holds refuse", async () => {
  const dir = derivedHoldDir(FAKE_CODEX_PAYTO);
  const fixture = loadFixture();
  const fakeCodex = targetFromSentRow(codexRowFromFixture(fixture));
  const fakePay = FAKE_CODEX_PAYTO.toLowerCase();
  const planDay = "2026-11-16";
  const signs = new Map<string, number>();
  let codexFetches = 0;
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === CODEX_URL) {
      codexFetches++;
      return new Response("{}", { status: 402, headers: { "www-authenticate": wwwAuth(fakePay, "1000") } });
    }
    if (new Headers(init?.headers).get("authorization")) return new Response('{"ok":true}', { status: 200 });
    return new Response("{}", { status: 402 });
  };
  const payDeps = {
    fetchImpl,
    signer: signerCounting(signs),
    payer: throwaway.address,
    balance: async () => 10_000_000n,
    verify: async () => ({ settled: true, detail: "ok", feePaid: "30" }),
  };
  const roots: string[] = [];
  try {
    const state16 = holdMod.notSettledStateFromDir(dir, planDay);
    assert.equal(state16.holds.size, 0);
    const slots16 = [{ target: fakeCodex, slot: 0 }];
    const setup16 = setupPayRoot(throwaway.address, planDay);
    roots.push(setup16.root);
    const rebuy = await payTempo(slots16, payDeps, {
      date: planDay,
      ledger: setup16.ledger,
      keyLedgers: setup16.set,
      chain: { outflowSinceCensusStart: async () => 0n, outflowSinceMonthStart: async () => 0n },
      monthElsewhere: 0n,
      sleep: async () => {},
      notSettledHolds: state16.holds,
    });
    setup16.ledger.release();
    assert.equal(signs.get(fakePay) ?? 0, 1);
    assert.ok(codexFetches >= 1);
    assert.ok(rebuy.rows.some((r) => r.outcome === "sent" && normAddr(r.expectedPayTo) === fakePay));

    const state15 = holdMod.notSettledStateFromDir(dir, "2026-11-15");
    codexFetches = 0;
    signs.clear();
    const setup15 = setupPayRoot(throwaway.address, "2026-11-15");
    roots.push(setup15.root);
    const held = await payTempo(slots16, payDeps, {
      date: "2026-11-15",
      ledger: setup15.ledger,
      keyLedgers: setup15.set,
      chain: { outflowSinceCensusStart: async () => 0n, outflowSinceMonthStart: async () => 0n },
      monthElsewhere: 0n,
      sleep: async () => {},
      notSettledHolds: state15.holds,
    });
    setup15.ledger.release();
    assert.equal(codexFetches, 0);
    assert.equal(signs.get(fakePay) ?? 0, 0);
    const refuse = held.rows.find((r) => normAddr(r.expectedPayTo) === fakePay);
    assert.ok(refuse);
    assert.equal(refuse!.outcome, "refused");
    assert.equal(refuse!.reason, "not_settled_hold");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  }
});

test("notSettledStateFromDir: pre-window result bad row mid-file is unreadable, does not partial-merge ended", () => {
  const dir = mkdtempSync(join(tmpdir(), "tempo-pre-bad-row-"));
  const otherPay = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const badFile = join(dir, "tempo-2026-11-01.json");
  try {
    const fixture = loadFixture();
    const sent = {
      ...fixture.rows[0]!,
      chain: "tempo" as const,
      payTo: otherPay,
      expectedPayTo: otherPay,
      outcome: "sent" as const,
      settled: false,
      at: "2026-11-01T12:00:00.000Z",
      key: `2026-11-01|${otherPay}|0`,
    };
    writeFileSync(
      badFile,
      JSON.stringify(
        { kind: "vet402-remeasure", version: 1, chain: "tempo", date: "2026-11-01", payer: fixture.payer, note: "", runs: [], rows: [sent, null] },
        null,
        2,
      ) + "\n",
    );
    const state = holdMod.notSettledStateFromDir(dir, "2026-11-16");
    assert.ok(!state.ended.has(normAddr(otherPay)));
    assert.deepEqual(new Set(state.unreadable), new Set([badFile]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notSettledStateFromDir: pre-window corrupt files are skipped, in-window corrupt files throw", () => {
  const dir = derivedHoldDir(FAKE_CODEX_PAYTO);
  const badResult = join(dir, "tempo-2026-11-01.json");
  const badLedger = join(dir, "tempo-ledger-2026-10-31.json");
  try {
    writeFileSync(badResult, "{not json");
    writeFileSync(badLedger, JSON.stringify({ version: 2, payer: "0x0", capAtomic: "0", entries: [] }));
    const pay = normAddr(FAKE_CODEX_PAYTO);
    const state09 = holdMod.notSettledStateFromDir(dir, "2026-11-09");
    assert.equal(state09.holds.size, 1);
    assert.ok(state09.holds.has(pay));
    assert.deepEqual(new Set(state09.unreadable), new Set([badResult, badLedger]));
    assert.equal(typeof holdMod.holdEndedUnreadableLine, "function");
    assert.match(holdMod.holdEndedUnreadableLine(badResult), /could not read/);
    assert.ok(!/\b(we|our)\b/i.test(holdMod.holdEndedUnreadableLine(badResult)));
    assert.ok(!/[;—–]/.test(holdMod.holdEndedUnreadableLine(badResult)));

    const state16 = holdMod.notSettledStateFromDir(dir, "2026-11-16");
    assert.equal(state16.holds.size, 0);
    assert.ok(state16.ended.has(pay));
    assert.deepEqual(new Set(state16.unreadable), new Set([badResult, badLedger]));

    writeFileSync(join(dir, "tempo-ledger-2026-11-08.json"), "{");
    assert.throws(() => holdMod.notSettledStateFromDir(dir, "2026-11-09"), /JSON|Unexpected|tempo day ledger/);
    assert.throws(() => holdMod.notSettledHoldsFromDir(dir, "2026-11-09"), /JSON|Unexpected|tempo day ledger/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- 4. regressions ----------

test("regression: real quarantined codex stays quarantined, not hold, no holdEnded on 2026-11-16", () => {
  assert.equal(typeof holdMod.notSettledStateFromDir, "function");
  const read = (p: string) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "data", p), "utf8"));
  const tem = tempoFromLedger(read("tempo/ledger.json"), read("tempo/census-plan-2026-09-28.json"), "t");
  const q = RM_QUARANTINED.find((x) => x.chain === "tempo")!;
  const dir = mkdtempSync(join(tmpdir(), "tempo-q-"));
  try {
    writeFileSync(join(dir, "tempo-2026-11-08.json"), readFileSync(FIX_JSON));
    const state = holdMod.notSettledStateFromDir(dir, "2026-11-16");
    assert.ok(state.ended.has(normAddr(q.payTo)));
    const sel = selectSlots(tem, 1, state.holds, state.ended);
    const codexTem = tem.filter((t) => t.payTo === normAddr(q.payTo));
    assert.ok(codexTem.length > 0);
    const codexEx = sel.excluded.filter((e) => e.payTo === normAddr(q.payTo));
    assert.equal(codexEx.length, codexTem.length);
    assert.ok(codexEx.every((e) => e.reason === "quarantined"));
    assert.ok(!codexEx.some((e) => e.reason === "not_settled_hold"));
    assert.equal(sel.holdEnded.filter((e) => e.payTo === normAddr(q.payTo)).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("regression: planVerdict still pays when holds are excluded but would_pay fits caps", () => {
  const day = "2026-10-01";
  const payTo = "0x3333333333333333333333333333333333333333";
  const rows = [
    { key: `${day}|${payTo}|0`, outcome: "would_pay", priceUsdc: "0.500000" },
    { key: `${day}|0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|0`, outcome: "refused", reason: "not_settled_hold", priceUsdc: "0.600000" },
  ];
  const plan = {
    kind: "vet402-remeasure-dry-run",
    chain: "tempo",
    createdAt: `${day}T01:00:00.000Z`,
    perPayTo: 1,
    caps: { perPurchase: "0.100000", perRun: "1.000000", perMonth: "30.000000", monthLeft: "25.000000" },
    summary: { would: 1, estimate: "0.500000", payerUsdcEBefore: "16.000000" },
    excluded: [{ url: "https://graph.codex.io/graphql", payTo: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", reason: "not_settled_hold" }],
    rows,
  };
  const v = planVerdict(plan, "tempo", day, 1);
  assert.equal(v.pay, true);

  const allHold = {
    ...plan,
    summary: { would: 0, estimate: "0.000000", payerUsdcEBefore: "16.000000" },
    rows: [{ key: `${day}|${payTo}|0`, outcome: "refused", reason: "not_settled_hold", priceUsdc: "0.010000" }],
  };
  const none = planVerdict(allHold, "tempo", day, 1);
  assert.ok(!none.pay && !none.stop, none.line);
  assert.match(none.line, /nothing to buy/);
});

test("regression: Solana short balance plan stays skip not stop", () => {
  const day = "2026-10-01";
  const payTo = "226DYoWb2e6uYxDkFp7vK8jZhzzh2VNvHH6DgbDsNueC";
  const plan = {
    kind: "vet402-remeasure-dry-run",
    chain: "solana",
    createdAt: `${day}T01:00:00.000Z`,
    perPayTo: 1,
    caps: { perPurchase: "0.100000", perRun: "3.000000", perMonth: "30.000000", monthLeft: "25.000000" },
    summary: { would: 1, estimate: "2.000000", payerUsdcBefore: "1.000000" },
    rows: [{ key: `${day}|${payTo}|0`, outcome: "would_pay", priceUsdc: "2.000000" }],
  };
  const v = planVerdict(plan, "solana", day, 1);
  assert.ok(!v.pay && !v.stop && v.skip);
});