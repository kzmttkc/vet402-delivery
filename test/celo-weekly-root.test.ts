/**
 * Celo weekly DeliveryRoots: leaves from export.csv, week boundaries, plan/send guards.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { recordDigest } from "../src/evm/evm-anchor.js";
import { verifyInclusion } from "../src/receipt/merkle.js";
import {
  amountFromExport,
  inWeek,
  lastClosedWeekSunday,
  parseCeloExport,
  publicLeafFromExport,
  rowsForWeek,
  saltFromCeloExport,
  weekRootFromRows,
  weekSundayOf,
  buildCeloRootsFile,
  celoRootsFileProblems,
  CELO_REGISTRY,
  type CeloSentWeek,
} from "../src/evm/celo-roots.js";
import { getAddress, type Hex } from "viem";

const ROOT = new URL("..", import.meta.url).pathname;
const FIXTURE = join(ROOT, "test/fixtures/celo-weekly-export.csv");
const TX = (b: string) => (`0x${b.repeat(64)}`.slice(0, 66)) as Hex;

test("amountAtomic uses confirmed_units only when positive", () => {
  assert.equal(amountFromExport({ confirmed_units: "100", spent_units: "200" } as Parameters<typeof amountFromExport>[0]), "100");
  assert.equal(amountFromExport({ confirmed_units: "0", spent_units: "20000" } as Parameters<typeof amountFromExport>[0]), null);
  assert.equal(amountFromExport({ confirmed_units: "", spent_units: "500" } as Parameters<typeof amountFromExport>[0]), null);
});

test("week boundaries: Mon 00:00 through Sun 23:59:59 in week ending Sunday", () => {
  const sun = "2026-11-08";
  assert.equal(weekSundayOf("2026-11-03T10:00:00Z"), sun);
  assert.ok(inWeek("2026-11-02T00:00:00Z", sun));
  assert.ok(inWeek("2026-11-08T23:59:59Z", sun));
  assert.ok(!inWeek("2026-11-09T00:00:00Z", sun));
  assert.ok(!inWeek("2026-11-01T23:59:59Z", sun));
});

test("leaves and root are fixed by export.csv rows alone", () => {
  const rows = parseCeloExport(readFileSync(FIXTURE, "utf8"));
  const picked = rowsForWeek(rows, "2026-11-08");
  assert.equal(picked.length, 3);
  const a = weekRootFromRows("2026-11-08", picked, "2026-11-09T00:00:01Z");
  const b = weekRootFromRows("2026-11-08", picked, "2026-11-09T00:00:01Z");
  assert.equal(a.root.root, b.root.root);
  assert.equal(a.root.n, 3);
  assert.equal(a.salts[picked[0]!.purchase_id], saltFromCeloExport(picked[0]!));
  for (let i = 0; i < 3; i++) assert.ok(verifyInclusion(recordDigest(a.root.leaves[i]), a.root.proofs[i]!, a.root.root));
  const leaf0 = publicLeafFromExport(picked[0]!, saltFromCeloExport(picked[0]!));
  assert.equal(leaf0.method, "GET");
  assert.equal(leaf0.chainCheck, "transfer_found");
  assert.equal(publicLeafFromExport(picked[1]!, saltFromCeloExport(picked[1]!)).method, "POST");
  assert.equal(a.root.root, "0xbc4c6d156f8476aea9aae0300540fc62e2a85ac692234b417a7bd7fa252b0277");
});

test("open week is refused", () => {
  const rows = parseCeloExport(readFileSync(FIXTURE, "utf8"));
  const picked = rowsForWeek(rows, "2026-11-08");
  assert.throws(() => weekRootFromRows("2026-11-08", picked, "2026-11-08T12:00:00Z"), /not over/);
});

test("lastClosedWeekSunday matches fixture week", () => {
  assert.equal(lastClosedWeekSunday(new Date("2026-11-09T00:00:01Z")), "2026-11-08");
});

test("plan without --send writes plan and salts; --send without VET402_ANCHOR_SEND refuses", () => {
  const dir = mkdtempSync(join(tmpdir(), "celo-plan-"));
  const anchors = join(dir, "anchors");
  const r1 = spawnSync("npx", ["tsx", join(ROOT, "scripts/celo-weekly-root.ts"), "--csv", FIXTURE, "--week", "2026-11-08", "--anchors-dir", anchors], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, VET402_DAILY_NOW: String(Date.parse("2026-11-09T00:00:01Z") / 1000) },
  });
  assert.equal(r1.status, 0, r1.stderr);
  const plan = JSON.parse(r1.stdout);
  assert.equal(plan.n, 3);
  assert.ok(existsSync(join(anchors, "celo-week-2026-11-08.plan.json")));
  assert.ok(existsSync(join(anchors, "celo-week-2026-11-08.salts.json")));
  const r2 = spawnSync("npx", ["tsx", join(ROOT, "scripts/celo-weekly-root.ts"), "--csv", FIXTURE, "--week", "2026-11-08", "--send", "--anchors-dir", anchors], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, VET402_DAILY_NOW: String(Date.parse("2026-11-09T00:00:01Z") / 1000) },
  });
  assert.match(r2.stderr + r2.stdout, /VET402_ANCHOR_SEND=celo/);
  rmSync(dir, { recursive: true });
});

test("double send is refused when sent.json is already sent", () => {
  const dir = mkdtempSync(join(tmpdir(), "celo-sent-"));
  const anchors = join(dir, "results", "evm", "anchors");
  mkdirSync(anchors, { recursive: true });
  writeFileSync(
    join(anchors, "celo-week-2026-11-08.sent.json"),
    JSON.stringify({
      lane: "celo",
      week: "2026-11-08",
      root: "0x" + "aa".repeat(32),
      n: 1,
      status: "sent",
      hash: TX("f"),
      registry: CELO_REGISTRY,
      leaves: [],
    }) + "\n",
    { mode: 0o600 },
  );
  chmodSync(join(anchors, "celo-week-2026-11-08.sent.json"), 0o600);
  const r = spawnSync(
    "npx",
    ["tsx", join(ROOT, "scripts/celo-weekly-root.ts"), "--csv", FIXTURE, "--week", "2026-11-08", "--send"],
    { cwd: dir, encoding: "utf8", env: { ...process.env, VET402_ANCHOR_SEND: "celo", VET402_DAILY_NOW: String(Date.parse("2026-11-09T00:00:01Z") / 1000) } },
  );
  assert.equal(r.status, 0);
  assert.match(r.stdout, /already sent/);
  rmSync(dir, { recursive: true });
});

test("--send rejects --csv", () => {
  const r = spawnSync("npx", ["tsx", join(ROOT, "scripts/celo-weekly-root.ts"), "--csv", FIXTURE, "--week", "2026-11-08", "--send"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, VET402_ANCHOR_SEND: "celo", VET402_DAILY_NOW: String(Date.parse("2026-11-09T00:00:01Z") / 1000) },
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /omit --csv/);
});

test("buildCeloRootsFile validates proofs", () => {
  const rows = parseCeloExport(readFileSync(FIXTURE, "utf8"));
  const { root } = weekRootFromRows("2026-11-08", rowsForWeek(rows, "2026-11-08"), "2026-11-09T00:00:01Z");
  const sent: CeloSentWeek = {
    lane: "celo",
    week: "2026-11-08",
    root: root.root,
    n: root.n,
    status: "sent",
    hash: TX("e"),
    block: "1",
    registry: getAddress(CELO_REGISTRY),
    leaves: root.leaves,
  };
  const f = buildCeloRootsFile([sent], null);
  assert.equal(celoRootsFileProblems(f).length, 0);
  assert.equal(f.days[0]!.published, 3);
});
