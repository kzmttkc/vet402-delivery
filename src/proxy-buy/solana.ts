/**
 * Proxy buy on Solana: the agent pays vet402 with x402 (exact, USDC), vet402 pays the seller with its
 * own proxy wallet through the census payment path (src/pay.ts payOne), and hands over the answer.
 *
 * Order (settle first, as in vet402-algorand's /v1/buy):
 *   decode the agent's payment -> read the seller's 402 again and price it again -> the payment must be
 *   for exactly that price (x402 v2 deep equality of `accepted`) -> take the payment key (the signed
 *   transaction's message: a replay guard that re-encoding cannot dodge) -> check the day's headroom,
 *   including what a refund would need -> facilitator verify -> facilitator settle -> read the agent's
 *   transfer on chain -> record the agent's transaction as used (once only) -> payOne (which reads the
 *   seller's 402 a third time and refuses a raised price or a changed payTo before signing) -> answer.
 * Every refusal before settle costs the agent nothing. After settle: if vet402 did not pay the seller,
 * the agent's payment is refunded to the address that paid; if the seller was paid and did not deliver,
 * there is no refund and the record says so.
 */
import { createHash } from "node:crypto";
import { getBase64Encoder, getTransactionDecoder } from "@solana/kit";
import type { x402ResourceServer } from "@x402/core/server";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { SOLANA_MAINNET, USDC_MINT, atomicToUsdc } from "../constants.js";
import { payOne, type PayDeps, type PurchaseRecord as PayRecord } from "../pay.js";
import type { Books, PurchaseRecord } from "./books.js";
import { OFFER_TTL_SECONDS, PROXY_MAX_FORWARD_BYTES, REFUND_POLICY } from "./constants.js";
import { redact, refusalReason } from "./reasons.js";
import { refundAgent, type RefundOutcome } from "./refund.js";
import { totalAtomic, type SolanaOffer } from "./quote.js";

export interface SolanaSide {
  /** Where agents pay (USDC ATA must exist). Its key is not on the server. */
  receive: string;
  /** vet402's proxy payer. Pays sellers and refunds only. */
  payer: string;
  resourceServer: x402ResourceServer;
  /** src/pay.ts dependencies for the proxy payer (budget, judge, payer and the body hooks are set per purchase). */
  pay: Omit<PayDeps, "budget" | "judge" | "payer" | "onBody" | "maxBodyBytes">;
  /** The agent's transfer, read on chain: success and exactly `amount` into `receive`. Fixed reason codes only. */
  confirmCustomer: (tx: string, payer: string | null, amount: bigint) => Promise<{ ok: true } | { ok: false; detail: string }>;
  /** Send `amount` USDC from the proxy payer to `to` (src/proxy-buy/refund.ts sendSolanaRefund). */
  refund: (to: string, amount: bigint) => Promise<RefundOutcome>;
}

export interface SolanaContext {
  side: SolanaSide;
  books: Books;
  feeAtomic: bigint;
  now: () => Date;
  recordUrl: (id: string) => string;
  resourceUrl: string;
}

let initFor = new WeakMap<x402ResourceServer, Promise<void>>();

/** Read the facilitator's /supported once per resource server; a failed read is retried by the next call. */
export async function ensureInit(rs: x402ResourceServer): Promise<void> {
  let p = initFor.get(rs);
  if (!p) {
    p = rs.initialize().catch((e) => {
      initFor.delete(rs);
      throw e;
    });
    initFor.set(rs, p);
  }
  await p;
}

/** Test hook: forget cached initialisations. */
export function resetInit(): void {
  initFor = new WeakMap();
}

export async function solanaRequirements(ctx: SolanaContext, offer: SolanaOffer, target: string): Promise<PaymentRequirements[]> {
  const rs = ctx.side.resourceServer;
  await ensureInit(rs);
  const total = totalAtomic(offer.sellerAtomic, ctx.feeAtomic);
  return rs.buildPaymentRequirements({
    scheme: "exact",
    network: SOLANA_MAINNET,
    payTo: ctx.side.receive,
    price: { amount: total.toString(), asset: USDC_MINT },
    maxTimeoutSeconds: OFFER_TTL_SECONDS,
    extra: {
      target,
      sellerAmount: offer.accept.amount,
      sellerPayTo: offer.accept.payTo,
      buyFee: ctx.feeAtomic.toString(),
    },
  });
}

