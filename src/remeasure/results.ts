/**
 * The remeasure result files: results/remeasure/<chain>-YYYY-MM-DD.json, one per chain and UTC day.
 * A second run on the same day appends to the same file. `npm run rank` reads them (./normalize.ts).
 * Dry runs write <chain>-YYYY-MM-DD.dry-run.json, which the rank never reads.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RemeasureChain } from "./constants.js";
import { RM_NOTE, REMEASURE_CHAINS } from "./constants.js";

/** "would_pay" only appears in dry-run files; the rank refuses it. */
export type RowOutcome = "sent" | "refused" | "not_sent" | "unknown" | "would_pay";

export interface RemeasureRow {
  at: string;
  chain: RemeasureChain;
  host: string;
  service: string | null;
  url: string;
  requestUrl: string;
  /** Recipient the live 402 asked for (null when no usable 402 came back). */
  payTo: string | null;
  /** Recipient of the earlier settled payment, which this purchase was locked to. */
  expectedPayTo: string;
  outcome: RowOutcome;
  /** "sent", "pay_to_changed", or the guard's refusal word. */
  reason: string;
  detail: string | null;
  settled: boolean | null;
  delivered: boolean | null;
  httpStatus: number | null;
  /** Tempo: length of the paid answer's body. Solana: null (payOne judges the body itself, in `delivered`). */
  bodyBytes: number | null;
  tx: string | null;
  priceUsdc: string | null;
  slot: number;
}

export interface RunInfo {
  startedAt: string;
  endedAt: string | null;
  perPayTo: number;
  stopped: string | null;
}

export interface ResultFile {
  kind: "vet402-remeasure";
  version: 1;
  chain: RemeasureChain;
  date: string;
  payer: string;
  note: string;
  runs: RunInfo[];
  rows: RemeasureRow[];
}

export const RESULT_NAME = /^(solana|tempo)-(\d{4}-\d{2}-\d{2})\.json$/;

export function resultPath(dir: string, chain: RemeasureChain, date: string): string {
  return join(dir, `${chain}-${date}.json`);
}

export function readResultFile(file: string, chain: RemeasureChain, date: string, payer: string): ResultFile {
  if (!existsSync(file)) return { kind: "vet402-remeasure", version: 1, chain, date, payer, note: RM_NOTE, runs: [], rows: [] };
  const f = JSON.parse(readFileSync(file, "utf8")) as ResultFile;
  if (f.kind !== "vet402-remeasure" || f.chain !== chain || f.date !== date || !Array.isArray(f.rows) || !Array.isArray(f.runs)) {
    throw new Error(`${file} is not a ${chain} remeasure file for ${date}; refusing to append`);
  }
  if (f.payer.toLowerCase() !== payer.toLowerCase()) throw new Error(`${file} was written for another payer`);
  return f;
}

export function writeJsonAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  renameSync(tmp, file);
}

/** Result files in `dir` the rank should read: <chain>-YYYY-MM-DD.json with a date on or before `upTo`, oldest first. */
export function resultFilesUpTo(dir: string, upTo: string): { file: string; chain: RemeasureChain; date: string; name: string }[] {
  if (!existsSync(dir)) return [];
  const out: { file: string; chain: RemeasureChain; date: string; name: string }[] = [];
  for (const name of readdirSync(dir)) {
    const m = RESULT_NAME.exec(name);
    if (!m) continue;
    const chain = m[1] as RemeasureChain;
    if (!REMEASURE_CHAINS.includes(chain) || m[2]! > upTo) continue;
    out.push({ file: join(dir, name), chain, date: m[2]!, name });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.chain < b.chain ? -1 : 1));
}
