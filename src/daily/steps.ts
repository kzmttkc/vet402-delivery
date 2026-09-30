/**
 * The decisions scripts/daily/run.sh hands to code, so each one is tested:
 *  - planVerdict: pay or not, from a remeasure dry run (caps, month left, payer balance)
 *  - runOutcome: did the --pay run that just ended finish without a stop
 *  - updateManifest: data/manifest.json after a remeasure file is copied into data/
 *  - commitMessage: the data commit's subject line, from the files it adds
 * Reads files, decides, writes nothing on its own. No key, no network.
 */
import type { Redaction } from "./secret-gate.js";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** "2.285000" -> 2285000n (6 decimals, as the dry-run files write amounts). */
export function toAtomic(s: unknown): bigint {
  if (typeof s !== "string" || !/^\d+(?:\.\d{1,6})?$/.test(s)) throw new Error(`not an amount: ${JSON.stringify(s)}`);
  const [w, f = ""] = s.split(".");
  return BigInt(w!) * 1_000_000n + BigInt(f.padEnd(6, "0"));
}
const fmt = (a: bigint) => `${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, "0")}`;

/** Fee reserve per Tempo purchase, counted even when the live 402 would be sponsored (src/tempo/constants.ts). */
export const TEMPO_FEE_RESERVE_ATOMIC = 2_000n;

export type PlanVerdict = { pay: true; line: string } | { pay: false; stop: false; line: string } | { pay: false; stop: true; line: string };

interface DryRunFile {
  kind?: string;
  chain?: string;
  createdAt?: string;
  perPayTo?: number;
  caps?: { perRun?: string; monthLeft?: string };
  summary?: { would?: number; estimate?: string; payerUsdcBefore?: string; payerUsdcEBefore?: string };
  rows?: { key?: string; outcome?: string; priceUsdc?: string | null }[];
}

/** Keys the spend ledger already holds (Solana budget-solana-YYYY-MM.json purchases, Tempo day ledger entries). */
export function ledgerKeys(ledger: unknown): Set<string> {
  const l = (ledger ?? {}) as { purchases?: { key?: string }[]; entries?: { key?: string }[] };
  return new Set([...(l.purchases ?? []), ...(l.entries ?? [])].map((x) => x.key).filter((k): k is string => typeof k === "string"));
}

/**
 * Pay only when the dry run of the same UTC day and chain says the run fits: estimate (plus the Tempo fee
 * reserve) within the run cap, the month left and the payer balance. Nothing to buy is not a stop.
 */
export function planVerdict(plan: DryRunFile, chain: "solana" | "tempo", day: string, perPayTo: number, bought: ReadonlySet<string> = new Set()): PlanVerdict {
  const stop = (line: string): PlanVerdict => ({ pay: false, stop: true, line: `${chain}: ${line}` });
  if (plan.kind !== "vet402-remeasure-dry-run" || plan.chain !== chain) return stop("the plan is not a remeasure dry run for this chain");
  if (!DAY.test(day) || plan.createdAt?.slice(0, 10) !== day) return stop(`the plan is from ${plan.createdAt ?? "?"}, not UTC day ${day}`);
  if (plan.perPayTo !== perPayTo) return stop(`the plan is for --per-payto ${plan.perPayTo}, not ${perPayTo}`);
  // The dry run prices every slot; slots the ledger already holds are bought and are not paid again.
  if (!Array.isArray(plan.rows)) return stop("the plan has no rows");
  const toBuy = plan.rows.filter((r) => r.outcome === "would_pay" && !(typeof r.key === "string" && bought.has(r.key)));
  if (plan.rows.some((r) => r.outcome === "would_pay" && typeof r.key !== "string")) return stop("a planned purchase has no key");
  const would = toBuy.length;
  const skipped = plan.rows.filter((r) => r.outcome === "would_pay").length - would;
  if (would === 0) return { pay: false, stop: false, line: `${chain}: nothing to buy${skipped ? ` (${skipped} already in the ledger)` : ""}` };
  let est: bigint, perRun: bigint, monthLeft: bigint, balance: bigint;
  try {
    est = toBuy.reduce((a, r) => a + toAtomic(r.priceUsdc), 0n);
    perRun = toAtomic(plan.caps?.perRun);
    monthLeft = toAtomic(plan.caps?.monthLeft);
    balance = toAtomic(chain === "solana" ? plan.summary?.payerUsdcBefore : plan.summary?.payerUsdcEBefore);
  } catch (e) {
    return stop(`the plan is missing an amount (${(e as Error).message})`);
  }
  const need = chain === "tempo" ? est + BigInt(would) * TEMPO_FEE_RESERVE_ATOMIC : est;
  const what = chain === "tempo" ? `estimate ${fmt(est)} + fee reserve = ${fmt(need)}` : `estimate ${fmt(need)}`;
  if (need > perRun) return stop(`${what} is over the run cap ${fmt(perRun)}`);
  if (need > monthLeft) return stop(`${what} is over what is left this month ${fmt(monthLeft)}`);
  if (need > balance) return stop(`${what} is over the payer balance ${fmt(balance)}`);
  return { pay: true, line: `${chain}: ${would} purchases${skipped ? ` (${skipped} already in the ledger)` : ""}, ${what} within run cap ${fmt(perRun)}, month left ${fmt(monthLeft)}, balance ${fmt(balance)}` };
}

interface ResultFile {
  kind?: string;
  chain?: string;
  date?: string;
  runs?: { startedAt: string; endedAt: string | null; perPayTo: number; stopped: string | null }[];
  rows?: { outcome?: string; settled?: boolean | null; delivered?: boolean | null }[];
}

