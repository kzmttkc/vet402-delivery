/**
 * Fixed values for the Tempo census. Changing any of these changes what money can move.
 *
 * Sources (read 2026-09-28):
 *  - chainId 4217 / USDC.e / pathUSD / MACH: read on chain from https://rpc.tempo.xyz
 *    (eth_chainId = 0x1079; name()/symbol()/decimals() of each token).
 *  - Mercator prices MPP charges in USDC.e: https://mercator.sh/docs.md ("Payments").
 *  - Fee token order (tx > account > TIP-20 contract > pathUSD):
 *    https://tempo.xyz/developers/docs/protocol/fees/spec-fee
 */

/** Tempo mainnet. The only chain the census signs for. */
export const TEMPO_MAINNET_CHAIN_ID = 4217;
export const TEMPO_MAINNET_CAIP2 = "eip155:4217";
/** Tempo testnet (Moderato). Named only so it can be refused by name. */
export const TEMPO_MODERATO_CHAIN_ID = 42431;
export const TEMPO_MODERATO_CAIP2 = "eip155:42431";

export const TEMPO_RPC_URL = "https://rpc.tempo.xyz";
export const TEMPO_EXPLORER_TX = "https://explore.tempo.xyz/tx/";

/** Bridged USDC (Stargate), symbol USDC.e, 6 decimals. The only currency the census pays in. */
export const USDC_E = "0x20c000000000000000000000b9537d11c60e8b50";
/** pathUSD, 6 decimals. Recorded when a challenge asks for it; never paid. */
export const PATH_USD = "0x20c0000000000000000000000000000000000000";
/** MACH (Mercator credit), 6 decimals. Recorded, never paid. */
export const MACH = "0x20c000000000000000000000f37de3740adec032";
export const TOKEN_SYMBOLS: Record<string, string> = {
  [USDC_E]: "USDC.e",
  [PATH_USD]: "pathUSD",
  [MACH]: "MACH",
};
export const TIP20_DECIMALS = 6;

/** vet402's shared EVM payer (key in <repo>/.keys/evm.json; never printed). */
export const PAYER_ADDRESS = "0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51";

/** Money limits, atomic USDC.e (6 decimals). */
export const MAX_PER_CALL_ATOMIC = 100_000n; // 0.10 USDC.e per purchase
export const MAX_TOTAL_ATOMIC = 5_000_000n; // 5.00 USDC.e hard ceiling for the whole census
export const DEFAULT_TOTAL_CAP_ATOMIC = 2_500_000n; // 2.50 USDC.e unless --cap lowers/raises it (<= hard ceiling)
export const MAX_PURCHASES = 150;
/**
 * When a challenge does not set feePayer, vet402 pays the Tempo fee itself (in USDC.e,
 * the TIP-20 being transferred). A 50k-gas TIP-20 transfer costs <= ~$0.0006 at the base-fee
 * cap (fees spec). Reserve 0.002 per unsponsored purchase against the total cap so the cap
 * holds even for a first transaction from a fresh account.
 */
export const FEE_RESERVE_ATOMIC = 2_000n;

/** Wait this long for a paid response. vouch's 20 s limit cut off image generations (see analysis). */
export const PAID_TIMEOUT_MS = 90_000;
export const PROBE_TIMEOUT_MS = 20_000;

export const MERCATOR_ORIGIN = "https://mercator.sh";
export const MPP_DIRECTORY_URL = "https://mpp.dev/api/services";
export const USER_AGENT = "vet402-tempo-census/0.1 (+https://vet402.com)";

/** Hosts that are vet402's own: never bought from. */
export const OWN_HOSTS = ["vet402.com", "vet402-algorand.vercel.app"];

export function normAddr(a: unknown): string {
  return String(a ?? "").toLowerCase();
}

export function tokenSymbol(addr: string): string {
  return TOKEN_SYMBOLS[normAddr(addr)] ?? addr;
}

export function atomicToUnits(a: bigint | string): string {
  const v = BigInt(a);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}
