/**
 * The steps Solana and Tempo share once the agent has paid: waiting for a handed-over transaction's fate,
 * and the refund when vet402 did not pay the seller.
 */
import type { ProxyChain } from "./allowlist.js";
import { TEMPO_REFUND_FEE_BOUND_ATOMIC } from "./constants.js";
import type { Fate } from "./fate.js";
import type { NotDeliveredFault, NotDeliveredRefund } from "./not-delivered.js";
import { refundAgent, type RefundSender } from "./refund.js";
import type { DayCaps, PurchaseRecord, PurchaseState, RefundRecord, Store } from "./store.js";

export type PaidAnswer =
  | { kind: "refuse"; status: number; body: Record<string, unknown>; headers?: Record<string, string> }
  | { kind: "answer"; status: number; body: Uint8Array; headers: Record<string, string> }
  | { kind: "json"; status: number; body: Record<string, unknown>; headers: Record<string, string> };

export interface Common {
  store: Store;
  feeAtomic: bigint;
  now: () => Date;
  recordUrl: (id: string) => string;
  caps: DayCaps;
  /** At most one purchase's total (per-purchase cap + fee). */
  maxRefund: bigint;
  /** Epoch ms by which this request must stop waiting on chains (a serverless function has a hard limit). */
  deadline: number;
  /** A non-final purchase older than this is taken to be abandoned (reconciler; per-agent and per-seller wait). */
  staleMs: number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
}

export const noCharge = (status: number, reason: string, detail: string, extra: Record<string, unknown> = {}): PaidAnswer => ({
  kind: "refuse",
  status,
  body: { verdict: "REFUSE", reason, detail, charged: false, ...extra },
});

/** Poll `fate` until it is not "pending", a search was cut short (`capped`: asking again reads as much), or the deadline. */
export async function waitFate(c: Common, fate: () => Promise<Fate>): Promise<Fate> {
  const sleep = c.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    const f = await fate().catch((): Fate => ({ fate: "pending" }));
    if (f.fate !== "pending" || f.capped) return f;
    if (Date.now() + (c.pollMs ?? 3_000) >= c.deadline) return f;
    await sleep(c.pollMs ?? 3_000);
  }
}

/**
 * A fate look that keeps, with the purchase's facts under `key`, where the window ends (the finalized slot first
 * seen past the transaction's last valid block height) and how far the walk above it got: every later look (this
 * request's next poll, the reconciler) reads the same window and starts where the last one stopped.
 */
export function keepExpiry<F extends { expiredSlot?: number; cursor?: string }>(store: Store, id: string, key: string, facts: F, look: (f: F) => Promise<Fate>): () => Promise<Fate> {
  return async () => {
    const f = await look(facts);
    const patch = windowPatch(facts, f);
    if (patch) {
      Object.assign(facts, patch);
      await store.mergeFacts(id, key, patch).catch(() => undefined);
    }
    return f;
  };
}

/** What a pending Solana answer adds to the facts it was asked with (null: nothing new). */
export function windowPatch(facts: { expiredSlot?: unknown; cursor?: unknown }, f: Fate): { expiredSlot?: number; cursor?: string } | null {
  if (f.fate !== "pending") return null;
  const patch: { expiredSlot?: number; cursor?: string } = {};
  if (f.expiredSlot !== undefined && typeof facts.expiredSlot !== "number") patch.expiredSlot = f.expiredSlot;
  if (f.cursor !== undefined && f.cursor !== facts.cursor) patch.cursor = f.cursor;
  return Object.keys(patch).length ? patch : null;
}

/** Reads the network fee a mined transaction took from the payer (Tempo: TempoReads.fee); null: no receipt. */
export type FeeOf = (tx: string) => Promise<bigint | null>;

