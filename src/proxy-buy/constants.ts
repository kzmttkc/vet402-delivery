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

/**
 * Solana refunds that may create the agent's USDC account (the proxy payer pays its rent in SOL, about 0.002
 * each) per UTC day. A refund whose account is missing past this waits for the next day, and is reported once
 * it is stuck.
 */
export const REFUND_ACCOUNT_CREATIONS_PER_DAY = 10;

/** A Tempo payment's validBefore may be at most this far ahead (mppx signs 25 s ahead): past it, it is refused. */
export const TEMPO_MAX_VALID_AHEAD_SECONDS = 600;

/**
 * The most a Tempo refund may pay in network fees (USDC.e, bounded at the base-fee cap, src/receipt/tempo-anchor.ts):
 * 0.01. A plain TIP-20 transfer is about 33k gas, but Tempo charges about 250k more gas for a transaction from an
 * account with no transaction yet (nonce 0) and about 250k more for a transfer to an address holding no USDC.e
 * (both read with eth_estimateGas on mainnet, 2026-10-01: 285,714 and 288,879). A refund can be one or both: the proxy
 * payer's first transaction, to an agent that paid its whole balance. With the census reserve (0.002) as the
 * bound, such a refund was refused before sending every time and ended "stuck". 10,000 atomic covers a gas limit
 * of 833k (estimate x 1.25) at the cap. The fee actually paid is the base fee's (0.6 gwei on 2026-10-01, about
 * 0.0003 for 450k gas). Every Tempo purchase reserves this much more in the payer wallet, for its refund.
 */
export const TEMPO_REFUND_FEE_BOUND_ATOMIC = 10_000n;

/**
 * The reconciler says ALERT when Tempo's base fee passes this (6 gwei): half the base-fee cap (12 gwei) that the
 * refund's fee bound and every refund's maxFeePerGas assume. Seen early, before a refund cannot be included.
 */
export const TEMPO_BASE_FEE_ALERT = 6_000_000_000n;

/** Chain transaction reads one reconcile run may make in all (the cron's RPC bill has a ceiling). */
export const RECONCILE_MAX_TX_READS = 1000;

/** A purchase whose chain search was cut short is looked at again only after this long. */
export const CAPPED_RECHECK_MS = 15 * 60_000;

/** An open purchase older than this is reported by the reconciler (ALERT) on every look. */
export const OPEN_ALERT_MS = 2 * 3_600_000;

export const DEFAULT_FACILITATOR_URL = "https://facilitator.payai.network";

/** Shown with every price and in the README. */
export const REFUND_POLICY =
  "If your payment settles and vet402 then does not pay the seller, vet402 refunds your full payment to the address that paid, on the same chain in the same token. If vet402 paid the seller and the seller did not deliver, there is no refund; the purchase is recorded against the seller.";

/** Shown with every price: what happens to an answer above PROXY_MAX_FORWARD_BYTES. */
export const ANSWER_LIMIT_NOTE =
  "An answer above 1,000,000 bytes is not forwarded. vet402 has paid the seller by then, so there is no refund; the record keeps its size and sha256.";
