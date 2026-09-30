import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFunctionData, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Abis, Transaction } from "viem/tempo";
import { MEASURE_SPACING_MS } from "../src/constants.js";
import { SellerPacer } from "../src/measure.js";
import { TEMPO_MAINNET_CHAIN_ID, USDC_E, FEE_RESERVE_ATOMIC } from "../src/tempo/constants.js";
import { mppChallengesFromHeader, tempoChargeRequest } from "../src/tempo/challenge.js";
import { Ledger } from "../src/tempo/ledger.js";
import type { PayDeps as TempoPayDeps } from "../src/tempo/pay.js";
import { registerDayLedger, type KeyLedgerSet } from "../src/tempo/key-ledgers.js";
import type { Signer } from "../src/tempo/chain.js";
import type { PlannedRequest } from "../src/tempo/mercator.js";
import { bodyShape, checkInput, inputProblem, publishableField } from "../src/tempo/answer.js";
import { classifyFailure, FAULT_RULES, FAULT_RULES_NEXT } from "../src/rank/classify.js";
import { annotateTempoInput, normalizeTempoLedger } from "../src/rank/normalize.js";
import { RM_TEMPO_MAX_PER_RUN_ATOMIC } from "../src/remeasure/constants.js";
import { selectSlots, tempoFromLedger, type Target } from "../src/remeasure/targets.js";
import { dayLedgerPath, dryRunTempo, payTempo, type TempoChainView } from "../src/remeasure/tempo.js";
import { normalizeRemeasure } from "../src/remeasure/normalize.js";
import type { RemeasureRow, ResultFile } from "../src/remeasure/results.js";
import { scanJson, type Finding } from "../src/daily/secret-gate.js";

const DATA = join(import.meta.dirname, "..", "data");
const plan = JSON.parse(readFileSync(join(DATA, "tempo", "census-plan-2026-09-28.json"), "utf8")) as { plan: { serviceId: string; request: PlannedRequest }[] };
const reqOf = (id: string) => plan.plan.find((p) => p.serviceId === id)!.request;

// ---------- what vet402 sent ----------

test("input: the catalog's type names and notes are placeholders; real examples and no-input GETs are not", () => {
  assert.deepEqual(checkInput(reqOf("orth-peopledatalabs")).placeholders, ["ip"]); // ?ip=string
  assert.deepEqual(checkInput(reqOf("orth-agentphone")).placeholders, ["agent_id", "to_number", "body"]);
  assert.deepEqual(checkInput(reqOf("orth-baseten")).placeholders, ["messages[0]", "model"]); // {"messages":[null],"model":"string"}
  assert.deepEqual(checkInput(reqOf("clado")).placeholders, ["jobId"]); // "<from clado/bulk-contacts>"
  assert.deepEqual(checkInput(reqOf("spyfu")).placeholders, ["(path)"]); // /v2/*
  assert.deepEqual(checkInput(reqOf("alphavantage")).placeholders, []);
  assert.deepEqual(checkInput(reqOf("orth-andi")).placeholders, []);
  const serp = checkInput(reqOf("serpapi"));
  assert.deepEqual([serp.source, serp.placeholders, serp.missingRequired], ["none", [], null]);
  // required list, when the caller has one
  assert.deepEqual(checkInput({ url: "https://s.example/x?a=1", body: null, inputSource: "mercator_example" }, ["a", "b"]).missingRequired, ["b"]);
});

test("input problem: placeholder, missing required, or no input with an answer that says the input was wrong", () => {
  const ex = { source: "mercator_example" as const, placeholders: [], missingRequired: null };
  assert.equal(inputProblem({ ...ex, placeholders: ["ip"] }, null), "placeholder_input");
  assert.equal(inputProblem({ ...ex, missingRequired: ["q"] }, null), "missing_required");
  assert.equal(inputProblem({ ...ex, source: "none" }, { inputError: ["required"] }), "no_input_sent");
  // the catalog's own example rejected as invalid: can't tell (the example may be the catalog's error)
  assert.equal(inputProblem(ex, { inputError: ["invalid"] }), null);
  assert.equal(inputProblem({ ...ex, source: "none" }, { inputError: [] }), null);
  assert.equal(inputProblem(null, { inputError: ["invalid"] }), null);
});

// ---------- what came back: shape only ----------