/** The PAYMENT-REQUIRED header value for these requirements. */
export async function paymentRequiredHeader(ctx: SolanaContext, reqs: PaymentRequirements[], description: string, error?: string): Promise<string> {
  const pr = await ctx.side.resourceServer.createPaymentRequiredResponse(reqs, { url: ctx.resourceUrl, description, mimeType: "application/octet-stream" }, error);
  return encodePaymentRequiredHeader(pr);
}

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex").slice(0, 32);

/**
 * Replay key of an x402 SVM payment: the signed transaction's message bytes. The same transaction under
 * another JSON encoding, extra payload fields or another header encoding has the same key.
 */
export function solanaPaymentKey(p: PaymentPayload): string {
  const tx = (p.payload as { transaction?: unknown } | undefined)?.transaction;
  if (typeof tx === "string") {
    try {
      return sha(Uint8Array.from(getTransactionDecoder().decode(getBase64Encoder().encode(tx)).messageBytes));
    } catch {
      /* not a transaction: verify refuses it; key it by the raw payload */
    }
  }
  return sha(`raw:${JSON.stringify(p.payload)}`);
}

export type PaidAnswer =
  | { kind: "refuse"; status: number; body: Record<string, unknown>; headers?: Record<string, string> }
  | { kind: "answer"; status: number; body: Uint8Array; headers: Record<string, string> }
  | { kind: "json"; status: number; body: Record<string, unknown>; headers: Record<string, string> };

const noCharge = (status: number, reason: string, detail: string, extra: Record<string, unknown> = {}): PaidAnswer => ({
  kind: "refuse",
  status,
  body: { verdict: "REFUSE", reason, detail, charged: false, ...extra },
});

/**
 * One paid Solana request. `offer` comes from the seller's 402 read for this request, `header` is the
 * agent's PAYMENT-SIGNATURE.
 */
