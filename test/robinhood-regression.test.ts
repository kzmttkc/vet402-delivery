/**
 * 3.1b Robinhood Chain regression (REQUIREMENTS_AND_PLAN §3.1b): the daily records lane must not publish a daily
 * root that disagrees with the lane page's withholding rules. Fixtures are copies of results/evm/ and data/ from
 * 2026-11-08 (no new purchases, no signatures). Four stages: buy (purchases.jsonl), verify (chaincheck.jsonl),
 * publish (evm-publish.ts), daily root (evm-roots-publish.ts); then the same check as build-site (loadLanePublic).
 *
 * The 2026-11-08 stop (records halted when roots on main showed purchases the refreshed lane page withholds) is
 * covered by refreshing the roots file after the lane page in the same run (commit a7c78259). Skipping that refresh
 * must fail loadLanePublic even when publish succeeds.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadLanePublic, rowSeller } from "../src/evm/site.js";
import { notifiedSellers, type NotifiedFile } from "../src/receipt/publish.js";
import {
  assertRobinhoodFixtureJsonlClean,
  redactEvmPurchaseJsonl,
  redactEvmPurchaseRecord,
} from "./robinhood-fixture-redact.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(ROOT, "test/fixtures/robinhood-regression-1108");
const TSX = pathToFileURL(createRequire(join(ROOT, "package.json")).resolve("tsx")).href;

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "vet402-rh-regression-"));
  cpSync(join(FIXTURE, "results"), join(dir, "results"), { recursive: true });
  cpSync(join(FIXTURE, "data"), join(dir, "data"), { recursive: true });
  for (const name of ["robinhood-purchases.jsonl", "robinhood-chaincheck.jsonl"] as const) {
    const p = join(dir, "results", "evm", name);
    writeFileSync(p, redactEvmPurchaseJsonl(readFileSync(p, "utf8")));
  }
  return dir;
}

function tsx(cwd: string, script: string, args: string[]): void {
  execFileSync(process.execPath, ["--import", TSX, join(ROOT, "scripts", script), ...args], { cwd, stdio: "pipe" });
}

function buyAndVerify(dir: string): void {
  const purchases = join(dir, "results", "evm", "robinhood-purchases.jsonl");
  const chaincheck = join(dir, "results", "evm", "robinhood-chaincheck.jsonl");
  assert.ok(existsSync(purchases), "buy: robinhood-purchases.jsonl from the real lane");
  assert.ok(existsSync(chaincheck), "verify: robinhood-chaincheck.jsonl from the chain check");
  const sent = readFileSync(purchases, "utf8").trim().split("\n").filter(Boolean);
  const checked = readFileSync(chaincheck, "utf8").trim().split("\n").filter(Boolean);
  assert.ok(sent.length > 0 && checked.length > 0, "non-empty purchase and chain-check readings");
  assert.equal(sent.length, checked.length, "one chain-check line per sent purchase");
  for (const line of sent) assert.equal(JSON.parse(line).outcome, "sent");
}

function publishRobinhood(dir: string): void {
  tsx(dir, "evm-publish.ts", ["--lane", "robinhood", "--data", join(dir, "data")]);
}

function publishRoots(dir: string): void {
  tsx(dir, "evm-roots-publish.ts", ["--data", join(dir, "data")]);
}

/** Lane page older than today's publish rules: withhold a purchase the daily roots file still shows (2026-11-08 class). */
function staleWithholdingPage(dataDir: string): void {
  const f = join(dataDir, "evm", "robinhood.json");
  const page = JSON.parse(readFileSync(f, "utf8")) as { rows: Record<string, unknown>[] };
  const row = page.rows.find((r) => (r.hosts as string[] | undefined)?.includes("hosaka-agents.vercel.app"));
  assert.ok(row, "hosaka-agents row on the committed lane page");
  Object.assign(row, {
    status: "withheld",
    cause: null,
    settlementTx: null,
    paidRequestMs: null,
    relayer: null,
    chainCheck: undefined,
    purchases: undefined,
    paymentResponseHeader: undefined,
  });
  writeFileSync(f, JSON.stringify(page, null, 2) + "\n");
}

function assertBuildSiteOk(dir: string): void {
  const lanes = loadLanePublic(join(dir, "data"));
  const l = lanes.robinhood;
  assert.ok(l, "data/evm/robinhood.json");
  assert.ok(l.roots, "data/evm/roots/robinhood.json");
  const notified = notifiedSellers(JSON.parse(readFileSync(join(dir, "data", "records", "notified.json"), "utf8")) as NotifiedFile);
  for (const r of l.rows) {
    if (notified.has(rowSeller(r) ?? "")) continue;
    assert.equal(r.settled, undefined, `no settled count next to ${rowSeller(r)} (not told)`);
    if (r.status !== "withheld") assert.equal(r.purchases, undefined, `no purchase count next to ${rowSeller(r)} (not told)`);
  }
  const day1108 = l.roots.days.find((d) => d.day === "2026-11-08");
  assert.ok(day1108, "2026-11-08 host-run day is in the daily roots file");
}

test("3.1b Robinhood: fixture jsonl copies hold no EIP-3009 signature or authorization hex", () => {
  assertRobinhoodFixtureJsonlClean(FIXTURE);
});

test("3.1b Robinhood: copying purchases redacts authorization before the scratch run", () => {
  const raw = JSON.parse(
    readFileSync(join(FIXTURE, "results", "evm", "robinhood-purchases.jsonl"), "utf8").trim().split("\n")[21]!,
  ) as Record<string, unknown>;
  const red = redactEvmPurchaseRecord(raw);
  assert.equal(red.authorization, undefined);
  assert.doesNotMatch(JSON.stringify(red), /0x[0-9a-fA-F]{64}/);
});

test("3.1b Robinhood: buy, verify, publish, daily root on real copies pass build-site's check", () => {
  const dir = scratch();
  try {
    buyAndVerify(dir);
    publishRobinhood(dir);
    publishRoots(dir);
    assertBuildSiteOk(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("3.1b Robinhood: a stale lane page beside the daily roots file stops build-site (2026-11-08 mismatch class)", () => {
  const dir = scratch();
  try {
    buyAndVerify(dir);
    staleWithholdingPage(join(dir, "data"));
    assert.throws(() => loadLanePublic(join(dir, "data")), /shown here but withheld on the lane page/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("3.1b Robinhood: evm-roots-publish --check exit 10 when the lane page is stale (daily refresh signal)", () => {
  const dir = scratch();
  try {
    buyAndVerify(dir);
    staleWithholdingPage(join(dir, "data"));
    let code = 0;
    let out = "";
    try {
      out = execFileSync(process.execPath, ["--import", TSX, join(ROOT, "scripts", "evm-roots-publish.ts"), "--data", join(dir, "data"), "--check"], {
        cwd: dir,
        encoding: "utf8",
      });
    } catch (e) {
      code = (e as NodeJS.ErrnoException & { status?: number }).status ?? 1;
      out = String((e as { stdout?: string }).stdout ?? "");
    }
    assert.equal(code, 10);
    assert.match(out, /robinhood: would change/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("3.1b Robinhood: publish then roots refresh clears the stale page mismatch", () => {
  const dir = scratch();
  try {
    buyAndVerify(dir);
    staleWithholdingPage(join(dir, "data"));
    assert.throws(() => loadLanePublic(join(dir, "data")), /shown here but withheld on the lane page/);
    publishRobinhood(dir);
    publishRoots(dir);
    assertBuildSiteOk(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
