/**
 * Proxy buy on Tempo: the agent pays vet402 with an MPP tempo/charge credential (USDC.e, pull mode:
 * the agent signs, vet402 broadcasts), vet402 pays the seller with its own proxy wallet through the
 * census payment path (src/tempo/pay.ts payOne), and hands over the answer.
 *
 * Order (settle first):
 *   read the credential -> pull mode only -> read the seller's challenge again and price it again ->
 *   mppx validates the credential against exactly that price and target (HMAC-bound challenge, amount,
 *   externalId, recipient, memo, simulated transfer), without broadcasting -> take the payment key (the
 *   signed transaction's signature: a replay guard that re-encoding cannot dodge) -> check the day's
 *   headroom, including what a refund would need -> mppx broadcasts and waits for the receipt -> read the
 *   agent's transfer on chain -> record the agent's transaction as used (once only) -> payOne (which reads
 *   the seller's challenge again and refuses a raised price or a changed recipient before signing) -> answer.
 * A push credential (the agent already broadcast) is refused: its money would move before vet402 could
 * re-check the seller. After the broadcast: if vet402 did not pay the seller, the agent's payment is
 * refunded to the address that paid; if the seller was paid and did not deliver, there is no refund.
 */
import { createHash } from "node:crypto";
import { Credential, Receipt } from "mppx";
import { Transaction } from "viem/tempo";
import { atomicToUnits, FEE_RESERVE_ATOMIC } from "../tempo/constants.js";
import { payOne, type PayDeps, type PayOutcome } from "../tempo/pay.js";
import type { Books, PurchaseRecord } from "./books.js";
import { PROXY_MAX_FORWARD_BYTES, REFUND_POLICY } from "./constants.js";
import { refusalReason } from "./reasons.js";
import { refundAgent, type RefundOutcome } from "./refund.js";
import { totalAtomic, type TempoOffer } from "./quote.js";
import type { PaidAnswer } from "./solana.js";

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
  /** USDC.e that left the proxy payer from `fromBlock` on (refunds included; the books subtract them). */
  outflowSince: (fromBlock: bigint) => Promise<bigint>;
  head: () => Promise<bigint>;
  /** The agent's transfer, read on chain: success and exactly `amount` from `payer` into `receive`. Fixed reason codes only. */
  confirmCustomer: (tx: string, payer: string | null, amount: bigint) => Promise<{ ok: true } | { ok: false; detail: string }>;
  /** Send `amount` USDC.e from the proxy payer to `to` (src/proxy-buy/refund.ts sendTempoRefund). */
  refund: (to: string, amount: bigint) => Promise<RefundOutcome>;
}

export interface TempoContext {
  side: TempoSide;
  books: Books;
  feeAtomic: bigint;
  now: () => Date;
  recordUrl: (id: string) => string;
}

/**
 * The route values bound into the challenge (mppx checks them with the challenge HMAC): the total price,
 * and the target through externalId, so a credential signed for one seller cannot buy from another.
 */
export function tempoRoute(offer: TempoOffer, feeAtomic: bigint, target: string): { amount: string; externalId: string } {
  const total = totalAtomic(offer.sellerAtomic, feeAtomic);
  return { amount: atomicToUnits(total), externalId: `vet402-buy:${createHash("sha256").update(target).digest("hex").slice(0, 32)}` };
}

/** Replay key: the signature of the signed transaction (the same transaction in another hex case or envelope has the same key). */
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

const noCharge = (status: number, reason: string, detail: string): PaidAnswer => ({
  kind: "refuse",
  status,
  body: { verdict: "REFUSE", reason, detail, charged: false },
});

