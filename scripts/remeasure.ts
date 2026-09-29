/**
 * Remeasure: buy again, once a day, from sellers vet402 already paid (payment settled), so the ranking
 * gets purchases on more than one day. Never buys from a new seller.
 *
 *   npm run remeasure -- --chain solana               # dry run (the default): targets and estimate, pays nothing
 *   npm run remeasure -- --chain tempo --dry-run
 *   npm run remeasure -- --chain solana --pay         # pays (explicit flag only)
 *   options: --per-payto N (1..5, default 1)  --data <dir> (default data/)
 *            --out <dir> (dry run only: where the plan is written; default results/remeasure/ of this checkout)
 *            --key <file> (--pay only; default .keys/payer.json on Solana, .keys/evm.json on Tempo)
 *
 * Production runs in one place only: ledgers, locks and results are always ~/vet402-solana/results/remeasure
 * (RM_PROD_DIR), whichever checkout runs the script; --pay refuses --out.
 *
 * Who: the settled purchases in the published inputs (data/manifest.json, sha256 checked): Solana census
 * and gate1 results, the Tempo ledger (with the census plan for method and body). One purchase per payTo
 * per run by default, locked to the payTo and price of the earlier settled payment; a live 402 that names
 * another payTo is not paid and is recorded as pay_to_changed.
 *
 * Money: the existing paths only (src/pay.ts payOne on Solana, src/tempo/pay.ts payOne on Tempo).
 * Caps: 0.10 per purchase; per run 3 USDC (Solana) / 1 USDC.e (Tempo); 30 per month on each chain.
 * Ledgers are written before anything is signed. At most MEASURE_MAX_PER_SELLER purchases per payTo per
 * run, MEASURE_SPACING_MS apart. One --pay run per chain at a time (results/remeasure/<chain>.lock).
 *
 * Output: results/remeasure/<chain>-YYYY-MM-DD.json (read by `npm run rank`), or <chain>-YYYY-MM-DD.dry-run.json.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PAYER_ADDRESS, atomicToUsdc } from "../src/constants.js";
import { PAYER_ADDRESS as TEMPO_PAYER, atomicToUnits } from "../src/tempo/constants.js";
import { acquireRunLock, LockHeld } from "../src/first-buyer/lock.js";
import {
  RM_DEFAULT_PER_PAYTO,
  RM_MAX_PER_PAYTO,
  RM_NOTE,
  RM_SOLANA_MAX_PER_MONTH_ATOMIC,
  RM_SOLANA_MAX_PER_RUN_ATOMIC,
  RM_TEMPO_MAX_PER_MONTH_ATOMIC,
  RM_TEMPO_MAX_PER_RUN_ATOMIC,
  type RemeasureChain,
} from "../src/remeasure/constants.js";
import { selectSlots, solanaFromCensus, solanaFromGate1, tempoFromLedger, type Target } from "../src/remeasure/targets.js";
import { readResultFile, resultPath, runDirs, writeJsonAtomic, type RemeasureRow, type RunInfo } from "../src/remeasure/results.js";
import { reconcileSolana, reconcileTempo } from "../src/remeasure/reconcile.js";
import type { LoopResult } from "../src/remeasure/loop.js";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string): string | undefined => {
  const i = args.indexOf(n);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${n} needs a value`);
  return v;
};

function usage(msg: string): never {
  console.error(`${msg}\nusage: remeasure.ts --chain solana|tempo [--dry-run | --pay] [--per-payto N] [--data dir] [--out dir] [--key file]`);
  process.exit(2);
}

const chain = opt("--chain") as RemeasureChain | undefined;
if (chain !== "solana" && chain !== "tempo") usage("--chain solana|tempo is required");
if (flag("--pay") && flag("--dry-run")) usage("choose --dry-run or --pay");
const PAY = flag("--pay");
const perPayTo = Number(opt("--per-payto") ?? RM_DEFAULT_PER_PAYTO);
if (!Number.isInteger(perPayTo) || perPayTo < 1 || perPayTo > RM_MAX_PER_PAYTO) usage(`--per-payto must be 1..${RM_MAX_PER_PAYTO}`);
const DATA = resolve(opt("--data") ?? join(ROOT, "data"));
let dirs: ReturnType<typeof runDirs>;
try {
  dirs = runDirs({ pay: PAY, out: opt("--out"), root: ROOT });
} catch (e) {
  usage((e as Error).message);
}
/** Ledgers, locks and result files: always RM_PROD_DIR (read by dry runs, written by --pay). */
const OUT = dirs.ledgers;
/** Where a dry run writes its plan. */
const DRY_OUT = dirs.dryRunOut;
const NOW = new Date();
const DATE = NOW.toISOString().slice(0, 10);
const MONTH = DATE.slice(0, 7);
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

