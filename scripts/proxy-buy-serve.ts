/**
 * Run proxy buy as one long-running HTTP process.
 *
 *   npx tsx scripts/proxy-buy-serve.ts --check   # print the config (no keys) and the allowlist size; no network, pays nothing
 *   npx tsx scripts/proxy-buy-serve.ts           # serve on PORT (default 8402)
 *
 * Everything comes from environment variables (see README, "Proxy buy"). Nothing is paid unless
 * VET402_PROXY_BUY_ENABLED=1 and a paid request arrives. The process takes an exclusive lock on its data
 * directory; a second one refuses to start.
 */
import { join } from "node:path";
import { loadAllowlist } from "../src/proxy-buy/allowlist.js";
import { Books } from "../src/proxy-buy/books.js";
import { configFromEnv, describeConfig } from "../src/proxy-buy/config.js";
import { createProxyBuy } from "../src/proxy-buy/handler.js";
import { startServer } from "../src/proxy-buy/http.js";
import { redact } from "../src/proxy-buy/reasons.js";
import { ownAddresses, solanaSide, tempoSide } from "../src/proxy-buy/wire.js";

async function main(): Promise<void> {
  const cfg = configFromEnv(process.env);
  const allowlist = loadAllowlist(join(import.meta.dirname, "..", "data"));
  const summary = {
    ...describeConfig(cfg),
    allowlist: {
      solana: allowlist.entries.filter((e) => e.chain === "solana").length,
      tempo: allowlist.entries.filter((e) => e.chain === "tempo").length,
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  if (process.argv.includes("--check")) return;
  if (!cfg.solana && !cfg.tempo) throw new Error("neither Solana nor Tempo is configured");

  const own = ownAddresses(cfg.solana, cfg.tempo);
  // One refund is at most what one purchase can charge: the per-purchase cap plus the fee.
  const maxRefund = cfg.maxPerCallAtomic + cfg.feeAtomic;
  const books = new Books({
    dataDir: cfg.dataDir,
    lock: true,
    ...(cfg.solana
      ? { solana: { payer: cfg.solana.payer, dailyCapAtomic: cfg.solana.dailyCapAtomic, maxPerCallAtomic: cfg.maxPerCallAtomic, dailyMaxPurchases: cfg.dailyMaxPurchases, dailyRefundCapAtomic: cfg.solana.dailyRefundCapAtomic, maxRefundAtomic: maxRefund } }
      : {}),
    ...(cfg.tempo
      ? { tempo: { payer: cfg.tempo.payer, dailyCapAtomic: cfg.tempo.dailyCapAtomic, dailyMaxPurchases: cfg.dailyMaxPurchases, dailyRefundCapAtomic: cfg.tempo.dailyRefundCapAtomic, maxRefundAtomic: maxRefund } }
      : {}),
  });
  const realm = new URL(cfg.publicOrigin).host;
  const buy = createProxyBuy({
    enabled: cfg.enabled,
    publicOrigin: cfg.publicOrigin,
    feeAtomic: cfg.feeAtomic,
    allowlist,
    books,
    quoteDeps: { fetchImpl: fetch, ownAddresses: own, solanaPayer: cfg.solana?.payer ?? null, tempoPayer: cfg.tempo?.payer ?? null },
    ...(cfg.solana ? { solana: await solanaSide(cfg.solana, own) } : {}),
    ...(cfg.tempo ? { tempo: tempoSide(cfg.tempo, realm) } : {}),
  });
  const server = await startServer(buy, {
    port: cfg.port,
    host: process.env.HOST ?? "127.0.0.1",
    origin: cfg.publicOrigin,
    trustProxy: process.env.VET402_PROXY_TRUST_PROXY === "1",
    // The message only: an error object can carry request data, never print it whole.
    onError: (e) => console.error(`proxy buy: unexpected error: ${redact(String((e as Error).message ?? e))}`),
  });
  console.log(`proxy buy listening on ${process.env.HOST ?? "127.0.0.1"}:${cfg.port} (enabled: ${cfg.enabled})`);
  const stop = () => {
    server.close(() => {
      books.release();
      process.exit(0);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(`proxy buy: ${redact(String((e as Error).message ?? e), 300)}`);
  process.exit(1);
});
