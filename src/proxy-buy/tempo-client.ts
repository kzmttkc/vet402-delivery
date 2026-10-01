/**
 * The agent's side of a proxy buy on Tempo (scripts/proxy-buy-tempo-client.ts): read vet402's 402 for a seller
 * endpoint, and pay it with a pull-mode MPP credential (the agent signs, vet402 broadcasts).
 *
 * Nothing is signed unless the challenge is exactly what this client expects: method tempo, intent charge, chain
 * 4217, currency USDC.e, the recipient vet402's Tempo receive wallet as given, an amount above 0 and at most the
 * caller's ceiling, no splits, the agent paying its own fee, and pull mode offered. After mppx signs, the signed
 * transaction is decoded and must be exactly that transfer (one TIP-20 transfer of that amount to that recipient,
 * from the agent, chain 4217, fee in USDC.e) with a validBefore at most TEMPO_MAX_VALID_AHEAD_SECONDS ahead.
 * By default (dry run) it stops there: the credential is never sent and never printed (anyone holding a signed
 * pull-mode transaction can broadcast it until its validBefore). Only `send: true` sends the paid GET.
 */
import { decodeTempoTx } from "./fate.js";
import { BUY_PATH, TEMPO_MAX_VALID_AHEAD_SECONDS } from "./constants.js";
import { mppChallengesFromHeader, tempoChargeRequest, type MppChallenge } from "../tempo/challenge.js";
import { normAddr, PAYER_ADDRESS as TEMPO_CENSUS_PAYER, TEMPO_MAINNET_CHAIN_ID, USDC_E } from "../tempo/constants.js";
import type { Signer } from "../tempo/chain.js";
import { checkSignedTransfer } from "../tempo/txcheck.js";

/** vet402's Tempo receive wallet on https://vet402-delivery.vercel.app (VET402_PROXY_TEMPO_RECEIVE). */
export const DEFAULT_TEMPO_RECEIVE = "0xf85727Ec3531099c6c5158Ad1a6Db10D61Ad3391";
/** Default ceiling on what one run may pay (seller price + vet402's fee), atomic USDC.e: 0.01. */
export const DEFAULT_CLIENT_MAX_ATOMIC = 10_000n;

export interface TempoClientOptions {
  /** vet402's origin, e.g. https://vet402-delivery.vercel.app */
  origin: string;
  /** The seller endpoint to buy. */
  target: string;
  /** The recipient the challenge must name (vet402's Tempo receive wallet). */
  expectedReceive: string;
  /** The most the run may pay, atomic USDC.e. */
  maxAtomic: bigint;
  /** false (default): build and check the credential, never send it. */
  send?: boolean;
  /** Addresses the agent must not be (vet402's own wallets): the agent's wallet is kept apart from them. */
  notAgent?: string[];
  now?: () => Date;
}

export interface TempoClientDeps {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  /** The agent's pull-mode signer (src/tempo/chain.ts signerFor). */
  signer: Signer;
}

export type TempoClientResult =
  | { ok: false; stage: "quote" | "guard" | "sign" | "check"; reason: string; signed: boolean; sent: false }
  | {
      ok: true;
      sent: false;
      dryRun: true;
      amountAtomic: string;
      recipient: string;
      agent: string;
      /** keccak256 of the signed transaction (what it would be on chain); the transaction itself is not returned. */
      txHash: string;
      validBefore: string;
    }
  | {
      ok: true;
      sent: true;
      amountAtomic: string;
      recipient: string;
      agent: string;
      txHash: string;
      status: number;
      headers: Record<string, string>;
      body: Uint8Array;
    };

export function buyUrlFor(origin: string, target: string): string {
  return `${origin.replace(/\/+$/, "")}${BUY_PATH}?url=${encodeURIComponent(target)}`;
}

/** The single tempo/charge challenge of the 402, or why there is none to pay. */
export function pickChallenge(res: Response): { ch: MppChallenge } | { reason: string } {
  if (res.status !== 402) return { reason: `quote_status_${res.status}` };
  const all = mppChallengesFromHeader(res.headers.get("www-authenticate"));
  const tempo = all.filter((c) => (c.method ?? "").toLowerCase() === "tempo" && (c.intent ?? "").toLowerCase() === "charge");
  if (tempo.length === 0) return { reason: "no_tempo_charge_offered" };
  if (tempo.length > 1) return { reason: "more_than_one_tempo_charge" };
  if (!tempo[0]!.id) return { reason: "challenge_without_id" };
  return { ch: tempo[0]! };
}

