/** Fixed values for gate 1. Changing any of these changes what money can move. */
export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;

/** vet402's Solana payer (the key lives in .keys/payer.json; never printed). */
export const PAYER_ADDRESS = "9VaAPD1CPE4i8pquaRwE7LvZXMmvGdgffD4Q8xJgaQRu";

/** Absolute money limits (atomic USDC, 6 decimals). */
export const MAX_PER_PURCHASE_ATOMIC = 100_000n; // 0.10 USDC
export const MAX_TOTAL_ATOMIC = 1_000_000n; // 1.00 USDC
export const MAX_PURCHASES = 10;

/**
 * Measurement pacing (rank method v2), for every script here that buys to measure sellers:
 * at most MEASURE_MAX_PER_SELLER purchases from one seller in one run, and at least MEASURE_SPACING_MS
 * between two purchases from the same seller. The 2026-09-27/28 Algorand runs bought ~500 items of one
 * seller within minutes and got 429 / subcent_quota_exceeded back; that measured vet402, not the seller.
 * This changes only how many and how fast. Amounts, payTo checks and the money caps above are untouched.
 */
export const MEASURE_MAX_PER_SELLER = 5;
export const MEASURE_SPACING_MS = 60_000;

export const PAYAI_DISCOVERY = "https://facilitator.payai.network/discovery/resources";
export const CDP_DISCOVERY = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

/** Hosts that are vet402's own: never bought from. */
export const OWN_HOSTS = ["vet402.com", "vet402-algorand.vercel.app"];

export const V1_NETWORK_ALIASES: Record<string, string> = { solana: SOLANA_MAINNET };

export function toCaip2(network: unknown): string {
  const n = String(network ?? "");
  return V1_NETWORK_ALIASES[n] ?? n;
}

export function atomicToUsdc(a: bigint | string): string {
  const v = BigInt(a);
  const whole = v / 1_000_000n;
  const frac = (v % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}
