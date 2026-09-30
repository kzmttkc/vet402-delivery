/**
 * x402-observation/v0: vet402's signed record of one paid call, seen from the buyer's side.
 *
 * Names are borrowed, not invented:
 *  - payment fields: x402 PaymentRequirements / Receipt (`network` CAIP-2, `payTo`, `asset`, `amount`,
 *    `payer`, `transaction`, `resourceUrl`, `issuedAt`)
 *  - response hash: x402 PR #3186 (`responseHash`, `responseHashAlg`, `responseHashEncoding`)
 *  - request hash: x402 issue #2833 (`request { method, url_hash, params_hash, ts }`)
 *  - seller receipt: the x402 Receipt, embedded as received (`{ format, payload, signature }`)
 * The only new thing is the observer's wrapper (type, observer, verdict, scope, anchor).
 *
 * Facts only. No score, grade or rating word. No response body; hashes only.
 */

export const OBSERVATION_TYPE = "x402-observation" as const;
export const OBSERVATION_VERSION = 0 as const;

/** The four verdict words. Fixed; nothing else is ever emitted. */
export const VERDICTS = ["DELIVERED", "MISMATCH", "NOT_DELIVERED", "UNCLEAR"] as const;
export type VerdictCode = (typeof VERDICTS)[number];

export interface Checks {
  /** The payment transaction was found confirmed on chain, moving `amount` of `asset` from payer to payTo. */
  paymentSettled: boolean;
  /** HTTP status of the paid response; null = no response before the timeout. */
  httpStatus: number | null;
  /** null = not recorded by the run that made this observation. */
  bodyNonEmpty: boolean | null;
  /** null = the seller declared no format, or it was not checked. */
  declaredFormatMatched: boolean | null;
  /** null = no seller receipt came back (always null when nothing was delivered). */
  sellerReceiptValid: boolean | null;
  /** null = no seller responseHash to compare, or vet402 has no responseHash of its own. */
  responseHashMatchesSeller: boolean | null;
}

export interface Verdict {
  code: VerdictCode;
  /** One factual line. Which check decided the verdict. */
  reason: string;
  /** For UNCLEAR only: when it will be looked at again. */
  recheck: string | null;
  checks: Checks;
}

export interface Payment {
  /** CAIP-2. */
  network: string;
  /** How the payment was made: "x402-exact" (x402 v1/v2 exact scheme) or "mpp-charge" (Tempo MPP). */
  scheme: "x402-exact" | "mpp-charge";
  transaction: string;
  payer: string;
  payTo: string;
  asset: string;
  /** Atomic units, decimal string. */
  amount: string;
  /** Token decimals of `asset`, for display. */
  decimals: number;
  /** Human symbol of `asset`, for display. */
  assetSymbol: string;
  /** Block time of the settlement, ISO 8601; null = not recorded. */
  settledAt: string | null;
}

export interface Request {
  method: string | null;
  /** 0x sha256 of the resource URL without query or fragment (the same string as `resourceUrl`). */
  url_hash: string;
  /**
   * 0x sha256(salt || canonical params) of the query string and request body.
   * Salted so that small input spaces cannot be brute-forced back from a published record. The salt is
   * held by vet402 and disclosed to the parties in a dispute. null = params not recorded.
   */
  params_hash: string | null;
  params_salted: boolean;
  /** When the request was sent (ISO 8601); null = not recorded. */
  ts: string | null;
}

export interface Response {
  /** null = no response before the timeout. */
  status: number | null;
  /** #3186 names. null = not computed; the reason is in `responseHashNote`. */
  responseHash: string | null;
  responseHashAlg: "sha256" | null;
  responseHashEncoding: "raw" | "jcs" | null;
  responseHashNote: string | null;
  contentType: string | null;
  bytes: number | null;
  /** When the response was received (ISO 8601); null = not recorded. */
  receivedAt: string | null;
  latencyMs: number | null;
}

/** An x402 artifact exactly as received: `{ format, payload, signature }` (x402 offer-and-receipt §3.1). */
export interface SignedArtifact {
  format: "eip712" | "jws";
  payload?: Record<string, unknown>;
  signature: string;
}

export interface Scope {
  proves: string[];
  doesNotProve: string[];
  /** Where the observation was made from. Always stated. */
  vantage: string;
  text: string;
}

export interface Anchor {
  /** "pending" = root computed, not yet written on chain. "anchored" = `tx` holds the root. */
  status: "pending" | "anchored";
  /** UTC day the root covers (YYYY-MM-DD). One root per day at most. */
  day: string;
  network: string;
  tx: string | null;
  root: string;
  leafIndex: number;
  proof: string[];
  /** Number of leaves and the observer sequence range the root covers. */
  count: number;
  sequenceRange: [number, number];
  /** The signing address in force for this root, so later key rotation cannot rewrite history. */
  observerAddress: string;
  anchoredAt: string | null;
}

export interface Correction {
  at: string;
  kind: "seller-receipt" | "seller-note" | "recheck" | "retraction";
  /** Who wrote it. Seller notes are shown as the seller's statement, not checked by vet402. */
  by: string;
  text: string;
  ref: string | null;
}

export interface Observation {
  type: typeof OBSERVATION_TYPE;
  version: typeof OBSERVATION_VERSION;
  id: string;
  observer: {
    /** did:web key id. */
    id: string;
    /** EVM address of the observation signing key (separate from any payment key). */
    address: string;
    /** Per-observer running number. Gaps in a day's range are visible from the anchor. */
    sequence: number;
  };
  /** Unix seconds when vet402 signed this record. */
  issuedAt: number;
  verdict: Verdict;
  resourceUrl: string;
  payment: Payment;
  request: Request;
  response: Response;
  offer: SignedArtifact | null;
  sellerReceipt: SignedArtifact | null;
  scope: Scope;
  /** What the run that made this observation did not record. Stated, never filled in. */
  notRecorded: string[];
  /** Where the facts came from (dataset and row), for vet402's own audit trail. */
  source: { dataset: string; row: string };
  contact: string;
  /** Not signed: added after signing. */
  anchor: Anchor | null;
  /** Not signed: append-only, each entry separately attributable. */
  corrections: Correction[];
  signature: { format: "eip712"; signature: string } | null;
}

/** The part of an Observation covered by the signature (and so by the Merkle leaf). */
export type SignedBody = Omit<Observation, "anchor" | "corrections" | "signature">;

export const UNSIGNED_FIELDS = ["anchor", "corrections", "signature"] as const;
