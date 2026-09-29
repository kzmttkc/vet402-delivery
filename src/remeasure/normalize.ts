/**
 * Remeasure result files (results/remeasure/<chain>-YYYY-MM-DD.json) -> rank Attempt rows.
 *
 * Same rules as src/rank/normalize.ts: delivered = settled, then 2xx with a non-empty body; an unknown
 * outcome or refusal word throws, so a new failure mode cannot be silently counted or dropped.
 * Each row keeps its own time, so a remeasure day is a different UTC day for the rank's MIN_DAYS.
 */
import { TRIED_CATEGORIES, type Attempt, type ReasonCategory } from "../rank/types.js";
import type { RemeasureRow, ResultFile } from "./results.js";

/** Not buyable right now: the seller's side of "not tried". */
const NOT_PAYABLE = new Set([
  "no_solana_accept",
  "no_tempo_charge",
  "scheme_mismatch",
  "network_mismatch",
  "mint_mismatch",
  "bad_amount",
  "payto_invalid",
  "payto_off_curve",
  "self_dealing",
  "fee_payer_missing",
  "fee_payer_is_self",
  "request_undecodable",
  "testnet_chain",
  "chain_mismatch",
  "currency_mismatch",
  "recipient_invalid",
  "recipient_not_allowlisted",
  "splits_refused",
  "pull_unsupported",
  "expired",
]);
/** vet402's own policy or state: never the seller's doing. */
const VET402_SKIPPED = new Set([
  "price_over_cap",
  "price_raised",
  "total_cap_reached",
  "purchase_count_reached",
  "already_bought",
  "ledger_unreadable",
  "tx_check_failed",
  "chain_spend_exceeds_ledger",
  "insufficient_balance",
]);

function refusalCategory(reason: string, where: string): ReasonCategory {
  if (reason === "pay_to_changed") return "payto_changed";
  if (NOT_PAYABLE.has(reason)) return "not_payable";
  if (VET402_SKIPPED.has(reason)) return "vet402_skipped";
  throw new Error(`${where}: unknown remeasure refusal "${reason}"`);
}

const is2xx = (s: number | null) => s !== null && s >= 200 && s <= 299;
const cut = (v: string | null) => (v === null ? null : v.length > 200 ? `${v.slice(0, 200)}…` : v);

function rowToAttempt(r: RemeasureRow, source: string, where: string): Attempt {
  if (r.chain !== "solana" && r.chain !== "tempo") throw new Error(`${where}: unknown chain "${String(r.chain)}"`);
  if (typeof r.at !== "string" || Number.isNaN(Date.parse(r.at))) throw new Error(`${where}: bad at`);
  if (typeof r.host !== "string" || typeof r.url !== "string" || typeof r.expectedPayTo !== "string") throw new Error(`${where}: missing host/url/expectedPayTo`);
  let category: ReasonCategory;
  let settled: boolean | null = null;
  let rawReason: string;
  let bodyChecked = true;
  if (r.outcome === "sent") {
    settled = r.settled;
    rawReason = `sent/http ${r.httpStatus ?? "?"}`;
    if (settled === true) {
      if (r.chain === "solana") {
        // payOne already judged the body: delivered = 2xx and text.trim() not empty.
        category = r.delivered === true ? "delivered" : is2xx(r.httpStatus) ? "settled_empty_body" : "settled_error_status";
      } else {
        bodyChecked = r.bodyBytes !== null;
        category = !is2xx(r.httpStatus) ? "settled_error_status" : r.bodyBytes === 0 ? "settled_empty_body" : "delivered";
      }
    } else if (settled === false) category = "not_settled";
    else category = "unconfirmed_server_error";
  } else if (r.outcome === "unknown") {
    // A credential left the process and the outcome was not recorded (Tempo).
    rawReason = "unknown";
    category = "unconfirmed_server_error";
  } else if (r.outcome === "refused" || r.outcome === "not_sent") {
    rawReason = r.reason;
    category = refusalCategory(r.reason, where);
  } else {
    throw new Error(`${where}: outcome "${String(r.outcome)}" does not belong in a result file`);
  }
  return {
    chain: r.chain,
    source,
    host: r.host.toLowerCase(),
    service: r.service,
    url: r.url,
    payTo: r.payTo,
    expectedPayTo: category === "payto_changed" ? r.expectedPayTo : null,
    at: r.at,
    tried: TRIED_CATEGORIES.has(category),
    settled,
    delivered: category === "delivered",
    category,
    rawReason,
    detail: cut(r.detail),
    tx: r.tx,
    priceUsdc: r.priceUsdc,
    httpStatus: r.httpStatus,
    declaredMatch: null,
    bodyChecked,
    feedbackTx: null,
  };
}

export function normalizeRemeasure(json: unknown, source: string): Attempt[] {
  const f = json as ResultFile;
  if (!f || f.kind !== "vet402-remeasure" || f.version !== 1 || !Array.isArray(f.rows)) throw new Error(`${source}: expected a vet402-remeasure result file`);
  return f.rows.map((r, i) => {
    const where = `${source}.rows[${i}]`;
    if (r.chain !== f.chain) throw new Error(`${where}: chain ${r.chain} in a ${f.chain} file`);
    return rowToAttempt(r, source, where);
  });
}
