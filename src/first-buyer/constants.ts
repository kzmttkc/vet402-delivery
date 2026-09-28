/**
 * First-buyer mode: fixed values. Changing any of these changes what money can move.
 *
 * vet402 buys, once per payTo for life, from a Solana x402 seller that no one outside vet402
 * has paid yet, and publishes whether the payment settled and whether content came back.
 */
import { MAX_PER_PURCHASE_ATOMIC, PAYER_ADDRESS, SOLANA_MAINNET, USDC_MINT } from "../constants.js";

/** 0.10 USDC per purchase (atomic, 6 decimals). Never above the gate-1 per-purchase cap. */
export const FB_MAX_PER_PURCHASE_ATOMIC = 100_000n;
if (FB_MAX_PER_PURCHASE_ATOMIC > MAX_PER_PURCHASE_ATOMIC) throw new Error("first-buyer per-purchase cap exceeds the guard's cap");
/** 5 USDC per run. */
export const FB_MAX_PER_RUN_ATOMIC = 5_000_000n;
/** 20 USDC per calendar month (UTC), persisted in results/first-buyer-budget-YYYY-MM.json. */
export const FB_MAX_PER_MONTH_ATOMIC = 20_000_000n;
/** Runaway bound on purchase count in one month ledger; money is bounded by the 20 USDC cap. */
export const FB_MAX_PURCHASES_PER_MONTH = 1000;

/** A failure where no money moved may be tried again this many days after the first attempt. */
export const FB_RETRY_AFTER_DAYS: readonly number[] = [7, 30];
/** First attempt plus the retries above. */
export const FB_MAX_ATTEMPTS = 1 + FB_RETRY_AFTER_DAYS.length;

/** Printed on every published record. */
export const FB_NOTE = "One test purchase by vet402. Not organic demand.";

/** Window for the reciprocity mark (rule 6). */
export const FB_RECIPROCAL_WINDOW_DAYS = 90;

/** The wallets vet402 buys from on Solana (published as wallets.json). */
export const FB_BUYER_WALLETS: readonly { chain: string; network: string; address: string; asset: string; use: string }[] = [
  {
    chain: "solana",
    network: SOLANA_MAINNET,
    address: PAYER_ADDRESS,
    asset: USDC_MINT,
    use: "vet402 test purchases on Solana (gate 1, census, first-buyer). Payments from this wallet are not organic demand.",
  },
];

/**
 * vet402's own Solana addresses. USDC from these is not an outside receipt, and a payTo in this
 * list is never bought. payTos declared by listings on vet402's own hosts are added at run time.
 */
export const FB_OWN_ADDRESSES: readonly string[] = [PAYER_ADDRESS];

/** Tunnel and preview hosts that do not stay up: never bought (rule 1, item 5). */
export const TEMP_HOST_SUFFIXES: readonly string[] = [
  "trycloudflare.com",
  "ngrok-free.app",
  "ngrok-free.dev",
  "ngrok.io",
  "ngrok.app",
  "ngrok.dev",
  "loca.lt",
  "localtunnel.me",
  "serveo.net",
  "serveousercontent.com",
  "lhr.life",
  "localhost.run",
  "pinggy.link",
  "pinggy.io",
  "tunnelmole.net",
  "devtunnels.ms",
  "bore.pub",
];

/** Outside-receipt check: signatures read per USDC account, and transactions parsed per payTo. */
export const FB_RECEIPT_SIG_LIMIT = 100;
export const FB_RECEIPT_TX_LIMIT = 25;

/** A --pay run refuses a plan older than this. */
export const FB_PLAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;
