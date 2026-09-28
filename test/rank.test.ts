import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyFailure, FAULT_RULES } from "../src/rank/classify.js";
import { cdpByHost, compareWithCatalog, spearman } from "../src/rank/compare.js";
import { appealUrl, escapeHtml, renderSite, sellerSlugs, txHtml, txUrl } from "../src/rank/html.js";
import { SellerPacer } from "../src/measure.js";
import { MEASURE_MAX_PER_SELLER } from "../src/constants.js";
import {
  normalizeAlgorand,
  normalizeBase,
  normalizeSolanaCensus,
  normalizeSolanaGate1,
  normalizeTempoLedger,
  parseTempoRunLog,
} from "../src/rank/normalize.js";
import { buildReport } from "../src/rank/report.js";
import { aggregate, gradeFor, MIN_COUNTED, MIN_DAYS, qualifies, rank, wilsonLower, wilsonUpper } from "../src/rank/score.js";
import type { Attempt } from "../src/rank/types.js";

const ALGO_TX = "KXCP3MI7BZWZ2EYQLEC7BJUIQEORE43I35W7QOD6XT7Q4QQSNNEA";
const SOL_SIG = "5t3ZLiqDAE8GLrhCGkJnEwTftj73yhZxEWMT3LqVVxqTHUjGG31X8DYmBMHMNLTypK1b1kYZZ8vTWhemgECkJq6u";
const EVM_TX = "0xdb4fbc76ef920653217974915625b4d0a3d2d3c33bad6449af126d9d6ffaa776";
const ADDR_A = "0x060b0fB0Be9d90557577B3AEE480711067149Ff0";
const ADDR_B = "0x4858d6614e579ca75e1626f3ace0996655ce6d4a";

// ---------- normalization ----------

function algoRow(over: Record<string, unknown>): Record<string, unknown> {
  return { at: "2026-09-27T04:32:00.000Z", url: "https://a.example/x", host: "A.Example", method: "GET", input: "", payTo: "PAYTO", priceUsdc: "0.001000", declared: {}, ...over };
}

test("algorand: verdicts map to categories; only committed payments are tried", () => {
  const rows = normalizeAlgorand(
    {
      mode: "census",
      rows: [
        algoRow({ verdict: "ALLOW", reason: "delivered", paid: true, tx: ALGO_TX, declared: { expectedKeys: ["a"] }, delivery: "200 application/json object{a:string}" }),
        algoRow({ verdict: "REFUSE", reason: "delivery_missing_keys", paid: true, tx: ALGO_TX, declared: { expectedKeys: ["a"] }, delivery: "200 application/json; charset=utf-8 object{b:string}" }),
        algoRow({ verdict: "REFUSE", reason: "http_error", paid: true, tx: ALGO_TX, delivery: "400 application/json; charset=utf-8 status 400" }),
        algoRow({ verdict: "REFUSE", reason: "payment_failed", paid: false, detail: "status 429, no settlement receipt" }),
        algoRow({ verdict: "REFUSE", reason: "not_x402", paid: false }),
        algoRow({ verdict: "REFUSE", reason: "price_over_cap", paid: false }),
        algoRow({ verdict: "REFUSE", reason: "not_json", paid: true, tx: ALGO_TX, delivery: "200 image/png content-type image/png, 0 bytes: " }),
        algoRow({ verdict: "ALLOW", reason: "delivered", paid: true, tx: ALGO_TX, declared: { expectedKeys: [] }, delivery: "200 application/json object{}" }),
      ],
    },
    "algorand/t",
  );
  assert.deepEqual(
    rows.map((r) => [r.category, r.tried, r.settled, r.delivered, r.declaredMatch, r.httpStatus]),
    [
      ["delivered", true, true, true, true, 200],
      ["delivered", true, true, true, false, 200], // 2xx with a body arrives; key mismatch is a separate column
      ["settled_error_status", true, true, false, null, 400],
      ["not_settled", true, false, false, null, 429],
      ["not_payable", false, null, false, null, null],
      ["vet402_skipped", false, null, false, null, null],
      ["settled_empty_body", true, true, false, false, 200],
      ["delivered", true, true, true, null, 200], // nothing declared: not checked
    ],
  );
  assert.equal(rows[0]!.host, "a.example");
  assert.equal(rows[0]!.tx, ALGO_TX);
  assert.equal(rows[1]!.detail, "200 application/json; charset=utf-8 object{b:string}");
});