/**
 * Record the network fee a mined Tempo transaction of this purchase took from the payer wallet (a seller payment or a
 * refund; a reverted one pays it too), so that closing the purchase counts it in what was spent. `known`: the fee
 * already read (a refund's read-back). When it cannot be read, the refund's fee bound is counted: counting too much
 * only lowers the floor below the balance (a later top-up check raises it again); too little would stop Tempo.
 * Solana's fees are paid in SOL, not from the USDC the floor counts: nothing to record. A sponsored transaction's
 * fee is the seller's.
 */
export async function recordTempoFee(store: Store, chain: ProxyChain, id: string, tx: { hash: string; sponsored?: boolean }, o: { known?: bigint | null; feeOf?: FeeOf }): Promise<void> {
  if (chain !== "tempo" || tx.sponsored) return;
  let fee = o.known ?? null;
  if (fee === null && o.feeOf) fee = await o.feeOf(tx.hash).catch(() => null);
  await store.addFee(id, tx.hash, fee ?? TEMPO_REFUND_FEE_BOUND_ATOMIC);
}

/**
 * A sent refund closes its purchase: the total, plus (Tempo) the refund's fee and every fee recorded before. `spent`:
 * what the purchase took out of the payer wallet when it is not the total alone (a refund for an undelivered answer:
 * the seller's price and the refund).
 */
export async function closeRefunded(
  c: { store: Store; now: () => Date },
  o: { id: string; chain: ProxyChain; record: PurchaseRecord; total: bigint; spent?: bigint; tx: string | null; feePaid: string | null; feeOf?: FeeOf; updatedAt?: string },
): Promise<boolean> {
  if (o.tx) await recordTempoFee(c.store, o.chain, o.id, { hash: o.tx }, { known: o.feePaid !== null && /^\d+$/.test(o.feePaid) ? BigInt(o.feePaid) : null, ...(o.feeOf ? { feeOf: o.feeOf } : {}) });
  else if (o.chain === "tempo") await c.store.addFee(o.id, "refund:unknown", TEMPO_REFUND_FEE_BOUND_ATOMIC);
  return c.store.finish(o.id, ["refund_pending"], { record: o.record, spent: o.spent ?? o.total, ...(o.updatedAt ? { updatedAt: o.updatedAt } : {}), now: c.now() });
}

/** A refund owed for an answer the seller did not deliver after vet402 paid it (not-delivered.ts). */
export interface NotDeliveredOwed {
  /** The seller's price: vet402 paid it, so the purchase takes it and the refund out of the payer wallet. */
  sellerAmount: bigint;
  /** The seller's failure, e.g. "http_500". */
  basis: string;
}

/** What a refund is owed for, as the record says it. */
export const refundBasis = (nd: NotDeliveredOwed | undefined) => (nd ? `not_delivered: ${nd.basis}` : "seller_not_paid");

/**
 * vet402 did not pay the seller (proven): record that a refund is owed, refund, and close the purchase when
 * the refund is settled or refused. A refund that failed before sending, or whose outcome is unknown, leaves
 * the purchase in refund_pending for the reconciler.
 */
