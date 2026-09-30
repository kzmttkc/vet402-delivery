/**
 * Proxy buy on Solana: the agent pays vet402 with x402 (exact, USDC), vet402 pays the seller with its
 * own proxy wallet through the census payment path (src/pay.ts payOne), and hands over the answer.
 *
 * Order (settle first, as in vet402-algorand's /v1/buy):
 *   decode the agent's payment -> read the seller's 402 again and price it again -> the payment must be
 *   for exactly that price (x402 v2 deep equality of `accepted`) -> take the payment key (replay guard)
 *   -> check the day's headroom -> facilitator verify -> facilitator settle -> read the agent's transfer
 *   on chain -> payOne (which reads the seller's 402 a third time and refuses a raised price or a
 *   changed payTo before signing) -> answer.
 * Every refusal before settle costs the agent nothing. After settle there is no refund; the record says
 * what happened, with both transactions.
 */
import { createHash } from "node:crypto";
import type { x402ResourceServer } from "@x402/core/server";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { SOLANA_MAINNET, USDC_MINT, atomicToUsdc } from "../constants.js";
import { payOne, type PayDeps } from "../pay.js";
import type { Books, PurchaseRecord } from "./books.js";
import { OFFER_TTL_SECONDS, PROXY_MAX_FORWARD_BYTES } from "./constants.js";
import { totalAtomic, type SolanaOffer } from "./quote.js";

