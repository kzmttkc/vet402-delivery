import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Abis, Transaction } from "viem/tempo";
import { MEASURE_SPACING_MS } from "../src/constants.js";
import { buildGet, type Listing } from "../src/discovery.js";
import { SellerPacer } from "../src/measure.js";
import { classify, VALUE_TABLE } from "../src/inputs/values.js";
import { commitsToPurchase, containsPlaceholder, fillParams, isPlaceholder, sendsMessage } from "../src/inputs/fill.js";
import { fromBazaar, fromMercator, fromOpenApi, type EndpointSpec } from "../src/inputs/spec.js";
import { repairSolanaUrl, repairTargets, repairTempoRequest } from "../src/inputs/repair.js";
import { bookKey, parseBook, readBook, type InputBook } from "../src/inputs/book.js";
import { checkInput } from "../src/tempo/answer.js";
import { FEE_RESERVE_ATOMIC, TEMPO_MAINNET_CHAIN_ID, USDC_E } from "../src/tempo/constants.js";
import { mppChallengesFromHeader, tempoChargeRequest } from "../src/tempo/challenge.js";
import { Ledger } from "../src/tempo/ledger.js";
import type { PayDeps as TempoPayDeps } from "../src/tempo/pay.js";
import { registerDayLedger, type KeyLedgerSet } from "../src/tempo/key-ledgers.js";
import type { Signer } from "../src/tempo/chain.js";
import type { PlannedRequest } from "../src/tempo/mercator.js";
import { RM_TEMPO_MAX_PER_RUN_ATOMIC } from "../src/remeasure/constants.js";
import { selectSlots, solanaFromCensus, tempoFromLedger, type Target } from "../src/remeasure/targets.js";
import { dayLedgerPath, dryRunTempo, payTempo, type TempoChainView } from "../src/remeasure/tempo.js";
import { blockingFindings, loadAllowList, scanJson, type Finding } from "../src/daily/secret-gate.js";

const ROOT = join(import.meta.dirname, "..");
const DATA = join(ROOT, "data");
const TODAY = "2026-10-01";

// ---------- the value table ----------

test("values: every table value is real, not a placeholder, and no domain is a reserved example domain", () => {
  for (const v of Object.values(VALUE_TABLE)) {
    assert.ok(!containsPlaceholder(v.value), v.cls);
    assert.ok(v.from.length > 0, `${v.cls} says where it comes from`);
    assert.ok(!/\bexample\.(com|org|net)\b|\.example\b|\.test\b|\.invalid\b/.test(JSON.stringify(v.value)), v.cls);
  }
  assert.equal(VALUE_TABLE.ip.value, "8.8.8.8");
  assert.equal(VALUE_TABLE.crypto_symbol.value, "USDC");
});

test("values: what a parameter is, and what vet402 never makes up", () => {
  assert.deepEqual(classify("ip"), { cls: "ip" });
  assert.deepEqual(classify("website"), { cls: "domain" });
  assert.deepEqual(classify("text", "Location search query"), { cls: "location_query" });
  assert.deepEqual(classify("symbol", "Stock ticker"), { cls: "stock_symbol" });
  assert.deepEqual(classify("symbol", "Token symbol"), { cls: "crypto_symbol" });
  assert.deepEqual(classify("name", "Business name"), { cls: "company_name" });
  assert.deepEqual(classify("name", "Fuzzy search by investor name"), { unfillable: "unknown_param" });
  assert.deepEqual(classify("url", "URL to Komi page"), { unfillable: "unknown_param" }, "a page on one site: a general page would be wrong");
  assert.deepEqual(classify("email"), { unfillable: "personal_data" });
  assert.deepEqual(classify("to_number"), { unfillable: "personal_data" });
  assert.deepEqual(classify("api_key"), { unfillable: "secret" });
  assert.deepEqual(classify("token", "Submission token returned by submit-code"), { unfillable: "needs_own_id" });
  assert.deepEqual(classify("prediction_id"), { unfillable: "needs_own_id" });
});

// ---------- filling ----------

const spec = (params: Partial<EndpointSpec["params"][number]>[], extra: Partial<EndpointSpec> = {}): EndpointSpec => ({
  method: "GET",
  description: "",
  outputExample: null,
  source: "test",
  ...extra,
  params: params.map((p) => ({ name: "x", in: "query", type: "string", required: false, description: "", enum: [], example: undefined, ...p })),
});

