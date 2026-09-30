/**
 * A person's tools for purchases the reconciler reported (ALERT) and could not close by itself
 * (scripts/proxy-buy-resolve.ts). Every change is a guarded update and leaves a reason on the record and the alert.
 *
 *   recheck        look again at the next reconcile run (clears the "look later" time of a search cut short)
 *   reopenRefund   a refund that is "stuck" (every sent attempt proven dead on chain, or it never could be sent):
 *                  allow new attempts, optionally to another address. Safe: a stuck refund has no transaction that
 *                  can still land.
 *   settleByHand   close an open purchase with what a person found out (for example a refund sent by hand), and
 *                  give its reservations back; or mark a closed purchase's seller payment as seen. Refused while a
 *                  sent refund can still land (sending, unknown) and for a purchase changed in the last 10 minutes.
 *   note           a reason on its open alerts, nothing else
 */
import type { PurchaseRecord, PurchaseState, Store } from "./store.js";
import { OPEN_STATES } from "./store.js";

/** A purchase that changed more recently than this is not closed by hand (a request or the reconciler may be on it). */
export const SETTLE_QUIET_MS = 10 * 60_000;

export async function recheck(store: Store, id: string): Promise<boolean> {
  const r = await store.sql.query(`update pb_purchase set checked_at = null where id = $1 and state <> 'done' returning id`, [id]);
  return r.rows.length === 1;
}

export async function reopenRefund(store: Store, id: string, o: { reason: string; to?: string; now: Date }): Promise<{ ok: boolean; detail: string }> {
  const row = await store.get(id);
  if (!row || row.state !== "refund_pending") return { ok: false, detail: "the purchase is not waiting for a refund" };
  const r = await store.sql.query(
    `update pb_refund set status = 'dead', attempt = 0, failures = 0, to_addr = coalesce($2, to_addr), reason = $3, updated_at = $4
     where purchase_id = $1 and status = 'stuck' returning purchase_id`,
    [id, o.to ?? null, `reopened by hand: ${o.reason}`.slice(0, 500), o.now.toISOString()],
  );
  if (r.rows.length !== 1) return { ok: false, detail: "no stuck refund for this purchase" };
  await recheck(store, id);
  await store.alertNote(id, `refund reopened by hand: ${o.reason}`);
  return { ok: true, detail: "the next reconcile run sends a new refund attempt" };
}

export async function settleByHand(
  store: Store,
  id: string,
  o: { reason: string; spent: bigint; refundTx?: string; now: Date },
): Promise<{ ok: boolean; detail: string }> {
  const row = await store.get(id);
  if (!row) return { ok: false, detail: "no such purchase" };
  const note = `settled by hand: ${o.reason}`.slice(0, 500);
  if (row.state === "done") {
    // A closed purchase whose seller payment was never seen: a person has looked.
    if (!(await store.sellerSeen(id, row.record ? { ...row.record, reason: note } : null))) return { ok: false, detail: "the purchase is already closed" };
    await store.alertsResolve(id, [], o.now, note);
    return { ok: true, detail: "the seller payment is marked as seen; it no longer holds back the wallet floor" };
  }
  if (!(OPEN_STATES as PurchaseState[]).includes(row.state)) return { ok: false, detail: `the purchase is ${row.state}: nothing was charged, the reconciler releases it` };
  if (o.now.getTime() - Date.parse(row.updated_at) < SETTLE_QUIET_MS) return { ok: false, detail: "the purchase changed less than 10 minutes ago; wait, or recheck first" };
  const rf = await store.getRefund(id);
  if (rf && (rf.status === "sending" || rf.status === "unknown")) {
    return { ok: false, detail: `a refund transaction (${rf.tx ?? "?"}) was sent and can still land; recheck until the reconciler decides it` };
  }
  const base = (row.record ?? {}) as PurchaseRecord;
  const record: PurchaseRecord = {
    ...base,
    id,
    chain: row.chain,
    outcome: "settled_by_hand",
    reason: note,
    refund: o.refundTx
      ? { status: "sent", to: typeof row.facts.refundTo === "string" ? row.facts.refundTo : null, amountAtomic: row.total, tx: o.refundTx, reason: "sent by hand" }
      : (base.refund ?? "none"),
  };
  if (!(await store.finish(id, OPEN_STATES, { record, spent: o.spent, updatedAt: row.updated_at, now: o.now }))) return { ok: false, detail: "the purchase moved meanwhile; look again" };
  // The refund row follows: sent by hand, or closed with the purchase (never left open with nobody to decide it).
  if (o.refundTx) {
    await store.sql.query(`update pb_refund set status = 'sent', tx = $2, reason = $3, updated_at = $4 where purchase_id = $1 and status <> 'sent'`, [id, o.refundTx, note, o.now.toISOString()]);
  } else {
    await store.sql.query(`update pb_refund set status = 'closed', reason = $2, updated_at = $3 where purchase_id = $1 and status not in ('sent', 'closed')`, [id, note, o.now.toISOString()]);
  }
  await store.alertsResolve(id, [], o.now, note);
  return { ok: true, detail: "closed; its reservations went back" };
}

export async function note(store: Store, id: string, reason: string): Promise<void> {
  await store.alertNote(id, reason);
}
