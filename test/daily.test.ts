/**
 * scripts/daily: the secret gate, the pay/publish decisions, and run.sh itself.
 *
 * The raw result files of 2026-09-28 and 2026-09-29 stay on the runner's machine (they hold the token the
 * public copies redact), so the tests that compare raw -> public skip where those files are absent.
 * run.sh is exercised against a throwaway git repository whose npm scripts stand in for remeasure and rank:
 * nothing here pays, signs, sends or pushes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  blockingFindings,
  loadAllowList,
  ownKeyNeedles,
  publicJson,
  redactKnown,
  scanFileText,
  scanTree,
  SELLER_TOKEN_REDACTION,
  type Finding,
} from "../src/daily/secret-gate.js";
import { commitMessage, planVerdict, redactionNote, runOutcome, updateManifest } from "../src/daily/steps.js";

const ROOT = resolve(import.meta.dirname, "..");
const DATA = join(ROOT, "data");
const ALLOW = join(ROOT, "scripts", "daily", "secret-allow.json");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const RAW_SOLANA_0929 = join(homedir(), "vet402-solana", "results", "remeasure", "solana-2026-09-29.json");
const RAW_TEMPO_0929 = join(homedir(), "vet402-solana", "results", "remeasure", "tempo-2026-09-29.json");
const RAW_CENSUS_0928 = join(homedir(), "vet402-solana-census", "results", "census-2026-09-28.json");
const noRaw = (p: string) => (existsSync(p) ? false : `${p} is only on the runner's machine`);
const read = (p: string) => readFileSync(p, "utf8");
const gateCli = (...args: string[]) => spawnSync(TSX, [join(ROOT, "scripts", "daily", "secret-gate.ts"), ...args], { encoding: "utf8" });
const stepsCli = (...args: string[]) => spawnSync(TSX, [join(ROOT, "scripts", "daily", "steps.ts"), ...args], { encoding: "utf8" });
const tmp = () => mkdtempSync(join(tmpdir(), "vet402-daily-"));
const scan = (text: string, name = "x.json") => blockingFindings(scanFileText(text, name), loadAllowList(ALLOW));
const kinds = (fs: Finding[]) => fs.map((f) => f.kind);

// ---------- the secret gate on the real data ----------

test("gate: the 2026-09-29 Solana result becomes the published copy byte for byte; the two token rows are redacted", { skip: noRaw(RAW_SOLANA_0929) }, () => {
  const { value, redactions } = redactKnown(JSON.parse(read(RAW_SOLANA_0929)));
  assert.equal(publicJson(value), read(join(DATA, "remeasure", "solana-2026-09-29.json")));
  assert.deepEqual(redactions, [
    { path: "rows[4].detail", what: "seller-token" },
    { path: "rows[192].detail", what: "seller-token" },
  ]);
  const dir = tmp();
  const r = gateCli("copy", RAW_SOLANA_0929, join(dir, "solana-2026-09-29.json"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(join(dir, "solana-2026-09-29.json")), read(join(DATA, "remeasure", "solana-2026-09-29.json")));
  assert.deepEqual(JSON.parse(r.stdout).redactions.length, 2);
  rmSync(dir, { recursive: true });
});

test("gate: the 2026-09-29 Tempo result is published unchanged (nothing to redact)", { skip: noRaw(RAW_TEMPO_0929) }, () => {
  const { value, redactions } = redactKnown(JSON.parse(read(RAW_TEMPO_0929)));
  assert.equal(publicJson(value), read(join(DATA, "remeasure", "tempo-2026-09-29.json")));
  assert.deepEqual(redactions, []);
});

test("gate: the 2026-09-28 census gets the same redactions as the published copy, rows[17] included", { skip: noRaw(RAW_CENSUS_0928) }, () => {
  const raw = JSON.parse(read(RAW_CENSUS_0928));
  const { value, redactions } = redactKnown(raw);
  assert.deepEqual(value, JSON.parse(read(join(DATA, "solana", "census-2026-09-28.json"))));
  assert.deepEqual(redactions, [
    { path: "ledger", what: "local-path" },
    { path: "rows[17].first300", what: "seller-token" },
    { path: "records[17].response.first300", what: "seller-token" },
  ]);
  // The copy published before f61bb07 left rows[17] as it was: the gate stops on it (a known shape left in).
  const before = JSON.parse(read(join(DATA, "solana", "census-2026-09-28.json")));
  before.rows[17].first300 = raw.rows[17].first300;
  const block = scan(JSON.stringify(before, null, 2), "solana/census-2026-09-28.json");
  assert.equal(block.length, 1);
  assert.equal(block[0]!.path, "rows[17].first300");
  assert.equal(block[0]!.kind, "jwt");
  assert.equal(block[0]!.known, true);
});

test("gate: the published copies carry the redaction wording where the tokens were", () => {
  const sol = JSON.parse(read(join(DATA, "remeasure", "solana-2026-09-29.json")));
  for (const i of [4, 192]) assert.ok(sol.rows[i].detail.endsWith(SELLER_TOKEN_REDACTION), `rows[${i}]`);
  const census = JSON.parse(read(join(DATA, "solana", "census-2026-09-28.json")));
  assert.equal(census.rows[17].first300, census.records[17].response.first300);
  assert.ok(census.rows[17].first300.includes(SELLER_TOKEN_REDACTION));
});

test("gate: the whole public tree (data/, site/) passes with the allow list; every allowed value is still there", () => {
  const { files, findings } = scanTree(ROOT, ["data", "site"]);
  assert.ok(files > 500, `scanned ${files} files`);
  const allow = loadAllowList(ALLOW);
  assert.deepEqual(blockingFindings(findings, allow).map((f) => `${f.file} ${f.path} ${f.kind}`), []);
  const seen = new Set(findings.map((f) => `${f.kind}:${f.sha256}`));
  for (const a of allow) assert.ok(seen.has(`${a.kind}:${a.sha256}`), `allow entry ${a.sha256.slice(0, 12)} matches nothing: remove it`);
});

// ---------- the secret gate: what stops ----------

const b64 = (n: number) => randomBytes(n).toString("base64url");
function withDetail(detail: string, field = "detail"): string {
  return JSON.stringify({ kind: "vet402-remeasure", rows: [{ host: "seller.example", [field]: detail }] }, null, 2);
}

test("gate: each unknown credential shape stops, alone", () => {
  const secret = `Zq8${b64(30)}`;
  const cases: [string, string, string][] = [
    ["jwt outside a response body", withDetail(`eyJhbGciOiJIUzI1NiJ9.${b64(40)}.${b64(20)}`, "input"), "jwt"],
    ["bearer", withDetail(`{"note":"use Authorization: Bearer ${secret}"}`), "bearer"],
    ["api key in a URL query", withDetail(`see https://api.example.com/v1/x?api_key=${secret}&q=1`), "url-query-secret"],
    ["session id field", withDetail(`{"session_id":"${secret}","ok":true}`), "secret-field"],
    ["password field", withDetail(`{"user":"a","password":"Pw${b64(18)}"}`), "secret-field"],
    ["token-named JSON key", JSON.stringify({ rows: [{ access_token: secret }] }), "secret-field"],
    ["opaque 40+", withDetail(`{"id":"${b64(48)}"}`), "opaque-40"],
    // A random token holding - or _ is not a slug of harmless parts.
    ["session token with dashes", withDetail(`{"session":"Zq8Kx9Lm-3Pq7Rt2Vw-5Yb8Nc1Df4Gh-6Jk2Mn"}`), "secret-field"],
    ["opaque 40+ with dashes", withDetail(`{"ref":"Zq8Kx9Lm3P-q7Rt2Vw5Yb8N_c1Df4Gh6Jk2Mn4Pq7Rs"}`), "opaque-40"],
    ["local path", withDetail(`{"file":"/home/runner/.keys/payer.json"}`), "local-path"],
    ["vendor key", withDetail(`{"k":"sk_live_${randomBytes(12).toString("hex")}Ab"}`), "vendor-key"],
    ["private key block", withDetail("-----BEGIN PRIVATE KEY-----\\nMIIE"), "private-key-block"],
  ];
  for (const [what, text, kind] of cases) {
    const block = scan(text);
    assert.ok(kinds(block).includes(kind as Finding["kind"]), `${what}: ${JSON.stringify(kinds(block))}`);
  }
});

test("gate: public shapes do not stop (addresses, signatures, hashes, ids, words)", () => {
  const detail = JSON.stringify({
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    token: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    tx: "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW",
    evm: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    hash: "bac028774b9f783fa6841b80bf99ef70179857ac7779686cb979f1c45811ca5f",
    uuid: "299de0e8-cfd8-4343-8fff-9fdd698b68df",
    algo: "GD64YIY3TWGDMCNPP553DZPPR6LDUSFQOIJVFDPPXWEG3FVOJCCDBBHU5A",
    cid: "https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    pool: "eth_0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
    words: "Strait of Hormuz traffic returns to normal by December 31?",
    url: "https://api.solsentry.app/v1/check?mint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&token=So11111111111111111111111111111111111111112",
    redacted: `{"auth":{"id_token":"${SELLER_TOKEN_REDACTION}`,
  });
  assert.deepEqual(scan(withDetail(detail)), []);
  // a mint cut short at the 300-character body limit, under a token-named key
  assert.deepEqual(scan(withDetail(`${"x".repeat(270)}{"mint":"DezXAZ8z7Pnr","token":"DezXAZ8z7PnrnRJj`)), []);
});

test("gate: copy refuses a result with an unknown shape and writes nothing", { skip: noRaw(RAW_SOLANA_0929) }, () => {
  const dir = tmp();
  const raw = JSON.parse(read(RAW_SOLANA_0929));
  raw.rows[10].detail = `{"session":"${b64(33)}Q9","user":"vet402"}`;
  writeFileSync(join(dir, "in.json"), JSON.stringify(raw));
  const out = join(dir, "out", "solana-2026-09-29.json");
  const r = gateCli("copy", join(dir, "in.json"), out);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /blocked: solana-2026-09-29\.json rows\[10\]\.detail secret-field/);
  assert.ok(!existsSync(out));
  assert.ok(!r.stderr.includes(raw.rows[10].detail.slice(12, 40)), "the value is never printed");
  rmSync(dir, { recursive: true });
});

test("gate: copy redacts a seller token in a body and passes the rest", () => {
  const dir = tmp();
  const jwt = `eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ.${b64(120)}`;
  writeFileSync(join(dir, "in.json"), JSON.stringify({ rows: [{ detail: `{"auth":{"id_token":"${jwt}` }, { detail: "ok" }] }));
  const r = gateCli("copy", join(dir, "in.json"), join(dir, "out.json"));
  assert.equal(r.status, 0, r.stderr);
  const out = read(join(dir, "out.json"));
  assert.ok(!out.includes(jwt));
  assert.equal(JSON.parse(out).rows[0].detail, `{"auth":{"id_token":"${SELLER_TOKEN_REDACTION}`);
  assert.deepEqual(JSON.parse(r.stdout).redactions, [{ path: "rows[0].detail", what: "seller-token" }]);
  rmSync(dir, { recursive: true });
});

test("gate: the runner's own key in any encoding stops and can never be allowed", () => {
  const dir = tmp();
  const secret = randomBytes(64);
  writeFileSync(join(dir, "payer.json"), JSON.stringify([...secret]));
  const needles = ownKeyNeedles(dir);
  assert.ok(needles.length >= 4);
  for (const n of needles) {
    const found = scanFileText(withDetail(`{"x":"${n}"}`), "x.json", { ownKeys: needles });
    assert.ok(kinds(blockingFindings(found, [{ sha256: found[0]!.sha256, kind: "own-key", reason: "no" }])).includes("own-key"));
  }
  writeFileSync(join(dir, "allow.json"), JSON.stringify({ kind: "vet402-secret-gate-allow", allow: [{ sha256: "a".repeat(64), kind: "own-key", reason: "x" }] }));
  assert.throws(() => loadAllowList(join(dir, "allow.json")), /can never be allowed/);
  writeFileSync(join(dir, "allow.json"), JSON.stringify({ kind: "vet402-secret-gate-allow", allow: [{ sha256: "a".repeat(64), kind: "jwt", reason: " " }] }));
  assert.throws(() => loadAllowList(join(dir, "allow.json")), /needs a sha256 and a reason/);
  rmSync(dir, { recursive: true });
});

// ---------- decisions ----------

const plan = (o: { chain?: string; day?: string; per?: number; would?: number; est?: string; perRun?: string; monthLeft?: string; bal?: string } = {}) => ({
  kind: "vet402-remeasure-dry-run",
  chain: o.chain ?? "solana",
  createdAt: `${o.day ?? "2026-10-01"}T01:17:30.000Z`,
  perPayTo: o.per ?? 1,
  caps: { perPurchase: "0.100000", perRun: o.perRun ?? "3.000000", perMonth: "30.000000", monthLeft: o.monthLeft ?? "25.000000" },
  summary: { would: o.would ?? 93, estimate: o.est ?? "1.133000", payerUsdcBefore: o.bal ?? "45.000000", payerUsdcEBefore: o.bal ?? "16.000000" },
});

test("plan: pays within the caps; stops over the run cap, the month, the balance, or on another day's plan", () => {
  assert.equal(planVerdict(plan(), "solana", "2026-10-01", 1).pay, true);
  const stops: [ReturnType<typeof plan>, RegExp][] = [
    [plan({ est: "3.500000" }), /over the run cap 3\.000000/],
    [plan({ est: "2.000000", monthLeft: "1.500000" }), /over what is left this month/],
    [plan({ est: "2.000000", bal: "1.000000" }), /over the payer balance/],
    [plan({ day: "2026-09-30" }), /not UTC day 2026-10-01/],
    [plan({ per: 2 }), /--per-payto 2, not 1/],
    [{ ...plan(), kind: "something else" }, /not a remeasure dry run/],
  ];
  for (const [p, re] of stops) {
    const v = planVerdict(p, "solana", "2026-10-01", 1);
    assert.equal(v.pay, false);
    assert.ok(!v.pay && v.stop, v.line);
    assert.match(v.line, re);
  }
  const none = planVerdict(plan({ would: 0, est: "0.000000" }), "solana", "2026-10-01", 1);
  assert.ok(!none.pay && !none.stop);
});

test("plan: Tempo counts the fee reserve against the cap", () => {
  // 0.95 + 35 x 0.002 = 1.02 > 1.00
  const v = planVerdict(plan({ chain: "tempo", would: 35, est: "0.950000", perRun: "1.000000" }), "tempo", "2026-10-01", 1);
  assert.ok(!v.pay && v.stop);
  assert.match(v.line, /fee reserve = 1\.020000 is over the run cap 1\.000000/);
  assert.equal(planVerdict(plan({ chain: "tempo", would: 35, est: "0.847250", perRun: "1.000000" }), "tempo", "2026-10-01", 1).pay, true);
});

test("plan: the real 2026-09-29 second-run plan fits (2.285 of 3 USDC)", { skip: noRaw(join(homedir(), "vet402-solana", "results", "remeasure", "solana-2026-09-29.dry-run.json")) }, () => {
  const p = JSON.parse(read(join(homedir(), "vet402-solana", "results", "remeasure", "solana-2026-09-29.dry-run.json")));
  const v = planVerdict(p, "solana", "2026-09-29", 2);
  assert.equal(v.pay, true, v.line);
});

test("plan: the CLI exits 4 on an over-cap plan and 0 within the caps", () => {
  const dir = tmp();
  writeFileSync(join(dir, "over.json"), JSON.stringify(plan({ est: "3.500000" })));
  writeFileSync(join(dir, "ok.json"), JSON.stringify(plan()));
  const over = stepsCli("check-plan", join(dir, "over.json"), "--chain", "solana", "--day", "2026-10-01", "--per-payto", "1");
  assert.equal(over.status, 4);
  assert.match(over.stdout, /over the run cap/);
  assert.equal(stepsCli("check-plan", join(dir, "ok.json"), "--chain", "solana", "--day", "2026-10-01", "--per-payto", "1").status, 0);
  rmSync(dir, { recursive: true });
});

test("run outcome: only one run since the start, ended, not stopped", () => {
  const since = "2026-10-01T01:17:40.000Z";
  const file = (runs: { startedAt: string; endedAt: string | null; stopped: string | null }[]) => ({ runs: runs.map((r) => ({ ...r, perPayTo: 1 })), rows: [] });
  assert.equal(runOutcome(file([{ startedAt: "2026-10-01T01:17:41.000Z", endedAt: "2026-10-01T01:25:00.000Z", stopped: null }]), since).ok, true);
  assert.match(runOutcome(file([{ startedAt: "2026-10-01T01:17:41.000Z", endedAt: "2026-10-01T01:25:00.000Z", stopped: "chain_spend_exceeds_ledger" }]), since).line, /stopped: chain_spend_exceeds_ledger/);
  assert.match(runOutcome(file([{ startedAt: "2026-10-01T01:17:41.000Z", endedAt: null, stopped: null }]), since).line, /no end/);
  assert.match(runOutcome(file([{ startedAt: "2026-10-01T00:10:00.000Z", endedAt: "2026-10-01T00:20:00.000Z", stopped: null }]), since).line, /found 0/);
});

test("manifest: a new day adds the input, moves the date and labels the CDP fetch the way 2026-09-29 did", () => {
  const text = read(join(DATA, "manifest.json"));
  const before = JSON.parse(text);
  const r = updateManifest(text, { label: "remeasure/solana-2026-09-30", path: "remeasure/solana-2026-09-30.json", sha256: "f".repeat(64), source: "~/vet402-solana/results/remeasure/solana-2026-09-30.json", day: "2026-09-30", redactions: [{ path: "rows[3].detail", what: "seller-token" }] });
  assert.ok(r.changed);
  const m = JSON.parse(r.text);
  assert.equal(m.date, "2026-09-30");
  assert.equal(m.files.length, before.files.length + 2);
  const cdp = m.files.find((f: { label: string }) => f.label === "cdp/discovery-2026-09-30");
  const cdp29 = before.files.find((f: { label: string }) => f.label === "cdp/discovery-2026-09-29");
  assert.deepEqual({ ...cdp, label: "", note: cdp.note.replace("2026-09-30", "2026-09-29") }, { ...cdp29, label: "" });
  assert.ok(m.redactions.includes("remeasure/solana-2026-09-30.json rows[3].detail: an auth token a seller returned to vet402 is replaced with [redacted]"));
  // The same copy again changes nothing; a copy of an existing day keeps its hand-written note when unchanged.
  const same = updateManifest(r.text, { label: "remeasure/solana-2026-09-30", path: "remeasure/solana-2026-09-30.json", sha256: "f".repeat(64), source: "", day: "2026-09-30", redactions: [] });
  assert.equal(same.changed, false);
  const e29 = before.files.find((f: { label: string }) => f.label === "remeasure/solana-2026-09-29");
  assert.equal(updateManifest(text, { label: e29.label, path: e29.path, sha256: e29.sha256, source: e29.source, day: "2026-09-29", redactions: [] }).changed, false);
  // A changed copy replaces the file's earlier note, in either form ("<path> rows[..]: ..." or "<path>: ...").
  const older = JSON.stringify({ ...before, redactions: [...before.redactions.filter((n: string) => !n.startsWith("remeasure/solana-2026-09-29.json")), "remeasure/solana-2026-09-29.json: an older note"] }, null, 2) + "\n";
  const again = JSON.parse(updateManifest(older, { label: e29.label, path: e29.path, sha256: "e".repeat(64), source: e29.source, day: "2026-09-29", redactions: [{ path: "rows[4].detail", what: "seller-token" }] }).text);
  assert.deepEqual(again.redactions.filter((n: string) => n.startsWith("remeasure/solana-2026-09-29.json")), ["remeasure/solana-2026-09-29.json rows[4].detail: an auth token a seller returned to vet402 is replaced with [redacted]"]);
});

test("commit message and redaction note: public English, no first person, no dash", () => {
  const rows = [
    { outcome: "sent", settled: true, delivered: true },
    { outcome: "sent", settled: true, delivered: false },
    { outcome: "refused", settled: null, delivered: null },
  ];
  const msg = commitMessage("2026-09-30", [
    { chain: "solana", result: { rows }, redacted: true },
    { chain: "tempo", result: { rows: rows.slice(0, 1) }, redacted: false },
  ]);
  assert.equal(msg, "data: 2026-09-30 remeasure on Solana (3 rows: 2 paid, 2 settled, 1 delivered) and Tempo (1 rows: 1 paid, 1 settled, 1 delivered); a seller-issued token redacted");
  assert.equal(redactionNote("remeasure/x.json", [{ path: "a", what: "seller-token" }, { path: "b", what: "seller-token" }, { path: "c", what: "local-path" }]), "remeasure/x.json a and b: an auth token a seller returned to vet402 is replaced with [redacted]; local runner paths are shortened to ~/");
});

const cp = (n: number) => String.fromCharCode(n);
/** Hiragana, katakana and CJK ideographs; built from code points so this file stays ASCII. */
const JAPANESE = new RegExp(`[${cp(0x3040)}-${cp(0x30ff)}${cp(0x3400)}-${cp(0x9fff)}]`);
const EM_DASH = cp(0x2014);
/** The words are split so this file does not match itself. */
const FIRST_PLURAL = new RegExp(`\\b(?:${["w" + "e", "u" + "s", "ou" + "r", "ou" + "rs", "ou" + "rselves"].join("|")})\\b`, "i");

