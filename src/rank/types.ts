/**
 * Common schema for one vet402 purchase attempt, whatever the chain.
 *
 * Every row comes from a run where vet402 paid (or offered to pay) from its own wallet.
 * Nothing a seller reports about itself (call counts, payer counts, reviews) enters this schema.
 */

import type { InputProblem } from "../tempo/answer.js";

export type Chain = "algorand" | "solana" | "tempo" | "base" | "robinhood" | "arbitrum";

/**
 * Why an attempt ended the way it did.
 * The first five are "tried": vet402 committed to pay, so the seller had a fair chance to deliver.
 * The last three are "not tried": they are recorded but never count toward a seller's rate.
 */
export type ReasonCategory =
  | "delivered" // settled, then a 2xx answer with a non-empty body (the same test on every chain)
  | "not_settled" // vet402 sent a payment; the seller did not settle it (and did not deliver)
  | "settled_error_status" // settled, then the seller answered with a non-2xx status
  | "settled_empty_body" // settled, 2xx, but the body was empty
  | "unconfirmed_server_error" // seller answered 5xx and no settlement could be confirmed either way
  | "not_payable" // listed in a catalog but not buyable (no 402, no usable accept, unreachable)
  | "payto_changed" // vet402 refused because the recipient differed from the one recorded earlier
  | "vet402_skipped"; // vet402's own policy (price cap, unfillable input, duplicate) — not the seller's doing

export const TRIED_CATEGORIES: ReadonlySet<ReasonCategory> = new Set<ReasonCategory>([
  "delivered",
  "not_settled",
  "settled_error_status",
  "settled_empty_body",
  "unconfirmed_server_error",
]);

/**
 * Who a tried-but-not-delivered purchase is attributed to. Only "seller" counts toward the grade.
 * The mapping from reason to fault lives in ./classify.ts (FAULT_RULES) and in README.md.
 */
export type Fault = "seller" | "vet402_or_facilitator" | "unknown";

export interface Attempt {
  chain: Chain;
  /** Which input file the row came from, e.g. "algorand/census-2026-09-27". */
  source: string;
  /** Lower-cased hostname of the resource. */
  host: string;
  /** Catalog service id when the rail has one (Tempo / Mercator), else null. */
  service: string | null;
  url: string;
  /** Recipient the seller asked vet402 to pay (as the seller presented it at attempt time). */
  payTo: string | null;
  /** When the payTo differs from an earlier recorded one: the earlier value. */
  expectedPayTo: string | null;
  /** ISO timestamp of the attempt. */
  at: string;
  tried: boolean;
  /** true = settlement confirmed, false = confirmed not settled, null = unknown. */
  settled: boolean | null;
  /**
   * A remeasure row whose answer was never recorded (outcome unknown), but whose payment the post-run chain check
   * found on chain. `settled` stays null so no fault rule reads it as the seller's (the run timed out on vet402's
   * side); only the rebuy count reads this. Absent everywhere else.
   */
  paidOnChain?: true;
  delivered: boolean;
  category: ReasonCategory;
  /** The runner's own reason string, verbatim. */
  rawReason: string;
  /** The runner's detail text (may quote the seller's answer), cut to 200 chars. Seller-controlled. */
  detail: string | null;
  tx: string | null;
  priceUsdc: string | null;
  /** HTTP status of the paid request (or of the answer that ended it), when the runner recorded one. */
  httpStatus: number | null;
  /**
   * Separate from delivery: did the answer match what the seller declared (keys / schema)?
   * null = not checked (the runner did not check, the seller declared nothing, or nothing was delivered).
   */
  declaredMatch: boolean | null;
  /** false when the runner recorded no body size or text for this chain (Tempo), so the body test could not run. */
  bodyChecked: boolean;
  /** ERC-8004 feedback tx vet402 wrote for this purchase (Base only). */
  feedbackTx: string | null;
  /**
   * Tempo only: why the request vet402 sent was vet402's own mistake (src/tempo/answer.ts inputProblem), null when
   * it cannot be told, absent when not checked. Read by the paid_then_402_placeholder and paid_then_4xx_vet402_input rules in ./classify.ts.
   */
  inputProblem?: InputProblem | null;
}
