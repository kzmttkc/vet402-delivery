/**
 * Dry run of the input repair: what the next remeasure would send instead of what it sent, and, for every past
 * purchase that did not count against a seller (vet402 / facilitator side, or can't tell), whether the repair
 * reaches it. Offline: reads data/ (sha256 checked) and src/inputs/book.json. No network, no wallet.
 *
 *   npx tsx scripts/inputs-dry-run.ts [--date YYYY-MM-DD] [--json <file>]
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OWN_HOSTS } from "../src/constants.js";
import { classifyFailure, FAULT_RULES } from "../src/rank/classify.js";
import { annotateTempoInput, normalizeBase, normalizeSolanaCensus, normalizeSolanaGate1, normalizeTempoLedger, parseTempoRunLog, tempoPlanUrls } from "../src/rank/normalize.js";
import type { Attempt } from "../src/rank/types.js";
import { normalizeRemeasure } from "../src/remeasure/normalize.js";
import { solanaFromCensus, solanaFromGate1, tempoFromLedger, type Target } from "../src/remeasure/targets.js";
import { bookKey, readBook } from "../src/inputs/book.js";
import { repairTargets, type RepairLine } from "../src/inputs/repair.js";

const ROOT = resolve(import.meta.dirname, "..");
const DATA = join(ROOT, "data");
const args = process.argv.slice(2);
const opt = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const DATE = opt("--date") ?? new Date().toISOString().slice(0, 10);
const manifest = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8")) as { files: { label: string; path: string; sha256: string; loggedAt?: string }[] };
const text = (label: string) => {
  const e = manifest.files.find((f) => f.label === label)!;
  const t = readFileSync(join(DATA, e.path), "utf8");
  if (createHash("sha256").update(t).digest("hex") !== e.sha256) throw new Error(`${e.path}: sha256 differs from the manifest`);
  return t;
};
const json = (label: string) => JSON.parse(text(label)) as unknown;
const labels = (re: RegExp) => manifest.files.map((f) => f.label).filter((l) => re.test(l)).sort();

// ---------- the repair on today's remeasure targets ----------

const targets: Target[] = [];
for (const l of labels(/^solana\/census-/)) targets.push(...solanaFromCensus(json(l), l));
for (const l of labels(/^solana\/gate1-/)) targets.push(...solanaFromGate1(json(l), l));
const plan = json("tempo/census-plan-2026-09-28") as { plan: unknown[] };
targets.push(...tempoFromLedger(json("tempo/ledger"), plan, "tempo/ledger"));
const book = readBook(join(ROOT, "src", "inputs", "book.json"), new Date(`${DATE}T12:00:00Z`));
const { lines } = repairTargets(targets, book, DATE);
const lineOf = new Map<string, RepairLine>(lines.map((l) => [bookKey(l), l]));

console.log(`REPAIR (${DATE}): ${lines.length} targets in the book of ${targets.length}`);
for (const l of lines) {
  const what = l.result === "changed" ? l.filled.map((f) => `${f.param}<-${f.rule}`).join(" ") : l.reason ? `${l.reason}${l.param ? `(${l.param})` : ""}` : "";
  console.log(`  ${l.result.padEnd(9)} ${l.chain.padEnd(6)} ${(l.service ?? new URL(l.url).host).padEnd(32)} ${what}`);
  if (l.result === "changed") console.log(`            ${l.from}\n         -> ${l.to}`);
}

// ---------- every past purchase that did not count against the seller ----------

const at: Attempt[] = [];
at.push(...normalizeSolanaCensus(json("solana/census-2026-09-28"), "solana/census-2026-09-28"));
at.push(...normalizeSolanaGate1(json("solana/gate1-2026-09-29"), "solana/gate1-2026-09-29"));
at.push(...normalizeTempoLedger(json("tempo/ledger"), "tempo/ledger"));
const logAt = manifest.files.find((f) => f.label === "tempo/run-log")!.loggedAt!;
at.push(...parseTempoRunLog(text("tempo/run-log"), tempoPlanUrls(plan, "tempo/plan"), logAt, "tempo/run-log"));
at.push(...normalizeBase(text("base/purchases"), json("base/feedback-ledger"), "base/purchases"));
for (const l of labels(/^remeasure\/(solana|tempo)-\d{4}-\d{2}-\d{2}$/)) at.push(...normalizeRemeasure(json(l), l));
const attempts = annotateTempoInput(at, plan, "tempo/plan").filter((a) => !OWN_HOSTS.some((o) => a.host === o || a.host.endsWith(`.${o}`)));

const inRemeasure = new Set(targets.map((t) => bookKey(t)));
/** What the repair does for one past failure. */
function verdict(a: Attempt, rule: string): { fix: "fixable" | "skipped" | "not_fixable"; why: string } {
  const key = bookKey({ chain: a.chain, service: a.service, url: a.url });
  const l = lineOf.get(key);
  if (!inRemeasure.has(key)) return { fix: "not_fixable", why: a.chain === "base" ? "Base: no rebuy" : "not bought again: the census payment did not settle, so remeasure never picks it" };
  if (rule === "payment_tx_rejected") return { fix: "not_fixable", why: "the facilitator rejected or could not simulate the payment: not the input (money path unchanged)" };
  if (rule === "payment_not_accepted_402" || rule === "settled_not_delivered") return { fix: "not_fixable", why: "402 after paying: not the input" };
  const status = a.httpStatus;
  if (status === 401 || status === 403) return { fix: "not_fixable", why: `${status}: authorisation on the seller's side, not the input` };
  if (!l) return { fix: "not_fixable", why: "the request carries no placeholder and its latest answer was not 400/404/422" };
  if (l.result === "changed") return { fix: "fixable", why: `input filled: ${l.filled.map((f) => `${f.param}<-${f.rule}`).join(", ")}` };
  if (l.result === "skipped") return { fix: "skipped", why: `not bought again: ${l.reason}${l.param ? ` (${l.param})` : ""}` };
  if (l.result === "kept") return { fix: "not_fixable", why: `cannot be filled: ${l.reason}${l.param ? ` (${l.param})` : ""}; bought as before` };
  return { fix: "not_fixable", why: "the request already matches the seller's spec; the 4xx is the seller's answer to it" };
}

