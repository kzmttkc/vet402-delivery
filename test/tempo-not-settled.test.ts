/**
 * Plan 3.1: Tempo not_settled (2026-11-08 fixture), rebuy hold, and the four delivery stages.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { encodeFunctionData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Abis, Transaction } from "viem/tempo";
import { checkOutflows, unitsToAtomic6, type OutTx } from "../src/chaincheck.js";
import { RM_TEMPO_MAX_PER_RUN_ATOMIC } from "../src/remeasure/constants.js";
import type { PlanEntry } from "../src/tempo/census.js";
import { sharedEvmSignBlockedByTempo, tempoStoppedReasonFromJson } from "../src/evm/tempo-evm-payer-stop.js";
import { checkTempoRun, runCandidates, type RunWithCheck } from "../src/remeasure/chaincheck.js";
import { notSettledHoldsFromDir, notSettledStateFromDir } from "../src/remeasure/not-settled-hold.js";
import { dayLedgerPath, dryRunTempo, payTempo } from "../src/remeasure/tempo.js";
import type { ResultFile, RemeasureRow } from "../src/remeasure/results.js";
import { selectSlots, type Target } from "../src/remeasure/targets.js";
import { TEMPO_FEE_MANAGER, TEMPO_MAINNET_CHAIN_ID, USDC_E, FEE_RESERVE_ATOMIC, normAddr } from "../src/tempo/constants.js";
import { mppChallengesFromHeader, tempoChargeRequest } from "../src/tempo/challenge.js";
import { Ledger } from "../src/tempo/ledger.js";
import { stopReason, runPlan, type PayDeps, type PayOutcome } from "../src/tempo/pay.js";
import { registerDayLedger, type KeyLedgerSet } from "../src/tempo/key-ledgers.js";
import type { Signer } from "../src/tempo/chain.js";
import type { TempoOutflowReader } from "../src/tempo/chaincheck.js";

const FIX = join(import.meta.dirname, "fixtures", "tempo-not-settled-1108");
const FIX_JSON = join(FIX, "tempo-2026-11-08.json");
const FIX_LOG = join(FIX, "am-log-excerpt.txt");
const CODEX = "0xc12b5d802da90d14a8b35dec1cfb6fd5ceede60b";
const CODEX_URL = "https://graph.codex.io/graphql";
const PLAN_DAY = "2026-11-08";
const PLAN_DAY_AFTER = "2026-11-09";
const REPO = join(import.meta.dirname, "..");
const TSX_GATE = ["--import", "tsx", join(REPO, "scripts/daily/secret-gate.ts")];
const TSX_STEPS = ["--import", "tsx", join(REPO, "scripts/daily/steps.ts")];
/** Not in RM_QUARANTINED: derived fixture replaces codex payTo so hold is testable apart from quarantine. */
const FAKE_CODEX_PAYTO = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const throwaway = privateKeyToAccount(generatePrivateKey());
const MISSING_EVM_KEY = join(tmpdir(), "vet402-missing-evm-key.json");

function loadFixture(): ResultFile {
  return JSON.parse(readFileSync(FIX_JSON, "utf8")) as ResultFile;
}

function usdcAtomic(priceUsdc: string): string {
  const [w, f = ""] = priceUsdc.split(".");
  return (BigInt(w!) * 1_000_000n + BigInt(f.padEnd(6, "0"))).toString();
}

