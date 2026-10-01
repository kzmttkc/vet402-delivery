/**
 * The reconciler cron, the operator's proxy-alerts read and the "reconciler is late" threshold agree, and the
 * cron is slow enough for Neon's free plan (100 CU-hours a month, the database stops after 5 idle minutes):
 *  - vercel.json runs /api/reconcile every 30 minutes (minutes 0 and 30) with maxDuration 300;
 *  - the proxy-alerts LaunchAgent reads at minutes 2 and 32, two minutes after each run;
 *  - RECONCILER_LATE_MS is three intervals plus one run: a normal day never reads "late", two missed runs in a
 *    row do not either, three do.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { itemsFor, NEON_ALERT_CU_HOURS, neonItems, projectedCuHours, RECONCILE_EVERY_MS, RECONCILE_MAX_RUN_MS, RECONCILER_LATE_MS, recordWake, type WakeLog } from "../scripts/daily/proxy-alerts.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vercel = JSON.parse(readFileSync(join(ROOT, "vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[]; functions: Record<string, { maxDuration?: number }> };
const plist = readFileSync(join(ROOT, "scripts", "daily", "launchd", "com.vet402.daily.proxy-alerts.plist"), "utf8");

const cronMinutes = (schedule: string): number[] => {
  const m = /^\*\/(\d+) \* \* \* \*$/.exec(schedule);
  assert.ok(m, `a plain every-N-minutes schedule: ${schedule}`);
  const n = Number(m[1]);
  return Array.from({ length: 60 / n }, (_, i) => i * n);
};

test("the reconciler cron runs every 30 minutes, the late threshold is built from it and from the function's time limit", () => {
  const cron = vercel.crons.find((c) => c.path === "/api/reconcile")!;
  assert.equal(cron.schedule, "*/30 * * * *");
  assert.deepEqual(cronMinutes(cron.schedule), [0, 30]);
  assert.equal(RECONCILE_EVERY_MS, 30 * 60_000);
  assert.equal(RECONCILE_MAX_RUN_MS, (vercel.functions["api/reconcile.ts"]!.maxDuration ?? 0) * 1000);
  assert.equal(RECONCILER_LATE_MS, 95 * 60_000);
});

test("proxy-alerts reads at :02 and :32, two minutes after each cron run, on a calendar (not every 15 minutes)", () => {
  assert.ok(!plist.includes("StartInterval"), "no fixed interval left");
  const minutes = [...plist.matchAll(/<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/g)].map((m) => Number(m[1]));
  assert.deepEqual(minutes, [2, 32]);
  assert.deepEqual(minutes.map((m) => m - 2), cronMinutes(vercel.crons.find((c) => c.path === "/api/reconcile")!.schedule));
  assert.ok(!/<key>Hour<\/key>/.test(plist), "every hour");
});

/** A day of reads at :02 and :32; each cron run records its full run up to RECONCILE_MAX_RUN_MS after it starts. */
function lateReads(missed: (runStart: number) => boolean, finishAfterMs: number): number {
  const day = Date.parse("2026-10-02T00:00:00Z");
  let late = 0;
  for (let t = day; t < day + 86_400_000; t += 30 * 60_000) {
    const read = t + 2 * 60_000;
    // the newest run that finished before the read (the run at t may still be going)
    let last: number | null = null;
    for (let s = t; s > day - 3 * 3_600_000; s -= RECONCILE_EVERY_MS) {
      if (missed(s)) continue;
      if (s + finishAfterMs <= read) {
        last = s + finishAfterMs;
        break;
      }
    }
    const items = itemsFor({ alerts: [], reconcilerLastRunAt: last === null ? null : new Date(last).toISOString() }, new Date(read));
    if (items.some((i) => i.key === "reconciler-late")) late++;
  }
  return late;
}

test("no false 'late' alarm: a normal day, slow runs, and two missed runs in a row stay quiet; three missed runs are reported", () => {
  assert.equal(lateReads(() => false, 60_000), 0, "runs that take a minute");
  assert.equal(lateReads(() => false, RECONCILE_MAX_RUN_MS), 0, "runs that take the full five minutes");
  const twoMissed = (s: number) => s >= Date.parse("2026-10-02T06:00:00Z") && s < Date.parse("2026-10-02T07:00:00Z");
  assert.equal(lateReads(twoMissed, RECONCILE_MAX_RUN_MS), 0, "two missed runs in a row");
  const threeMissed = (s: number) => s >= Date.parse("2026-10-02T06:00:00Z") && s < Date.parse("2026-10-02T07:30:00Z");
  assert.ok(lateReads(threeMissed, RECONCILE_MAX_RUN_MS) > 0, "three missed runs in a row");
});

test("the README says the same schedule, threshold and free-plan numbers", () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  assert.ok(readme.includes("every 30 minutes (`*/30` in `vercel.json`)"));
  assert.ok(readme.includes("| `proxy-alerts` | :02 and :32 every hour |"));
  assert.ok(readme.includes("has not run in full for 95 minutes"));
  assert.ok(readme.includes("100 CU-hours a month"));
  assert.ok(!/every five minutes|\*\/5 in|every 15 min/.test(readme), "no old interval left");
});

test("Neon estimate: a normal month stays quiet, a database that never stops is reported, a missing wake-up time says so", () => {
  const day = Date.parse("2026-10-02T00:00:00Z");
  const run = (startFor: (t: number) => number, hours: number) => {
    let log: WakeLog | undefined;
    let items: { key: string }[] = [];
    for (let t = day; t < day + hours * 3_600_000; t += 30 * 60_000) {
      const read = new Date(t + 2 * 60_000);
      const started = new Date(startFor(t)).toISOString().replace(/\.\d{3}Z$/, "Z");
      log = recordWake(log, started, read);
      items = neonItems(log, started, read);
    }
    return { log: log!, items };
  };
  // Woken by each cron run at :00 / :30, stopped 5 idle minutes after the :02 / :32 read.
  const normal = run((t) => t, 48);
  const p = projectedCuHours(normal.log, new Date(day + 48 * 3_600_000))!;
  assert.ok(p.projected > 40 && p.projected < 46, `about 43 CU-hours: ${p.projected}`);
  assert.deepEqual(normal.items, []);
  // Never stopped (the old five-minute cron): one wake-up all along.
  const always = run(() => day - 60_000, 48);
  assert.equal(always.log.wakes.length, 1);
  assert.equal(always.items[0]?.key, "neon-usage");
  assert.ok(projectedCuHours(always.log, new Date(day + 48 * 3_600_000))!.projected > NEON_ALERT_CU_HOURS);
  // Too little watched: no projection yet.
  assert.equal(projectedCuHours(run(() => day - 60_000, 3).log, new Date(day + 3 * 3_600_000)), null);
  // The database does not say: said, not guessed.
  assert.equal(neonItems(recordWake(undefined, null, new Date(day)), null, new Date(day))[0]?.key, "neon-unmeasured");
  // A new month starts a new log.
  const next = recordWake(normal.log, "2026-11-01T00:00:00Z", new Date("2026-11-01T00:02:00Z"));
  assert.deepEqual([next.month, next.wakes.length], ["2026-11", 1]);
});
