/**
 * Why did a paid purchase not come back with an answer? One cause per record, first matching rule wins.
 *
 *   facilitator   the seller's facilitator cannot settle this chain / scheme / amount
 *   seller_config the seller's own setup: took the money but sent no answer, settled to another address,
 *                 has no paid route, or advertises a chain its facilitator does not settle
 *   vet402        vet402's payment itself was wrong (balance, signature, validity window)
 *   unknown       nothing in the response says which
 *
 * Inputs are what vet402 saw: the seller's PAYMENT-RESPONSE (errorReason), the HTTP status and body, the
 * settlement read back on chain, and what the facilitators' own /supported pages say about the chain.
 * Pure: no network.
 */
import type { ChainBuyRecord } from "./evm-buy.js";

export type Cause = "delivered" | "not_paid" | "facilitator" | "seller_config" | "vet402" | "unknown";

export interface CauseResult {
  cause: Cause;
  rule: string;
  /** What the cause rests on: the seller's response, the chain, or only a facilitator's /supported page (a lead, not a finding). */
  evidence: "response" | "chain" | "supported_page" | "none";
  /** What the seller (or vet402) can change, in one sentence. Public text. */
  fix: string | null;
}

/** What a facilitator's /supported said for one chain (read 2026-09-30 04:47Z, no payment). */
export interface FacilitatorSupport {
  name: string;
  /** Hints that tie a 402 to this facilitator (lowercase substrings of the raw 402 or of the relayer address). */
  hints: readonly string[];
  /** CAIP-2 -> exact-scheme support. */
  exact: Record<string, { assetTransferMethod: "eip3009" | "permit2"; minAtomic: bigint | null }>;
}

export const FACILITATORS: readonly FacilitatorSupport[] = [
  {
    name: "Dexter",
    hints: ["dexter", "0x402feee072d655b85e08f1751af9ddbcd249521f"],
    // x402.dexter.cash/supported (v2 exact): extra.assetTransferMethod "permit2" on all three; minPaymentAmountAtomic
    // 7301 (4663), 6112 (42161), 1514 (8453). The floor is in USD and moves with the read.
    exact: {
      "eip155:4663": { assetTransferMethod: "permit2", minAtomic: 7301n },
      "eip155:42161": { assetTransferMethod: "permit2", minAtomic: 6112n },
      "eip155:8453": { assetTransferMethod: "permit2", minAtomic: 1514n },
    },
  },
  {
    name: "Ultravioleta DAO",
    hints: ["ultravioleta"],
    // facilitator.ultravioletadao.xyz/supported: eip155:4663 exact, USDG, no assetTransferMethod (EIP-3009).
    exact: { "eip155:4663": { assetTransferMethod: "eip3009", minAtomic: null } },
  },
];

/** Before paying: which facilitator a 402 points at, and whether vet402's EIP-3009 payment can settle there. */
export function predictFacilitator(raw402: string, network: string, amountAtomic: string): { facilitator: string | null; problem: string | null } {
  const low = raw402.toLowerCase();
  const f = FACILITATORS.find((x) => x.hints.some((h) => low.includes(h)));
  if (!f) return { facilitator: null, problem: null };
  const s = f.exact[network];
  if (!s) return { facilitator: f.name, problem: null }; // not in the table: no lead either way
  if (s.assetTransferMethod === "permit2") return { facilitator: f.name, problem: `${f.name}'s /supported lists Permit2 for exact on ${network}; the 402 does not ask for Permit2, so vet402 sends EIP-3009, which that facilitator may refuse` };
  if (s.minAtomic !== null && /^\d+$/.test(amountAtomic) && BigInt(amountAtomic) < s.minAtomic) return { facilitator: f.name, problem: `price ${amountAtomic} is below ${f.name}'s minimum ${s.minAtomic} on ${network}` };
  return { facilitator: f.name, problem: null };
}

const VET402_REASONS = [/insufficient_funds/, /invalid_exact_evm_payload_signature/, /authorization_valid_(before|after)/, /authorization_value/, /nonce/];
const FACILITATOR_REASONS = [/invalid_network/, /unsupported_network/, /unsupported_scheme/, /invalid_scheme/, /unexpected_(settle|verify)_error/, /facilitator/];
const SELLER_REASONS = [/recipient_mismatch/, /payto/, /invalid_payment_requirements/, /asset/];

