/**
 * Who a failed purchase is attributed to: the seller, vet402 / the facilitator, or can't tell.
 *
 * Only "seller" failures count toward a seller's grade. The other two are shown as counts and never
 * lower anyone's grade. Rules are checked top to bottom; the first match wins. The same table is printed
 * on the method page and in src/rank/README.md (a test keeps the README in step with this list).
 */
import type { Attempt, Fault } from "./types.js";

export interface FaultRule {
  id: string;
  fault: Fault;
  /** One line a seller or a buyer can read. */
  when: string;
  match: (a: Attempt, text: string) => boolean;
}

const status = (a: Attempt, text: string): number | null => {
  if (a.httpStatus !== null) return a.httpStatus;
  const m = /\bstatus (\d{3})\b/.exec(text) ?? /\bhttp (\d{3})\b/.exec(text);
  return m ? Number(m[1]) : null;
};

/**
 * 429 and subcent_quota_exceeded: in the 2026-09-27/28 Algorand runs vet402 bought ~500 endpoints of
 * one seller (agent402.tools) within 30–47 minutes. A buyer making one purchase would not send that burst.
 * Caveat, checked on the data: subcent_quota_exceeded already came back on the first sub-cent purchase of
 * each day, so it may be a per-payer quota that outlives one run. If purchases paced by MEASURE_* in
 * src/constants.ts still get 429 or subcent_quota_exceeded, these two rules move to the seller side.
 */
export const FAULT_RULES: readonly FaultRule[] = [
  {
    id: "settled_not_delivered",
    fault: "seller",
    when: "Paid on chain, answered 402, delivered nothing: vet402's payment settled on chain (a facilitator error such as \"already in ledger\" included), then the seller answered 402. The buyer paid and received nothing.",
    match: (a, t) => a.settled === true && status(a, t) === 402,
  },
  {
    // The same line as the signed delivery records (src/receipt/build.ts: UNCLEAR, not NOT_DELIVERED).
    id: "paid_then_4xx",
    fault: "unknown",
    when: "vet402's payment settled, then the seller answered 4xx other than 402 (400, 401, 404, 422, 429 …). vet402 built the request from the seller's listing, so a fault on vet402's side is not ruled out. Shown as a count, as in the signed records (UNCLEAR).",
    match: (a, t) => {
      const s = status(a, t);
      return a.settled === true && s !== null && s >= 400 && s <= 499 && s !== 402;
    },
  },
  {
    id: "paid_not_delivered",
    fault: "seller",
    when: "vet402's payment settled, then the seller answered 5xx, nothing, another non-2xx that is not a 4xx, or 2xx with an empty body.",
    match: (a) => a.settled === true,
  },
  {
    id: "rate_limited_429",
    fault: "vet402_or_facilitator",
    when: "HTTP 429. vet402 bought many items from one seller within minutes; one ordinary purchase would not hit the limit.",
    match: (a, t) => status(a, t) === 429,
  },
  {
    id: "subcent_quota",
    fault: "vet402_or_facilitator",
    when: "subcent_quota_exceeded: vet402's many sub-cent purchases used up the per-payer quota.",
    match: (_a, t) => /subcent_quota_exceeded/i.test(t),
  },
  {
    id: "payment_tx_rejected",
    fault: "vet402_or_facilitator",
    when: "The payment transaction vet402 built was rejected before settling: simulation failed, BlockhashNotFound, already in ledger, validity window passed, facilitator unavailable.",
    match: (_a, t) =>
      /simulation[_ ]?(failed|error)|BlockhashNotFound|already in (the )?ledger|txn dead|submitted but not confirmed|facilitator verify unavailable|invalid_exact_svm/i.test(t),
  },
  {
    id: "server_error_5xx",
    fault: "seller",
    when: "The seller's server answered 5xx and no settlement happened.",
    match: (a, t) => {
      const s = status(a, t);
      return s !== null && s >= 500 && s <= 599;
    },
  },
  {
    id: "timeout",
    fault: "unknown",
    when: "vet402's request timed out. A slow seller and a short vet402 timeout look the same.",
    match: (_a, t) => /timeout|timed out|aborted/i.test(t),
  },
  {
    id: "request_rejected_4xx",
    fault: "unknown",
    when: "The seller answered 4xx (400, 401, 404, 422 …) before any payment settled. vet402 made the input, so the cause cannot be told apart.",
    match: (a, t) => {
      const s = status(a, t);
      return s !== null && s >= 400 && s <= 499 && s !== 402;
    },
  },
  {
    id: "payment_not_accepted_402",
    fault: "unknown",
    when: "The seller answered 402 again after vet402 paid, with no reason that points to either side.",
    match: (a, t) => status(a, t) === 402,
  },
  {
    id: "answer_without_settlement",
    fault: "unknown",
    when: "The seller answered 2xx but no settlement of vet402's payment could be found.",
    match: (a, t) => {
      const s = status(a, t);
      return s !== null && s >= 200 && s <= 299;
    },
  },
  {
    id: "unclassified",
    fault: "unknown",
    when: "None of the above. Counted here so a new failure mode is visible and never lowers a grade.",
    match: () => true,
  },
];

