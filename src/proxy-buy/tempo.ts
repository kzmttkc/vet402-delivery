/**
 * Proxy buy on Tempo: the agent pays vet402 with an MPP tempo/charge credential (USDC.e, pull mode: the agent
 * signs, vet402 broadcasts), vet402 pays the seller with its own proxy wallet through the census payment path
 * (src/tempo/pay.ts payOne), and hands over the answer.
 *
 * Order (settle first):
 *   read the credential -> pull mode only -> read the seller's challenge again and price it again -> mppx
 *   validates the credential against exactly that price and target, without broadcasting -> take the payment key
 *   in the database (the signed transaction's signature) -> reserve the wallet and the day in the database ->
 *   mark "settling" -> mppx broadcasts and waits for the receipt -> read the agent's transfer on chain -> record
 *   the agent's transaction as used and the purchase as in progress -> payOne (vet402's signed payment to the
 *   seller is recorded in the database before it is handed over) -> answer.
 * A push credential (the agent already broadcast) is refused: its money would move before vet402 could re-check
 * the seller. After the broadcast: if vet402 did not pay the seller (payOne refused, or vet402's payment is proven
 * dead: past its validBefore with no receipt and no matching transfer), the agent is refunded; if the seller was
 * paid, there is no refund; if that cannot be told yet, the reconciler decides later.
 */
import { createHash } from "node:crypto";
import { Credential, Receipt } from "mppx";
import { Transaction } from "viem/tempo";
import { atomicToUnits, FEE_RESERVE_ATOMIC } from "../tempo/constants.js";
import { Ledger } from "../tempo/ledger.js";
import { payOne, type PayDeps, type PayOutcome } from "../tempo/pay.js";
import type { Signer } from "../tempo/chain.js";
import { ANSWER_LIMIT_NOTE, PROXY_MAX_FORWARD_BYTES, REFUND_POLICY } from "./constants.js";
import { decodeTempoTx, tempoTxFate, type Fate, type TempoReads, type TempoTxFacts } from "./fate.js";
import { noCharge, publicTarget, refundOwed, waitFate, type Common, type PaidAnswer } from "./flow.js";
import { refusalReason } from "./reasons.js";
import type { RefundSender } from "./refund.js";
import { utcDay, type PurchaseRecord } from "./store.js";
import { totalAtomic, type TempoOffer } from "./quote.js";

/** The subset of an mppx server instance proxy buy uses. */
export interface MppServer {
  /** mppx `charge(options)(request)`: a 402 challenge for this price. */
  challenge(request: Request, route: { amount: string; externalId: string; expires: string }): Promise<Response>;
  validateCredential(credential: string, options: { request: { amount: string; externalId: string } }): Promise<{ details?: unknown }>;
  broadcastCredential(credential: string, options: { request: { amount: string; externalId: string } }): Promise<{ reference: string; status: string }>;
}

export interface TempoSide {
  receive: string;
  payer: string;
  mpp: MppServer;
  /** src/tempo/pay.ts dependencies for the proxy payer (ledger, chainSpent, onBody and payer are set per purchase). */
  pay: Omit<PayDeps, "ledger" | "chainSpent" | "onBody" | "payer">;
  head: () => Promise<bigint>;
  reads: TempoReads;
  /** The agent's transfer, read on chain: success and exactly `amount` from `sender` into `receive`. */
  confirmCustomer: (tx: string, sender: string, amount: bigint) => Promise<{ ok: true } | { ok: false; detail: string; definite: boolean }>;
  /** Send `amount` USDC.e from the proxy payer to `to` (refund.ts sendTempoRefund). */
  refund: RefundSender;
}

export interface TempoContext extends Common {
  side: TempoSide;
}

/**
 * The route values bound into the challenge (mppx checks them with the challenge HMAC): the total price, and the
 * target through externalId, so a credential signed for one seller cannot buy from another.
 */
export function tempoRoute(offer: TempoOffer, feeAtomic: bigint, target: string): { amount: string; externalId: string } {
  const total = totalAtomic(offer.sellerAtomic, feeAtomic);
  return { amount: atomicToUnits(total), externalId: `vet402-buy:${createHash("sha256").update(target).digest("hex").slice(0, 32)}` };
}

