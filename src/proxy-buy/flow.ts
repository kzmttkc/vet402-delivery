/**
 * The steps Solana and Tempo share once the agent has paid: waiting for a handed-over transaction's fate,
 * and the refund when vet402 did not pay the seller.
 */
import type { ProxyChain } from "./allowlist.js";
import { TEMPO_REFUND_FEE_BOUND_ATOMIC } from "./constants.js";
import type { Fate } from "./fate.js";
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

/** A sent refund closes its purchase: the total, plus (Tempo) the refund's fee and every fee recorded before. */
export async function closeRefunded(
  c: { store: Store; now: () => Date },
  o: { id: string; chain: ProxyChain; record: PurchaseRecord; total: bigint; tx: string | null; feePaid: string | null; feeOf?: FeeOf; updatedAt?: string },
): Promise<boolean> {
  if (o.tx) await recordTempoFee(c.store, o.chain, o.id, { hash: o.tx }, { known: o.feePaid !== null && /^\d+$/.test(o.feePaid) ? BigInt(o.feePaid) : null, ...(o.feeOf ? { feeOf: o.feeOf } : {}) });
  else if (o.chain === "tempo") await c.store.addFee(o.id, "refund:unknown", TEMPO_REFUND_FEE_BOUND_ATOMIC);
  return c.store.finish(o.id, ["refund_pending"], { record: o.record, spent: o.total, ...(o.updatedAt ? { updatedAt: o.updatedAt } : {}), now: c.now() });
}

/**
 * vet402 did not pay the seller (proven): record that a refund is owed, refund, and close the purchase when
 * the refund is settled or refused. A refund that failed before sending, or whose outcome is unknown, leaves
 * the purchase in refund_pending for the reconciler.
 */
export async function refundOwed(
  c: Common,
  o: { id: string; chain: ProxyChain; day: string; from: PurchaseState[]; base: PurchaseRecord; reason: string; to: string | null; total: bigint; send: RefundSender; headers: Record<string, string>; retry?: boolean; feeOf?: FeeOf },
): Promise<PaidAnswer> {
  const pending: PurchaseRecord = { ...o.base, outcome: "seller_not_paid", reason: o.reason, refund: { status: "pending", to: o.to, amountAtomic: o.total.toString(), tx: null, reason: null } };
  if (o.from.length && !(await c.store.move(o.id, o.from, "refund_pending", { record: pending, now: c.now() }))) {
    return { kind: "json", status: 409, body: { error: "purchase_moved", record: c.recordUrl(o.id) }, headers: o.headers };
  }
  const refund: RefundRecord = await refundAgent(c.store, o.send, { id: o.id, chain: o.chain, day: o.day, to: o.to, amount: o.total, maxRefund: c.maxRefund, now: c.now, ...(o.retry ? { retry: true } : {}) });
  const record: PurchaseRecord = { ...pending, refund };
  // Only a sent refund closes the purchase. A refused, failed, unknown or stuck refund keeps it open (refund_pending):
  // the money is still owed, the reconciler keeps at it, and a stuck one is reported for a human.
  if (refund.status === "sent") {
    const fee = (await c.store.getRefund(o.id).catch(() => null))?.fee_paid ?? null;
    await closeRefunded(c, { id: o.id, chain: o.chain, record, total: o.total, tx: refund.tx, feePaid: fee === null ? null : String(fee), ...(o.feeOf ? { feeOf: o.feeOf } : {}) });
  }
  else await c.store.setRecord(o.id, ["refund_pending"], record);
  return {
    kind: "json",
    status: 502,
    body: { error: "seller_not_paid", reason: o.reason, refund, record: c.recordUrl(o.id) },
    headers: { ...o.headers, ...(refund.tx ? { "x-vet402-refund-tx": refund.tx } : {}) },
  };
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
