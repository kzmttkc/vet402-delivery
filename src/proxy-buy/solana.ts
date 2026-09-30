/**
 * Proxy buy on Solana: the agent pays vet402 with x402 (exact, USDC), vet402 pays the seller with its own
 * proxy wallet through the census payment path (src/pay.ts payOne), and hands over the answer.
 *
 * Order (settle first, as in vet402-algorand's /v1/buy):
 *   decode the agent's payment -> read the seller's 402 again and price it again -> the payment must be for
 *   exactly that price (x402 v2 deep equality of `accepted`) -> take the payment key in the database (the
 *   signed transaction's message) -> reserve the wallet and the day in the database -> facilitator verify ->
 *   mark "settling" -> facilitator settle -> read the agent's transfer on chain (the authority's balance down
 *   and the receive wallet's up by exactly the total) -> record the agent's transaction as used and the
 *   purchase as in progress -> payOne (the seller's 402 is read again; vet402's signed payment is recorded in
 *   the database before it is sent) -> answer.
 * Every stop before settle costs the agent nothing. After settle: if vet402 did not pay the seller (payOne
 * refused, or vet402's payment to the seller is proven dead on chain), the agent is refunded; if the seller
 * was paid, there is no refund; if that cannot be told yet, the reconciler decides later.
 */
import { createHash } from "node:crypto";
import { getBase64Encoder, getTransactionDecoder } from "@solana/kit";
import type { x402ResourceServer } from "@x402/core/server";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { SOLANA_MAINNET, USDC_MINT, atomicToUsdc } from "../constants.js";
import { Budget } from "../guard.js";
import { payOne, type PayDeps, type PurchaseRecord as PayRecord } from "../pay.js";
import { ANSWER_LIMIT_NOTE, OFFER_TTL_SECONDS, PROXY_MAX_FORWARD_BYTES, REFUND_POLICY } from "./constants.js";
import { decodeSolanaTx, type Fate, type SolanaFateQuery, type SolanaTxFacts } from "./fate.js";
import { noCharge, publicTarget, refundOwed, waitFate, type Common, type PaidAnswer } from "./flow.js";
import { redact, refusalReason } from "./reasons.js";
import type { RefundSender } from "./refund.js";
import { utcDay, type PurchaseRecord } from "./store.js";
import { totalAtomic, type SolanaOffer } from "./quote.js";

export type { PaidAnswer } from "./flow.js";

/**
 * SOL the Solana proxy payer must hold for one refund: the network fee, and the rent of the agent's USDC account
 * when the refund has to create it again (2,039,280 lamports for a token account).
 */
export const REFUND_SOL_MIN_LAMPORTS = 2_100_000n;

export interface SolanaSide {
  /** Where agents pay (USDC ATA must exist). Its key is not on the server. */
  receive: string;
  receiveAta: string;
  /** vet402's proxy payer. Pays sellers and refunds only. */
  payer: string;
  payerAta: string;
  resourceServer: x402ResourceServer;
  /** src/pay.ts dependencies for the proxy payer (budget, judge, payer and the body hooks are set per purchase). */
  pay: Omit<PayDeps, "budget" | "judge" | "payer" | "onBody" | "maxBodyBytes">;
  /**
   * The agent's transfer, read on chain: success and `receive` up by exactly `amount` (charged); `payer` is the owner
   * of the account that paid (the refund address). `definite`: on chain and failed or moved something else (no charge).
   */
  confirmCustomer: (tx: string, authority: string, amount: bigint) => Promise<{ ok: true; payer: string } | { ok: false; detail: string; definite: boolean }>;
  /** The fate of a transaction found by its message hash among `account`'s signatures (fate.ts solanaTxFate). */
  fate: (f: SolanaFateQuery) => Promise<Fate>;
  /** The confirmed slot (a lower bound for where a transaction handed over after this read can land). */
  slot?: () => Promise<number>;
  /** Send `amount` USDC from the proxy payer to `to` (refund.ts sendSolanaRefund). */
  refund: RefundSender;
}

