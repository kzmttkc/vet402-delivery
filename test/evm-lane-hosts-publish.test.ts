/**
 * Acceptance tests for the host run after the first paying run (2026-11-08): a dated ledger per later run, and the
 * Robinhood Chain page showing the host run's purchases. Written before the implementation and fixed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAddress, type Hex } from "viem";
import { EVM_CHAINS, LANES } from "../src/evm/chains.js";
import type { ChainBuyRecord } from "../src/evm/evm-buy.js";
import { LEGACY_HOST_RUN_DATE, hostLedgerKey, hostRunFiles, hostRunLedgerProblem, laneCountCapForHostRun, pickHostEntries, type HostChoice } from "../src/evm/lane-hosts.js";
import { classifyRecord } from "../src/evm/settle-cause.js";
import { buildLanePublic, renderRobinhoodPage, unpublishableRows, withholdUnnotified, type LanePublic } from "../src/evm/site.js";

const RH = EVM_CHAINS.robinhood;
const A = getAddress("0x712c78928080Adb009E31315c0c3c7473dA9648a");
const B = getAddress("0xdC36D51963d08862c525045ccFD39FAe6a0C7F40");
const C = getAddress("0x50ab2018c06c6E4eAA9BA52057Eb55eD284912fc");
const TX = ("0x" + "ab".repeat(32)) as Hex;

// ---------- a dated ledger for every later run ----------

test("hostRunFiles: 2026-11-08 keeps the first run's ledger and keys; any other date gets its own ledger and dated keys", () => {
  assert.equal(LEGACY_HOST_RUN_DATE, "2026-11-08");
  const first = hostRunFiles("2026-11-08");
  assert.equal(first.ledger, "robinhood-hosts-ledger.json");
  assert.equal(first.key("Hosaka.test"), hostLedgerKey("hosaka.test"));
  const later = hostRunFiles("2026-12-20");
  assert.equal(later.ledger, "robinhood-hosts-2026-12-20-ledger.json");
  assert.equal(later.key("Hosaka.test"), "robinhood-host:hosaka.test:2026-12-20");
  for (const bad of ["", "2026-12-2", "20261220", "2026-12-20/../x", "../2026-12-20"]) assert.throws(() => hostRunFiles(bad), /date/, bad);
});

const choice = (host: string, amount: string): HostChoice =>
  ({
    host,
    listings: 1,
    tried: [],
    chosen: { resource: `https://${host}/r`, listingResource: `https://${host}/r`, method: "GET", query: null, body: null, payTo: A, amount, liveAmount: amount, raw402: "", simple: true, declaredParams: [], inputDate: "2026-12-20", datedParams: [], declaration: { declared: [], required: [], from: [], requiredFrom: [] } },
  }) as unknown as HostChoice;

test("pickHostEntries: with a run date the ledger keys carry the date; without one they stay the first run's", () => {
  const ch = [choice("a.test", "5000")];
  assert.equal(pickHostEntries(ch, { maxTotalAtomic: 60_000n, maxCount: 10 }).entries[0]!.ledgerKey, "robinhood-host:a.test");
  assert.equal(pickHostEntries(ch, { maxTotalAtomic: 60_000n, maxCount: 10, runDate: "2026-11-08" }).entries[0]!.ledgerKey, "robinhood-host:a.test");
  assert.equal(pickHostEntries(ch, { maxTotalAtomic: 60_000n, maxCount: 10, runDate: "2026-12-20" }).entries[0]!.ledgerKey, "robinhood-host:a.test:2026-12-20");
});

test("hostRunLedgerProblem: each run date is checked against its own ledger and only its own records (by inputDate)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rh-hosts-"));
  try {
    const rows = [
      { agentId: "host:a.test", outcome: "sent", inputDate: "2026-11-08" },
      { agentId: "host:b.test", outcome: "sent", inputDate: "2026-11-08" },
      { agentId: "host:a.test", outcome: "sent", inputDate: "2026-12-20" },
      { agentId: `payto:${A}`, outcome: "sent", inputDate: "2026-12-20" },
    ];
    writeFileSync(join(dir, "robinhood-purchases.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const ledger = (n: number) => JSON.stringify({ baselineAtomic: "1", spentAtomic: String(n * 5000), purchases: Array.from({ length: n }, (_, i) => ({ key: `k${i}`, amount: "5000", at: "" })) });
    writeFileSync(join(dir, "robinhood-hosts-ledger.json"), ledger(2));
    assert.equal(hostRunLedgerProblem(dir), null, "the first run: 2 sent, 2 held");
    assert.equal(hostRunLedgerProblem(dir, "2026-11-08"), null);
    assert.match(hostRunLedgerProblem(dir, "2026-12-20") ?? "", /robinhood-hosts-2026-12-20-ledger\.json does not exist/);
    writeFileSync(join(dir, "robinhood-hosts-2026-12-20-ledger.json"), ledger(1));
    assert.equal(hostRunLedgerProblem(dir, "2026-12-20"), null, "1 sent that day, 1 held; the plain lane row does not count");
    assert.equal(hostRunLedgerProblem(dir, "2027-01-05"), null, "a date with no purchases needs no ledger yet");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("laneCountCapForHostRun: the lane ledger lets a host run add its own count on top of what it already holds, never more", () => {
  assert.equal(laneCountCapForHostRun(18), 28);
  assert.equal(laneCountCapForHostRun(27), 37);
  assert.equal(laneCountCapForHostRun(0), 10);
});

// ---------- the page ----------

const rec = (over: Partial<ChainBuyRecord> & { agentId: string; resource: string; payTo: string }) => {
  const r = { method: "GET", at: "2026-11-08T01:12:00Z", outcome: "sent", amountAtomic: "5000", payer: "0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51", inputDate: "2026-11-08", settlementTx: null, settledOnChain: false, delivered: false, response: { status: 402, contentType: null, bytes: 2, first300: "{}" }, ...over } as ChainBuyRecord;
  return { ...r, lane: "robinhood", cause: classifyRecord(r) };
};
const ok = { settlementTx: TX, settledOnChain: true, delivered: true, response: { status: 200, contentType: "application/json", bytes: 9, first300: '{"ok":1}' } } as const;
const dry = { generatedAt: "2026-09-30T06:18:35Z", catalogs: {}, robinhood: { payTosInCatalogs: 2, payTosWithLive402: 2, choices: [{ payTo: A, catalogListings: 1, hosts: ["hosaka.test"], chosen: { resource: "https://hosaka.test/lookup", liveAmount: "5000" } }, { payTo: C, catalogListings: 3, hosts: ["macro.test"], chosen: { resource: "https://macro.test/x", liveAmount: "5000" } }] } };

test("buildLanePublic: a host-run purchase to a payTo outside the census gets its own row; one to a census payTo shows on that row", () => {
  const paid = [
    rec({ agentId: "host:hosaka.test", resource: "https://hosaka.test/lookup", payTo: A, ...ok }),
    rec({ agentId: "host:t0ll.test", resource: "https://t0ll.test/api/x402/fresh", payTo: B, amountAtomic: "10000", ...ok }),
    rec({ agentId: "host:macro.test", resource: "https://macro.test/x", payTo: C }),
  ];
  const l = buildLanePublic("robinhood", dry, paid);
  assert.equal(l.rows.length, 3, "two census rows and one new payTo");
  const b = l.rows.find((r) => r.payTo === B)!;
  assert.equal(b.status, "delivered");
  assert.equal(b.resource, "https://t0ll.test/api/x402/fresh");
  assert.deepEqual(b.hosts, ["t0ll.test"]);
  assert.equal(b.livePrice, "10000");
  assert.equal(b.settlementTx, TX);
  assert.equal(l.rows.find((r) => r.payTo === A)!.status, "delivered");
  assert.equal(l.rows.find((r) => r.payTo === C)!.status, "not_settled");
  assert.deepEqual(l.hostRuns, [{ date: "2026-11-08", hosts: 3 }], "only the count of hosts: per-run settle counts could name a seller vet402 has not told");
});

test("buildLanePublic: no host-run purchases, no hostRuns field and no extra rows (the page stays as it is)", () => {
  const l = buildLanePublic("robinhood", dry, [rec({ agentId: `payto:${A}`, resource: "https://hosaka.test/lookup", payTo: A, ...ok })]);
  assert.equal(l.rows.length, 2);
  assert.equal(l.hostRuns, undefined);
});

test("Robinhood page: one plain sentence per host run, dated, outside the lane cap, with the run's own cap; none without host runs", () => {
  const report = JSON.parse(readFileSync(new URL("../site/rank.json", import.meta.url), "utf8"));
  const base = buildLanePublic("robinhood", dry, [
    rec({ agentId: "host:hosaka.test", resource: "https://hosaka.test/lookup", payTo: A, ...ok }),
    rec({ agentId: "host:t0ll.test", resource: "https://t0ll.test/api/x402/fresh", payTo: B, ...ok }),
    rec({ agentId: "host:macro.test", resource: "https://macro.test/x", payTo: C }),
  ]);
  const html = renderRobinhoodPage(report, null as never, base);
  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const want = `On 2026-11-08 vet402 also bought one item from each of 3 hosts, outside the ${LANES.robinhood.maxCount}-purchase lane cap, with a cap of its own: at most 0.01 USDG a purchase and 0.06 USDG in total.`;
  assert.ok(text.includes(want), text.slice(text.indexOf("How vet402 pays"), text.indexOf("How vet402 pays") + 900));
  const sentence = want;
  assert.ok(!/\b(we|us|our)\b/i.test(sentence) && !/[—–;]/.test(sentence), "public English rules");
  assert.ok(!/payments settled/.test(text), "no settle count for the run");
  const none = renderRobinhoodPage(report, null as never, { ...base, hostRuns: undefined } as LanePublic);
  assert.ok(!none.includes("also bought one item from each of"));
  void RH;
});

// ---------- a later payment that did not settle never leaks through an older delivered row ----------

test("an unnotified seller with an older delivered purchase and a newer one that did not settle: the settled count is withheld", () => {
  const paid = [
    rec({ agentId: `payto:${A}`, resource: "https://hosaka.test/lookup", payTo: A, at: "2026-09-30T12:32:00Z", inputDate: "2026-09-30", ...ok }),
    rec({ agentId: "host:hosaka.test", resource: "https://hosaka.test/other", payTo: A }),
  ];
  const raw = buildLanePublic("robinhood", dry, paid);
  const row = raw.rows.find((r) => r.payTo === A)!;
  assert.equal(row.purchases, 2);
  assert.equal(row.settled, 1);
  assert.deepEqual(unpublishableRows(raw, new Set()).filter((x) => x.includes(A)).length, 1, "the raw lane file would stop the page build");
  const pub = withholdUnnotified(raw, new Set());
  const w = pub.rows.find((r) => r.payTo === A)!;
  assert.equal(w.settled, undefined, "no settled count next to an unnotified seller");
  assert.equal(w.purchases, undefined, "no purchase count either, so a missing settled count is no signal");
  assert.deepEqual(unpublishableRows(pub, new Set()), []);
  const html = renderRobinhoodPage(JSON.parse(readFileSync(new URL("../site/rank.json", import.meta.url), "utf8")), null as never, pub);
  assert.ok(!html.includes("2 purchases, 1 settled"));
  // A seller vet402 has told keeps the count.
  const told = withholdUnnotified(raw, new Set(["hosaka.test"])).rows.find((r) => r.payTo === A)!;
  assert.equal(told.settled, 1);
});

test("the host run writes the run date as each record's inputDate (no midnight split between ledger and records)", () => {
  const lane = readFileSync(new URL("../scripts/evm-lane.ts", import.meta.url), "utf8");
  assert.match(lane, /groupByHost\(cat\.items, rh, \{[^}]*today: runDate/);
});

test("an unnotified seller whose payments all settled shows no counts either: the absence of a count says nothing", () => {
  const paid = [
    rec({ agentId: `payto:${A}`, resource: "https://hosaka.test/lookup", payTo: A, at: "2026-09-30T12:32:00Z", inputDate: "2026-09-30", ...ok }),
    rec({ agentId: "host:hosaka.test", resource: "https://hosaka.test/lookup", payTo: A, ...ok }),
  ];
  const raw = buildLanePublic("robinhood", dry, paid);
  assert.equal(raw.rows.find((r) => r.payTo === A)!.settled, 2);
  const w = withholdUnnotified(raw, new Set()).rows.find((r) => r.payTo === A)!;
  assert.equal(w.status, "delivered");
  assert.equal(w.purchases, undefined);
  assert.equal(w.settled, undefined);
  const told = withholdUnnotified(raw, new Set(["hosaka.test"])).rows.find((r) => r.payTo === A)!;
  assert.equal(told.purchases, 2);
  assert.equal(told.settled, 2);
});
