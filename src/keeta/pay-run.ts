/**
 * Keeta --pay run body (lock held for the whole critical section). Injectable for tests.
 */
import { readFileSync, statSync } from "node:fs";
import { acquireRunLock, LockHeld } from "../first-buyer/lock.js";
import {
  buyKeetaOne,
  readKeetaPayPlan,
  readKeetaResultFile,
  type KeetaBuyDeps,
  type KeetaBuyEntry,
  type KeetaRemeasureRow,
  type KeetaResultFile,
} from "./buy.js";
import { KeetaBudget, isKeetaMonthCapRefusal, isKeetaRunCapRefusal } from "./budget.js";
import {
  KEETA_KEY_FILE,
  KEETA_MAX_PER_RUN_ATOMIC,
  KEETA_MAX_PURCHASES_PER_RUN,
  KEETA_PUB_FILE,
  KEETA_RPC_TIMEOUT_MS,
  KEETA_USDC,
  keetaBudgetPath,
  keetaLockPath,
  keetaResultPath,
} from "./constants.js";
import { publicKeetaReader, readKeetaUsdcBalance, withKeetaTimeout, type KeetaLedgerReader } from "./ledger.js";
import { accountToSigner, loadKeetaAccount, makeKeetaCreatePayment } from "./sign.js";
import { writeJsonAtomic } from "../remeasure/results.js";
import type { ClientKeetaSigner } from "@x402/keeta";

function monthCapStop(row: KeetaRemeasureRow): boolean {
  if (isKeetaMonthCapRefusal({ refused: row.reason, detail: row.detail })) return true;
  if (row.reason === "purchase_count_reached" && !row.detail?.startsWith("run:")) return true;
  return false;
}

export interface KeetaPayRunHooks {
  loadAccount: (keyFile: string, pub: string) => Promise<Awaited<ReturnType<typeof loadKeetaAccount>>>;
  makeReader: () => KeetaLedgerReader;
  readResult: (file: string, date: string, payer: string) => KeetaResultFile;
  readPlan: (file: string, day: string) => KeetaBuyEntry[];
  buyOne: typeof buyKeetaOne;
  readBalance: (payer: string, token: string) => Promise<bigint>;
  acquireLock: (file: string, now: Date) => (() => void) | null;
  pubFile: string;
  keyFile: string;
  statPubMode: (file: string) => number;
  readPubAddress: (file: string) => string;
  writeResult: (path: string, data: KeetaResultFile) => void;
  log: (msg: string) => void;
  error: (msg: string) => void;
  toSigner: typeof accountToSigner;
  rpcTimeoutMs: number;
}

const defaultHooks = (): KeetaPayRunHooks => ({
  loadAccount: loadKeetaAccount,
  makeReader: publicKeetaReader,
  readResult: readKeetaResultFile,
  readPlan: readKeetaPayPlan,
  buyOne: buyKeetaOne,
  readBalance: readKeetaUsdcBalance,
  acquireLock: (file, now) => {
    try {
      return acquireRunLock(file, now);
    } catch (e) {
      if (e instanceof LockHeld) return null;
      throw e;
    }
  },
  pubFile: KEETA_PUB_FILE,
  keyFile: KEETA_KEY_FILE,
  statPubMode: (file) => statSync(file).mode & 0o777,
  readPubAddress: (file) => readFileSync(file, "utf8").trim().split(/\s/)[0]!,
  writeResult: writeJsonAtomic,
  log: (msg) => console.log(msg),
  error: (msg) => console.error(msg),
  toSigner: accountToSigner,
  rpcTimeoutMs: KEETA_RPC_TIMEOUT_MS,
});

