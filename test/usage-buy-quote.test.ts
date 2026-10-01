/**
 * Counting /v1/buy quotes (api/buy.ts: countBuyQuote) never touches the payment path: the quote's 402 is
 * the same whether the usage database is up, down, throwing or hanging; a request that carries a payment
 * is never counted; and the key is VET402_USAGE_SALT only.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { countBuyQuote, isBuyQuote, usageCounter, usageKey } from "../src/usage/count.js";
import { agentPaysSolana, buyUrl, paidReq, S_URL, solRig } from "./proxy-buy-fakes.js";

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