test("algorand: an unknown reason fails loud instead of being dropped", () => {
  assert.throws(() => normalizeAlgorand({ mode: "census", rows: [algoRow({ verdict: "REFUSE", reason: "brand_new_reason", paid: false })] }, "algorand/t"), /unknown refusal reason/);
  assert.throws(() => normalizeAlgorand({ mode: "census", rows: [algoRow({ verdict: "REFUSE", reason: "weird", paid: true })] }, "algorand/t"), /unknown paid refusal/);
  assert.throws(() => normalizeAlgorand({ mode: "census", rows: [algoRow({ verdict: "ALLOW", reason: "delivered", paid: false })] }, "algorand/t"), /ALLOW without/);
});

test("solana census: status/category map; refused rows are not tried", () => {
  const base = { url: "https://s.example/x", host: "s.example", payTo: "P", at: "2026-09-28T07:00:00.000Z", priceUsdc: "0.001000" };
  const rows = normalizeSolanaCensus(
    {
      kind: "census-live",
      rows: [
        { ...base, status: "delivered", settled: true, delivered: true, reason: "delivered", category: null, signature: SOL_SIG },
        { ...base, status: "settled_not_delivered", settled: true, delivered: false, reason: "delivery_missing_keys", category: "missing_keys", signature: SOL_SIG, httpStatus: 200, first300: '{"x":1}', declared: { outputExample: { y: 1 } } },
        { ...base, status: "settled_not_delivered", settled: true, delivered: false, reason: "http_error", category: "server_error_paid", signature: SOL_SIG, httpStatus: 500 },
        { ...base, status: "not_settled", settled: false, delivered: false, reason: "payment_failed", category: "payment_refused", signature: null },
        { ...base, status: "refused", settled: false, delivered: false, reason: "not_x402", category: "rate_limited", signature: null },
      ],
    },
    "solana/t",
  );
  assert.deepEqual(
    rows.map((r) => r.category),
    ["delivered", "delivered", "settled_error_status", "not_settled", "not_payable"],
  );
  assert.equal(rows[0]!.declaredMatch, null, "nothing declared: not checked");
  assert.equal(rows[1]!.declaredMatch, false);
  assert.equal(rows[2]!.httpStatus, 500);
  assert.equal(rows[4]!.tried, false);
  assert.equal(rows[4]!.settled, null);
});

test("solana gate1: sent and refused records", () => {
  const rows = normalizeSolanaGate1(
    {
      kind: "gate1-live",
      ranAt: "2026-09-28T06:52:30.661Z",
      records: [
        { host: "g.example", requestUrl: "https://g.example/a", outcome: "refused", refusal: { refused: "no_solana_accept", detail: "x" }, probe: {} },
        { host: "g.example", requestUrl: "https://g.example/b", outcome: "sent", settled: true, delivered: true, signature: SOL_SIG, probe: { payTo: "P1" }, response: { status: 200 } },
        { host: "g.example", requestUrl: "https://g.example/c", outcome: "sent", settled: false, delivered: false, signature: null, probe: { payTo: "P1" }, response: { status: 402 } },
      ],
    },
    "gate1/t",
  );
  assert.deepEqual(rows.map((r) => [r.category, r.tried, r.payTo]), [["not_payable", false, null], ["delivered", true, "P1"], ["not_settled", true, "P1"]]);
  assert.equal(rows[1]!.at, "2026-09-28T06:52:30.661Z");
  assert.equal(rows[2]!.httpStatus, 402);
});

