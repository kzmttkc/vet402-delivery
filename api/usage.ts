/**
 * How often the free endpoints were called (src/usage/count.ts), per day: calls and different callers, and
 * vet402's own calls apart. Read-only, not public: only with Authorization: Bearer $VET402_PROXY_ALERTS_SECRET,
 * the same secret as /api/alerts.
 */
import { bearerOk, usageDb, usageSummary } from "../src/usage/count.js";

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.VET402_PROXY_ALERTS_SECRET;
  if (secret && secret === process.env.CRON_SECRET) return new Response("misconfigured: VET402_PROXY_ALERTS_SECRET equals CRON_SECRET", { status: 503 });
  if (!bearerOk(request.headers.get("authorization"), secret)) return new Response("forbidden", { status: 403 });
  const sql = usageDb();
  if (!sql) return new Response(JSON.stringify({ error: "no_database" }), { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  try {
    const days = Math.min(90, Math.max(1, Number(new URL(request.url).searchParams.get("days")) || 30));
    const rows = await usageSummary(sql, days);
    return new Response(`${JSON.stringify({ kind: "vet402-usage", days, rows }, null, 2)}\n`, { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch {
    return new Response(JSON.stringify({ error: "internal_error" }), { status: 500, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
}
