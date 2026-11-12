/**
 * Write data/evm/roots/celo.json from results/evm/anchors/celo-week-<sunday>.sent.json (status "sent").
 *
 *   npx tsx scripts/celo-roots-publish.ts --data data
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import { buildCeloRootsFile, CELO_DEPLOY_TX, celoRootsFileProblems, type CeloSentWeek } from "../src/evm/celo-roots.js";

const argv = process.argv.slice(2);
const dataDir = argv[argv.indexOf("--data") + 1];
if (!argv.includes("--data") || !dataDir) throw new Error("--data <dir>");
const anchorsDir = "results/evm/anchors";
const files = existsSync(anchorsDir) ? readdirSync(anchorsDir).filter((f) => f.startsWith("celo-week-") && f.endsWith(".sent.json")) : [];
const sent = files.map((f) => JSON.parse(readFileSync(join(anchorsDir, f), "utf8")) as CeloSentWeek).filter((s) => s.status === "sent");
const deployFile = join(anchorsDir, "deploy-celo.json");
const deploy = existsSync(deployFile) ? (JSON.parse(readFileSync(deployFile, "utf8")) as { status?: string; hash?: Hex }) : null;
const out = buildCeloRootsFile(sent, deploy?.status === "deployed" && deploy.hash ? deploy.hash : CELO_DEPLOY_TX);
const bad = celoRootsFileProblems(out);
if (bad.length) throw new Error(`celo: ${bad.join("; ")}`);
const target = join(dataDir, "evm", "roots", "celo.json");
const text = JSON.stringify(out, null, 2) + "\n";
mkdirSync(join(dataDir, "evm", "roots"), { recursive: true });
writeFileSync(target, text);
console.log(sent.length ? `celo: ${out.days.map((d) => `${d.day} n=${d.n}`).join(", ")}` : "celo: no week written yet (empty file)");
