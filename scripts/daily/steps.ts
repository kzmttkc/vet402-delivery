/**
 * Decisions for scripts/daily/run.sh (src/daily/steps.ts). No key, no network, no payment.
 *
 *   npx tsx scripts/daily/steps.ts check-plan <dry-run.json> --chain solana|tempo --day YYYY-MM-DD --per-payto N [--ledger <file>]
 *       the estimate leaves out slots the spend ledger already holds (bought earlier that day)
 *       exit 0 pay, 10 nothing to buy, 4 stop (over a cap, the month, the balance, or not today's plan)
 *   npx tsx scripts/daily/steps.ts run-outcome <result.json> --since <ISO time>
 *       exit 0 when exactly one run started since then and ended without a stop, else 4
 *   npx tsx scripts/daily/steps.ts manifest <data dir> --file remeasure/<chain>-<day>.json --day <day> --redactions <json>
 *       updates <data dir>/manifest.json for that copy (sha256 read from the file); prints changed|unchanged
 *   npx tsx scripts/daily/steps.ts message <data dir> --day <day> --redacted solana,tempo
 *       prints the data commit subject for that day's remeasure copies in <data dir>
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitMessage, ledgerKeys, planVerdict, runOutcome, updateManifest } from "../../src/daily/steps.js";
import type { Redaction } from "../../src/daily/secret-gate.js";

const args = process.argv.slice(2);
const cmd = args.shift();
const opt = (n: string): string | undefined => {
  const i = args.indexOf(n);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) usage(`${n} needs a value`);
  args.splice(i, 2);
  return v;
};
function usage(msg: string): never {
  console.error(`${msg}\nusage: steps.ts check-plan|run-outcome|manifest|message ... (see the file header)`);
  process.exit(2);
}
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

if (cmd === "check-plan") {
  const chain = opt("--chain");
  const day = opt("--day");
  const per = Number(opt("--per-payto"));
  const ledger = opt("--ledger");
  const [file] = args;
  if ((chain !== "solana" && chain !== "tempo") || !day || !file || !Number.isInteger(per)) usage("check-plan needs <file> --chain --day --per-payto");
  const v = planVerdict(readJson(file), chain, day, per, ledger && existsSync(ledger) ? ledgerKeys(readJson(ledger)) : new Set());
  console.log(v.line);
  process.exit(v.pay ? 0 : v.stop ? 4 : 10);
} else if (cmd === "run-outcome") {
  const since = opt("--since");
  const [file] = args;
  if (!since || !file) usage("run-outcome needs <file> --since");
  if (!existsSync(file)) {
    console.log(`no result file ${file}`);
    process.exit(4);
  }
  const v = runOutcome(readJson(file), since);
  console.log(v.line);
  process.exit(v.ok ? 0 : 4);
} else if (cmd === "manifest") {
  const file = opt("--file");
  const day = opt("--day");
  const reds = JSON.parse(opt("--redactions") ?? "[]") as Redaction[];
  const [dataDir] = args;
  if (!file || !day || !dataDir) usage("manifest needs <data dir> --file --day");
  const label = file.replace(/\.json$/, "");
  const sha = createHash("sha256").update(readFileSync(join(dataDir, file), "utf8")).digest("hex");
  const mpath = join(dataDir, "manifest.json");
  const r = updateManifest(readFileSync(mpath, "utf8"), { label, path: file, sha256: sha, source: `~/vet402-solana/results/${file}`, day, redactions: reds });
  if (r.changed) {
    writeFileSync(`${mpath}.tmp`, r.text);
    renameSync(`${mpath}.tmp`, mpath);
  }
  console.log(r.changed ? "changed" : "unchanged");
} else if (cmd === "message") {
  const day = opt("--day");
  const redacted = (opt("--redacted") ?? "").split(",").filter(Boolean);
  const [dataDir] = args;
  if (!day || !dataDir) usage("message needs <data dir> --day");
  const files = (["solana", "tempo"] as const)
    .filter((c) => existsSync(join(dataDir, "remeasure", `${c}-${day}.json`)))
    .map((c) => ({ chain: c, result: readJson(join(dataDir, "remeasure", `${c}-${day}.json`)), redacted: redacted.includes(c) }));
  if (!files.length) usage(`no remeasure copy for ${day} in ${dataDir}`);
  console.log(commitMessage(day, files));
} else {
  usage("unknown command");
}
