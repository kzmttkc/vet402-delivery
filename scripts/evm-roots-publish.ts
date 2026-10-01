/**
 * Write data/evm/roots/<lane>.json (src/evm/roots.ts buildRootsFile) from the days scripts/evm-anchor.ts has
 * written: results/evm/anchors/<lane>-<day>.sent.json with status "sent", and the deployment of DeliveryRoots
 * (results/evm/anchors/deploy-<lane>.json). Only the leaves kept in each sent file are published, so a later rule
 * change never makes a published leaf differ from the root on chain. A lane with no written day gets no file.
 *
 *   npx tsx scripts/evm-roots-publish.ts --data data
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import { notifiedSellers, type NotifiedFile } from "../src/receipt/publish.js";
import { buildRootsFile, rootsFileProblems, ROOTS_LANES, type SentDay } from "../src/evm/roots.js";

const argv = process.argv.slice(2);
const dataDir = argv[argv.indexOf("--data") + 1];
if (!argv.includes("--data") || !dataDir) throw new Error("--data <dir>");
const anchorsDir = "results/evm/anchors";
const notified = notifiedSellers(JSON.parse(readFileSync(join(dataDir, "records", "notified.json"), "utf8")) as NotifiedFile);
for (const lane of ROOTS_LANES) {
  const files = existsSync(anchorsDir) ? readdirSync(anchorsDir).filter((f) => f.startsWith(`${lane}-`) && f.endsWith(".sent.json")) : [];
  const sent = files.map((f) => JSON.parse(readFileSync(join(anchorsDir, f), "utf8")) as SentDay).filter((s) => s.status === "sent");
  if (sent.length === 0) {
    console.log(`${lane}: no day written yet`);
    continue;
  }
  const deployFile = join(anchorsDir, `deploy-${lane}.json`);
  const deploy = existsSync(deployFile) ? (JSON.parse(readFileSync(deployFile, "utf8")) as { status?: string; hash?: Hex }) : null;
  const out = buildRootsFile(lane, sent, deploy?.status === "deployed" && deploy.hash ? deploy.hash : null, notified);
  const bad = rootsFileProblems(out, lane, notified);
  if (bad.length) throw new Error(`${lane}: ${bad.join("; ")}`);
  mkdirSync(join(dataDir, "evm", "roots"), { recursive: true });
  writeFileSync(join(dataDir, "evm", "roots", `${lane}.json`), JSON.stringify(out, null, 2) + "\n");
  console.log(`${lane}: ${out.days.map((d) => `${d.day} n=${d.n} published=${d.published}`).join(", ")}`);
}