/**
 * Not yet in FAULT_RULES (the published method): a paid 4xx (not 402) where the request vet402 sent was its own
 * mistake (Attempt.inputProblem, src/tempo/answer.ts): a placeholder from the catalog in place of an input
 * (`{"ip":"string"}`), a parameter the catalog marks required left out, or no cataloged input while the seller's
 * answer says the input was wrong. Anything else stays paid_then_4xx (can't tell).
 * FAULT_RULES_NEXT is FAULT_RULES with this rule just before paid_then_4xx. Publishing it means: FAULT_RULES
 * takes this list, src/rank/README.md gets the row, and site/ is built again (test/site.test.ts).
 */
export const PAID_THEN_4XX_VET402_INPUT: FaultRule = {
  id: "paid_then_4xx_vet402_input",
  fault: "vet402_or_facilitator",
  when: "vet402's payment settled, then the seller answered 4xx other than 402, and the request vet402 sent was wrong: a placeholder from the catalog in place of a value (such as \"string\"), a parameter the catalog marks required left out, or no input while the seller's answer says the input was wrong.",
  match: (a, t) => {
    const s = status(a, t);
    return a.settled === true && s !== null && s >= 400 && s <= 499 && s !== 402 && (a.inputProblem ?? null) !== null;
  },
};

export const FAULT_RULES_NEXT: readonly FaultRule[] = (() => {
  const i = FAULT_RULES.findIndex((r) => r.id === "paid_then_4xx");
  if (i < 0) throw new Error("FAULT_RULES has no paid_then_4xx");
  return [...FAULT_RULES.slice(0, i), PAID_THEN_4XX_VET402_INPUT, ...FAULT_RULES.slice(i)];
})();

export interface Classification {
  fault: Fault;
  rule: string;
}

/** Classify a tried, not-delivered attempt. Delivered or not-tried rows are a caller error. */
export function classifyFailure(a: Attempt, rules: readonly FaultRule[] = FAULT_RULES): Classification {
  if (!a.tried || a.delivered) throw new Error(`classifyFailure: only tried, not delivered rows (${a.category})`);
  const text = `${a.rawReason} ${a.detail ?? ""}`;
  for (const r of rules) if (r.match(a, text)) return { fault: r.fault, rule: r.id };
  throw new Error("unreachable: FAULT_RULES ends with a catch-all");
}

export const FAULT_LABEL: Record<Fault, string> = {
  seller: "seller side",
  vet402_or_facilitator: "vet402 or facilitator side",
  unknown: "can't tell",
};

export function ruleById(id: string): FaultRule | undefined {
  return FAULT_RULES.find((r) => r.id === id);
}
