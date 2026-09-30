/**
 * Proxy buy's state lives in Postgres, so that any number of serverless instances, and an instance that
 * is stopped half way, share one set of books. Everything that must not happen twice is a unique key or a
 * conditional UPDATE in the database, never an in-memory check:
 *   - one purchase per signed payment: pb_purchase primary key (the payment key);
 *   - one purchase per settled on-chain payment: pb_customer_tx primary key (chain, tx);
 *   - caps: a single conditional UPDATE on the day row / the wallet row (Postgres re-checks the WHERE
 *     clause under the row lock, so concurrent reservations cannot both pass);
 *   - one refund per purchase: pb_refund primary key (purchase id); a new attempt only from status "dead";
 *   - one purchase per seller payment or refund found on chain: pb_chain_tx primary key (chain, tx);
 *   - request limits and daily counters (per-client quotes, refund account creations): pb_counter.
 *
 * Amounts are bigint columns, read back as text (drivers differ in how they return bigint).
 */
import type { Pool, PoolClient } from "pg";

export interface Sql {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Run `fn` in one transaction; throwing rolls it back. */
  tx<R>(fn: (q: Sql) => Promise<R>): Promise<R>;
}

export const SCHEMA = `
create table if not exists pb_purchase (
  id text primary key,
  chain text not null,
  state text not null,
  day date,
  target text not null,
  seller_host text not null default '',
  agent text,
  seller_amount bigint not null,
  fee_reserve bigint not null,
  total bigint not null,
  reserved bigint not null default 0,
  facts jsonb not null default '{}'::jsonb,
  record jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  checked_at timestamptz
);
create index if not exists pb_purchase_state_idx on pb_purchase (state, updated_at);
create index if not exists pb_purchase_host_idx on pb_purchase (seller_host, state);
create index if not exists pb_purchase_agent_idx on pb_purchase (agent, state);
create table if not exists pb_customer_tx (
  chain text not null,
  tx text not null,
  purchase_id text not null,
  primary key (chain, tx)
);
create table if not exists pb_chain_tx (
  chain text not null,
  tx text not null,
  purchase_id text not null,
  kind text not null,
  at timestamptz not null,
  primary key (chain, tx)
);
create table if not exists pb_counter (
  key text primary key,
  at timestamptz not null,
  count integer not null
);
create table if not exists pb_day (
  chain text not null,
  day date not null,
  cap bigint not null,
  max_count integer not null,
  refund_cap bigint not null,
  committed bigint not null default 0,
  count integer not null default 0,
  refunded bigint not null default 0,
  refund_reserved bigint not null default 0,
  primary key (chain, day)
);
create table if not exists pb_wallet (
  chain text primary key,
  payer text not null,
  floor bigint not null
);
create table if not exists pb_refund (
  purchase_id text primary key,
  chain text not null,
  day date not null,
  to_addr text not null,
  amount bigint not null,
  status text not null,
  attempt integer not null default 1,
  tx text,
  facts jsonb not null default '{}'::jsonb,
  fee_paid bigint,
  reason text,
  failures integer not null default 0,
  updated_at timestamptz not null
);
alter table pb_purchase add column if not exists checked_at timestamptz;
alter table pb_refund add column if not exists failures integer not null default 0;
alter table pb_purchase add column if not exists spent bigint not null default 0;
alter table pb_purchase add column if not exists seller_open boolean not null default false;
create index if not exists pb_purchase_seller_open_idx on pb_purchase (seller_open) where seller_open;
create table if not exists pb_alert (
  key text primary key,
  purchase_id text not null,
  chain text not null,
  reason text not null,
  first_at timestamptz not null,
  last_at timestamptz not null,
  count integer not null default 1,
  resolved_at timestamptz,
  note text
);
create index if not exists pb_alert_open_idx on pb_alert (purchase_id) where resolved_at is null;
create index if not exists pb_counter_at_idx on pb_counter (at);
`;

/** node-postgres over a pool (Neon's pooled connection string on Vercel). */
export function pgSql(pool: Pool): Sql {
  const wrap = (c: Pool | PoolClient): Sql => ({
    async query<T>(text: string, params: unknown[] = []) {
      const r = await c.query(text, params as unknown[]);
      return { rows: r.rows as T[] };
    },
    async tx<R>(fn: (q: Sql) => Promise<R>): Promise<R> {
      if (c !== pool) return fn(wrap(c)); // already inside a transaction
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await fn(wrap(client));
        await client.query("commit");
        return out;
      } catch (e) {
        await client.query("rollback").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
  });
  return wrap(pool);
}

/** Advisory lock key for migrations: concurrent cold starts create the tables one at a time. */
const MIGRATE_LOCK = 402_402_402;

export async function migrate(sql: Sql): Promise<void> {
  await sql.tx(async (q) => {
    await q.query("select pg_advisory_xact_lock($1)", [MIGRATE_LOCK]);
    for (const stmt of SCHEMA.split(";").map((x) => x.trim()).filter(Boolean)) await q.query(stmt);
  });
}
