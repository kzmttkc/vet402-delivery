/**
 * Why did a paid purchase not come back with an answer? One cause per record, first matching rule wins.
 *
 *   facilitator   the seller's facilitator cannot settle this chain / scheme / amount
 *   seller_config the seller's own setup: took the money but sent no answer, settled to another address,
 *                 has no paid route, or advertises a chain its facilitator does not settle
 *   vet402        vet402's payment itself was wrong (balance, signature, validity window), or vet402's request
 *                 was (rule input:*: a path slot left in the URL, or the seller's 400/404/422 naming a missing or
 *                 empty input), whether or not the payment settled
 *   seller_free   the seller said in its answer that it did not charge this call (first_call_free,
 *                 freeTrialApplied, charged:false), the answer came back, and the chain check found no transfer
 *   unconfirmed   vet402 could not read the settlement back (RPC timeout, receipt not found): vet402's side
 *   not_settled   the payment did not settle and nothing points at anyone: not the seller's fault
 *   unknown       nothing in the response says which
 *
 * seller_config is assigned only on definite evidence: the payment settled on chain and no answer came
 * back; the settlement tx the seller named has no transfer from vet402 to the payTo, or a different amount
 * (read from vet402's own Transfer only); or the facilitator reported a recipient mismatch. A reverted tx,
 * an unsupported token or network, and a pending settlement are never the seller's fault here. A payment that did not settle is never counted against the seller.
 *
 * Inputs are what vet402 saw: the seller's PAYMENT-RESPONSE (errorReason), the HTTP status and body, the
 * settlement read back on chain, and what the facilitators' own /supported pages say about the chain.
 * Pure: no network.
 */
import type { ChainBuyRecord } from "./evm-buy.js";
import { laneInputProblem, sellerSaidFree } from "./lane-input.js";

export type Cause = "delivered" | "not_paid" | "facilitator" | "seller_config" | "vet402" | "seller_free" | "unconfirmed" | "not_settled" | "unknown";

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

const VET402_REASONS = [/insufficient_(funds|balance)/, /invalid_exact_evm_(payload_)?signature/, /authorization_valid_(before|after)/, /authorization_value/, /nonce/];
/** The facilitator cannot settle this network, scheme, token or transfer method. */
const FACILITATOR_REASONS = [/invalid_network/, /unsupported_network/, /unsupported_scheme/, /invalid_scheme/, /unexpected_(settle|verify)_error/, /facilitator/, /asset/, /eip3009_not_supported/, /unsupported_payload_type/, /unsupported_asset_transfer_method/];
/** Named by the facilitator as a difference between the seller's payment requirements and its 402. */
const SELLER_REASONS = [/recipient_mismatch/, /payto_mismatch/];
/** Pending or failed on chain: nothing yet says whose side. */
const PENDING_REASONS = [/pending/, /transaction_failed/, /timeout/];

const FACILITATOR_TEXT = /(unsupported|not supported|no facilitator|unknown) (network|chain)|(network|chain)[^.]{0,40}not supported|facilitator (error|unavailable|rejected)/i;
const VET402_TEXT = /insufficient (funds|balance)|invalid signature/i;

const FIX = {
  facilitator: "Use a facilitator whose /supported lists this chain for exact, or stop advertising the chain in the 402 until one does.",
  permit2: "Advertise extra.assetTransferMethod \"permit2\" in the 402 when the facilitator requires Permit2 on this chain, or use a facilitator that accepts EIP-3009 (transferWithAuthorization) for this token.",
  minimum: "Raise the price to the facilitator's minimum for this chain, or use a facilitator without one.",
  settledNoAnswer: "The payment settled; return the answer after settlement (or refund) instead of an error or an empty body.",
  recipientMismatch: "The facilitator reported that the recipient in the seller's payment requirements is not the payTo in its 402; make the two the same address.",
  receiptWithoutPayment: "The settlement tx named in PAYMENT-RESPONSE has no transfer from vet402 to the payTo in the 402; return the tx that moved this payment.",
  amountMismatch: "The settlement tx moved a different amount from vet402 to the payTo than the 402 asked for.",
  vet402: null,
};

/**
 * Pure. A record whose settlement was read again: settled when vet402's own transfer to the payTo is found;
 * delivered when also the paid response was 2xx with a non-empty body (the rule buyOneOnChain applies).
 */
export function reverifyRecord<T extends ChainBuyRecord>(r: T, proof: { ok: boolean; from?: string; reason?: string }, payer: string): T {
  const settled = proof.ok && !!proof.from && proof.from.toLowerCase() === payer.toLowerCase();
  const status = r.response?.status ?? null;
  const answered = status !== null && status >= 200 && status < 300 && ((r.response?.first300 ?? "").trim().length > 0 || (r.response?.bytes ?? 0) > 0);
  return {
    ...r,
    settledOnChain: settled,
    settlementCheck: proof.ok ? `transfer ${proof.from} -> ${r.payTo} ${r.amountAtomic}` : `not verified: ${proof.reason}`,
    delivered: settled && answered,
  };
}

