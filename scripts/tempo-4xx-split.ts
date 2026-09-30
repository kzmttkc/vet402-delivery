/**
 * Read-only: the Tempo purchases in data/ (census ledger, run log, remeasure files) classified with the published
 * FAULT_RULES and with FAULT_RULES_NEXT (src/rank/classify.ts), side by side. No network, no key, no writes.
 *
 *   npx tsx scripts/tempo-4xx-split.ts            # data/ of this checkout
 *   npx tsx scripts/tempo-4xx-split.ts --data <dir>
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { classifyFailure, FAULT_RULES, FAULT_RULES_NEXT } from "../src/rank/classify.js";
import { annotateTempoInput, normalizeTempoLedger, parseTempoRunLog, tempoPlanUrls } from "../src/rank/normalize.js";
import type { Attempt } from "../src/rank/types.js";
import { normalizeRemeasure } from "../src/remeasure/normalize.js";

const ROOT = resolve(import.meta.dirname, "..");
const i = process.argv.indexOf("--data");
const DATA = resolve(i > 0 ? process.argv[i + 1]! : join(ROOT, "data"));
const manifest = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8")) as { files: { label: string; path: string; sha256: string; loggedAt?: string }[] };
const entry = (label: string) => manifest.files.find((f) => f.label === label) ?? (() => { throw new Error(`no ${label} in manifest`); })();
function read(label: string): string {
  const e = entry(label);
  const text = readFileSync(join(DATA, e.path), "utf8");
  const got = createHash("sha256").update(text).digest("hex");
  if (got !== e.sha256) throw new Error(`${e.path}: sha256 ${got} != manifest ${e.sha256}`);
  return text;
}

const planLabel = manifest.files.map((f) => f.label).filter((l) => /^tempo\/census-plan-/.test(l)).sort().at(-1)!;
const plan = JSON.parse(read(planLabel));
let attempts: Attempt[] = [
  ...normalizeTempoLedger(JSON.parse(read("tempo/ledger")), "tempo/ledger"),
  ...parseTempoRunLog(read("tempo/run-log"), tempoPlanUrls(plan, "tempo/plan"), entry("tempo/run-log").loggedAt!, "tempo/run-log"),
];
for (const l of manifest.files.map((f) => f.label).filter((l) => /^remeasure\/tempo-\d{4}-\d{2}-\d{2}$/.test(l)).sort()) {
  attempts.push(...normalizeRemeasure(JSON.parse(read(l)), l));
}
attempts = annotateTempoInput(attempts, plan, "tempo/plan");

type Row = { source: string; tried: number; delivered: number; bodyChecked: number; before: Record<string, number>; after: Record<string, number> };
const bySource = new Map<string, Row>();
const moved: string[] = [];
const stay: string[] = [];
const sellerSideWithPlaceholder: string[] = [];
for (const a of attempts) {
  const src = a.source.startsWith("tempo/run-log") ? "tempo/run-log" : a.source;
  const r = bySource.get(src) ?? { source: src, tried: 0, delivered: 0, bodyChecked: 0, before: {}, after: {} };
  bySource.set(src, r);
  if (!a.tried) continue;
  r.tried++;
  if (a.bodyChecked) r.bodyChecked++;
  if (a.delivered) {
    r.delivered++;
    continue;
  }
  const b = classifyFailure(a);
  const n = classifyFailure(a, FAULT_RULES_NEXT);
  const kb = `${b.fault}/${b.rule}`;
  const kn = `${n.fault}/${n.rule}`;
  r.before[kb] = (r.before[kb] ?? 0) + 1;
  r.after[kn] = (r.after[kn] ?? 0) + 1;
  const line = `${src} ${a.service} http ${a.httpStatus} input ${a.inputProblem ?? "-"}`;
  if (kb !== kn) moved.push(line);
  else if (n.rule === "paid_then_4xx") stay.push(line);
  if (b.fault === "seller" && a.inputProblem) sellerSideWithPlaceholder.push(`${line} (${b.rule})`);
}

const rules = FAULT_RULES_NEXT.map((r) => r.id);
console.log(`rules published: ${FAULT_RULES.length}, next: ${FAULT_RULES_NEXT.length}`);
for (const r of [...bySource.values()].sort((x, y) => (x.source < y.source ? -1 : 1))) {
  console.log(`\n${r.source}: tried ${r.tried}, delivered ${r.delivered}, body tested ${r.bodyChecked}`);
  const keys = [...new Set([...Object.keys(r.before), ...Object.keys(r.after)])].sort((x, y) => rules.indexOf(x.split("/")[1]!) - rules.indexOf(y.split("/")[1]!));
  for (const k of keys) console.log(`  ${k.padEnd(52)} before ${String(r.before[k] ?? 0).padStart(3)}  after ${String(r.after[k] ?? 0).padStart(3)}`);
}
console.log(`\nmoved to vet402's side (${moved.length}):`);
for (const l of moved) console.log(`  ${l}`);
console.log(`\nstill can't tell, paid_then_4xx (${stay.length}):`);
for (const l of stay) console.log(`  ${l}`);
console.log(`\nseller side under both lists, though the request had an input problem (${sellerSideWithPlaceholder.length}):`);
for (const l of sellerSideWithPlaceholder) console.log(`  ${l}`);
