/**
 * Checks made before anything is signed. Pure: no network, no files.
 * Every check must pass before the signer is touched; the order only decides which reason is reported.
 */
import { isAddress } from "viem";
import {
  MAX_PER_CALL_ATOMIC,
  TEMPO_MAINNET_CHAIN_ID,
  TEMPO_MODERATO_CHAIN_ID,
  USDC_E,
  normAddr,
} from "./constants.js";
import { tempoChargeRequest, type MppChallenge, type TempoChargeRequest } from "./challenge.js";

export type RefuseReason =
  | "no_tempo_charge"
  | "request_undecodable"
  | "testnet_chain"
  | "chain_mismatch"
  | "currency_mismatch"
  | "bad_amount"
  | "price_over_cap"
  | "price_raised"
  | "recipient_invalid"
  | "recipient_mismatch"
  | "recipient_not_allowlisted"
  | "self_dealing"
  | "splits_refused"
  | "pull_unsupported"
  | "expired"
  | "total_cap_reached"
  | "purchase_count_reached"
  | "already_bought"
  | "ledger_unreadable"
  | "chain_spend_exceeds_ledger"
  | "insufficient_balance"
  | "tx_check_failed";

export interface Refusal {
  refused: RefuseReason;
  detail: string;
}

export interface GuardContext {
  payer: string;
  /** Recipient seen in the dry-run 402. The paid run must see the same one. */
  lockedRecipient?: string | undefined;
  /** Price seen in the dry-run 402. A higher price is refused. */
  lockedAmount?: string | undefined;
  /** Mercator's recipientPolicy allowlist for the service, when it has one. */
  allowlist?: readonly string[] | undefined;
  now?: Date | undefined;
}

const refuse = (refused: RefuseReason, detail: string): Refusal => ({ refused, detail });

/** Pick the tempo/charge challenge vet402 would pay: mainnet, USDC.e, locked recipient first. */
export function pickTempoCharge(challenges: MppChallenge[], lockedRecipient?: string): MppChallenge | null {
  const tempo = challenges.filter((c) => c.method === "tempo" && c.intent === "charge");
  if (tempo.length === 0) return null;
  const score = (c: MppChallenge): number => {
    const r = tempoChargeRequest(c);
    if (!r) return 0;
    let s = 1;
    if (r.chainId === TEMPO_MAINNET_CHAIN_ID) s += 4;
    if (r.currency === USDC_E) s += 2;
    if (lockedRecipient && normAddr(r.recipient) === normAddr(lockedRecipient)) s += 8;
    return s;
  };
  return [...tempo].sort((a, b) => score(b) - score(a))[0]!;
}

/** null = may be paid. Otherwise the first reason it may not. */
export function checkCharge(ch: MppChallenge | null, ctx: GuardContext): Refusal | null {
  if (!ch || ch.method !== "tempo" || ch.intent !== "charge") return refuse("no_tempo_charge", "no tempo/charge challenge");
  const r: TempoChargeRequest | null = tempoChargeRequest(ch);
  if (!r) return refuse("request_undecodable", ch.requestError ?? "request missing");
  if (r.chainId === TEMPO_MODERATO_CHAIN_ID) return refuse("testnet_chain", "chainId 42431 (Moderato testnet)");
  if (r.chainId !== TEMPO_MAINNET_CHAIN_ID) return refuse("chain_mismatch", `chainId ${String(r.chainId)} is not 4217`);
  if (r.currency !== USDC_E) return refuse("currency_mismatch", `currency ${r.currency} is not USDC.e`);
  if (!/^[1-9]\d{0,30}$/.test(r.amount)) return refuse("bad_amount", `amount ${JSON.stringify(r.amount)}`);
  const amount = BigInt(r.amount);
  if (amount > MAX_PER_CALL_ATOMIC) return refuse("price_over_cap", `amount ${r.amount} > ${MAX_PER_CALL_ATOMIC}`);
  if (ctx.lockedAmount !== undefined && amount > BigInt(ctx.lockedAmount))
    return refuse("price_raised", `amount ${r.amount} > recorded ${ctx.lockedAmount}`);
  if (!r.recipient || !isAddress(r.recipient, { strict: false })) return refuse("recipient_invalid", String(r.recipient));
  if (normAddr(r.recipient) === normAddr(ctx.payer)) return refuse("self_dealing", "recipient is the payer");
  if (ctx.lockedRecipient !== undefined && normAddr(r.recipient) !== normAddr(ctx.lockedRecipient))
    return refuse("recipient_mismatch", `recipient ${r.recipient} != recorded ${ctx.lockedRecipient}`);
  if (ctx.allowlist && ctx.allowlist.length > 0 && !ctx.allowlist.some((a) => normAddr(a) === normAddr(r.recipient)))
    return refuse("recipient_not_allowlisted", `recipient ${r.recipient} not in Mercator recipientPolicy`);
  if (r.splits.length > 0) return refuse("splits_refused", `${r.splits.length} splits`);
  if (r.supportedModes.length > 0 && !r.supportedModes.includes("pull"))
    return refuse("pull_unsupported", `supportedModes ${r.supportedModes.join(",")}`);
  if (ch.expires) {
    const t = Date.parse(ch.expires);
    const now = (ctx.now ?? new Date()).getTime();
    if (Number.isFinite(t) && t <= now) return refuse("expired", `expired ${ch.expires}`);
  }
  return null;
}
