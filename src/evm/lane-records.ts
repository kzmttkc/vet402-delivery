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

function jsonl<T>(f: string): T[] {
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as T) : [];
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

/** The patches for these lanes: the tracked file, then any local per-lane file. */
export function readDeclaredPatches(laneIds: readonly string[], dir = "results/evm"): DeclaredPatch[] {
  const all = [...jsonl<DeclaredPatch>(join(dir, DECLARED_INPUTS_FILE)), ...laneIds.flatMap((l) => jsonl<DeclaredPatch>(join(dir, `${l}-declared.jsonl`)))];
  return all.filter((p) => laneIds.includes(p.lane));
}

/** Every reading of these lanes, one record per purchase, with rule 0's material applied. */
export function loadLaneRecords(laneIds: readonly string[], dir = "results/evm", kinds: readonly string[] = ["purchases", "reverify", "chaincheck"]): LaneRecord[] {
  const rows = mergeReadings(laneIds.flatMap((l) => kinds.flatMap((k) => jsonl<LaneRecord>(join(dir, `${l}-${k}.jsonl`)))));
  return applyDeclaredPatches(rows, readDeclaredPatches(laneIds, dir));
}
