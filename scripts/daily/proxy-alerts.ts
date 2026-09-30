/**
 * run.sh proxy-alerts: read the open proxy-buy ALERTs (GET $VET402_PROXY_ALERTS_URL with
 * Authorization: Bearer $VET402_PROXY_CRON_SECRET, served by api/alerts.ts) and print one line per alert to report
 * now: a new one, or one still open a day after it was last reported. run.sh writes each line to the alert file and
 * shows a notification. A read that fails is printed once, until a read works again.
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
  /** alert key -> when it was last reported (ISO). */
  reported: Record<string, string>;
  /** The last read failed and that was reported. */
  readFailing?: boolean;
}

/** Report again an alert that is still open this long after it was last reported. */
export const REPORT_AGAIN_MS = 24 * 3_600_000;

export function lineFor(a: ProxyAlert): string {
  const reason = a.reason.replace(/\s+/g, " ").slice(0, 400);
  return `[vet402_proxy_buy] ${a.chain} ${a.purchaseId}: ${reason} (first ${a.firstAt}, seen ${a.count} time(s))${a.note ? ` note: ${a.note.slice(0, 200)}` : ""}`;
}

/** What to print now, and the state to keep. Keys no longer open are forgotten (a later return is new again). */
export function toReport(alerts: ProxyAlert[], state: ReportState, now: Date): { lines: string[]; state: ReportState } {
  const reported: Record<string, string> = {};
  const lines: string[] = [];
  for (const a of alerts) {
    const last = state.reported[a.key];
    if (!last || now.getTime() - Date.parse(last) >= REPORT_AGAIN_MS) {
      lines.push(lineFor(a));
      reported[a.key] = now.toISOString();
    } else {
      reported[a.key] = last;
    }
  }
  return { lines, state: { reported } };
}

function readState(file: string): ReportState {
  if (!existsSync(file)) return { reported: {} };
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as ReportState;
    return { reported: s.reported ?? {}, ...(s.readFailing ? { readFailing: true } : {}) };
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
  const secret = process.env.VET402_PROXY_CRON_SECRET ?? "";
  // https only (the secret travels in the header); plain http only to this machine (tests).
  if (!/^(https:\/\/[^/]+|http:\/\/127\.0\.0\.1:\d+)\/api\/alerts$/.test(url) || !secret) {
    throw new Error("VET402_PROXY_ALERTS_URL (https://<host>/api/alerts) and VET402_PROXY_CRON_SECRET are required");
  }
  const state = readState(file);
  let alerts: ProxyAlert[];
  try {
    const res = await fetch(url, { headers: { authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    alerts = ((await res.json()) as { alerts?: ProxyAlert[] }).alerts ?? [];
  } catch (e) {
    // Fixed words only: the URL and the secret are never printed.
    const why = /^HTTP \d+$/.test((e as Error).message) ? (e as Error).message : "no answer";
    if (!state.readFailing) console.log(`[vet402_proxy_buy] the open alerts could not be read (${why}); said once until a read works again`);
    writeState(file, { ...state, readFailing: true });
    return;
  }
  const out = toReport(alerts, state, new Date());
  for (const l of out.lines) console.log(l);
  writeState(file, out.state);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(`proxy-alerts: ${String((e as Error).message ?? e).slice(0, 200)}`);
    process.exit(2);
  });
}
