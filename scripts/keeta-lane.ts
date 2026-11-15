/**
 * Keeta remeasure lane (keespecs.xyz). Default off. Enabled by ~/.config/vet402-daily/keeta-enabled via run.sh.
 *
 *   npx tsx scripts/keeta-lane.ts --dry-run [--out <dir>]
 *   VET402_KEETA_PAY=1 npx tsx scripts/keeta-lane.ts --pay --plan <dry-run.json>
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicToUsdc } from "../src/constants.js";
import { toAtomic } from "../src/daily/steps.js";
import { keetaCandidatesFromCatalog } from "../src/keeta/challenge.js";
import { fetchCatalog } from "../src/keeta/catalog.js";
import { probePayable } from "../src/keeta/probe.js";
import type { KeetaRemeasureRow } from "../src/keeta/buy.js";
import {
  KEETA_MAX_PER_MONTH_ATOMIC,
  KEETA_MAX_PER_RUN_ATOMIC,
  KEETA_MAX_PURCHASES_PER_RUN,
  KEETA_PUB_FILE,
  KEETA_RESULTS_DIR,
  KEETA_SELLERS,
  KEETA_USDC,
  keetaBudgetPath,
  keetaDryRunPath,
} from "../src/keeta/constants.js";
import { readKeetaUsdcBalance } from "../src/keeta/ledger.js";
import { applyKeetaCapsToPlanRows, keetaLedgerCaps, keetaMonthCapWarn } from "../src/keeta/plan.js";
import { runKeetaPayRun } from "../src/keeta/pay-run.js";
import { writeJsonAtomic } from "../src/remeasure/results.js";

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
  console.error(`${msg}\nusage: keeta-lane.ts --dry-run [--out dir] | --pay --plan <file> (requires VET402_KEETA_PAY=1)`);
  process.exit(2);
}

if (flag("--pay") && flag("--dry-run")) usage("choose --dry-run or --pay");
const PAY = flag("--pay");
const DRY = flag("--dry-run") || !PAY;
if (!DRY && !PAY) usage("--dry-run or --pay is required");
if (PAY && process.env.VET402_KEETA_PAY !== "1") process.exit(6);
if (PAY && !opt("--plan")) usage("--pay requires --plan");

const NOW = new Date();
const DATE = NOW.toISOString().slice(0, 10);
const MONTH = DATE.slice(0, 7);
const OUT = KEETA_RESULTS_DIR;
const dryOut = resolve(opt("--out") ?? join(ROOT, "results", "remeasure"));

function readPub(): { address: string | null; problem: string | null } {
  if (!existsSync(KEETA_PUB_FILE)) {
    return { address: null, problem: "no Keeta purchase key (keeta-payer.pub not found in the key folder)" };
  }
  const address = readFileSync(KEETA_PUB_FILE, "utf8").trim().split(/\s/)[0] ?? "";
  if (!address.startsWith("keeta_")) return { address: null, problem: "keeta-payer.pub has no Keeta address" };
  return { address, problem: null };
}

async function runDry(fetchImpl: typeof fetch): Promise<void> {
  mkdirSync(dryOut, { recursive: true });
  const pub = readPub();
  const payer = pub.address ?? "keeta_unknown";
  let balanceAtomic = 0n;
  if (pub.address) {
    try {
      balanceAtomic = await readKeetaUsdcBalance(pub.address, KEETA_USDC);
    } catch {
      balanceAtomic = 0n;
    }
  }
  const monthFile = keetaBudgetPath(OUT, MONTH);
  const { monthSpent, monthCount, daySeed } = keetaLedgerCaps(monthFile, DATE);
  const rows: KeetaRemeasureRow[] = [];
  for (const seller of KEETA_SELLERS) {
    const catalog = await fetchCatalog(seller.catalog, fetchImpl);
    const urls = keetaCandidatesFromCatalog(catalog, seller);
    for (const { url, payTo } of urls) {
      const row = await probePayable(url, payTo, fetchImpl, { at: NOW.toISOString(), date: DATE });
      if (!row) continue;
      rows.push(row);
      if (rows.filter((r) => r.outcome === "would_pay").length >= KEETA_MAX_PURCHASES_PER_RUN) break;
    }
  }
  const { monthCut, payableCount } = applyKeetaCapsToPlanRows(rows, {
    monthSpent,
    monthCount,
    daySeed,
    balance: balanceAtomic,
    date: DATE,
  });
  const would = rows.filter((r) => r.outcome === "would_pay");
  const estProper = atomicToUsdc(would.reduce((a, r) => a + (r.priceUsdc ? toAtomic(r.priceUsdc) : 0n), 0n));
  const monthLeft = KEETA_MAX_PER_MONTH_ATOMIC - monthSpent;
  const perRunLeftAtomic = KEETA_MAX_PER_RUN_ATOMIC - daySeed.spent;
  const outFile = {
    kind: "vet402-remeasure-dry-run" as const,
    chain: "keeta" as const,
    createdAt: NOW.toISOString(),
    perPayTo: 1,
    caps: {
      perRun: atomicToUsdc(perRunLeftAtomic > 0n ? perRunLeftAtomic : 0n),
      monthLeft: atomicToUsdc(monthLeft > 0n ? monthLeft : 0n),
    },
    summary: { would: would.length, estimate: estProper, payerUsdcBefore: atomicToUsdc(balanceAtomic) },
    rows,
    signer: pub.problem
      ? { problem: pub.problem }
      : monthCut > 0
        ? { warn: keetaMonthCapWarn(would.length, payableCount, monthSpent) }
        : {},
    payer,
  };
  writeJsonAtomic(keetaDryRunPath(dryOut, DATE), outFile);
  console.log(`Keeta dry run: ${would.length} would pay, estimate ${estProper} USDC, balance ${atomicToUsdc(balanceAtomic)}`);
}

async function runPay(fetchImpl: typeof fetch): Promise<number> {
  const planFile = resolve(opt("--plan")!);
  return runKeetaPayRun({ planFile, date: DATE, now: NOW, resultsDir: OUT, fetchImpl });
}

const fetchImpl = globalThis.fetch;
if (DRY) {
  runDry(fetchImpl)
    .then(() => process.exit(0))
    .catch((e) => {
      console.error((e as Error).message);
      process.exit(1);
    });
} else {
  runPay(fetchImpl)
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error((e as Error).message);
      process.exit(1);
    });
}