/** Replay key: the signature of the signed transaction (the same transaction in another hex case or encoding has the same key). */
export function tempoPaymentKey(signedTx: string): string {
  let material = `raw:${signedTx.toLowerCase()}`;
  try {
    const t = Transaction.deserialize(signedTx as `0x76${string}`) as { signature?: { r?: unknown; s?: unknown } };
    if (t.signature && t.signature.r !== undefined && t.signature.s !== undefined) material = `sig:${String(t.signature.r)}:${String(t.signature.s)}`.toLowerCase();
  } catch {
    /* undecodable: mppx refuses it; key it by the raw text */
  }
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

function recordBase(ctx: TempoContext, id: string, target: string, offer: TempoOffer, total: bigint, tx: string | null, payer: string | null): PurchaseRecord {
  return {
    id,
    chain: "tempo",
    at: ctx.now().toISOString(),
    target: publicTarget(target),
    seller: { host: offer.known.host, payTo: offer.request.recipient!.toLowerCase(), priceAtomic: offer.request.amount },
    feeAtomic: ctx.feeAtomic.toString(),
    totalAtomic: total.toString(),
    customer: { tx, payer, confirmed: false },
    sellerPayment: null,
    answer: null,
    outcome: "in_progress",
    reason: null,
    refund: "none",
  };
}

export async function payTempo(ctx: TempoContext, target: string, offer: TempoOffer, authorization: string): Promise<PaidAnswer> {
  const { store, side } = ctx;
  let cred: { payload?: { type?: unknown; signature?: unknown } };
  try {
    cred = Credential.deserialize(authorization) as typeof cred;
  } catch {
    return noCharge(400, "malformed_payment", "Authorization is not a readable MPP credential");
  }
  if (cred.payload?.type !== "transaction" || typeof cred.payload.signature !== "string") {
    return noCharge(400, "pull_only", "proxy buy accepts a signed transaction for vet402 to broadcast (pull mode) only; a transaction you already broadcast would move money before vet402 re-checks the seller");
  }
  const signedTx = cred.payload.signature;
  const agentTx = decodeTempoTx(signedTx);
  if (!agentTx || agentTx.sponsored) return noCharge(400, "malformed_payment", "the credential does not carry a self-paid Tempo transaction");
  const route = tempoRoute(offer, ctx.feeAtomic, target);
  try {
    await side.mpp.validateCredential(authorization, { request: route });
  } catch {
    return noCharge(402, "price_changed_or_invalid", "the credential is not for the price and seller read just now, has expired, or does not simulate; ask for the price again. Nothing was charged");
  }
  const sender = agentTx.from; // mppx checked that the transfer comes from the transaction's signer

  const id = tempoPaymentKey(signedTx);
  const seller = offer.sellerAtomic;
  const total = totalAtomic(seller, ctx.feeAtomic);
  const feeReserve = offer.request.feePayer ? 0n : FEE_RESERVE_ATOMIC;
  const now = ctx.now();
  // An earlier purchase from this agent or to this seller that stopped half way is settled first; others go on.
  if ((await store.blockingFor(now, ctx.staleMs, { agent: sender, host: offer.known.host })) > 0) {
    return noCharge(503, "reconcile_pending", "an earlier purchase from this payer or to this seller is being settled on chain first; nothing was charged, try again later");
  }
  if (!(await store.claim({ id, chain: "tempo", target, sellerHost: offer.known.host, agent: sender, sellerAmount: seller, feeReserve, total, facts: { agent: { ...agentTx, search: { recipient: side.receive.toLowerCase(), amount: total.toString(), fromBlock: "0" } } }, now }))) {
    return noCharge(409, "duplicate_payment", "this signed transaction was already used or is being used now");
  }
  let bal: bigint;
  let fromBlock: bigint;
  const balanceReadAt = ctx.now();
  try {
    bal = await side.pay.balance();
    fromBlock = await side.head();
  } catch {
    await store.release(id);
    return noCharge(503, "ledger_unreadable", "the proxy wallet could not be read on chain; nothing was charged");
  }
  const day = utcDay(now);
  // The wallet reservation is the most this purchase can take out: a refund of the total plus its fee (>= the seller price + fee).
  const need = total + FEE_RESERVE_ATOMIC > seller + feeReserve ? total + FEE_RESERVE_ATOMIC : seller + feeReserve;
  const room = await store.admit(id, { chain: "tempo", payer: side.payer, day, caps: ctx.caps, need, balance: bal, balanceReadAt, now });
  if (!room.ok) {
    await store.release(id);
    return noCharge(503, room.reason, room.detail);
  }

  // ---- from here the agent's money may move: the key is spent for good ----
  if (!(await store.move(id, ["admitted"], "settling", { facts: { agent: { ...agentTx, search: { recipient: side.receive.toLowerCase(), amount: total.toString(), fromBlock: fromBlock.toString() } } }, now: ctx.now() }))) {
    return noCharge(409, "duplicate_payment", "this payment moved on in another request");
  }
  const unknownBase = recordBase(ctx, id, target, offer, total, null, sender);
  let receipt: { reference: string; status: string };
  try {
    receipt = await side.mpp.broadcastCredential(authorization, { request: route });
  } catch {
    const r: PurchaseRecord = { ...unknownBase, outcome: "customer_payment_unconfirmed", reason: "broadcast_error" };
    await store.move(id, ["settling"], "settling", { record: r, now: ctx.now() });
    return { kind: "json", status: 502, body: { error: "customer_payment_unconfirmed", reason: r.reason, record: ctx.recordUrl(id), charged: "unknown", refund: "pending_reconcile" }, headers: { "x-vet402-record": ctx.recordUrl(id) } };
  }
  const base = recordBase(ctx, id, target, offer, total, receipt.reference, sender);
  const paidHeaders = {
    "payment-receipt": Receipt.serialize({ method: "tempo", status: "success", timestamp: new Date().toISOString(), reference: receipt.reference } as never),
    "x-vet402-customer-tx": receipt.reference,
    "x-vet402-record": ctx.recordUrl(id),
  };
  const conf = await side.confirmCustomer(receipt.reference, sender, total).catch(() => ({ ok: false as const, detail: "confirm_error", definite: false }));
  if (!conf.ok) {
    if (conf.definite) {
      await store.finish(id, ["settling"], { record: { ...base, outcome: "no_charge", reason: conf.detail }, spent: 0n, now: ctx.now() });
      return noCharge(402, "customer_payment_failed", conf.detail);
    }
    const r: PurchaseRecord = { ...base, outcome: "customer_payment_unconfirmed", reason: conf.detail };
    await store.move(id, ["settling"], "settling", { record: r, now: ctx.now() });
    return { kind: "json", status: 502, body: { error: "customer_payment_unconfirmed", reason: r.reason, record: ctx.recordUrl(id), refund: "pending_reconcile" }, headers: paidHeaders };
  }
  base.customer.confirmed = true;
  if (!(await store.useCustomerTx(id, "tempo", receipt.reference, { facts: { customerTx: receipt.reference }, record: base, now: ctx.now() }))) {
    await store.finish(id, ["settling"], { record: { ...base, outcome: "duplicate_customer_tx", reason: "this on-chain payment already paid for a purchase" }, spent: 0n, now: ctx.now() });
    return { kind: "json", status: 409, body: { error: "duplicate_customer_tx", record: ctx.recordUrl(id), refund: "none" }, headers: paidHeaders };
  }
  const owe = (reason: string) => refundOwed(ctx, { id, chain: "tempo", day, from: ["in_progress"], base, reason, to: sender, total, send: side.refund, headers: paidHeaders });

  const recipient = offer.request.recipient!;
  const got: { body: Buffer | null; sellerTx: (TempoTxFacts & { search: { recipient: string; amount: string; fromBlock: string } }) | null } = { body: null, sellerTx: null };
  // vet402's signed payment to the seller is written to the database before payOne hands it over.
  const signer: Signer = {
    address: side.pay.signer.address,
    async credentialFor(res, challengeId, rcpt) {
      const out = await side.pay.signer.credentialFor(res, challengeId, rcpt);
      const f = decodeTempoTx(out.serializedTx);
      if (!f) throw new Error("seller payment not decodable");
      const head = await side.head();
      const sellerTx = { ...f, search: { recipient: rcpt.toLowerCase(), amount: offer.request.amount, fromBlock: head.toString() } };
      if (!(await store.move(id, ["in_progress"], "in_progress", { facts: { seller: sellerTx }, now: ctx.now() }))) throw new Error("purchase moved");
      got.sellerTx = sellerTx;
      return out;
    },
  };
  let out: PayOutcome;
  try {
    out = await payOne(
      {
        serviceId: id,
        request: { url: target, method: "GET", body: null, contentType: null, inputSource: "none" },
        lockedRecipient: recipient,
        lockedAmount: offer.request.amount,
        sponsored: offer.request.feePayer,
        allowlist: [],
      },
      {
        ...side.pay,
        signer,
        payer: side.payer,
        // A single-purchase ledger: the caps and the wallet check are in the database, before the agent paid.
        ledger: new Ledger(null, side.payer, seller + FEE_RESERVE_ATOMIC),
        chainSpent: async () => 0n,
        onBody: (b) => {
          got.body = b;
        },
      },
    );
  } catch {
    // payOne catches everything after the credential is handed over: a throw comes from before (a read, the database write).
    return owe("seller_payment_error");
  }
  if (out.result === "refused") return owe(out.refusal ? refusalReason(out.refusal) : "refused");

  const buf = got.body;
  const status = out.httpStatus ?? null;
  const tooLarge = !!buf && buf.byteLength > PROXY_MAX_FORWARD_BYTES;
  const delivered = out.result === "sent" && status !== null && status >= 200 && status < 300 && buf !== null && buf.byteLength > 0 && !tooLarge;
  let sellerSettled: boolean | null = out.settled === true ? true : null;
  let sellerTx = out.txHash ?? null;
  if (sellerSettled !== true && !delivered) {
    const f: Fate = got.sellerTx ? await waitFate(ctx, () => tempoTxFate(side.reads, got.sellerTx!)) : { fate: "pending" };
    if (f.fate === "dead" || f.fate === "failed") return owe(f.fate === "dead" ? "seller_payment_expired_unsent" : "seller_payment_failed_on_chain");
    if (f.fate === "landed") {
      sellerSettled = true;
      sellerTx = f.tx;
    } else {
      const r: PurchaseRecord = {
        ...base,
        sellerPayment: { tx: sellerTx, settled: null },
        answer: { httpStatus: status, delivered: false, bodySha256: out.bodySha256 ?? null, bodyBytes: out.bodyBytes ?? null, contentType: out.contentType ?? null },
        outcome: "seller_payment_pending",
        reason: `seller answered ${status ?? "nothing"}; payment not settled yet`,
      };
      await store.move(id, ["in_progress"], "seller_unsettled", { record: r, now: ctx.now() });
      return { kind: "json", status: 502, body: { error: "seller_payment_pending", reason: r.reason, record: ctx.recordUrl(id), refund: "pending_reconcile", note: "if vet402's payment to the seller never settles, the reconciler refunds you" }, headers: paidHeaders };
    }
  }
  const answer = { httpStatus: status, delivered, bodySha256: out.bodySha256 ?? null, bodyBytes: out.bodyBytes ?? null, contentType: out.contentType ?? null };
  const headers = {
    ...paidHeaders,
    ...(sellerTx ? { "x-vet402-seller-tx": sellerTx } : {}),
    "x-vet402-seller-settled": String(sellerSettled ?? "unknown"),
    "x-vet402-seller-status": String(status ?? ""),
  };
  const sellerPayment = { tx: sellerTx, settled: sellerSettled };
  const spent = seller + feeReserve;
  if (tooLarge) {
    const r: PurchaseRecord = { ...base, sellerPayment, answer, outcome: "answer_too_large", reason: `answer above ${PROXY_MAX_FORWARD_BYTES} bytes` };
    await store.finish(id, ["in_progress"], { record: r, spent, now: ctx.now() });
    return { kind: "json", status: 502, body: { error: "answer_too_large", record: ctx.recordUrl(id), refund: "none" }, headers };
  }
  const r: PurchaseRecord = {
    ...base,
    sellerPayment,
    answer,
    outcome: delivered ? "delivered" : "not_delivered",
    reason: delivered ? null : `seller answered ${status ?? "nothing"}${buf && buf.byteLength === 0 ? " with an empty body" : ""}; vet402's payment to it settled`,
  };
  // A failed closing write must not lose an answer vet402 paid for: the reconciler closes the purchase later.
  await store.finish(id, ["in_progress"], { record: r, spent, now: ctx.now() }).catch(() => false);
  if (!delivered) {
    return {
      kind: "json",
      status: 502,
      body: { error: "not_delivered", sellerStatus: status, sellerAnswer: buf ? buf.subarray(0, 300).toString("utf8") : null, record: ctx.recordUrl(id), refund: "none", note: "vet402 paid the seller; no refund" },
      headers,
    };
  }
  return {
    kind: "answer",
    status: 200,
    body: new Uint8Array(buf!),
    headers: { ...headers, "content-type": answer.contentType ?? "application/octet-stream", "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'" },
  };
}

export function tempoPriceInfo(offer: TempoOffer, feeAtomic: bigint) {
  const total = totalAtomic(offer.sellerAtomic, feeAtomic);
  return {
    pay: "MPP tempo/charge, USDC.e on Tempo mainnet (4217), pull mode; your own Tempo fee",
    sellerPrice: atomicToUnits(offer.sellerAtomic),
    fee: atomicToUnits(feeAtomic),
    total: atomicToUnits(total),
    sellerPayTo: offer.request.recipient,
    refund: REFUND_POLICY,
    largeAnswers: ANSWER_LIMIT_NOTE,
    vet402Record: { settledPurchases: offer.known.settled, delivered: offer.known.delivered, lastAt: offer.known.lastAt },
  };
}