test("placeholders: type names, notes and 'example' are; a GraphQL query and real values are not", () => {
  for (const v of ["string", "example", "<from clado/bulk-contacts>", "{id}", null, "", "your-door.example"]) assert.ok(isPlaceholder(v), String(v));
  for (const v of ["{ __typename }", "8.8.8.8", "Tempo blockchain", 0, false]) assert.ok(!isPlaceholder(v), String(v));
  assert.ok(containsPlaceholder([null]));
  assert.ok(!containsPlaceholder({}));
});

test("fill: placeholders and missing required parameters get a real value, and each says where it came from", () => {
  const r = fillParams({ ip: "string" }, spec([{ name: "ip", required: true, example: "string" }]), TODAY);
  assert.deepEqual(r, { ok: true, params: { ip: "8.8.8.8" }, filled: [{ param: "ip", rule: "table:ip" }] });
  // the seller's own "e.g." wins over the table
  const d = fillParams({}, spec([{ name: "domain", required: true, description: 'Company website domain, e.g. "stripe.com" - bare host only' }]), TODAY);
  assert.deepEqual(d.ok && [d.params, d.filled[0]!.rule], [{ domain: "stripe.com" }, "description_example"]);
  // the seller's own example answer holds a value for the parameter
  const v = fillParams({ vin: "example" }, spec([{ name: "vin", required: true, example: "example" }], { outputExample: { vehicle: { vin: "1HGCM82633A004352" } } }), TODAY);
  assert.deepEqual(v.ok && v.params, { vin: "1HGCM82633A004352" });
  // an object whose description names its required field
  const o = fillParams({ input: {} }, spec([{ name: "input", in: "body", type: "object", required: true, description: "Input parameters: domain (required, string): Company domain (e.g., microsoft.com)" }], { method: "POST" }), TODAY);
  assert.deepEqual(o.ok && o.params, { input: { domain: "microsoft.com" } });
  // a chat and a model from the listed models
  const c = fillParams({ messages: [null], model: "string" }, spec([{ name: "messages", in: "body", type: "array", required: true }, { name: "model", in: "body", required: true, description: "Model slug. Available models: deepseek-ai/DeepSeek-V3-0324 (164k context), zai-org/GLM-4.6" }], { method: "POST" }), TODAY);
  assert.deepEqual(c.ok && c.params, { messages: [{ role: "user", content: "Reply with the single word: ok" }], model: "deepseek-ai/DeepSeek-V3-0324" });
  // a date is the run's date
  const t = fillParams({}, spec([{ name: "date", required: true }]), TODAY);
  assert.deepEqual(t.ok && t.params, { date: TODAY });
  // an enum's first value
  const e = fillParams({ platform: "string" }, spec([{ name: "platform", required: true, enum: ["instagram", "tiktok"] }]), TODAY);
  assert.deepEqual(e.ok && e.params, { platform: "instagram" });
});

test("fill: what vet402 does not make up fails the whole request; an optional placeholder is left out", () => {
  assert.deepEqual(fillParams({ email: "string" }, spec([{ name: "email", required: true }]), TODAY), { ok: false, reason: "personal_data", param: "email" });
  assert.deepEqual(fillParams({ id: "string" }, spec([{ name: "id", required: true, description: "UUID of the queued search" }]), TODAY), { ok: false, reason: "needs_own_id", param: "id" });
  const sms = spec([{ name: "body", in: "body", required: true }], { method: "POST", description: "Send an SMS from an agent's phone number." });
  assert.deepEqual(fillParams({ body: "string" }, sms, TODAY), { ok: false, reason: "sends_message", param: null });
  assert.equal(sendsMessage({ method: "POST", description: "Send a one-time verification code to an email address." }), true);
  assert.equal(sendsMessage({ method: "POST", description: "Send a conversation to a model and get a completion back." }), false, "a chat endpoint is not a message to a person");
  // an endpoint that commits vet402 to more than the call it pays for
  assert.equal(commitsToPurchase({ description: "Buy a US or CA phone number. $3/month per number." }), true);
  assert.equal(commitsToPurchase({ description: "Book a flight for a traveller." }), true);
  assert.equal(commitsToPurchase({ description: "Returns the order book for a trading pair." }), false);
  assert.equal(commitsToPurchase({ description: "Search for flights between two airports." }), false);
  const num = spec([{ name: "country", in: "body", required: true, description: "US or CA." }], { method: "POST", description: "Buy a US or CA phone number. $3/month per number." });
  assert.deepEqual(fillParams({}, num, TODAY), { ok: false, reason: "commits_to_purchase", param: null });
  // a "username" that is not on a named social platform (an inbox) is not filled with a public account
  assert.deepEqual(classify("username"), { unfillable: "unknown_param" });
  assert.deepEqual(classify("handle", "TikTok handle"), { cls: "social_handle" });
  const r = fillParams({ url: "example", page: "example" }, spec([{ name: "url", description: "URL to read" }, { name: "page", description: "Alias for url" }]), TODAY);
  assert.deepEqual(r.ok && [r.params, r.filled], [{ url: "https://www.wikipedia.org/" }, [{ param: "url", rule: "table:web_url" }, { param: "page", rule: "left_out_optional" }]]);
  // nothing needs filling: nothing changes
  assert.deepEqual(fillParams({ q: "Tempo blockchain" }, spec([{ name: "q", required: true }]), TODAY), { ok: true, params: { q: "Tempo blockchain" }, filled: [] });
});

