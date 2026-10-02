/**
 * A lane request that cannot be filled is never bought (review of the payment path, 2026-10-02): every failure of
 * fillParams, sends_message and commits_to_purchase above all, with or without an earlier 4xx. The plan goes through
 * the same steps as scripts/evm-lane.ts (groupByPayTo, confirmLive, laneEntries); the purchase is a fake that only
 * counts its calls, so nothing is signed or paid.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { getAddress } from "viem";
import { EVM_CHAINS } from "../src/evm/chains.js";
import type { ChainBuyEntry } from "../src/evm/evm-buy.js";
import { repairLaneRequest, type LastPaid } from "../src/evm/lane-input.js";
import { confirmLive, groupByPayTo, laneEntries, type Probe } from "../src/evm/lane-plan.js";

const ARB = EVM_CHAINS.arbitrum;
const PAYER = getAddress("0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51");
const TODAY = "2026-10-02";
const NOW = Date.parse("2026-10-02T00:00:00Z");
const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);
const accept = (payTo: string) => ({ scheme: "exact", network: ARB.caip2, amount: "3000", asset: ARB.asset, payTo, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" } });
const listing = (resource: string, payTo: string, description: string, input: Record<string, unknown>) => ({ resource, description, accepts: [accept(payTo)], extensions: { bazaar: { info: { input: { type: "http", ...input } } } } });

/** A required input whose only value is a placeholder nothing names. */
const UNFILLABLE = {
  ...listing("https://u.test/account", addr(1), "Look up an account", { method: "GET", queryParams: { account_ref: "<your-account-ref>" } }),
};
UNFILLABLE.extensions.bazaar = { ...UNFILLABLE.extensions.bazaar, schema: { properties: { input: { properties: { queryParams: { type: "object", properties: { account_ref: { type: "string" } }, required: ["account_ref"] } } } } } } as never;
/** A required input declared as a JSON schema, with no value anywhere. */
const UNFILLABLE_SCHEMA = listing("https://u2.test/email-search", addr(8), "Search the emails of a domain", { method: "GET", queryParams: { type: "object", properties: { email_domain: { type: "string" } }, required: ["email_domain"] } });
const SMS_POST = listing("https://m.test/v1/send", addr(2), "Sends an SMS text message to a phone number", { method: "POST", body: { to: "+15555550100", text: "hello" } });
const SMS_GET = listing("https://m2.test/notify", addr(3), "Sends an SMS text message to the number given", { method: "GET", queryParams: { to: "+15555550100" } });
const DOMAIN = listing("https://d.test/v1/domains", addr(4), "Register a new domain name for one year", { method: "POST", body: { name: "example.com" } });
const PLAN = listing("https://s.test/v1/plan", addr(5), "Subscribe to the pro plan, billed monthly", { method: "GET", queryParams: { tier: "pro" } });
const FILLABLE = listing("https://f.test/price", addr(6), "Token price", { method: "GET", queryParams: { symbol: "ETH" } });
const NO_INPUT = listing("https://n.test/stats", addr(7), "Network stats", { method: "GET" });

/** The lane's own steps, a fake probe that answers every request with a 402, and a fake purchase that counts. */
async function plannedPurchases(catalog: unknown[], lastPaid?: Map<string, LastPaid>) {
  const probed: string[] = [];
  const probe: Probe = async (o) => {
    probed.push(o.resource);
    const l = (catalog as { resource: string; accepts: ReturnType<typeof accept>[] }[]).find((x) => o.resource.startsWith(x.resource.split("?")[0]!))!;
    return { status: 402, accepts: l.accepts as never, raw: "" };
  };
  const groups = groupByPayTo(catalog as never, ARB, { maxPerAtomic: 100_000n, today: TODAY, nowMs: NOW, ...(lastPaid ? { lastPaid } : {}) });
  const choices = await confirmLive(groups, ARB, probe, { payer: PAYER, maxPerAtomic: 100_000n });
  const entries = laneEntries(choices, ARB);
  const bought: string[] = [];
  const buy = async (e: ChainBuyEntry) => {
    bought.push(e.listingResource ?? e.resource);
  };
  for (const e of entries) await buy(e);
  return { groups, probed, bought, skipped: groups.flatMap((g) => g.inputSkipped ?? []) };
}

test("a listing whose request cannot be filled is never bought: a required input without a value, sends_message, commits_to_purchase", async () => {
  const catalog = [UNFILLABLE, UNFILLABLE_SCHEMA, SMS_POST, SMS_GET, DOMAIN, PLAN];
  const r = await plannedPurchases(catalog);
  assert.equal(r.bought.length, 0, `bought: ${r.bought.join(", ")}`);
  assert.equal(r.probed.length, 0, "not even the unpaid request is sent");
  const why = new Map(r.skipped.map((s) => [s.resource, s.why]));
  assert.equal(why.get(UNFILLABLE.resource), "input_unfillable: unknown_param (account_ref)");
  assert.match(why.get(UNFILLABLE_SCHEMA.resource)!, /^input_unfillable: /);
  assert.match(why.get(SMS_POST.resource)!, /^input_unfillable: sends_message/);
  assert.match(why.get(SMS_GET.resource)!, /^input_unfillable: sends_message/);
  assert.match(why.get(DOMAIN.resource)!, /^input_unfillable: commits_to_purchase/);
  assert.match(why.get(PLAN.resource)!, /^input_unfillable: commits_to_purchase/);
});

test("a listing that can be filled is bought as before", async () => {
  const r = await plannedPurchases([FILLABLE, NO_INPUT]);
  assert.deepEqual(r.bought.sort(), [FILLABLE.resource, NO_INPUT.resource].sort());
  assert.equal(r.skipped.length, 0);
});

test("with no earlier 4xx (nothing paid before), a request that cannot be filled is still not bought; mixed with fillable ones, only those are", async () => {
  const r = await plannedPurchases([UNFILLABLE, UNFILLABLE_SCHEMA, SMS_POST, SMS_GET, DOMAIN, PLAN, FILLABLE, NO_INPUT], new Map<string, LastPaid>());
  assert.deepEqual(r.bought.sort(), [FILLABLE.resource, NO_INPUT.resource].sort());
  assert.equal(r.skipped.length, 6);
  // The same at the level of one request, with no last answer at all.
  for (const l of [UNFILLABLE, SMS_POST, SMS_GET, DOMAIN, PLAN]) {
    const input = l.extensions.bazaar.info.input as unknown as { method: "GET" | "POST"; body?: unknown };
    const x = repairLaneRequest(l as never, { resource: l.resource, method: input.method, query: null, body: input.body ?? null }, TODAY, null, NOW);
    assert.equal(x.ok, false, l.resource);
    assert.match(!x.ok ? x.reason : "", /^input_unfillable:/, l.resource);
  }
  // A body that is not a JSON object is not given to fillParams; sends_message is refused before it.
  const raw = repairLaneRequest(SMS_POST as never, { resource: SMS_POST.resource, method: "POST", query: null, body: "to=+15555550100" }, TODAY, null, NOW);
  assert.deepEqual(raw, { ok: false, reason: "input_unfillable:sends_message", param: null });
});