function outTxsFromRows(file: ResultFile): OutTx[] {
  return file.rows
    .filter((r) => r.outcome === "sent" && r.tx)
    .map((r) => ({
      tx: r.tx!,
      timeMs: Date.parse(r.at) + 2_000,
      transfers: [{ to: normAddr(r.payTo ?? r.expectedPayTo), amount: unitsToAtomic6(r.priceUsdc!) }],
    }));
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

function fakeTempoReader(txs: OutTx[]): TempoOutflowReader {
  return {
    outTxs: async (fromMs, toMs) => txs.filter((t) => t.timeMs >= fromMs && t.timeMs <= toMs),
    verify: async () => ({ settled: true, detail: "transfer found", feePaid: null }),
  };
}

function throwSigner(signs: { n: number }): Signer {
  return {
    address: throwaway.address,
    async credentialFor() {
      signs.n++;
      throw new Error("signer must not run in this path");
    },
  };
}

function holdsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tempo-hold-"));
  writeFileSync(join(dir, "tempo-2026-11-08.json"), readFileSync(FIX_JSON));
  return dir;
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

function targetsFromSentRows(file: ResultFile): Target[] {
  return file.rows.filter((r) => r.outcome === "sent").map(targetFromSentRow);
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

function derivedHoldDir(fakeCodexPayTo: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tempo-hold-derived-"));
  const file = loadFixture();
  const pay = normAddr(fakeCodexPayTo);
  const rows = file.rows.map((r, i) =>
    i === 28 ? { ...r, payTo: pay, expectedPayTo: pay, key: `${PLAN_DAY}|${pay}|0` } : r,
  );
  writeFileSync(join(dir, "tempo-2026-11-08.json"), JSON.stringify({ ...file, rows }, null, 2) + "\n");
  return dir;
}

function codexRowFromFixture(file: ResultFile, payTo = FAKE_CODEX_PAYTO): RemeasureRow {
  const row = { ...file.rows[28]! };
  const pay = normAddr(payTo);
  return { ...row, payTo: pay, expectedPayTo: pay, key: `${PLAN_DAY}|${pay}|0` };
}

function spawnOk(argv: string[], cwd = REPO, env?: NodeJS.ProcessEnv): void {
  const r = spawnSync(process.execPath, argv, { cwd, encoding: "utf8", env: { ...process.env, VET402_EVM_KEY_FILE: MISSING_EVM_KEY, ...env } });
  assert.equal(r.status, 0, `${argv.join(" ")}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
}

// ---------- A. fixture shape ----------

test("fixture copy: last run stopped not_settled, chain check 17/17/0, rows[28] is codex unsettled with no tx, log lines present", () => {
  const file = loadFixture();
  const run = file.runs.at(-1)! as RunWithCheck;
  assert.equal(run.stopped, "not_settled");
  assert.deepEqual([run.chainCheck?.txs, run.chainCheck?.recorded, run.chainCheck?.unmatched.length], [17, 17, 0]);
  const row = file.rows[28]!;
  assert.equal(row.host, "graph.codex.io");
  assert.deepEqual([row.settled, row.tx, row.httpStatus], [false, null, 402]);
  const log = readFileSync(FIX_LOG, "utf8");
  assert.match(log, /stopped: not_settled/);
  assert.match(log, /chain check: 17 txs out of the payer, 17 on a row/);
});

// ---------- B–E. four delivery stages (no new signatures) ----------

test("four stages: recorded buy, chain recheck, publish copy, and daily root run with zero new signatures", async () => {
  const signs = { n: 0 };
  const signer = throwSigner(signs);
  const fixture = loadFixture();
  const run = fixture.runs.at(-1)! as RunWithCheck;
  assert.equal(run.stopped, "not_settled");

  const roots: string[] = [];
  const buyRoot = mkdtempSync(join(tmpdir(), "tempo-buy-"));
  roots.push(buyRoot);
  try {
  const set: KeyLedgerSet = { census: join(buyRoot, "census.json"), remeasureDir: buyRoot };
  writeFileSync(set.census, JSON.stringify({ kind: "vet402-tempo-ledger", version: 1, payer: fixture.payer, cap: String(RM_TEMPO_MAX_PER_RUN_ATOMIC), entries: [] }));
  registerDayLedger(set, PLAN_DAY, fixture.payer, RM_TEMPO_MAX_PER_RUN_ATOMIC);
  writeDayLedgerFromSent(buyRoot, fixture);
  const buyLedger = new Ledger(dayLedgerPath(buyRoot, PLAN_DAY), fixture.payer, RM_TEMPO_MAX_PER_RUN_ATOMIC, { lock: true });
  const targets = targetsFromSentRows(fixture);
  assert.ok(targets.some((t) => t.host === "graph.codex.io"), "fixture sent rows include codex");
  const slots = selectSlots(targets, 1).slots;
  const chFor = (t: Target) =>
    `Payment id="x", realm="${t.host}", method="tempo", intent="charge", request="${b64url({ amount: t.amountAtomic, currency: USDC_E, recipient: t.payTo, methodDetails: { chainId: TEMPO_MAINNET_CHAIN_ID } })}", expires="2099-01-01T00:00:00Z"`;
  const fetchNoSign = async (url: string, init?: RequestInit): Promise<Response> => {
    if (new Headers(init?.headers).get("authorization")) throw new Error("signer must not run");
    const t = targets.find((x) => x.url === url || x.requestUrl === url);
    if (!t) return new Response("{}", { status: 404 });
    return new Response("{}", { status: 402, headers: { "www-authenticate": chFor(t) } });
  };
  try {
    const pay = await payTempo(
      slots,
      {
        fetchImpl: fetchNoSign,
        signer,
        payer: fixture.payer,
        balance: async () => 10_000_000n,
        verify: async () => ({ settled: true, detail: "transfer found", feePaid: "30" }),
      },
      {
        date: PLAN_DAY,
        ledger: buyLedger,
        keyLedgers: set,
        chain: { outflowSinceCensusStart: async () => 0n, outflowSinceMonthStart: async () => 0n },
        monthElsewhere: 0n,
        sleep: async () => {},
      },
    );
    assert.equal(signs.n, 0);
    assert.equal(pay.stopped, null);
    assert.ok(pay.rows.every((r) => r.outcome === "refused" && r.reason === "already_bought"));
  } finally {
    buyLedger.release();
  }

  const file = structuredClone(fixture);
  const txs = outTxsFromRows(file);
  const row = file.rows[28]!;
  const ccDir = mkdtempSync(join(tmpdir(), "tempo-cc-"));
  roots.push(ccDir);
  const ccSet: KeyLedgerSet = { census: join(ccDir, "c.json"), remeasureDir: ccDir };
  writeFileSync(ccSet.census, JSON.stringify({ kind: "vet402-tempo-ledger", version: 1, payer: file.payer, cap: "1000000", entries: [] }));
  writeFileSync(join(ccDir, "tempo-ledger-index.json"), JSON.stringify({ kind: "vet402-tempo-day-ledgers", dates: [file.date] }));
  const dayPath = dayLedgerPath(ccDir, file.date);
  writeFileSync(dayPath, JSON.stringify({ version: 1, payer: file.payer, capAtomic: "1000000", entries: [{ key: row.key, url: row.url, recipient: row.payTo!, amount: "1000", status: "sent", settled: false, reservedAt: row.at }] }));
  const ledger = new Ledger(dayPath, file.payer, 1_000_000n, { lock: true });
  try {
    const cand = runCandidates(file, run, Date.parse(run.endedAt!))[0]!;
    const match: OutTx = {
      tx: `0x${"cd".repeat(32)}`,
      timeMs: Math.floor((cand.fromMs + cand.toMs) / 2),
      transfers: [{ to: normAddr(row.payTo!), amount: cand.amount }],
    };
  // checkTempoRun (src/remeasure/chaincheck.ts): chain read + ledger patch only; no signer in its parameter list.
    type CheckArgs = Parameters<typeof checkTempoRun>[0];
    const checkArgKeys = new Set(Object.keys({ file, run, dayLedger: ledger, set: ccSet, reader: fakeTempoReader([...txs, match]), endMs: Date.parse(run.endedAt!) } satisfies CheckArgs));
    assert.ok(!checkArgKeys.has("signer"));
    const chainCheck = await checkTempoRun({ file, run, dayLedger: ledger, set: ccSet, reader: fakeTempoReader([...txs, match]), endMs: Date.parse(run.endedAt!) });
    assert.equal(chainCheck.recorded, 17);
    assert.equal(chainCheck.unmatched.length, 0);
    assert.equal(file.rows[28]!.tx, match.tx);
  } finally {
    ledger.release();
  }

  const pubDir = mkdtempSync(join(tmpdir(), "tempo-pub-"));
  roots.push(pubDir);
  const copyOut = join(pubDir, "data", "remeasure", "tempo-2026-11-08.json");
  mkdirSync(dirname(copyOut), { recursive: true });
  // scripts/daily/run.sh copy_day: scripts/daily/secret-gate.ts copy <result> <data/remeasure/...>
  const gate = spawnSync(process.execPath, [...TSX_GATE, "copy", FIX_JSON, copyOut, "--allow", join(REPO, "scripts/daily/secret-allow.json")], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, VET402_EVM_KEY_FILE: MISSING_EVM_KEY },
  });
  assert.equal(gate.status, 0, gate.stderr);
  const gateMeta = JSON.parse(gate.stdout.trim()) as { redactions: unknown[] };
  writeFileSync(
    join(pubDir, "data", "manifest.json"),
    `${JSON.stringify({ kind: "vet402-rank-inputs", date: PLAN_DAY, files: [] }, null, 2)}\n`,
  );
  // scripts/daily/run.sh: daily_steps manifest "$PUB/data" --file remeasure/tempo-<day>.json --day <day> --redactions "$reds"
  const reds = JSON.stringify(gateMeta.redactions ?? []);
  spawnOk([...TSX_STEPS, "manifest", join(pubDir, "data"), "--file", "remeasure/tempo-2026-11-08.json", "--day", PLAN_DAY, "--redactions", reds]);
  const published = readFileSync(copyOut, "utf8");
  const sha = createHash("sha256").update(published).digest("hex");
  const manifest = JSON.parse(readFileSync(join(pubDir, "data", "manifest.json"), "utf8")) as { files: { label: string; sha256: string }[] };
  const entry = manifest.files.find((f) => f.label === "remeasure/tempo-2026-11-08");
  assert.ok(entry);
  assert.equal(entry.sha256, sha);

  // scripts/build-receipts.ts --day: spends from tempo-ledger-<day>.json (no --send, no --simulate-anchor).
  const receiptRm = mkdtempSync(join(tmpdir(), "tempo-rcpt-"));
  const receiptOut = mkdtempSync(join(tmpdir(), "tempo-rcpt-out-"));
  roots.push(receiptRm, receiptOut);
  const attestKey = join(receiptRm, "attest.json");
  writeFileSync(attestKey, `${JSON.stringify({ privateKey: generatePrivateKey() })}\n`);
  writeFileSync(join(receiptRm, "tempo-2026-11-08.json"), readFileSync(FIX_JSON));
  writeDayLedgerFromSent(receiptRm, fixture);
  spawnOk(
    ["--import", "tsx", join(REPO, "scripts/build-receipts.ts"), "--key", attestKey, "--out", receiptOut, "--day", PLAN_DAY, "--remeasure-dir", receiptRm, "--chains", "tempo"],
  );
  const skipped = JSON.parse(readFileSync(join(receiptOut, PLAN_DAY, "skipped.json"), "utf8")) as { row: string; reason: string }[];
  assert.ok(skipped.some((s) => s.row === "rows[28]" && /not confirmed/.test(s.reason)));
  const built = readdirSync(join(receiptOut, PLAN_DAY)).filter((f) => f.endsWith(".json") && f.startsWith("obs_"));
  assert.ok(built.length >= 1);
  for (const f of built) {
    assert.ok(!readFileSync(join(receiptOut, PLAN_DAY, f), "utf8").includes(fixture.rows[28]!.key), `${f} must not reference rows[28] key`);
  }
  } finally {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  }
});

test("four stages build-receipts: not_settled_hold refusal row lands in skipped.json", () => {
  const fixture = loadFixture();
  const pay = normAddr(FAKE_CODEX_PAYTO);
  const holdRefusal: RemeasureRow = {
    ...codexRowFromFixture(fixture),
    at: `${PLAN_DAY}T23:00:00.000Z`,
    outcome: "refused",
    reason: "not_settled_hold",
    detail: `holdDate=${PLAN_DAY} holdKey=${PLAN_DAY}|${pay}|0`,
    settled: null,
    delivered: null,
    httpStatus: null,
    bodyBytes: null,
    tx: null,
    priceUsdc: "0.001000",
    key: `${PLAN_DAY}|${pay}|1`,
  };
  const rm = mkdtempSync(join(tmpdir(), "tempo-br-hold-"));
  const out = mkdtempSync(join(tmpdir(), "tempo-br-hold-out-"));
  try {
    const keyPath = join(rm, "attest.json");
    writeFileSync(keyPath, `${JSON.stringify({ privateKey: generatePrivateKey() })}\n`);
    writeFileSync(join(rm, "tempo-2026-11-08.json"), JSON.stringify({ ...fixture, rows: [...fixture.rows, holdRefusal] }, null, 2) + "\n");
    writeDayLedgerFromSent(rm, fixture);
    spawnOk(
      ["--import", "tsx", join(REPO, "scripts/build-receipts.ts"), "--key", keyPath, "--out", out, "--day", PLAN_DAY, "--remeasure-dir", rm, "--chains", "tempo"],
    );
    const skipped = JSON.parse(readFileSync(join(out, PLAN_DAY, "skipped.json"), "utf8")) as { row: string; reason: string }[];
    const holdSkip = skipped.find((s) => s.row === `rows[${fixture.rows.length}]`);
    assert.ok(holdSkip);
    assert.equal(holdSkip!.reason, "not paid (refused: not_settled_hold)");
  } finally {
    rmSync(rm, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

// ---------- C. chain recheck ----------

test("chain recheck on fixture: 17 txs recorded, rows[28] stays settled false when nothing new fits", () => {
  const file = loadFixture();
  const run = file.runs[0] as RunWithCheck;
  const txs = outTxsFromRows(file);
  assert.equal(txs.length, 17);
  const r = checkOutflows({
    txs,
    known: file.rows.map((x) => x.tx).filter((t): t is string => !!t),
    books: [],
    candidates: runCandidates(file, run, Date.parse(run.endedAt!)),
    feeSinks: [TEMPO_FEE_MANAGER],
    norm: normAddr,
  });
  assert.deepEqual([r.txs, r.recorded, r.matched.length, r.unmatched.length], [17, 17, 0, 0]);
  assert.deepEqual([file.rows[28]!.settled, file.rows[28]!.tx], [false, null]);
});

test("chain recheck: exactly one chain tx for rows[28] matches alone; two fitting txs stay unmatched", () => {
  const file = loadFixture();
  const run = file.runs[0] as RunWithCheck;
  const base = outTxsFromRows(file);
  const row = file.rows[28]!;
  const cands = runCandidates(file, run, Date.parse(run.endedAt!));
  assert.equal(cands.length, 1);
  const cand = cands[0]!;
  const match: OutTx = {
    tx: `0x${"cd".repeat(32)}`,
    timeMs: Math.floor((cand.fromMs + cand.toMs) / 2),
    transfers: [{ to: normAddr(row.payTo!), amount: cand.amount }],
  };
  const inp = {
    txs: [...base, match],
    known: file.rows.map((x) => x.tx).filter((t): t is string => !!t),
    books: [] as string[][],
    candidates: cands,
    feeSinks: [TEMPO_FEE_MANAGER],
    norm: normAddr,
  };
  const one = checkOutflows(inp);
  assert.deepEqual(one.matched.map((m) => m.id), ["28"]);
  const twin = { ...match, tx: `0x${"ce".repeat(32)}`, timeMs: match.timeMs + 1 };
  const two = checkOutflows({ ...inp, txs: [...base, match, twin] });
  assert.equal(two.matched.length, 0);
  assert.equal(two.unmatched.length, 2);
});

// ---------- hold rules ----------

test("not_settled_hold: seven-day window includes 2026-11-08 through 2026-11-15 on plan days; clears on 2026-11-16", () => {
  const dir = holdsDir();
  try {
  const codex = CODEX.toLowerCase();
  assert.ok(notSettledHoldsFromDir(dir, PLAN_DAY).has(codex));
  assert.ok(notSettledHoldsFromDir(dir, PLAN_DAY_AFTER).has(codex));
  assert.ok(notSettledHoldsFromDir(dir, "2026-11-15").has(codex));
  const held = notSettledHoldsFromDir(dir, PLAN_DAY_AFTER).get(codex)!;
  assert.deepEqual([held.holdDate, held.holdKey], ["2026-11-08", `2026-11-08|${codex}|0`]);
  assert.equal(notSettledHoldsFromDir(dir, "2026-11-16").size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("not_settled_hold: a sent row with settled false and a tx still holds the payTo", () => {
  const dir = holdsDir();
  try {
  const file = loadFixture();
  const codex = CODEX.toLowerCase();
  const r28 = file.rows[28]!;
  const withTx: ResultFile = {
    ...file,
    rows: file.rows.map((r, i) => (i === 28 ? { ...r, tx: `0x${"bb".repeat(32)}`, settled: false } : r)),
  };
  writeFileSync(join(dir, "tempo-2026-11-08.json"), JSON.stringify(withTx));
  assert.ok(notSettledHoldsFromDir(dir, PLAN_DAY_AFTER).has(codex));
  assert.equal(notSettledHoldsFromDir(dir, PLAN_DAY_AFTER).get(codex)!.holdKey, r28.key);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("not_settled_hold: a later sent row with settled true clears the hold; a later refused row does not", () => {
  const dir = holdsDir();
  const dir2 = holdsDir();
  try {
  const codex = CODEX.toLowerCase();
  const healed = loadFixture();
  const last = { ...healed.rows[28]!, settled: true, tx: `0x${"aa".repeat(64)}`, at: "2026-11-10T12:00:00.000Z" };
  healed.date = "2026-11-10";
  healed.rows = [last];
  writeFileSync(join(dir, "tempo-2026-11-10.json"), JSON.stringify(healed));
  assert.equal(notSettledHoldsFromDir(dir, "2026-11-11").size, 0);

  const base = loadFixture();
  const codexRow = { ...base.rows[28]! };
  const refused: ResultFile = {
    ...base,
    date: "2026-11-09",
    rows: [{ ...codexRow, at: "2026-11-09T10:00:00.000Z", outcome: "refused", reason: "tx_check_failed", detail: "bad tx", settled: null, delivered: null, tx: null, key: `2026-11-09|${codex}|0` }],
    runs: [],
  };
  writeFileSync(join(dir2, "tempo-2026-11-09.json"), JSON.stringify(refused));
  assert.ok(notSettledHoldsFromDir(dir2, "2026-11-10").has(codex));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  }
});

test("not_settled_hold: the day ledger alone holds when the result file is missing", () => {
  const dir = holdsDir();
  try {
  const file = loadFixture();
  const row = file.rows[28]!;
  rmSync(join(dir, "tempo-2026-11-08.json"));
  writeFileSync(
    join(dir, "tempo-ledger-2026-11-08.json"),
    JSON.stringify({
      version: 1,
      payer: file.payer,
      capAtomic: "1000000",
      entries: [{ key: row.key, url: row.url, recipient: row.payTo, amount: "1000", status: "sent", settled: false, reservedAt: row.at }],
    }),
  );
  assert.ok(notSettledHoldsFromDir(dir, PLAN_DAY_AFTER).has(CODEX.toLowerCase()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("not_settled_hold: corrupt JSON in the results dir throws instead of returning an empty hold set", () => {
  const dir = holdsDir();
  try {
  writeFileSync(join(dir, "tempo-2026-11-08.json"), "{");
  assert.throws(() => notSettledHoldsFromDir(dir, PLAN_DAY_AFTER), /JSON|Unexpected/);
  writeFileSync(join(dir, "tempo-2026-11-08.json"), readFileSync(FIX_JSON));
  writeFileSync(join(dir, "tempo-ledger-2026-11-08.json"), "{");
  assert.throws(() => notSettledHoldsFromDir(dir, PLAN_DAY_AFTER), /JSON|Unexpected/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("not_settled_hold: same instant prefers settled true over false between result and ledger", () => {
  const file = loadFixture();
  const pay = normAddr("0x1111111111111111111111111111111111111111");
  const planDay = PLAN_DAY_AFTER;
  const url = "https://hold-merge.example/r";

  const writePair = (dir: string, resultSettled: boolean, ledgerSettled: boolean, resultAt: string, ledgerAt: string): void => {
    const key = `2026-11-08|${pay}|0`;
    const row: RemeasureRow = {
      chain: "tempo",
      outcome: "sent",
      host: "hold-merge.example",
      service: null,
      url,
      requestUrl: url,
      expectedPayTo: pay,
      payTo: pay,
      at: resultAt,
      settled: resultSettled,
      key,
      reason: "sent",
      slot: 0,
      detail: null,
      bodyBytes: null,
      priceUsdc: "0.001000",
      delivered: resultSettled,
      httpStatus: 200,
      tx: resultSettled ? `0x${"11".repeat(32)}` : null,
    };
    const dayResult: ResultFile = { ...file, date: "2026-11-08", rows: [row], runs: [] };
    writeFileSync(join(dir, "tempo-2026-11-08.json"), JSON.stringify(dayResult) + "\n");
    writeFileSync(
      join(dir, "tempo-ledger-2026-11-08.json"),
      JSON.stringify({
        version: 1,
        payer: file.payer,
        capAtomic: String(RM_TEMPO_MAX_PER_RUN_ATOMIC),
        entries: [{ key, url, recipient: pay, amount: "1000", status: "sent", settled: ledgerSettled, reservedAt: ledgerAt }],
      }) + "\n",
    );
  };

  const dirA = mkdtempSync(join(tmpdir(), "tempo-hold-same-"));
  const dirB = mkdtempSync(join(tmpdir(), "tempo-hold-same-"));
  try {
    writePair(dirA, false, true, "2026-11-08T12:00:00Z", "2026-11-08T12:00:00.000Z");
    assert.equal(notSettledHoldsFromDir(dirA, planDay).size, 0);

    writePair(dirB, true, false, "2026-11-08T12:00:00.000Z", "2026-11-08T12:00:00Z");
    assert.equal(notSettledHoldsFromDir(dirB, planDay).size, 0);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

// ---------- next-day plan (dry run and pay) ----------

test("scripts/remeasure.ts: tempo passes notSettledStateFromDir into selectSlots", () => {
  const src = readFileSync(join(REPO, "scripts/remeasure.ts"), "utf8");
  assert.match(src, /const notSettledState = chain === "tempo" \? notSettledStateFromDir\(OUT, DATE\) : undefined;/);
  assert.match(src, /const slots = selectSlots\(allTargets, perPayTo, notSettledState\?\.holds, notSettledState\?\.ended\);/);
});

test("next-day plan: derived codex hold blocks pay; without hold, pay stops on not_settled", async () => {
  const dir = derivedHoldDir(FAKE_CODEX_PAYTO);
  const fixture = loadFixture();
  const fakeCodex = targetFromSentRow(codexRowFromFixture(fixture));
  const ok = okTarget();
  const targets = [fakeCodex, ok];
  const holdRoot = mkdtempSync(join(tmpdir(), "tempo-hold-run-"));
  const noHoldRoot = mkdtempSync(join(tmpdir(), "tempo-nohold-run-"));
  let holdLedger: Ledger | null = null;
  let noHoldLedger: Ledger | null = null;

  try {
  const holds = notSettledHoldsFromDir(dir, PLAN_DAY_AFTER);
  assert.ok(holds.has(FAKE_CODEX_PAYTO.toLowerCase()));
  const holdEx = selectSlots(targets, 1, holds).excluded.find((e) => e.reason === "not_settled_hold" && e.payTo === FAKE_CODEX_PAYTO.toLowerCase());
  assert.ok(holdEx);
  assert.deepEqual([holdEx!.holdDate, holdEx!.holdKey], ["2026-11-08", `${PLAN_DAY}|${FAKE_CODEX_PAYTO.toLowerCase()}|0`]);
  const slotsWithHold = selectSlots(targets, 1, holds);
  assert.equal(slotsWithHold.slots.length, 1);
  assert.equal(slotsWithHold.slots[0]!.target.payTo, ok.payTo);

  const fakeVerifyDetail =
    "paid 402: verification-failed — Payment verification failed: Invalid transaction: receipt not found";
  const ch = (recipient: string, amount: string) =>
    `Payment id="x", realm="x", method="tempo", intent="charge", request="${b64url({ amount, currency: USDC_E, recipient, methodDetails: { chainId: TEMPO_MAINNET_CHAIN_ID } })}", expires="2099-01-01T00:00:00Z"`;
  const fakeChallenge = () =>
    `Payment id="codex", realm="graph.codex.io", method="tempo", intent="charge", request="${b64url({ amount: "1000", currency: USDC_E, recipient: FAKE_CODEX_PAYTO, methodDetails: { chainId: TEMPO_MAINNET_CHAIN_ID } })}", expires="2099-01-01T00:00:00Z"`;

  let codexFetches = 0;
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === CODEX_URL) {
      codexFetches++;
      return new Response(JSON.stringify({ title: "verification-failed", detail: fakeVerifyDetail }), {
        status: 402,
        headers: { "www-authenticate": fakeChallenge() },
      });
    }
    if (url !== ok.url) return new Response("{}", { status: 404 });
    if (new Headers(init?.headers).get("authorization")) return new Response('{"ok":true}', { status: 200 });
    return new Response("{}", { status: 402, headers: { "www-authenticate": ch(ok.payTo, "6000") } });
  };

  const dry = await dryRunTempo(slotsWithHold.slots, fetchImpl, { date: PLAN_DAY_AFTER, monthElsewhere: 0n, monthCommittedToday: 0n });
  assert.equal(codexFetches, 0);
  assert.equal(dry.stopped, null);

  let holdSigns = 0;
  const holdSigner: Signer = {
    address: throwaway.address,
    async credentialFor(res, _id, recipient) {
      if (normAddr(recipient) === FAKE_CODEX_PAYTO.toLowerCase()) throw new Error("codex must not be signed under hold");
      holdSigns++;
      const amount = BigInt(tempoChargeRequest(mppChallengesFromHeader(res.headers.get("www-authenticate"))[0]!)!.amount);
      return { credential: "Payment eyJ4IjoxfQ", serializedTx: await signedTransfer(recipient, amount) };
    },
  };
  const holdSet: KeyLedgerSet = { census: join(holdRoot, "c.json"), remeasureDir: join(holdRoot, "rm") };
  new Ledger(holdSet.census, throwaway.address, RM_TEMPO_MAX_PER_RUN_ATOMIC);
  registerDayLedger(holdSet, PLAN_DAY_AFTER, throwaway.address, RM_TEMPO_MAX_PER_RUN_ATOMIC);
  holdLedger = new Ledger(dayLedgerPath(holdSet.remeasureDir, PLAN_DAY_AFTER), throwaway.address, RM_TEMPO_MAX_PER_RUN_ATOMIC);
  const withHold = await payTempo(
    slotsWithHold.slots,
    {
      fetchImpl,
      signer: holdSigner,
      payer: throwaway.address,
      balance: async () => 10_000_000n,
      verify: async () => ({ settled: true, detail: "transfer found", feePaid: "30" }),
    },
    {
      date: PLAN_DAY_AFTER,
      ledger: holdLedger,
      keyLedgers: holdSet,
      chain: { outflowSinceCensusStart: async () => 0n, outflowSinceMonthStart: async () => 0n },
      monthElsewhere: 0n,
      sleep: async () => {},
    },
  );
  assert.equal(codexFetches, 0);
  assert.equal(holdSigns, 1);
  assert.equal(withHold.stopped, null);

  const slotsNoHold = selectSlots(targets, 1).slots;
  assert.equal(slotsNoHold.length, 2);
  let noHoldSigns = 0;
  const noHoldSigner: Signer = {
    address: throwaway.address,
    async credentialFor(res, _id, recipient) {
      noHoldSigns++;
      const amount = BigInt(tempoChargeRequest(mppChallengesFromHeader(res.headers.get("www-authenticate"))[0]!)!.amount);
      return { credential: "Payment eyJ4IjoxfQ", serializedTx: await signedTransfer(recipient, amount) };
    },
  };
  const noHoldSet: KeyLedgerSet = { census: join(noHoldRoot, "c.json"), remeasureDir: join(noHoldRoot, "rm") };
  new Ledger(noHoldSet.census, throwaway.address, RM_TEMPO_MAX_PER_RUN_ATOMIC);
  registerDayLedger(noHoldSet, PLAN_DAY_AFTER, throwaway.address, RM_TEMPO_MAX_PER_RUN_ATOMIC);
  noHoldLedger = new Ledger(dayLedgerPath(noHoldSet.remeasureDir, PLAN_DAY_AFTER), throwaway.address, RM_TEMPO_MAX_PER_RUN_ATOMIC);
  codexFetches = 0;
  const withoutHold = await payTempo(
    slotsNoHold,
    {
      fetchImpl,
      signer: noHoldSigner,
      payer: throwaway.address,
      balance: async () => 10_000_000n,
      verify: async (_tx, exp) =>
        normAddr(exp.recipient) === FAKE_CODEX_PAYTO.toLowerCase()
          ? { settled: false, detail: "receipt not found", feePaid: null }
          : { settled: true, detail: "transfer found", feePaid: "30" },
    },
    {
      date: PLAN_DAY_AFTER,
      ledger: noHoldLedger,
      keyLedgers: noHoldSet,
      chain: { outflowSinceCensusStart: async () => 0n, outflowSinceMonthStart: async () => 0n },
      monthElsewhere: 0n,
      sleep: async () => {},
    },
  );
  assert.ok(codexFetches >= 1);
  assert.ok(noHoldSigns >= 1);
  assert.equal(withoutHold.stopped, "not_settled");
  } finally {
    holdLedger?.release();
    noHoldLedger?.release();
    rmSync(dir, { recursive: true, force: true });
    rmSync(holdRoot, { recursive: true, force: true });
    rmSync(noHoldRoot, { recursive: true, force: true });
  }
});

test("notSettledStateFromDir: settled null sent after settled false keeps hold on 2026-11-15, ended on 2026-11-16", () => {
  const dir = derivedHoldDir(FAKE_CODEX_PAYTO);
  try {
    const pay = FAKE_CODEX_PAYTO.toLowerCase();
    const base = loadFixture();
    const nullSent = {
      ...codexRowFromFixture(base),
      settled: null,
      delivered: null,
      tx: null,
      at: "2026-11-10T12:00:00.000Z",
      key: `2026-11-10|${pay}|0`,
    };
    writeFileSync(
      join(dir, "tempo-2026-11-10.json"),
      JSON.stringify({ ...base, date: "2026-11-10", rows: [nullSent], runs: [] }, null, 2) + "\n",
    );
    const state15 = notSettledStateFromDir(dir, "2026-11-15");
    assert.equal(state15.holds.size, 1);
    assert.ok(state15.holds.has(pay));
    assert.equal(state15.ended.size, 0);
    const state16 = notSettledStateFromDir(dir, "2026-11-16");
    assert.equal(state16.holds.size, 0);
    assert.equal(state16.ended.size, 1);
    assert.ok(state16.ended.has(pay));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notSettledStateFromDir: sent with settled null only does not hold", () => {
  const dir = mkdtempSync(join(tmpdir(), "tempo-null-only-"));
  try {
    const pay = normAddr(FAKE_CODEX_PAYTO);
    const base = loadFixture();
    const nullSent = {
      ...codexRowFromFixture(base),
      settled: null,
      delivered: null,
      tx: null,
      at: "2026-11-10T12:00:00.000Z",
      key: `2026-11-10|${pay}|0`,
    };
    writeFileSync(
      join(dir, "tempo-2026-11-10.json"),
      JSON.stringify({ ...base, date: "2026-11-10", rows: [nullSent], runs: [] }, null, 2) + "\n",
    );
    const state = notSettledStateFromDir(dir, "2026-11-15");
    assert.equal(state.holds.size, 0);
    assert.equal(state.ended.size, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- G. other stop reasons ----------

test("stop reasons: sent settled false stops not_settled; not_settled_hold refusal is not a stop", () => {
  const sent = (o: Partial<PayOutcome>): PayOutcome => ({ serviceId: "s", result: "sent", settled: true, delivered: true, ...o });
  const ref = (r: string): PayOutcome => ({ serviceId: "s", result: "refused", refusal: { refused: r as never, detail: "" } });
  assert.equal(stopReason(sent({ settled: false, delivered: false })), "not_settled");
  assert.equal(stopReason(ref("not_settled_hold")), null);
});

const SELLER = "0x060b0fB0Be9d90557577B3AEE480711067149Ff0";
const GOOD_REQ = { amount: "6000", currency: USDC_E, recipient: SELLER, methodDetails: { chainId: TEMPO_MAINNET_CHAIN_ID } };
function challengeHeader(req: Record<string, unknown> = GOOD_REQ): string {
  return `Payment id="a", realm="svc.example", method="tempo", intent="charge", request="${b64url(req)}", expires="2099-01-01T00:00:00Z"`;
}

function payPlanDeps(setup: (d: PayDeps, sign: { n: number }) => void): { deps: PayDeps; sign: { n: number }; root: string } {
  const sign = { n: 0 };
  const root = mkdtempSync(join(tmpdir(), "tempo-rp-"));
  const path = join(root, "ledger.json");
  const ledger = new Ledger(path, throwaway.address, 1_000_000n);
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    if (!new Headers(init?.headers).get("authorization")) {
      return new Response("{}", { status: 402, headers: { "www-authenticate": challengeHeader() } });
    }
    return new Response('{"ok":true}', { status: 200 });
  };
  const deps: PayDeps = {
    ledger,
    chainSpent: async () => 0n,
    fetchImpl,
    signer: {
      address: throwaway.address,
      async credentialFor() {
        sign.n++;
        return { credential: "Payment x", serializedTx: await signedTransfer(SELLER, 6000n) };
      },
    },
    payer: throwaway.address,
    balance: async () => 1_000_000n,
    verify: async () => ({ settled: true, detail: "transfer found", feePaid: "30" }),
    now: () => new Date(),
  };
  setup(deps, sign);
  return { deps, sign, root };
}

const basePlan: PlanEntry = {
  serviceId: "openweather",
  request: { url: "https://svc.example/w", method: "GET", body: null, contentType: null, inputSource: "none" },
  lockedRecipient: SELLER,
  lockedAmount: "6000",
  sponsored: false,
  allowlist: [SELLER],
};
const secondPlan: PlanEntry = { ...basePlan, serviceId: "second" };

test("runPlan: not_settled stops after the first entry (other stop reasons: test/tempo.test.ts)", async () => {
  const { deps, sign, root } = payPlanDeps((d) => {
    d.verify = async () => ({ settled: false, detail: "receipt not found", feePaid: null });
  });
  try {
    const r = await runPlan([basePlan, secondPlan], deps);
    assert.equal(r.stopped?.reason, "not_settled");
    assert.equal(r.outcomes.length, 1);
    assert.equal(sign.n, 1);
  } finally {
    deps.ledger.release();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------- H. HALT ----------

const HALT_DELETE_ALLOW: { file: string; line: number; reason: string }[] = [];

test("HALT: changed remeasure files avoid deletion next to HALT (same line or within three lines)", () => {
  const root = join(import.meta.dirname, "..");
  const files = [
    "src/remeasure/not-settled-hold.ts",
    "src/remeasure/targets.ts",
    "src/remeasure/tempo.ts",
    "src/remeasure/normalize.ts",
    "scripts/remeasure.ts",
  ];
  const kill = /(?:\brm\b|\brm\s+-|unlink|rmSync|rename|(?:^|\s)mv\s|truncate)/i;
  const allowed = new Set(HALT_DELETE_ALLOW.map((a) => `${a.file}:${a.line}`));
  for (const f of files) {
    const lines = readFileSync(join(root, f), "utf8").split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/HALT/.test(lines[i]!)) continue;
      const lo = Math.max(0, i - 3);
      const hi = Math.min(lines.length - 1, i + 3);
      for (let j = lo; j <= hi; j++) {
        if (kill.test(lines[j]!)) {
          const key = `${f}:${j + 1}`;
          assert.ok(allowed.has(key), `${key}: ${lines[j]!.trim()} (HALT at line ${i + 1})`);
        }
      }
    }
  }
});

test("HALT: the latest Tempo result not_settled and HALT-pay block the shared payer", () => {
  const text = readFileSync(FIX_JSON, "utf8");
  assert.equal(tempoStoppedReasonFromJson(text), "not_settled");
  assert.match(sharedEvmSignBlockedByTempo({ lastTempoStopReason: "not_settled" }) ?? "", /Tempo is stopped/);
  assert.match(sharedEvmSignBlockedByTempo({ haltPayBody: "not_settled" }) ?? "", /HALT-pay/);
});