test("fill: nothing sent and nothing required, the seller's own documented defaults are sent, except a street address", () => {
  // A made-up home address stands for the seller's default here; vet402 sends the table's public address instead.
  const doc = { paths: { "/avm/rent/long-term": { get: { summary: "Rent Estimate", parameters: [
    { in: "query", name: "address", schema: { type: "string", default: "100 Sample Ave, Anytown, TX, 75001" } },
    { in: "query", name: "bedrooms", schema: { type: "number", default: "" } },
    { in: "query", name: "compCount", schema: { type: "integer", default: 5 } },
  ] } } } };
  const s = fromOpenApi(doc, "GET", "/avm/rent/long-term", "seller-openapi:test")!;
  const r = repairSolanaUrl("https://rentcast.x/avm/rent/long-term", s, TODAY);
  assert.deepEqual(r.ok && [r.changed, r.value], [true, "https://rentcast.x/avm/rent/long-term?address=354+Oyster+Point+Blvd%2C+South+San+Francisco%2C+CA+94080&compCount=5"]);
  assert.deepEqual(r.ok && r.filled.find((f) => f.param === "address"), { param: "address", rule: "table:street_address" });
});

test("fill: a street address never comes from the seller's example, the description or its example answer", () => {
  const home = "100 Sample Ave, Anytown, TX 75001";
  const s = spec([{ name: "address", required: true, example: home, description: `Full address, e.g. "${home}"` }]);
  const r = fillParams({}, { ...s, outputExample: { address: home } }, TODAY);
  assert.deepEqual(r.ok && [r.params, r.filled], [{ address: "354 Oyster Point Blvd, South San Francisco, CA 94080" }, [{ param: "address", rule: "table:street_address" }]]);
  // the book's entry for rentcast.x402.paysponge.com /avm/rent/long-term now fills the same public address
  const book = JSON.parse(readFileSync(join(ROOT, "src", "inputs", "book.json"), "utf8")) as InputBook;
  const e = book.entries.find((x) => x.url === "https://rentcast.x402.paysponge.com/avm/rent/long-term")!;
  const u = repairSolanaUrl(e.url, e.spec, TODAY);
  assert.ok(u.ok && new URL(u.value).searchParams.get("address") === "354 Oyster Point Blvd, South San Francisco, CA 94080", JSON.stringify(u));
});

test("fill: a parameter named address whose seller example is 0x... is a wallet: the seller's example is sent, never the table's street address", () => {
  const wallet = "0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51";
  // the example field
  const r = fillParams({}, spec([{ name: "address", required: true, example: wallet, description: "Address to look up" }]), TODAY);
  assert.deepEqual(r.ok && [r.params, r.filled], [{ address: wallet }, [{ param: "address", rule: "seller_example" }]]);
  // the "e.g." in the description
  const d = fillParams({ address: "string" }, spec([{ name: "address", required: true, description: `Address, e.g. ${wallet}` }]), TODAY);
  assert.deepEqual(d.ok && [d.params, d.filled], [{ address: wallet }, [{ param: "address", rule: "description_example" }]]);
  // no usable example at all: not filled, and never the street address
  const n = fillParams({}, spec([{ name: "address", required: true, example: "0x", description: "Address to look up" }]), TODAY);
  assert.ok(!JSON.stringify(n).includes("Oyster"), JSON.stringify(n));
  // a street example still gets the table's public address
  const s = fillParams({}, spec([{ name: "address", required: true, example: "100 Sample Ave, Anytown, TX 75001" }]), TODAY);
  assert.deepEqual(s.ok && s.params, { address: "354 Oyster Point Blvd, South San Francisco, CA 94080" });
});

