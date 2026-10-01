/**
 * run.sh proxy-alerts: read the open proxy-buy ALERTs (GET $VET402_PROXY_ALERTS_URL with
 * Authorization: Bearer $VET402_PROXY_ALERTS_SECRET, served by api/alerts.ts) and print one line per thing to report
 * now; run.sh writes each line to the alert file and shows a notification. Nothing fails quietly:
 *   - an open alert: when it is new, and again each day it stays open;
 *   - the reconciler's last full run older than RECONCILER_LATE_MS (the cron stopped): when it starts, then daily;
 *   - a read that fails (no answer, not 200, not JSON, no alerts list): when it starts, then daily;
 *   - Neon's free plan: when this month's database time, projected to the month's end, passes NEON_ALERT_CU_HOURS,
 *     or when the database does not say when it woke up (nothing to estimate from): when it starts, then daily.
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
  /** This month's database wake-ups as the reads saw them (for the Neon estimate). */
  neon?: WakeLog;
}

/**
 * The database's wake-ups seen by the reads. Each read is at :02 or :32, inside the wake-up the cron run just
 * caused, and api/alerts gives when the database server started (pg_postmaster_start_time: on Neon, the last
 * wake-up). The same start in two reads in a row means it stayed awake between them.
 */
export interface WakeLog {
  /** UTC month, YYYY-MM. A new month starts a new log. */
  month: string;
  firstReadAt: string;
  wakes: { start: string; lastSeen: string }[];
}

/** Neon's free plan: CU-hours a month, the smallest compute size, and the idle time before it stops. */
export const NEON_FREE_CU_HOURS = 100;
export const NEON_ALERT_CU_HOURS = 80;
export const NEON_CU = 0.25;
export const NEON_IDLE_MS = 5 * 60_000;
/** No projection from less than this much watching. */
export const NEON_MIN_OBSERVED_MS = 6 * 3_600_000;

/** Report again something still true this long after it was last reported. */
export const REPORT_AGAIN_MS = 24 * 3_600_000;
/** The reconciler cron (vercel.json, every 30 minutes): at :00 and :30. */
export const RECONCILE_EVERY_MS = 30 * 60_000;
/** The longest a reconcile run can take before it records its full run (vercel.json maxDuration of api/reconcile.ts). */
export const RECONCILE_MAX_RUN_MS = 300_000;
/**
 * A last full run older than this means the cron stopped: three intervals and one run's time, so two runs in a
 * row may be missed or cut short (as the 15 minutes did for the old five-minute cron) without a false alarm.
 * The runner reads at :02 and :32, while the run that started at :00 or :30 may still be going.
 */
export const RECONCILER_LATE_MS = 3 * RECONCILE_EVERY_MS + RECONCILE_MAX_RUN_MS;

export function lineFor(a: ProxyAlert): string {
  const reason = a.reason.replace(/\s+/g, " ").slice(0, 400);
  return `[vet402_proxy_buy] ${a.chain} ${a.purchaseId}: ${reason} (first ${a.firstAt}, seen ${a.count} time(s))${a.note ? ` note: ${a.note.slice(0, 200)}` : ""}`;
}

/** Add this read to the month's wake-up log. */
export function recordWake(log: WakeLog | undefined, dbStartedAt: string | null, now: Date): WakeLog {
  const month = now.toISOString().slice(0, 7);
  const cur: WakeLog = log && log.month === month ? { ...log, wakes: [...log.wakes] } : { month, firstReadAt: now.toISOString(), wakes: [] };
  if (!dbStartedAt || !Number.isFinite(Date.parse(dbStartedAt))) return cur;
  const last = cur.wakes[cur.wakes.length - 1];
  if (last && last.start === dbStartedAt) last.lastSeen = now.toISOString();
  else cur.wakes.push({ start: dbStartedAt, lastSeen: now.toISOString() });
  if (cur.wakes.length > 3000) cur.wakes.splice(0, cur.wakes.length - 3000);
  return cur;
}

