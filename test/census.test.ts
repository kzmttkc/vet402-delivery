import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSigner } from "@solana/kit";
import {
  CENSUS_MAX_PER_PURCHASE_ATOMIC,
  CENSUS_MAX_PURCHASES,
  CENSUS_MAX_TOTAL_ATOMIC,
  PAYER_ADDRESS,
  SOLANA_MAINNET,
  USDC_MINT,
} from "../src/constants.js";
import { Budget, type SolAccept } from "../src/guard.js";
import { payOne, type PayDeps, type PlanEntry, type PurchaseRecord } from "../src/pay.js";
import { classifyRecord, failureMode, type ClassInput } from "../src/classify.js";
import { declarationFromListing, judgeDelivery } from "../src/verdict.js";
import { onePerPayTo, selectCensus } from "../src/census.js";
import { endpointUrl, flatPriceAtomic, payshListings } from "../src/paysh.js";
import type { Listing } from "../src/discovery.js";

const SELLER = (await generateKeyPairSigner()).address;
const SELLER2 = (await generateKeyPairSigner()).address;
const FACILITATOR = (await generateKeyPairSigner()).address;
const SIG = "5".repeat(88);

const censusBudget = (file: string | null = null) => new Budget(file, CENSUS_MAX_TOTAL_ATOMIC, CENSUS_MAX_PURCHASES, CENSUS_MAX_PER_PURCHASE_ATOMIC);
const refusedWord = (r: unknown) => (r as { refused?: string }).refused;

// ---------- caps ----------

test("census caps are 0.10 per purchase and 35 USDC in total", () => {
  assert.equal(CENSUS_MAX_PER_PURCHASE_ATOMIC, 100_000n);
  assert.equal(CENSUS_MAX_TOTAL_ATOMIC, 35_000_000n);
  const b = censusBudget();
  assert.equal(refusedWord(b.reserve(100_001n, "over.example")), "price_over_cap");
  for (let i = 0; i < 350; i++) assert.ok("ok" in b.reserve(100_000n, `h${i}.example`), `purchase ${i}`);
  assert.equal(b.spent, 35_000_000n);
  assert.equal(refusedWord(b.reserve(1n, "one-more.example")), "total_cap_reached");
});

test("census total cap counts what the chain says left the wallet", () => {
  const b = censusBudget();
  b.setBaselineIfMissing(100_000_000n);
  // ledger says 0 spent, chain says 34.95 left the wallet
  assert.equal(refusedWord(b.reserve(100_000n, "x.example", 65_050_000n)), "total_cap_reached");
  assert.ok("ok" in b.reserve(50_000n, "y.example", 65_050_000n));
});

// ---------- no double payment ----------

test("persistent ledger: a host bought in one run is refused in the next", () => {
  const file = join(mkdtempSync(join(tmpdir(), "census-")), "ledger.json");
  const a = censusBudget(file);
  const r = a.reserve(10_000n, "seller.example");
  assert.ok("ok" in r);
  a.commit((r as { id: string }).id);
  const b = censusBudget(file); // a re-run reads the same file
  assert.equal(refusedWord(b.reserve(10_000n, "seller.example")), "already_bought");
  assert.equal(b.spent, 10_000n);
});

test("persistent ledger: a reservation made before a crash stays spent; an unreadable ledger fails closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "census-"));
  const file = join(dir, "ledger.json");
  censusBudget(file).reserve(20_000n, "crashed.example"); // never committed nor released
  assert.equal(refusedWord(censusBudget(file).reserve(20_000n, "crashed.example")), "already_bought");
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{not json");
  const c = censusBudget(bad);
  assert.notEqual(refusedWord(c.reserve(1_000n, "fresh.example")), undefined);
});

function accept(over: Partial<SolAccept> = {}): SolAccept {
  return { scheme: "exact", network: SOLANA_MAINNET, amount: "10000", asset: USDC_MINT, payTo: SELLER, extra: { feePayer: FACILITATOR }, ...over };
}

