/**
 * Run proxy buy as a local HTTP process (production runs on Vercel: api/buy.ts). The state is in Postgres
 * (DATABASE_URL), the same as on Vercel.
 *
 *   npx tsx scripts/proxy-buy-serve.ts --check   # print the config (no keys, no URLs with secrets) and the allowlist size; no network
 *   npx tsx scripts/proxy-buy-serve.ts           # serve on PORT (default 8402)
 *
 * Nothing is paid unless VET402_PROXY_BUY_ENABLED=1 and a paid request arrives.
 */
import { join } from "node:path";
import { loadAllowlist } from "../src/proxy-buy/allowlist.js";
import { configFromEnv, describeConfig } from "../src/proxy-buy/config.js";
import { startServer } from "../src/proxy-buy/http.js";
import { redact } from "../src/proxy-buy/reasons.js";
import { buildProxyBuy } from "../src/proxy-buy/wire.js";

async function main(): Promise<void> {
  const cfg = configFromEnv(process.env);
  const dataDir = join(import.meta.dirname, "..", "data");
  const allowlist = loadAllowlist(dataDir);
  const summary = {
    ...describeConfig(cfg),
    allowlist: {
      solana: allowlist.entries.filter((e) => e.chain === "solana" && e.delivered > 0).length,
      tempo: allowlist.entries.filter((e) => e.chain === "tempo" && e.delivered > 0).length,
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  if (process.argv.includes("--check")) return;
  if (!cfg.solana && !cfg.tempo) throw new Error("neither Solana nor Tempo is configured");
  const { buy } = await buildProxyBuy(cfg, { dataDir, allowlist });
  const server = await startServer(buy, {
    port: cfg.port,
    host: process.env.HOST ?? "127.0.0.1",
    origin: cfg.publicOrigin,
    trustProxy: process.env.VET402_PROXY_TRUST_PROXY === "1",
    onError: (e) => console.error(`proxy buy: unexpected error: ${redact(String((e as Error).message ?? e))}`),
  });
  console.log(`proxy buy listening on ${process.env.HOST ?? "127.0.0.1"}:${cfg.port} (enabled: ${cfg.enabled})`);
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(`proxy buy: ${redact(String((e as Error).message ?? e), 300)}`);
  process.exit(1);
});
