/**
 * Rebuild the test fixtures from the public data (network needed; the tests themselves never use it):
 *
 *   npx tsx packages/check/test/make-fixtures.ts
 *
 * Writes packages/check/test/fixtures/: a small rank.json and records index cut from the public ones
 * (a few sellers, fields as published), two signed records byte for byte, and the Solana RPC answers
 * their verification reads (payment tx and anchor memo tx).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_RPC } from "../../../src/receipt/chain.js";
import { jsonRpc } from "../../../src/chain.js";
import { RANK_URL, RECORDS_BASE_URL, RECORDS_INDEX_URL } from "../src/sources.js";

const OUT = join(import.meta.dirname, "fixtures");
const SELLERS = ["api.xona-agent.com", "agent402.tools", "midax402.com", "mpp.orthogonal.com#orth-andi", "mpp.orthogonal.com#orth-aviato"];
const RECORDS = ["obs_2026-09-28_000164"]; // XONA, NOT_DELIVERED; one DELIVERED agent402.tools Solana record is added below

async function get(url: string): Promise<string> {
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.text();
}

type Obj = Record<string, any>;
const rank = JSON.parse(await get(RANK_URL)) as Obj;
const index = JSON.parse(await get(RECORDS_INDEX_URL)) as Obj;

const small: Obj = {
  kind: rank.kind,
  date: rank.date,
  generatedAt: rank.generatedAt,
  method: { version: rank.method.version, faultRules: rank.method.faultRules, grades: rank.method.grades },
  groups: rank.groups.map((g: Obj) => ({ id: g.id, label: g.label, chains: g.chains, page: g.page, ranking: g.ranking.filter((s: Obj) => SELLERS.includes(s.key)) })),
};
const recs = index.records.filter((r: Obj) => SELLERS.includes(r.seller));
const delivered = recs.find((r: Obj) => r.seller === "agent402.tools" && r.verdict === "DELIVERED" && String(r.network).startsWith("solana:"));
if (!delivered) throw new Error("no DELIVERED Solana record of agent402.tools");
const ids = [...RECORDS, delivered.id as string];
const smallIndex = { ...index, records: recs };

mkdirSync(join(OUT, "records"), { recursive: true });
writeFileSync(join(OUT, "rank.json"), `${JSON.stringify(small, null, 2)}\n`);
writeFileSync(join(OUT, "records-index.json"), `${JSON.stringify(smallIndex, null, 2)}\n`);

const rpc = jsonRpc(DEFAULT_RPC["solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]!);
const answers: Obj = {};
for (const id of ids) {
  const text = await get(`${RECORDS_BASE_URL}/${id}.json`);
  writeFileSync(join(OUT, "records", `${id}.json`), text); // byte for byte: the index sha256 covers these bytes
  const o = JSON.parse(text) as Obj;
  for (const sig of [o.payment.transaction, o.anchor?.tx].filter(Boolean)) {
    if (answers[`getTransaction ${sig}`]) continue;
    answers[`getTransaction ${sig}`] = await rpc("getTransaction", [sig, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
  }
}
writeFileSync(join(OUT, "solana-rpc.json"), `${JSON.stringify(answers, null, 2)}\n`);
console.log(`fixtures: ${SELLERS.length} sellers, ${recs.length} index entries, records ${ids.join(", ")}, ${Object.keys(answers).length} RPC answers`);
