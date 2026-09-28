/**
 * --pay: buy one planned endpoint once. Order:
 *   re-read the live 402 -> guard (locks) -> balance -> ledger reserve (persisted) -> sign (pull mode,
 *   the tx stays in this process) -> decode and check the signed tx -> mark sent -> paid request ->
 *   re-read settlement on chain -> record.
 * Money can only move after "mark sent": in pull mode the server broadcasts the transaction we hand it.
 */
import { createHash } from "node:crypto";
import { keccak256, type Hex } from "viem";
import { Receipt } from "mppx";
import { FEE_RESERVE_ATOMIC, PAID_TIMEOUT_MS, PROBE_TIMEOUT_MS } from "./constants.js";
import { mppChallengesFromHeader, tempoChargeRequest } from "./challenge.js";
import { checkCharge, pickTempoCharge, type Refusal } from "./guard.js";
import type { Ledger } from "./ledger.js";
import type { FetchLike } from "./mercator.js";
import type { PlanEntry } from "./census.js";
import { refuseUrl, requestInit } from "./probe.js";
import { checkSignedTransfer } from "./txcheck.js";
import type { SettlementCheck, Signer } from "./chain.js";

export interface PayDeps {
  fetchImpl: FetchLike;
  signer: Signer;
  ledger: Ledger;
  payer: string;
  balance: () => Promise<bigint>;
  chainSpent: () => Promise<bigint>;
  verify: (txHash: string, exp: { payer: string; recipient: string; amount: bigint }) => Promise<SettlementCheck>;
  now?: () => Date;
  paidTimeoutMs?: number;
}

export interface PayOutcome {
  serviceId: string;
  result: "refused" | "sent" | "unknown";
  refusal?: Refusal;
  httpStatus?: number | null;
  txHash?: string | null;
  txHashSource?: "payment_receipt" | "signed_tx" | null;
  settled?: boolean | null;
  delivered?: boolean | null;
  /** USDC.e (atomic) the payer paid as fee in this tx, read back from the chain. */
  feePaid?: string | null;
  bodySha256?: string | null;
  bodyBytes?: number | null;
  contentType?: string | null;
  latencyMs?: number | null;
  detail?: string;
}

const MAX_BODY = 5 * 1024 * 1024;

function refused(serviceId: string, r: Refusal): PayOutcome {
  return { serviceId, result: "refused", refusal: r };
}

