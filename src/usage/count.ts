/**
 * How often the free endpoints are called: per UTC day, per endpoint, and how many different callers.
 *
 * Stored in the proxy-buy Postgres (DATABASE_URL), in its own table pc_usage. A caller is an HMAC of its IP
 * with a key that changes every UTC day (HMAC-SHA256 over the day, keyed by VET402_USAGE_SALT): the raw IP
 * is never stored, and the same IP gives unrelated values on different days. Without VET402_USAGE_SALT
 * nothing is counted. Calls whose User-Agent contains "vet402" are vet402's own and are counted apart
 * (own = true).
 *
 * Counting is best effort: every error is swallowed. /v1/check waits for it at most http.ts USE_WAIT_MS;
 * the /v1/buy quote does not wait for it at all (countBuyQuote).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import pg from "pg";

export const USAGE_SCHEMA = `
create table if not exists pc_usage (
  day date not null,
  endpoint text not null,
  caller text not null,
  own boolean not null,
  calls bigint not null default 0,
  primary key (day, endpoint, caller, own)
)`;

export interface UsageDb {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The caller's IP as Vercel passes it: the first x-forwarded-for entry, else x-real-ip. */
export function callerIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

/** A caller id that cannot be turned back into the IP without the key, and differs every day. */
export function callerId(ip: string, day: string, key: string): string {
  const dayKey = createHmac("sha256", key).update(`vet402-usage ${day}`).digest();
  return createHmac("sha256", dayKey).update(ip).digest("hex").slice(0, 32);
}

export function isOwnCall(req: Request): boolean {
  return /vet402/i.test(req.headers.get("user-agent") ?? "");
}

/** VET402_USAGE_SALT, or null (then nothing is counted). No other secret stands in for it. */
export function usageKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const k = env.VET402_USAGE_SALT;
  return k && k.length >= 16 ? k : null;
}

/** A counter for one endpoint ("check", "buy_quote"). Without a database or a key it counts nothing. */
export function usageCounter(endpoint: string, db: () => UsageDb | null, key: string | null, now: () => Date = () => new Date()): (req: Request) => Promise<void> {
  let ready: Promise<unknown> | null = null;
  return async (req: Request) => {
    const sql = db();
    if (!sql || !key) return;
    ready ??= sql.query(USAGE_SCHEMA).catch((e) => {
      ready = null;
      throw e;
    });
    await ready;
    const day = utcDay(now());
    await sql.query(
      `insert into pc_usage (day, endpoint, caller, own, calls) values ($1, $2, $3, $4, 1)
       on conflict (day, endpoint, caller, own) do update set calls = pc_usage.calls + 1`,
      [day, endpoint, callerId(callerIp(req), day, key), isOwnCall(req)],
    );
  };
}

/**
 * A free /v1/buy quote: a GET that carries no payment (no PAYMENT-SIGNATURE, X-PAYMENT or Authorization:
 * Payment) and is not a record read (/v1/buy/records/<id> arrives as ?record=).
 */
export function isBuyQuote(req: Request): boolean {
  if (req.method !== "GET") return false;
  const h = req.headers;
  if (h.has("payment-signature") || h.has("x-payment") || /^\s*payment\s/i.test(h.get("authorization") ?? "")) return false;
  try {
    return !new URL(req.url).searchParams.has("record");
  } catch {
    return false;
  }
}

let buyQuoteCounter: ((req: Request) => Promise<void>) | null = null;

/**
 * Count a /v1/buy quote, without waiting and without any way to fail the request: synchronous, returns
 * nothing, swallows every error. A request that carries a payment is never counted (nor looked at further).
 */
export function countBuyQuote(req: Request, counter?: (req: Request) => Promise<void>): void {
  try {
    if (!isBuyQuote(req)) return;
    const c = counter ?? (buyQuoteCounter ??= usageCounter("buy_quote", () => usageDb(), usageKey()));
    void Promise.resolve()
      .then(() => c(req))
      .catch(() => undefined);
  } catch {
    // fail open
  }
}

let pool: pg.Pool | null = null;

/** One small pool per instance on DATABASE_URL; null when it is not set. */
export function usageDb(env: NodeJS.ProcessEnv = process.env): UsageDb | null {
  if (!env.DATABASE_URL) return null;
  if (!pool) {
    pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 2_000 });
    pool.on("error", () => undefined);
  }
  return pool;
}

/** Per day and endpoint: calls and different callers, outside callers and vet402's own apart. Last `days` days. */
export async function usageSummary(sql: UsageDb, days = 30): Promise<{ day: string; endpoint: string; calls: number; callers: number; ownCalls: number }[]> {
  await sql.query(USAGE_SCHEMA);
  const { rows } = await sql.query(
    `select to_char(day, 'YYYY-MM-DD') as day, endpoint,
            coalesce(sum(calls) filter (where not own), 0)::int as calls,
            count(*) filter (where not own)::int as callers,
            coalesce(sum(calls) filter (where own), 0)::int as own_calls
       from pc_usage where day >= current_date - $1::int
      group by day, endpoint order by day desc, endpoint`,
    [days],
  );
  return rows.map((r) => ({ day: String(r.day), endpoint: String(r.endpoint), calls: Number(r.calls), callers: Number(r.callers), ownCalls: Number(r.own_calls) }));
}

/** The same check as the alerts endpoint: Authorization: Bearer <secret>, compared in constant time. */
export function bearerOk(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 16 || header === null) return false;
  const a = createHash("sha256").update(header).digest();
  const b = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(a, b);
}
