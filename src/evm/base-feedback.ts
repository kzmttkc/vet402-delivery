/**
 * Which Base purchases may become ERC-8004 feedback, and the FeedbackInput for each. Pure.
 * The submitter is the same address that paid (0x9B59), so the NewFeedback log and the proofOfPayment
 * tx carry the same address: the chain alone shows "the one who paid wrote this".
 */
import { getAddress, isAddress, isAddressEqual, type Address, type Hex } from "viem";
import type { BuyRecord } from "./base-buy.js";
import type { FeedbackInput } from "./erc8004.js";

export const PLACEHOLDER_TX = ("0x" + "00".repeat(32)) as Hex;

export interface Eligibility {
  ok: boolean;
  reason: string;
  placeholder: boolean;
}

/**
 * Real write: only a purchase that was sent, answered 2xx with a body, settled on chain from the payer
 * to the agentWallet. Dry run (`allowDryRunRecord`) also accepts a `would_pay` record, with a placeholder tx,
 * to measure gas; such a record can never be written.
 */
export function feedbackEligibility(r: BuyRecord, submitter: Address, opts: { allowDryRunRecord?: boolean } = {}): Eligibility {
  const same = (a?: string) => !!a && isAddress(a) && isAddressEqual(a, submitter);
  if (!same(r.payer)) return { ok: false, reason: `payer ${r.payer} is not the submitter`, placeholder: false };
  if (r.payToIsAgentWallet !== true) return { ok: false, reason: "payTo was not the agentWallet", placeholder: false };
  if (r.outcome === "would_pay" && opts.allowDryRunRecord) return { ok: true, reason: "dry-run record (placeholder tx; never writable)", placeholder: true };
  if (r.outcome !== "sent") return { ok: false, reason: `outcome ${r.outcome}`, placeholder: false };
  if (!r.settlementTx || !/^0x[0-9a-fA-F]{64}$/.test(r.settlementTx)) return { ok: false, reason: "no settlement tx", placeholder: false };
  if (r.settledOnChain !== true) return { ok: false, reason: `not settled on chain (${r.settlementCheck ?? "?"})`, placeholder: false };
  if (r.delivered !== true) return { ok: false, reason: `not delivered (HTTP ${r.response?.status ?? "none"})`, placeholder: false };
  return { ok: true, reason: "delivered and settled", placeholder: false };
}

export function toFeedbackInput(r: BuyRecord, submitter: Address, createdAt: string): FeedbackInput {
  if (!r.payTo || !r.amountAtomic) throw new Error("record lacks payTo/amount");
  const tx = (r.settlementTx ?? PLACEHOLDER_TX) as Hex;
  return {
    chain: "base",
    agentId: BigInt(r.agentId),
    clientAddress: submitter,
    delivered: true,
    createdAt,
    purchase: {
      resource: r.resource,
      network: "eip155:8453",
      txHash: tx,
      fromAddress: submitter,
      toAddress: getAddress(r.payTo),
      amountUnits: r.amountAtomic,
      attemptedAt: r.at,
      httpStatusPaid: r.response?.status ?? null,
      l2Schema: null,
      evidenceUrl: `https://basescan.org/tx/${tx}`,
    },
  };
}
