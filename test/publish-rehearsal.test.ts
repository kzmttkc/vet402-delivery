/**
 * Rehearsal of the EVM lane publishing on the real readings, before a push. It runs only where the paying lanes'
 * readings are (the results directory beside the key, src/evm/run-dir.ts), on copies: results/evm and data/ are
 * copied into a scratch directory, scripts/evm-publish.ts and scripts/evm-roots-publish.ts write there in the order the
 * daily records run uses, and the lane files must then pass the same check build-site makes (loadLanePublic: no
 * negative result for a seller not told, and no roots leaf the lane page withholds), with no purchase or settled
 * count next to a seller not told. Nothing outside the scratch directory is written.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { payResultsDir } from "../src/evm/run-dir.js";
import { loadLanePublic, rowSeller } from "../src/evm/site.js";
import { notifiedSellers, type NotifiedFile } from "../src/receipt/publish.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESULTS = payResultsDir();
// The scripts run with the scratch directory as cwd, so tsx is named by its path in this checkout.
const TSX = pathToFileURL(createRequire(join(ROOT, "package.json")).resolve("tsx")).href;
const LANES = ["robinhood", "arbitrum"] as const;
const present = LANES.filter((l) => existsSync(join(RESULTS, `${l}-purchases.jsonl`)));

test("rehearsal: the real lane readings make lane pages and roots files that pass build-site's check, with no count next to a seller not told", { skip: present.length ? false : `no lane readings in ${RESULTS}` }, () => {
  const dir = mkdtempSync(join(tmpdir(), "vet402-rehearsal-"));
  try {
    cpSync(RESULTS, join(dir, "results", "evm"), { recursive: true });
    cpSync(join(ROOT, "data"), join(dir, "data"), { recursive: true });
    const tsx = (script: string, args: string[]) => execFileSync(process.execPath, ["--import", TSX, join(ROOT, "scripts", script), ...args], { cwd: dir, stdio: "pipe" });
    for (const lane of present) tsx("evm-publish.ts", ["--lane", lane, "--data", join(dir, "data")]);
    tsx("evm-roots-publish.ts", ["--data", join(dir, "data")]);
    const lanes = loadLanePublic(join(dir, "data")); // throws on a negative row for a seller not told, or a roots leaf the page withholds
    const notified = notifiedSellers(JSON.parse(readFileSync(join(dir, "data", "records", "notified.json"), "utf8")) as NotifiedFile);
    for (const lane of present) {
      const l = lanes[lane];
      assert.ok(l, `data/evm/${lane}.json was written`);
      for (const r of l.rows) {
        if (notified.has(rowSeller(r) ?? "")) continue;
        assert.equal(r.settled, undefined, `${lane}: no settled count next to ${rowSeller(r)} (not told)`);
        if (r.status !== "withheld") assert.equal(r.purchases, undefined, `${lane}: no purchase count next to ${rowSeller(r)} (not told)`);
      }
      for (const h of l.hostRuns ?? []) assert.deepEqual(Object.keys(h).sort(), ["date", "hosts"], "a host run says only its date and host count");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
