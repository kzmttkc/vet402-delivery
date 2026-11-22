import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/tempo/ledger.js";
import { chainTxLedgerStop, chainTxsNotInLedgers, registerDayLedger, type KeyLedgerSet } from "../src/tempo/key-ledgers.js";
import { liveChainView, payTempo, type TempoChainView } from "../src/remeasure/tempo.js";
import { RM_TEMPO_MAX_PER_RUN_ATOMIC } from "../src/remeasure/constants.js";
import type { Slot } from "../src/remeasure/loop.js";

const PAYER = "0x9b59abf3dc92e7f60a6eeb7c1dedc6deb0bb4e51";
const RCPT = "0x1111111111111111111111111111111111111111";
const TX_A = "0x" + "a".repeat(64);
const TX_B = "0x" + "b".repeat(64);
const TX_C = "0x" + "c".repeat(64);

/** A census ledger with TX_A and a day ledger with TX_B (mixed case), both settled. */
function keySet(): { set: KeyLedgerSet; dir: string; day: string } {
  const dir = mkdtempSync(join(tmpdir(), "txgate-"));
  const set: KeyLedgerSet = { census: join(dir, "census", "tempo-ledger.json"), remeasureDir: join(dir, "remeasure") };
  const census = new Ledger(set.census, PAYER, RM_TEMPO_MAX_PER_RUN_ATOMIC);
  census.reserve({ key: "c1", url: "https://a.example/x", recipient: RCPT, amount: 1000n, sponsored: false });
  census.update("c1", { status: "sent", txHash: TX_A, settled: true });
  const day = registerDayLedger(set, "2026-11-23", PAYER, RM_TEMPO_MAX_PER_RUN_ATOMIC);
  const d = new Ledger(day, PAYER, RM_TEMPO_MAX_PER_RUN_ATOMIC);
  d.reserve({ key: "d1", url: "https://b.example/y", recipient: RCPT, amount: 2000n, sponsored: false });
  d.update("d1", { status: "sent", txHash: TX_B.toUpperCase().replace("0X", "0x"), settled: true });
  return { set, dir, day };
}

test("a transfer out of the key on no ledger stops (chain_tx_not_in_ledger)", async () => {
  const { set, dir } = keySet();
  try {
    assert.deepEqual(await chainTxsNotInLedgers(async () => [TX_A, TX_B, TX_C], PAYER, set), [TX_C]);
    const stop = await chainTxLedgerStop(async () => [TX_A, TX_B, TX_C, TX_C], PAYER, set);
    assert.match(stop ?? "", /^chain_tx_not_in_ledger: 1 transfer\(s\)/);
    assert.ok(stop!.includes(TX_C));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every transfer on some ledger passes (case-insensitive, census and day ledgers)", async () => {
  const { set, dir } = keySet();
  try {
    assert.equal(await chainTxLedgerStop(async () => [TX_A.toUpperCase().replace("0X", "0x"), TX_B], PAYER, set), null);
    assert.equal(await chainTxLedgerStop(async () => [], PAYER, set), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a chain read that fails or returns no list stops as unreadable, never as nothing missing", async () => {
  const { set, dir } = keySet();
  try {
    assert.match((await chainTxLedgerStop(async () => { throw new Error("HTTP request failed\nstatus 503"); }, PAYER, set)) ?? "", /^chain_tx_unreadable: HTTP request failed$/);
    assert.match((await chainTxLedgerStop(async () => undefined as unknown as string[], PAYER, set)) ?? "", /^chain_tx_unreadable:/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("payTempo stops before any purchase when a transfer is on no ledger or the read fails", async () => {
  const { set, dir, day } = keySet();
  try {
    const ledger = new Ledger(day, PAYER, RM_TEMPO_MAX_PER_RUN_ATOMIC, { lock: true });
    const touched: string[] = [];
    const slot = { target: { url: "https://b.example/z", payTo: RCPT, amountAtomic: "1000" }, slot: 0 } as unknown as Slot;
    const pay = {
      fetchImpl: (async () => { touched.push("fetch"); throw new Error("must not be called"); }) as never,
      signer: { credentialFor: async () => { touched.push("sign"); throw new Error("must not sign"); } } as never,
      payer: PAYER,
      balance: async () => { touched.push("balance"); return 10n ** 9n; },
      verify: async () => { throw new Error("must not verify"); },
    };
    const view = (txs: () => Promise<string[]>): TempoChainView => ({
      outflowSinceCensusStart: async () => 0n,
      outflowSinceMonthStart: async () => 0n,
      txsSinceCensusStart: txs,
    });
    const base = { date: "2026-11-23", ledger, keyLedgers: set, monthElsewhere: 0n, sleep: async () => undefined };
    const r1 = await payTempo([slot], pay, { ...base, chain: view(async () => [TX_A, TX_B, TX_C]) });
    assert.match(r1.stopped ?? "", /^chain_tx_not_in_ledger:/);
    assert.equal(r1.rows.length, 0);
    const r2 = await payTempo([slot], pay, { ...base, chain: view(async () => { throw new Error("socket hang up"); }) });
    assert.match(r2.stopped ?? "", /^chain_tx_unreadable: socket hang up/);
    assert.deepEqual(touched, []);
    assert.equal(ledger.entries().length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the live chain view gives the per-transaction read", () => {
  assert.equal(typeof liveChainView(PAYER).txsSinceCensusStart, "function");
});