// ---------- requests ----------

const plan = JSON.parse(readFileSync(join(DATA, "tempo", "census-plan-2026-09-28.json"), "utf8")) as { plan: { serviceId: string; request: PlannedRequest }[] };
const reqOf = (id: string) => plan.plan.find((p) => p.serviceId === id)!.request;

test("tempo request: the census request with 'string' becomes a real one, query or JSON body; a `*` path is refused", () => {
  const pdl = fromMercator({ method: "GET", requestFormat: "query", inputSchema: { properties: { ip: { type: "string", description: "IP address to enrich" } }, required: ["ip"] }, inputExample: { ip: "string" } }, "m");
  const r = repairTempoRequest(reqOf("orth-peopledatalabs"), pdl, TODAY);
  assert.deepEqual(r.ok && [r.value.url, r.value.inputSource, checkInput(r.value).placeholders], ["https://mpp.orthogonal.com/peopledatalabs/v5/ip/enrich?ip=8.8.8.8", "vet402_filled", []]);
  const ic = fromMercator({ method: "POST", requestFormat: "json", inputSchema: { properties: { handle: { type: "string", description: "Creator identifier: username, profile URL, or YouTube channel ID" }, platform: { type: "string", description: "Platform: instagram, youtube, tiktok, twitter" } }, required: ["handle", "platform"] } }, "m");
  const b = repairTempoRequest(reqOf("orth-influencers-club"), ic, TODAY);
  assert.deepEqual(b.ok && [b.value.body, b.value.contentType], ['{"handle":"nasa","platform":"instagram"}', "application/json"]);
  assert.deepEqual(repairTempoRequest(reqOf("spyfu"), null, TODAY), { ok: false, reason: "path_placeholder", param: "(path)" });
  // a real example is left as it is
  const andi = repairTempoRequest(reqOf("orth-andi"), null, TODAY);
  assert.deepEqual(andi.ok && [andi.changed, andi.value], [false, reqOf("orth-andi")]);
});

test("solana census: a listing whose example is 'example' is filled from its own schema and example answer; one that cannot be stays at score 0", () => {
  const vin: Listing = {
    resource: "https://agents.datamancer.io/api/v1/paid/vin",
    extensions: {
      bazaar: {
        info: { input: { method: "GET", queryParams: { vin: "example" }, type: "http" }, output: { example: { vehicle: { vin: "1HGCM82633A004352" } } } },
        schema: { properties: { input: { properties: { queryParams: { properties: { vin: { type: "string" } }, required: ["vin"] } } } } },
      } as never,
    },
  };
  const g = buildGet(vin, TODAY);
  assert.deepEqual(g.ok && [g.url, g.exampleScore, g.exampleInput], ["https://agents.datamancer.io/api/v1/paid/vin?vin=1HGCM82633A004352", 2, { vin: "1HGCM82633A004352" }]);
  const job: Listing = { resource: "https://s.x/job", extensions: { bazaar: { info: { input: { method: "GET", queryParams: { jobId: "<your job id>" } } } } } };
  const j = buildGet(job, TODAY);
  assert.deepEqual(j.ok && [j.exampleScore, j.url], [0, "https://s.x/job"]);
  // a listing with a concrete example is untouched
  const ok: Listing = { resource: "https://s.x/q", extensions: { bazaar: { info: { input: { method: "GET", queryParams: { q: "nvidia" } } } } } };
  const o = buildGet(ok, TODAY);
  assert.deepEqual(o.ok && [o.url, o.exampleScore], ["https://s.x/q?q=nvidia", 2]);
  assert.equal(fromBazaar({ resource: "https://s.x/none" }, "t"), null);
});

// ---------- remeasure targets and the book ----------

const tempoTargets = () => tempoFromLedger(JSON.parse(readFileSync(join(DATA, "tempo", "ledger.json"), "utf8")), plan, "tempo/ledger");
const committedBook = () => readBook(join(ROOT, "src", "inputs", "book.json"), new Date("2026-10-01T00:00:00Z"));

test("book: refused when too old or with a duplicate; the committed book lists specs with their source", () => {
  const b = committedBook();
  assert.ok(b.entries.length > 0 && b.entries.every((e) => e.looked.length > 0));
  assert.throws(() => parseBook(b, new Date(Date.parse(b.createdAt) + 15 * 86_400_000)), /days old/);
  assert.throws(() => parseBook({ ...b, entries: [b.entries[0], b.entries[0]] }, new Date(b.createdAt)), /duplicate/);
});