export async function refundOwed(
  c: Common,
  o: {
    id: string;
    chain: ProxyChain;
    day: string;
    from: PurchaseState[];
    base: PurchaseRecord;
    reason: string;
    to: string | null;
    total: bigint;
    send: RefundSender;
    headers: Record<string, string>;
    retry?: boolean;
    /** The refund row was taken already (Store.ndRefundClaim). */
    claimed?: boolean;
    /** The refund is for an answer the seller did not deliver after vet402 paid it (not for a seller vet402 did not pay). */
    notDelivered?: NotDeliveredOwed;
    /** Extra fields of the answer's body (a not-delivered answer keeps the seller's status). */
    extra?: Record<string, unknown>;
    feeOf?: FeeOf;
  },
): Promise<PaidAnswer> {
  // `basis` is written for a refund of an undelivered answer only: records of the refund above stay as they were.
  const basis = o.notDelivered ? { basis: refundBasis(o.notDelivered) } : {};
  const pending: PurchaseRecord = {
    ...o.base,
    outcome: o.notDelivered ? "not_delivered" : "seller_not_paid",
    reason: o.reason,
    refund: { status: "pending", to: o.to, amountAtomic: o.total.toString(), tx: null, reason: null, ...basis },
  };
  if (o.from.length && !(await c.store.move(o.id, o.from, "refund_pending", { record: pending, now: c.now() }))) {
    return { kind: "json", status: 409, body: { error: "purchase_moved", record: c.recordUrl(o.id) }, headers: o.headers };
  }
  const refund: RefundRecord = {
    ...(await refundAgent(c.store, o.send, { id: o.id, chain: o.chain, day: o.day, to: o.to, amount: o.total, maxRefund: c.maxRefund, now: c.now, ...(o.retry ? { retry: true } : {}), ...(o.claimed ? { claimed: true } : {}) })),
    ...basis,
  };
  const record: PurchaseRecord = { ...pending, refund };
  // Only a sent refund closes the purchase. A refused, failed, unknown or stuck refund keeps it open (refund_pending):
  // the money is still owed, the reconciler keeps at it, and a stuck one is reported for a human.
  if (refund.status === "sent") {
    const fee = (await c.store.getRefund(o.id).catch(() => null))?.fee_paid ?? null;
    await closeRefunded(c, {
      id: o.id,
      chain: o.chain,
      record,
      total: o.total,
      spent: o.total + (o.notDelivered?.sellerAmount ?? 0n),
      tx: refund.tx,
      feePaid: fee === null ? null : String(fee),
      ...(o.feeOf ? { feeOf: o.feeOf } : {}),
    });
  }
  else await c.store.setRecord(o.id, ["refund_pending"], record);
  return {
    kind: "json",
    status: 502,
    body: { error: o.notDelivered ? "not_delivered" : "seller_not_paid", reason: o.reason, ...(o.extra ?? {}), refund, record: c.recordUrl(o.id) },
    headers: { ...o.headers, ...(refund.tx ? { "x-vet402-refund-tx": refund.tx } : {}) },
  };
}

/**
 * vet402 paid the seller (its payment found landed on chain) and the answer did not deliver: close the purchase.
 * With the refund for undelivered answers on (`nd`) and a seller-side failure (`fault`), the refund is decided once
 * (Store.ndRefundClaim: caps, abuse checks) and, when granted, sent like any refund (refund_pending until sent; the
 * reconciler retries and reports). Otherwise, as before: closed with no refund (`refund` is "none", or the refusal
 * when the refund was decided against). `closed`: false when the closing write did not take (the purchase moved, or
 * the write failed: the reconciler closes it later). null: the refund decision found the purchase moved.
 */
