/**
 * Vercel Function (Node.js runtime, Web handler): GET /v1/buy and GET /v1/buy/records/<id> (rewrites in vercel.json).
 * All state is in Postgres (DATABASE_URL), so any number of instances share one set of books.
 */
import { join } from "node:path";
import { configFromEnv } from "../src/proxy-buy/config.js";
import { redact } from "../src/proxy-buy/reasons.js";
import { buildProxyBuy } from "../src/proxy-buy/wire.js";

let app: ReturnType<typeof buildProxyBuy> | null = null;

function instance(): ReturnType<typeof buildProxyBuy> {
  if (!app) {
    app = buildProxyBuy(configFromEnv(process.env), { dataDir: join(process.cwd(), "data") }).catch((e) => {
      app = null;
      throw e;
    });
  }
  return app;
}

export async function GET(request: Request): Promise<Response> {
  try {
    return await (await instance()).buy.handle(request);
  } catch (e) {
    // The message only, URLs removed: an error can carry the database or RPC URL.
    console.error(`proxy buy: ${redact(String((e as Error).message ?? e), 300)}`);
    return new Response(JSON.stringify({ error: "internal_error" }), { status: 500, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
}