test("remeasure targets: only the request changes; payTo, price, catalog URL and lock stay; no placeholder is left in a changed request", () => {
  const book = committedBook();
  const before = [...tempoTargets(), ...solanaFromCensus(JSON.parse(readFileSync(join(DATA, "solana", "census-2026-09-28.json"), "utf8")), "solana/census-2026-09-28")];
  const { targets, lines } = repairTargets(before, book, TODAY);
  const changed = lines.filter((l) => l.result === "changed");
  assert.ok(changed.length >= 10, `changed ${changed.length}`);
  for (const t of targets) {
    const o = before.find((x) => x.chain === t.chain && x.url === t.url && x.service === t.service)!;
    assert.deepEqual([t.payTo, t.amountAtomic, t.url, t.host, t.from, t.solana?.lock, t.tempo?.plan.lockedRecipient, t.tempo?.plan.lockedAmount, t.tempo?.feeReserveAtomic], [o.payTo, o.amountAtomic, o.url, o.host, o.from, o.solana?.lock, o.tempo?.plan.lockedRecipient, o.tempo?.plan.lockedAmount, o.tempo?.feeReserveAtomic]);
    if (t.tempo) {
      assert.equal(t.requestUrl, t.tempo.plan.request.url, "the Tempo requestUrl follows the request sent");
      if (lines.find((l) => l.service === t.service)?.result === "changed") assert.deepEqual(checkInput(t.tempo.plan.request).placeholders, [], t.service!);
    }
  }
  // dropped: only a message to someone, or a request whose last paid answer was 400/404/422 and that cannot be filled
  for (const l of lines.filter((x) => x.result === "skipped")) {
    const e = book.entries.find((x) => bookKey(x) === bookKey(l))!;
    assert.ok(l.reason === "sends_message" || [400, 404, 422].includes(e.lastStatus!), `${l.service} ${l.reason} ${e.lastStatus}`);
  }
  assert.equal(targets.length, before.length - lines.filter((l) => l.result === "skipped").length);
  // the census's own ip=string target is now 8.8.8.8, and the SMS sender is not bought
  assert.equal(targets.find((t) => t.service === "orth-peopledatalabs")!.tempo!.plan.request.url, "https://mpp.orthogonal.com/peopledatalabs/v5/ip/enrich?ip=8.8.8.8");
  assert.equal(targets.find((t) => t.service === "orth-agentphone"), undefined);
});

test("secret gate: every repaired request URL a result row will carry passes the gate with the committed allow list", () => {
  const before = [...tempoTargets(), ...solanaFromCensus(JSON.parse(readFileSync(join(DATA, "solana", "census-2026-09-28.json"), "utf8")), "solana/census-2026-09-28")];
  const { lines } = repairTargets(before, committedBook(), TODAY);
  const urls = lines.filter((l) => l.result === "changed").map((l) => l.to!.split(" ")[0]!);
  const out: Finding[] = [];
  scanJson({ kind: "vet402-remeasure", rows: urls.map((u) => ({ host: new URL(u).host, url: u.split("?")[0], requestUrl: u })) }, "data/remeasure/solana-2026-10-01.json", out);
  assert.deepEqual(blockingFindings(out, loadAllowList(join(ROOT, "scripts", "daily", "secret-allow.json"))), []);
});

// ---------- the payment path sends the repaired request, and nothing else changes ----------

const throwaway = privateKeyToAccount(generatePrivateKey());
const SELLER = "0x060b0fB0Be9d90557577B3AEE480711067149Ff0";
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const challenge = (recipient: string, amount: string) =>
  `Payment id="abc", realm="svc.example", method="tempo", intent="charge", request="${b64url({ amount, currency: USDC_E, recipient, methodDetails: { chainId: TEMPO_MAINNET_CHAIN_ID } })}", expires="2099-01-01T00:00:00Z"`;