export async function closeNotDelivered(
  c: Common,
  o: {
    id: string;
    chain: ProxyChain;
    day: string;
    from: PurchaseState[];
    updatedAt?: string;
    /** The not_delivered record (outcome, seller payment and answer filled in). */
    record: PurchaseRecord;
    fault: NotDeliveredFault | null;
    nd: NotDeliveredRefund | undefined;
    to: string | null;
    agent: string | null;
    total: bigint;
    sellerAmount: bigint;
    send: RefundSender;
    headers: Record<string, string>;
    extra: Record<string, unknown>;
    /**
     * The request's path: write the answer and whose failure it is before deciding (the purchase stays in its state),
     * so a decision that cannot be written now is made later by the reconciler, the same way.
     */
    saveFirst?: boolean;
    feeOf?: FeeOf;
  },
): Promise<{ answer: PaidAnswer; closed: boolean; deferred?: true } | null> {
  const pin = o.updatedAt ? { updatedAt: o.updatedAt } : {};
  const closeNoRefund = async (refund: PurchaseRecord["refund"]): Promise<{ answer: PaidAnswer; closed: boolean }> => {
    const record: PurchaseRecord = { ...o.record, refund };
    // A failed closing write must not lose an answer: the reconciler closes the purchase later.
    const closed = await c.store.finish(o.id, o.from, { record, spent: o.sellerAmount, ...pin, now: c.now() }).catch(() => false);
    return {
      closed,
      answer: {
        kind: "json",
        status: 502,
        body: { error: "not_delivered", ...o.extra, record: c.recordUrl(o.id), refund, note: refund === "none" ? "vet402 paid the seller; no refund" : "vet402 paid the seller; the refund was not made (see refund.reason)" },
        headers: o.headers,
      },
    };
  };
  if (!o.nd || !o.fault || !o.fault.refundable) return closeNoRefund("none");
  const basis = o.fault.basis;
  const refundTemplate = { to: o.to, amountAtomic: o.total.toString(), tx: null, basis: `not_delivered: ${basis}` };
  if (!o.to) return closeNoRefund({ status: "refused", ...refundTemplate, reason: "payer_unknown" });
  const pending: PurchaseRecord = { ...o.record, refund: { status: "pending", ...refundTemplate, reason: null } };
  const undecided: PurchaseRecord = { ...o.record, refund: { status: "pending", ...refundTemplate, reason: "decision_pending" } };
  const keep = (to: PurchaseState) => c.store.move(o.id, o.from, to, { record: undecided, facts: { answerFault: o.fault }, now: c.now() }).catch(() => false);
  const saved = o.saveFirst ? await keep(o.from[0]!) : false;
  let d: Awaited<ReturnType<Store["ndRefundClaim"]>>;
  try {
    d = await c.store.ndRefundClaim(o.id, {
    chain: o.chain,
    from: o.from,
    ...pin,
    to: o.to,
    agent: o.agent,
    sellerHost: o.record.seller.host,
    sellerPayTo: o.record.seller.payTo,
    amount: o.total,
    maxRefund: c.maxRefund,
    basis,
    caps: o.nd,
    lastDeliveredAt: o.nd.lastDeliveredAt(o.record.seller.host, o.record.seller.payTo),
    record: pending,
    now: c.now(),
  });
  } catch {
    // The decision could not be written (a database error). The answer and its failure are kept with the purchase,
    // which waits as seller_unsettled: the reconciler decides the refund the same way (never twice: pb_nd_refund).
    // The reconciler's own path leaves the row as it was read, for its next run.
    const moved = o.saveFirst ? await keep("seller_unsettled") : false;
    const later = !o.saveFirst || saved || moved;
    return {
      closed: false,
      deferred: true,
      answer: {
        kind: "json",
        status: 502,
        body: {
          error: "not_delivered",
          ...o.extra,
          record: c.recordUrl(o.id),
          refund: later ? "pending_reconcile" : "unknown",
          note: later
            ? "vet402 paid the seller and the seller did not deliver; whether your payment is refunded is decided later by the reconciler (the record shows it)"
            : "vet402 paid the seller and the seller did not deliver; the refund decision could not be recorded (the record shows the outcome)",
        },
        headers: o.headers,
      },
    };
  }
  if ("moved" in d) return null;
  if (!d.granted) return closeNoRefund({ status: "refused", ...refundTemplate, reason: `${d.reason}: ${d.detail}` });
  const answer = await refundOwed(c, {
    id: o.id,
    chain: o.chain,
    day: o.day,
    from: [],
    base: o.record,
    reason: o.record.reason ?? `seller answered; ${basis}`,
    to: o.to,
    total: o.total,
    send: o.send,
    headers: o.headers,
    claimed: true,
    notDelivered: { sellerAmount: o.sellerAmount, basis },
    extra: o.extra,
    ...(o.feeOf ? { feeOf: o.feeOf } : {}),
  });
  return { answer, closed: true };
}

/** The public target: scheme, host and path only (the query is the agent's input). */
export function publicTarget(target: string): string {
  try {
    const u = new URL(target);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}
