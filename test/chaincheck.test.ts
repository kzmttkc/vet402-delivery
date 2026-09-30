import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkOutflows, windows, type Candidate, type OutTx } from "../src/chaincheck.js";
import { TEMPO_FEE_MANAGER, normAddr } from "../src/tempo/constants.js";
import { Ledger } from "../src/tempo/ledger.js";
import { checkCensusRun, type TempoOutflowReader } from "../src/tempo/chaincheck.js";
import { checkSolanaRun, checkTempoRun, runCandidates, type RunWithCheck, type SolanaOutflowReader } from "../src/remeasure/chaincheck.js";
import type { RemeasureRow, ResultFile } from "../src/remeasure/results.js";

/**
 * Real data (test/fixtures/tempo-chaincheck.json): the payer's USDC.e transfers on Tempo read from the
 * chain, and vet402's records as they were before the check. On 2026-09-29 rows[30] (kicksdb, HTTP 500,
 * sponsored) paid on chain in 0xd25f…17f8 while the record said settled null, tx null. On 2026-09-28
 * the census had two more of these (goflightlabs 502, modal 500).
 */
const FX = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "tempo-chaincheck.json"), "utf8"));
const KICKSDB_TX = "0xd25f701b7d771a4715f4e01540bd4669a1e9e6c6a20f7e2dfa8e1680542417f8";
const PAYER = "0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51";
const MPP_PROXY = "0xca4e835f803cb0b7c428222b3a3b98518d4779fe";

type FxTx = { tx: string; time: string; transfers: { to: string; amount: string }[] };
const toOut = (xs: FxTx[]): OutTx[] => xs.map((x) => ({ tx: x.tx, timeMs: Date.parse(x.time), transfers: x.transfers.map((t) => ({ to: t.to, amount: BigInt(t.amount) })) }));

function tempoFile(): ResultFile {
  const t = structuredClone(FX.tempo0929);
  return {
    kind: "vet402-remeasure",
    version: 1,
    chain: "tempo",
    date: "2026-09-29",
    payer: PAYER,
    note: "",
    runs: t.runs,
    rows: t.rows.map((r: Partial<RemeasureRow>) => ({ chain: "tempo", url: "", requestUrl: "", bodyBytes: null, ...r })) as RemeasureRow[],
  };
}

function tempoInput(file: ResultFile, txs: OutTx[] = toOut(FX.tempo0929.chainTxs), extra: Candidate[] = []) {
  const run = file.runs[0]!;
  return {
    txs,
    known: file.rows.map((r) => r.tx).filter((t): t is string => !!t),
    books: [FX.tempo0929.dayLedger.entries.map((e: { txHash: string | null }) => e.txHash)],
    candidates: [...runCandidates(file, run, Date.parse(run.endedAt!)), ...extra],
    feeSinks: [TEMPO_FEE_MANAGER],
    norm: normAddr,
  };
}

test("chain check, real 2026-09-29 Tempo run: 35 txs, 34 on rows, the kicksdb payment belongs to rows[30] alone", () => {
  const file = tempoFile();
  assert.equal(file.rows[30]!.host, "kicksdb.mpp.tempo.xyz");
  assert.equal(file.rows[30]!.settled, null);
  const r = checkOutflows(tempoInput(file));
  assert.equal(r.txs, 35);
  assert.equal(r.recorded, 34);
  assert.deepEqual(r.matched, [{ id: "30", tx: KICKSDB_TX, time: "2026-09-29T08:28:46.000Z" }]);
  assert.deepEqual(r.unmatched, []);
  assert.deepEqual(r.duplicates, []);
});

test("chain check: rows[30]'s window runs from its start to the next attempt (the paid request lies inside)", () => {
  const file = tempoFile();
  const c = runCandidates(file, file.runs[0]!, Date.parse(file.runs[0]!.endedAt!));
  assert.equal(c.length, 1); // every other paid row already carries its tx
  assert.equal(c[0]!.fromMs, Date.parse("2026-09-29T08:28:30.000Z"));
  assert.equal(c[0]!.toMs, Date.parse(file.rows[31]!.at));
  assert.equal(c[0]!.amount, 500n);
  assert.equal(normAddr(c[0]!.payTo), MPP_PROXY);
});

test("chain check: a second row that could own the same payment makes it unmatched, not a guess", () => {
  const file = tempoFile();
  const twin: Candidate = { id: "twin", payTo: MPP_PROXY, amount: 500n, fromMs: Date.parse("2026-09-29T08:28:40Z"), toMs: Date.parse("2026-09-29T08:28:50Z") };
  const r = checkOutflows(tempoInput(file, undefined, [twin]));
  assert.deepEqual(r.matched, []);
  assert.equal(r.unmatched.length, 1);
  assert.equal(r.unmatched[0]!.reason, "more than one row fits");
  assert.deepEqual(r.unmatched[0]!.candidates.sort(), ["30", "twin"]);
});