/** A seller: 402 unpaid, 200 JSON when paid. Counts signatures and paid requests. */
function liveDeps(budget: Budget, body = '{"price":1,"symbol":"SOL"}', lamports: bigint[] = [100_000_000n]) {
  let signerCalls = 0;
  let paidRequests = 0;
  let bal = 0;
  const f = (async (_url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    if (h.has("PAYMENT-SIGNATURE")) {
      paidRequests++;
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }
    const pr = { x402Version: 2, resource: { url: "https://seller.example/x" }, accepts: [{ ...accept() }] };
    return new Response("{}", { status: 402, headers: { "content-type": "application/json", "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") } });
  }) as unknown as typeof fetch;
  const deps: PayDeps = {
    fetch: f,
    payer: PAYER_ADDRESS,
    budget,
    createPayment: async () => {
      signerCalls++;
      return { headers: { "PAYMENT-SIGNATURE": "signed" }, txBase64: "AAAA" };
    },
    checkTx: async () => ({ ok: true, facts: { feePayer: FACILITATOR, destinationAta: "x", amount: "10000", memo: "m" } }),
    readBalances: async () => ({ lamports: lamports[Math.min(bal++, lamports.length - 1)]!, usdcAtomic: 50_000_000n }),
    waitForSettlement: async () => ({
      signature: SIG,
      found: true,
      confirmed: true,
      err: null,
      memo: "m",
      payToDeltaAtomic: "10000",
      payerDeltaAtomic: "-10000",
      payerLamportsDelta: "0",
      feePayer: FACILITATOR,
    }),
  };
  return { deps, counts: () => ({ signerCalls, paidRequests }) };
}

const entry: PlanEntry = {
  host: "seller.example",
  requestUrl: "https://seller.example/x",
  exampleInput: null,
  lock: { payTo: SELLER, amount: "10000", asset: USDC_MINT, network: SOLANA_MAINNET, feePayer: FACILITATOR },
};

test("payOne pays a host once; the second attempt is refused before signing or sending", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "census-")), "ledger.json");
  const { deps, counts } = liveDeps(censusBudget(file));
  const first = await payOne(entry, deps);
  assert.equal(first.outcome, "sent");
  assert.equal(first.settled, true);
  assert.deepEqual(counts(), { signerCalls: 1, paidRequests: 1 });
  const second = await payOne(entry, { ...deps, budget: censusBudget(file) }); // a re-run, same ledger file
  assert.equal(second.outcome, "refused");
  assert.equal(second.refusal?.refused, "already_bought");
  assert.deepEqual(counts(), { signerCalls: 1, paidRequests: 1 });
});

test("payOne records a SOL decrease (the census loop stops on it)", async () => {
  const { deps } = liveDeps(censusBudget(), undefined, [100_000_000n, 99_995_000n]);
  const rec = await payOne(entry, deps);
  assert.equal(rec.solDecreased, true);
});

test("payOne with a judge: delivered follows the declaration, not just 2xx", async () => {
  const decl = { outputSchema: { type: "object", required: ["price", "volume"] } };
  const { deps } = liveDeps(censusBudget());
  const rec = await payOne(entry, { ...deps, judge: (d) => judgeDelivery(decl, d) });
  assert.equal(rec.settled, true);
  assert.equal(rec.delivered, false);
  const c = classifyRecord(rec);
  assert.equal(c.status, "settled_not_delivered");
  assert.equal(c.reason, "delivery_missing_keys");
  assert.equal(c.category, "missing_keys");
  assert.equal(c.displayClass, "MISMATCH");

  const ok = liveDeps(censusBudget());
  const rec2 = await payOne(entry, { ...ok.deps, judge: (d) => judgeDelivery({ outputSchema: { required: ["price"] } }, d) });
  const c2 = classifyRecord(rec2);
  assert.deepEqual([c2.status, c2.settled, c2.delivered, c2.category, c2.displayClass], ["delivered", true, true, null, "DELIVERED"]);
});

// ---------- classifications (vet402-algorand fix-first) ----------