const FACILITATOR_TEXT = /(unsupported|not supported|no facilitator|unknown) (network|chain)|(network|chain)[^.]{0,40}not supported|facilitator (error|unavailable|rejected)/i;
const VET402_TEXT = /insufficient (funds|balance)|invalid signature/i;

const FIX = {
  facilitator: "Use a facilitator whose /supported lists this chain for exact, or stop advertising the chain in the 402 until one does.",
  permit2: "Advertise extra.assetTransferMethod \"permit2\" in the 402 when the facilitator requires Permit2 on this chain, or use a facilitator that accepts EIP-3009 (transferWithAuthorization) for this token.",
  minimum: "Raise the price to the facilitator's minimum for this chain, or use a facilitator without one.",
  settledNoAnswer: "The payment settled; return the answer after settlement (or refund) instead of an error or an empty body.",
  settledElsewhere: "The settlement did not pay the payTo in the 402; make the 402 payTo the address the facilitator settles to.",
  routeMissing: "The paid request hit a route that does not exist; serve the resource at the URL the 402 names.",
  noReceipt: "Send the PAYMENT-RESPONSE header with the settlement tx so the buyer can read the payment back.",
  vet402: null,
};

/** Pure. `predicted` is the before-payment facilitator check for this record's 402, if any. */
export function classifyRecord(r: ChainBuyRecord, predicted?: { facilitator: string | null; problem: string | null }): CauseResult {
  if (r.outcome !== "sent") return { cause: "not_paid", rule: r.refusal ? `refused:${r.refusal.refused}` : r.outcome, evidence: "none", fix: null };
  if (r.delivered) return { cause: "delivered", rule: "delivered", evidence: "chain", fix: null };
  const reason = (r.settleResponse?.errorReason ?? "").toLowerCase();
  if (reason) {
    if (VET402_REASONS.some((x) => x.test(reason))) return { cause: "vet402", rule: `errorReason:${reason}`, evidence: "response", fix: FIX.vet402 };
    if (FACILITATOR_REASONS.some((x) => x.test(reason))) return { cause: "facilitator", rule: `errorReason:${reason}`, evidence: "response", fix: FIX.facilitator };
    if (SELLER_REASONS.some((x) => x.test(reason))) return { cause: "seller_config", rule: `errorReason:${reason}`, evidence: "response", fix: FIX.settledElsewhere };
  }
  const status = r.response?.status ?? null;
  const body = r.response?.first300 ?? "";
  if (r.settledOnChain) return { cause: "seller_config", rule: `settled_then_${status ?? "no_response"}`, evidence: "chain", fix: FIX.settledNoAnswer };
  if (r.settlementTx && r.settlementCheck?.startsWith("not verified")) return { cause: "seller_config", rule: "settlement_not_to_payto", evidence: "chain", fix: FIX.settledElsewhere };
  if (status === null) return { cause: "unknown", rule: "no_response", evidence: "none", fix: null };
  if (VET402_TEXT.test(body)) return { cause: "vet402", rule: "body:vet402", evidence: "response", fix: FIX.vet402 };
  if (FACILITATOR_TEXT.test(body)) return { cause: "facilitator", rule: "body:facilitator", evidence: "response", fix: FIX.facilitator };
  if (predicted?.problem) {
    const fix = /Permit2/.test(predicted.problem) ? FIX.permit2 : /minimum/.test(predicted.problem) ? FIX.minimum : FIX.facilitator;
    return { cause: "facilitator", rule: `supported:${predicted.facilitator}`, evidence: "supported_page", fix };
  }
  if (status === 404 || status === 405) return { cause: "seller_config", rule: `paid_${status}`, evidence: "response", fix: FIX.routeMissing };
  if (status >= 200 && status < 300 && !r.settlementTx) return { cause: "seller_config", rule: "answer_without_receipt", evidence: "response", fix: FIX.noReceipt };
  return { cause: "unknown", rule: `paid_${status}`, evidence: "response", fix: null };
}