test("tempo: ledger rows and run-log payTo refusals", () => {
  const entry = (over: Record<string, unknown>) => ({ key: "svc", url: "https://svc.example/q", recipient: ADDR_A, amount: "8000", status: "sent", reservedAt: "2026-09-28T07:55:54.160Z", note: "", ...over });
  const rows = normalizeTempoLedger(
    {
      entries: [
        entry({ httpStatus: 200, settled: true, delivered: true, txHash: EVM_TX }),
        entry({ key: "svc2", httpStatus: 404, settled: true, delivered: false, txHash: EVM_TX }),
        entry({ key: "svc3", httpStatus: 502, settled: null, delivered: false, txHash: null }),
        entry({ key: "svc4", httpStatus: 404, settled: false, delivered: false, txHash: null, note: "receipt not found" }),
      ],
    },
    "tempo/t",
  );
  assert.deepEqual(rows.map((r) => r.category), ["delivered", "settled_error_status", "unconfirmed_server_error", "not_settled"]);
  assert.equal(rows[0]!.bodyChecked, false, "the Tempo runner keeps no body");
  assert.equal(rows[0]!.priceUsdc, "0.008000");
  assert.equal(rows[0]!.service, "svc");

  const log = [
    "[pay] payer 0x9B59 cap 2.110000 USDC.e",
    `parallel                           refused recipient_mismatch (recipient ${ADDR_B} != recorded 0xc478c7a71af71a3301465915bcc8a7d7cac60da9)`,
    "alphavantage                       refused already_bought (alphavantage)",
    `aviationstack                      sent http 200 settled true delivered true https://explore.tempo.xyz/tx/${EVM_TX}`,
  ].join("\n");
  const refusals = parseTempoRunLog(log, new Map([["parallel", "https://parallel.example/search"]]), "2026-09-28T08:09:00.000Z", "tempo/log");
  assert.equal(refusals.length, 1, "already_bought and sent lines are not rows");
  assert.equal(refusals[0]!.category, "payto_changed");
  assert.equal(refusals[0]!.payTo, ADDR_B);
  assert.equal(refusals[0]!.expectedPayTo, "0xc478c7a71af71a3301465915bcc8a7d7cac60da9");
  assert.throws(() => parseTempoRunLog("ghost    refused recipient_mismatch (x)", new Map(), "t", "tempo/log"), /no URL/);
});

test("base: purchases with feedback tx; unsettled 200 is not delivered", () => {
  const line = (over: Record<string, unknown>) =>
    JSON.stringify({ resource: "https://b.example/api", outcome: "sent", payTo: ADDR_A, at: "2026-09-28T08:16:44.959Z", priceUsdc: "0.001000", response: { status: 200 }, ...over });
  const rows = normalizeBase(
    [line({ settlementTx: EVM_TX, settledOnChain: true, delivered: true }), line({ settlementTx: null, settledOnChain: false, delivered: false }), ""].join("\n"),
    { [EVM_TX]: { agentId: "1", feedbackTx: "0xfeed" } },
    "base/t",
  );
  assert.deepEqual(rows.map((r) => r.category), ["delivered", "not_settled"]);
  assert.equal(rows[0]!.feedbackTx, "0xfeed");
});

// ---------- ranking ----------

test("wilsonLower: known values and guards", () => {
  assert.equal(wilsonLower(0, 0), 0);
  assert.equal(wilsonLower(0, 5), 0);
  assert.ok(Math.abs(wilsonLower(1, 1) - 0.2065) < 1e-3);
  assert.ok(Math.abs(wilsonLower(10, 10) - 0.7225) < 1e-3);
  assert.ok(Math.abs(wilsonLower(81, 100) - 0.7222) < 1e-3);
  assert.throws(() => wilsonLower(3, 2));
  assert.throws(() => wilsonLower(1.5, 2));
});