test("failureMode groups like vet402-algorand fix-first", () => {
  const cases: [ClassInput, string | null][] = [
    [{ verdict: "ALLOW", reason: "delivered" }, null],
    [{ verdict: "REFUSE", reason: "not_x402", detail: "expected 402, got 404" }, "gone"],
    [{ verdict: "REFUSE", reason: "not_x402", detail: "expected 402, got 503" }, "down"],
    [{ verdict: "REFUSE", reason: "not_x402", detail: "expected 402, got 200" }, "free_200"],
    [{ verdict: "REFUSE", reason: "not_x402", detail: "expected 402, got 401" }, "auth"],
    [{ verdict: "REFUSE", reason: "not_x402", detail: "402 without parseable x402 payment requirements" }, "unreadable_402"],
    [{ verdict: "REFUSE", reason: "no_supported_accept" }, "no_accept"],
    [{ verdict: "REFUSE", reason: "payment_failed", detail: "status 402, subcent_quota_exceeded" }, "facilitator_quota"],
    [{ verdict: "REFUSE", reason: "payment_failed", detail: "status 402, invalid_payment" }, "payment_refused"],
    [{ verdict: "REFUSE", reason: "payment_failed", detail: "status 200, no matching settlement found on chain" }, "no_receipt"],
    [{ verdict: "REFUSE", reason: "payment_failed", detail: "fetch: The operation was aborted due to timeout" }, "timeout"],
    [{ verdict: "REFUSE", reason: "http_error", paid: true, delivery: "500 text/html" }, "server_error_paid"],
    [{ verdict: "REFUSE", reason: "http_error", paid: true, delivery: "400 application/json" }, "example_rejected"],
    [{ verdict: "REFUSE", reason: "not_json", paid: true }, "not_json"],
    [{ verdict: "REFUSE", reason: "delivery_missing_keys", paid: true }, "missing_keys"],
    [{ verdict: "REFUSE", reason: "placeholder_unfillable" }, "example_placeholder"],
    [{ verdict: "REFUSE", reason: "total_cap_reached" }, "vet402_limit"],
    [{ verdict: "REFUSE", reason: "already_bought" }, "vet402_limit"],
    [{ verdict: "REFUSE", reason: "tx_check_failed" }, "vet402_limit"],
    [{ verdict: "REFUSE", reason: "same_payto" }, "vet402_limit"],
    [{ verdict: "REFUSE", reason: "price_changed" }, "other"],
  ];
  for (const [input, want] of cases) assert.equal(failureMode(input), want, JSON.stringify(input));
});

test("classifyRecord maps gate 1 refusals to the Algorand reason words", () => {
  const base = (probe: Partial<PurchaseRecord["probe"]>, refused?: string): PurchaseRecord => ({
    host: "h",
    requestUrl: "https://h/x",
    outcome: "refused",
    probe: { status: 402, x402Version: 2, payTo: null, amount: null, asset: null, feePayer: null, ...probe },
    ...(refused ? { refusal: { refused: refused as never, detail: "d" } } : {}),
  });
  const pick = (r: PurchaseRecord) => {
    const c = classifyRecord(r);
    return [c.status, c.reason, c.category];
  };
  assert.deepEqual(pick(base({ status: 404 }, "no_solana_accept")), ["refused", "not_x402", "gone"]);
  assert.deepEqual(pick(base({ status: null, error: "fetch: getaddrinfo ENOTFOUND h" }, "no_solana_accept")), ["refused", "probe_error", "timeout"]);
  assert.deepEqual(pick(base({ error: "unparseable 402: bad" }, "no_solana_accept")), ["refused", "not_x402", "unreadable_402"]);
  assert.deepEqual(pick(base({}, "mint_mismatch")), ["refused", "no_supported_accept", "no_accept"]);
  assert.deepEqual(pick(base({}, "fee_payer_missing")), ["refused", "no_supported_accept", "no_accept"]);
  assert.deepEqual(pick(base({}, "payto_mismatch")), ["refused", "price_changed", "other"]);
  assert.deepEqual(pick(base({}, "price_over_cap")), ["refused", "price_over_cap", "vet402_limit"]);
  assert.deepEqual(pick(base({}, "total_cap_reached")), ["refused", "total_cap_reached", "vet402_limit"]);
  const notSent = { ...base({}), outcome: "not_sent" as const, refusal: { refused: "tx_check_failed" as const, detail: "2 token transfers" } };
  assert.deepEqual(pick(notSent), ["not_sent", "tx_check_failed", "vet402_limit"]);
  const refused402: PurchaseRecord = { ...base({}), outcome: "sent", settled: false, response: { status: 402, contentType: null, first300: "" }, settlementHeader: { success: false, errorReason: "subcent_quota_exceeded" } };
  assert.deepEqual(pick(refused402), ["not_settled", "payment_failed", "facilitator_quota"]);
  const paid500: PurchaseRecord = { ...base({}), outcome: "sent", settled: true, response: { status: 500, contentType: "text/html", first300: "oops" } };
  assert.deepEqual(pick(paid500), ["settled_not_delivered", "http_error", "server_error_paid"]);
});

