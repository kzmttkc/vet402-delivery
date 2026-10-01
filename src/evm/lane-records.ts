/**
 * A lane's purchase records as every reader must see them: the purchases, their re-read settlements, the chain
 * check (later readings of one purchase replace earlier ones), and rule 0's material (src/evm/lane-input.ts:
 * what the listing declared and which parameter names the request carried, never values).
 *
 * Rule 0's material for purchases that did not keep it themselves (before 2026-10-02) is in a tracked file,
 * results/evm/declared-inputs.jsonl (written by scripts/evm-declare.ts), so the daily publish and the lane's next
 * plan read the same thing on every machine. A local results/evm/<lane>-declared.jsonl is read too. A patch only
 * fills a field the record does not have: a purchase's own record always wins.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeReadings, recordKey } from "./chaincheck.js";
import type { ChainBuyRecord } from "./evm-buy.js";

export const DECLARED_INPUTS_FILE = "declared-inputs.jsonl";
export const DECLARED_FIELDS = ["declaredParams", "requiredParams", "declaredFrom", "requiredFrom", "sentParams"] as const;

export type LaneRecord = ChainBuyRecord & { lane: string };
export type DeclaredPatch = Pick<LaneRecord, "lane" | "agentId" | "at" | "resource"> & Partial<Pick<ChainBuyRecord, (typeof DECLARED_FIELDS)[number]>> & { sentFrom?: string };

/** A line of a results file that is not JSON: the file, its 1-based line number, the parser's error. */
export interface LineProblem {
  file: string;
  line: number;
  error: string;
}

/** Every JSON line of a file; a line that does not parse is skipped and reported, never thrown. */
export function readJsonl<T>(f: string): { rows: T[]; problems: LineProblem[] } {
  if (!existsSync(f)) return { rows: [], problems: [] };
  const rows: T[] = [];
  const problems: LineProblem[] = [];
  readFileSync(f, "utf8")
    .split("\n")
    .forEach((l, i) => {
      if (!l.trim()) return;
      try {
        rows.push(JSON.parse(l) as T);
      } catch (err) {
        problems.push({ file: f, line: i + 1, error: (err as Error).message.slice(0, 160) });
      }
    });
  return { rows, problems };
}

/** The purchase a broken patch line was about, when its key fields can still be read from the text. */
function keyOfBrokenLine(f: string, line: number): string | null {
  const text = readFileSync(f, "utf8").split("\n")[line - 1] ?? "";
  const field = (k: string) => new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text)?.[1];
  const [lane, agentId, at, resource] = ["lane", "agentId", "at", "resource"].map(field);
  return lane && agentId && at && resource ? recordKey({ lane, agentId, at, resource }) : null;
}

/** Pure. Fill rule 0's fields a record lacks from the patch of the same purchase. */
export function applyDeclaredPatches<T extends LaneRecord>(rows: readonly T[], patches: readonly DeclaredPatch[]): T[] {
  const by = new Map(patches.map((p) => [recordKey(p), p]));
  return rows.map((r) => {
    const p = by.get(recordKey(r));
    if (!p) return r;
    const out = { ...r } as T & Record<string, unknown>;
    for (const k of DECLARED_FIELDS) if (out[k] === undefined && p[k] !== undefined) (out as Record<string, unknown>)[k] = p[k];
    return out;
  });
}

/**
 * The patches for these lanes. The tracked file first; a local per-lane file only for purchases the tracked file
 * does not have, so every field of one purchase comes from one source. Lines that do not parse are reported.
 */
export function readDeclaredPatches(laneIds: readonly string[], dir = "results/evm"): { patches: DeclaredPatch[]; problems: LineProblem[] } {
  const tracked = readJsonl<DeclaredPatch>(join(dir, DECLARED_INPUTS_FILE));
  const locals = laneIds.map((l) => readJsonl<DeclaredPatch>(join(dir, `${l}-declared.jsonl`)));
  const have = new Set(tracked.rows.map((p) => recordKey(p)));
  const patches = [...tracked.rows, ...locals.flatMap((x) => x.rows).filter((p) => !have.has(recordKey(p)))].filter((p) => laneIds.includes(p.lane));
  return { patches, problems: [...tracked.problems, ...locals.flatMap((x) => x.problems)] };
}

