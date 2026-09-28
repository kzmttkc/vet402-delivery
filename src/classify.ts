/**
 * Reason category for each census row.
 *
 * `failureMode` and `displayClass` are ported from vet402-algorand (src/fix-first.ts and
 * src/board.ts) with the same group keys, so the Solana census and the Algorand board group
 * the same way. `rowFromRecord` is the only Solana-specific part: it turns gate 1's
 * PurchaseRecord (and its guard refusals) into the reason words those functions read.
 */
import type { PurchaseRecord } from "./pay.js";

export type BoardVerdict = "ALLOW" | "REFUSE" | "SKIPPED";

/** The fields the Algorand classifier reads. */
export interface ClassInput {
  verdict: BoardVerdict;
  reason: string;
  detail?: string;
  paid?: boolean;
  /** Paid response status line, e.g. "503 text/html". */
  delivery?: string;
}

export type DisplayClass = "DELIVERED" | "MISMATCH" | "UNREACHABLE" | "UNCLEAR";

export type FixKey =
  | "gone"
  | "unreadable_402"
  | "example_rejected"
  | "example_placeholder"
  | "missing_keys"
  | "not_json"
  | "wrong_method"
  | "free_200"
  | "no_accept"
  | "auth"
  | "down"
  | "server_error_paid"
  | "no_receipt"
  | "rate_limited"
  | "timeout"
  | "facilitator_quota"
  | "payment_refused"
  | "vet402_limit"
  | "other";

export const FIX_KEYS: readonly FixKey[] = [
  "gone",
  "unreadable_402",
  "example_rejected",
  "example_placeholder",
  "missing_keys",
  "not_json",
  "wrong_method",
  "free_200",
  "no_accept",
  "auth",
  "down",
  "server_error_paid",
  "no_receipt",
  "rate_limited",
  "timeout",
  "facilitator_quota",
  "payment_refused",
  "vet402_limit",
  "other",
];

// ---------------- vet402-algorand board.ts ----------------

const UNCLEAR_LOOK_STATUS = new Set([400, 403, 408, 429]);

export function notSent(r: Pick<ClassInput, "verdict" | "reason">): boolean {
  return r.verdict === "REFUSE" && r.reason === "placeholder_unfillable";
}

export function displayClass(r: Pick<ClassInput, "verdict" | "reason" | "detail" | "paid">): DisplayClass {
  if (r.verdict === "ALLOW") return "DELIVERED";
  if (r.verdict !== "REFUSE") return "UNCLEAR";
  if (r.paid) return "MISMATCH";
  if (r.reason === "not_x402") {
    const m = /^expected 402, got (\d{3})\b/.exec(r.detail ?? "");
    if (!m) return "UNCLEAR";
    const code = Number(m[1]);
    if (UNCLEAR_LOOK_STATUS.has(code) || (code >= 300 && code < 400)) return "UNCLEAR";
    return "UNREACHABLE";
  }
  if (r.reason === "invalid_target" && /does not resolve/.test(r.detail ?? "")) return "UNREACHABLE";
  return "UNCLEAR";
}

// ---------------- vet402-algorand fix-first.ts ----------------

/**
 * vet402's own refusals. The Algorand set, plus the Solana guard words that also mean
 * "vet402 did not buy because of its own limits" (caps, one per host, read-back refusal).
 */
const VET402_LIMIT_REASONS = new Set([
  "price_over_cap",
  "daily_cap_reached",
  "cap_check_unavailable",
  "self_dealing",
  "daily_cap",
  // Solana census additions
  "total_cap_reached",
  "purchase_count_reached",
  "already_bought",
  "fee_payer_is_self",
  "ledger_unreadable",
  "tx_check_failed",
  "same_payto",
]);

function statusIn(s: string | undefined, re: RegExp): number | undefined {
  const m = re.exec(s ?? "");
  return m ? Number(m[1]) : undefined;
}

function byStatus(code: number | undefined, paid: boolean): FixKey {
  if (code === undefined) return "other";
  if (code === 400 || code === 422) return "example_rejected";
  if (code === 404) return paid ? "example_rejected" : "gone";
  if (code === 410) return "gone";
  if (code === 401 || code === 403) return "auth";
  if (code === 405) return "wrong_method";
  if (code === 408) return "timeout";
  if (code === 429) return "rate_limited";
  if (code >= 500 && code < 600) return paid ? "server_error_paid" : "down";
  return "other";
}

const TIMEOUT = /aborted due to timeout|timed out|timeout|fetch failed|ECONNRESET|ECONNREFUSED|socket hang up|ENOTFOUND/i;

/** The failure mode of one row that did not deliver (DELIVERED rows return null). */
export function failureMode(r: ClassInput): FixKey | null {
  if (displayClass(r) === "DELIVERED") return null;
  if (r.verdict === "SKIPPED") return "vet402_limit";
  if (notSent(r)) return "example_placeholder";
  if (VET402_LIMIT_REASONS.has(r.reason)) return "vet402_limit";
  switch (r.reason) {
    case "not_x402": {
      if (/without parseable x402 payment requirements/.test(r.detail ?? "")) return "unreadable_402";
      const code = statusIn(r.detail, /^expected 402, got (\d{3})\b/);
      if (code !== undefined && code >= 200 && code < 300) return "free_200";
      return byStatus(code, false);
    }
    case "requirements_body_only":
      return "unreadable_402";
    case "invalid_target":
      return /does not resolve/.test(r.detail ?? "") ? "gone" : "other";
    case "no_supported_accept":
      return "no_accept";
    case "payment_failed": {
      const d = r.detail ?? "";
      const code = statusIn(d, /^status (\d{3})\b/);
      if (code === undefined) return TIMEOUT.test(d) ? "timeout" : "other";
      if (code === 402) return /subcent_quota_exceeded/.test(d) ? "facilitator_quota" : "payment_refused";
      if (code >= 200 && code < 300) return "no_receipt";
      return byStatus(code, true);
    }
    case "probe_error":
      return TIMEOUT.test(r.detail ?? "") ? "timeout" : "other";
    case "http_error":
      return byStatus(statusIn(r.delivery, /^(\d{3})\b/), true);
    case "not_json":
    case "empty_body":
      return "not_json";
    case "delivery_missing_keys":
      return "missing_keys";
    default:
      return "other";
  }
}

