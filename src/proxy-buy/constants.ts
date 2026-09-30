/**
 * Fixed values for proxy buy ("vet402 buys it for the agent"). Changing any of these changes what money can move.
 *
 * Proxy buy has its own wallets, its own caps and its own ledgers. It never signs with the census,
 * remeasure or first-buyer payers, and none of their ledgers or caps count here.
 */

export const BUY_PATH = "/v1/buy";
export const RECORD_PATH_PREFIX = "/v1/buy/records/";

/** vet402's fee on top of the seller's price, atomic USDC / USDC.e (6 decimals): 0.005. */
export const BUY_FEE_ATOMIC = 5_000n;

/** Largest seller price proxy buy pays in one purchase: 0.10 (the same per-purchase cap as the census). */
export const PROXY_MAX_PER_CALL_ATOMIC = 100_000n;

/** Default daily caps (UTC day) on what the proxy payer sends to sellers. Env can lower them, never raise them above the hard ceilings. */
export const PROXY_DEFAULT_DAILY_CAP_ATOMIC = 2_000_000n; // 2.00
export const PROXY_SOLANA_DAILY_CAP_CEILING_ATOMIC = 5_000_000n; // 5.00
/** Tempo's Ledger refuses a cap above its own ceiling (src/tempo/constants.ts MAX_TOTAL_ATOMIC, 5.00) and more than 150 entries. */
export const PROXY_DAILY_MAX_PURCHASES = 100;

/** Largest seller answer forwarded to the agent. A larger one is not forwarded in part. */
export const PROXY_MAX_FORWARD_BYTES = 1_000_000;

/** How long the price in a 402 stays payable (x402 maxTimeoutSeconds, MPP challenge expiry). */
export const OFFER_TTL_SECONDS = 60;

/** How long to wait for the agent's payment to show on chain before vet402 pays the seller. */
export const CUSTOMER_CONFIRM_TIMEOUT_MS = 30_000;

/** Unpaid price reads per client IP per minute (each one reads the seller's 402). */
export const QUOTES_PER_MINUTE = 30;

export const DEFAULT_FACILITATOR_URL = "https://facilitator.payai.network";
