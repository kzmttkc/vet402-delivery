/**
 * One --pay run at a time: a lock file created with O_EXCL ("wx"). Released only when the run ends
 * normally or with a thrown error; a run killed by a signal leaves it, and the next run stops and
 * says why instead of guessing that the other run is gone.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export class LockHeld extends Error {}

export function acquireRunLock(file: string, now: Date = new Date()): () => void {
  mkdirSync(dirname(file), { recursive: true });
  const token = randomUUID();
  let fd: number;
  try {
    fd = openSync(file, "wx");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    let held = "";
    try {
      held = readFileSync(file, "utf8").trim().slice(0, 300);
    } catch {
      /* unreadable lock: still held */
    }
    throw new LockHeld(
      `another first-buyer --pay run holds ${file} (${held || "no details"}). If no run is active, it ended without releasing the lock: check results/first-buyer-ledger.json for pending attempts, then delete the lock file.`,
    );
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: now.toISOString(), token }) + "\n");
  } finally {
    closeSync(fd);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (existsSync(file) && readFileSync(file, "utf8").includes(token)) unlinkSync(file);
    } catch {
      /* leave it: the next run stops and says why */
    }
  };
}