// ---------- inputs: the published copies in data/, sha256 checked against data/manifest.json ----------

interface DataEntry {
  label: string;
  path: string;
  sha256: string;
}
const manifest = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8")) as { files: DataEntry[] };
const inputs: { label: string; sha256: string }[] = [];

function readData(e: DataEntry): unknown {
  const text = readFileSync(join(DATA, e.path), "utf8");
  const got = createHash("sha256").update(text).digest("hex");
  if (got !== e.sha256) throw new Error(`${e.path}: sha256 ${got} != manifest ${e.sha256}`);
  inputs.push({ label: e.label, sha256: got });
  return JSON.parse(text);
}
const labelled = (re: RegExp) => manifest.files.filter((f) => re.test(f.label)).sort((a, b) => (a.label < b.label ? -1 : 1));

function targetsFor(c: RemeasureChain): Target[] {
  if (c === "solana") {
    const out: Target[] = [];
    for (const e of labelled(/^solana\/census-\d{4}-\d{2}-\d{2}$/)) out.push(...solanaFromCensus(readData(e), e.label));
    for (const e of labelled(/^solana\/gate1-\d{4}-\d{2}-\d{2}$/)) out.push(...solanaFromGate1(readData(e), e.label));
    return out;
  }
  const ledger = labelled(/^tempo\/ledger$/);
  const plans = labelled(/^tempo\/census-plan-\d{4}-\d{2}-\d{2}$/);
  if (ledger.length !== 1 || plans.length === 0) throw new Error("data/manifest.json needs tempo/ledger and a tempo/census-plan-*");
  // Later plans override earlier ones for the same service.
  const plan = { plan: plans.flatMap((p) => (readData(p) as { plan: unknown[] }).plan) };
  return tempoFromLedger(readData(ledger[0]!), plan, "tempo/ledger");
}

// ---------- output ----------

function tally(rows: readonly { reason: string }[]): Record<string, number> {
  const t: Record<string, number> = {};
  for (const r of rows) t[r.reason] = (t[r.reason] ?? 0) + 1;
  return t;
}

function summaryLines(res: LoopResult, fmt: (a: string) => string) {
  const would = res.rows.filter((r) => r.outcome === "would_pay");
  const toAtomic = (p: string | null) => {
    const [w, f = ""] = (p ?? "0").split(".");
    return BigInt(w!) * 1_000_000n + BigInt(f.padEnd(6, "0").slice(0, 6));
  };
  const est = would.reduce((s, r) => s + toAtomic(r.priceUsdc), 0n);
  return { would: would.length, estimate: fmt(est.toString()), refusals: tally(res.rows.filter((r) => r.outcome !== "would_pay")), skipped: tally(res.skipped) };
}

// ---------- Solana ----------