export async function paySolana(ctx: SolanaContext, target: string, offer: SolanaOffer, header: string): Promise<PaidAnswer> {
  const rs = ctx.side.resourceServer;
  let payload: PaymentPayload;
  try {
    payload = decodePaymentSignatureHeader(header);
  } catch {
    return noCharge(400, "malformed_payment", "PAYMENT-SIGNATURE is not a readable x402 payment");
  }
  if (payload.x402Version !== 2) return noCharge(400, "unsupported_x402_version", "proxy buy accepts x402 v2 payments only");

  let reqs: PaymentRequirements[];
  try {
    reqs = await solanaRequirements(ctx, offer, target);
  } catch {
    return noCharge(502, "facilitator_unavailable", "the facilitator could not be read; nothing was charged");
  }
  const req = rs.findMatchingRequirements(reqs, payload);
  if (!req) {
    // The seller's price or payTo moved since the agent signed, or the payment is for something else.
    const h = await paymentRequiredHeader(ctx, reqs, "price changed: sign again for this price", "price_changed").catch(() => null);
    return {
      kind: "refuse",
      status: 402,
      body: { verdict: "REFUSE", reason: "price_changed", charged: false, detail: "the payment is not for the price read from the seller just now; nothing was charged" },
      ...(h ? { headers: { "PAYMENT-REQUIRED": h } } : {}),
    };
  }

  const key = solanaPaymentKey(payload);
  const seller = offer.sellerAtomic;
  const total = BigInt(req.amount);
  if (!ctx.books.claim(key, "solana", seller, 0n)) {
    return noCharge(409, "duplicate_payment", "this signed transaction was already used or is being used now");
  }
  try {
    let bal: { usdcAtomic: bigint; lamports: bigint };
    try {
      bal = await ctx.side.pay.readBalances();
    } catch {
      ctx.books.unclaim(key);
      return noCharge(503, "ledger_unreadable", "the proxy wallet could not be read on chain; nothing was charged");
    }
    const room = ctx.books.solanaHeadroom(ctx.now(), bal, key, seller, total);
    if (!room.ok) {
      ctx.books.unclaim(key);
      return noCharge(503, room.reason, room.detail);
    }
    const day = room.day; // this purchase stays on this day's ledger until it is over
    let v;
    try {
      v = await rs.verifyPayment(payload, req);
    } catch {
      ctx.books.unclaim(key);
      return noCharge(502, "verify_failed", "the facilitator could not verify the payment; nothing was charged");
    }
    if (!v.isValid) {
      ctx.books.unclaim(key);
      return noCharge(402, "invalid_payment", redact(v.invalidReason ?? "the facilitator did not accept this payment"));
    }

    // ---- from here the agent's money may move: the key is spent for good ----
    ctx.books.burn(key);
    let settled: SettleResponse;
    try {
      settled = await rs.settlePayment(payload, req);
    } catch {
      // The facilitator may or may not have broadcast: record it, never pay the seller on an unknown.
      const r: PurchaseRecord = { ...recordBase(ctx, key, target, offer, total, null, v.payer ?? null), outcome: "customer_payment_unconfirmed", reason: "settle_error" };
      ctx.books.record(r);
      return { kind: "json", status: 502, body: { error: "customer_payment_unconfirmed", reason: r.reason, record: ctx.recordUrl(key), charged: "unknown", refund: "none" }, headers: { "x-vet402-record": ctx.recordUrl(key) } };
    }
    if (!settled.success) return noCharge(402, "customer_settlement_failed", redact(settled.errorReason ?? "settlement failed"));

    const agentAddr = settled.payer || v.payer || null;
    const base = recordBase(ctx, key, target, offer, total, settled.transaction, agentAddr);
    const paidHeaders = { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled), "x-vet402-customer-tx": settled.transaction, "x-vet402-record": ctx.recordUrl(key) };

    const conf = await ctx.side.confirmCustomer(settled.transaction, agentAddr, total).catch(() => ({ ok: false as const, detail: "confirm_error" }));
    if (!conf.ok) {
      const r: PurchaseRecord = { ...base, outcome: "customer_payment_unconfirmed", reason: conf.detail };
      ctx.books.record(r);
      return { kind: "json", status: 502, body: { error: "customer_payment_unconfirmed", reason: r.reason, record: ctx.recordUrl(key), refund: "none" }, headers: paidHeaders };
    }
    base.customer.confirmed = true;
    // Right before anything is paid for it: one purchase per settled on-chain transaction.
    if (!ctx.books.useCustomerTx("solana", settled.transaction)) {
      const r: PurchaseRecord = { ...base, outcome: "duplicate_customer_tx", reason: "this on-chain payment already paid for a purchase" };
      ctx.books.record(r);
      return { kind: "json", status: 409, body: { error: "duplicate_customer_tx", record: ctx.recordUrl(key), refund: "none" }, headers: paidHeaders };
    }

    const refundIfUnpaid = async (reason: string, outcome: "seller_not_paid"): Promise<PaidAnswer> => {
      const refund = await refundAgent(ctx.books, ctx.side.refund, { key, chain: "solana", day: day.day, to: agentAddr, amount: total, now: ctx.now });
      const r: PurchaseRecord = { ...base, outcome, reason, refund };
      ctx.books.record(r);
      return {
        kind: "json",
        status: 502,
        body: { error: outcome, reason, refund, record: ctx.recordUrl(key) },
        headers: { ...paidHeaders, ...(refund.tx ? { "x-vet402-refund-tx": refund.tx } : {}) },
      };
    };

    // The seller: through the census payment path, with the proxy wallet and this purchase's day Budget.
    const got: { body: Uint8Array | null; truncated: boolean } = { body: null, truncated: false };
    let rec: PayRecord;
    try {
      rec = await payOne(
        {
          host: key, // the Budget key: one purchase per agent payment
          requestUrl: target,
          exampleInput: null,
          lock: { payTo: offer.accept.payTo, amount: offer.accept.amount, asset: USDC_MINT, network: SOLANA_MAINNET, feePayer: String(offer.accept.extra?.feePayer ?? "") },
        },
        {
          ...ctx.side.pay,
          payer: ctx.side.payer,
          budget: day.budget,
          maxBodyBytes: PROXY_MAX_FORWARD_BYTES,
          onBody: (bytes, truncated) => {
            got.body = bytes;
            got.truncated = truncated;
          },
          judge: (d) => {
            const delivered = d.status >= 200 && d.status < 300 && d.bodyText.trim().length > 0;
            return { delivered, reason: delivered ? "delivered" : `http_${d.status}`, summary: "", missingKeys: [] };
          },
        },
      );
    } catch {
      // payOne returns its refusals; a throw comes from before anything was signed (a ledger write or a chain read).
      return refundIfUnpaid("seller_payment_error", "seller_not_paid");
    }
    if (rec.outcome !== "sent") {
      return refundIfUnpaid(rec.refusal ? refusalReason(rec.refusal) : rec.outcome, "seller_not_paid");
    }

    const sellerTx = rec.signature ?? null;
    const bytes: Uint8Array | null = got.body;
    const status = rec.response?.status ?? null;
    const answer = {
      httpStatus: status,
      delivered: rec.delivered ?? null,
      bodySha256: bytes ? createHash("sha256").update(bytes).digest("hex") : null,
      bodyBytes: bytes ? bytes.byteLength : null,
      contentType: rec.response?.contentType ?? null,
    };
    const headers = {
      ...paidHeaders,
      ...(sellerTx ? { "x-vet402-seller-tx": sellerTx } : {}),
      "x-vet402-seller-settled": String(rec.settled ?? "unknown"),
      "x-vet402-seller-status": String(status ?? ""),
    };
    const sellerPayment = { tx: sellerTx, settled: rec.settled ?? null };
    if (got.truncated) {
      const r: PurchaseRecord = { ...base, sellerPayment, answer, outcome: "answer_too_large", reason: `answer above ${PROXY_MAX_FORWARD_BYTES} bytes` };
      ctx.books.record(r);
      return { kind: "json", status: 502, body: { error: "answer_too_large", record: ctx.recordUrl(key), refund: "none" }, headers };
    }
    const delivered = rec.delivered === true && bytes !== null && bytes.byteLength > 0;
    const r: PurchaseRecord = { ...base, sellerPayment, answer: { ...answer, delivered }, outcome: delivered ? "delivered" : "not_delivered", reason: delivered ? null : `seller answered ${status ?? "nothing"}` };
    ctx.books.record(r);
    if (!delivered) {
      return {
        kind: "json",
        status: 502,
        body: { error: "not_delivered", sellerStatus: status, sellerAnswer: bytes ? Buffer.from(bytes.subarray(0, 300)).toString("utf8") : null, record: ctx.recordUrl(key), refund: "none" },
        headers,
      };
    }
    return {
      kind: "answer",
      status: 200,
      body: bytes!,
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

function recordBase(ctx: SolanaContext, key: string, target: string, offer: SolanaOffer, total: bigint, tx: string | null, payer: string | null): PurchaseRecord {
  return {
    id: key,
    chain: "solana",
    at: ctx.now().toISOString(),
    target,
    seller: { host: offer.known.host, payTo: offer.accept.payTo, priceAtomic: offer.accept.amount },
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

/** The price block shown in the unpaid 402 body. */
export function solanaPriceInfo(offer: SolanaOffer, feeAtomic: bigint) {
  const total = totalAtomic(offer.sellerAtomic, feeAtomic);
  return {
    pay: "x402 exact, USDC on Solana mainnet",
    sellerPrice: atomicToUsdc(offer.sellerAtomic),
    fee: atomicToUsdc(feeAtomic),
    total: atomicToUsdc(total),
    sellerPayTo: offer.accept.payTo,
    refund: REFUND_POLICY,
    vet402Record: { settledPurchases: offer.known.settled, delivered: offer.known.delivered, lastAt: offer.known.lastAt },
  };
}