// ---------------- Solana: gate 1 records -> the words above ----------------

/** Guard refusals that mean "the seller's 402 has no accept vet402 can pay on Solana". */
const NO_ACCEPT = new Set(["no_solana_accept", "scheme_mismatch", "network_mismatch", "mint_mismatch", "bad_amount", "payto_invalid", "payto_off_curve", "fee_payer_missing"]);
/** The live 402 no longer matches what was recorded at plan time (Algorand word: price_changed). */
const CHANGED = new Set(["payto_mismatch", "price_raised"]);

export type CensusStatus =
  | "delivered" // paid, settled on chain, response matches the declaration
  | "settled_not_delivered" // paid and settled, response did not match / not 2xx
  | "not_settled" // a signed payment was sent, no matching settlement found on chain
  | "refused" // vet402 did not pay (seller-side reason or vet402 guard)
  | "not_sent" // nothing was sent (example placeholder, or the read-back refused the tx)
  | "planned"; // dry run: every check passed, would pay

export interface Classified {
  status: CensusStatus;
  settled: boolean;
  delivered: boolean;
  /** Reason word (vet402-algorand verdict.ts vocabulary, plus the Solana guard words). */
  reason: string;
  detail: string;
  /** vet402-algorand fix-first group key; null when delivered or planned. */
  category: FixKey | null;
  displayClass: DisplayClass | null;
}

function classified(status: CensusStatus, input: ClassInput, settled = false, delivered = false): Classified {
  return {
    status,
    settled,
    delivered,
    reason: input.reason,
    detail: (input.detail ?? "").slice(0, 300),
    category: failureMode(input),
    displayClass: displayClass(input),
  };
}

/** The Algorand-style reason for a refusal that happened before anything was signed. */
export function refusalInput(rec: Pick<PurchaseRecord, "probe" | "refusal">): ClassInput {
  const p = rec.probe;
  const r = rec.refusal;
  if (p.status === null) return { verdict: "REFUSE", reason: "probe_error", detail: p.error ?? r?.detail ?? "no response" };
  if (p.status !== 402) return { verdict: "REFUSE", reason: "not_x402", detail: `expected 402, got ${p.status}` };
  if (p.error && /^unparseable 402/.test(p.error)) {
    return { verdict: "REFUSE", reason: "not_x402", detail: `402 without parseable x402 payment requirements (${p.error.slice(0, 150)})` };
  }
  const word = r?.refused ?? "other";
  if (NO_ACCEPT.has(word)) return { verdict: "REFUSE", reason: "no_supported_accept", detail: `${word}: ${r?.detail ?? ""}` };
  if (CHANGED.has(word)) return { verdict: "REFUSE", reason: "price_changed", detail: `${word}: ${r?.detail ?? ""}` };
  return { verdict: "REFUSE", reason: word, detail: r?.detail ?? "" };
}

/** Classify one gate-1 PurchaseRecord (from payOne, live or dry run). */
export function classifyRecord(rec: PurchaseRecord): Classified {
  if (rec.outcome === "refused") return classified("refused", refusalInput(rec));
  if (rec.outcome === "not_sent") {
    return classified("not_sent", { verdict: "REFUSE", reason: rec.refusal?.refused ?? "tx_check_failed", detail: rec.refusal?.detail ?? "" });
  }
  if (rec.outcome === "would_pay") {
    return { status: "planned", settled: false, delivered: false, reason: "would_pay", detail: "", category: null, displayClass: null };
  }
  // sent: money may have moved.
  const settled = rec.settled === true;
  const resp = rec.response;
  const sh = rec.settlementHeader;
  const status = resp?.status ?? null;
  const judged = rec.judgement;
  const delivered = rec.delivered === true;
  const outcome: CensusStatus = settled ? (delivered ? "delivered" : "settled_not_delivered") : "not_settled";
  if (status === null) {
    return classified(outcome, { verdict: "REFUSE", reason: "payment_failed", detail: resp?.error ?? "no response to the paid request", paid: settled }, settled, false);
  }
  if (status === 402) {
    const why = sh?.errorReason ?? (resp?.first300 ?? "").slice(0, 120);
    return classified(outcome, { verdict: "REFUSE", reason: "payment_failed", detail: `status 402, ${why}`, paid: settled }, settled, false);
  }
  if (status >= 200 && status < 300 && !settled) {
    return classified(outcome, { verdict: "REFUSE", reason: "payment_failed", detail: `status ${status}, no matching settlement found on chain`, paid: false }, false, delivered);
  }
  if (status < 200 || status >= 300) {
    return classified(outcome, { verdict: "REFUSE", reason: "http_error", detail: `status ${status}`, paid: true, delivery: `${status} ${resp?.contentType ?? ""}`.trim() }, settled, false);
  }
  // 2xx and settled: the delivery judgement decides.
  const reason = judged?.reason ?? (delivered ? "delivered" : "empty_body");
  const detail = judged?.missingKeys.length ? `missing: ${judged.missingKeys.join(", ")}` : (judged?.note ?? judged?.summary ?? "");
  return classified(outcome, { verdict: delivered ? "ALLOW" : "REFUSE", reason, detail, paid: true }, true, delivered);
}