test("remeasure tempo: the unpaid 402 check and the paid call both carry the repaired request; one signature, the same ledger amount", async () => {
  const payTo = SELLER.toLowerCase();
  const url = "https://svc.example/v5/ip/enrich?ip=string";
  const t: Target = {
    chain: "tempo", host: "svc.example", service: "pdl", url, requestUrl: url, payTo, amountAtomic: "6000", from: "test",
    tempo: { plan: { serviceId: "pdl", request: { url, method: "GET", body: null, contentType: null, inputSource: "mercator_example" }, lockedRecipient: payTo, lockedAmount: "6000", sponsored: false, allowlist: [] }, feeReserveAtomic: FEE_RESERVE_ATOMIC.toString() },
  };
  const book: InputBook = { kind: "vet402-input-book", version: 1, createdAt: `${TODAY}T00:00:00Z`, entries: [{ chain: "tempo", service: "pdl", url, lastStatus: 400, looked: ["test"], spec: fromMercator({ method: "GET", inputSchema: { properties: { ip: { type: "string" } }, required: ["ip"] } }, "test") }] };
  const [fixed] = repairTargets([t], book, TODAY).targets;

  const seen: { url: string; paid: boolean }[] = [];
  const root = mkdtempSync(join(tmpdir(), "inputs-"));
  const set: KeyLedgerSet = { census: join(root, "census", "tempo-ledger.json"), remeasureDir: join(root, "rm") };
  new Ledger(set.census, throwaway.address, 2_500_000n);
  const chain = { total: 0n };
  let signs = 0;
  const fetchImpl = async (u: string, init?: RequestInit): Promise<Response> => {
    const paid = !!new Headers(init?.headers).get("authorization");
    seen.push({ url: u, paid });
    if (paid) {
      chain.total += 6030n;
      return new Response('{"ip":"8.8.8.8","ok":true}', { status: 200 });
    }
    return new Response("{}", { status: 402, headers: { "www-authenticate": challenge(SELLER, "6000") } });
  };
  const signer: Signer = {
    address: throwaway.address,
    async credentialFor(res, _id, recipient) {
      signs++;
      const amount = BigInt(tempoChargeRequest(mppChallengesFromHeader(res.headers.get("www-authenticate"))[0]!)!.amount);
      const data = encodeFunctionData({ abi: Abis.tip20, functionName: "transfer", args: [recipient as Hex, amount] });
      const tx = { type: "tempo" as const, chainId: 4217, calls: [{ to: USDC_E as Hex, data }], nonce: 0, gas: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, nonceKey: 2n ** 256n - 1n, validBefore: 1_790_000_000 };
      return { credential: "Payment eyJ4IjoxfQ", serializedTx: await throwaway.signTransaction(tx as never, { serializer: Transaction.serialize as never }) };
    },
  };
  const pay: Omit<TempoPayDeps, "ledger" | "chainSpent"> = { fetchImpl, signer, payer: throwaway.address, balance: async () => 10_000_000n, verify: async () => ({ settled: true, detail: "transfer found", feePaid: "30" }) };
  const view: TempoChainView = { outflowSinceCensusStart: async () => chain.total, outflowSinceMonthStart: async () => chain.total };
  const clock = { t: Date.parse(`${TODAY}T00:00:00Z`) };
  registerDayLedger(set, TODAY, throwaway.address, RM_TEMPO_MAX_PER_RUN_ATOMIC);
  const ledger = new Ledger(dayLedgerPath(set.remeasureDir, TODAY), throwaway.address, RM_TEMPO_MAX_PER_RUN_ATOMIC);
  const res = await payTempo(selectSlots([fixed!], 1).slots, pay, {
    date: TODAY, ledger, keyLedgers: set, chain: view, monthElsewhere: 0n,
    now: () => new Date(clock.t), sleep: async (ms) => void (clock.t += ms), pacer: new SellerPacer(5, MEASURE_SPACING_MS, () => clock.t),
  });
  const r = res.rows[0]!;
  assert.deepEqual([r.outcome, r.delivered, r.url, r.requestUrl, r.input?.source, r.input?.placeholders], ["sent", true, url, "https://svc.example/v5/ip/enrich?ip=8.8.8.8", "vet402_filled", []]);
  assert.ok(seen.length >= 2 && seen.every((s) => s.url === "https://svc.example/v5/ip/enrich?ip=8.8.8.8"), JSON.stringify(seen));
  assert.deepEqual([signs, ledger.committed(), [...ledger.entries()][0]!.url], [1, 6000n + FEE_RESERVE_ATOMIC, "https://svc.example/v5/ip/enrich?ip=8.8.8.8"]);

  // the dry run probes the same repaired request, unpaid
  seen.length = 0;
  const d = await dryRunTempo(selectSlots([fixed!], 1).slots, fetchImpl, { date: TODAY, monthElsewhere: 0n, monthCommittedToday: 0n });
  assert.deepEqual([d.rows[0]!.outcome, seen], ["would_pay", [{ url: "https://svc.example/v5/ip/enrich?ip=8.8.8.8", paid: false }]]);
});
