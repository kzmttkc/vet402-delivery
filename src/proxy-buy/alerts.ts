/**
 * GET /api/alerts: the open proxy-buy ALERTs (pb_alert), for the runner on the operator's machine that copies new
 * ones into its alert file (scripts/daily/proxy-alerts.ts). Only with `Authorization: Bearer $CRON_SECRET`; the
 * answer carries purchase ids, chains and fixed-code reasons, never keys or RPC URLs.
 */
import type { Store } from "./store.js";

export async function alertsResponse(req: Request, store: Store, secret: string | undefined): Promise<Response> {
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return new Response("forbidden", { status: 403 });
  const rows = await store.openAlerts(500);
  const alerts = rows.map((r) => ({ key: r.key, purchaseId: r.purchase_id, chain: r.chain, reason: r.reason, firstAt: r.first_at, lastAt: r.last_at, count: r.count, note: r.note }));
  return new Response(JSON.stringify({ at: new Date().toISOString(), alerts }, null, 2), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
