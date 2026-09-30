/**
 * The open proxy-buy ALERTs and the reconciler's last full run (src/proxy-buy/alerts.ts), read by the operator's
 * runner (scripts/daily/run.sh proxy-alerts). Only with Authorization: Bearer $VET402_PROXY_ALERTS_SECRET.
 */
import { configFromEnv } from "../src/proxy-buy/config.js";
import { alertsResponse, bearerMatches } from "../src/proxy-buy/alerts.js";
import { migrate } from "../src/proxy-buy/db.js";
import { redact } from "../src/proxy-buy/reasons.js";
import { Store } from "../src/proxy-buy/store.js";
import { openDatabase } from "../src/proxy-buy/wire.js";

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.VET402_PROXY_ALERTS_SECRET;
  if (!bearerMatches(request.headers.get("authorization"), secret)) return new Response("forbidden", { status: 403 });
  try {
    const cfg = configFromEnv(process.env);
    if (!cfg.databaseUrl) throw new Error("DATABASE_URL is not set");
    const sql = openDatabase(cfg.databaseUrl);
    await migrate(sql);
    return await alertsResponse(request, new Store(sql), secret);
  } catch (e) {
    console.error(`proxy buy alerts: ${redact(String((e as Error).message ?? e), 300)}`);
    return new Response(JSON.stringify({ error: "internal_error" }), { status: 500, headers: { "content-type": "application/json" } });
  }
}
