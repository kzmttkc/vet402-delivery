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
      ...requestInit(entry.request, { authorization: `Payment ${credential}` }),
      redirect: "error",
      signal: AbortSignal.timeout(deps.paidTimeoutMs ?? PAID_TIMEOUT_MS),
    });
    const buf = await readCapped(res);
    const latencyMs = Date.now() - t0;
    let txHash: string | null = null;
    let txHashSource: PayOutcome["txHashSource"] = null;
    const rh = res.headers.get("payment-receipt");
    if (rh) {
      try {
        txHash = Receipt.deserialize(rh).reference;
        txHashSource = "payment_receipt";
      } catch {
        txHash = null;
      }
    }
    if (!txHash && !sponsored) {
      // Unsponsored: the server broadcasts our envelope unchanged, so its hash is ours to compute.
      txHash = keccak256(serializedTx as Hex);
      txHashSource = "signed_tx";
    }
    const settlement = txHash ? await deps.verify(txHash, { payer: deps.payer, recipient, amount }) : null;
    const settled = settlement ? settlement.settled : null;
    const delivered = settled === true && res.status >= 200 && res.status <= 299;
    ledger.update(id, {
      httpStatus: res.status,
      txHash,
      settled,
      delivered,
      feePaid: settlement?.feePaid ?? null,
      ...(settlement ? { note: settlement.detail } : {}),
    });
    return {
      serviceId: id,
      result: "sent",
      httpStatus: res.status,
      txHash,
      txHashSource,
      settled,
      delivered,
      bodySha256: buf ? createHash("sha256").update(buf).digest("hex") : null,
      bodyBytes: buf ? buf.length : null,
      contentType: res.headers.get("content-type"),
      latencyMs,
    };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    ledger.update(id, { status: "unknown", note: `after send: ${detail}` });
    return { serviceId: id, result: "unknown", detail, latencyMs: Date.now() - t0 };
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