function att(over: Partial<Attempt>): Attempt {
  return {
    chain: "solana",
    source: "t",
    host: "h.example",
    service: null,
    url: "https://h.example/x",
    payTo: "P",
    expectedPayTo: null,
    at: "2026-09-28T00:00:00.000Z",
    tried: true,
    settled: true,
    delivered: true,
    category: "delivered",
    rawReason: "delivered",
    detail: null,
    tx: SOL_SIG,
    priceUsdc: "0.001000",
    httpStatus: 200,
    declaredMatch: null,
    bodyChecked: true,
    feedbackTx: null,
    ...over,
  };
}
/** A seller-side failure: paid, settled, then 500. */
const fail = (over: Partial<Attempt>) => att({ delivered: false, category: "settled_error_status", settled: true, httpStatus: 500, rawReason: "http_error", ...over });
/** A vet402-side failure: 429 during a burst, nothing settled. */
const burst = (over: Partial<Attempt>) => att({ delivered: false, category: "not_settled", settled: false, tx: null, httpStatus: 429, rawReason: "payment_failed", detail: "status 429, no settlement receipt", ...over });
const DAY1 = "2026-09-27T04:00:00.000Z";
const DAY2 = "2026-09-28T04:00:00.000Z";
/** n rows for one host, alternating across two days. */
const series = (host: string, ok: number, bad: number, days = [DAY1, DAY2]): Attempt[] =>
  Array.from({ length: ok + bad }, (_, i) => (i < ok ? att : fail)({ host, at: days[i % days.length]! }));

// ---------- classification (rule 1) ----------

test("classify: each reason goes to the fault the method page promises", () => {
  const nf = (over: Partial<Attempt>) => att({ delivered: false, category: "not_settled", settled: false, tx: null, rawReason: "payment_failed", httpStatus: null, ...over });
  const cases: [Attempt, string, string][] = [
    [fail({}), "seller", "paid_not_delivered"],
    [att({ delivered: false, category: "settled_empty_body", settled: true }), "seller", "paid_not_delivered"],
    [nf({ detail: "status 429, no settlement receipt" }), "vet402_or_facilitator", "rate_limited_429"],
    [nf({ httpStatus: 429 }), "vet402_or_facilitator", "rate_limited_429"],
    [nf({ detail: "status 402, subcent_quota_exceeded" }), "vet402_or_facilitator", "subcent_quota"],
    [nf({ detail: 'status 402, {"error":"Payment rejected (invalid_exact_svm_transaction_simulation_failed): Simulation failed: \\"BlockhashNotFound\\""}' }), "vet402_or_facilitator", "payment_tx_rejected"],
    [nf({ detail: "status 402, Transaction simulation failed: transaction already in ledger: X" }), "vet402_or_facilitator", "payment_tx_rejected"],
    [nf({ detail: "status 402, Transaction T submitted but not confirmed: Transaction Rejected: txn dead: round 2 outside of 1--1" }), "vet402_or_facilitator", "payment_tx_rejected"],
    [nf({ detail: "status 503, no settlement receipt" }), "seller", "server_error_5xx"],
    [nf({ category: "unconfirmed_server_error", settled: null, rawReason: "http 502" }), "seller", "server_error_5xx"],
    [nf({ detail: "The operation was aborted due to timeout" }), "unknown", "timeout"],
    [nf({ detail: "status 400, no settlement receipt" }), "unknown", "request_rejected_4xx"],
    [nf({ rawReason: "http_error/example_rejected", httpStatus: 404 }), "unknown", "request_rejected_4xx"],
    [nf({ detail: "status 402, {}" }), "unknown", "payment_not_accepted_402"],
    [nf({ detail: "status 200, no settlement receipt" }), "unknown", "answer_without_settlement"],
    [nf({ rawReason: "sent/http ?", detail: null }), "unknown", "unclassified"],
  ];
  for (const [a, fault, rule] of cases) assert.deepEqual(classifyFailure(a), { fault, rule }, `${a.rawReason} ${a.detail}`);
  assert.throws(() => classifyFailure(att({})), /only tried, not delivered/);
});

test("classify: a 429 after settlement is still the seller's (money moved, nothing came back)", () => {
  assert.equal(classifyFailure(fail({ httpStatus: 429 })).fault, "seller");
});

test("classify: README lists every rule with its fault, in order", () => {
  const readme = readFileSync(new URL("../src/rank/README.md", import.meta.url), "utf8");
  let from = 0;
  for (const r of FAULT_RULES) {
    const line = `| \`${r.id}\` | ${r.fault} |`;
    const at = readme.indexOf(line, from);
    assert.ok(at >= 0, `README is missing or out of order: ${line}`);
    from = at + line.length;
  }
});