/** readUsdcTransfer reasons that are a finding about the tx itself; any other failure means vet402 could not read it. */
export const DEFINITE_SETTLEMENT_REASONS = ["amount_mismatch", "no_usdc_transfer_to_seller"] as const;

function settlementReason(check: string | undefined): string | null {
  if (!check?.startsWith("not verified: ")) return null;
  return check.slice("not verified: ".length).trim();
}

/** Pure. `predicted` is the before-payment facilitator check for this record's 402, if any. */
export function classifyRecord(r: ChainBuyRecord, predicted?: { facilitator: string | null; problem: string | null }): CauseResult {
  if (r.outcome !== "sent") return { cause: "not_paid", rule: r.refusal ? `refused:${r.refusal.refused}` : r.outcome, evidence: "none", fix: null };
  if (r.delivered) return { cause: "delivered", rule: "delivered", evidence: "chain", fix: null };
  const status = r.response?.status ?? null;
  const body = r.response?.first300 ?? "";
  // 0. vet402's request was wrong: never the seller's, settled or not.
  const input = laneInputProblem(r);
  if (input) return { cause: "vet402", rule: `input:${input.kind}${r.settledOnChain ? ":settled" : ""}`, evidence: "response", fix: null };
  // 0b. The seller said it did not charge, the answer came back, and the chain shows nothing moved.
  const free = r.settledOnChain !== true && r.chainCheck?.result === "no_transfer" && status !== null && status >= 200 && status < 300 ? sellerSaidFree(r.body ?? r.response?.first300) : null;
  if (free) return { cause: "seller_free", rule: `seller_said_free:${free}`, evidence: "response", fix: null };
  // 1. Settled on chain, no answer: the seller took the money.
  if (r.settledOnChain) return { cause: "seller_config", rule: `settled_then_${status ?? "no_response"}`, evidence: "chain", fix: FIX.settledNoAnswer };
  // 2. A settlement tx was named but vet402 could not confirm it.
  const why = settlementReason(r.settlementCheck);
  if (r.settlementTx && why !== null) {
    if (why === "amount_mismatch") return { cause: "seller_config", rule: `settlement:${why}`, evidence: "chain", fix: FIX.amountMismatch };
    if (why === "no_usdc_transfer_to_seller") return { cause: "seller_config", rule: `settlement:${why}`, evidence: "chain", fix: FIX.receiptWithoutPayment };
    // Reverted on chain: the payment did not move (a balance race or an expired authorization are possible). Not the seller's fault.
    if (why === "tx_status_reverted") return { cause: "not_settled", rule: "settlement:tx_status_reverted", evidence: "chain", fix: null };
    // The chain check read every transfer out of the payer in the authorization's window: none to this payTo.
    if (why === "no_transfer_on_chain") return { cause: "not_settled", rule: "settlement:no_transfer_on_chain", evidence: "chain", fix: null };
    return { cause: "unconfirmed", rule: `settlement_unreadable:${why.slice(0, 60)}`, evidence: "none", fix: null };
  }
  if (r.settlementTx && r.settlementCheck?.startsWith("transfer ")) return { cause: "unknown", rule: "transfer_from_another_payer", evidence: "chain", fix: null };
  // 3. Not settled. What the facilitator or vet402's own payment says, else nobody's fault.
  const reason = (r.settleResponse?.errorReason ?? "").toLowerCase();
  if (reason) {
    if (VET402_REASONS.some((x) => x.test(reason))) return { cause: "vet402", rule: `errorReason:${reason}`, evidence: "response", fix: FIX.vet402 };
    if (FACILITATOR_REASONS.some((x) => x.test(reason))) return { cause: "facilitator", rule: `errorReason:${reason}`, evidence: "response", fix: FIX.facilitator };
    if (SELLER_REASONS.some((x) => x.test(reason))) return { cause: "seller_config", rule: `errorReason:${reason}`, evidence: "response", fix: FIX.recipientMismatch };
    if (PENDING_REASONS.some((x) => x.test(reason))) return { cause: "unconfirmed", rule: `errorReason:${reason}`, evidence: "response", fix: null };
  }
  if (status === null) return { cause: "unconfirmed", rule: "no_response", evidence: "none", fix: null };
  if (VET402_TEXT.test(body)) return { cause: "vet402", rule: "body:vet402", evidence: "response", fix: FIX.vet402 };
  if (FACILITATOR_TEXT.test(body)) return { cause: "facilitator", rule: "body:facilitator", evidence: "response", fix: FIX.facilitator };
  if (predicted?.problem) {
    const fix = /Permit2/.test(predicted.problem) ? FIX.permit2 : /minimum/.test(predicted.problem) ? FIX.minimum : FIX.facilitator;
    return { cause: "facilitator", rule: `supported:${predicted.facilitator}`, evidence: "supported_page", fix };
  }
  return { cause: "not_settled", rule: `not_settled_${status}`, evidence: "response", fix: null };
}