async function solana(slotsAll: ReturnType<typeof selectSlots>, targets: Target[]) {
  const { jsonRpc, readBalances, waitForSettlement } = await import("../src/chain.js");
  const { RemeasureBudget } = await import("../src/remeasure/budget.js");
  const { dryRunSolana, paySolana } = await import("../src/remeasure/solana.js");
  const monthFile = join(OUT, `budget-solana-${MONTH}.json`);
  const rpc = jsonRpc(RPC_URL);

  if (!PAY) {
    const before = await readBalances(rpc, PAYER_ADDRESS);
    const monthSpent = existsSync(monthFile) ? new RemeasureBudget(monthFile).spent : 0n;
    const monthLeft = RM_SOLANA_MAX_PER_MONTH_ATOMIC > monthSpent ? RM_SOLANA_MAX_PER_MONTH_ATOMIC - monthSpent : 0n;
    const sim = new RemeasureBudget(null, RM_SOLANA_MAX_PER_RUN_ATOMIC, monthLeft);
    const res = await dryRunSolana(slotsAll.slots, fetch, { date: DATE, budget: sim, now: () => new Date() });
    const after = await readBalances(rpc, PAYER_ADDRESS);
    const sum = summaryLines(res, atomicToUsdc);
    const out = join(DRY_OUT, `solana-${DATE}.dry-run.json`);
    writeJsonAtomic(out, {
      kind: "vet402-remeasure-dry-run",
      chain: "solana",
      createdAt: NOW.toISOString(),
      payer: PAYER_ADDRESS,
      note: RM_NOTE,
      inputs,
      perPayTo,
      caps: { perPurchase: "0.100000", perRun: atomicToUsdc(RM_SOLANA_MAX_PER_RUN_ATOMIC), perMonth: atomicToUsdc(RM_SOLANA_MAX_PER_MONTH_ATOMIC), monthLeft: atomicToUsdc(monthLeft) },
      summary: { payTos: slotsAll.payTos, resources: slotsAll.resources, slots: slotsAll.slots.length, ...sum, payerUsdcBefore: atomicToUsdc(before.usdcAtomic), payerUsdcAfter: atomicToUsdc(after.usdcAtomic), payerLamportsBefore: before.lamports.toString(), payerLamportsAfter: after.lamports.toString() },
      excluded: slotsAll.excluded,
      rows: res.rows,
      skipped: res.skipped,
    });
    for (const r of res.rows) console.log(`${r.reason.padEnd(16)} ${r.host.padEnd(44)} ${r.priceUsdc ?? "-"} payTo=${r.payTo ?? "-"}${r.payTo && r.payTo !== r.expectedPayTo ? ` (recorded ${r.expectedPayTo})` : ""}`);
    console.log(`TARGETS payTos ${slotsAll.payTos}, resources ${slotsAll.resources}, slots ${slotsAll.slots.length} (per payTo ${perPayTo}); excluded ${JSON.stringify(tally(slotsAll.excluded))}`);
    console.log(`WOULD PAY ${sum.would}, estimated ${sum.estimate} USDC (run cap ${atomicToUsdc(RM_SOLANA_MAX_PER_RUN_ATOMIC)}, month left ${atomicToUsdc(monthLeft)}); not paid: ${JSON.stringify(sum.refusals)}; skipped: ${JSON.stringify(sum.skipped)}`);
    console.log(`payer USDC before ${atomicToUsdc(before.usdcAtomic)} after ${atomicToUsdc(after.usdcAtomic)}; SOL lamports before ${before.lamports} after ${after.lamports}`);
    console.log(`wrote ${out}`);
    return 0;
  }

  const { loadPayer, makeCreatePayment } = await import("../src/client.js");
  const { checkPaymentTransaction, usdcAta } = await import("../src/txcheck.js");
  const { realSleep } = await import("../src/remeasure/loop.js");
  const release = lockOrExit(join(OUT, "solana.lock"));
  try {
    // Purchases a killed run reserved but never recorded: one unknown_after_sign row each, never paid again.
    const { readdirSync } = await import("node:fs");
    for (const n of existsSync(OUT) ? readdirSync(OUT).filter((x) => /^budget-solana-\d{4}-\d{2}\.json$/.test(x)).sort() : []) {
      for (const r of reconcileSolana(join(OUT, n), OUT, targets, PAYER_ADDRESS)) console.log(`recorded unknown_after_sign ${r.key} ${r.host}`);
    }
    const budget = new RemeasureBudget(monthFile);
    const signer = await loadPayer(opt("--key") ?? join(ROOT, ".keys", "payer.json"));
    const payerAta = await usdcAta(PAYER_ADDRESS);
    const start = await readBalances(rpc, PAYER_ADDRESS);
    budget.setBaselineIfMissing(start.usdcAtomic);
    const file = resultPath(OUT, "solana", DATE);
    const result = readResultFile(file, "solana", DATE, PAYER_ADDRESS);
    const run: RunInfo = { startedAt: NOW.toISOString(), endedAt: null, perPayTo, stopped: null };
    result.runs.push(run);
    const save = () => writeJsonAtomic(file, result);
    save();
    const res = await paySolana(
      slotsAll.slots,
      {
        fetch,
        payer: PAYER_ADDRESS,
        createPayment: makeCreatePayment(signer, RPC_URL),
        checkTx: checkPaymentTransaction,
        readBalances: () => readBalances(rpc, PAYER_ADDRESS),
        waitForSettlement: (sig: string | null, memo: string | null, payTo: string) =>
          waitForSettlement({ rpc, signature: sig, memo, payer: PAYER_ADDRESS, payerUsdcAta: payerAta, payTo }),
      },
      { date: DATE, budget, sleep: realSleep, onRow: (r) => (result.rows.push(r), save(), logRow(r)) },
    );
    run.endedAt = new Date().toISOString();
    run.stopped = res.stopped;
    save();
    console.log(`sent ${res.rows.filter((r) => r.outcome === "sent").length}, run spent ${atomicToUsdc(budget.runSpentAtomic)} USDC, month ledger ${atomicToUsdc(budget.spent)} USDC${res.stopped ? `; stopped: ${res.stopped}` : ""}`);
    console.log(`results: ${file}`);
    return res.stopped?.startsWith("payer SOL decreased") ? 1 : 0;
  } finally {
    release();
  }
}

