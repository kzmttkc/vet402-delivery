/**
 * The public tree of the commit under test passes the secret gate, before it can reach main.
 *
 * On 2026-10-01 main held ten findings the gate did not allow (public function names on site/use.html and
 * site/index.html, the observation_roots program id in data/records/index.json): nothing scanned a commit when it
 * was pushed, only the daily runner before its own publish, which then stopped. This test runs with npm test, so a
 * commit that adds such a finding fails here first.
 *
 * What it scans: the files git tracks at HEAD (git archive HEAD into a scratch folder, so untracked files and
 * results/ left on this machine do not count), under data, site and results, with the allow list of that same
 * commit (scripts/daily/secret-allow.json). With the runner's key folder present (.keys/ beside this checkout), any
 * encoding of those keys is a finding no allow entry covers; without it, the scan runs all the same.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");

test("secret gate on HEAD: every tracked file under data, site and results passes with the commit's own allow list (0 not allowed)", { timeout: 300_000 }, () => {
  const head = spawnSync("/usr/bin/git", ["-C", ROOT, "rev-parse", "--verify", "HEAD"], { encoding: "utf8" });
  assert.equal(head.status, 0, `not a git checkout with a HEAD: ${head.stderr}`);
  const dir = mkdtempSync(join(tmpdir(), "vet402-gate-head-"));
  try {
    const tar = spawnSync("/bin/sh", ["-c", `/usr/bin/git -C "${ROOT}" archive HEAD | /usr/bin/tar -x -C "${dir}"`], { encoding: "utf8" });
    assert.equal(tar.status, 0, `git archive HEAD: ${tar.stderr}`);
    const allow = join(dir, "scripts", "daily", "secret-allow.json");
    assert.ok(existsSync(allow), "the commit carries its allow list");
    const keys = join(ROOT, ".keys");
    const args = [join(ROOT, "scripts", "daily", "secret-gate.ts"), "scan", dir, "data", "site", "results", "--allow", allow, ...(existsSync(keys) ? ["--keys-dir", keys] : [])];
    const r = spawnSync(TSX, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const out = `${r.stdout}${r.stderr}`;
    const summary = /secret gate: (\d+) files, \d+ finding\(s\), (\d+) not allowed/.exec(out);
    assert.ok(summary, `no summary line from the gate:\n${out.slice(-2000)}`);
    assert.ok(Number(summary[1]) > 0, "the scan saw the tree");
    const blocked = out.split("\n").filter((l) => l.startsWith("blocked:"));
    assert.equal(Number(summary[2]), 0, `findings not in scripts/daily/secret-allow.json (add each with its own reason, or take it out of the tree):\n${blocked.join("\n")}`);
    assert.equal(r.status, 0, out.slice(-2000));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
