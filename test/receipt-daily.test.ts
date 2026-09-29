/**
 * Daily delivery records from the remeasure purchases (scripts/build-receipts.ts --day):
 *  - only rows whose payment was sent, read back on chain and recorded with a tx become records
 *  - the spend ledger written before signing must agree (key, amount; Tempo also recipient, tx, settled)
 *  - the verdict agrees with the ranking's reading of the same row (src/remeasure/normalize.ts)
 *  - nothing the seller sent back (`detail`) reaches a record
 *  - sequence numbers continue across days; a built day is never signed again; an earlier day after a
 *    later one, and the still-open UTC day, are refused
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { assemble, factsFromRemeasure, HASH_NOT_RECORDED_REMEASURE, nextSequence, type RemeasureFile, type RemeasureRowIn, type RemeasureSpend } from "../src/receipt/build.js";
import { normalizeRemeasure } from "../src/remeasure/normalize.js";
import type { Observation } from "../src/receipt/types.js";

const DAY = "2026-09-01";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWxsZXItdG9rZW4ifQ.c2VsbGVyLXNpZ25hdHVyZS14eXo";
const SOL_PAYER = "9VaAPD1CPE4i8pquaRwE7LvZXMmvGdgffD4Q8xJgaQRu";
const TEMPO_PAYER = "0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51";
const account = privateKeyToAccount(generatePrivateKey());
const observer = { id: "did:web:vet402.com#obs-key-test", address: account.address };
const SALT = `0x${"22".repeat(32)}` as Hex;

let n = 0;
function solRow(over: Partial<RemeasureRowIn> = {}, day = DAY): RemeasureRowIn {
  n++;
  const payTo = `So1Pay${String(n).padStart(3, "0")}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`;
  return {
    at: `${day}T08:15:${String(n % 60).padStart(2, "0")}.000Z`,
    chain: "solana",
    url: `https://s${n}.example.com/v1/data`,
    requestUrl: `https://s${n}.example.com/v1/data?symbol=BTC`,
    payTo,
    expectedPayTo: payTo,
    outcome: "sent",
    reason: "sent",
    detail: `{"token":"${JWT}"}`,
    settled: true,
    delivered: true,
    httpStatus: 200,
    bodyBytes: null,
    tx: `${"5".repeat(40)}${String(n).padStart(48, "A")}`,
    priceUsdc: "0.001000",
    key: `${day}|${payTo}|0`,
    ...over,
  };
}
function tempoRow(over: Partial<RemeasureRowIn> = {}, day = DAY): RemeasureRowIn {
  n++;
  const payTo = `0x${String(n).padStart(40, "a")}`;
  return {
    at: `${day}T08:24:${String(n % 60).padStart(2, "0")}.000Z`,
    chain: "tempo",
    url: `https://t${n}.example.com/api`,
    requestUrl: `https://t${n}.example.com/api`,
    payTo,
    expectedPayTo: payTo,
    outcome: "sent",
    reason: "sent",
    detail: JWT,
    settled: true,
    delivered: true,
    httpStatus: 200,
    bodyBytes: 1234,
    tx: `0x${String(n).padStart(64, "b")}`,
    priceUsdc: "0.030000",
    key: `${day}|${payTo}|0`,
    ...over,
  };
}
const file = (chain: "solana" | "tempo", rows: RemeasureRowIn[], day = DAY): RemeasureFile => ({
  kind: "vet402-remeasure",
  version: 1,
  chain,
  date: day,
  payer: chain === "solana" ? SOL_PAYER : TEMPO_PAYER,
  rows,
});
const usdcAtomic = (p: string) => String(Math.round(Number(p) * 1e6));
function solSpends(rows: RemeasureRowIn[]): RemeasureSpend[] {
  return rows.filter((r) => r.outcome === "sent").map((r) => ({ key: r.key, amount: usdcAtomic(r.priceUsdc!), at: r.at }));
}
function tempoSpends(rows: RemeasureRowIn[]): RemeasureSpend[] {
  return rows
    .filter((r) => r.outcome === "sent")
    .map((r) => ({ key: r.key, amount: usdcAtomic(r.priceUsdc!), at: r.at, recipient: r.payTo!.toUpperCase().replace("0X", "0x"), status: "sent", txHash: r.tx, settled: r.settled }));
}

test("remeasure Solana: only sent + settled + tx rows become records; verdicts follow the recorded status", () => {
  const rows = [
    solRow(),
    solRow({ delivered: false }), // 2xx, blank body
    solRow({ delivered: false, httpStatus: 500 }),
    solRow({ delivered: false, httpStatus: 404 }),
    solRow({ outcome: "refused", reason: "price_raised", settled: null, delivered: null, tx: null }),
    solRow({ settled: false, delivered: false, httpStatus: 502 }),
    solRow({ settled: true, tx: null }),
  ];
  const { facts, skips } = factsFromRemeasure(file("solana", rows), "remeasure-solana-test", solSpends(rows));
  assert.equal(facts.length, 4);
  assert.deepEqual(
    skips.map((s) => s.row),
    ["rows[4]", "rows[5]", "rows[6]"],
  );
  const codes = facts.map((f, i) => assemble(f, i + 1, observer, SALT, 1).verdict.code);
  assert.deepEqual(codes, ["DELIVERED", "NOT_DELIVERED", "NOT_DELIVERED", "UNCLEAR"]);
  const o = assemble(facts[0]!, 1, observer, SALT, 1);
  assert.equal(o.payment.amount, "1000");
  assert.equal(o.payment.network, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
  assert.equal(o.resourceUrl, `${new URL(rows[0]!.requestUrl).origin}/v1/data`);
  assert.ok(o.request.params_salted && o.request.params_hash);
  assert.equal(o.source.dataset, "remeasure-solana-test");
});

test("remeasure Tempo: body length decides an empty body; the ledger's recipient is the payTo", () => {
  const rows = [tempoRow(), tempoRow({ bodyBytes: 0, delivered: true }), tempoRow({ bodyBytes: null }), tempoRow({ httpStatus: 402, delivered: false }), tempoRow({ settled: null, tx: null, httpStatus: 500, delivered: false })];
  const spends = tempoSpends(rows);
  const { facts, skips } = factsFromRemeasure(file("tempo", rows), "remeasure-tempo-test", spends);
  assert.equal(facts.length, 4);
  assert.equal(skips.length, 1);
  const obs = facts.map((f, i) => assemble(f, i + 1, observer, SALT, 1));
  assert.deepEqual(
    obs.map((o) => o.verdict.code),
    ["DELIVERED", "NOT_DELIVERED", "DELIVERED", "NOT_DELIVERED"],
  );
  assert.equal(obs[0]!.response.bytes, 1234);
  assert.equal(obs[2]!.response.bytes, null);
  assert.match(obs[2]!.verdict.reason, /body size not recorded/);
  assert.equal(obs[0]!.payment.payTo, spends[0]!.recipient);
  assert.equal(obs[0]!.payment.scheme, "mpp-charge");
  assert.equal(obs[0]!.request.method, null);
  assert.equal(obs[0]!.response.responseHashNote, HASH_NOT_RECORDED_REMEASURE);
  assert.ok(obs[0]!.notRecorded.includes(`response.responseHash: ${HASH_NOT_RECORDED_REMEASURE}`));
  assert.ok(!JSON.stringify(obs).includes("predates"));
});

test("remeasure: a record is DELIVERED exactly when the ranking counts the same row as delivered", () => {
  const sol = [solRow(), solRow({ delivered: false }), solRow({ delivered: false, httpStatus: 503 }), solRow({ delivered: false, httpStatus: 400 })];
  const tem = [tempoRow(), tempoRow({ bodyBytes: 0 }), tempoRow({ bodyBytes: null }), tempoRow({ httpStatus: 422, delivered: false }), tempoRow({ httpStatus: 401, delivered: false, bodyBytes: 0 })];
  for (const [chain, rows, spends] of [
    ["solana", sol, solSpends(sol)],
    ["tempo", tem, tempoSpends(tem)],
  ] as const) {
    const f = file(chain, rows as RemeasureRowIn[]);
    const ranked = normalizeRemeasure({ ...f, rows: f.rows.map((r) => ({ ...r, host: new URL(r.url).hostname, service: null })) }, `remeasure/${chain}`);
    assert.equal(ranked.length, rows.length);
    const { facts } = factsFromRemeasure(f, `remeasure-${chain}`, spends);
    facts.forEach((x, i) => {
      const delivered = assemble(x, i + 1, observer, SALT, 1).verdict.code === "DELIVERED";
      assert.equal(delivered, ranked[i]!.delivered, `${chain} rows[${i}]`);
    });
  }
});

test("remeasure: nothing the seller sent back reaches a record", () => {
  const rows = [solRow(), solRow({ delivered: false, httpStatus: 500 })];
  const t = [tempoRow(), tempoRow({ httpStatus: 404, delivered: false })];
  const all = [
    ...factsFromRemeasure(file("solana", rows), "s", solSpends(rows)).facts,
    ...factsFromRemeasure(file("tempo", t), "t", tempoSpends(t)).facts,
  ].map((f, i) => JSON.stringify(assemble(f, i + 1, observer, SALT, 1)));
  for (const text of all) {
    assert.ok(!text.includes("eyJ"), "no JWT piece");
    assert.ok(!text.includes("token"), "no body text");
    assert.ok(!text.includes("/Users/") && !text.includes("results/remeasure"), "no local path");
  }
});

test("remeasure: the spend ledger must agree, or nothing is built", () => {
  const r = solRow();
  const f = file("solana", [r]);
  assert.throws(() => factsFromRemeasure(f, "s", []), /no spend ledger entry/);
  assert.throws(() => factsFromRemeasure(f, "s", [{ key: r.key, amount: "2000", at: r.at }]), /differs from the ledger amount/);
  const moved = solRow();
  assert.throws(() => factsFromRemeasure(file("solana", [{ ...moved, expectedPayTo: "Else1111111111111111111111111111111111111" }]), "s", solSpends([moved])), /locked/);
  assert.throws(() => factsFromRemeasure(file("solana", [solRow({}, "2026-09-02")]), "s", []), /is not on 2026-09-01/);
  const t = tempoRow();
  const good = tempoSpends([t]);
  assert.throws(() => factsFromRemeasure(file("tempo", [t]), "t", [{ ...good[0]!, txHash: `0x${"c".repeat(64)}` }]), /does not show this tx settled/);
  assert.throws(() => factsFromRemeasure(file("tempo", [t]), "t", [{ ...good[0]!, settled: false }]), /does not show this tx settled/);
  assert.throws(() => factsFromRemeasure(file("tempo", [t]), "t", [{ ...good[0]!, recipient: `0x${"d".repeat(40)}` }]), /ledger recipient/);
  assert.throws(() => factsFromRemeasure(file("tempo", [t]), "t", [...good, ...good]), /twice/);
  assert.throws(() => factsFromRemeasure({ ...file("tempo", [t]), kind: "census" }, "t", good), /not a vet402-remeasure/);
});

test("nextSequence continues the observer's numbers and refuses a rebuilt, earlier or broken history", () => {
  const a = account.address;
  const recs = (from: number, to: number, address = a) => Array.from({ length: to - from + 1 }, (_, i) => ({ address, sequence: from + i }));
  assert.equal(nextSequence([], "2026-09-29", a), 1);
  assert.equal(nextSequence([{ day: "2026-09-28", records: recs(1, 165) }], "2026-09-29", a), 166);
  assert.equal(nextSequence([{ day: "2026-09-28", records: recs(1, 165) }], "2026-09-29", a.toLowerCase()), 166);
  assert.equal(nextSequence([{ day: "2026-09-28", records: [...recs(1, 3), ...recs(1, 9, "0x0000000000000000000000000000000000000001")] }], "2026-09-29", a), 4);
  assert.throws(() => nextSequence([{ day: "2026-09-29", records: recs(1, 3) }], "2026-09-29", a), /already built/);
  assert.throws(() => nextSequence([{ day: "2026-09-30", records: recs(1, 3) }], "2026-09-29", a), /is earlier/);
  assert.throws(() => nextSequence([{ day: "2026-09-28", records: [...recs(1, 3), ...recs(5, 6)] }], "2026-09-29", a), /not 1\.\.5/);
  assert.throws(() => nextSequence([{ day: "2026-09-27", records: recs(1, 3) }, { day: "2026-09-28", records: recs(3, 4) }], "2026-09-29", a), /not 1\.\.5/);
});

// ---------- the script, end to end, on a temporary folder (no network: no --simulate-anchor) ----------

function contents(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir)) out[f] = readFileSync(join(dir, f), "utf8");
  return out;
}

test("build-receipts --day: continues sequences, never re-signs a built day, refuses an earlier or open day, keeps seller text out", () => {
  const root = mkdtempSync(join(tmpdir(), "daily-rec-"));
  try {
    const rm = join(root, "remeasure");
    const out = join(root, "receipts");
    const key = join(root, "attest.json");
    writeFileSync(key, JSON.stringify({ privateKey: generatePrivateKey() }), { mode: 0o600 });
    const budget: RemeasureSpend[] = [];
    const days = ["2026-09-01", "2026-09-02"];
    mkdirSync(rm, { recursive: true });
    for (const d of days) {
      const s = [solRow({}, d), solRow({ delivered: false, httpStatus: 500 }, d), solRow({ outcome: "refused", reason: "price_raised", settled: null, delivered: null, tx: null }, d)];
      const t = [tempoRow({}, d), tempoRow({ httpStatus: 404, delivered: false }, d)];
      budget.push(...solSpends(s));
      writeFileSync(join(rm, `solana-${d}.json`), JSON.stringify(file("solana", s, d)));
      writeFileSync(join(rm, `tempo-${d}.json`), JSON.stringify(file("tempo", t, d)));
      writeFileSync(
        join(rm, `tempo-ledger-${d}.json`),
        JSON.stringify({ version: 1, payer: TEMPO_PAYER, capAtomic: "1000000", entries: tempoSpends(t).map((e) => ({ ...e, reservedAt: e.at })) }),
      );
    }
    writeFileSync(join(rm, "budget-solana-2026-09.json"), JSON.stringify({ baselineAtomic: "0", spentAtomic: "0", purchases: budget }));
    const run = (...extra: string[]) =>
      spawnSync(process.execPath, ["--import", "tsx", "scripts/build-receipts.ts", "--key", key, "--out", out, "--remeasure-dir", rm, ...extra], {
        cwd: join(import.meta.dirname, ".."),
        encoding: "utf8",
      });

    const r1 = run("--day", "2026-09-01");
    assert.equal(r1.status, 0, r1.stderr);
    const r2 = run("--day", "2026-09-02");
    assert.equal(r2.status, 0, r2.stderr);
    const seqs = (d: string) =>
      readdirSync(join(out, d))
        .filter((f) => /^obs_.*\.json$/.test(f))
        .map((f) => (JSON.parse(readFileSync(join(out, d, f), "utf8")) as Observation).observer.sequence)
        .sort((a, b) => a - b);
    assert.deepEqual(seqs("2026-09-01"), [1, 2, 3, 4]);
    assert.deepEqual(seqs("2026-09-02"), [5, 6, 7, 8]);
    const idx = JSON.parse(readFileSync(join(out, "2026-09-02", "anchor-plan.json"), "utf8")) as { sequenceRange: number[]; memo: string };
    assert.deepEqual(idx.sequenceRange, [5, 8]);
    assert.match(idx.memo, /day=2026-09-02 .* n=4 seq=5-8 /);

    const before = contents(join(out, "2026-09-01"));
    const again = run("--day", "2026-09-01");
    assert.equal(again.status, 2);
    assert.match(again.stderr, /already built/);
    assert.deepEqual(contents(join(out, "2026-09-01")), before);
    const earlier = run("--day", "2026-08-31");
    assert.equal(earlier.status, 2);
    assert.match(earlier.stderr, /is earlier/);
    const today = run("--day", new Date().toISOString().slice(0, 10));
    assert.equal(today.status, 2);
    assert.match(today.stderr, /still open/);
    const first = run("--solana", join(rm, "solana-2026-09-01.json"));
    assert.equal(first.status, 2);
    assert.match(first.stderr, /--day builds from the remeasure results only|already holds/);

    for (const d of days)
      for (const f of readdirSync(join(out, d))) {
        const text = readFileSync(join(out, d, f), "utf8");
        assert.ok(!text.includes("eyJ"), `${d}/${f}: JWT piece`);
        assert.ok(!text.includes(root), `${d}/${f}: local path`);
      }
    assert.ok(!readdirSync(out).some((f) => f.endsWith(".partial")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

