import { test } from "node:test";
import assert from "node:assert/strict";
import { cdpByHost, compareWithCatalog, spearman } from "../src/rank/compare.js";
import { escapeHtml, renderHtml, txHtml, txUrl } from "../src/rank/html.js";
import {
  normalizeAlgorand,
  normalizeBase,
  normalizeSolanaCensus,
  normalizeSolanaGate1,
  normalizeTempoLedger,
  parseTempoRunLog,
} from "../src/rank/normalize.js";
import { buildReport } from "../src/rank/report.js";
import { aggregate, rank, wilsonLower } from "../src/rank/score.js";
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
        algoRow({ verdict: "ALLOW", reason: "delivered", paid: true, tx: ALGO_TX }),
        algoRow({ verdict: "REFUSE", reason: "delivery_missing_keys", paid: true, tx: ALGO_TX, delivery: "200 object{}" }),
        algoRow({ verdict: "REFUSE", reason: "http_error", paid: true, tx: ALGO_TX }),
        algoRow({ verdict: "REFUSE", reason: "payment_failed", paid: false, detail: "status 400, no settlement receipt" }),
        algoRow({ verdict: "REFUSE", reason: "not_x402", paid: false }),
        algoRow({ verdict: "REFUSE", reason: "price_over_cap", paid: false }),
      ],
    },
    "algorand/t",
  );
  assert.deepEqual(
    rows.map((r) => [r.category, r.tried, r.settled, r.delivered]),
    [
      ["delivered", true, true, true],
      ["settled_bad_content", true, true, false],
      ["settled_error_status", true, true, false],
      ["not_settled", true, false, false],
      ["not_payable", false, null, false],
      ["vet402_skipped", false, null, false],
    ],
  );
  assert.equal(rows[0]!.host, "a.example");
  assert.equal(rows[0]!.tx, ALGO_TX);
  assert.equal(rows[1]!.detail, "200 object{}");
  assert.equal(rows[0]!.deliveryCheck, "declared_keys");
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
        { ...base, status: "settled_not_delivered", settled: true, delivered: false, reason: "delivery_missing_keys", category: "missing_keys", signature: SOL_SIG },
        { ...base, status: "settled_not_delivered", settled: true, delivered: false, reason: "http_error", category: "server_error_paid", signature: SOL_SIG },
        { ...base, status: "not_settled", settled: false, delivered: false, reason: "payment_failed", category: "payment_refused", signature: null },
        { ...base, status: "refused", settled: false, delivered: false, reason: "not_x402", category: "rate_limited", signature: null },
      ],
    },
    "solana/t",
  );
  assert.deepEqual(
    rows.map((r) => r.category),
    ["delivered", "settled_bad_content", "settled_error_status", "not_settled", "not_payable"],
  );
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
  assert.equal(rows[1]!.deliveryCheck, "http_2xx");
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
    deliveryCheck: "http_2xx",
    feedbackTx: null,
    ...over,
  };
}
const fail = (over: Partial<Attempt>) => att({ delivered: false, category: "not_settled", settled: false, tx: null, rawReason: "payment_failed", ...over });

test("rank: sample size matters; one lucky try does not beat a long record", () => {
  const rows: Attempt[] = [
    att({ host: "one.example" }),
    ...Array.from({ length: 20 }, (_, i) => (i < 18 ? att({ host: "many.example" }) : fail({ host: "many.example" }))),
    ...Array.from({ length: 5 }, () => fail({ host: "never.example" })),
    att({ host: "skipped.example", tried: false, delivered: false, category: "not_payable", settled: null }),
  ];
  const ranked = rank(aggregate(rows));
  assert.deepEqual(ranked.map((s) => s.key), ["many.example", "one.example", "never.example"]);
  assert.equal(ranked[0]!.delivered, 18);
  assert.equal(ranked[0]!.tried, 20);
  assert.equal(ranked[2]!.wilsonLower, 0);
  assert.ok(!ranked.some((s) => s.key === "skipped.example"), "a seller with no tried purchase is not ranked");
});

test("rank: non-tried rows never move the score", () => {
  const base = [att({}), fail({})];
  const withNoise = [...base, ...Array.from({ length: 50 }, () => att({ tried: false, delivered: false, category: "vet402_skipped", settled: null }))];
  const a = aggregate(base)[0]!;
  const b = aggregate(withNoise)[0]!;
  assert.equal(a.wilsonLower, b.wilsonLower);
  assert.equal(b.notTried.vet402_skipped, 50);
});

test("rank: ties share a rank", () => {
  const ranked = rank(aggregate([att({ host: "a.example" }), att({ host: "b.example" }), fail({ host: "c.example" })]));
  assert.deepEqual(ranked.map((s) => s.rank), [1, 1, 3]);
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
    fail({ host: "popular-broken.example" }),
    att({ host: "popular-broken2.example", delivered: false, category: "settled_bad_content", settled: true, tx: SOL_SIG }),
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

test("renderHtml: seller-controlled strings cannot inject markup", () => {
  const evil = `<script>alert(1)</script>`;
  const evilHost = `evil.example"><img src=x onerror=alert(1)>`;
  const rows: Attempt[] = [
    att({ host: evilHost, url: `https://evil.example/${evil}`, payTo: `P1${evil}`, at: "2026-09-27T00:00:00.000Z" }),
    fail({ host: evilHost, url: `https://evil.example/${evil}`, payTo: `P2'${evil}`, rawReason: evil, detail: `{"error":"${evil}"}`, tx: `x${evil}`, at: "2026-09-28T00:00:00.000Z" }),
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
  const html = renderHtml(report);
  assert.ok(!html.includes("<script"), "no script tag survives");
  assert.ok(!html.includes("<img"), "no img tag survives");
  assert.ok(!html.includes('"><img'), "attribute breakout is escaped");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("script-src 'none'"), "CSP forbids scripts as a second line");
  assert.ok(html.includes('name="viewport"'), "phone-width viewport");
});