export interface SolanaSide {
  /** Where agents pay (USDC ATA must exist). Never signs anything. */
  receive: string;
  /** vet402's proxy payer. Pays sellers only. */
  payer: string;
  resourceServer: x402ResourceServer;
  /** src/pay.ts dependencies for the proxy payer (budget, judge and payer are set per purchase). */
  pay: Omit<PayDeps, "budget" | "judge" | "payer">;
  /** The agent's transfer, read on chain: success and exactly `amount` into `receive`. */
  confirmCustomer: (tx: string, payer: string | null, amount: bigint) => Promise<{ ok: true } | { ok: false; detail: string }>;
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

/** Replay key of an x402 payment: the signed transaction (or whatever the scheme put in the payload). */
export function solanaPaymentKey(p: PaymentPayload): string {
  return createHash("sha256").update(JSON.stringify(p.payload)).digest("hex").slice(0, 32);
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
  } catch (e) {
    return noCharge(502, "facilitator_unavailable", String((e as Error).message ?? e).slice(0, 200));
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
  if (!ctx.books.claim(key, "solana", seller, 0n)) {
    return noCharge(409, "duplicate_payment", "this signed payment was already used or is being used now");
  }
  let settled: SettleResponse | null = null;
  try {
    let bal: bigint;
    try {
      bal = (await ctx.side.pay.readBalances()).usdcAtomic;
    } catch (e) {
      ctx.books.unclaim(key);
      return noCharge(503, "ledger_unreadable", `cannot read the proxy wallet balance: ${(e as Error).message}`.slice(0, 200));
    }
    const room = ctx.books.solanaHeadroom(ctx.now(), bal, key, seller);
    if (!room.ok) {
      ctx.books.unclaim(key);
      return noCharge(503, room.reason, room.detail);
    }
    let v;
    try {
      v = await rs.verifyPayment(payload, req);
    } catch (e) {
      ctx.books.unclaim(key);
      return noCharge(502, "verify_failed", String((e as Error).message ?? e).slice(0, 200));
    }
    if (!v.isValid) {
      ctx.books.unclaim(key);
      return noCharge(402, "invalid_payment", v.invalidReason ?? "the facilitator did not accept this payment");
    }

    // ---- from here the agent's money may move: the key is spent for good ----
    ctx.books.burn(key);
    const total = BigInt(req.amount);
    try {
      settled = await rs.settlePayment(payload, req);
    } catch (e) {
      // The facilitator may or may not have broadcast: record it, never pay the seller on an unknown.
      const r: PurchaseRecord = {
        ...recordBase(ctx, key, target, offer, total, { success: false, transaction: "", network: SOLANA_MAINNET, payer: v.payer }),
        customer: { tx: null, payer: v.payer ?? null, confirmed: false },
        outcome: "customer_payment_unconfirmed",
        reason: `settle: ${String((e as Error).message ?? e)}`.slice(0, 200),
      };
      ctx.books.record(r);
      return { kind: "json", status: 502, body: { error: "customer_payment_unconfirmed", detail: r.reason, record: ctx.recordUrl(key), charged: "unknown", refund: "none" }, headers: { "x-vet402-record": ctx.recordUrl(key) } };
    }
    if (!settled.success) return noCharge(402, "customer_settlement_failed", settled.errorReason ?? "settlement failed");

    const base = recordBase(ctx, key, target, offer, total, settled);
    const paidHeaders = { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled), "x-vet402-customer-tx": settled.transaction, "x-vet402-record": ctx.recordUrl(key) };

    const conf = await ctx.side.confirmCustomer(settled.transaction, settled.payer ?? v.payer ?? null, total).catch((e) => ({ ok: false as const, detail: String((e as Error).message ?? e) }));
    if (!conf.ok) {
      const r: PurchaseRecord = { ...base, outcome: "customer_payment_unconfirmed", reason: conf.detail.slice(0, 200) };
      ctx.books.record(r);
      return { kind: "json", status: 502, body: { error: "customer_payment_unconfirmed", detail: r.reason, record: ctx.recordUrl(key), refund: "none" }, headers: paidHeaders };
    }
    base.customer.confirmed = true;

    // The seller: through the census payment path, with the proxy wallet and today's proxy Budget.
    const got: { body: string | null } = { body: null };
    const budget = ctx.books.solanaBudget(ctx.now(), bal);
    let rec: Awaited<ReturnType<typeof payOne>>;
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
          budget,
          judge: (d) => {
            got.body = d.bodyText;
            const delivered = d.status >= 200 && d.status < 300 && d.bodyText.trim().length > 0;
            return { delivered, reason: delivered ? "delivered" : `http_${d.status}`, summary: "", missingKeys: [] };
          },
        },
      );
    } catch (e) {
      // payOne records its own refusals; an exception here is unexpected (a ledger write, a chain read).
      // The agent has paid: record it, and never retry the seller payment on an unknown.
      const r: PurchaseRecord = { ...base, outcome: "seller_payment_unknown", reason: `error in the seller payment step: ${String((e as Error).message ?? e)}`.slice(0, 300) };
      ctx.books.record(r);
      return { kind: "json", status: 502, body: { error: "seller_payment_unknown", reason: r.reason, record: ctx.recordUrl(key), refund: "none" }, headers: paidHeaders };
    }
    if (rec.outcome !== "sent") {
      const why = rec.refusal ? `${rec.refusal.refused}: ${rec.refusal.detail}` : rec.outcome;
      const r: PurchaseRecord = { ...base, outcome: "seller_not_paid", reason: why.slice(0, 300) };
      ctx.books.record(r);
      return { kind: "json", status: 502, body: { error: "seller_not_paid", reason: r.reason, record: ctx.recordUrl(key), refund: "none" }, headers: paidHeaders };
    }
    const sellerTx = rec.signature ?? null;
    const text = got.body;
    const bytes = text === null ? null : new TextEncoder().encode(text);
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
    if (bytes && bytes.byteLength > PROXY_MAX_FORWARD_BYTES) {
      const r: PurchaseRecord = { ...base, sellerPayment: { tx: sellerTx, settled: rec.settled ?? null }, answer, outcome: "answer_too_large", reason: `answer above ${PROXY_MAX_FORWARD_BYTES} bytes` };
      ctx.books.record(r);
      return { kind: "json", status: 502, body: { error: "answer_too_large", record: ctx.recordUrl(key), refund: "none" }, headers };
    }
    const delivered = rec.delivered === true && bytes !== null;
    const r: PurchaseRecord = {
      ...base,
      sellerPayment: { tx: sellerTx, settled: rec.settled ?? null },
      answer,
      outcome: delivered ? "delivered" : "not_delivered",
      reason: delivered ? null : `seller answered ${status ?? "nothing"}`,
    };
    ctx.books.record(r);
    if (!delivered) {
      return {
        kind: "json",
        status: 502,
        body: { error: "not_delivered", sellerStatus: status, sellerAnswer: text ? text.slice(0, 300) : null, record: ctx.recordUrl(key), refund: "none" },
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

function recordBase(ctx: SolanaContext, key: string, target: string, offer: SolanaOffer, total: bigint, s: SettleResponse): PurchaseRecord {
  return {
    id: key,
    chain: "solana",
    at: ctx.now().toISOString(),
    target,
    seller: { host: offer.known.host, payTo: offer.accept.payTo, priceAtomic: offer.accept.amount },
    feeAtomic: ctx.feeAtomic.toString(),
    totalAtomic: total.toString(),
    customer: { tx: s.transaction, payer: s.payer ?? null, confirmed: false },
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
    vet402Record: { settledPurchases: offer.known.settled, delivered: offer.known.delivered, lastAt: offer.known.lastAt },
  };
}