test("chain check: the same payment outside the row's paid request, at another price, or to another recipient is unmatched", () => {
  const file = tempoFile();
  const base = toOut(FX.tempo0929.chainTxs);
  const k = base.findIndex((t) => t.tx === KICKSDB_TX);
  const variants: [string, OutTx][] = [
    ["after the next attempt started", { ...base[k]!, timeMs: Date.parse("2026-09-29T08:28:51Z") }],
    ["another price", { ...base[k]!, transfers: [{ to: MPP_PROXY, amount: 501n }] }],
    ["another recipient", { ...base[k]!, transfers: [{ to: "0x060b0fb0be9d90557577b3aee480711067149ff0", amount: 500n }] }],
  ];
  for (const [why, v] of variants) {
    const r = checkOutflows(tempoInput(file, base.map((t, i) => (i === k ? v : t))));
    assert.deepEqual(r.matched, [], why);
    assert.equal(r.unmatched[0]?.reason, "no row with this payTo and price was paying at this time", why);
  }
});

test("chain check: a tx with two payments (not the fee manager) is unmatched; a fee transfer beside the payment is fine", () => {
  const file = tempoFile();
  const base = toOut(FX.tempo0929.chainTxs);
  const k = base.findIndex((t) => t.tx === KICKSDB_TX);
  const two = { ...base[k]!, transfers: [...base[k]!.transfers, { to: "0x060b0fb0be9d90557577b3aee480711067149ff0", amount: 1n }] };
  assert.equal(checkOutflows(tempoInput(file, base.map((t, i) => (i === k ? two : t)))).unmatched[0]?.reason, "not exactly one payment transfer in the tx");
  const fee = { ...base[k]!, transfers: [...base[k]!.transfers, { to: TEMPO_FEE_MANAGER, amount: 37n }] };
  assert.equal(checkOutflows(tempoInput(file, base.map((t, i) => (i === k ? fee : t)))).matched.length, 1);
});

test("chain check: a payment nobody recorded (another spender of the key) fails the run", () => {
  const file = tempoFile();
  const stray: OutTx = { tx: `0x${"ab".repeat(32)}`, timeMs: Date.parse("2026-09-29T08:26:00Z"), transfers: [{ to: MPP_PROXY, amount: 500n }] };
  const r = checkOutflows(tempoInput(file, [...toOut(FX.tempo0929.chainTxs), stray]));
  assert.equal(r.matched.length, 1);
  assert.deepEqual(r.unmatched.map((u) => u.tx), [stray.tx]);
});

test("chain check: one tx on two records is a duplicate", () => {
  const file = tempoFile();
  const inp = tempoInput(file);
  const r = checkOutflows({ ...inp, books: [...inp.books, [file.rows[0]!.tx]] });
  assert.deepEqual(r.duplicates, [normAddr(file.rows[0]!.tx!)]);
});

test("windows: sorted by start; each ends where the next attempt starts; the last at the run's end", () => {
  const w = windows([{ at: "2026-09-29T00:00:05.500Z" }, { at: "2026-09-29T00:00:01.900Z" }], (x) => x.at, Date.parse("2026-09-29T00:01:00Z"));
  assert.deepEqual(
    w.map((x) => [new Date(x.fromMs).toISOString(), new Date(x.toMs).toISOString()]),
    [
      ["2026-09-29T00:00:01.000Z", "2026-09-29T00:00:05.500Z"],
      ["2026-09-29T00:00:05.000Z", "2026-09-29T00:01:00.000Z"],
    ],
  );
});

// ---------- the Tempo run check with files (what --pay and scripts/chain-check.ts do) ----------

function keySet() {
  const dir = mkdtempSync(join(tmpdir(), "chaincheck-"));
  const remeasureDir = join(dir, "remeasure");
  const census = join(dir, "tempo-ledger.json");
  // the census ledger as published before the chain check (it had goflightlabs and modal as settled null)
  writeFileSync(census, JSON.stringify(FX.census0928.ledger, null, 2) + "\n");
  const day = join(remeasureDir, "tempo-ledger-2026-09-29.json");
  return { set: { census, remeasureDir }, day };
}

function fakeTempoReader(txs: OutTx[], verified: string[] = []): TempoOutflowReader {
  return {
    outTxs: async (fromMs, toMs) => txs.filter((t) => t.timeMs >= Math.floor(fromMs / 1000) * 1000 && t.timeMs <= toMs),
    verify: async (tx) => (verified.push(tx), { settled: true, detail: "transfer found", feePaid: null }),
  };
}

