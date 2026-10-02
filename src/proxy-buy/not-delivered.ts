/**
 * The refund for an answer the seller did not deliver after vet402 paid it (Solana; owner approval 2026-10-02).
 *
 * Refunded only when vet402's own payment to the seller is found landed on chain and the seller's answer is a
 * seller-side failure in src/rank/classify.ts (settled_not_delivered: 402 again; paid_not_delivered: 5xx, no
 * answer, a status that is neither 2xx nor 4xx, a 2xx with an empty body), less what cannot be told apart from a
 * slow seller or vet402's own side: a wait that ran out (timeout), a connection error that is not the seller
 * refusing or closing it, a body that could not be read. Any other 4xx is not the seller's for certain
 * (paid_then_4xx: vet402 or the agent built the request), so it is not refunded either. When in doubt, no refund.
 *
 * Caps and abuse checks are in Store.ndRefundClaim (one database transaction under an advisory lock).
 */
import type { NotDeliveredRefundCaps } from "./config.js";

/** What a failed fetch of the paid answer says about the seller. */
export type FetchFailure = "timeout" | "closed" | "unknown";

/** Error codes that mean the seller's side refused or closed the connection (no answer at all). */
const CLOSED_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE", "UND_ERR_SOCKET", "UND_ERR_CLOSED"]);
const TIMEOUT_CODES = /TIMEOUT|ETIMEDOUT|ESOCKETTIMEDOUT/i;

/**
 * Classify a thrown fetch error by its name and code and those of its causes. A timeout of any kind (the abort
 * signal, a connect, header or body timeout) is "timeout"; the seller refusing or resetting the connection is
 * "closed"; anything else (a DNS failure, an error with no code) is "unknown".
 */
export function fetchFailureKind(e: unknown): FetchFailure {
  let closed = false;
  for (let x: unknown = e, i = 0; x && typeof x === "object" && i < 6; x = (x as { cause?: unknown }).cause, i++) {
    const name = String((x as { name?: unknown }).name ?? "");
    const code = String((x as { code?: unknown }).code ?? "");
    const message = String((x as { message?: unknown }).message ?? "");
    if (name === "TimeoutError" || name === "AbortError" || TIMEOUT_CODES.test(code) || /timed? ?out/i.test(message)) return "timeout";
    if (CLOSED_CODES.has(code)) closed = true;
  }
  return closed ? "closed" : "unknown";
}

export type NotDeliveredFault = { refundable: true; basis: string } | { refundable: false; why: string };

/**
 * Whether an answer that did not deliver (vet402's payment to the seller landed) is the seller's failure, by the
 * rules above. `fetchFailure`: set when no HTTP answer came at all. `bodyError`: an HTTP status came but its body
 * could not be read. `truncated` answers (above the forward limit) are never refunded here.
 */
export function notDeliveredFault(a: { status: number | null; bodyError: boolean; truncated: boolean; fetchFailure: FetchFailure | null }): NotDeliveredFault {
  if (a.truncated) return { refundable: false, why: "answer_too_large" };
  const s = a.status;
  if (s === null) {
    if (a.fetchFailure === "closed") return { refundable: true, basis: "no_answer_connection_closed" };
    return { refundable: false, why: a.fetchFailure === "timeout" ? "no_answer_within_wait" : "no_answer_cause_unknown" };
  }
  if (s === 402) return { refundable: true, basis: "http_402_after_payment" };
  if (s >= 400 && s <= 499) return { refundable: false, why: `http_${s}_not_seller_for_certain` };
  if (s >= 500 && s <= 599) return { refundable: true, basis: `http_${s}` };
  if (s >= 200 && s <= 299) {
    if (a.bodyError) return { refundable: false, why: "body_unreadable" };
    return { refundable: true, basis: `http_${s}_empty_body` };
  }
  return { refundable: true, basis: `http_${s}_not_an_answer` };
}

/** The refund for undelivered answers on one chain: its caps, and when a seller last delivered (data/). */
export interface NotDeliveredRefund extends NotDeliveredRefundCaps {
  /** ISO time of the latest settled vet402 purchase from (host, payTo) that delivered, or null (allowlist.ts). */
  lastDeliveredAt: (host: string, payTo: string) => string | null;
}

/** Reasons Store.ndRefundClaim gives for not refunding (public: the record and the answer show them). */
export const ND_REFUSALS = {
  payto_is_buyer: "the seller's payTo is the paying address",
  buyer_daily_limit: "this paying address already had a refund for an undelivered answer this UTC day",
  seller_on_hold: "a refund for an undelivered answer from this seller is not yet followed by a delivered vet402 purchase",
  cap_daily: "the cap for refunds of undelivered answers for this UTC day would be passed",
  cap_monthly: "the cap for refunds of undelivered answers for this UTC month would be passed",
} as const;
export type NdRefusal = keyof typeof ND_REFUSALS;
