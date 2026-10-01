/**
 * Counting /v1/buy quotes (api/buy.ts: countBuyQuote) never touches the payment path: the quote's 402 is
 * the same whether the usage database is up, down, throwing or hanging; a request that carries a payment
 * is never counted; and the key is VET402_USAGE_SALT only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AWAKE_AFTER_CRON_MIN, countBuyQuote, databaseLikelyAwake, isBuyQuote, usageCounter, usageKey } from "../src/usage/count.js";
import type { Sql } from "../src/proxy-buy/db.js";
import { agentPaysSolana, buyUrl, paidReq, S_URL, solRig, testSql } from "./proxy-buy-fakes.js";

const KEY = "salt-for-tests-0123456789";

/** Status, the headers that carry the price, and the body: what an agent reads from a quote. */
async function shape(res: Response) {
  return { status: res.status, required: res.headers.get("payment-required"), auth: res.headers.get("www-authenticate"), body: await res.text() };
}

test("a quote answers the same 402 whether the usage database is up, down, throwing or hanging", async () => {
  const r = await solRig();
  const plain = await shape(await r.buy.handle(new Request(buyUrl(S_URL))));
  assert.equal(plain.status, 402);
  const counters = {
    down: usageCounter("buy_quote", () => ({ query: () => Promise.reject(new Error("connect ECONNREFUSED")) }), KEY),
    throws: () => {
      throw new Error("boom");
    },
    hangs: usageCounter("buy_quote", () => ({ query: () => new Promise(() => undefined) }), KEY),
  } as Record<string, (req: Request) => Promise<void>>;
  for (const [name, c] of Object.entries(counters)) {
    const req = new Request(buyUrl(S_URL));
    const t0 = performance.now();
    assert.equal(countBuyQuote(req, c), undefined, `${name}: returns at once, nothing to await`);
    assert.ok(performance.now() - t0 < 20, `${name}: not waited for`);
    assert.deepEqual(await shape(await r.buy.handle(req)), plain, `${name}: the same 402, byte for byte`);
  }
  assert.equal(r.fac.settles, 0);
});

test("a request that carries a payment, or reads a record, is never counted; a free GET is", async () => {
  const r = await solRig();
  const { header } = await agentPaysSolana(r.buy);
  let calls = 0;
  const c = async () => void calls++;
  countBuyQuote(paidReq(header), c);
  countBuyQuote(new Request(buyUrl(S_URL), { headers: { "x-payment": "x" } }), c);
  countBuyQuote(new Request(buyUrl(S_URL), { headers: { authorization: "Payment abc" } }), c);
  countBuyQuote(new Request("https://buy.test/api/buy?record=pb_1"), c);
  countBuyQuote(new Request(buyUrl(S_URL), { method: "POST" }), c);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 0, "no paid request, record read or POST is counted");
  assert.equal(isBuyQuote(paidReq(header)), false);
  countBuyQuote(new Request(buyUrl(S_URL)), c);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1, "the free quote is");
});

test("the key is VET402_USAGE_SALT only: without it nothing is counted (the alerts secret does not stand in)", async () => {
  assert.equal(usageKey({ VET402_PROXY_ALERTS_SECRET: "a".repeat(32) } as NodeJS.ProcessEnv), null);
  assert.equal(usageKey({ VET402_USAGE_SALT: KEY } as NodeJS.ProcessEnv), KEY);
  assert.equal(usageKey({ VET402_USAGE_SALT: "short" } as NodeJS.ProcessEnv), null);
  let queried = 0;
  const c = usageCounter("buy_quote", () => ({ query: async () => (queried++, { rows: [] }) }), usageKey({} as NodeJS.ProcessEnv));
  await c(new Request(buyUrl(S_URL)));
  assert.equal(queried, 0);
});

test("a free quote does not touch the database at all: with the database down it answers the same 402; a paid request still uses it", async () => {
  const real = await testSql();
  let down = false;
  let queries = 0;
  const sql: Sql = {
    query: (text, params) => {
      queries++;
      return down ? Promise.reject(new Error("connect ECONNREFUSED")) : real.query(text, params);
    },
    tx: (fn) => (down ? Promise.reject(new Error("connect ECONNREFUSED")) : real.tx(fn)),
  };
  const r = await solRig({ sql });
  const before = await shape(await r.buy.handle(new Request(buyUrl(S_URL))));
  assert.equal(before.status, 402);
  queries = 0;
  down = true;
  const after = await shape(await r.buy.handle(new Request(buyUrl(S_URL))));
  assert.deepEqual(after, before, "the same 402 with the database down");
  assert.equal(queries, 0, "not one query for a quote");
  down = false;
  const { header } = await agentPaysSolana(r.buy);
  queries = 0;
  await r.buy.handle(paidReq(header));
  assert.ok(queries > 0, "a paid request reads and writes the database as before");
  down = true;
  const paidDown = await r.buy.handle(paidReq(header));
  assert.equal(paidDown.status, 503, "and with the database down a paid request stops before any charge, as before");
  assert.equal(((await paidDown.json()) as { charged: boolean }).charged, false);
});

test("usage counts wait in memory and are written only while the database is awake anyway: never a wake-up of their own", async () => {
  const seen: unknown[][] = [];
  const db = { query: async (text: string, params?: unknown[]) => (seen.push([text, ...(params ?? [])]), { rows: [] }) };
  let t = new Date("2026-10-02T12:15:00Z");
  const c = usageCounter("check", () => db, KEY, () => t);
  const req = () => new Request("https://h.example/v1/check", { headers: { "x-forwarded-for": "198.51.100.4" } });
  await c(req());
  await c(req());
  assert.equal(seen.length, 0, "12:15: the database may be stopped; nothing is sent");
  assert.equal(databaseLikelyAwake(t, null), false);
  t = new Date("2026-10-02T12:31:00Z");
  await c(req());
  const inserts = seen.filter((x) => String(x[0]).startsWith("insert"));
  assert.equal(inserts.length, 1, "12:31, right after the cron run: one row");
  assert.equal(inserts[0]![5], 3, "with the three calls added up");
  seen.length = 0;
  t = new Date("2026-10-02T12:38:30Z");
  await c(req());
  assert.equal(seen.length, 0, "12:38:30: past the cron's window and 7.5 minutes after this instance's write");
  t = new Date("2026-10-02T13:00:20Z");
  await c(req());
  assert.equal(seen.filter((x) => String(x[0]).startsWith("insert"))[0]![5], 2, "the waiting call and this one are written in the next window");
  // the windows follow the cron: every 30 minutes, a few minutes long
  assert.deepEqual([0, 2, 6, 7, 29, 30, 36, 37].map((m) => databaseLikelyAwake(new Date(Date.UTC(2026, 9, 2, 12, m)), null)), [true, true, true, false, false, true, true, false]);
  assert.equal(AWAKE_AFTER_CRON_MIN, 6);
});
