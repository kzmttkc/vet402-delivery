/**
 * Tempo payTos whose latest payment attempt in the window is sent with settled false stay out of the next
 * plan from seven UTC days before the plan day through the plan day (eight UTC dates), so the same seller is not bought again while unpaid.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { normAddr } from "../tempo/constants.js";
import type { LedgerEntry, LedgerFile } from "../tempo/ledger.js";
import { resultFilesUpTo, type RemeasureRow, type ResultFile } from "./results.js";

export interface NotSettledHold {
  url: string;
  holdDate: string;
  holdKey: string;
}

const DAY_MS = 86_400_000;
const DAY_LEDGER = /^tempo-ledger-(\d{4}-\d{2}-\d{2})\.json$/;

export function utcDateAdd(isoDate: string, deltaDays: number): string {
  const y = Number(isoDate.slice(0, 4));
  const m = Number(isoDate.slice(5, 7)) - 1;
  const d = Number(isoDate.slice(8, 10));
  return new Date(Date.UTC(y, m, d) + deltaDays * DAY_MS).toISOString().slice(0, 10);
}

type SentAttempt = {
  at: string;
  settled: boolean | null | undefined;
  url: string;
  key: string;
  holdDate: string;
};

function atMs(at: string): number {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) throw new Error(`invalid at: ${at}`);
  return ms;
}

/** Same instant (Date.parse): settled true beats false or unknown. Otherwise the earlier read stays. */
function isBetterAttempt(ev: SentAttempt, prev: SentAttempt): boolean {
  const evMs = atMs(ev.at);
  const prevMs = atMs(prev.at);
  if (evMs > prevMs) return true;
  if (evMs < prevMs) return false;
  if (ev.settled === true && prev.settled !== true) return true;
  if (prev.settled === true && ev.settled !== true) return false;
  return false;
}

function bumpLatest(latest: Map<string, SentAttempt>, payTo: string, ev: SentAttempt): void {
  if (ev.settled !== true && ev.settled !== false) return;
  const prev = latest.get(payTo);
  if (!prev || isBetterAttempt(ev, prev)) latest.set(payTo, ev);
}

function ingestResultRows(latest: Map<string, SentAttempt>, f: ResultFile, date: string): void {
  for (const row of f.rows) {
    if (row.chain !== "tempo" || row.outcome !== "sent") continue;
    bumpLatest(latest, normAddr(row.expectedPayTo), {
      at: row.at,
      settled: row.settled,
      url: row.url,
      key: row.key,
      holdDate: date,
    });
  }
}

function ingestLedgerEntries(latest: Map<string, SentAttempt>, entries: readonly LedgerEntry[], date: string): void {
  for (const e of entries) {
    if (e.status !== "sent") continue;
    bumpLatest(latest, normAddr(e.recipient), {
      at: e.reservedAt,
      settled: e.settled,
      url: e.url,
      key: e.key,
      holdDate: date,
    });
  }
}

function readDayLedger(dir: string, date: string): LedgerFile | null {
  const path = join(dir, `tempo-ledger-${date}.json`);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as LedgerFile;
  if (raw.version !== 1 || !Array.isArray(raw.entries)) throw new Error(`${path} is not a tempo day ledger`);
  return raw;
}

function ledgerDatesInWindow(dir: string, windowStart: string, planDate: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const m = DAY_LEDGER.exec(name);
    if (!m) continue;
    const date = m[1]!;
    if (date < windowStart || date > planDate) continue;
    out.push(date);
  }
  return out.sort();
}

function ledgerDatesUpTo(dir: string, planDate: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const m = DAY_LEDGER.exec(name);
    if (!m) continue;
    const date = m[1]!;
    if (date > planDate) continue;
    out.push(date);
  }
  return out.sort();
}

function latestInWindow(dir: string, windowStart: string, planDate: string): Map<string, SentAttempt> {
  const latest = new Map<string, SentAttempt>();
  for (const { file, chain, date } of resultFilesUpTo(dir, planDate)) {
    if (chain !== "tempo" || date < windowStart) continue;
    const f = JSON.parse(readFileSync(file, "utf8")) as ResultFile;
    ingestResultRows(latest, f, date);
  }
  for (const date of ledgerDatesInWindow(dir, windowStart, planDate)) {
    const ledger = readDayLedger(dir, date);
    if (ledger) ingestLedgerEntries(latest, ledger.entries, date);
  }
  return latest;
}

