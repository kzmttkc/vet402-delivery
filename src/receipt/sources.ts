/**
 * <receipts>/<day>/sources.json: the inputs a daily build (scripts/build-receipts.ts --day) signed from,
 * and the gate publish-records and anchor-receipts run before they touch that day.
 *
 * A day's root covers the purchases that were in the remeasure files when the day was built. If a later
 * run added purchases to the same day (or a file was replaced), the root would leave them out while the
 * ranking counts them. So before a day is published or anchored:
 *  - every input is hashed again and must equal what the build recorded;
 *  - a day built while its UTC day was still open (--allow-open-day) is refused: rebuild it once the
 *    day has closed.
 *
 * The Solana spend ledger is one file per month and grows every day, so for it only the day's own
 * purchases (keys "<day>|...") are hashed. Every other input is hashed whole.
 *
 * sources.json stays local: publish-records copies only the signed records.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SOURCES_KIND = "vet402-day-sources";

export interface SourceEntry {
  dataset: string;
  /** File name inside the remeasure folder. */
  file: string;
  /** "file": sha256 of the whole file. "day-purchases": sha256 of the day's purchases in a month ledger. */
  scope: "file" | "day-purchases";
  sha256: string;
}

export interface DaySources {
  kind: typeof SOURCES_KIND;
  version: 1;
  day: string;
  /** True when the build ran while the UTC day was still open (--allow-open-day). Such a day is never published or anchored. */
  openDay: boolean;
  builtAt: string;
  files: SourceEntry[];
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** The day's purchases in the Solana month ledger (budget-solana-YYYY-MM.json), in ledger order. */
export function dayPurchases(ledgerText: string, day: string): unknown[] {
  const l = JSON.parse(ledgerText) as { purchases?: { key?: unknown }[] };
  if (!Array.isArray(l.purchases)) throw new Error("spend ledger has no purchases list");
  return l.purchases.filter((p) => typeof p.key === "string" && p.key.startsWith(`${day}|`));
}

export function sourceDigest(scope: SourceEntry["scope"], text: string, day: string): string {
  return scope === "file" ? sha256(text) : sha256(JSON.stringify(dayPurchases(text, day)));
}

/**
 * Refuse a day whose inputs changed since it was built, or that was built while still open.
 * A day folder without sources.json is accepted only when its records start at sequence 1: that is the
 * first build (2026-09-28), which read census files, not the remeasure folder.
 * Returns a one-line description of what was checked; throws with the reason otherwise.
 */
export function assertDaySourcesCurrent(dayDir: string, day: string, remeasureDir: string): string {
  const path = join(dayDir, "sources.json");
  if (!existsSync(path)) {
    const seqs = readdirSync(dayDir)
      .filter((f) => /^obs_\d{4}-\d{2}-\d{2}_\d{6}\.json$/.test(f))
      .map((f) => (JSON.parse(readFileSync(join(dayDir, f), "utf8")) as { observer: { sequence: number } }).observer.sequence);
    if (seqs.length > 0 && Math.min(...seqs) === 1) return `${day}: first build (sequence from 1), no remeasure inputs to check`;
    throw new Error(`${day}: sources.json is missing, so the inputs this day was signed from cannot be checked`);
  }
  const s = JSON.parse(readFileSync(path, "utf8")) as Partial<DaySources> | unknown[];
  if (Array.isArray(s) || s.kind !== SOURCES_KIND || s.version !== 1 || !Array.isArray(s.files))
    throw new Error(`${day}: sources.json is not a ${SOURCES_KIND} v1 file (built by an older build-receipts); rebuild the day`);
  if (s.day !== day) throw new Error(`${day}: sources.json is for ${String(s.day)}`);
  if (s.openDay !== false)
    throw new Error(`${day}: built while the UTC day was still open (--allow-open-day); a later run that day may have added purchases. Rebuild it after the day closes`);
  if (s.files.length === 0) throw new Error(`${day}: sources.json lists no inputs`);
  const drift: string[] = [];
  for (const e of s.files) {
    if (e.scope !== "file" && e.scope !== "day-purchases") throw new Error(`${day}: sources.json: unknown scope for ${e.file}`);
    if (e.file.includes("/") || e.file.includes("\\") || e.file.startsWith(".")) throw new Error(`${day}: sources.json: ${e.file} is not a file name`);
    const p = join(remeasureDir, e.file);
    if (!existsSync(p)) {
      drift.push(`${e.file} is gone`);
      continue;
    }
    const now = sourceDigest(e.scope, readFileSync(p, "utf8"), day);
    if (now !== e.sha256) drift.push(`${e.file}${e.scope === "day-purchases" ? ` (the ${day} purchases)` : ""} changed since the build`);
  }
  if (drift.length) throw new Error(`${day}: the records no longer match their inputs: ${drift.join("; ")}. Rebuild the day (move the folder aside first)`);
  return `${day}: ${s.files.length} inputs unchanged since the build`;
}