test("aggregate: only seller-side failures enter the grade; others are counts", () => {
  const rows = [...series("s.example", 20, 0), ...Array.from({ length: 500 }, () => burst({ host: "s.example" })), att({ host: "s.example", delivered: false, category: "not_settled", settled: false, tx: null, httpStatus: 400, rawReason: "payment_failed" })];
  const s = aggregate(rows)[0]!;
  assert.equal(s.tried, 521);
  assert.equal(s.counted, 20);
  assert.equal(s.delivered, 20);
  assert.deepEqual(s.excluded, { vet402_or_facilitator: 500, unknown: 1 });
  assert.equal(s.failuresByRule.rate_limited_429, 500);
  assert.equal(s.wilsonLower, wilsonLower(20, 20), "excluded failures do not move the score");
  assert.equal(s.sellerFailures.length, 0);
});

test("aggregate: declared match is its own column and never changes delivery", () => {
  const s = aggregate([att({ declaredMatch: true }), att({ declaredMatch: false }), att({ declaredMatch: null })])[0]!;
  assert.equal(s.delivered, 3);
  assert.deepEqual(s.declared, { checked: 2, matched: 1 });
});

// ---------- rank numbers (rule 3) ----------

test("rank number: needs 10 counted purchases on 2+ different days", () => {
  assert.equal(MIN_COUNTED, 10);
  assert.equal(MIN_DAYS, 2);
  assert.equal(qualifies(10, 2), true);
  assert.equal(qualifies(9, 5), false);
  assert.equal(qualifies(500, 1), false);
  const ranked = rank(
    aggregate([
      ...series("ten-two-days.example", 10, 0),
      ...series("ten-one-day.example", 10, 0, [DAY1]),
      ...series("nine-two-days.example", 9, 0),
      // 10 tries, but one was vet402's 429: 9 counted
      ...series("burst.example", 9, 0),
      burst({ host: "burst.example", at: DAY2 }),
      att({ host: "one.example" }),
      fail({ host: "one-fail.example" }),
      att({ host: "skipped.example", tried: false, delivered: false, category: "not_payable", settled: null }),
    ]),
  );
  assert.deepEqual(
    ranked.map((s) => [s.key, s.rank, s.grade]),
    [
      ["ten-two-days.example", 1, "C"],
      ["burst.example", null, "measuring"],
      ["nine-two-days.example", null, "measuring"],
      ["one-fail.example", null, "measuring"],
      ["one.example", null, "measuring"],
      ["ten-one-day.example", null, "measuring"],
    ],
  );
  assert.ok(!ranked.some((s) => s.key === "skipped.example"), "a seller with no tried purchase is not listed");
});

test("rank: order by lower bound among qualified sellers; ties share a number", () => {
  const ranked = rank(aggregate([...series("a.example", 40, 0), ...series("b.example", 40, 0), ...series("c.example", 18, 2), ...series("d.example", 12, 0)]));
  assert.deepEqual(
    ranked.map((s) => [s.key, s.rank]),
    [
      ["a.example", 1],
      ["b.example", 1],
      ["d.example", 3],
      ["c.example", 4],
    ],
  );
});

// ---------- marks (rule 4) ----------

test("wilsonUpper: known values", () => {
  assert.equal(wilsonUpper(0, 0), 1);
  assert.ok(Math.abs(wilsonUpper(0, 1) - 0.7935) < 1e-3, "one failure alone cannot be called bad");
  assert.ok(Math.abs(wilsonUpper(0, 10) - 0.2775) < 1e-3);
  assert.ok(Math.abs(wilsonUpper(10, 10) - 1) < 1e-9);
});