function latestIncludingPreWindow(
  dir: string,
  windowStart: string,
  planDate: string,
  unreadable: string[],
): Map<string, SentAttempt> {
  const latest = new Map(latestInWindow(dir, windowStart, planDate));
  for (const { file, chain, date } of resultFilesUpTo(dir, planDate)) {
    if (chain !== "tempo" || date >= windowStart) continue;
    const scratch = new Map<string, SentAttempt>();
    try {
      const f = JSON.parse(readFileSync(file, "utf8")) as ResultFile;
      ingestResultRows(scratch, f, date);
      for (const [payTo, ev] of scratch) bumpLatest(latest, payTo, ev);
    } catch {
      unreadable.push(file);
    }
  }
  for (const date of ledgerDatesUpTo(dir, planDate)) {
    if (date >= windowStart) continue;
    const path = join(dir, `tempo-ledger-${date}.json`);
    if (!existsSync(path)) continue;
    const scratch = new Map<string, SentAttempt>();
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as LedgerFile;
      if (raw.version !== 1 || !Array.isArray(raw.entries)) throw new Error(`${path} is not a tempo day ledger`);
      ingestLedgerEntries(scratch, raw.entries, date);
      for (const [payTo, ev] of scratch) bumpLatest(latest, payTo, ev);
    } catch {
      unreadable.push(path);
    }
  }
  return latest;
}

/** Hold `acquire()`'s lock through `notSettledStateFromDir`; release on read failure so the lock file is not left behind. */
export function lockAndReadHolds(
  acquire: () => () => void,
  dir: string,
  planDate: string,
): { release: () => void; holds: Map<string, NotSettledHold> } {
  const release = acquire();
  try {
    return { release, holds: notSettledStateFromDir(dir, planDate).holds };
  } catch (e) {
    release();
    throw e;
  }
}

/** Active holds and payTos whose unsettled attempt fell before the current window (eligible to buy again with a log line). */
export function notSettledStateFromDir(
  dir: string,
  planDate: string,
): { holds: Map<string, NotSettledHold>; ended: Map<string, NotSettledHold>; unreadable: string[] } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(planDate)) throw new Error(`planDate ${planDate} is not YYYY-MM-DD`);
  const windowStart = utcDateAdd(planDate, -7);
  const holds = new Map<string, NotSettledHold>();
  const ended = new Map<string, NotSettledHold>();
  const unreadable: string[] = [];
  for (const [payTo, ev] of latestInWindow(dir, windowStart, planDate)) {
    if (ev.settled === false) holds.set(payTo, { url: ev.url, holdDate: ev.holdDate, holdKey: ev.key });
  }
  for (const [payTo, ev] of latestIncludingPreWindow(dir, windowStart, planDate, unreadable)) {
    if (ev.settled !== false || ev.holdDate >= windowStart) continue;
    ended.set(payTo, { url: ev.url, holdDate: ev.holdDate, holdKey: ev.key });
  }
  return { holds, ended, unreadable };
}

/** PayTos on hold from tempo results and day ledgers in `dir` from seven UTC days before `planDate` through `planDate` inclusive. */
export function notSettledHoldsFromDir(dir: string, planDate: string): Map<string, NotSettledHold> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(planDate)) throw new Error(`planDate ${planDate} is not YYYY-MM-DD`);
  const windowStart = utcDateAdd(planDate, -7);
  const holds = new Map<string, NotSettledHold>();
  for (const [payTo, ev] of latestInWindow(dir, windowStart, planDate)) {
    if (ev.settled === false) holds.set(payTo, { url: ev.url, holdDate: ev.holdDate, holdKey: ev.key });
  }
  return holds;
}

/** Console line when a payTo may be bought again because its unsettled hold fell before the eight-day window. */
export function holdEndedLine(e: { payTo: string; url: string; holdDate: string; holdKey: string }): string {
  return `not_settled_hold ended: ${e.payTo} ${e.url} was last sent unsettled on ${e.holdDate} (${e.holdKey}), buying it again today`;
}

/** Console line when a pre-window result or ledger file could not be read while resolving ended holds. */
export function holdEndedUnreadableLine(path: string): string {
  return `not_settled_hold: could not read ${path} while looking for ended holds, skipped it`;
}

/** Lines to log after a hold ends or a pre-window file is unreadable (scripts/remeasure.ts). */
export function holdNoticeLines(
  holdEnded: readonly { payTo: string; url: string; holdDate: string; holdKey: string }[],
  unreadable: readonly string[],
): string[] {
  return [...holdEnded.map(holdEndedLine), ...unreadable.map(holdEndedUnreadableLine)];
}