interface Row {
  chain: string;
  /** The input label, e.g. remeasure/tempo-2026-09-30. */
  label: string;
  source: string;
  rule: string;
  fault: string;
  status: number | null;
  who: string;
  fix: string;
  why: string;
}
const rows: Row[] = [];
for (const a of attempts) {
  if (!a.tried || a.delivered || a.chain === "algorand") continue;
  const c = classifyFailure(a, FAULT_RULES);
  if (c.fault === "seller") continue;
  const v = verdict(a, c.rule);
  rows.push({ chain: a.chain, label: a.source, source: a.source.replace(/-\d{4}-\d{2}-\d{2}$/, ""), rule: c.rule, fault: c.fault, status: a.httpStatus, who: a.service ?? a.host, fix: v.fix, why: v.why });
}

const count = (f: (r: Row) => boolean) => rows.filter(f).length;
console.log(`\nPAST FAILURES not counted against the seller (Solana, Tempo, Base): ${rows.length} (vet402/facilitator ${count((r) => r.fault === "vet402_or_facilitator")}, can't tell ${count((r) => r.fault === "unknown")})`);
const groups = new Map<string, Row[]>();
for (const r of rows) {
  const k = `${r.chain} ${r.source} ${r.rule} ${r.status ?? "-"}`;
  groups.set(k, [...(groups.get(k) ?? []), r]);
}
console.log("chain  source                rule                      status  n  fixable skipped not_fixable");
for (const [k, g] of [...groups.entries()].sort()) {
  const [chain, source, rule, status] = k.split(" ");
  console.log(`${chain!.padEnd(6)} ${source!.padEnd(21)} ${rule!.padEnd(25)} ${status!.padEnd(6)} ${String(g.length).padStart(2)}  ${String(g.filter((r) => r.fix === "fixable").length).padStart(7)} ${String(g.filter((r) => r.fix === "skipped").length).padStart(7)} ${String(g.filter((r) => r.fix === "not_fixable").length).padStart(11)}`);
}
const whys = new Map<string, number>();
for (const r of rows) whys.set(`${r.fix}: ${r.why}`, (whys.get(`${r.fix}: ${r.why}`) ?? 0) + 1);
console.log("\nBY REASON");
for (const [w, n] of [...whys.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${w}`);

// One remeasure day: the newest remeasure file per chain, before and after.
console.log("\nONE REMEASURE DAY (newest file per chain): failures not counted against the seller");
for (const chain of ["solana", "tempo"] as const) {
  const newest = labels(new RegExp(`^remeasure/${chain}-\\d{4}-\\d{2}-\\d{2}$`)).pop();
  if (!newest) continue;
  const day = rows.filter((r) => r.label === newest);
  const n = (f: string) => day.filter((r) => r.fix === f).length;
  console.log(`  ${newest}: before ${day.length}; after: request filled ${n("fixable")}, not bought (skipped) ${n("skipped")}, unchanged ${n("not_fixable")}`);
}

const out = opt("--json");
if (out) writeFileSync(out, JSON.stringify({ date: DATE, repair: lines, failures: rows }, null, 2) + "\n");