test("grades: good marks by the lower bound, D only by the upper bound", () => {
  assert.equal(gradeFor(35, 35, 2), "A"); // lower 0.901
  assert.equal(gradeFor(34, 34, 2), "B"); // lower 0.898
  assert.equal(gradeFor(10, 10, 2), "C"); // lower 0.722: all delivered is not enough evidence for B
  assert.equal(gradeFor(8, 10, 2), "undecided"); // lower 0.490, upper 0.943
  assert.equal(gradeFor(4, 10, 2), "undecided", "a 40% rate is not a D while the upper bound is 0.69");
  assert.equal(gradeFor(1, 10, 2), "D"); // upper 0.404
  assert.equal(gradeFor(0, 10, 2), "D");
  assert.equal(gradeFor(0, 1, 1), "measuring");
  assert.equal(gradeFor(0, 9, 2), "measuring");
  for (let n = MIN_COUNTED; n <= 60; n++)
    for (let k = 0; k <= n; k++) {
      const g = gradeFor(k, n, 2);
      if (g === "D") assert.ok(wilsonUpper(k, n) < 0.5, `D at ${k}/${n}`);
      if (g === "A") assert.ok(wilsonLower(k, n) >= 0.9, `A at ${k}/${n}`);
      if (g === "B") assert.ok(wilsonLower(k, n) >= 0.75, `B at ${k}/${n}`);
      if (g === "C") assert.ok(wilsonLower(k, n) >= 0.5, `C at ${k}/${n}`);
    }
});

// ---------- measurement pacing (rule 2) ----------

test("pacer: at most 5 per seller per run, spaced apart; other sellers are independent", () => {
  assert.equal(MEASURE_MAX_PER_SELLER, 5);
  let now = 0;
  const p = new SellerPacer(5, 60_000, () => now);
  for (let i = 0; i < 5; i++) {
    assert.equal(p.waitMs("s"), 0);
    p.record("s");
    assert.equal(p.waitMs("s"), i < 4 ? 60_000 : null);
    assert.throws(() => p.record("s"), /not due/);
    assert.equal(p.waitMs("other"), 0);
    now += 60_000;
  }
  assert.equal(p.waitMs("s"), null, "sixth purchase from the same seller is refused");
});

test("payTo: change on the same chain and URL is flagged; one recipient per chain is not", () => {
  const multiChain = aggregate([
    att({ chain: "algorand", payTo: "ALGOADDR", at: "2026-09-27T00:00:00.000Z" }),
    att({ chain: "base", payTo: ADDR_A, at: "2026-09-28T00:00:00.000Z" }),
  ])[0]!;
  assert.equal(multiChain.payToChanged, false);
  assert.deepEqual(multiChain.payTos, [ADDR_A.toLowerCase(), "ALGOADDR"]);

  const changed = aggregate([att({ payTo: "P1", at: "2026-09-27T00:00:00.000Z" }), att({ payTo: "P2", at: "2026-09-28T00:00:00.000Z" })])[0]!;
  assert.equal(changed.payToChanged, true);
  assert.equal(changed.payToChanges[0]!.how, "differs_between_runs");

  const evmCase = aggregate([att({ chain: "base", payTo: ADDR_A }), att({ chain: "base", payTo: ADDR_A.toLowerCase() })])[0]!;
  assert.equal(evmCase.payToChanged, false, "EVM address case is not a change");

  const refused = aggregate([att({ chain: "tempo" }), att({ chain: "tempo", tried: false, delivered: false, category: "payto_changed", payTo: ADDR_B, expectedPayTo: ADDR_A.toLowerCase(), settled: null })])[0]!;
  assert.equal(refused.payToChanged, true);
  assert.equal(refused.payToChanges[0]!.how, "refused_at_payment");
});

test("seller identity: a host fronting several services splits by service", () => {
  const stats = aggregate([
    att({ chain: "tempo", host: "proxy.example", service: "s1" }),
    fail({ chain: "tempo", host: "proxy.example", service: "s2" }),
    att({ chain: "tempo", host: "solo.example", service: "solo" }),
  ]);
  assert.deepEqual(stats.map((s) => s.key).sort(), ["proxy.example#s1", "proxy.example#s2", "solo.example"]);
  assert.deepEqual(stats.find((s) => s.key === "solo.example")!.services, ["solo"]);
});

test("aggregate: own hosts are excluded", () => {
  assert.equal(aggregate([att({ host: "vet402.com" })], ["vet402.com"]).length, 0);
});