/** Why this challenge must not be signed, or null when it is exactly what the client expects. */
export function guardChallenge(ch: MppChallenge, o: { expectedReceive: string; maxAtomic: bigint; now: Date }): string | null {
  const req = tempoChargeRequest(ch);
  if (!req) return `request_unreadable${ch.requestError ? `: ${ch.requestError}` : ""}`;
  if (req.chainId !== TEMPO_MAINNET_CHAIN_ID) return `chain_${String(req.chainId)}_not_4217`;
  if (normAddr(req.currency) !== USDC_E) return `currency_${req.currency}_not_usdc_e`;
  if (!req.recipient || normAddr(req.recipient) !== normAddr(o.expectedReceive)) return `recipient_${String(req.recipient)}_not_${o.expectedReceive}`;
  if (!/^\d+$/.test(req.amount)) return `amount_${req.amount}_not_atomic`;
  const amount = BigInt(req.amount);
  if (amount <= 0n) return "amount_zero";
  if (amount > o.maxAtomic) return `amount_${amount}_over_max_${o.maxAtomic}`;
  if (req.splits.length > 0) return "splits_not_allowed";
  if (req.feePayer) return "sponsored_fee_not_expected";
  if (req.supportedModes.length > 0 && !req.supportedModes.includes("pull")) return "pull_mode_not_offered";
  if (ch.expires) {
    const t = Date.parse(ch.expires);
    if (Number.isFinite(t) && t <= o.now.getTime()) return "challenge_expired";
  }
  return null;
}

export async function buyOnTempo(o: TempoClientOptions, d: TempoClientDeps): Promise<TempoClientResult> {
  const now = o.now ?? (() => new Date());
  const agent = d.signer.address;
  const own = [o.expectedReceive, TEMPO_CENSUS_PAYER, ...(o.notAgent ?? [])].map(normAddr);
  if (own.includes(normAddr(agent))) return { ok: false, stage: "guard", reason: "agent_is_a_vet402_wallet", signed: false, sent: false };
  if (o.maxAtomic <= 0n) return { ok: false, stage: "guard", reason: "max_not_positive", signed: false, sent: false };

  const url = buyUrlFor(o.origin, o.target);
  let quoteRes: Response;
  try {
    quoteRes = await d.fetchImpl(url, { method: "GET", redirect: "error" });
  } catch {
    return { ok: false, stage: "quote", reason: "quote_unreachable", signed: false, sent: false };
  }
  const picked = pickChallenge(quoteRes);
  if ("reason" in picked) {
    // vet402's own refusal names why (a fixed code), e.g. chain_not_offered while Tempo is off
    const why = quoteRes.status === 402 ? "" : await quoteRes.json().then((j: { reason?: unknown; offers?: { tempo?: { refused?: unknown } } }) => [j.reason, j.offers?.tempo?.refused].filter((x) => typeof x === "string" && /^[a-z0-9_]{1,64}$/.test(x)).join("/"), () => "");
    return { ok: false, stage: "quote", reason: why ? `${picked.reason}: ${why}` : picked.reason, signed: false, sent: false };
  }
  const ch = picked.ch;
  const refusal = guardChallenge(ch, { expectedReceive: o.expectedReceive, maxAtomic: o.maxAtomic, now: now() });
  if (refusal) return { ok: false, stage: "guard", reason: refusal, signed: false, sent: false };
  const req = tempoChargeRequest(ch)!;
  const amount = BigInt(req.amount);
  const recipient = req.recipient!;

  let credential: string;
  let serializedTx: string;
  try {
    ({ credential, serializedTx } = await d.signer.credentialFor(quoteRes, ch.id!, recipient));
  } catch {
    return { ok: false, stage: "sign", reason: "credential_not_created", signed: false, sent: false };
  }
  const problem = checkSignedTransfer(serializedTx, { payer: agent, recipient, amount, sponsored: false });
  if (problem) return { ok: false, stage: "check", reason: `signed_tx_rejected: ${problem}`, signed: true, sent: false };
  const facts = decodeTempoTx(serializedTx);
  const nowSec = BigInt(Math.floor(now().getTime() / 1000));
  if (!facts || facts.validBefore === null || BigInt(facts.validBefore) > nowSec + BigInt(TEMPO_MAX_VALID_AHEAD_SECONDS)) {
    return { ok: false, stage: "check", reason: "signed_tx_without_near_valid_before", signed: true, sent: false };
  }
  if (!o.send) {
    return { ok: true, sent: false, dryRun: true, amountAtomic: amount.toString(), recipient, agent, txHash: facts.hash, validBefore: facts.validBefore };
  }

  const res = await d.fetchImpl(url, { method: "GET", redirect: "error", headers: { authorization: credential } });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (k.startsWith("x-vet402-") || k === "content-type" || k === "payment-receipt") headers[k] = v;
  });
  return { ok: true, sent: true, amountAtomic: amount.toString(), recipient, agent, txHash: facts.hash, status: res.status, headers, body: new Uint8Array(await res.arrayBuffer()) };
}
