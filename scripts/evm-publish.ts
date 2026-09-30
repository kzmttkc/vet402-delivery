/**
 * Write data/evm/<lane>.json (the Robinhood Chain / Arbitrum pages' input) from the lane's own output:
 * results/evm/<lane>-dryrun.json (the census read without paying) and, when vet402 has paid,
 * results/evm/<lane>-purchases.jsonl (+ results/evm/base-compare-purchases.jsonl for arbitrum).
 *
 *   npx tsx scripts/evm-publish.ts --lane robinhood
 *   npx tsx scripts/build-site.ts --out site
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildLanePublic } from "../src/evm/site.js";

const argv = process.argv.slice(2);
const lane = argv[argv.indexOf("--lane") + 1];
if (lane !== "robinhood" && lane !== "arbitrum") throw new Error("--lane robinhood | arbitrum");
const dry = JSON.parse(readFileSync(`results/evm/${lane}-dryrun.json`, "utf8")) as Record<string, unknown>;
const files = lane === "arbitrum" ? ["results/evm/arbitrum-purchases.jsonl", "results/evm/base-compare-purchases.jsonl"] : ["results/evm/robinhood-purchases.jsonl"];
const paid = files.flatMap((f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : []));
const out = buildLanePublic(lane, dry, paid);
mkdirSync("data/evm", { recursive: true });
writeFileSync(`data/evm/${lane}.json`, JSON.stringify(out, null, 2) + "\n");
console.log(`data/evm/${lane}.json: ${out.source}, ${out.payTosInCatalogs} payTos in catalogs, ${out.payTosOffered} offered, ${out.rows.length} rows${out.stock ? `, ${out.stock.length} stock references` : ""}`);
