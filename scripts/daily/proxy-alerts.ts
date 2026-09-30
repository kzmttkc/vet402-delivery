/**
 * run.sh proxy-alerts: read the open proxy-buy ALERTs (GET $VET402_PROXY_ALERTS_URL with
 * Authorization: Bearer $VET402_PROXY_ALERTS_SECRET, served by api/alerts.ts) and print one line per thing to report
 * now; run.sh writes each line to the alert file and shows a notification. Nothing fails quietly:
 *   - an open alert: when it is new, and again each day it stays open;
 *   - the reconciler's last full run older than RECONCILER_LATE_MS (the cron stopped): when it starts, then daily;
 *   - a read that fails (no answer, not 200, not JSON, no alerts list): when it starts, then daily.
 *
 *   tsx scripts/daily/proxy-alerts.ts --state <file>
 *
 * The state file (outside the repository) remembers what was reported and when. Nothing here pays or writes to the
 * database.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface ProxyAlert {
  key: string;
  purchaseId: string;
  chain: string;
  reason: string;
  firstAt: string;
  lastAt: string;
  count: number;
  note?: string | null;
}

export interface ReportState {
  /** report key -> when it was last reported (ISO). Alert keys, and "read-failing" / "reconciler-late". */
  reported: Record<string, string>;
}

/** Report again something still true this long after it was last reported. */
export const REPORT_AGAIN_MS = 24 * 3_600_000;
/** The cron runs every five minutes: a last full run older than this means it stopped. */
export const RECONCILER_LATE_MS = 15 * 60_000;

export function lineFor(a: ProxyAlert): string {
  const reason = a.reason.replace(/\s+/g, " ").slice(0, 400);
  return `[vet402_proxy_buy] ${a.chain} ${a.purchaseId}: ${reason} (first ${a.firstAt}, seen ${a.count} time(s))${a.note ? ` note: ${a.note.slice(0, 200)}` : ""}`;
}

/** The answer of api/alerts, checked: anything else is a failed read. */
export function parseAnswer(text: string): { alerts: ProxyAlert[]; reconcilerLastRunAt: string | null } | { error: string } {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { error: "not JSON" };
  }
  const o = j as { alerts?: unknown; reconcilerLastRunAt?: unknown };
  if (!o || typeof o !== "object" || !Array.isArray(o.alerts)) return { error: "no alerts list" };
  const last = typeof o.reconcilerLastRunAt === "string" ? o.reconcilerLastRunAt : null;
  return { alerts: o.alerts as ProxyAlert[], reconcilerLastRunAt: last };
}

type Item = { key: string; line: string };

/** What to print now, and the state to keep. Keys no longer true are forgotten (a later return is new again). */
export function toReport(items: Item[], state: ReportState, now: Date): { lines: string[]; state: ReportState } {
  const reported: Record<string, string> = {};
  const lines: string[] = [];
  for (const it of items) {
    const last = state.reported[it.key];
    if (!last || now.getTime() - Date.parse(last) >= REPORT_AGAIN_MS) {
      lines.push(it.line);
      reported[it.key] = now.toISOString();
    } else {
      reported[it.key] = last;
    }
  }
  return { lines, state: { reported } };
}

/** The items for one read: its alerts, and whether the reconciler is late. */
export function itemsFor(answer: { alerts: ProxyAlert[]; reconcilerLastRunAt: string | null }, now: Date): Item[] {
  const items: Item[] = answer.alerts.map((a) => ({ key: `alert:${a.key}`, line: lineFor(a) }));
  const last = answer.reconcilerLastRunAt ? Date.parse(answer.reconcilerLastRunAt) : NaN;
  if (!Number.isFinite(last) || now.getTime() - last > RECONCILER_LATE_MS) {
    items.push({
      key: "reconciler-late",
      line: `[vet402_proxy_buy] the reconciler has not run in full since ${answer.reconcilerLastRunAt ?? "(never)"}: the cron may have stopped; purchases left open are not being settled`,
    });
  }
  return items;
}

export function failedItem(why: string): Item {
  return { key: "read-failing", line: `[vet402_proxy_buy] the open alerts could not be read (${why}); said again daily until a read works` };
}

function readState(file: string): ReportState {
  if (!existsSync(file)) return { reported: {} };
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as ReportState;
    return { reported: s.reported ?? {} };
  } catch {
    return { reported: {} };
  }
}

function writeState(file: string, s: ReportState): void {
  writeFileSync(`${file}.tmp`, JSON.stringify(s, null, 2), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}

async function main(): Promise<void> {
  const i = process.argv.indexOf("--state");
  const file = i >= 0 ? process.argv[i + 1] : undefined;
  if (!file) throw new Error("--state <file> is required");
  const url = process.env.VET402_PROXY_ALERTS_URL ?? "";
  const secret = process.env.VET402_PROXY_ALERTS_SECRET ?? "";
  // https only (the secret travels in the header); plain http only to this machine (tests).
  if (!/^(https:\/\/[^/]+|http:\/\/127\.0\.0\.1:\d+)\/api\/alerts$/.test(url) || !secret) {
    throw new Error("VET402_PROXY_ALERTS_URL (https://<host>/api/alerts) and VET402_PROXY_ALERTS_SECRET are required");
  }
  const state = readState(file);
  const now = new Date();
  let items: Item[];
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const a = parseAnswer(await res.text());
    if ("error" in a) throw new Error(a.error);
    items = itemsFor(a, now);
  } catch (e) {
    // Fixed words only: the URL and the secret are never printed.
    const m = (e as Error).message;
    const why = /^HTTP \d+$/.test(m) || m === "not JSON" || m === "no alerts list" ? m : "no answer";
    // Keep what was reported about alerts: a failed read says nothing about them.
    const out = toReport([failedItem(why)], state, now);
    for (const l of out.lines) console.log(l);
    writeState(file, { reported: { ...state.reported, ...out.state.reported } });
    return;
  }
  const out = toReport(items, state, now);
  for (const l of out.lines) console.log(l);
  writeState(file, out.state);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(`proxy-alerts: ${String((e as Error).message ?? e).slice(0, 200)}`);
    process.exit(2);
  });
}