// ---------- comparison ----------

test("cdpByHost sums calls per host and ignores bad items", () => {
  const m = cdpByHost([
    { resource: "https://X.example/a", quality: { l30DaysTotalCalls: 10, l30DaysUniquePayers: 3, lastCalledAt: "2026-09-01T00:00:00Z" } },
    { resource: "https://x.example/b", quality: { l30DaysTotalCalls: 5, l30DaysUniquePayers: 4, lastCalledAt: "2026-09-02T00:00:00Z" } },
    { resource: "not a url" },
    null,
  ]);
  assert.deepEqual(m.get("x.example"), { host: "x.example", resources: 2, calls30d: 15, maxUniquePayers30d: 4, lastCalledAt: "2026-09-02T00:00:00Z" });
  assert.equal(m.size, 1);
});

test("compareWithCatalog: counts high-but-never-delivered and low-but-always-delivered", () => {
  const rows: Attempt[] = [
    fail({ host: "popular-broken.example", settled: null, category: "unconfirmed_server_error", tx: null, httpStatus: 503 }),
    att({ host: "popular-broken2.example", delivered: false, category: "settled_error_status", settled: true, httpStatus: 500, tx: SOL_SIG }),
    att({ host: "popular-good.example" }),
    att({ host: "quiet-good.example" }),
    fail({ host: "quiet-broken.example" }),
    att({ host: "unlisted.example" }),
  ];
  const ranked = rank(aggregate(rows));
  const calls = new Map([
    ["popular-broken.example", 1000],
    ["popular-broken2.example", 900],
    ["popular-good.example", 800],
    ["quiet-good.example", 3],
    ["quiet-broken.example", 2],
  ]);
  const c = compareWithCatalog(ranked, "CDP", "calls", "desc", (s) => calls.get(s.host) ?? null);
  assert.equal(c.overlap, 5);
  assert.equal(c.highCutoffPos, 3);
  assert.deepEqual(c.highButNeverDelivered.map((r) => r.key), ["popular-broken2.example", "popular-broken.example"], "paid-and-failed first");
  assert.equal(c.highButNeverDeliveredDespitePaidTx, 1);
  assert.deepEqual(c.lowButAlwaysDelivered.map((r) => r.key), ["quiet-good.example"]);
  assert.equal(c.misaligned, 3);

  const byRank = compareWithCatalog(ranked, "Mercator", "rank", "asc", (s) => (s.host === "quiet-good.example" ? 1 : s.host === "popular-broken.example" ? 9 : null));
  assert.equal(byRank.overlap, 2);
  assert.equal(byRank.highCutoffPos, 1);
  assert.equal(byRank.highButNeverDelivered.length, 0);
  assert.equal(byRank.lowButAlwaysDelivered.length, 0);
});

test("spearman: perfect, inverse, too few", () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [4, 3, 2, 1]), -1);
  assert.equal(spearman([1, 2], [1, 2]), null);
});

// ---------- escaping ----------

test("escapeHtml escapes every markup-significant character", () => {
  assert.equal(escapeHtml(`<a href="x" onclick='y'>&\``), "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&#96;");
});

test("txUrl: only well-formed ids become links, onto fixed explorers", () => {
  assert.equal(txUrl("algorand", ALGO_TX), `https://allo.info/tx/${ALGO_TX}`);
  assert.equal(txUrl("solana", SOL_SIG), `https://solscan.io/tx/${SOL_SIG}`);
  assert.equal(txUrl("base", EVM_TX), `https://basescan.org/tx/${EVM_TX}`);
  assert.equal(txUrl("tempo", "javascript:alert(1)"), null);
  assert.equal(txUrl("base", `${EVM_TX}"><script>`), null);
  const html = txHtml("solana", `"><img src=x onerror=alert(1)>`);
  assert.ok(!html.includes("<img"), html);
  assert.ok(!html.includes("href"), "malformed tx is text, not a link");
});