// ---------- delivery judgement (vet402-algorand verdict) ----------

test("judgeDelivery: required keys are the promise; example keys are hints", () => {
  const d = (body: string, status = 200) => ({ status, contentType: "application/json", bodyText: body });
  assert.equal(judgeDelivery({ outputSchema: { required: ["a"] } }, d('{"a":null}')).verdict, "ALLOW");
  assert.equal(judgeDelivery({ outputSchema: { required: ["a", "b"] } }, d('{"a":1}')).reason, "delivery_missing_keys");
  assert.equal(judgeDelivery({ outputExample: { x: 1, y: 2 } }, d('{"error":"bad"}')).reason, "delivery_missing_keys");
  const partial = judgeDelivery({ outputExample: { x: 1, y: 2 } }, d('{"x":1}'));
  assert.equal(partial.verdict, "ALLOW");
  assert.match(partial.note ?? "", /y/);
  assert.equal(judgeDelivery({}, d("<html>")).reason, "not_json");
  assert.equal(judgeDelivery({}, d("[]")).reason, "empty_body");
  assert.equal(judgeDelivery({}, d("{}", 503)).reason, "http_error");
  assert.equal(judgeDelivery({}, d('{"anything":1}')).verdict, "ALLOW");
});

test("declarationFromListing reads CDP bazaar, PayAI outputSchema and v1 accept outputSchema", () => {
  const cdp = {
    resource: "https://a.example/x",
    description: "cdp desc",
    accepts: [{ ...accept() }],
    extensions: { bazaar: { info: { output: { example: { p: 1 } } }, schema: { properties: { output: { properties: { example: { type: "object", required: ["p"] } } } } } } },
  } as unknown as Listing;
  const dc = declarationFromListing(cdp);
  assert.deepEqual(dc.outputSchema, { type: "object", required: ["p"] });
  assert.deepEqual(dc.outputExample, { p: 1 });
  assert.equal(dc.description, "cdp desc");

  const payai = { resource: "https://b.example/x", accepts: [{ ...accept() }], outputSchema: { type: "json", example: { q: 2 } }, mimeType: "application/json" } as unknown as Listing;
  const dp = declarationFromListing(payai);
  assert.deepEqual(dp.outputExample, { q: 2 });
  assert.equal(dp.outputSchema, undefined);
  assert.equal(dp.mimeType, "application/json");

  const v1 = {
    resource: "https://c.example/x",
    x402Version: 1,
    accepts: [{ ...accept(), network: "solana", description: "v1 desc", outputSchema: { input: { type: "http" }, output: { type: "object", required: ["r"] } } }],
  } as unknown as Listing;
  const d1 = declarationFromListing(v1);
  assert.deepEqual(d1.outputSchema, { type: "object", required: ["r"] });
  assert.equal(d1.description, "v1 desc");
});

// ---------- selection ----------

function listing(resource: string, amount: string, over: Record<string, unknown> = {}): Listing {
  return { resource, x402Version: 2, method: "GET", accepts: [{ ...accept({ amount }) }], ...over } as unknown as Listing;
}