test("answer: shape only, never the text; secret-like and random names are withheld", () => {
  const body = Buffer.from(JSON.stringify({ result: { a: 1 }, items: [1, 2], access_token: "eyJabc.def.ghi", api_key: "x", "0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be": 1, name: "Jane Roe" }));
  const s = bodyShape(body, 200);
  assert.deepEqual([s.json, s.fields, s.fieldsWithheld, s.nonEmpty, s.inputError, s.declared, s.declaredMatch], ["object", ["items", "name", "result"], 3, true, [], null, null]);
  assert.ok(!JSON.stringify(s).includes("Jane") && !JSON.stringify(s).includes("eyJ"), "no value is kept");
  assert.equal(bodyShape(Buffer.from("  \n "), 200).nonEmpty, false, "whitespace is empty, as on Solana");
  assert.equal(bodyShape(null, 200).nonEmpty, false);
  assert.deepEqual([bodyShape(Buffer.from("[1,2,3]"), 200).json, bodyShape(Buffer.from("[1,2,3]"), 200).items], ["array", 3]);
  assert.equal(bodyShape(Buffer.from("<html>ok</html>"), 200).json, null);
  assert.deepEqual(bodyShape(Buffer.from('{"error":"ip is required and must be a valid IPv4"}'), 400).inputError, ["required", "must_be"]);
  assert.deepEqual(bodyShape(Buffer.from('{"error":"Invalid parameter"}'), 422).inputError, ["invalid"]);
  assert.deepEqual(bodyShape(Buffer.from('{"error":"invalid state"}'), 500).inputError, [], "only a 4xx answer is read for input words");
  assert.deepEqual([bodyShape(Buffer.from('{"a":1,"b":2}'), 200, ["a", "b"]).declaredMatch, bodyShape(Buffer.from('{"a":1}'), 200, ["a", "b"]).declaredMatch], [true, false]);
  for (const n of ["result", "data", "first_name", "items.count"]) assert.ok(publishableField(n), n);
  for (const n of ["token", "apiKey", "session_id", "x-auth", "5f2b9c1e8a7d3f60aa", "a b", "x".repeat(40), "1234567"]) assert.ok(!publishableField(n), n);
});

// ---------- remeasure on Tempo: the new record, and the placeholder skip ----------

const throwaway = privateKeyToAccount(generatePrivateKey());
const SELLER = "0x060b0fB0Be9d90557577B3AEE480711067149Ff0";
const DATE = "2026-10-01";
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const challenge = (recipient: string, amount: string) =>
  `Payment id="abc", realm="svc.example", method="tempo", intent="charge", request="${b64url({ amount, currency: USDC_E, recipient, methodDetails: { chainId: TEMPO_MAINNET_CHAIN_ID } })}", expires="2099-01-01T00:00:00Z"`;

async function signedTransfer(to: string, amount: bigint): Promise<string> {
  const data = encodeFunctionData({ abi: Abis.tip20, functionName: "transfer", args: [to as Hex, amount] });
  const tx = { type: "tempo" as const, chainId: 4217, calls: [{ to: USDC_E as Hex, data }], nonce: 0, gas: 100_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, nonceKey: 2n ** 256n - 1n, validBefore: 1_790_000_000 };
  return throwaway.signTransaction(tx as never, { serializer: Transaction.serialize as never });
}

function target(service: string, request: Omit<PlannedRequest, "url">, path = `/${service}`): Target {
  const payTo = SELLER.toLowerCase();
  const url = `https://svc.example${path}`;
  return {
    chain: "tempo", host: "svc.example", service, url, requestUrl: url, payTo, amountAtomic: "6000", from: "test",
    tempo: { plan: { serviceId: service, request: { url, ...request }, lockedRecipient: payTo, lockedAmount: "6000", sponsored: false, allowlist: [] }, feeReserveAtomic: FEE_RESERVE_ATOMIC.toString() },
  };
}