test("checkTempoRun on the real 2026-09-29 run: rows[30] and its day-ledger entry get the tx; outcome, reason, delivered unchanged; a second check adds nothing", async () => {
  const { set, day } = keySet();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(set.remeasureDir, { recursive: true });
  writeFileSync(day, JSON.stringify(FX.tempo0929.dayLedger, null, 2) + "\n");
  writeFileSync(join(set.remeasureDir, "tempo-ledger-index.json"), JSON.stringify({ kind: "vet402-tempo-day-ledgers", dates: ["2026-09-29"] }));
  const file = tempoFile();
  const run = file.runs[0] as RunWithCheck;
  const verified: string[] = [];
  const reader = fakeTempoReader(toOut(FX.tempo0929.chainTxs), verified);
  const ledger = new Ledger(day, PAYER, 1_000_000n, { lock: true });
  try {
    const now = () => new Date("2026-09-30T00:00:00Z");
    const r = await checkTempoRun({ file, run, dayLedger: ledger, set, reader, endMs: Date.parse(run.endedAt!), now });
    assert.deepEqual(verified, [KICKSDB_TX]);
    assert.deepEqual(r.added, [{ key: file.rows[30]!.key, tx: KICKSDB_TX, time: "2026-09-29T08:28:46.000Z" }]);
    assert.deepEqual(r.unmatched, []);
    const row = file.rows[30]!;
    assert.equal(row.settled, true);
    assert.equal(row.tx, KICKSDB_TX);
    assert.equal(row.detail, "settled on chain (found by the post-run chain check)");
    assert.equal(row.outcome, "sent");
    assert.equal(row.reason, "sent");
    assert.equal(row.delivered, false);
    assert.equal(row.httpStatus, 500);
    const e = JSON.parse(readFileSync(day, "utf8")).entries.find((x: { key: string }) => x.key === row.key);
    assert.equal(e.txHash, KICKSDB_TX);
    assert.equal(e.settled, true);
    assert.equal(e.status, "sent");
    assert.equal(e.delivered, false);
    assert.equal(run.chainCheck?.added.length, 1);
    // again: everything is on a row now; the earlier finding stays in the record
    const again = await checkTempoRun({ file, run, dayLedger: ledger, set, reader, endMs: Date.parse(run.endedAt!), now });
    assert.equal(again.recorded, 35);
    assert.equal(again.added.length, 1);
    assert.equal(run.chainCheck?.added.length, 1);
    // the 34 rows that had a tx are untouched
    const before = tempoFile().rows;
    for (let i = 0; i < before.length; i++) if (i !== 30) assert.deepEqual(file.rows[i], before[i]);
  } finally {
    ledger.release();
  }
});

test("checkTempoRun read-only (no day ledger) reports the finding and writes nothing", async () => {
  const { set } = keySet();
  const file = tempoFile();
  const run = file.runs[0] as RunWithCheck;
  const r = await checkTempoRun({ file, run, dayLedger: null, set, reader: fakeTempoReader(toOut(FX.tempo0929.chainTxs)), endMs: Date.parse(run.endedAt!) });
  assert.equal(r.added.length, 1);
  assert.equal(file.rows[30]!.settled, null);
  assert.equal(run.chainCheck, undefined);
});

test("census check on the real 2026-09-28 census: goflightlabs (502) and modal (500) paid on chain; both entries get their tx", async () => {
  const { set } = keySet();
  const ledger = new Ledger(set.census, PAYER, 2_110_000n, { lock: true });
  try {
    const start = ledger.entries()[0]!.reservedAt;
    const end = Date.parse(ledger.entries().at(-1)!.reservedAt) + 120_000;
    const r = await checkCensusRun({ ledger, startedAt: start, endMs: end, set, reader: fakeTempoReader(toOut(FX.census0928.chainTxs)), payer: PAYER });
    assert.equal(r.txs, 72);
    assert.equal(r.recorded, 70);
    assert.deepEqual(
      r.added.map((a) => [a.key, a.tx]),
      [
        ["goflightlabs", "0x34fbc6dc957f6edd19c4e8402323b0447f9b8ebc3322c27036b4a9b9dcf965ec"],
        ["modal", "0x3439e09ee264bbc67cb1ebf45e808f4f2756a8e90925d5fcae94085be8c8643c"],
      ],
    );
    assert.deepEqual(r.unmatched, []);
    const saved = JSON.parse(readFileSync(set.census, "utf8")).entries;
    assert.equal(saved.find((e: { key: string }) => e.key === "modal").settled, true);
    // stableemail (unsponsored, "receipt not found") had no transfer on chain: still not settled
    assert.equal(saved.find((e: { key: string }) => e.key === "stableemail").settled, false);
  } finally {
    ledger.release();
  }
});