test("renderSite: seller-controlled strings cannot inject markup on any page", () => {
  const evil = `<script>alert(1)</script>`;
  const evilHost = `evil.example"><img src=x onerror=alert(1)>`;
  const rows: Attempt[] = [
    ...series(evilHost, 10, 0).map((a) => ({ ...a, url: `https://evil.example/${evil}`, payTo: `P1${evil}` })),
    fail({ host: evilHost, url: `https://evil.example/${evil}`, payTo: `P2'${evil}`, rawReason: evil, detail: `{"error":"${evil}"}`, tx: `x${evil}`, at: DAY2 }),
    burst({ host: evilHost, detail: `status 429 ${evil}` }),
    att({ chain: "tempo", host: "proxy.example", service: `../../${evil}`, at: DAY1 }),
    att({ chain: "tempo", host: "proxy.example", service: "s2", at: DAY1 }),
  ];
  const report = buildReport({
    date: "2026-09-28",
    generatedAt: "2026-09-28T00:00:00.000Z",
    attempts: rows,
    excludeHosts: [],
    cdp: new Map([[evilHost, { host: evilHost, resources: 1, calls30d: 5, maxUniquePayers30d: 1, lastCalledAt: null }]]),
    mercator: null,
    inputs: [{ label: evil, location: evil, sha256: "0".repeat(64) }],
  });
  const pages = renderSite(report);
  assert.ok(pages.has("index.html") && pages.has("method.html"));
  assert.equal(pages.size, 2 + report.ranking.length, "one page per listed seller");
  for (const [path, html] of pages) {
    assert.match(path, /^(index|method)\.html$|^s\/[a-z0-9._-]+\.html$/, `safe file name: ${path}`);
    assert.ok(!path.includes(".."), path);
    assert.ok(!html.includes("<script"), `${path}: no script tag survives`);
    assert.ok(!html.includes("<img"), `${path}: no img tag survives`);
    assert.ok(!html.includes('"><img'), `${path}: attribute breakout is escaped`);
    assert.ok(html.includes("script-src 'none'"), `${path}: CSP forbids scripts as a second line`);
    assert.ok(html.includes('name="viewport"'), `${path}: phone-width viewport`);
  }
  const sellerPage = [...pages].find(([p, h]) => p.startsWith("s/") && h.includes("evil.example&quot;&gt;&lt;img"))!;
  assert.ok(sellerPage, "seller page shows the escaped host");
  assert.ok(sellerPage[1].includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(sellerPage[1].includes("https://github.com/kzmttkc/vet402-delivery/issues/new?title="), "correction link");
});

test("appeal link and slugs: encoded query on a fixed origin, file names reduced to a safe set", () => {
  const u = appealUrl(`a.example#"><script>&x=1`, "2026-09-28");
  assert.ok(u.startsWith("https://github.com/kzmttkc/vet402-delivery/issues/new?title="));
  assert.ok(!/[<>"# ]/.test(u.slice(u.indexOf("?"))), u);
  const slugs = sellerSlugs(["a.example", "A.example", "p.example#../../x", ".hidden", "p.example#s/1"]);
  assert.deepEqual([...slugs.values()], ["a.example", "a.example-2", "p.example_____x", "_hidden", "p.example_s_1"]);
});

test("index: grade, arrived count and last date per row; measuring rows carry no number", () => {
  const report = buildReport({
    date: "2026-09-28",
    generatedAt: "2026-09-28T00:00:00.000Z",
    attempts: [...series("good.example", 40, 0), att({ host: "new.example", at: DAY2 })],
    excludeHosts: [],
    cdp: null,
    mercator: null,
    inputs: [],
  });
  const html = renderSite(report).get("index.html")!;
  assert.ok(html.includes("We buy from each seller with our own money"));
  assert.ok(html.includes('<span class="rk">1</span><span class="g gA"'), html);
  assert.ok(html.includes('href="s/good.example.html">good.example</a><span class="num">40/40</span><span class="date">2026-09-28</span>'));
  assert.ok(html.includes('<span class="rk"></span><span class="g gmeasuring"'), "measuring row has no rank number");
  assert.ok(html.includes('href="method.html"'), "one link to the method");
});
