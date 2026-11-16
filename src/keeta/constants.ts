/**
 * Keeta mainnet lane: fixed values. Changing any of these changes what money can move.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { MAX_PER_PURCHASE_ATOMIC } from "../constants.js";
import { RM_PROD_DIR } from "../remeasure/constants.js";

export const KEETA_CAIP2 = "keeta:21378";
export const KEETA_TESTNET_CAIP2 = "keeta:1413829460";
export const KEETA_USDC = "keeta_amnkge74xitii5dsobstldatv3irmyimujfjotftx7plaaaseam4bntb7wnna";
export const KEETA_USDC_DECIMALS = 6;

export type KeetaSeller = {
  host: string;
  catalog: string;
  payTo: string;
  /** Seller may answer unpaid GET with 200; vet402 pays from the catalog accept before the resource GET. */
  freeTrial?: boolean;
  /** Max would_pay routes from this seller per dry-run / run slice (keespecs 12 + kta-oracle 3 = 15). */
  maxPerRun?: number;
};

export const KEETA_SELLERS: readonly KeetaSeller[] = [
  {
    host: "keespecs.xyz",
    catalog: "https://keespecs.xyz/.well-known/x402",
    payTo: "keeta_aabz6zxbs2n4r7iiobclndobrnowxdf4pjrb5lwe6bvpeo564bot6krjbrsbbvy",
    maxPerRun: 12,
  },
  {
    host: "kta-oracle.top",
    catalog: "https://kta-oracle.top/.well-known/x402",
    payTo: "keeta_aab4y4nd5ug4nnzjtp5fslfsrdv7pnxfbeexafwolqs4mgxrb2ppontfqb64tzi",
    freeTrial: true,
    maxPerRun: 3,
  },
];

export function keetaSellerMaxPerRun(seller: KeetaSeller): number {
  return seller.maxPerRun ?? KEETA_MAX_PURCHASES_PER_RUN;
}

export const KEETA_MAX_PER_PURCHASE_ATOMIC = 20_000n;
export const KEETA_MAX_PER_RUN_ATOMIC = 250_000n;
export const KEETA_MAX_PER_MONTH_ATOMIC = 6_000_000n;
export const KEETA_MAX_PURCHASES_PER_RUN = 15;
export const KEETA_MAX_PURCHASES_PER_MONTH = 600;
export const KEETA_RPC_TIMEOUT_MS = 20_000;
if (KEETA_MAX_PER_PURCHASE_ATOMIC > MAX_PER_PURCHASE_ATOMIC) throw new Error("Keeta per-purchase cap exceeds the guard's cap");

const keyRoot = process.env.VET402_KEETA_KEY_DIR ?? join(homedir(), ".vet402");
export const KEETA_RESULTS_DIR = process.env.VET402_KEETA_RESULTS_DIR ?? RM_PROD_DIR;
export const KEETA_KEY_DIR = keyRoot;
export const KEETA_KEY_FILE = join(KEETA_KEY_DIR, "keeta-payer.json");
export const KEETA_PUB_FILE = join(KEETA_KEY_DIR, "keeta-payer.pub");

/** Ledger, results and lock live under RM_PROD_DIR (results/remeasure): budget-keeta-YYYY-MM.json, keeta-YYYY-MM-DD.json, keeta.lock. */
/** Dry run writes keeta-YYYY-MM-DD.dry-run.json under --out only. */
/** Daily runner: ~/.config/vet402-daily/keeta-enabled present turns this lane on after publish. Absent (default) leaves it off. */
export const KEETA_ENABLED_FLAG = join(homedir(), ".config", "vet402-daily", "keeta-enabled");

export function keetaBudgetPath(dir: string, month: string): string {
  return join(dir, `budget-keeta-${month}.json`);
}

export function keetaResultPath(dir: string, day: string): string {
  return join(dir, `keeta-${day}.json`);
}

export function keetaDryRunPath(dir: string, day: string): string {
  return join(dir, `keeta-${day}.dry-run.json`);
}

export function keetaLockPath(dir: string): string {
  return join(dir, "keeta.lock");
}