/**
 * Cut the verdict fixtures from this repository's published data (no network):
 *
 *   npx tsx packages/check/test/make-verdict-fixtures.ts
 *
 * Reads site/rank.json and data/records/index.json (the files api/check.ts bundles) and writes
 * fixtures/verdict-rank.json and fixtures/verdict-records-index.json with only the sellers below, fields
 * as published. Cut on 2026-10-01 from rank.json of that day:
 *   api.xona-agent.com             paid 6 times on Solana over 4 days, 0 answered (HTTP 500)
 *   brasil-dados-api.onrender.com  paid 6 times on Solana over 4 days, 6 answered
 *   agents.datamancer.io           paid 6 times, 2 answered, 4 failures of cause unknown (404 after paying)
 *   api.exa.ai                     Tempo, 4 of 4 over 4 days
 *   scvd.store                     Solana and Base on the first page, and Arbitrum (data/evm)
 *   algorandtracker.com            the Algorand page, grade A
 *   api.nativebtc.org              Arbitrum only, one purchase, came back
 *   x402.quickintel.io             Arbitrum only, result held until the seller is told
 * and fixtures/verdict-lane-<lane>.json: data/evm/arbitrum.json and robinhood.json with only those hosts' rows.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const OUT = join(import.meta.dirname, "fixtures");
export const VERDICT_SELLERS = ["api.xona-agent.com", "brasil-dados-api.onrender.com", "agents.datamancer.io", "api.exa.ai", "scvd.store", "algorandtracker.com"];
const LANE_HOSTS = ["scvd.store", "api.nativebtc.org", "x402.quickintel.io"];

type Obj = Record<string, any>;
const rank = JSON.parse(readFileSync(join(ROOT, "site", "rank.json"), "utf8")) as Obj;
const index = JSON.parse(readFileSync(join(ROOT, "data", "records", "index.json"), "utf8")) as Obj;

const small: Obj = {
  kind: rank.kind,
  date: rank.date,
  generatedAt: rank.generatedAt,
  method: { version: rank.method.version, faultRules: rank.method.faultRules, grades: rank.method.grades, minCounted: rank.method.minCounted, minDays: rank.method.minDays },
  groups: rank.groups.map((g: Obj) => ({ id: g.id, label: g.label, chains: g.chains, page: g.page, ranking: g.ranking.filter((s: Obj) => VERDICT_SELLERS.includes(s.key)) })),
};
const recs = index.records.filter((r: Obj) => VERDICT_SELLERS.includes(r.seller));
const days = new Set(recs.map((r: Obj) => r.day));
const smallIndex = { ...index, records: recs, days: index.days.filter((d: Obj) => days.has(d.day)) };

const hostOf = (u: string | null): string | null => {
  try {
    return u ? new URL(u).hostname : null;
  } catch {
    return null;
  }
};
const lanes = ["arbitrum", "robinhood"].map((l) => {
  const j = JSON.parse(readFileSync(join(ROOT, "data", "evm", `${l}.json`), "utf8")) as Obj;
  return { kind: j.kind, lane: j.lane, chain: j.chain, generatedAt: j.generatedAt, source: j.source, rows: j.rows.filter((r: Obj) => LANE_HOSTS.includes(hostOf(r.resource) ?? "")) };
});

for (const l of lanes) writeFileSync(join(OUT, `verdict-lane-${l.lane}.json`), `${JSON.stringify(l, null, 2)}\n`);
writeFileSync(join(OUT, "verdict-rank.json"), `${JSON.stringify(small, null, 2)}\n`);
writeFileSync(join(OUT, "verdict-records-index.json"), `${JSON.stringify(smallIndex, null, 2)}\n`);
console.log(`verdict fixtures: rank.json ${rank.date}, ${small.groups.reduce((n: number, g: Obj) => n + g.ranking.length, 0)} sellers, ${recs.length} records`);
