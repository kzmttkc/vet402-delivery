/**
 * Read the seller's 402 once, without paying, and decide what proxy buy would pay on each chain.
 *
 * Only hosts on the allowlist are contacted at all (vet402 already paid them and the payment settled),
 * so an agent cannot make vet402 fetch an arbitrary URL. The seller's offer must then pass the same
 * pre-signing checks the census uses (src/guard.ts checkAccept, src/tempo/guard.ts checkCharge) and its
 * payTo must be the one vet402 paid before.
 */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { checkAccept, normalizeAccept, pickSolanaAccept, type SolAccept } from "../guard.js";
import { mppChallengesFromHeader, tempoChargeRequest, type MppChallenge, type TempoChargeRequest } from "../tempo/challenge.js";
import { checkCharge, pickTempoCharge } from "../tempo/guard.js";
import { refuseUrl } from "../tempo/probe.js";
import type { AllowEntry, Allowlist, ProxyChain } from "./allowlist.js";

const parser = new x402HTTPClient(new x402Client());

export interface Refused {
  ok: false;
  status: 400 | 403 | 422 | 502;
  reason: string;
  detail: string;
}

export interface SolanaOffer {
  ok: true;
  chain: "solana";
  accept: SolAccept;
  paymentRequired: PaymentRequired;
  sellerAtomic: bigint;
  known: AllowEntry;
}

export interface TempoOffer {
  ok: true;
  chain: "tempo";
  challenge: MppChallenge;
  request: TempoChargeRequest;
  sellerAtomic: bigint;
  known: AllowEntry;
}

export interface Quote {
  target: string;
  host: string;
  solana: SolanaOffer | Refused;
  tempo: TempoOffer | Refused;
}

export interface QuoteDeps {
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  allowlist: Allowlist;
  /** Every vet402 address (receive and payer wallets on both chains, and the census payers). Never paid. */
  ownAddresses: string[];
  solanaPayer: string | null;
  tempoPayer: string | null;
  timeoutMs?: number;
  now?: () => Date;
}

const refused = (status: Refused["status"], reason: string, detail: string): Refused => ({ ok: false, status, reason, detail });

/** Parse and check the target URL. Returns the normalised URL or a refusal. */
export function checkTarget(raw: string | null, allowlist: Allowlist): { ok: true; url: string; host: string } | Refused {
  if (!raw) return refused(400, "missing_url", "add ?url=<the seller's endpoint>");
  const bad = refuseUrl(raw);
  if (bad) return refused(400, "invalid_target", bad);
  const u = new URL(raw);
  if (u.username || u.password) return refused(400, "invalid_target", "credentials in the URL");
  const host = u.host.toLowerCase();
  if (!allowlist.entries.some((e) => e.host === host)) {
    return refused(403, "seller_not_allowlisted", `vet402 buys only from sellers it already paid with a settled payment; ${host} is not one of them`);
  }
  return { ok: true, url: u.toString(), host };
}

export async function quote(rawTarget: string | null, deps: QuoteDeps): Promise<Quote | Refused> {
  const t = checkTarget(rawTarget, deps.allowlist);
  if (!t.ok) return t;
  let res: Response;
  try {
    res = await deps.fetchImpl(t.url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000),
    });
  } catch {
    return refused(502, "seller_unreachable", "the seller did not answer the unpaid request");
  }
  const www = res.headers.get("www-authenticate");
  if (res.status !== 402) {
    await res.body?.cancel().catch(() => undefined);
    return refused(422, "not_402", `the seller answered ${res.status} to an unpaid request, not 402`);
  }
  const bodyText = await readTextCapped(res, QUOTE_MAX_BODY_BYTES);

  return {
    target: t.url,
    host: t.host,
    solana: solanaOffer(res.headers, bodyText, t.host, deps),
    tempo: tempoOffer(www, t.host, deps),
  };
}

function solanaOffer(headers: Headers, bodyText: string, host: string, deps: QuoteDeps): SolanaOffer | Refused {
  if (!deps.solanaPayer) return refused(422, "chain_not_offered", "proxy buy on Solana is not configured");
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = undefined;
  }
  let pr: PaymentRequired;
  try {
    pr = parser.getPaymentRequiredResponse((n) => headers.get(n), body);
  } catch {
    return refused(422, "no_solana_accept", "no readable x402 payment requirements");
  }
  const accepts = (pr.accepts as unknown as Record<string, unknown>[]).map(normalizeAccept);
  const accept = pickSolanaAccept(accepts);
  if (!accept) return refused(422, "no_solana_accept", "the seller's 402 has no Solana mainnet accept");
  // The lock is the seller's own payTo as read now; the allowlist below decides whether that payTo is one vet402 paid before.
  const r = checkAccept(accept, { payer: deps.solanaPayer, lockedPayTo: accept.payTo, ownAddresses: deps.ownAddresses });
  if (r) return refused(422, r.refused, r.detail);
  const known = deps.allowlist.find("solana", host, accept.payTo);
  if (!known) return refused(403, "payto_not_allowlisted", `vet402 has not paid ${accept.payTo} at ${host} with a settled payment`);
  // A seller whose every settled purchase came back without an answer is not bought for an agent.
  if (known.delivered === 0) return refused(403, "seller_never_delivered", `none of vet402's ${known.settled} settled purchase(s) from ${host} came back with an answer`);
  return { ok: true, chain: "solana", accept, paymentRequired: pr, sellerAtomic: BigInt(accept.amount), known };
}

function tempoOffer(www: string | null, host: string, deps: QuoteDeps): TempoOffer | Refused {
  if (!deps.tempoPayer) return refused(422, "chain_not_offered", "proxy buy on Tempo is not configured");
  const ch = pickTempoCharge(mppChallengesFromHeader(www));
  const r = checkCharge(ch, { payer: deps.tempoPayer, now: (deps.now ?? (() => new Date()))() });
  if (r) return refused(422, r.refused, r.detail);
  const req = tempoChargeRequest(ch!)!;
  const recipient = req.recipient!;
  if (deps.ownAddresses.some((a) => a.toLowerCase() === recipient.toLowerCase())) return refused(422, "self_dealing", "recipient is a vet402 address");
  const known = deps.allowlist.find("tempo", host, recipient);
  if (!known) return refused(403, "payto_not_allowlisted", `vet402 has not paid ${recipient} at ${host} with a settled payment`);
  // A seller whose every settled purchase came back without an answer is not bought for an agent.
  if (known.delivered === 0) return refused(403, "seller_never_delivered", `none of vet402's ${known.settled} settled purchase(s) from ${host} came back with an answer`);
  return { ok: true, chain: "tempo", challenge: ch!, request: req, sellerAtomic: BigInt(req.amount), known };
}

/** A 402 body larger than this is not read further (x402 requirements are a few KB; v2 puts them in a header). */
export const QUOTE_MAX_BODY_BYTES = 64 * 1024;

/** The body as text, at most `max` bytes of it; anything unreadable is "". */
export async function readTextCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (n + value.byteLength > max) {
        await reader.cancel().catch(() => undefined);
        return ""; // too large to be a 402 worth parsing
      }
      n += value.byteLength;
      chunks.push(value);
    }
  } catch {
    return "";
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** What the agent pays for a seller price. */
export function totalAtomic(sellerAtomic: bigint, feeAtomic: bigint): bigint {
  return sellerAtomic + feeAtomic;
}

export function offerFor(q: Quote, chain: ProxyChain): SolanaOffer | TempoOffer | Refused {
  return chain === "solana" ? q.solana : q.tempo;
}