/** A seller answering each paid request with `paid(url)`; every paid request moves 6000 + a 30 fee. */
function env(paid: (url: string) => Response) {
  const root = mkdtempSync(join(tmpdir(), "rm-ans-"));
  const set: KeyLedgerSet = { census: join(root, "census", "tempo-ledger.json"), remeasureDir: join(root, "rm") };
  new Ledger(set.census, throwaway.address, 2_500_000n);
  const chain = { total: 0n };
  let signs = 0;
  let paidCalls = 0;
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    if (new Headers(init?.headers).get("authorization")) {
      paidCalls++;
      chain.total += 6030n;
      return paid(url);
    }
    return new Response("{}", { status: 402, headers: { "www-authenticate": challenge(SELLER, "6000") } });
  };
  const signer: Signer = {
    address: throwaway.address,
    async credentialFor(res, _id, recipient) {
      signs++;
      const amount = BigInt(tempoChargeRequest(mppChallengesFromHeader(res.headers.get("www-authenticate"))[0]!)!.amount);
      return { credential: "Payment eyJ4IjoxfQ", serializedTx: await signedTransfer(recipient, amount) };
    },
  };
  const pay: Omit<TempoPayDeps, "ledger" | "chainSpent"> = {
    fetchImpl, signer, payer: throwaway.address, balance: async () => 10_000_000n,
    verify: async () => ({ settled: true, detail: "transfer found", feePaid: "30" }),
  };
  const view: TempoChainView = { outflowSinceCensusStart: async () => chain.total, outflowSinceMonthStart: async () => chain.total };
  const clock = { t: Date.parse("2026-10-01T00:00:00Z") };
  registerDayLedger(set, DATE, throwaway.address, RM_TEMPO_MAX_PER_RUN_ATOMIC);
  const ledger = new Ledger(dayLedgerPath(set.remeasureDir, DATE), throwaway.address, RM_TEMPO_MAX_PER_RUN_ATOMIC);
  const run = (targets: Target[]) =>
    payTempo(selectSlots(targets, 1).slots, pay, {
      date: DATE, ledger, keyLedgers: set, chain: view, monthElsewhere: 0n,
      now: () => new Date(clock.t), sleep: async (ms) => void (clock.t += ms), pacer: new SellerPacer(5, MEASURE_SPACING_MS, () => clock.t),
    });
  return { run, fetchImpl, ledger, signs: () => signs, paidCalls: () => paidCalls };
}

const file = (rows: RemeasureRow[]): ResultFile => ({ kind: "vet402-remeasure", version: 1, chain: "tempo", date: DATE, payer: "p", note: "n", runs: [], rows });

test("remeasure tempo: a request with a catalog placeholder is not bought (no signature, no reservation), in --pay and in the dry run", async () => {
  const e = env(() => new Response('{"ok":true}', { status: 200 }));
  const t = target("pdl", { method: "GET", body: null, contentType: null, inputSource: "mercator_example" }, "/v5/ip/enrich?ip=string");
  const res = await e.run([t]);
  assert.deepEqual([e.signs(), e.paidCalls(), e.ledger.committed()], [0, 0, 0n]);
  const r = res.rows[0]!;
  assert.deepEqual([r.outcome, r.reason, r.detail, r.tx, r.answer, r.input?.placeholders], ["refused", "placeholder_input", "placeholders: ip", null, null, ["ip"]]);
  const a = normalizeRemeasure(file([r]), "x")[0]!;
  assert.deepEqual([a.tried, a.category], [false, "vet402_skipped"]);
  const d = await dryRunTempo(selectSlots([t], 1).slots, e.fetchImpl, { date: DATE, monthElsewhere: 0n, monthCommittedToday: 0n });
  assert.deepEqual([d.rows[0]!.outcome, d.rows[0]!.reason], ["refused", "placeholder_input"]);
  // a placeholder the seller answered in the census (a search for "string") is still bought
  const answered = target("seltz", { method: "POST", body: '{"query":"string"}', contentType: "application/json", inputSource: "mercator_example" });
  answered.tempo!.censusDelivered = true;
  const r2 = (await e.run([answered])).rows[0]!;
  assert.deepEqual([r2.outcome, r2.delivered, r2.input?.placeholders, e.signs()], ["sent", true, ["query"], 1]);
});

test("targets: the census ledger's delivered flag reaches the Tempo target", () => {
  const ledger = JSON.parse(readFileSync(join(DATA, "tempo", "ledger.json"), "utf8"));
  const ts = tempoFromLedger(ledger, plan, "t");
  const by = (id: string) => ts.find((t) => t.service === id)!.tempo!.censusDelivered;
  assert.deepEqual([by("orth-seltz"), by("orth-peopledatalabs"), by("alphavantage")], [true, false, true]);
});

test("remeasure tempo: a paid 2xx records the answer's shape; a whitespace body is empty, as on Solana", async () => {
  const e = env(() => new Response('{"price":1,"symbol":"AAPL","session":"s-1"}', { status: 200 }));
  const t = target("quote", { method: "POST", body: '{"symbol":"AAPL"}', contentType: "application/json", inputSource: "mercator_example" });
  const r = (await e.run([t])).rows[0]!;
  assert.deepEqual([r.outcome, r.delivered, r.input], ["sent", true, { source: "mercator_example", placeholders: [], missingRequired: null }]);
  assert.deepEqual(r.answer, { bytes: 43, nonEmpty: true, json: "object", fields: ["price", "symbol"], fieldsWithheld: 1, items: null, inputError: [], declared: null, declaredMatch: null });
  assert.ok(!JSON.stringify(r.answer).includes("AAPL") && !JSON.stringify(r.answer).includes("s-1"), "names, not values");
  const a = normalizeRemeasure(file([r]), "x")[0]!;
  assert.deepEqual([a.category, a.bodyChecked, a.inputProblem], ["delivered", true, null]);
  // whitespace only: settled_empty_body (the body length alone said delivered)
  const blank = normalizeRemeasure(file([{ ...r, answer: bodyShape(Buffer.from("   "), 200), bodyBytes: 3 }]), "x")[0]!;
  assert.equal(blank.category, "settled_empty_body");
});

