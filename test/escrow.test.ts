/**
 * "What an escrow would have returned" (src/escrow/would-refund.ts) and its page (site/escrow.html):
 *  - the counts are the ranking's own: the refund rules sum to the same failures as site/rank.json
 *  - every settled, not delivered purchase lands in exactly one of: returned, vet402's wrong request, can't tell
 *  - only sellers in data/records/notified.json are named; everyone else is a count
 *  - site/escrow.html and site/escrow.json are what scripts/build-site.ts makes, and the page keeps the wording rules
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FAULT_RULES } from "../src/rank/classify.js";
import type { RankReport } from "../src/rank/report.js";
import { sellerKeys } from "../src/rank/score.js";
import { notifiedSellers, type NotifiedFile } from "../src/receipt/publish.js";
import { renderEscrowPage, usd, type DevnetRun } from "../src/escrow/page.js";
import { loadAttemptsFromData, microsToUsd, REFUND_RULES, usdToMicros, VET402_INPUT_RULES, wouldRefund, wouldRefundFromData } from "../src/escrow/would-refund.js";
import type { Attempt } from "../src/rank/types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const report = wouldRefundFromData(DATA);
const rank = JSON.parse(readFileSync(join(ROOT, "site", "rank.json"), "utf8")) as RankReport;
const notified = JSON.parse(readFileSync(join(DATA, "records", "notified.json"), "utf8")) as NotifiedFile;

test("the refund rules are on the seller's side in the ranking, the wrong-request rule on vet402's", () => {
  for (const id of REFUND_RULES) assert.equal(FAULT_RULES.find((r) => r.id === id)?.fault, "seller", id);
  for (const id of VET402_INPUT_RULES) assert.equal(FAULT_RULES.find((r) => r.id === id)?.fault, "vet402_or_facilitator", id);
});

test("the totals equal the ranking's (site/rank.json) for the same data", () => {
  assert.equal(report.dataDate, rank.date);
  const byRule = rank.totals.failuresByRule;
  const sum = (ids: readonly string[]) => ids.reduce((n, id) => n + (byRule[id] ?? 0), 0);
  assert.equal(report.totals.wouldRefund.purchases, sum(REFUND_RULES));
  assert.equal(report.totals.vet402Input.purchases, sum(VET402_INPUT_RULES));
  assert.equal(report.totals.cantTell.purchases, sum(["paid_then_4xx", "paid_then_402_placeholder"]));
  assert.equal(report.totals.settled, rank.totals.settled);
  assert.equal(report.totals.wouldRefund.purchases + report.totals.vet402Input.purchases + report.totals.cantTell.purchases, rank.totals.settledNotDelivered);
  for (const c of report.chains) {
    const r = rank.chains.find((x) => x.chain === c.chain)!;
    assert.equal(c.settled, r.settled, c.chain);
    assert.equal(c.delivered, r.delivered, c.chain);
    assert.equal(c.wouldRefund.byRule.settled_not_delivered + c.wouldRefund.byRule.paid_not_delivered, c.wouldRefund.purchases);
  }
});

test("only told sellers are named; the rest are counted", () => {
  const told = notifiedSellers(notified);
  for (const c of report.chains) {
    for (const s of c.toldSellers) assert.ok(told.has(s.seller), s.seller);
    assert.equal(c.toldSellers.length + c.notToldSellers, c.sellers, c.chain);
  }
  // Every seller with a returned purchase who was not told: its name is nowhere on the page or in the JSON.
  const { attempts } = loadAttemptsFromData(DATA);
  const keys = sellerKeys(attempts);
  const untold = new Set<string>();
  for (const a of attempts) {
    if (a.tried && a.settled === true && !a.delivered && !told.has(keys.get(a)!)) untold.add(a.host);
  }
  assert.ok(untold.size > 0);
  const html = readFileSync(join(ROOT, "site", "escrow.html"), "utf8");
  const json = readFileSync(join(ROOT, "site", "escrow.json"), "utf8");
  for (const h of untold) {
    assert.ok(!html.includes(h), `escrow.html names ${h}`);
    assert.ok(!json.includes(h), `escrow.json names ${h}`);
  }
});

test("amounts: summed in millionths, never through floating point", () => {
  assert.equal(usdToMicros("0.001"), 1000n);
  assert.equal(usdToMicros("1.5"), 1_500_000n);
  assert.equal(usdToMicros("0.0105000"), 10_500n);
  assert.throws(() => usdToMicros("0.0000001"));
  assert.throws(() => usdToMicros("-1"));
  assert.equal(microsToUsd(927_000n), "0.927000");
  assert.equal(usd("0.927000"), "0.927");
  assert.equal(usd("0.250000"), "0.25");
  assert.equal(usd("0.000000"), "0.00");
  const row = (over: Partial<Attempt>): Attempt => ({
    chain: "solana", source: "t", host: "s.example", service: null, url: "https://s.example/x", payTo: "P", expectedPayTo: null, at: "2026-09-29T00:00:00Z",
    tried: true, settled: true, delivered: false, category: "settled_error_status", rawReason: "status 503", detail: null, tx: "t", priceUsdc: "0.1", httpStatus: 503,
    declaredMatch: null, bodyChecked: true, feedbackTx: null, ...over,
  });
  const r = wouldRefund({ date: "2026-09-29", attempts: [row({}), row({ priceUsdc: "0.2" }), row({ httpStatus: 400, rawReason: "status 400" }), row({ delivered: true, category: "delivered", httpStatus: 200 }), row({ settled: false, category: "not_settled" })], notified: null });
  assert.equal(r.totals.wouldRefund.purchases, 2);
  assert.equal(r.totals.wouldRefund.amountUsd, "0.300000");
  assert.equal(r.totals.cantTell.purchases, 1);
  assert.equal(r.totals.settled, 4);
  assert.equal(r.totals.notToldSellers, 1);
});

test("site/escrow.html and site/escrow.json are what build-site makes now, and the page keeps the public wording rules", () => {
  const devnetFile = join(ROOT, "solana-program", "escrow-devnet.json");
  const devnet = existsSync(devnetFile) ? (JSON.parse(readFileSync(devnetFile, "utf8")) as DevnetRun) : null;
  const html = renderEscrowPage(report, devnet);
  assert.equal(readFileSync(join(ROOT, "site", "escrow.html"), "utf8"), html, "site/escrow.html is up to date");
  assert.equal(readFileSync(join(ROOT, "site", "escrow.json"), "utf8"), JSON.stringify(report, null, 2) + "\n", "site/escrow.json is up to date");
  const words = html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ");
  assert.ok(!/\b(we|us|our|ours|ourselves)\b/i.test(words), "no we/us/our");
  assert.ok(!words.includes("—"), "no em dash");
  assert.ok(!/[぀-ヿ一-鿿]/.test(words), "no Japanese");
  assert.ok(!html.includes("<script"), "no script");
  assert.ok(html.includes("script-src 'none'"), "CSP");
});

test("devnet section: links only from Solana-shaped ids, onto the devnet explorer", () => {
  const sig = "5".repeat(88);
  const d: DevnetRun = {
    kind: "vet402-escrow-devnet",
    cluster: "devnet",
    rootsProgram: "CTepEgSktQbjAw6SDGJts82tqZwaJ6XUn5Yqe6gi1tUi",
    escrowProgram: "p7HTembyKn78rT4doqVneMw9qfck7yY3Zf3QRLCxMBA",
    mint: "3HPD2pJ2ZBHPHW5mWMKLhc4VAUktpjchXdXWcvR9xSgZ",
    demo: {
      ranAt: "2026-10-01T00:00:00Z",
      runs: [{ record: "obs_2026-09-30_000552", verdict: "NOT_DELIVERED", outcome: "returned to the buyer", amount: "100000", decimals: 6, payTo: "9VaDVp1Wb78G4Wm6VuTiMrpESjrUymXefQTHcJGRSTEA", mainnetTransaction: sig, deposit: { tx: sig }, settle: { tx: sig, log: null } }],
    },
  };
  const html = renderEscrowPage(report, d);
  assert.ok(html.includes(`https://explorer.solana.com/tx/${sig}?cluster=devnet`));
  assert.ok(html.includes(`<td>0.1</td>`));
  assert.throws(() => renderEscrowPage(report, { ...d, demo: { ...d.demo!, runs: [{ ...d.demo!.runs[0]!, deposit: { tx: `x"><script>` } }] } }));
  assert.throws(() => renderEscrowPage(report, { ...d, demo: { ...d.demo!, runs: [{ ...d.demo!.runs[0]!, record: "../x" }] } }));
});