export async function payOne(entry: PlanEntry, deps: PayDeps): Promise<PayOutcome> {
  const { ledger } = deps;
  const now = deps.now ?? (() => new Date());
  const id = entry.serviceId;
  const bad = refuseUrl(entry.request.url);
  if (bad) return refused(id, { refused: "no_tempo_charge", detail: `url refused: ${bad}` });

  // 1. the live 402, read again right before paying
  let unpaid: Response;
  try {
    unpaid = await deps.fetchImpl(entry.request.url, {
      ...requestInit(entry.request),
      redirect: "error",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (e) {
    return refused(id, { refused: "no_tempo_charge", detail: `probe failed: ${e instanceof Error ? e.message : String(e)}` });
  }
  if (unpaid.status !== 402) return refused(id, { refused: "no_tempo_charge", detail: `unpaid status ${unpaid.status}` });
  const challenges = mppChallengesFromHeader(unpaid.headers.get("www-authenticate"));
  const ch = pickTempoCharge(challenges, entry.lockedRecipient);

  // 2. guard with the dry-run locks
  const refusal = checkCharge(ch, {
    payer: deps.payer,
    lockedRecipient: entry.lockedRecipient,
    lockedAmount: entry.lockedAmount,
    allowlist: entry.allowlist,
    now: now(),
  });
  if (refusal) return refused(id, refusal);
  const req = tempoChargeRequest(ch!)!;
  const amount = BigInt(req.amount);
  const recipient = req.recipient!;
  const sponsored = req.feePayer;

  // 3. balance
  const bal = await deps.balance();
  const need = amount + (sponsored ? 0n : FEE_RESERVE_ATOMIC);
  if (bal < need) return refused(id, { refused: "insufficient_balance", detail: `balance ${bal} < ${need}` });

  // 4. reserve (persisted before signing)
  const spent = await deps.chainSpent();
  // More USDC.e left the payer on chain than the ledger accounts for: the ledger is lost, stale,
  // or someone else spends from this key. Nothing more is signed until a human looks.
  const committed = ledger.committed();
  if (spent > committed)
    return refused(id, { refused: "chain_spend_exceeds_ledger", detail: `on-chain outflow ${spent} > ledger ${committed}` });
  const r = ledger.reserve({ key: id, url: entry.request.url, recipient, amount, sponsored }, spent, now());
  if ("refused" in r) return refused(id, r);

  // 5. sign (pull mode: the signed tx does not leave this process yet)
  let credential: string;
  let serializedTx: string;
  try {
    ({ credential, serializedTx } = await deps.signer.credentialFor(unpaid, ch!.id ?? "", recipient));
  } catch (e) {
    ledger.update(id, { status: "refused_before_sign", note: `sign failed: ${e instanceof Error ? e.message : String(e)}` });
    return refused(id, { refused: "tx_check_failed", detail: "credential not created" });
  }

  // 6. the signed transaction must be exactly the approved transfer
  const txProblem = checkSignedTransfer(serializedTx, { payer: deps.payer, recipient, amount, sponsored });
  if (txProblem) {
    ledger.update(id, { status: "refused_before_sign", note: `signed tx rejected, never sent: ${txProblem}` });
    return refused(id, { refused: "tx_check_failed", detail: txProblem });
  }

  // 7. from here money can move
  ledger.update(id, { status: "sent" });
  const t0 = Date.now();
  try {
    const res = await deps.fetchImpl(entry.request.url, {
      ...requestInit(entry.request, { authorization: authorizationHeader(credential) }),
      redirect: "error",
      signal: AbortSignal.timeout(deps.paidTimeoutMs ?? PAID_TIMEOUT_MS),
    });
    const buf = await readCapped(res);
    const latencyMs = Date.now() - t0;
    let candidate: string | null = null;
    let txHashSource: PayOutcome["txHashSource"] = null;
    const rh = res.headers.get("payment-receipt");
    if (rh) {
      try {
        candidate = Receipt.deserialize(rh).reference;
        txHashSource = "payment_receipt";
      } catch {
        candidate = null;
      }
    }
    if (!candidate && !sponsored) {
      // Unsponsored: if the server broadcast our envelope unchanged, this is its hash. Only a
      // candidate: it is reported as the tx only when the chain has a receipt for it.
      candidate = keccak256(serializedTx as Hex);
      txHashSource = "signed_tx";
    }
    const settlement = candidate ? await deps.verify(candidate, { payer: deps.payer, recipient, amount }) : null;
    const settled = settlement ? settlement.settled : null;
    const onChain = settlement !== null && settlement.detail !== "receipt not found";
    const txHash = onChain ? candidate : null;
    if (!onChain) txHashSource = null;
    const delivered = settled === true && res.status >= 200 && res.status <= 299;
    const problem = res.status === 402 && buf ? problemOf(buf) : null;
    ledger.update(id, {
      httpStatus: res.status,
      txHash,
      settled,
      delivered,
      feePaid: settlement?.feePaid ?? null,
      note: [problem, settlement?.detail].filter(Boolean).join("; "),
    });
    return {
      serviceId: id,
      result: "sent",
      httpStatus: res.status,
      txHash,
      txHashSource,
      settled,
      delivered,
      feePaid: settlement?.feePaid ?? null,
      bodySha256: buf ? createHash("sha256").update(buf).digest("hex") : null,
      bodyBytes: buf ? buf.length : null,
      contentType: res.headers.get("content-type"),
      latencyMs,
      ...(problem ? { detail: problem } : {}),
    };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    ledger.update(id, { status: "unknown", note: `after send: ${detail}` });
    return { serviceId: id, result: "unknown", detail, latencyMs: Date.now() - t0 };
  }
}

/**
 * Whether the whole --pay run must stop after this outcome (review B1). Any sign that the money
 * path is not behaving as checked stops everything; a human looks before the next purchase.
 *   tx_check_failed            mppx produced a transaction other than the approved transfer
 *   chain_spend_exceeds_ledger more left the payer on chain than the ledger accounts for
 *   total_cap_reached / insufficient_balance   nothing further can be bought anyway
 *   result "unknown"           a credential left the process and the outcome was not recorded
 *   settled === false          a sent credential did not produce the expected on-chain transfer
 *   feePaid > FEE_RESERVE      the fee is larger than the budget reserves for it
 */
export function stopReason(o: PayOutcome): string | null {
  const r = o.refusal?.refused;
  if (r === "tx_check_failed" || r === "chain_spend_exceeds_ledger" || r === "total_cap_reached" || r === "insufficient_balance")
    return r;
  if (o.result === "unknown") return "outcome_unknown";
  if (o.result === "sent" && o.settled === false) return "not_settled";
  if (o.feePaid && /^\d+$/.test(o.feePaid) && BigInt(o.feePaid) > FEE_RESERVE_ATOMIC) return "fee_over_reserve";
  return null;
}

/** Pay each entry in order; stop at the first outcome `stopReason` flags. */
export async function runPlan(
  plan: readonly PlanEntry[],
  deps: PayDeps,
  onOutcome: (entry: PlanEntry, o: PayOutcome) => void = () => undefined,
): Promise<{ outcomes: PayOutcome[]; stopped: { serviceId: string; reason: string } | null }> {
  const outcomes: PayOutcome[] = [];
  for (const entry of plan) {
    const o = await payOne(entry, deps);
    outcomes.push(o);
    onOutcome(entry, o);
    const reason = stopReason(o);
    if (reason) return { outcomes, stopped: { serviceId: entry.serviceId, reason } };
  }
  return { outcomes, stopped: null };
}

/**
 * The Authorization value for a credential. mppx's createCredential / Credential.serialize already
 * return `Payment <base64url>`; prefixing again sent `Payment Payment …`, which sellers reject as
 * `malformed-credential` (402, nothing broadcast) — the 2026-09-28 smoke-test failure.
 */
export function authorizationHeader(credential: string): string {
  const c = credential.trim();
  if (/^Payment\s+/i.test(c)) return c;
  return `Payment ${c}`;
}

/** RFC 9457 problem `type` + `detail` from a paid 402, for the ledger. */
function problemOf(buf: Buffer): string | null {
  try {
    const p = JSON.parse(buf.toString("utf8")) as { type?: unknown; detail?: unknown; title?: unknown };
    const parts = [p.type, p.detail ?? p.title].filter((x) => typeof x === "string") as string[];
    return parts.length ? `paid 402: ${parts.join(" — ").slice(0, 300)}` : null;
  } catch {
    return null;
  }
}

async function readCapped(res: Response): Promise<Buffer | null> {
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_BODY) {
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