test("remeasure tempo: a paid 4xx whose answer says the input was wrong, after vet402 sent no input, goes to vet402's side under the next rules only", async () => {
  const e = env(() => new Response('{"error":"q is required"}', { status: 400 }));
  const t = target("search", { method: "GET", body: null, contentType: null, inputSource: "none" });
  const r = (await e.run([t])).rows[0]!;
  assert.deepEqual([r.outcome, r.settled, r.httpStatus, r.answer?.inputError, r.answer?.fields], ["sent", true, 400, ["required"], ["error"]]);
  assert.ok(!JSON.stringify(r).includes("q is required"), "the answer's text is not kept");
  const a = normalizeRemeasure(file([r]), "x")[0]!;
  assert.equal(a.inputProblem, "no_input_sent");
  assert.deepEqual(classifyFailure(a), { fault: "unknown", rule: "paid_then_4xx" }, "published rules: unchanged");
  assert.deepEqual(classifyFailure(a, FAULT_RULES_NEXT), { fault: "vet402_or_facilitator", rule: "paid_then_4xx_vet402_input" });
  // the same 4xx after the catalog's real example stays can't tell
  const withExample = normalizeRemeasure(file([{ ...r, input: { source: "mercator_example", placeholders: [], missingRequired: null } }]), "x")[0]!;
  assert.deepEqual(classifyFailure(withExample, FAULT_RULES_NEXT), { fault: "unknown", rule: "paid_then_4xx" });
});

test("remeasure tempo: the new fields pass the secret gate (no finding), even with secret-like names in the answer", async () => {
  const e = env(() => new Response(JSON.stringify({ access_token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnopqrstuv", refresh_token: "r".repeat(40), data: { ok: true } }), { status: 200 }));
  const r = (await e.run([target("login", { method: "POST", body: '{"token":"string"}', contentType: "application/json", inputSource: "mercator_example" }), target("auth", { method: "GET", body: null, contentType: null, inputSource: "none" }, "/auth")])).rows;
  const out: Finding[] = [];
  scanJson(file(r), "data/remeasure/tempo-2026-10-01.json", out);
  assert.deepEqual(out.map((f) => `${f.path} ${f.kind}`), []);
});

// ---------- the classification lists ----------

test("classify: the published FAULT_RULES are unchanged; FAULT_RULES_NEXT adds one vet402-side rule just before paid_then_4xx", () => {
  assert.equal(FAULT_RULES.length, 12);
  assert.ok(!FAULT_RULES.some((r) => r.id === "paid_then_4xx_vet402_input"));
  const ids = FAULT_RULES_NEXT.map((r) => r.id);
  assert.deepEqual(ids.filter((id) => id !== "paid_then_4xx_vet402_input"), FAULT_RULES.map((r) => r.id));
  assert.equal(ids.indexOf("paid_then_4xx_vet402_input") + 1, ids.indexOf("paid_then_4xx"));
});

test("data/: the census ledger's paid 4xx, judged from the plan: 18 vet402's input, 4 can't tell (22 can't tell under the published rules)", () => {
  const ledger = JSON.parse(readFileSync(join(DATA, "tempo", "ledger.json"), "utf8"));
  const rows = annotateTempoInput(normalizeTempoLedger(ledger, "tempo/ledger"), plan, "tempo/plan").filter((a) => a.tried && !a.delivered);
  const count = (rules?: typeof FAULT_RULES) => {
    const c: Record<string, number> = {};
    for (const a of rows) {
      const k = classifyFailure(a, rules).rule;
      c[k] = (c[k] ?? 0) + 1;
    }
    return c;
  };
  assert.equal(count().paid_then_4xx, 22);
  const next = count(FAULT_RULES_NEXT);
  assert.deepEqual([next.paid_then_4xx_vet402_input, next.paid_then_4xx], [18, 4]);
  // seller-side counts do not move
  assert.deepEqual([next.settled_not_delivered, next.paid_not_delivered], [count().settled_not_delivered, count().paid_not_delivered]);
});