export async function payTempo(ctx: TempoContext, target: string, offer: TempoOffer, authorization: string): Promise<PaidAnswer> {
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
  const route = tempoRoute(offer, ctx.feeAtomic, target);
  let validation: { details?: unknown };
  try {
    validation = await ctx.side.mpp.validateCredential(authorization, { request: route });
  } catch {
    // mppx's message can quote the RPC (simulation): a fixed code only.
    return noCharge(402, "price_changed_or_invalid", "the credential is not for the price and seller read just now, has expired, or does not simulate; ask for the price again. Nothing was charged");
  }
  const sender = senderOf(validation.details);

  const key = tempoPaymentKey(signedTx);
  const seller = offer.sellerAtomic;
  const total = totalAtomic(seller, ctx.feeAtomic);
  const feeReserve = offer.request.feePayer ? 0n : FEE_RESERVE_ATOMIC;
  if (!ctx.books.claim(key, "tempo", seller, feeReserve)) {
    return noCharge(409, "duplicate_payment", "this signed transaction was already used or is being used now");
  }
  try {
    let room;
    try {
      room = await ctx.books.tempoHeadroom(ctx.now(), ctx.side.head, key, { amount: seller, feeReserve, refundTotal: total }, { spentSinceStart: ctx.side.outflowSince, balance: ctx.side.pay.balance });
    } catch {
      ctx.books.unclaim(key);
      return noCharge(503, "ledger_unreadable", "the proxy wallet could not be read on chain; nothing was charged");
    }
    if (!room.ok) {
      ctx.books.unclaim(key);
      return noCharge(503, room.reason, room.detail);
    }
    const day = room.day; // this purchase stays on this day's ledger until it is over

    // ---- from here the agent's money may move: the key is spent for good ----
    ctx.books.burn(key);
    let receipt: { reference: string; status: string };
    try {
      receipt = await ctx.side.mpp.broadcastCredential(authorization, { request: route });
    } catch {
      const r: PurchaseRecord = { ...recordBase(ctx, key, target, offer, total, null, sender), outcome: "customer_payment_unconfirmed", reason: "broadcast_error" };
      ctx.books.record(r);
      return { kind: "json", status: 502, body: { error: "customer_payment_unconfirmed", reason: r.reason, record: ctx.recordUrl(key), charged: "unknown", refund: "none" }, headers: { "x-vet402-record": ctx.recordUrl(key) } };
    }
    const base = recordBase(ctx, key, target, offer, total, receipt.reference, sender);
    const paidHeaders = {
      "payment-receipt": Receipt.serialize({ method: "tempo", status: "success", timestamp: new Date().toISOString(), reference: receipt.reference } as never),
      "x-vet402-customer-tx": receipt.reference,
      "x-vet402-record": ctx.recordUrl(key),
    };
    const conf = await ctx.side.confirmCustomer(receipt.reference, sender, total).catch(() => ({ ok: false as const, detail: "confirm_error" }));
    if (!conf.ok) {
      const r: PurchaseRecord = { ...base, outcome: "customer_payment_unconfirmed", reason: conf.detail };
      ctx.books.record(r);
      return { kind: "json", status: 502, body: { error: "customer_payment_unconfirmed", reason: r.reason, record: ctx.recordUrl(key), refund: "none" }, headers: paidHeaders };
    }
    base.customer.confirmed = true;
    if (!ctx.books.useCustomerTx("tempo", receipt.reference)) {
      const r: PurchaseRecord = { ...base, outcome: "duplicate_customer_tx", reason: "this on-chain payment already paid for a purchase" };
      ctx.books.record(r);
      return { kind: "json", status: 409, body: { error: "duplicate_customer_tx", record: ctx.recordUrl(key), refund: "none" }, headers: paidHeaders };
    }

    const refundIfUnpaid = async (reason: string): Promise<PaidAnswer> => {
      const refund = await refundAgent(ctx.books, ctx.side.refund, { key, chain: "tempo", day: day.day, to: sender, amount: total, now: ctx.now });
      const r: PurchaseRecord = { ...base, outcome: "seller_not_paid", reason, refund };
      ctx.books.record(r);
      return {
        kind: "json",
        status: 502,
        body: { error: "seller_not_paid", reason, refund, record: ctx.recordUrl(key) },
        headers: { ...paidHeaders, ...(refund.tx ? { "x-vet402-refund-tx": refund.tx } : {}) },
      };
    };

    const recipient = offer.request.recipient!;
    const got: { body: Buffer | null } = { body: null };
    let out: PayOutcome;
    try {
      out = await payOne(
        {
          serviceId: key, // the Ledger key: one purchase per agent payment
          request: { url: target, method: "GET", body: null, contentType: null, inputSource: "none" },
          lockedRecipient: recipient,
          lockedAmount: offer.request.amount,
          sponsored: offer.request.feePayer,
          allowlist: [],
        },
        {
          ...ctx.side.pay,
          payer: ctx.side.payer,
          ledger: day.ledger,
          chainSpent: () => ctx.books.tempoSpentForLedger(day, ctx.side.outflowSince),
          onBody: (b) => {
            got.body = b;
          },
        },
      );
    } catch {
      // payOne catches everything after the credential is sent: a throw comes from before (a chain read, a ledger write).
      return refundIfUnpaid("seller_payment_error");
    }
    if (out.result === "refused") return refundIfUnpaid(out.refusal ? refusalReason(out.refusal) : "refused");

    const buf = got.body;
    const answer = {
      httpStatus: out.httpStatus ?? null,
      delivered: out.delivered ?? null,
      bodySha256: out.bodySha256 ?? null,
      bodyBytes: out.bodyBytes ?? null,
      contentType: out.contentType ?? null,
    };
    const headers = {
      ...paidHeaders,
      ...(out.txHash ? { "x-vet402-seller-tx": out.txHash } : {}),
      "x-vet402-seller-settled": String(out.settled ?? "unknown"),
      "x-vet402-seller-status": String(out.httpStatus ?? ""),
    };
    const sellerPayment = { tx: out.txHash ?? null, settled: out.settled ?? null };
    if (out.result === "unknown") {
      // The credential left vet402: the seller may have been paid. No refund on an unknown.
      const r: PurchaseRecord = { ...base, sellerPayment, answer, outcome: "seller_payment_unknown", reason: "outcome_unknown_after_send" };
      ctx.books.record(r);
      return { kind: "json", status: 502, body: { error: "seller_payment_unknown", reason: r.reason, record: ctx.recordUrl(key), refund: "none" }, headers };
    }
    if (buf && buf.byteLength > PROXY_MAX_FORWARD_BYTES) {
      const r: PurchaseRecord = { ...base, sellerPayment, answer, outcome: "answer_too_large", reason: `answer above ${PROXY_MAX_FORWARD_BYTES} bytes` };
      ctx.books.record(r);
      return { kind: "json", status: 502, body: { error: "answer_too_large", record: ctx.recordUrl(key), refund: "none" }, headers };
    }
    const status = out.httpStatus ?? null;
    const delivered = status !== null && status >= 200 && status < 300 && buf !== null && buf.byteLength > 0;
    const r: PurchaseRecord = {
      ...base,
      sellerPayment,
      answer: { ...answer, delivered },
      outcome: delivered ? "delivered" : "not_delivered",
      reason: delivered ? null : `seller answered ${status ?? "nothing"}${buf && buf.byteLength === 0 ? " with an empty body" : ""}`,
    };
    ctx.books.record(r);
    if (!delivered) {
      return {
        kind: "json",
        status: 502,
        body: { error: "not_delivered", sellerStatus: status, sellerAnswer: buf ? buf.subarray(0, 300).toString("utf8") : null, record: ctx.recordUrl(key), refund: "none" },
        headers,
      };
    }
    return {
      kind: "answer",
      status: 200,
      body: new Uint8Array(buf!),
      headers: {
        ...headers,
        "content-type": answer.contentType ?? "application/octet-stream",
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox; default-src 'none'",
      },
    };
  } finally {
    ctx.books.done(key);
  }
}

function senderOf(details: unknown): string | null {
  const s = (details as { sender?: unknown } | undefined)?.sender;
  return typeof s === "string" ? s : null;
}

function recordBase(ctx: TempoContext, key: string, target: string, offer: TempoOffer, total: bigint, tx: string | null, payer: string | null): PurchaseRecord {
  return {
    id: key,
    chain: "tempo",
    at: ctx.now().toISOString(),
    target,
    seller: { host: offer.known.host, payTo: offer.request.recipient!.toLowerCase(), priceAtomic: offer.request.amount },
    feeAtomic: ctx.feeAtomic.toString(),
    totalAtomic: total.toString(),
    customer: { tx, payer, confirmed: false },
    sellerPayment: null,
    answer: null,
    outcome: "seller_not_paid",
    reason: null,
    refund: "none",
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
    vet402Record: { settledPurchases: offer.known.settled, delivered: offer.known.delivered, lastAt: offer.known.lastAt },
  };
}