// ---------- Solana: the same check over the payer's USDC account ----------

test("checkSolanaRun: a payment the row recorded as not settled (no signature) is found and recorded; an unknown one fails", async () => {
  const at = (s: number) => new Date(Date.parse("2026-09-29T08:15:00Z") + s * 1000).toISOString();
  const row = (i: number, o: Partial<RemeasureRow>): RemeasureRow => ({
    at: at(i * 10), chain: "solana", host: `h${i}`, service: null, url: "", requestUrl: "", payTo: `PayTo${i}`, expectedPayTo: `PayTo${i}`,
    outcome: "sent", reason: "sent", detail: "{}", settled: true, delivered: true, httpStatus: 200, bodyBytes: null, tx: `sig${i}`, priceUsdc: "0.010000", slot: 0, key: `k${i}`, ...o,
  });
  const file: ResultFile = {
    kind: "vet402-remeasure", version: 1, chain: "solana", date: "2026-09-29", payer: "Payer", note: "",
    runs: [{ startedAt: at(0), endedAt: at(40), perPayTo: 1, stopped: null }],
    rows: [row(0, {}), row(1, { settled: false, delivered: false, tx: null, httpStatus: 502 }), row(2, {})],
  };
  const txs: OutTx[] = [
    { tx: "sig0", timeMs: Date.parse(at(1)), transfers: [] },
    { tx: "late1", timeMs: Date.parse(at(15)), transfers: [{ to: "PayTo1", amount: 10_000n }] },
    { tx: "sig2", timeMs: Date.parse(at(21)), transfers: [] },
  ];
  const reader: SolanaOutflowReader = { outTxs: async () => txs, verify: async (sig, payTo, amount) => sig === "late1" && payTo === "PayTo1" && amount === 10_000n };
  const run = file.runs[0] as RunWithCheck;
  const r = await checkSolanaRun({ file, run, reader, endMs: Date.parse(run.endedAt!), write: true });
  assert.deepEqual(r.added.map((a) => a.tx), ["late1"]);
  assert.equal(file.rows[1]!.settled, true);
  assert.equal(file.rows[1]!.tx, "late1");
  assert.equal(file.rows[1]!.detail, "{}; settled on chain (found by the post-run chain check)");
  assert.equal(file.rows[1]!.delivered, false);

  txs.push({ tx: "stray", timeMs: Date.parse(at(25)), transfers: [{ to: "Elsewhere", amount: 5n }] });
  const r2 = await checkSolanaRun({ file, run, reader, endMs: Date.parse(run.endedAt!), write: false });
  assert.deepEqual(r2.unmatched.map((u) => u.tx), ["stray"]);
});

// ---------- review WARN1: row N's payment landing inside row N+1's window ----------

test("chain check: a payment inside row N+1's window is unmatched when an earlier row N to the same payTo at the same price has no tx", () => {
  const t0 = Date.parse("2026-09-29T10:00:00Z");
  const n: Candidate = { id: "N", payTo: MPP_PROXY, amount: 500n, fromMs: t0, toMs: t0 + 60_000 };
  const n1: Candidate = { id: "N+1", payTo: MPP_PROXY, amount: 500n, fromMs: t0 + 60_000, toMs: t0 + 120_000 };
  const late: OutTx = { tx: `0x${"c1".repeat(32)}`, timeMs: t0 + 75_000, transfers: [{ to: MPP_PROXY, amount: 500n }] };
  const inp = { txs: [late], known: [], books: [], candidates: [n, n1], feeSinks: [TEMPO_FEE_MANAGER], norm: normAddr };
  const r = checkOutflows(inp);
  assert.deepEqual(r.matched, []);
  assert.equal(r.unmatched.length, 1);
  assert.deepEqual(r.unmatched[0]!.candidates, ["N+1"]);
  assert.match(r.unmatched[0]!.reason, /earlier row with this payTo and price/);
  // the same without the earlier row, or with the earlier row at another price or payTo: recorded on N+1 as before
  for (const other of [[], [{ ...n, amount: 501n }], [{ ...n, payTo: "0x060b0fb0be9d90557577b3aee480711067149ff0" }]]) {
    assert.deepEqual(checkOutflows({ ...inp, candidates: [...other, n1] }).matched.map((m) => m.id), ["N+1"]);
  }
  // a later open row (N+1) does not block N's own payment inside N's window
  const own: OutTx = { ...late, timeMs: t0 + 30_000 };
  assert.deepEqual(checkOutflows({ ...inp, txs: [own] }).matched.map((m) => m.id), ["N"]);
});
