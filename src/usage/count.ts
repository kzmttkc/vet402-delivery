/**
 * How often the free endpoints are called: per UTC day, per endpoint, and how many different callers.
 *
 * Stored in the proxy-buy Postgres (DATABASE_URL), in its own table pc_usage. A caller is an HMAC of its IP
 * with a key that changes every UTC day (HMAC-SHA256 over the day, keyed by VET402_USAGE_SALT): the raw IP
 * is never stored, and the same IP gives unrelated values on different days. Without VET402_USAGE_SALT
 * nothing is counted. Calls whose User-Agent contains "vet402" are vet402's own and are counted apart
 * (own = true).
 *
 * Rows are kept USAGE_KEEP_DAYS days. Counts wait in memory until the database is awake anyway (see
 * usageCounter), so counting never wakes it. Counting is best effort: every error is swallowed. /v1/check waits for it at most http.ts USE_WAIT_MS;
 * the /v1/buy quote does not wait for it at all (countBuyQuote).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import pg from "pg";
import { paymentOf } from "../proxy-buy/payment-header.js";

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

/** Rows older than this many days are deleted (once a UTC day per instance, after a write). */
export const USAGE_KEEP_DAYS = 90;

/**
 * Minutes after each reconciler cron run (vercel.json, at :00 and :30) during which the database is awake
 * anyway: the cron's queries, then the operator's proxy-alerts read at :02 and :32, then Neon's 5 idle minutes.
 */
export const AWAKE_AFTER_CRON_MIN = 6;
/**
 * Would a query now find the database awake anyway (no wake-up of its own)? Only in the minutes after a cron
 * run. Not after this instance's own write: writing then would keep the database awake by itself.
 */
export function databaseLikelyAwake(at: Date): boolean {
  return at.getUTCMinutes() % 30 <= AWAKE_AFTER_CRON_MIN;
}

/** Most distinct (day, caller) rows kept in memory between writes; past it, new callers are not counted. */
export const USAGE_BUFFER_MAX = 5_000;

/**
 * A counter for one endpoint ("check", "buy_quote"). Without a database or a key it counts nothing.
 *
 * Counts are added up in this instance's memory and written only when the database is awake anyway (in the
 * minutes after a cron run), so counting never wakes a stopped database (Neon's free plan: 100 CU-hours a month). The price: an instance that stops before such a moment
 * loses its counts, so the table can only undercount.
 */
export function usageCounter(endpoint: string, db: () => UsageDb | null, key: string | null, now: () => Date = () => new Date()): (req: Request) => Promise<void> {
  let ready: Promise<unknown> | null = null;
  let prunedOn = "";
  let flushing = false;
  type Row = { day: string; caller: string; own: boolean; calls: number };
  const pending = new Map<string, Row>();
  const add = (r: Row) => {
    const k = `${r.day}|${r.caller}|${r.own}`;
    const cur = pending.get(k);
    if (cur) cur.calls += r.calls;
    else if (pending.size < USAGE_BUFFER_MAX) pending.set(k, { ...r });
  };
  return async (req: Request) => {
    const sql = db();
    if (!sql || !key) return;
    const at = now();
    const day = utcDay(at);
    add({ day, caller: callerId(callerIp(req), day, key), own: isOwnCall(req), calls: 1 });
    // One write at a time; counts that arrive meanwhile wait for the next one.
    if (flushing || !databaseLikelyAwake(at)) return;
    flushing = true;
    // Take the counts out first: a call that arrives during the write adds to a fresh buffer, never to rows
    // already sent. Rows whose write failed go back.
    const batch = [...pending.values()];
    pending.clear();
    let i = 0;
    try {
      ready ??= sql.query(USAGE_SCHEMA).catch((e) => {
        ready = null;
        throw e;
      });
      await ready;
      for (; i < batch.length; i++) {
        const row = batch[i]!;
        await sql.query(
          `insert into pc_usage (day, endpoint, caller, own, calls) values ($1, $2, $3, $4, $5)
           on conflict (day, endpoint, caller, own) do update set calls = pc_usage.calls + excluded.calls`,
          [row.day, endpoint, row.caller, row.own, row.calls],
        );
      }
      if (prunedOn !== day) {
        prunedOn = day;
        await sql.query(`delete from pc_usage where day < $1::date - $2::int`, [day, USAGE_KEEP_DAYS]);
      }
    } catch (e) {
      for (const row of batch.slice(i)) add(row);
      throw e;
    } finally {
      flushing = false;
    }
  };
}

/**
 * A free /v1/buy quote: a GET that carries no payment (the handler's own test, src/proxy-buy/payment-header.ts)
 * and is not a record read (/v1/buy/records/<id> arrives as ?record=).
 */
export function isBuyQuote(req: Request): boolean {
  if (req.method !== "GET") return false;
  if (paymentOf(req.headers)) return false;
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