export async function runKeetaPayRun(opts: {
  planFile: string;
  date: string;
  now: Date;
  resultsDir: string;
  fetchImpl: typeof fetch;
  hooks?: Partial<KeetaPayRunHooks>;
}): Promise<number> {
  const h = { ...defaultHooks(), ...opts.hooks };
  let release: (() => void) | null = null;
  try {
    release = h.acquireLock(keetaLockPath(opts.resultsDir), opts.now);
    if (!release) return 1;

    const entries = h.readPlan(opts.planFile, opts.date);
    const pubMode = h.statPubMode(h.pubFile);
    if (pubMode !== 0o600) {
      h.error(`keeta-payer.pub must be mode 600 (is ${pubMode.toString(8)})`);
      return 1;
    }
    const pub = h.readPubAddress(h.pubFile);
    let signer: ClientKeetaSigner | undefined;
    let reader: KeetaLedgerReader | undefined;
    let exitCode = 0;
    let resultPath = "";
    let startedAt = "";
    let result: KeetaResultFile | undefined;
    let rows: KeetaRemeasureRow[] = [];
    let stopped: string | null = null;
    try {
      const account = await h.loadAccount(h.keyFile, pub);
      const payer = account.publicKeyString.toString();
      signer = h.toSigner(account);
      reader = h.makeReader();
      const budgetFile = keetaBudgetPath(opts.resultsDir, opts.date.slice(0, 7));
      const budget = new KeetaBudget(budgetFile, KEETA_MAX_PER_RUN_ATOMIC, KEETA_MAX_PURCHASES_PER_RUN, opts.date);
      resultPath = keetaResultPath(opts.resultsDir, opts.date);
      startedAt = opts.now.toISOString();
      result = h.readResult(resultPath, opts.date, payer);
      rows = [...result.rows];

      const bal = await h.readBalance(payer, KEETA_USDC);
      budget.setBaselineIfMissing(bal);
      const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
      const createPayment = makeKeetaCreatePayment(signer, payer);
      const deps: KeetaBuyDeps = {
        fetch: opts.fetchImpl,
        payer,
        createPayment,
        reader,
        budget,
        balance: async () => h.readBalance(payer, KEETA_USDC),
        now: () => opts.now,
        sleep,
      };
      try {
        for (const entry of entries) {
          const out = await h.buyOne(entry, deps, opts.date, rows.length + 1);
          rows.push(out.row);
          if (out.stop) {
            stopped = out.stop;
            if (
              stopped.startsWith("keeta_tx_not_found:") ||
              stopped.startsWith("keeta_tx_mismatch:") ||
              stopped.startsWith("keeta_ledger_unreadable:") ||
              stopped.startsWith("keeta_sign_timeout:")
            ) {
              exitCode = 2;
            }
            break;
          }
          if (out.row.outcome === "refused") {
            if (monthCapStop(out.row)) {
              stopped = `month_cap_reached: ${out.row.detail}`;
              break;
            }
            if (isKeetaRunCapRefusal({ refused: out.row.reason, detail: out.row.detail }) || out.row.reason === "purchase_count_reached") {
              break;
            }
          }
          if (budget.runSpentAtomic >= KEETA_MAX_PER_RUN_ATOMIC) break;
        }
      } catch (e) {
        stopped = (e as Error).message;
        exitCode = exitCode || 1;
      }
      result = {
        ...result,
        payer,
        rows,
        runs: [...result.runs, { startedAt, endedAt: new Date().toISOString(), perPayTo: 1, stopped }],
      };
      h.writeResult(resultPath, result);
      const sent = rows.filter((r) => r.outcome === "sent").length;
      const tail = stopped ? ` (stopped: ${stopped})` : "";
      h.log(`Keeta paid ${sent}${tail}`);
    } catch (e) {
      exitCode = exitCode || 1;
      h.error((e as Error).message);
    } finally {
      if (signer) {
        try {
          await withKeetaTimeout(signer.destroy(), h.rpcTimeoutMs, "signer.destroy");
        } catch (e) {
          h.error((e as Error).message);
        }
      }
      if (reader) {
        try {
          await withKeetaTimeout(reader.destroy(), h.rpcTimeoutMs, "reader.destroy");
        } catch (e) {
          h.error((e as Error).message);
        }
      }
    }
    return exitCode;
  } finally {
    release?.();
  }
}