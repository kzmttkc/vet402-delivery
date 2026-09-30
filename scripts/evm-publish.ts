/**
 * Write data/evm/<lane>.json (the Robinhood Chain / Arbitrum pages' input) from the lane's own output:
 * results/evm/<lane>-dryrun.json (the census read without paying) and, when vet402 has paid,
 * results/evm/<lane>-purchases.jsonl (+ results/evm/base-compare-purchases.jsonl for arbitrum).
 *
 *   npx tsx scripts/evm-publish.ts --lane robinhood
 *   npx tsx scripts/build-site.ts --out site
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildLanePublic, withholdUnnotified } from "../src/evm/site.js";
import { notifiedSellers, type NotifiedFile } from "../src/receipt/publish.js";
import { classifyRecord } from "../src/evm/settle-cause.js";
import { compareStockAnswer } from "../src/robinhood/stock-check.js";

const argv = process.argv.slice(2);
const lane = argv[argv.indexOf("--lane") + 1];
if (lane !== "robinhood" && lane !== "arbitrum") throw new Error("--lane robinhood | arbitrum");
const dry = JSON.parse(readFileSync(`results/evm/${lane}-dryrun.json`, "utf8")) as Record<string, unknown>;
const files = lane === "arbitrum" ? ["results/evm/arbitrum-purchases.jsonl", "results/evm/base-compare-purchases.jsonl"] : ["results/evm/robinhood-purchases.jsonl"];
const raw = files.flatMap((f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : []));
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
const notified = notifiedSellers(JSON.parse(readFileSync("data/records/notified.json", "utf8")) as NotifiedFile);
const out = withholdUnnotified(buildLanePublic(lane, dry, paid), notified);
mkdirSync("data/evm", { recursive: true });
writeFileSync(`data/evm/${lane}.json`, JSON.stringify(out, null, 2) + "\n");
console.log(`data/evm/${lane}.json: ${out.source}, ${out.payTosInCatalogs} payTos in catalogs, ${out.payTosOffered} offered, ${out.rows.length} rows${out.stock ? `, ${out.stock.length} stock references` : ""}`);