/** The --pay run that started at or after `since` (ISO): exactly one, ended, and not stopped. */
export function runOutcome(result: ResultFile, since: string): { ok: boolean; line: string } {
  const runs = (result.runs ?? []).filter((r) => r.startedAt >= since);
  if (runs.length !== 1) return { ok: false, line: `expected one run started at or after ${since}, found ${runs.length}` };
  const r = runs[0]!;
  if (!r.endedAt) return { ok: false, line: `the run started ${r.startedAt} has no end (killed or still running)` };
  if (r.stopped) return { ok: false, line: `the run stopped: ${r.stopped}` };
  return { ok: true, line: `run ${r.startedAt}..${r.endedAt} ended without a stop; ${tally(result)}` };
}

export function tally(result: ResultFile): string {
  const rows = result.rows ?? [];
  const paid = rows.filter((x) => x.outcome === "sent").length;
  const settled = rows.filter((x) => x.settled === true).length;
  const delivered = rows.filter((x) => x.delivered === true).length;
  return `${rows.length} rows: ${paid} paid, ${settled} settled, ${delivered} delivered`;
}

interface ManifestEntry {
  label: string;
  path: string;
  sha256: string;
  source?: string;
  note?: string;
  [k: string]: unknown;
}
interface Manifest {
  kind: string;
  date: string;
  files: ManifestEntry[];
  redactions?: string[];
  [k: string]: unknown;
}

/** "rows[4].detail and rows[192].detail: ..." in the wording data/manifest.json already uses. */
export function redactionNote(path: string, redactions: readonly Redaction[]): string | null {
  if (redactions.length === 0) return null;
  const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
  const tokens = redactions.filter((r) => r.what === "seller-token").map((r) => r.path);
  const parts: string[] = [];
  if (tokens.length) parts.push(`${list(tokens)}: an auth token a seller returned to vet402 is replaced with [redacted]`);
  const addresses = redactions.filter((r) => r.what === "postal-address").map((r) => r.path);
  if (addresses.length) parts.push(`${list(addresses)}: a street address (a seller's example input, or an answer that repeats it) is replaced with [redacted]`);
  if (redactions.some((r) => r.what === "local-path")) parts.push("local runner paths are shortened to ~/");
  return `${path} ${parts.join("; ")}`;
}

/**
 * Add or refresh one remeasure input. An unchanged file (same sha256) changes nothing. The manifest date
 * moves to the newest day, and that day gets a cdp/discovery-<day> label on the latest CDP fetch, as the
 * 2026-09-29 report did, since `npm run rank -- --data data` reads cdp/discovery-<manifest date>.
 */
export function updateManifest(
  text: string,
  add: { label: string; path: string; sha256: string; source: string; day: string; redactions: readonly Redaction[] },
): { text: string; changed: boolean } {
  const m = JSON.parse(text) as Manifest;
  if (m.kind !== "vet402-rank-inputs") throw new Error("not data/manifest.json");
  if (!DAY.test(add.day)) throw new Error(`bad day ${add.day}`);
  if (!/^remeasure\/(solana|tempo)-\d{4}-\d{2}-\d{2}$/.test(add.label) || add.path !== `${add.label}.json`) throw new Error(`not a remeasure label: ${add.label}`);
  const old = m.files.find((f) => f.label === add.label);
  if (old && old.sha256 === add.sha256 && old.path === add.path) return { text, changed: false };
  if (old) old.sha256 = add.sha256;
  else m.files.push({ label: add.label, path: add.path, sha256: add.sha256, source: add.source });
  // Notes on this file start "<path> rows[..]..." or "<path>: ..."; the new copy's note replaces them.
  const notes = (m.redactions ?? []).filter((n) => !n.startsWith(`${add.path} `) && !n.startsWith(`${add.path}:`));
  const note = redactionNote(add.path, add.redactions);
  if (note) notes.push(note);
  if (notes.length || m.redactions) m.redactions = notes;
  if (add.day > m.date) {
    m.date = add.day;
    const label = `cdp/discovery-${add.day}`;
    if (!m.files.some((f) => f.label === label)) {
      const fetches = m.files.filter((f) => /^cdp\/discovery-\d{4}-\d{2}-\d{2}$/.test(f.label) && f.path === `${f.label}.json`).sort((a, b) => (a.label < b.label ? -1 : 1));
      const base = fetches[fetches.length - 1];
      if (!base) throw new Error("data/manifest.json has no CDP discovery fetch to reuse");
      const fetchDay = base.label.slice(-10);
      m.files.push({
        label,
        path: base.path,
        sha256: base.sha256,
        source: base.source ?? "",
        note: `${base.note ? `${base.note} ` : ""}Used for the ${add.day} report as well: the catalog comparison still uses the ${fetchDay} fetch.`,
      });
    }
  }
  return { text: JSON.stringify(m, null, 2) + "\n", changed: true };
}

/** The data commit's subject: what the day's remeasure files hold. */
export function commitMessage(day: string, files: { chain: "solana" | "tempo"; result: ResultFile; redacted: boolean }[]): string {
  const name = { solana: "Solana", tempo: "Tempo" } as const;
  const parts = files.map((f) => `${name[f.chain]} (${tally(f.result)})`);
  const red = files.some((f) => f.redacted) ? "; a seller-issued token redacted" : "";
  return `data: ${day} remeasure on ${parts.join(" and ")}${red}`;
}
