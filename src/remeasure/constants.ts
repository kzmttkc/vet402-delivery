/**
 * Remeasure: fixed values. Changing any of these changes what money can move.
 *
 * Remeasure buys again from sellers vet402 already paid and whose payment settled, so the ranking
 * (src/rank, method v2) gets purchases on more than one day. It never buys from a new seller. It runs every
 * day from 2026-09-29 to 2026-10-08, twice on Solana and once on Tempo (by hand on 2026-09-29, then from the
 * daily runner scripts/daily/run.sh); the ledger allows one purchase per payTo per slot per UTC day
 * (ledger key <date>|<payTo>|<slot>, budget.ts).
 */
import { MAX_PER_PURCHASE_ATOMIC, MEASURE_MAX_PER_SELLER } from "../constants.js";
import { MAX_PER_CALL_ATOMIC } from "../tempo/constants.js";
import { TEMPO_KEY_LEDGERS } from "../tempo/key-ledgers.js";

export type RemeasureChain = "solana" | "tempo";
export const REMEASURE_CHAINS: readonly RemeasureChain[] = ["solana", "tempo"];

/** Solana, atomic USDC (6 decimals). */
export const RM_SOLANA_MAX_PER_PURCHASE_ATOMIC = 100_000n; // 0.10 USDC
export const RM_SOLANA_MAX_PER_RUN_ATOMIC = 3_000_000n; // 3 USDC
export const RM_SOLANA_MAX_PER_MONTH_ATOMIC = 30_000_000n; // 30 USDC, results/remeasure/budget-solana-YYYY-MM.json
if (RM_SOLANA_MAX_PER_PURCHASE_ATOMIC > MAX_PER_PURCHASE_ATOMIC) throw new Error("remeasure per-purchase cap exceeds the guard's cap");

/** Tempo, atomic USDC.e (6 decimals). Amount + fee reserve count against the caps. */
export const RM_TEMPO_MAX_PER_PURCHASE_ATOMIC = 100_000n; // 0.10 USDC.e
export const RM_TEMPO_MAX_PER_RUN_ATOMIC = 1_000_000n; // 1 USDC.e (the day ledger's cap)
export const RM_TEMPO_MAX_PER_MONTH_ATOMIC = 30_000_000n; // 30 USDC.e, summed over the month's day ledgers
if (RM_TEMPO_MAX_PER_PURCHASE_ATOMIC > MAX_PER_CALL_ATOMIC) throw new Error("remeasure per-call cap exceeds the Tempo guard's cap");

/**
 * Runaway bound on purchases in one Solana month file. Money is bounded by the 30 USDC month cap;
 * this only stops a loop. ~100 payTos a day for 31 days fits.
 */
export const RM_MAX_PURCHASES_PER_MONTH = 5_000;

/** Purchases per payTo in one run: 1 unless --per-payto says more, never above MEASURE_MAX_PER_SELLER. */
export const RM_DEFAULT_PER_PAYTO = 1;
/**
 * The daily rebuy waits this long for a paid answer (the purchase code's own default is 90 s). On 2026-10-01 a Tempo
 * seller that had answered 200 on 09-29 and 09-30 was cut off at 90 s, after the payment had settled: vet402 lost
 * the answer it paid for and the run stopped. Nothing waits on these runs, so a slow seller gets the time.
 */
export const RM_PAID_TIMEOUT_MS = 180_000;
export const RM_MAX_PER_PAYTO = MEASURE_MAX_PER_SELLER;

/**
 * The only place --pay keeps ledgers, locks and results: ~/vet402-solana/results/remeasure, whichever
 * checkout the script runs from. A second copy of the ledgers elsewhere would reopen the caps.
 * The Tempo key's ledger set (src/tempo/key-ledgers.ts) points at the same folder.
 */
export const RM_PROD_DIR = TEMPO_KEY_LEDGERS.remeasureDir;

/** Printed on every result file. */
export const RM_NOTE = "Repeat test purchase by vet402 from a seller it paid before. Not organic demand.";
