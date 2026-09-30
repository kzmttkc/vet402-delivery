/**
 * The post-run chain check on a past remeasure day (the same check every --pay run makes at its end).
 *
 *   npx tsx scripts/chain-check.ts --chain tempo|solana --date YYYY-MM-DD           # read only: report
 *   npx tsx scripts/chain-check.ts --chain tempo|solana --date YYYY-MM-DD --write   # record what it finds
 *
 * Every run in results/remeasure/<chain>-<date>.json (the production folder) is checked: each payment
 * that left the payer during the run (and up to 2 minutes after it) must be on a row. A payment exactly
 * one row can own is written onto that row (and on Tempo its day-ledger entry) with --write. Signs and
 * sends nothing; no key is loaded.
 *
 * Exit: 0 every payment is on a row; 1 unmatched payments or a tx on two records; 2 usage.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { PAYER_ADDRESS } from "../src/constants.js";
import { PAYER_ADDRESS as TEMPO_PAYER } from "../src/tempo/constants.js";
import { RM_PROD_DIR, RM_TEMPO_MAX_PER_RUN_ATOMIC, type RemeasureChain } from "../src/remeasure/constants.js";
import { readResultFile, resultPath, writeJsonAtomic } from "../src/remeasure/results.js";
import { checkSolanaRun, checkTempoRun, liveSolanaReader, type RunWithCheck } from "../src/remeasure/chaincheck.js";
import { checkFailed, type ChainCheckRecord } from "../src/chaincheck.js";
import { acquireRunLock } from "../src/first-buyer/lock.js";

const args = process.argv.slice(2);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const chain = opt("--chain") as RemeasureChain | undefined;
const date = opt("--date");
const WRITE = args.includes("--write");
if ((chain !== "solana" && chain !== "tempo") || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error("usage: chain-check.ts --chain solana|tempo --date YYYY-MM-DD [--write]");
  process.exit(2);
}

const DIR = RM_PROD_DIR;
const payer = chain === "tempo" ? TEMPO_PAYER : PAYER_ADDRESS;
const file = resultPath(DIR, chain, date);
if (!existsSync(file)) {
  console.error(`${file} does not exist`);
  process.exit(2);
}

function print(i: number, r: ChainCheckRecord): void {
  console.log(`run ${i} ${r.from} .. ${r.to}: ${r.txs} txs out of the payer, ${r.recorded} already on a row, ${r.added.length} found and ${WRITE ? "recorded" : "recordable"}, ${r.unmatched.length} unmatched, ${r.duplicates.length} duplicate`);
  for (const a of r.added) console.log(`  ${WRITE ? "recorded" : "would record"} ${a.key} tx ${a.tx} at ${a.time}`);
  for (const u of r.unmatched) console.log(`  UNMATCHED ${u.tx} at ${u.time}: ${u.reason} ${JSON.stringify(u.transfers)} candidates ${JSON.stringify(u.candidates)}`);
  for (const d of r.duplicates) console.log(`  DUPLICATE ${d}`);
}

const release = WRITE ? acquireRunLock(join(DIR, `${chain}.lock`)) : () => undefined;
let failed = false;
try {
  const result = readResultFile(file, chain, date, payer);
  if (chain === "tempo") {
    const { Ledger } = await import("../src/tempo/ledger.js");
    const { TEMPO_KEY_LEDGERS } = await import("../src/tempo/key-ledgers.js");
    const { liveTempoReader } = await import("../src/tempo/chaincheck.js");
    const { dayLedgerPath } = await import("../src/remeasure/tempo.js");
    const { assertMainnet } = await import("../src/tempo/chain.js");
    await assertMainnet();
    const ledger = WRITE ? new Ledger(dayLedgerPath(DIR, date), TEMPO_PAYER, RM_TEMPO_MAX_PER_RUN_ATOMIC, { lock: true }) : null;
    try {
      const reader = liveTempoReader(TEMPO_PAYER);
      for (const [i, run] of (result.runs as RunWithCheck[]).entries()) {
        if (!run.endedAt) throw new Error(`run ${i} has no endedAt; check it once the run has ended`);
        const r = await checkTempoRun({ file: result, run, dayLedger: ledger, set: TEMPO_KEY_LEDGERS, reader, endMs: Date.parse(run.endedAt) });
        print(i, r);
        failed ||= checkFailed(r);
      }
    } finally {
      ledger?.release();
    }
  } else {
    const { jsonRpc } = await import("../src/chain.js");
    const { usdcAta } = await import("../src/txcheck.js");
    const rpc = jsonRpc(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com");
    const reader = liveSolanaReader(rpc, PAYER_ADDRESS, await usdcAta(PAYER_ADDRESS));
    for (const [i, run] of (result.runs as RunWithCheck[]).entries()) {
      if (!run.endedAt) throw new Error(`run ${i} has no endedAt; check it once the run has ended`);
      const r = await checkSolanaRun({ file: result, run, reader, endMs: Date.parse(run.endedAt), write: WRITE });
      print(i, r);
      failed ||= checkFailed(r);
    }
  }
  if (WRITE) {
    writeJsonAtomic(file, result);
    console.log(`wrote ${file}`);
  }
} finally {
  release();
}
process.exitCode = failed ? 1 : 0;
