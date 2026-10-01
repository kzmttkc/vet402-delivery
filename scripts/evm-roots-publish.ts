/**
 * Write data/evm/roots/<lane>.json (src/evm/roots.ts buildRootsFile) from the days scripts/evm-anchor.ts has
 * written: results/evm/anchors/<lane>-<day>.sent.json with status "sent", and the deployment of DeliveryRoots
 * (results/evm/anchors/deploy-<lane>.json). Only the leaves kept in each sent file are published (facts only, so
 * they always match the root on chain). Each leaf is judged now, with today's rules, from the lane's current
 * readings (results/evm/<lane>-purchases.jsonl, -reverify.jsonl, -chaincheck.jsonl), and nothing is shown that the
 * lane page (<data>/evm/<lane>.json) withholds: run it after scripts/evm-publish.ts (the daily records run does
 * both, in that order). When the readings are newer than the lane page, a purchase today's rules would show stays
 * withheld until the page shows it too; the count is printed. A lane with no written day gets no file.
 *
 *   npx tsx scripts/evm-roots-publish.ts --data data
 *   npx tsx scripts/evm-roots-publish.ts --data data --check     exit 10 when a file would change (nothing written)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import { notifiedSellers, type NotifiedFile } from "../src/receipt/publish.js";
import { buildRootsFile, laneReadings, leafIsPublic, pageWithholds, rootsFileProblems, ROOTS_LANES, verdictsOf, leafKey, type SentDay } from "../src/evm/roots.js";
import type { LanePublic } from "../src/evm/site.js";

const argv = process.argv.slice(2);
const dataDir = argv[argv.indexOf("--data") + 1];
if (!argv.includes("--data") || !dataDir) throw new Error("--data <dir>");
const check = argv.includes("--check");
const anchorsDir = "results/evm/anchors";
const notified = notifiedSellers(JSON.parse(readFileSync(join(dataDir, "records", "notified.json"), "utf8")) as NotifiedFile);
let changed = 0;
for (const lane of ROOTS_LANES) {
  const files = existsSync(anchorsDir) ? readdirSync(anchorsDir).filter((f) => f.startsWith(`${lane}-`) && f.endsWith(".sent.json")) : [];
  const sent = files.map((f) => JSON.parse(readFileSync(join(anchorsDir, f), "utf8")) as SentDay).filter((s) => s.status === "sent");
  if (sent.length === 0) {
    console.log(`${lane}: no day written yet`);
    continue;
  }
  const readings = laneReadings(
    lane,
    ["purchases", "reverify", "chaincheck"].map((k) => `results/evm/${lane}-${k}.jsonl`).map((f) => (existsSync(f) ? readFileSync(f, "utf8") : "")),
  );
  const verdicts = verdictsOf(lane, readings);
  const deployFile = join(anchorsDir, `deploy-${lane}.json`);
  const deploy = existsSync(deployFile) ? (JSON.parse(readFileSync(deployFile, "utf8")) as { status?: string; hash?: Hex }) : null;
  // The lane page as it will be published next to this file: without one, nothing is shown.
  const pageFile = join(dataDir, "evm", `${lane}.json`);
  if (!existsSync(pageFile)) throw new Error(`${pageFile} is missing: run scripts/evm-publish.ts --lane ${lane} first`);
  const page = pageWithholds(JSON.parse(readFileSync(pageFile, "utf8")) as LanePublic);
  const out = buildRootsFile(lane, sent, deploy?.status === "deployed" && deploy.hash ? deploy.hash : null, notified, verdicts, page);
  const heldForPage = sent.flatMap((s) => s.leaves).filter((l) => leafIsPublic(l, verdicts.get(leafKey(l)) ?? null, notified, { payTos: new Set(), resources: new Set() }) && !leafIsPublic(l, verdicts.get(leafKey(l)) ?? null, notified, page)).length;
  if (heldForPage) console.log(`${lane}: ${heldForPage} purchase(s) today's rules would show stay withheld because data/evm/${lane}.json withholds them (run scripts/evm-publish.ts --lane ${lane}, then this)`);
  const bad = rootsFileProblems(out, lane, notified, { verdicts, page });
  if (bad.length) throw new Error(`${lane}: ${bad.join("; ")}`);
  const target = join(dataDir, "evm", "roots", `${lane}.json`);
  const text = JSON.stringify(out, null, 2) + "\n";
  if (existsSync(target) && readFileSync(target, "utf8") === text) {
    console.log(`${lane}: unchanged`);
    continue;
  }
  changed++;
  if (check) {
    console.log(`${lane}: would change`);
    continue;
  }
  mkdirSync(join(dataDir, "evm", "roots"), { recursive: true });
  writeFileSync(target, text);
  console.log(`${lane}: ${out.days.map((d) => `${d.day} n=${d.n} published=${d.published}`).join(", ")}`);
}
if (check && changed) process.exitCode = 10;
