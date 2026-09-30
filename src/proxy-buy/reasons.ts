/**
 * What proxy buy says about a failure, in answers and in public records: a fixed reason code, and a
 * detail only where the detail is about the seller's own offer (prices, addresses). Error messages from
 * RPC clients, facilitators and mppx can carry an RPC URL (often with an API key in it) or a request
 * body, so they never reach an answer or a record.
 */

/** Refusal codes whose detail is safe to show: it only restates values from the seller's 402 or vet402's own counters. */
const SAFE_DETAIL = new Set([
  "price_raised",
  "price_over_cap",
  "payto_mismatch",
  "recipient_mismatch",
  "scheme_mismatch",
  "network_mismatch",
  "mint_mismatch",
  "currency_mismatch",
  "chain_mismatch",
  "testnet_chain",
  "bad_amount",
  "splits_refused",
  "pull_unsupported",
  "expired",
  "total_cap_reached",
  "purchase_count_reached",
  "daily_cap_reached",
  "insufficient_balance",
  "chain_spend_exceeds_ledger",
  "already_bought",
  "payto_off_curve",
  "self_dealing",
]);

/** Remove anything URL-shaped and anything that looks like a credential, and bound the length. */
export function redact(s: string, max = 160): string {
  return s
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "<url>")
    .replace(/\b(api[-_]?key|apikey|token|secret|key|auth(orization)?)\s*[=:]\s*[^\s,;"']+/gi, "$1=<redacted>")
    .slice(0, max);
}

/** A refusal from the census payment code (src/guard.ts, src/tempo/guard.ts), as proxy buy reports it. */
export function refusalReason(r: { refused: string; detail: string }): string {
  return SAFE_DETAIL.has(r.refused) ? `${r.refused}: ${redact(r.detail)}` : r.refused;
}