test("selectCensus: union deduplicated by URL and host, cheapest GET <= 0.10 per host, sources kept", () => {
  const payai = [
    listing("https://one.example/a", "20000"),
    listing("https://one.example/b", "5000"),
    listing("https://two.example/x", "150000"), // over 0.10
    listing("https://vet402.com/own", "1000"), // own host
    listing("https://gate1.example/x", "1000"), // bought in gate 1
  ];
  const cdp = [
    listing("https://one.example/b", "5000"), // same URL as PayAI
    listing("https://one.example/b", "5000"), // CDP duplicate item
    listing("https://three.example/p", "3000", { method: "POST", extensions: { bazaar: { info: { input: { method: "POST" } } } } }),
    { resource: "https://base-only.example/x", accepts: [{ scheme: "exact", network: "eip155:8453", amount: "1000", asset: "0x", payTo: "0x1" }] } as unknown as Listing,
    listing("https://ph.example/q", "1000", { extensions: { bazaar: { info: { input: { type: "http", method: "GET", queryParams: { type: "object", properties: { wallet: { type: "string" } }, required: ["wallet"] } } } } } }),
  ];
  const paysh = payshListings([
    {
      fqn: "p/one",
      service_url: "https://four.example/",
      endpoints: [
        { method: "GET", path: "v1/data", protocol: ["x402"], pricing: { mode: "flat", dimensions: [{ tiers: [{ price_usd: 0.012 }] }] } },
        { method: "GET", path: "v1/cheap", protocol: ["mpp"], pricing: { mode: "flat", dimensions: [{ tiers: [{ price_usd: 0.001 }] }] } },
        { method: "GET", path: "v1/item/:id", protocol: ["x402"], pricing: { mode: "flat", dimensions: [{ tiers: [{ price_usd: 0.001 }] }] } },
      ],
    },
  ]);
  const sel = selectCensus({ payai, cdp, paysh }, { alreadyBoughtHosts: ["gate1.example"] });
  const hosts = Object.fromEntries(sel.hosts.map((h) => [h.host, h]));
  assert.deepEqual(Object.keys(hosts).sort(), ["four.example", "one.example", "ph.example"]);
  const one = hosts["one.example"]!.candidates[0]!;
  assert.equal(one.url, "https://one.example/b");
  assert.equal(one.priceAtomic, 5000n);
  assert.deepEqual(one.sources, ["payai", "cdp"]);
  assert.equal(hosts["four.example"]!.candidates[0]!.source, "paysh");
  assert.equal(hosts["four.example"]!.candidates[0]!.priceAtomic, 12_000n);
  assert.equal(hosts["four.example"]!.candidates[0]!.declaredAccept, null);
  assert.equal(hosts["four.example"]!.candidates.length, 1); // mpp and path-param endpoints are out
  assert.equal(hosts["ph.example"]!.candidates.length, 0); // required input without an example: not sent
  assert.equal(hosts["ph.example"]!.placeholder.length, 1);
  assert.deepEqual(sel.stats.hostsAlreadyBought, ["gate1.example"]);
  assert.equal(sel.stats.hostsOwn, 1);
  assert.equal(sel.stats.bySource.payai.dropped["price_over_0.10"], 1);
  assert.equal(sel.stats.bySource.cdp.dropped["not_get"], 1);
  assert.equal(sel.stats.bySource.paysh.dropped["not_x402_protocol"], 1);
  assert.equal(sel.stats.bySource.paysh.dropped["path_params"], 1);
  assert.equal(sel.stats.bySource.cdp.solana, 4); // the Base-only listing is not in the Solana market
  // placeholder-only hosts sort last
  assert.equal(sel.hosts.at(-1)!.host, "ph.example");
});

test("onePerPayTo keeps the first host per payTo", () => {
  const t = (host: string, payTo: string) => ({ host, lock: { payTo } });
  const { kept, dropped } = onePerPayTo([t("a", SELLER), t("b", SELLER2), t("c", SELLER)]);
  assert.deepEqual(kept.map((x) => x.host), ["a", "b"]);
  assert.deepEqual(dropped.map((x) => x.host), ["c"]);
});

test("pay.sh helpers: flat price and URL join", () => {
  assert.equal(flatPriceAtomic({ mode: "flat", dimensions: [{ tiers: [{ price_usd: 0.012 }] }] }), 12_000n);
  assert.equal(flatPriceAtomic({ mode: "tiered", dimensions: [{ tiers: [{ price_usd: 0.01 }] }] }), null);
  assert.equal(flatPriceAtomic({ mode: "flat", dimensions: [{ tiers: [{ price_usd: 0.01 }, { price_usd: 0.02 }] }] }), null);
  assert.equal(endpointUrl("https://x.example/api/", "/v1/a"), "https://x.example/api/v1/a");
});
