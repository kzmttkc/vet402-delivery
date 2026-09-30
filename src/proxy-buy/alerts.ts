/**
 * GET /api/alerts: the open proxy-buy ALERTs (pb_alert) and when the reconciler last ran in full, for the runner on
 * the operator's machine (scripts/daily/proxy-alerts.ts). Only with `Authorization: Bearer $VET402_PROXY_ALERTS_SECRET`
 * (a read-only secret, not the cron's), compared in constant time. The answer carries purchase ids, chains and
 * fixed-code reasons, never keys or RPC URLs.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { RECONCILE_RAN_KEY } from "./reconcile.js";
import type { Store } from "./store.js";

/** Whether `header` is exactly `Bearer <secret>`, compared in constant time (hashes of equal length). */
export function bearerMatches(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 16 || header === null) return false;
  const a = createHash("sha256").update(header).digest();
  const b = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(a, b);
}

export async function alertsResponse(req: Request, store: Store, secret: string | undefined, cronSecret?: string): Promise<Response> {
  // The read-only secret must not be the cron's: a copy on the operator's machine could then start the reconciler.
  if (secret && cronSecret && secret === cronSecret) return new Response("misconfigured: VET402_PROXY_ALERTS_SECRET equals CRON_SECRET", { status: 503 });
  if (!bearerMatches(req.headers.get("authorization"), secret)) return new Response("forbidden", { status: 403 });
  const rows = await store.openAlerts(500);
  const alerts = rows.map((r) => ({ key: r.key, purchaseId: r.purchase_id, chain: r.chain, reason: r.reason, firstAt: r.first_at, lastAt: r.last_at, count: r.count, note: r.note }));
  const reconcilerLastRunAt = await store.lastRan(RECONCILE_RAN_KEY);
  return new Response(JSON.stringify({ at: new Date().toISOString(), reconcilerLastRunAt, alerts }, null, 2), {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
