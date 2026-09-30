/**
 * Vercel Cron (vercel.json): settles purchases that stopped half way (reconcile.ts). The request gate also
 * reconciles before it takes a paid request, so this is the backstop when no requests come in.
 * Only Vercel Cron's own call is accepted: Authorization: Bearer $CRON_SECRET.
 */
import { join } from "node:path";
import { configFromEnv } from "../src/proxy-buy/config.js";
import { DEFAULT_STALE_MS } from "../src/proxy-buy/handler.js";
import { reconcile } from "../src/proxy-buy/reconcile.js";
import { redact } from "../src/proxy-buy/reasons.js";
import { buildProxyBuy, dayCaps } from "../src/proxy-buy/wire.js";

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return new Response("forbidden", { status: 403 });
  try {
    const cfg = configFromEnv(process.env);
    const built = await buildProxyBuy(cfg, { dataDir: join(process.cwd(), "data") });
    const caps = dayCaps(cfg, "solana") ?? dayCaps(cfg, "tempo")!;
    const actions = await reconcile({
      store: built.store,
      feeAtomic: cfg.feeAtomic,
      now: () => new Date(),
      recordUrl: (id) => `${cfg.publicOrigin}/v1/buy/records/${id}`,
      caps,
      maxRefund: cfg.maxPerCallAtomic + cfg.feeAtomic,
      deadline: Date.now() + 240_000,
      staleMs: DEFAULT_STALE_MS,
      ...(built.solana ? { solana: built.solana } : {}),
      ...(built.tempo ? { tempo: built.tempo } : {}),
    });
    // A refund that is stuck or refused, or a purchase with no address to refund, needs a human: say so in the logs.
    for (const a of actions) if (a.action.startsWith("ALERT")) console.error(`proxy buy ALERT ${a.chain} ${a.id}: ${a.action}`);
    return new Response(JSON.stringify({ actions }, null, 2), { status: 200, headers: { "content-type": "application/json" } });
  } catch (e) {
    console.error(`proxy buy reconcile: ${redact(String((e as Error).message ?? e), 300)}`);
    return new Response(JSON.stringify({ error: "internal_error" }), { status: 500, headers: { "content-type": "application/json" } });
  }
}
