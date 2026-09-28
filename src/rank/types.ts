/**
 * Common schema for one vet402 purchase attempt, whatever the chain.
 *
 * Every row comes from a run where vet402 paid (or offered to pay) from its own wallet.
 * Nothing a seller reports about itself (call counts, payer counts, reviews) enters this schema.
 */

export type Chain = "algorand" | "solana" | "tempo" | "base";

/**
 * Why an attempt ended the way it did.
 * The first five are "tried": vet402 committed to pay, so the seller had a fair chance to deliver.
 * The last three are "not tried": they are recorded but never count toward a seller's rate.
 */
export type ReasonCategory =
  | "delivered" // paid, settled, and the answer passed the chain runner's delivery check
  | "not_settled" // vet402 sent a payment; the seller did not settle it (and did not deliver)
  | "settled_error_status" // settled, then the seller answered with a non-2xx status
  | "settled_bad_content" // settled, 2xx, but the answer did not match what the seller declared
  | "unconfirmed_server_error" // seller answered 5xx and no settlement could be confirmed either way
  | "not_payable" // listed in a catalog but not buyable (no 402, no usable accept, unreachable)
  | "payto_changed" // vet402 refused because the recipient differed from the one recorded earlier
  | "vet402_skipped"; // vet402's own policy (price cap, unfillable input, duplicate) — not the seller's doing

export const TRIED_CATEGORIES: ReadonlySet<ReasonCategory> = new Set<ReasonCategory>([
  "delivered",
  "not_settled",
  "settled_error_status",
  "settled_bad_content",
  "unconfirmed_server_error",
]);

/**
 * What "delivered" meant in the run that produced the row. Each chain runner judged delivery itself;
 * this module does not re-judge.
 *   declared_keys: 2xx JSON whose keys match what the seller declared (when it declared any)
 *   http_2xx:      settled, then any 2xx answer (Base also requires a non-empty body)
 */
export type DeliveryCheck = "declared_keys" | "http_2xx";

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
  delivered: boolean;
  category: ReasonCategory;
  /** The runner's own reason string, verbatim. */
  rawReason: string;
  /** The runner's detail text (may quote the seller's answer), cut to 200 chars. Seller-controlled. */
  detail: string | null;
  tx: string | null;
  priceUsdc: string | null;
  deliveryCheck: DeliveryCheck;
  /** ERC-8004 feedback tx vet402 wrote for this purchase (Base only). */
  feedbackTx: string | null;
}