export interface SolanaContext extends Common {
  side: SolanaSide;
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

export async function solanaRequirements(ctx: { side: SolanaSide; feeAtomic: bigint }, offer: SolanaOffer, target: string): Promise<PaymentRequirements[]> {
  const rs = ctx.side.resourceServer;
  await ensureInit(rs);
  const total = totalAtomic(offer.sellerAtomic, ctx.feeAtomic);
  return rs.buildPaymentRequirements({
    scheme: "exact",
    network: SOLANA_MAINNET,
    payTo: ctx.side.receive,
    price: { amount: total.toString(), asset: USDC_MINT },
    maxTimeoutSeconds: OFFER_TTL_SECONDS,
    extra: { target, sellerAmount: offer.accept.amount, sellerPayTo: offer.accept.payTo, buyFee: ctx.feeAtomic.toString() },
  });
}

/** The PAYMENT-REQUIRED header value for these requirements. */
export async function paymentRequiredHeader(ctx: { side: SolanaSide; resourceUrl: string }, reqs: PaymentRequirements[], description: string, error?: string): Promise<string> {
  const pr = await ctx.side.resourceServer.createPaymentRequiredResponse(reqs, { url: ctx.resourceUrl, description, mimeType: "application/octet-stream" }, error);
  return encodePaymentRequiredHeader(pr);
}

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex").slice(0, 32);

/**
 * Replay key of an x402 SVM payment: the signed transaction's message bytes. The same transaction under another
 * JSON encoding, extra payload fields or another header name has the same key.
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

/**
 * A facilitator `success: false` that proves nothing was broadcast: no transaction, and a verification reason
 * (the x402 SVM facilitator's own checks, run before it signs and sends). Anything else may have been sent.
 */
export function settleFailedBeforeSend(s: SettleResponse): boolean {
  if (s.transaction) return false;
  return /^invalid_exact_svm_(payload_|fee_payer_|network_mismatch|smart_wallet_)/.test(s.errorReason ?? "");
}

function recordBase(ctx: SolanaContext, id: string, target: string, offer: SolanaOffer, total: bigint, tx: string | null, payer: string | null): PurchaseRecord {
  return {
    id,
    chain: "solana",
    at: ctx.now().toISOString(),
    target: publicTarget(target),
    seller: { host: offer.known.host, payTo: offer.accept.payTo, priceAtomic: offer.accept.amount },
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

/** One paid Solana request. `offer` comes from the seller's 402 read for this request. */
export async function paySolana(ctx: SolanaContext, target: string, offer: SolanaOffer, header: string): Promise<PaidAnswer> {
  const { store, side } = ctx;
  const rs = side.resourceServer;
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
    const h = await paymentRequiredHeader(ctx, reqs, "price changed: sign again for this price", "price_changed").catch(() => null);
    return {
      kind: "refuse",
      status: 402,
      body: { verdict: "REFUSE", reason: "price_changed", charged: false, detail: "the payment is not for the price read from the seller just now; nothing was charged" },
      ...(h ? { headers: { "PAYMENT-REQUIRED": h } } : {}),
    };
  }
  const agentTx = decodeSolanaTx(String((payload.payload as { transaction?: unknown }).transaction ?? ""));
  if (!agentTx || !agentTx.authority || agentTx.amount !== req.amount) return noCharge(400, "malformed_payment", "the payment is not one USDC transfer of the total");
  const authority = agentTx.authority;

  const id = solanaPaymentKey(payload);
  const seller = offer.sellerAtomic;
  const total = BigInt(req.amount);
  const now = ctx.now();
  const since = Math.floor(now.getTime() / 1000) - 120;
  // An earlier purchase from this agent or to this seller that stopped half way is settled first; others go on.
  if ((await store.blockingFor(now, ctx.staleMs, { agent: authority, host: offer.known.host })) > 0) {
    return noCharge(503, "reconcile_pending", "an earlier purchase from this payer or to this seller is being settled on chain first; nothing was charged, try again later");
  }
  // The agent's transaction needs the facilitator's signature as fee payer: it cannot land before vet402 settles it.
  const agentMinSlot = await slotOrNone(side);
  const agentFacts = { ...agentTx, account: side.receiveAta, since, ...(agentMinSlot !== undefined ? { minSlot: agentMinSlot } : {}) };
  if (!(await store.claim({ id, chain: "solana", target, sellerHost: offer.known.host, agent: authority, sellerAmount: seller, feeReserve: 0n, total, facts: { agent: agentFacts }, now }))) {
    return noCharge(409, "duplicate_payment", "this signed transaction was already used or is being used now");
  }
  let bal: { usdcAtomic: bigint; lamports: bigint };
  const balanceReadAt = ctx.now();
  try {
    bal = await side.pay.readBalances();
  } catch {
    await store.release(id);
    return noCharge(503, "ledger_unreadable", "the proxy wallet could not be read on chain; nothing was charged");
  }
  const day = utcDay(now);
  // The wallet reservation is the most this purchase can take out: a refund of the total (>= the seller price),
  // and the SOL of its refund (fee and account rent) on top of what every other open purchase keeps.
  const room = await store.admit(id, {
    chain: "solana",
    payer: side.payer,
    day,
    caps: ctx.caps,
    need: total,
    balance: bal.usdcAtomic,
    balanceReadAt,
    lamports: { have: bal.lamports, perPurchase: REFUND_SOL_MIN_LAMPORTS },
    now,
  });
  if (!room.ok) {
    await store.release(id);
    return noCharge(503, room.reason, room.detail);
  }
  let v;
  try {
    v = await rs.verifyPayment(payload, req);
  } catch {
    await store.release(id);
    return noCharge(502, "verify_failed", "the facilitator could not verify the payment; nothing was charged");
  }
  if (!v.isValid) {
    await store.release(id);
    return noCharge(402, "invalid_payment", redact(v.invalidReason ?? "the facilitator did not accept this payment"));
  }

  // ---- from here the agent's money may move: the key is spent for good ----
  if (!(await store.move(id, ["admitted"], "settling", { now: ctx.now() }))) return noCharge(409, "duplicate_payment", "this payment moved on in another request");
  const unknownBase = recordBase(ctx, id, target, offer, total, null, authority);
  let settled: SettleResponse;
  try {
    settled = await rs.settlePayment(payload, req);
  } catch {
    const r: PurchaseRecord = { ...unknownBase, outcome: "customer_payment_unconfirmed", reason: "settle_error" };
    await store.move(id, ["settling"], "settling", { record: r, now: ctx.now() });
    return { kind: "json", status: 502, body: { error: "customer_payment_unconfirmed", reason: r.reason, record: ctx.recordUrl(id), charged: "unknown", refund: "pending_reconcile" }, headers: { "x-vet402-record": ctx.recordUrl(id) } };
  }
  if (!settled.success) {
    if (settleFailedBeforeSend(settled)) {
      // The facilitator says it never sent; the chain has the last word: dead (blockhash expired, not there) = no charge.
      const f = await waitFate(ctx, () => side.fate({ ...agentFacts, deadline: ctx.deadline }));
      if (f.fate === "dead" || f.fate === "failed") {
        await store.finish(id, ["settling"], { record: { ...unknownBase, outcome: "no_charge", reason: "customer_settlement_failed" }, spent: 0n, now: ctx.now() });
        return noCharge(402, "customer_settlement_failed", redact(settled.errorReason ?? "settlement failed"));
      }
      const r: PurchaseRecord = { ...unknownBase, outcome: "customer_payment_unconfirmed", reason: "settle_failed_not_proven" };
      await store.move(id, ["settling"], "settling", { record: r, facts: f.fate === "landed" ? { settleTx: f.tx } : {}, now: ctx.now() });
      return { kind: "json", status: 502, body: { error: "customer_payment_unconfirmed", reason: r.reason, record: ctx.recordUrl(id), charged: "unknown", refund: "pending_reconcile" }, headers: { "x-vet402-record": ctx.recordUrl(id) } };
    }
    const r: PurchaseRecord = { ...unknownBase, customer: { ...unknownBase.customer, tx: settled.transaction || null }, outcome: "customer_payment_unconfirmed", reason: "settle_outcome_unknown" };
    await store.move(id, ["settling"], "settling", { record: r, facts: { settleTx: settled.transaction || null }, now: ctx.now() });
    return { kind: "json", status: 502, body: { error: "customer_payment_unconfirmed", reason: r.reason, record: ctx.recordUrl(id), charged: "unknown", refund: "pending_reconcile" }, headers: { "x-vet402-record": ctx.recordUrl(id) } };
  }

  const base = recordBase(ctx, id, target, offer, total, settled.transaction, authority);
  const paidHeaders = { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settled), "x-vet402-customer-tx": settled.transaction, "x-vet402-record": ctx.recordUrl(id) };
  const conf = await side.confirmCustomer(settled.transaction, authority, total).catch(() => ({ ok: false as const, detail: "confirm_error", definite: false }));
  if (!conf.ok) {
    if (conf.definite) {
      await store.finish(id, ["settling"], { record: { ...base, outcome: "no_charge", reason: conf.detail }, spent: 0n, now: ctx.now() });
      return noCharge(402, "customer_payment_failed", conf.detail);
    }
    const r: PurchaseRecord = { ...base, outcome: "customer_payment_unconfirmed", reason: conf.detail };
    await store.move(id, ["settling"], "settling", { record: r, facts: { settleTx: settled.transaction }, now: ctx.now() });
    return { kind: "json", status: 502, body: { error: "customer_payment_unconfirmed", reason: r.reason, record: ctx.recordUrl(id), refund: "pending_reconcile" }, headers: paidHeaders };
  }
  base.customer.confirmed = true;
  const payerAddr = conf.payer;
  base.customer.payer = payerAddr;
  // The agent's on-chain payment is used once, and the in-progress record is written, before anyone is paid.
  if (!(await store.useCustomerTx(id, "solana", settled.transaction, { facts: { customerTx: settled.transaction, refundTo: payerAddr }, record: base, now: ctx.now() }))) {
    await store.finish(id, ["settling"], { record: { ...base, outcome: "duplicate_customer_tx", reason: "this on-chain payment already paid for a purchase" }, spent: 0n, now: ctx.now() });
    return { kind: "json", status: 409, body: { error: "duplicate_customer_tx", record: ctx.recordUrl(id), refund: "none" }, headers: paidHeaders };
  }
  const owe = (reason: string, from: ("in_progress" | "seller_unsettled")[]) =>
    refundOwed(ctx, { id, chain: "solana", day, from, base, reason, to: payerAddr, total, send: side.refund, headers: paidHeaders });

  // The seller: through the census payment path, with a single-purchase budget (the caps are in the database).
  const got: { body: Uint8Array | null; truncated: boolean; sellerTx: (SolanaTxFacts & { minSlot?: number }) | null } = { body: null, truncated: false, sellerTx: null };
  let rec: PayRecord;
  try {
    rec = await payOne(
      {
        host: id,
        requestUrl: target,
        exampleInput: null,
        lock: { payTo: offer.accept.payTo, amount: offer.accept.amount, asset: USDC_MINT, network: SOLANA_MAINNET, feePayer: String(offer.accept.extra?.feePayer ?? "") },
      },
      {
        ...side.pay,
        // vet402's signed payment to the seller is written to the database before payOne can send it.
        createPayment: async (pr, accept) => {
          const minSlot = await slotOrNone(side);
          const created = await side.pay.createPayment(pr, accept);
          const f = decodeSolanaTx(created.txBase64);
          if (!f) throw new Error("seller payment not decodable");
          const facts = { ...f, ...(minSlot !== undefined ? { minSlot } : {}) };
          if (!(await store.move(id, ["in_progress"], "in_progress", { facts: { seller: { ...facts, account: side.payerAta, since } }, now: ctx.now() }))) throw new Error("purchase moved");
          got.sellerTx = facts;
          return created;
        },
        payer: side.payer,
        budget: new Budget(null, seller, 1, seller),
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
    // payOne returns its refusals; a throw comes from before anything was sent (the database write above, a read).
    return owe("seller_payment_error", ["in_progress"]);
  }
  if (rec.outcome !== "sent") return owe(rec.refusal ? refusalReason(rec.refusal) : rec.outcome, ["in_progress"]);

  const bytes = got.body;
  const status = rec.response?.status ?? null;
  const answer = {
    httpStatus: status,
    delivered: rec.delivered ?? null,
    bodySha256: bytes ? createHash("sha256").update(bytes).digest("hex") : null,
    bodyBytes: bytes ? bytes.byteLength : null,
    contentType: rec.response?.contentType ?? null,
  };
  const delivered = rec.delivered === true && bytes !== null && bytes.byteLength > 0 && !got.truncated;
  // Whether the seller was paid is read from vet402's own signed payment, found on chain by its message. The
  // transaction the seller names (PAYMENT-RESPONSE) is not taken: it can be another, earlier settlement.
  const sellerFacts = got.sellerTx;
  const look = (): Promise<Fate> =>
    sellerFacts ? side.fate({ ...sellerFacts, account: side.payerAta, since, deadline: ctx.deadline }) : Promise.resolve({ fate: "pending" } as Fate);
  // Delivered: one look for the record. Not delivered: wait for proof either way before deciding.
  const f = delivered ? await look().catch((): Fate => ({ fate: "pending" })) : await waitFate(ctx, look);
  let sellerSettled: boolean | null = null;
  let sellerTx: string | null = null;
  if (f.fate === "landed" && (await store.bindTx("solana", f.tx, id, "seller", ctx.now()))) {
    sellerSettled = true;
    sellerTx = f.tx;
  } else if ((f.fate === "dead" || f.fate === "failed") && !delivered) {
    return owe(f.fate === "dead" ? "seller_payment_expired_unsent" : "seller_payment_failed_on_chain", ["in_progress"]);
  } else if (f.fate === "dead" || f.fate === "failed") {
    sellerSettled = false;
  }
  if (sellerSettled !== true && !delivered) {
    const r: PurchaseRecord = { ...base, sellerPayment: { tx: null, settled: null }, answer, outcome: "seller_payment_pending", reason: `seller answered ${status ?? "nothing"}; payment not settled yet` };
    await store.move(id, ["in_progress"], "seller_unsettled", { record: r, now: ctx.now() });
    return { kind: "json", status: 502, body: { error: "seller_payment_pending", reason: r.reason, record: ctx.recordUrl(id), refund: "pending_reconcile", note: "if vet402's payment to the seller never settles, the reconciler refunds you" }, headers: paidHeaders };
  }
  const headers = {
    ...paidHeaders,
    ...(sellerTx ? { "x-vet402-seller-tx": sellerTx } : {}),
    "x-vet402-seller-settled": String(sellerSettled ?? "unknown"),
    "x-vet402-seller-status": String(status ?? ""),
  };
  const sellerPayment = { tx: sellerTx, settled: sellerSettled };
  if (got.truncated) {
    const r: PurchaseRecord = { ...base, sellerPayment, answer, outcome: "answer_too_large", reason: `answer above ${PROXY_MAX_FORWARD_BYTES} bytes` };
    await store.finish(id, ["in_progress"], { record: r, spent: seller, now: ctx.now() });
    return { kind: "json", status: 502, body: { error: "answer_too_large", record: ctx.recordUrl(id), refund: "none" }, headers };
  }
  const r: PurchaseRecord = { ...base, sellerPayment, answer: { ...answer, delivered }, outcome: delivered ? "delivered" : "not_delivered", reason: delivered ? null : `seller answered ${status ?? "nothing"}; vet402's payment to it settled` };
  // A failed closing write must not lose an answer vet402 paid for: the reconciler closes the purchase later.
  await store.finish(id, ["in_progress"], { record: r, spent: seller, now: ctx.now() }).catch(() => false);
  if (!delivered) {
    return {
      kind: "json",
      status: 502,
      body: { error: "not_delivered", sellerStatus: status, sellerAnswer: bytes ? Buffer.from(bytes.subarray(0, 300)).toString("utf8") : null, record: ctx.recordUrl(id), refund: "none", note: "vet402 paid the seller; no refund" },
      headers,
    };
  }
  return {
    kind: "answer",
    status: 200,
    body: bytes!,
    headers: { ...headers, "content-type": answer.contentType ?? "application/octet-stream", "x-content-type-options": "nosniff", "content-security-policy": "sandbox; default-src 'none'" },
  };
}

/** The confirmed slot, or undefined when it cannot be read (the search then relies on `since` alone). */
async function slotOrNone(side: SolanaSide): Promise<number | undefined> {
  if (!side.slot) return undefined;
  try {
    const s = await side.slot();
    return Number.isSafeInteger(s) ? s : undefined;
  } catch {
    return undefined;
  }
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
    largeAnswers: ANSWER_LIMIT_NOTE,
    vet402Record: { settledPurchases: offer.known.settled, delivered: offer.known.delivered, lastAt: offer.known.lastAt },
  };
}

export { utcDay };