// ---------- Tempo ----------

async function tempo(slotsAll: ReturnType<typeof selectSlots>, targets: Target[]) {
  const tchain = await import("../src/tempo/chain.js");
  const { Ledger } = await import("../src/tempo/ledger.js");
  const { dayLedgerPath, dryRunTempo, liveChainView, monthCommittedElsewhere, payTempo } = await import("../src/remeasure/tempo.js");
  const { TEMPO_KEY_LEDGERS } = await import("../src/tempo/key-ledgers.js");
  const chainView = liveChainView(TEMPO_PAYER);
  const dayFile = dayLedgerPath(OUT, DATE);
  const monthElsewhere = monthCommittedElsewhere(OUT, MONTH, DATE);

  if (!PAY) {
    const before = await tchain.usdcBalance(TEMPO_PAYER);
    const today = existsSync(dayFile) ? new Ledger(dayFile, TEMPO_PAYER, RM_TEMPO_MAX_PER_RUN_ATOMIC).committed() : 0n;
    const monthChainOutflow = await chainView.outflowSinceMonthStart(MONTH);
    const res = await dryRunTempo(slotsAll.slots, fetch, { date: DATE, monthElsewhere, monthCommittedToday: today, monthChainOutflow, now: () => new Date() });
    const after = await tchain.usdcBalance(TEMPO_PAYER);
    const sum = summaryLines(res, atomicToUnits);
    const out = join(DRY_OUT, `tempo-${DATE}.dry-run.json`);
    const monthBooks = monthElsewhere + today;
    const monthSpent = monthChainOutflow > monthBooks ? monthChainOutflow : monthBooks;
    const monthLeft = RM_TEMPO_MAX_PER_MONTH_ATOMIC > monthSpent ? RM_TEMPO_MAX_PER_MONTH_ATOMIC - monthSpent : 0n;
    writeJsonAtomic(out, {
      kind: "vet402-remeasure-dry-run",
      chain: "tempo",
      createdAt: NOW.toISOString(),
      payer: TEMPO_PAYER,
      note: RM_NOTE,
      inputs,
      perPayTo,
      caps: { perPurchase: "0.100000", perRun: atomicToUnits(RM_TEMPO_MAX_PER_RUN_ATOMIC), perMonth: atomicToUnits(RM_TEMPO_MAX_PER_MONTH_ATOMIC), monthLeft: atomicToUnits(monthLeft), feeReservePerPurchase: "0.002000 (counted unless the live 402 is sponsored)" },
      summary: { payTos: slotsAll.payTos, resources: slotsAll.resources, slots: slotsAll.slots.length, ...sum, payerUsdcEBefore: atomicToUnits(before), payerUsdcEAfter: atomicToUnits(after) },
      excluded: slotsAll.excluded,
      rows: res.rows,
      skipped: res.skipped,
    });
    for (const r of res.rows) console.log(`${r.reason.padEnd(16)} ${`${r.host}#${r.service}`.padEnd(60)} ${r.priceUsdc ?? "-"} payTo=${r.payTo ?? "-"}${r.payTo && r.payTo !== r.expectedPayTo ? ` (recorded ${r.expectedPayTo})` : ""}`);
    console.log(`TARGETS payTos ${slotsAll.payTos}, resources ${slotsAll.resources}, slots ${slotsAll.slots.length} (per payTo ${perPayTo}); excluded ${JSON.stringify(tally(slotsAll.excluded))}`);
    console.log(`WOULD PAY ${sum.would}, estimated ${sum.estimate} USDC.e before fees (run cap ${atomicToUnits(RM_TEMPO_MAX_PER_RUN_ATOMIC)} incl. fee reserve, month left ${atomicToUnits(monthLeft)}); not paid: ${JSON.stringify(sum.refusals)}; skipped: ${JSON.stringify(sum.skipped)}`);
    console.log(`payer USDC.e before ${atomicToUnits(before)} after ${atomicToUnits(after)}`);
    console.log(`wrote ${out}`);
    return 0;
  }

  const { realSleep } = await import("../src/remeasure/loop.js");
  const release = lockOrExit(join(OUT, "tempo.lock"));
  let ledger: InstanceType<typeof Ledger> | null = null;
  try {
    await tchain.assertMainnet();
    const signer = tchain.loadSigner(opt("--key") ?? process.env.VET402_EVM_KEY_FILE ?? join(ROOT, ".keys", "evm.json"));
    // Purchases a killed run reserved but never recorded: one unknown_after_sign row each, never paid again.
    for (const r of reconcileTempo(OUT, targets, TEMPO_PAYER)) console.log(`recorded unknown_after_sign ${r.key} ${r.host}#${r.service}`);
    ledger = new Ledger(dayFile, TEMPO_PAYER, RM_TEMPO_MAX_PER_RUN_ATOMIC, { lock: true });
    const file = resultPath(OUT, "tempo", DATE);
    const result = readResultFile(file, "tempo", DATE, TEMPO_PAYER);
    const run: RunInfo = { startedAt: NOW.toISOString(), endedAt: null, perPayTo, stopped: null };
    result.runs.push(run);
    const save = () => writeJsonAtomic(file, result);
    save();
    const res = await payTempo(
      slotsAll.slots,
      {
        fetchImpl: fetch,
        signer,
        payer: TEMPO_PAYER,
        balance: () => tchain.usdcBalance(TEMPO_PAYER),
        verify: (h, e) => tchain.verifySettlement(h, e),
      },
      // payOne's chain check: outflow since the census start <= this day ledger + every other ledger of the key.
      { date: DATE, ledger, keyLedgers: TEMPO_KEY_LEDGERS, chain: chainView, monthElsewhere, sleep: realSleep, onRow: (r) => (result.rows.push(r), save(), logRow(r)) },
    );
    run.endedAt = new Date().toISOString();
    run.stopped = res.stopped;
    save();
    console.log(`sent ${res.rows.filter((r) => r.outcome === "sent").length}, day ledger ${atomicToUnits(ledger.committed())} USDC.e committed${res.stopped ? `; stopped: ${res.stopped}` : ""}`);
    console.log(`results: ${file}`);
    return res.stopped ? 2 : 0;
  } finally {
    ledger?.release();
    release();
  }
}

function lockOrExit(file: string): () => void {
  try {
    return acquireRunLock(file, NOW);
  } catch (e) {
    if (e instanceof LockHeld) throw new Error(`another remeasure --pay run holds ${file}. If none is running, check the day's ledger for purchases without a result, then delete the lock file.`);
    throw e;
  }
}

function logRow(r: RemeasureRow) {
  console.log(`${r.outcome.padEnd(8)} ${r.reason.padEnd(16)} ${r.host.padEnd(44)} ${r.priceUsdc ?? "-"} settled=${r.settled ?? "-"} delivered=${r.delivered ?? "-"} tx=${r.tx ?? "-"}`);
}

const allTargets = targetsFor(chain);
const slots = selectSlots(allTargets, perPayTo);
process.exitCode = chain === "solana" ? await solana(slots, allTargets) : await tempo(slots, allTargets);
