/**
 * The steps Solana and Tempo share once the agent has paid: waiting for a handed-over transaction's fate,
 * and the refund when vet402 did not pay the seller.
 */
import type { ProxyChain } from "./allowlist.js";
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
 * A fate look that keeps, with the purchase's facts under `key`, the slot where the transaction's blockhash was
 * first seen expired: every later look (this request's next poll, the reconciler) reads the same window.
 */
export function keepExpiry<F extends { expiredSlot?: number }>(store: Store, id: string, key: string, facts: F, look: (f: F) => Promise<Fate>): () => Promise<Fate> {
  return async () => {
    const f = await look(facts);
    if (f.fate === "pending" && f.expiredSlot !== undefined && facts.expiredSlot === undefined) {
      facts.expiredSlot = f.expiredSlot;
      await store.mergeFacts(id, key, { expiredSlot: f.expiredSlot }).catch(() => undefined);
    }
    return f;
  };
}

/**
 * vet402 did not pay the seller (proven): record that a refund is owed, refund, and close the purchase when
 * the refund is settled or refused. A refund that failed before sending, or whose outcome is unknown, leaves
 * the purchase in refund_pending for the reconciler.
 */
export async function refundOwed(
  c: Common,
  o: { id: string; chain: ProxyChain; day: string; from: PurchaseState[]; base: PurchaseRecord; reason: string; to: string | null; total: bigint; send: RefundSender; headers: Record<string, string>; retry?: boolean },
): Promise<PaidAnswer> {
  const pending: PurchaseRecord = { ...o.base, outcome: "seller_not_paid", reason: o.reason, refund: { status: "pending", to: o.to, amountAtomic: o.total.toString(), tx: null, reason: null } };
  if (o.from.length && !(await c.store.move(o.id, o.from, "refund_pending", { record: pending, now: c.now() }))) {
    return { kind: "json", status: 409, body: { error: "purchase_moved", record: c.recordUrl(o.id) }, headers: o.headers };
  }
  const refund: RefundRecord = await refundAgent(c.store, o.send, { id: o.id, chain: o.chain, day: o.day, to: o.to, amount: o.total, maxRefund: c.maxRefund, now: c.now, ...(o.retry ? { retry: true } : {}) });
  const record: PurchaseRecord = { ...pending, refund };
  // Only a sent refund closes the purchase. A refused, failed, unknown or stuck refund keeps it open (refund_pending):
  // the money is still owed, the reconciler keeps at it, and a stuck one is reported for a human.
  if (refund.status === "sent") await c.store.finish(o.id, ["refund_pending"], { record, spent: o.total, now: c.now() });
  else await c.store.move(o.id, ["refund_pending"], "refund_pending", { record, now: c.now() });
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
