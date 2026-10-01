/**
 * Counting /v1/buy quotes (api/buy.ts: countBuyQuote) never touches the payment path: the quote's 402 is
 * the same whether the usage database is up, down, throwing or hanging; a request that carries a payment
 * is never counted; and the key is VET402_USAGE_SALT only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AWAKE_AFTER_CRON_MIN, countBuyQuote, databaseLikelyAwake, isBuyQuote, usageCounter, usageKey } from "../src/usage/count.js";
import type { Sql } from "../src/proxy-buy/db.js";
import { memoryRateLimit, MEMORY_RATE_MAX_KEYS } from "../src/proxy-buy/handler.js";
import { paymentOf } from "../src/proxy-buy/payment-header.js";
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
  assert.equal(databaseLikelyAwake(t), false);
  t = new Date("2026-10-02T12:31:00Z");
  await c(req());
  const inserts = seen.filter((x) => String(x[0]).startsWith("insert"));
  assert.equal(inserts.length, 1, "12:31, right after the cron run: one row");
  assert.equal(inserts[0]![5], 3, "with the three calls added up");
  seen.length = 0;
  t = new Date("2026-10-02T12:38:30Z");
  await c(req());
  assert.equal(seen.length, 0, "12:38:30: past the cron's window");
  t = new Date("2026-10-02T13:00:20Z");
  await c(req());
  assert.equal(seen.filter((x) => String(x[0]).startsWith("insert"))[0]![5], 2, "the waiting call and this one are written in the next window");
  // the windows follow the cron: every 30 minutes, a few minutes long
  assert.deepEqual([0, 2, 6, 7, 29, 30, 36, 37].map((m) => databaseLikelyAwake(new Date(Date.UTC(2026, 9, 2, 12, m)))), [true, true, true, false, false, true, true, false]);
  assert.equal(AWAKE_AFTER_CRON_MIN, 6);
});

test("usage counts: calls every 3 minutes outside the window never write (no wake-up kept alive by the counter itself)", async () => {
  const seen: unknown[][] = [];
  const db = { query: async (text: string, params?: unknown[]) => (seen.push([text, ...(params ?? [])]), { rows: [] }) };
  let t = Date.parse("2026-10-02T12:07:00Z");
  const c = usageCounter("check", () => db, KEY, () => new Date(t));
  for (; t < Date.parse("2026-10-02T12:30:00Z"); t += 3 * 60_000) await c(new Request("https://h.example/v1/check"));
  assert.equal(seen.length, 0, "12:07 to 12:28, every 3 minutes: nothing written");
  t = Date.parse("2026-10-02T12:31:00Z");
  await c(new Request("https://h.example/v1/check"));
  assert.equal(seen.filter((x) => String(x[0]).startsWith("insert"))[0]![5], 9, "all of them in the next window, added up");
});

test("usage counts: one write at a time; three calls at once are all counted; a failed write keeps its rows", async () => {
  const rows: number[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  let first = true;
  const db = {
    query: async (text: string, params?: unknown[]) => {
      if (text.startsWith("insert")) {
        if (first) {
          first = false;
          await gate;
        }
        rows.push(Number(params![4]));
      }
      return { rows: [] };
    },
  };
  let t = new Date("2026-10-02T12:01:00Z");
  const c = usageCounter("check", () => db, KEY, () => t);
  const req = () => new Request("https://h.example/v1/check", { headers: { "x-forwarded-for": "198.51.100.9" } });
  const a = c(req());
  const b = c(req());
  const d = c(req());
  release();
  await Promise.all([a, b, d]);
  await c(req());
  assert.equal(rows.reduce((n, k) => n + k, 0), 4, "three at once and one after: four counted, none twice");
  // A write that fails: its rows come back and go out with the next write.
  let fail = true;
  const sent: number[] = [];
  const flaky = { query: async (text: string, params?: unknown[]) => {
    if (text.startsWith("insert")) {
      if (fail) throw new Error("connect ECONNREFUSED");
      sent.push(Number(params![4]));
    }
    return { rows: [] };
  } };
  const c2 = usageCounter("check", () => flaky, KEY, () => t);
  await assert.rejects(c2(req()));
  fail = false;
  t = new Date("2026-10-02T12:02:00Z");
  await c2(req());
  assert.deepEqual(sent, [2], "the failed call is not lost");
});

test("the quote limit in memory: a new minute starts empty, distinct clients are capped, each call stays O(1)", () => {
  const lim = memoryRateLimit(2, 60_000, 1000);
  const t0 = Date.parse("2026-10-02T12:00:00Z");
  let ok = 0;
  const start = performance.now();
  for (let i = 0; i < 200_000; i++) if (lim(`k${i}`, t0)) ok++;
  assert.equal(ok, 1000, "past the cap a new client is refused (quotes are free)");
  assert.ok(performance.now() - start < 1000, "200,000 distinct keys in well under a second");
  assert.equal(lim("k1", t0), true);
  assert.equal(lim("k1", t0), false, "the per-client limit");
  assert.equal(lim("new", t0 + 60_000), true, "a new minute starts empty");
  assert.equal(MEMORY_RATE_MAX_KEYS, 50_000);
});

test("free quote or paid: usage counting and the handler use the same test", () => {
  const cases: [Record<string, string>, boolean][] = [
    [{}, false],
    [{ "PAYMENT-SIGNATURE": "x" }, true],
    [{ "x-payment": "x" }, true],
    [{ "PAYMENT-SIGNATURE": "" }, false],
    [{ authorization: "Payment abc" }, true],
    [{ authorization: "Bearer abc" }, false],
    [{ authorization: " Payment abc" }, true], // Headers trims the value
  ];
  for (const [headers, paid] of cases) {
    const req = new Request(buyUrl(S_URL), { headers });
    assert.equal(paymentOf(req.headers) !== null, paid, JSON.stringify(headers));
    assert.equal(isBuyQuote(req), !paid, JSON.stringify(headers));
  }
});