/**
 * Every reading of these lanes, one record per purchase, with rule 0's material applied, and every line that did
 * not parse. A purchase whose material may have been on a broken line of a declarations file is marked
 * materialLost (the pages withhold it rather than read its 4xx without the material): the purchase the line names
 * when its key can still be read, else every 4xx purchase of these lanes that has no material.
 */
export function loadLaneRecordsChecked(
  laneIds: readonly string[],
  dir = "results/evm",
  kinds: readonly string[] = ["purchases", "reverify", "chaincheck"],
): { rows: LaneRecord[]; problems: LineProblem[]; /** Broken record lines that name no purchase that could be read. */ unnamedLines: number } {
  const reads = laneIds.flatMap((l) => kinds.map((k) => readJsonl<LaneRecord>(join(dir, `${l}-${k}.jsonl`))));
  const decl = readDeclaredPatches(laneIds, dir);
  let rows = applyDeclaredPatches(mergeReadings(reads.flatMap((r) => r.rows)), decl.patches);
  // A purchase whose every reading was on a broken line: kept as a withheld placeholder when its key can be read
  // from the line (so it is counted and never shown as "not bought yet"), else counted as an unnamed line.
  const have = new Set(rows.map((r) => recordKey(r)));
  let unnamedLines = 0;
  const placeholders = new Map<string, LaneRecord>();
  for (const p of reads.flatMap((r) => r.problems)) {
    const text = readFileSync(p.file, "utf8").split("\n")[p.line - 1] ?? "";
    const field = (k: string) => new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(text)?.[1];
    const [lane, agentId, at, resource] = ["lane", "agentId", "at", "resource"].map(field);
    if (!(lane && agentId && at && resource)) {
      unnamedLines++;
      continue;
    }
    const key = recordKey({ lane, agentId, at, resource });
    if (have.has(key) || placeholders.has(key)) continue;
    const payTo = field("payTo") ?? (agentId.startsWith("payto:") ? agentId.slice(6) : undefined);
    placeholders.set(key, { lane, agentId, at, resource, method: field("method") === "POST" ? "POST" : "GET", outcome: "sent", materialLost: true, ...(payTo ? { payTo } : {}) } as LaneRecord);
  }
  rows = [...rows, ...placeholders.values()];
  if (decl.problems.length) {
    const keys = decl.problems.map((p) => keyOfBrokenLine(p.file, p.line));
    const named = new Set(keys.filter((k): k is string => k !== null));
    const unknown = keys.some((k) => k === null);
    rows = rows.map((r) => {
      const lacks = r.outcome === "sent" && [400, 404, 422].includes(r.response?.status ?? -1) && r.requiredParams === undefined && r.sentParams === undefined;
      return named.has(recordKey(r)) || (unknown && lacks) ? { ...r, materialLost: true } : r;
    });
  }
  return { rows, problems: [...reads.flatMap((r) => r.problems), ...decl.problems], unnamedLines };
}

/**
 * A paying run must not buy on records it could not read whole: the last answers (what not to buy again) and rule
 * 0's material come from these files. Returns why it stops (ALERT lines with file and line), or null.
 */
export function payStopForUnreadableLines(problems: readonly LineProblem[]): string | null {
  if (!problems.length) return null;
  return problems.map((p) => `ALERT ${p.file}:${p.line}: not JSON (${p.error})`).join("\n") + `\nALERT ${problems.length} unreadable line(s) in the lane's records: --pay stops before any purchase`;
}

/** loadLaneRecordsChecked, with every line that did not parse said on stderr. */
export function loadLaneRecords(laneIds: readonly string[], dir = "results/evm", kinds: readonly string[] = ["purchases", "reverify", "chaincheck"]): LaneRecord[] {
  const { rows, problems } = loadLaneRecordsChecked(laneIds, dir, kinds);
  for (const p of problems) console.error(`ALERT ${p.file}:${p.line}: not JSON, skipped (${p.error})`);
  return rows;
}
