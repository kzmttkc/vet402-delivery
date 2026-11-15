/**
 * Rank must accept not_settled_hold refusals from Tempo remeasure (plan 3.1).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { annotateTempoInput } from "../src/rank/normalize.js";
import { buildReport, type RankReport } from "../src/rank/report.js";
import { normalizeRemeasure } from "../src/remeasure/normalize.js";
import type { RemeasureRow, ResultFile } from "../src/remeasure/results.js";
import { tempoRow } from "../src/remeasure/tempo.js";
import type { Slot } from "../src/remeasure/loop.js";
import type { Target } from "../src/remeasure/targets.js";
import { FEE_RESERVE_ATOMIC } from "../src/tempo/constants.js";
import type { SellerStats } from "../src/rank/score.js";

const REPO = join(import.meta.dirname, "..");
const SRC_DATA = join(REPO, "data");
const FIXTURE_TEMPO = join(REPO, "test/fixtures/tempo-not-settled-1108/tempo-2026-11-08.json");
const TEMPO_FILE = "tempo-2026-11-08.json";
const TEMPO_LABEL = `remeasure/${TEMPO_FILE.replace(/\.json$/, "")}`;
const FIXTURE_DATE = "2026-11-08";
const HOLD_AT = `${FIXTURE_DATE}T23:00:00.000Z`;
const BAD_AT = `${FIXTURE_DATE}T23:01:00.000Z`;
const SLOW = process.env.VET402_SLOW_TESTS === "1";
// CLI rank uses a copy of data/; only when VET402_SLOW_TESTS=1 (set VET402_SLOW_TESTS=1 to run).
const MANIFEST = SLOW
  ? (JSON.parse(readFileSync(join(SRC_DATA, "manifest.json"), "utf8")) as { date: string; files: { label: string; path: string }[] })
  : null;
const RANK_DATE = MANIFEST?.date ?? FIXTURE_DATE;
const TEMPO_MANIFEST_LABEL = SLOW
  ? MANIFEST!.files
      .map((f) => f.label)
      .filter((l) => /^remeasure\/tempo-\d{4}-\d{2}-\d{2}$/.test(l) && l.slice(-10) <= RANK_DATE)
      .sort()
      .at(-1)!
  : TEMPO_LABEL;
const LATEST_TEMPO = SLOW ? `${TEMPO_MANIFEST_LABEL.slice("remeasure/".length)}.json` : TEMPO_FILE;
const EMPTY_TEMPO_PLAN = { plan: [] as { serviceId: string; request: { url: string; method: string; body: null; contentType: null; inputSource: string } }[] };

function loadFixture(): ResultFile {
  return JSON.parse(readFileSync(FIXTURE_TEMPO, "utf8")) as ResultFile;
}

function slotForRow(r: RemeasureRow): Slot {
  const payTo = r.expectedPayTo;
  const amount = String(Math.round(Number(r.priceUsdc ?? "0") * 1e6));
  const target: Target = {
    chain: "tempo",
    host: r.host,
    service: r.service,
    url: r.url,
    requestUrl: r.requestUrl,
    payTo,
    amountAtomic: amount,
    from: "rank-test",
    tempo: {
      plan: {
        serviceId: r.service ?? r.host,
        request: { url: r.requestUrl, method: "GET", body: null, contentType: null, inputSource: "none" },
        lockedRecipient: payTo,
        lockedAmount: amount,
        sponsored: false,
        allowlist: [],
      },
      feeReserveAtomic: FEE_RESERVE_ATOMIC.toString(),
    },
  };
  return { target, slot: r.slot ?? 0 };
}

function notSettledHoldRow(base: RemeasureRow, at: string): RemeasureRow {
  const s = slotForRow(base);
  return tempoRow(
    s,
    { result: "refused", refusal: { refused: "not_settled_hold", detail: "holdDate=2026-11-08 holdKey=test-hold" } },
    at,
    { key: `${at.slice(0, 10)}|${base.expectedPayTo}|hold-rank`, livePayTo: null, amountAtomic: s.target.amountAtomic },
  );
}

function rankFromTempoFile(file: ResultFile): RankReport {
  const attempts = annotateTempoInput(normalizeRemeasure(file, TEMPO_LABEL), EMPTY_TEMPO_PLAN, "tempo/plan");
  return buildReport({
    date: FIXTURE_DATE,
    generatedAt: `${FIXTURE_DATE}T12:00:00.000Z`,
    attempts,
    excludeHosts: [],
    cdp: new Map(),
    mercator: new Map(),
    inputs: [],
  });
}

function sellerByHost(report: RankReport, host: string): SellerStats | undefined {
  for (const g of report.groups) {
    const s = g.ranking.find((r) => r.host === host);
    if (s) return s;
  }
  return undefined;
}

function buildSymlinkData(tmpRoot: string, tempoFile: ResultFile): string {
  const dataDir = join(tmpRoot, "data");
  const tempoText = JSON.stringify(tempoFile, null, 2) + "\n";
  const tempoSha = createHash("sha256").update(tempoText).digest("hex");
  mkdirSync(dataDir, { recursive: true });
  for (const name of readdirSync(SRC_DATA)) {
    const src = join(SRC_DATA, name);
    const dst = join(dataDir, name);
    if (name === "manifest.json") {
      const manifest = JSON.parse(readFileSync(src, "utf8")) as {
        kind: string;
        date: string;
        files: { label: string; path: string; sha256: string }[];
      };
      for (const f of manifest.files) {
        if (f.label === TEMPO_MANIFEST_LABEL) f.sha256 = tempoSha;
      }
      writeFileSync(dst, `${JSON.stringify(manifest, null, 2)}\n`);
    } else if (name === "remeasure") {
      mkdirSync(dst, { recursive: true });
      for (const f of readdirSync(src)) {
        if (f === LATEST_TEMPO) writeFileSync(join(dst, f), tempoText);
        else symlinkSync(join(src, f), join(dst, f));
      }
    } else {
      symlinkSync(src, dst);
    }
  }
  return dataDir;
}

function runRankCli(dataDir: string, outDir: string): { status: number | null; stderr: string } {
  const r = spawnSync(
    process.execPath,
    ["--import", "tsx", join(REPO, "scripts/rank.ts"), "--data", dataDir, "--offline", "--out", outDir],
    { cwd: REPO, encoding: "utf8" },
  );
  return { status: r.status, stderr: r.stderr };
}

test("not_settled_hold rank normalize: vet402_skipped without throw", () => {
  const base = loadFixture();
  const template = base.rows.find((r) => r.outcome === "sent") ?? base.rows[0]!;
  const hold = notSettledHoldRow(template, HOLD_AT);
  const file: ResultFile = { ...base, rows: [...base.rows, hold] };
  const attempts = normalizeRemeasure(file, TEMPO_LABEL);
  const row = attempts.find((a) => a.rawReason === "not_settled_hold");
  assert.ok(row);
  assert.equal(row!.category, "vet402_skipped");
  assert.equal(row!.tried, false);
});

test("not_settled_hold rank normalize: unknown refusal still throws (fail-loud)", () => {
  const base = loadFixture();
  const template = base.rows.find((r) => r.outcome === "sent") ?? base.rows[0]!;
  const bad = notSettledHoldRow(template, BAD_AT);
  bad.reason = "made_up_reason";
  const file: ResultFile = { ...base, rows: [...base.rows, bad] };
  assert.throws(() => normalizeRemeasure(file, TEMPO_LABEL), /unknown remeasure refusal "made_up_reason"/);
});

test("not_settled_hold rank in process: normalizeRemeasure and buildReport accept a hold refusal row", () => {
  const base = loadFixture();
  const template = base.rows.find((r) => r.outcome === "sent") ?? base.rows[0]!;
  const hold = notSettledHoldRow(template, HOLD_AT);
  const withHold: ResultFile = { ...base, rows: [...base.rows, hold] };
  const attempts = normalizeRemeasure(withHold, TEMPO_LABEL);
  const row = attempts.find((a) => a.rawReason === "not_settled_hold");
  assert.ok(row);
  assert.equal(row!.category, "vet402_skipped");
  assert.equal(row!.tried, false);

  const baseline = rankFromTempoFile(base);
  const withHoldReport = rankFromTempoFile(withHold);
  assert.equal(withHoldReport.totals.tried, baseline.totals.tried);

  const host = hold.host;
  const before = sellerByHost(baseline, host);
  const after = sellerByHost(withHoldReport, host);
  assert.deepEqual(
    after ? { tried: after.tried, counted: after.counted, failuresByRule: after.failuresByRule } : null,
    before ? { tried: before.tried, counted: before.counted, failuresByRule: before.failuresByRule } : null,
    `hold refusal must not increase failure stats for ${host}`,
  );
});

test(
  "not_settled_hold rank CLI: offline rank succeeds with hold refusal row, fails on made_up_reason",
  { skip: SLOW ? false : "slow CLI rank; set VET402_SLOW_TESTS=1 to run" },
  () => {
    const tmp = mkdtempSync(join(tmpdir(), "tempo-ns-rank-"));
    try {
      const base = SLOW
        ? (JSON.parse(readFileSync(join(SRC_DATA, "remeasure", LATEST_TEMPO), "utf8")) as ResultFile)
        : loadFixture();
      const template = base.rows.find((r) => r.outcome === "sent") ?? base.rows[0]!;
      const hold = notSettledHoldRow(template, HOLD_AT);

      const goodFile: ResultFile = { ...base, rows: [...base.rows, hold] };
      const dataGood = buildSymlinkData(join(tmp, "good"), goodFile);
      const outGood = join(tmp, "rank-good");
      mkdirSync(outGood, { recursive: true });
      const ok = runRankCli(dataGood, outGood);
      assert.equal(ok.status, 0, ok.stderr);
      assert.ok(readFileSync(join(outGood, `rank-${RANK_DATE}.json`), "utf8").includes('"kind"'));

      const bad = { ...hold, reason: "made_up_reason" as const };
      const badFile: ResultFile = { ...base, rows: [...base.rows, bad] };
      const dataBad = buildSymlinkData(join(tmp, "bad"), badFile);
      const outBad = join(tmp, "rank-bad");
      mkdirSync(outBad, { recursive: true });
      const fail = runRankCli(dataBad, outBad);
      assert.notEqual(fail.status, 0);
      assert.match(fail.stderr, /unknown remeasure refusal/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
);