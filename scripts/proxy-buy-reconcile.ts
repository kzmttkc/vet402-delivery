/**
 * Settle every proxy-buy purchase that stopped half way, by reading the chains (src/proxy-buy/reconcile.ts).
 *
 *   npx tsx scripts/proxy-buy-reconcile.ts --list    # print the purchases that need it; changes nothing, sends nothing
 *   npx tsx scripts/proxy-buy-reconcile.ts           # settle them: closes, and refunds only on proof
 *
 * Needs the same environment as the server (DATABASE_URL, the RPCs, and the payer keys for refunds).
 */
import { join } from "node:path";
import { configFromEnv } from "../src/proxy-buy/config.js";
import { DEFAULT_STALE_MS } from "../src/proxy-buy/handler.js";
import { reconcile } from "../src/proxy-buy/reconcile.js";
import { redact } from "../src/proxy-buy/reasons.js";
import { buildProxyBuy, dayCaps } from "../src/proxy-buy/wire.js";

async function main(): Promise<void> {
  const cfg = configFromEnv(process.env);
  const built = await buildProxyBuy(cfg, { dataDir: join(import.meta.dirname, "..", "data") });
  const staleMs = Number(process.env.VET402_PROXY_STALE_MS ?? DEFAULT_STALE_MS);
  if (process.argv.includes("--list")) {
    const rows = await built.store.stale(new Date(), staleMs);
    const refunds = await Promise.all(rows.map((r) => built.store.getRefund(r.id)));
    console.log(JSON.stringify(rows.map((r, i) => ({ id: r.id, chain: r.chain, state: r.state, updatedAt: r.updated_at, total: r.total, refund: refunds[i]?.status ?? null })), null, 2));
    return;
  }
  const caps = dayCaps(cfg, "solana") ?? dayCaps(cfg, "tempo");
  if (!caps) throw new Error("neither Solana nor Tempo is configured");
  const actions = await reconcile({
    store: built.store,
    feeAtomic: cfg.feeAtomic,
    now: () => new Date(),
    recordUrl: (id) => `${cfg.publicOrigin}/v1/buy/records/${id}`,
    caps,
    maxRefund: cfg.maxPerCallAtomic + cfg.feeAtomic,
    deadline: Date.now() + 10 * 60_000,
    staleMs,
    ...(built.solana ? { solana: built.solana } : {}),
    ...(built.tempo ? { tempo: built.tempo } : {}),
  });
  console.log(JSON.stringify(actions, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error(`proxy buy reconcile: ${redact(String((e as Error).message ?? e), 300)}`);
  process.exit(1);
});