/**
 * This month's database time, projected to the month's end, in CU-hours at NEON_CU. Each wake-up counts from
 * its start to the last read that saw it, plus the idle minutes before Neon stops it. A wake-up that started and
 * ended between two reads is not seen, so this can only undercount; the 17-day failure (the database never
 * stopping) is what it is sure to see. null when too little has been watched.
 */
export function projectedCuHours(log: WakeLog, now: Date): { awakeHours: number; observedHours: number; projected: number } | null {
  const monthStart = Date.parse(`${log.month}-01T00:00:00Z`);
  const from = Math.max(monthStart, Date.parse(log.firstReadAt));
  const observedMs = now.getTime() - from;
  if (observedMs < NEON_MIN_OBSERVED_MS) return null;
  let awakeMs = 0;
  for (const w of log.wakes) {
    const start = Math.max(Date.parse(w.start), from);
    awakeMs += Math.max(0, Date.parse(w.lastSeen) - start) + NEON_IDLE_MS;
  }
  const d = new Date(monthStart);
  const monthMs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - monthStart;
  const projected = (awakeMs / observedMs) * (monthMs / 3_600_000) * NEON_CU;
  return { awakeHours: awakeMs / 3_600_000, observedHours: observedMs / 3_600_000, projected };
}

/** What to say about Neon's free plan after this read. */
export function neonItems(log: WakeLog, dbStartedAt: string | null, now: Date): Item[] {
  if (!dbStartedAt) {
    return [{ key: "neon-unmeasured", line: "[vet402_proxy_buy] Neon: the database did not say when it woke up (api/alerts dbStartedAt); its monthly use is not being estimated" }];
  }
  const p = projectedCuHours(log, now);
  if (!p || p.projected <= NEON_ALERT_CU_HOURS) return [];
  return [
    {
      key: "neon-usage",
      line: `[vet402_proxy_buy] Neon: about ${p.projected.toFixed(0)} CU-hours projected for ${log.month} (awake ${p.awakeHours.toFixed(1)} h of ${p.observedHours.toFixed(1)} h watched, at ${NEON_CU} CU); the free plan stops the database at ${NEON_FREE_CU_HOURS}, and proxy buy with it`,
    },
  ];
}

/** The answer of api/alerts, checked: anything else is a failed read. */
export function parseAnswer(text: string): { alerts: ProxyAlert[]; reconcilerLastRunAt: string | null; dbStartedAt?: string | null } | { error: string } {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { error: "not JSON" };
  }
  const o = j as { alerts?: unknown; reconcilerLastRunAt?: unknown; dbStartedAt?: unknown };
  if (!o || typeof o !== "object" || !Array.isArray(o.alerts)) return { error: "no alerts list" };
  const last = typeof o.reconcilerLastRunAt === "string" ? o.reconcilerLastRunAt : null;
  const started = typeof o.dbStartedAt === "string" ? o.dbStartedAt : null;
  return { alerts: o.alerts as ProxyAlert[], reconcilerLastRunAt: last, dbStartedAt: started };
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
    return { reported: s.reported ?? {}, ...(s.neon ? { neon: s.neon } : {}) };
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
  let neon = state.neon;
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const a = parseAnswer(await res.text());
    if ("error" in a) throw new Error(a.error);
    items = itemsFor(a, now);
    neon = recordWake(state.neon, a.dbStartedAt ?? null, now);
    items.push(...neonItems(neon, a.dbStartedAt ?? null, now));
  } catch (e) {
    // Fixed words only: the URL and the secret are never printed.
    const m = (e as Error).message;
    const why = /^HTTP \d+$/.test(m) || m === "not JSON" || m === "no alerts list" ? m : "no answer";
    // Keep what was reported about alerts: a failed read says nothing about them.
    const out = toReport([failedItem(why)], state, now);
    for (const l of out.lines) console.log(l);
    writeState(file, { reported: { ...state.reported, ...out.state.reported }, ...(neon ? { neon } : {}) });
    return;
  }
  const out = toReport(items, state, now);
  for (const l of out.lines) console.log(l);
  writeState(file, { ...out.state, ...(neon ? { neon } : {}) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(`proxy-alerts: ${String((e as Error).message ?? e).slice(0, 200)}`);
    process.exit(2);
  });
}