test("public text in scripts/daily and src/daily: English only, no first person plural, no em dash, no local home path", () => {
  const files = [
    ...readdirSync(join(ROOT, "scripts", "daily")).filter((f) => /\.(ts|sh|json)$/.test(f)).map((f) => join(ROOT, "scripts", "daily", f)),
    ...readdirSync(join(ROOT, "scripts", "daily", "launchd")).map((f) => join(ROOT, "scripts", "daily", "launchd", f)),
    ...readdirSync(join(ROOT, "src", "daily")).map((f) => join(ROOT, "src", "daily", f)),
    join(ROOT, "test", "daily.test.ts"),
  ];
  assert.ok(FIRST_PLURAL.test("so " + "w" + "e did") && JAPANESE.test(cp(0x65e5)) && !FIRST_PLURAL.test("status USDC"), "the checks themselves work");
  for (const f of files) {
    const t = read(f);
    assert.ok(!JAPANESE.test(t), `${f}: Japanese`);
    assert.ok(!t.includes(EM_DASH), `${f}: em dash`);
    assert.ok(!FIRST_PLURAL.test(t.replace(/\bUS\b/g, "")), `${f}: first person plural`);
    assert.ok(!/\/Users\/[a-z]/.test(t.replace(/\/Users\/<name>\//g, "").replace(/"\/Users\/"|\/Users\\\//g, "")), `${f}: a home path`);
  }
});

// ---------- run.sh against a throwaway repository ----------

const RUN = join(ROOT, "scripts", "daily", "run.sh");
const at = (iso: string) => String(Math.floor(Date.parse(iso) / 1000));
/** The review gate installed in this clone (scripts/git-hooks/install-review-gate.sh), if any. */
const PRE_PUSH = (() => {
  const r = spawnSync("/usr/bin/git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: ROOT, encoding: "utf8" });
  const p = r.status === 0 ? join(r.stdout.trim(), "hooks", "pre-push") : "";
  return p && existsSync(p) && read(p).includes("review-gate") ? p : null;
})();

interface Sandbox {
  dir: string;
  home: string;
  repo: string;
  pub: string;
  origin: string;
  state: string;
  alerts: string;
  calls: string;
  rmdir: string;
  env: NodeJS.ProcessEnv;
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** A bare origin, a clone on main that looks like this repository to run.sh, and fake remeasure/rank scripts. */
function sandbox(): Sandbox {
  const dir = tmp();
  const home = join(dir, "home");
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(seed, "fake"), { recursive: true });
  const pkg = { name: "fake", private: true, type: "module", scripts: { remeasure: "node fake/remeasure.mjs", rank: "node fake/rank.mjs", typecheck: "node -e 0", test: "node -e 0" } };
  writeFileSync(join(seed, "package.json"), JSON.stringify(pkg, null, 2));
  writeFileSync(join(seed, "package-lock.json"), JSON.stringify({ name: "fake", lockfileVersion: 3, requires: true, packages: { "": { name: "fake" } } }, null, 2));
  writeFileSync(join(seed, ".gitignore"), "node_modules/\n");
  cpSync(join(ROOT, "scripts", "daily"), join(seed, "scripts", "daily"), { recursive: true });
  cpSync(join(ROOT, "src", "daily"), join(seed, "src", "daily"), { recursive: true });
  // remeasure: --dry-run writes a plan from FAKE_ESTIMATE; --pay is only logged (a test fails if it appears).
  writeFileSync(
    join(seed, "fake", "remeasure.mjs"),
    `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2), v = (n) => a[a.indexOf(n) + 1];
appendFileSync(process.env.FAKE_CALLS, a.join(" ") + "\\n");
if (a.includes("--pay")) process.exit(0);
const chain = v("--chain"), out = v("--out"), day = new Date(Number(process.env.VET402_DAILY_NOW) * 1000).toISOString().slice(0, 10);
mkdirSync(out, { recursive: true });
writeFileSync(out + "/" + chain + "-" + day + ".dry-run.json", JSON.stringify({ kind: "vet402-remeasure-dry-run", chain, createdAt: day + "T01:18:00.000Z", perPayTo: Number(v("--per-payto")),
  caps: { perRun: chain === "solana" ? "3.000000" : "1.000000", monthLeft: "25.000000" },
  summary: { would: 10, estimate: process.env["FAKE_ESTIMATE_" + chain.toUpperCase()] ?? process.env.FAKE_ESTIMATE ?? "0.500000", payerUsdcBefore: "40.000000", payerUsdcEBefore: "15.000000" } }));
`,
  );
  writeFileSync(
    join(seed, "fake", "rank.mjs"),
    `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2), out = a[a.indexOf("--out") + 1], m = JSON.parse(readFileSync("data/manifest.json", "utf8"));
mkdirSync(out, { recursive: true });
writeFileSync(out + "/rank-" + m.date + ".json", JSON.stringify({ date: m.date, inputs: m.files.length }) + "\\n");
`,
  );
  mkdirSync(join(seed, "scripts"), { recursive: true });
  writeFileSync(
    join(seed, "scripts", "build-site.ts"),
    `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2), report = a[a.indexOf("--report") + 1], out = a[a.indexOf("--out") + 1];
mkdirSync(out, { recursive: true });
writeFileSync(out + "/rank.json", readFileSync(report, "utf8"));
`,
  );
  mkdirSync(join(seed, "data", "remeasure"), { recursive: true });
  writeFileSync(
    join(seed, "data", "manifest.json"),
    JSON.stringify({ kind: "vet402-rank-inputs", date: "2026-09-29", files: [{ label: "cdp/discovery-2026-09-28", path: "cdp/discovery-2026-09-28.json", sha256: "0".repeat(64), source: "https://example.com/discovery", note: "Projection." }] }, null, 2) + "\n",
  );
  mkdirSync(join(seed, "site"), { recursive: true });
  writeFileSync(join(seed, "site", "rank.json"), "{}\n");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(seed, "init", "-q", "-b", "main");
  git(seed, "config", "user.name", "Test");
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  const repo = join(home, "vet402-solana");
  git(dir, "clone", "-q", origin, repo);
  git(repo, "config", "user.name", "Test");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "reviewgate.datare", "^(data/|site/)");
  if (PRE_PUSH) {
    copyFileSync(PRE_PUSH, join(repo, ".git", "hooks", "pre-push"));
    chmodSync(join(repo, ".git", "hooks", "pre-push"), 0o755);
  }
  const rmdir = join(repo, "results", "remeasure");
  mkdirSync(rmdir, { recursive: true });
  const state = join(dir, "state");
  const sb: Sandbox = {
    dir,
    home,
    repo,
    pub: join(home, "vet402-solana-publish"),
    origin,
    state,
    alerts: join(dir, "ALERTS.md"),
    calls: join(dir, "calls.log"),
    rmdir,
    env: {},
  };
  sb.env = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    VET402_TSX: TSX,
    VET402_KEYS: join(dir, "keys"),
    VET402_RECEIPTS: join(dir, "receipts"),
    VET402_DAILY_STATE: state,
    VET402_DAILY_LOGS: join(dir, "logs"),
    VET402_ALERTS_FILE: sb.alerts,
    VET402_DAILY_NOTIFY: "0",
    FAKE_CALLS: sb.calls,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  return sb;
}

function runSh(sb: Sandbox, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", [RUN, ...args], { env: { ...sb.env, ...env }, encoding: "utf8", timeout: 120_000 });
}
const logs = (sb: Sandbox) => (existsSync(join(sb.dir, "logs")) ? readdirSync(join(sb.dir, "logs")).map((f) => read(join(sb.dir, "logs", f))).join("\n") : "");
const alerts = (sb: Sandbox) => (existsSync(sb.alerts) ? read(sb.alerts) : "");
const calls = (sb: Sandbox) => (existsSync(sb.calls) ? read(sb.calls) : "");

test("run.sh: on or after 2026-10-09 (JST) nothing runs", () => {
  const sb = sandbox();
  const r = runSh(sb, ["am"], { VET402_DAILY_NOW: at("2026-10-09T01:17:00Z") });
  assert.equal(r.status, 0);
  assert.match(logs(sb), /JST 2026-10-09 is on or after 2026-10-09: nothing runs/);
  assert.equal(alerts(sb), "");
  assert.equal(calls(sb), "");
  // 2026-10-08 22:17 JST still runs (it reaches the fake remeasure)
  const r2 = runSh(sb, ["pm", "--dry-run"], { VET402_DAILY_NOW: at("2026-10-08T13:17:00Z") });
  assert.equal(r2.status, 0, logs(sb));
  assert.match(calls(sb), /--chain solana --dry-run --per-payto 2/);
  rmSync(sb.dir, { recursive: true });
});

test("run.sh: a second run while one holds the lock stops, alerts, and does nothing", async () => {
  const sb = sandbox();
  mkdirSync(sb.state, { recursive: true });
  const ready = join(sb.dir, "ready");
  const holder = spawn("/usr/bin/lockf", ["-k", join(sb.state, "run.lock"), "/bin/sh", "-c", `touch '${ready}'; sleep 20`]);
  for (let i = 0; i < 100 && !existsSync(ready); i++) await new Promise((res) => setTimeout(res, 50));
  assert.ok(existsSync(ready));
  try {
    const r = runSh(sb, ["am"], { VET402_DAILY_NOW: at("2026-10-01T01:17:00Z") });
    assert.equal(r.status, 75);
    assert.match(alerts(sb), /\[vet402_daily\] am stopped: another daily run holds .*run\.lock; this am run did nothing/);
    assert.equal(calls(sb), "");
  } finally {
    holder.kill();
  }
  rmSync(sb.dir, { recursive: true });
});

test("run.sh: a HALT file stops the lane until removed; outside the pay window nothing is paid", () => {
  const sb = sandbox();
  mkdirSync(sb.state, { recursive: true });
  writeFileSync(join(sb.state, "HALT-pay"), "earlier stop\n");
  assert.equal(runSh(sb, ["am"], { VET402_DAILY_NOW: at("2026-10-01T01:17:00Z") }).status, 1);
  assert.match(alerts(sb), /the pay lane is halted since an earlier stop/);
  rmSync(join(sb.state, "HALT-pay"));
  assert.equal(runSh(sb, ["pm"], { VET402_DAILY_NOW: at("2026-10-01T23:10:00Z") }).status, 1);
  assert.match(alerts(sb), /UTC 2310 is outside the pay window/);
  assert.ok(!existsSync(join(sb.state, "HALT-pay")), "no HALT: nothing was paid");
  assert.equal(calls(sb), "");
  rmSync(sb.dir, { recursive: true });
});

test("run.sh: an over-cap estimate stops before any --pay and halts the lane", () => {
  const sb = sandbox();
  const r = runSh(sb, ["am"], { VET402_DAILY_NOW: at("2026-10-01T01:17:00Z"), FAKE_ESTIMATE: "3.500000" });
  assert.equal(r.status, 1, logs(sb));
  assert.match(alerts(sb), /not paying: solana: estimate 3\.500000 is over the run cap 3\.000000/);
  assert.ok(existsSync(join(sb.state, "HALT-pay")));
  assert.equal(calls(sb).trim(), "--chain solana --dry-run --per-payto 1 --out " + join(sb.state, "plan"));
  rmSync(sb.dir, { recursive: true });
});

test("run.sh: Tempo over its cap after Solana: no Tempo payment, the lane halts, what Solana bought is still published", { skip: PRE_PUSH ? false : "no review gate installed in this clone" }, () => {
  const sb = sandbox();
  writeFileSync(join(sb.rmdir, "solana-2026-10-01.json"), JSON.stringify({ kind: "vet402-remeasure", chain: "solana", date: "2026-10-01", runs: [], rows: [{ host: "a.example", outcome: "sent", settled: true, delivered: true, detail: "{}" }] }));
  const r = runSh(sb, ["am", "--dry-run"], { VET402_DAILY_NOW: at("2026-10-01T01:17:00Z"), FAKE_ESTIMATE_TEMPO: "1.500000" });
  assert.equal(r.status, 1, logs(sb));
  assert.match(alerts(sb), /not paying: tempo: estimate 1\.500000 \+ fee reserve = 1\.520000 is over the run cap 1\.000000/);
  assert.ok(existsSync(join(sb.state, "HALT-pay")));
  assert.match(logs(sb), /commit [0-9a-f]{40}: data: 2026-10-01 remeasure on Solana \(1 rows: 1 paid, 1 settled, 1 delivered\)$/m);
  assert.ok(!calls(sb).includes("--pay"));
  rmSync(sb.dir, { recursive: true });
});

test("run.sh: an unknown secret in a result stops the publish; nothing is copied or committed", () => {
  const sb = sandbox();
  writeFileSync(join(sb.rmdir, "solana-2026-10-01.json"), JSON.stringify({ kind: "vet402-remeasure", chain: "solana", date: "2026-10-01", runs: [], rows: [{ host: "a.example", outcome: "sent", detail: `{"session":"Zq8${b64(30)}"}` }] }));
  const r = runSh(sb, ["am", "--dry-run"], { VET402_DAILY_NOW: at("2026-10-01T01:17:00Z") });
  assert.equal(r.status, 1, logs(sb));
  assert.match(alerts(sb), /am stopped \(dry run\): secret gate stopped the copy of solana-2026-10-01\.json/);
  assert.match(logs(sb), /blocked: solana-2026-10-01\.json rows\[0\]\.detail secret-field/);
  assert.ok(!existsSync(join(sb.pub, "data", "remeasure", "solana-2026-10-01.json")));
  assert.ok(!calls(sb).includes("--pay"));
  assert.equal(git(sb.pub, "status", "--porcelain"), "");
  rmSync(sb.dir, { recursive: true });
});

test("run.sh --dry-run: copies through the gate, commits data/ and site/ only, passes the pre-push gate, never pushes", { skip: PRE_PUSH ? false : "no review gate installed in this clone" }, () => {
  const sb = sandbox();
  const jwt = `eyJhbGciOiJSUzI1NiJ9.${b64(90)}`;
  const result = { kind: "vet402-remeasure", chain: "solana", date: "2026-10-01", runs: [], rows: [{ host: "a.example", outcome: "sent", settled: true, delivered: true, detail: `{"auth":{"id_token":"${jwt}` }] };
  writeFileSync(join(sb.rmdir, "solana-2026-10-01.json"), JSON.stringify(result));
  const originBefore = git(sb.origin, "rev-parse", "main");
  const r = runSh(sb, ["am", "--dry-run"], { VET402_DAILY_NOW: at("2026-10-01T01:17:00Z") });
  assert.equal(r.status, 0, logs(sb));
  assert.equal(alerts(sb), "");
  const m = logs(sb).match(/commit ([0-9a-f]{40}): (.*)/);
  assert.ok(m, logs(sb));
  assert.equal(m[2], "data: 2026-10-01 remeasure on Solana (1 rows: 1 paid, 1 settled, 1 delivered); a seller-issued token redacted");
  const files = git(sb.repo, "diff-tree", "--no-commit-id", "--name-only", "-r", m[1]!).split("\n");
  assert.deepEqual(files.sort(), ["data/manifest.json", "data/remeasure/solana-2026-10-01.json", "site/rank.json"]);
  const copy = git(sb.repo, "show", `${m[1]}:data/remeasure/solana-2026-10-01.json`);
  assert.ok(!copy.includes(jwt));
  assert.ok(copy.includes(SELLER_TOKEN_REDACTION));
  assert.match(git(sb.repo, "show", `${m[1]}:data/manifest.json`), /"date": "2026-10-01"/);
  assert.equal(git(sb.origin, "rev-parse", "main"), originBefore, "nothing pushed");
  assert.equal(git(sb.pub, "rev-parse", "HEAD"), originBefore, "publish worktree back at origin/main");
  assert.equal(git(sb.pub, "status", "--porcelain"), "");
  assert.match(calls(sb), /--chain solana --dry-run --per-payto 1/);
  assert.match(calls(sb), /--chain tempo --dry-run --per-payto 1/);
  assert.ok(!calls(sb).includes("--pay"));
  assert.match(logs(sb), /dry run: would pay now \(remeasure --chain solana --pay --per-payto 1\)/);
  rmSync(sb.dir, { recursive: true });
});
