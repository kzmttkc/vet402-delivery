/**
 * Write data/evm/<lane>.json (the Robinhood Chain / Arbitrum pages' input) from the lane's own output:
 * results/evm/<lane>-dryrun.json (the census read without paying) and, when vet402 has paid,
 * results/evm/<lane>-purchases.jsonl (+ results/evm/base-compare-purchases.jsonl for arbitrum), each read
 * against the chain by scripts/evm-chaincheck.ts (results/evm/<lane>-chaincheck.jsonl).
 *
 *   npx tsx scripts/evm-publish.ts --lane robinhood
 *   npx tsx scripts/evm-publish.ts --lane robinhood --data <dir>   read notified.json from and write into <dir>
 *                                                                   (the daily records run: results/ from the
 *                                                                   checkout, data/ in the publish worktree)
 *   npx tsx scripts/build-site.ts --out site
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { buildLanePublic, withholdUnnotified } from "../src/evm/site.js";
import { uncheckedPurchases } from "../src/evm/chaincheck.js";
import type { ChainBuyRecord } from "../src/evm/evm-buy.js";
import { loadLaneRecordsChecked } from "../src/evm/lane-records.js";
import { notifiedSellers, type NotifiedFile } from "../src/receipt/publish.js";
import { classifyRecord } from "../src/evm/settle-cause.js";
import { compareStockAnswer } from "../src/robinhood/stock-check.js";

const argv = process.argv.slice(2);
const lane = argv[argv.indexOf("--lane") + 1];
if (lane !== "robinhood" && lane !== "arbitrum") throw new Error("--lane robinhood | arbitrum");
const dataDir = argv.includes("--data") ? argv[argv.indexOf("--data") + 1] : "data";
if (!dataDir || dataDir.startsWith("--")) throw new Error("--data <dir>");
// The plan of the paying run when there is one (it re-plans from live 402s), else the dry run's.
const planFile = existsSync(`results/evm/${lane}-paid-run.json`) ? `results/evm/${lane}-paid-run.json` : `results/evm/${lane}-dryrun.json`;
const dry = JSON.parse(readFileSync(planFile, "utf8")) as Record<string, unknown>;
console.error(`plan: ${planFile}`);
// Each lane's purchases, its re-read settlements (scripts/evm-reverify.ts) and the chain check
// (scripts/evm-chaincheck.ts), one record per purchase (a later reading replaces the earlier), with rule 0's
// material (results/evm/declared-inputs.jsonl, tracked) filled where a record lacks it: src/evm/lane-records.ts.
const lanes = lane === "arbitrum" ? ["arbitrum", "base-compare"] : ["robinhood"];
const loaded = loadLaneRecordsChecked(lanes);
const raw = loaded.rows as (ChainBuyRecord & { lane: string } & Record<string, any>)[];
// A line that does not parse is skipped, never fatal: said on stderr with its file and line, and the run ends with
// exit code 3 (the page is written; 1 stays "nothing written"). A purchase whose rule 0 material was on such a line
// is withheld (materialLost), never read as the seller's.
for (const p of loaded.problems) console.error(`ALERT ${p.file}:${p.line}: not JSON, skipped (${p.error})`);
const lost = raw.filter((r) => r.materialLost).length;
if (lost) console.error(`ALERT ${lost} purchase(s) withheld: their rule 0 material was on a line that did not parse`);
// Settled is the chain's word, not the seller's header: every sent purchase must have been read by the chain check.
const unchecked = uncheckedPurchases(raw);
if (unchecked.length) throw new Error(`${unchecked.length} sent purchase(s) without a chain check; run npx tsx scripts/evm-chaincheck.ts --lane <lane> first: ${unchecked.slice(0, 5).join("; ")}`);
// Causes and stock verdicts are decided again here with today's rules, not taken from the run's own file:
// a rule change (for instance what counts as the seller's fault) must reach every row before it is published.
const paid = raw.map((r) => {
  const cause = classifyRecord(r, { facilitator: r.facilitator ?? null, problem: r.predictedProblem ?? null });
  const ticker = typeof r.agentId === "string" && r.agentId.startsWith("stock:") ? r.agentId.slice(6) : null;
  const ref = r.stock?.reference;
  const stock = ticker && ref && r.delivered && typeof r.body === "string" ? { ...compareStockAnswer(ticker, r.body, ref, r.at), reference: ref } : r.stock;
  return { ...r, cause, ...(stock !== undefined ? { stock } : {}) };
});
// Negative results only for sellers vet402 has told (data/records/notified.json), as for the delivery records.
const notified = notifiedSellers(JSON.parse(readFileSync(`${dataDir}/records/notified.json`, "utf8")) as NotifiedFile);
const out = withholdUnnotified(buildLanePublic(lane, dry, paid), notified);
mkdirSync(`${dataDir}/evm`, { recursive: true });
writeFileSync(`${dataDir}/evm/${lane}.json`, JSON.stringify(out, null, 2) + "\n");
console.log(`${dataDir}/evm/${lane}.json: ${out.source}, ${out.payTosInCatalogs} payTos in catalogs, ${out.payTosOffered} offered, ${out.rows.length} rows${out.stock ? `, ${out.stock.length} stock references` : ""}`);
// The daily run (scripts/daily/run.sh) says this sentence when the exit code is 3: the facts, from this run.
const alertFile = `results/evm/${lane}-publish-alert.txt`;
if (loaded.problems.length) {
  const where = [...new Set(loaded.problems.map((p) => `${p.file}:${p.line}`))].join(", ");
  writeFileSync(alertFile, `wrote ${dataDir}/evm/${lane}.json with ${lost} purchase(s) withheld: unreadable line(s) in ${where}\n`);
  process.exitCode = 3;
} else if (existsSync(alertFile)) rmSync(alertFile);
