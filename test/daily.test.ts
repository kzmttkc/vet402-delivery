/**
 * scripts/daily: the secret gate, the pay/publish decisions, and run.sh itself.
 *
 * Nothing here reads data/ or site/, which change every day, nor the runner's local files: the inputs are
 * fixed copies in test/fixtures/daily/ (taken at e28f0b0), and raw result files are rebuilt from them by
 * putting a made-up token back where the redaction text stands. Random values come from a fixed seed. run.sh is exercised against a throwaway git
 * repository whose npm scripts stand in for remeasure, rank and the records scripts: nothing here pays,
 * signs, sends, or pushes anywhere but a local bare repository.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  blockingFindings,
  gateTree,
  isSecretName,
  loadAllowList,
  ownKeyNeedles,
  publicJson,
  redactKnown,
  scanFileText,
  SELLER_TOKEN_REDACTION,
  type Finding,
} from "../src/daily/secret-gate.js";
import { alnum, b64url, base58, bytes, GATE_SHAPES, hex, seeded, withDetail } from "../src/daily/gate-shapes.js";
import { commitMessage, ledgerKeys, planVerdict, redactionNote, runOutcome, updateManifest } from "../src/daily/steps.js";

const ROOT = resolve(import.meta.dirname, "..");
/** Fixed copies of published files (test/fixtures/daily/), so a new day's data changes no test. */
const FIX = join(ROOT, "test", "fixtures", "daily");
const ALLOW = join(ROOT, "scripts", "daily", "secret-allow.json");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const read = (p: string) => readFileSync(p, "utf8");
const gateCli = (...args: string[]) => spawnSync(TSX, [join(ROOT, "scripts", "daily", "secret-gate.ts"), ...args], { encoding: "utf8" });
const stepsCli = (...args: string[]) => spawnSync(TSX, [join(ROOT, "scripts", "daily", "steps.ts"), ...args], { encoding: "utf8" });
const tmp = () => mkdtempSync(join(tmpdir(), "vet402-daily-"));
const scan = (text: string, name = "x.json") => blockingFindings(scanFileText(text, name), loadAllowList(ALLOW));
const kinds = (fs: Finding[]) => fs.map((f) => f.kind);

/** A made-up seller token in the place of the redaction text, cut at the same 300 characters as the body. */
function withFakeToken(body: string, r = seeded(7)): string {
  const i = body.indexOf(SELLER_TOKEN_REDACTION);
  assert.ok(i >= 0);
  const token = `eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ.${b64url(r, 400)}`;
  return (body.slice(0, i) + token).slice(0, 300);
}

// ---------- the secret gate on the published data (raw files rebuilt from data/) ----------

test("gate: the 2026-09-29 Solana copy comes out byte for byte from a raw file with the token back (published rows 4 and 192)", () => {
  const published = read(join(FIX, "remeasure-solana-2026-09-29.subset.json"));
  const raw = JSON.parse(published);
  for (const i of [4, 5]) raw.rows[i].detail = withFakeToken(raw.rows[i].detail);
  const { value, redactions } = redactKnown(raw);
  assert.equal(publicJson(value), published);
  assert.deepEqual(redactions, [
    { path: "rows[4].detail", what: "seller-token" },
    { path: "rows[5].detail", what: "seller-token" },
  ]);
  const dir = tmp();
  writeFileSync(join(dir, "raw.json"), JSON.stringify(raw));
  const r = gateCli("copy", join(dir, "raw.json"), join(dir, "solana-2026-09-29.json"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(join(dir, "solana-2026-09-29.json")), published);
  assert.equal(JSON.parse(r.stdout).redactions.length, 2);
  rmSync(dir, { recursive: true });
});

test("gate: the 2026-09-29 Tempo copy is unchanged by the copy step (nothing to redact)", () => {
  const published = read(join(FIX, "remeasure-tempo-2026-09-29.subset.json"));
  const { value, redactions } = redactKnown(JSON.parse(published));
  assert.equal(publicJson(value), published);
  assert.deepEqual(redactions, []);
});

test("gate: the 2026-09-28 census gets the published redactions (rows[17], records[17], the local path)", () => {
  const published = JSON.parse(read(join(FIX, "census-2026-09-28.subset.json")));
  const raw = structuredClone(published);
  raw.rows[1].first300 = withFakeToken(raw.rows[1].first300);
  raw.records[0].response.first300 = withFakeToken(raw.records[0].response.first300);
  raw.ledger = raw.ledger.replace(/^~\//, "/Users/runner/");
  const { value, redactions } = redactKnown(raw);
  assert.deepEqual(value, published);
  assert.deepEqual(redactions, [
    { path: "ledger", what: "local-path" },
    { path: "rows[1].first300", what: "seller-token" },
    { path: "records[0].response.first300", what: "seller-token" },
  ]);
  // The copy published before f61bb07 left rows[17] as it was: the gate stops on it (a known shape left in).
  const before = structuredClone(published);
  before.rows[1].first300 = raw.rows[1].first300;
  const block = scan(JSON.stringify(before, null, 2), "data/solana/census-2026-09-28.json");
  assert.ok(block.some((f) => f.path === "rows[1].first300" && f.kind === "jwt" && f.known), JSON.stringify(block.map((f) => f.path)));
});

test("gate: the site may print an id that data/ names; a random value on a page still stops", () => {
  const dir = tmp();
  const sig = base58(bytes(seeded(12), 64));
  mkdirSync(join(dir, "data"), { recursive: true });
  mkdirSync(join(dir, "site"), { recursive: true });
  writeFileSync(join(dir, "data", "r.json"), JSON.stringify({ rows: [{ tx: sig }] }));
  writeFileSync(join(dir, "site", "a.html"), `<a href="https://solscan.io/tx/${sig}">paid</a> <span>${sig}</span>`);
  assert.deepEqual(gateTree(dir, ["data", "site"], { allow: [], files: [] }).blocking.map((f) => f.file), []);
  writeFileSync(join(dir, "site", "b.html"), `<span>${alnum(seeded(13), 30)}</span>`);
  assert.deepEqual(gateTree(dir, ["data", "site"], { allow: [], files: [] }).blocking.map((f) => f.file), ["site/b.html"]);
  rmSync(dir, { recursive: true });
});

test("gate: the allow list loads, and each value entry says where it stands", () => {
  const allow = loadAllowList(ALLOW);
  assert.ok(allow.files.length >= 1 && allow.allow.length >= 1);
  for (const a of allow.allow) assert.match(a.reason, /first at \S+/, a.sha256.slice(0, 12));
});

test("gate: a whole-file allowance holds only for the exact bytes", () => {
  const dir = tmp();
  mkdirSync(join(dir, "data"), { recursive: true });
  const text = withDetail(`{"session":"${alnum(seeded(3), 30)}"}`);
  writeFileSync(join(dir, "data", "copy.json"), text);
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const allow = { allow: [], files: [{ path: "data/copy.json", sha256: sha(text), reason: "test" }] };
  assert.equal(gateTree(dir, ["data"], allow).blocking.length, 0);
  writeFileSync(join(dir, "data", "copy.json"), text.replace("session", "sessionid"));
  assert.ok(gateTree(dir, ["data"], allow).blocking.length > 0);
  rmSync(dir, { recursive: true });
});

// ---------- the secret gate: every shape stops, with a fixed seed ----------

test("gate: every credential shape in src/daily/gate-shapes.ts (both reviews' probes) stops, 300 times each (fixed seed)", () => {
  const r = seeded(20260930);
  for (const [label, make] of GATE_SHAPES) {
    let passed = 0;
    for (let i = 0; i < 300; i++) if (blockingFindings(scanFileText(make(r), "data/x.json"), []).length === 0) passed++;
    assert.equal(passed, 0, `${label}: ${passed}/300 passed the gate`);
  }
});

test("gate: each finding kind is reported for its shape", () => {
  const r = seeded(11);
  const secret = `Zq8${b64url(r, 30)}`;
  const cases: [string, string, Finding["kind"]][] = [
    ["jwt outside a response body", withDetail(`eyJhbGciOiJIUzI1NiJ9.${b64url(r, 40)}.${b64url(r, 20)}`, "input"), "jwt"],
    ["bearer", withDetail(`{"note":"use Authorization: Bearer ${secret}"}`), "bearer"],
    ["api key in a URL query", withDetail(`see https://api.example.com/v1/x?api_key=${secret}&q=1`), "url-query-secret"],
    ["session id field", withDetail(`{"session_id":"${secret}","ok":true}`), "secret-field"],
    ["token-named JSON key", JSON.stringify({ rows: [{ access_token: secret }] }), "secret-field"],
    ["token over a value that is not an asset shape", JSON.stringify({ rows: [{ token: "usdc-session" }] }), "secret-field"],
    ["opaque 24+", withDetail(`{"ref":"${alnum(r, 30)}"}`), "opaque-40"],
    ["local path", withDetail(`{"file":"/home/runner/.keys/payer.json"}`), "local-path"],
    ["vendor key", withDetail(`{"k":"sk_live_${hex(r, 24)}Ab"}`), "vendor-key"],
    ["private key block", withDetail("-----BEGIN PRIVATE KEY-----\\nMIIE"), "private-key-block"],
  ];
  for (const [what, text, kind] of cases) assert.ok(kinds(scan(text)).includes(kind), `${what}: ${JSON.stringify(kinds(scan(text)))}`);
  for (const n of ["api_key", "X-Api-Key", "apiKey", "clientSecret", "SESSION_ID", "set-cookie", "refresh_token", "Authorization"]) assert.ok(isSecretName(n), n);
  // Any name holding token, secret or key is secret, public or not (tokenAddress, keyword): a person allows the value.
  for (const n of ["tokenAddress", "token2", "tokenValue", "secret_value", "keyword", "pk", "wallet", "otp"]) assert.ok(isSecretName(n), n);
  for (const n of ["author", "description", "address", "mint", "hash"]) assert.ok(!isSecretName(n), n);
});

test("gate: the nine market-data values that stopped the 2026-09-30 production publish now pass by rule", () => {
  // rows 1, 20, 39, 69, 75, 83, 86 of that day's Solana result: prices, a token list, token names and amounts,
  // wallet and mint addresses, an IPFS image path, a Polymarket condition id
  const text = read(join(FIX, "remeasure-solana-2026-09-30.market-rows.json"));
  const stopped = ["bbe956917b9eb728", "9ea0471224a66f87", "665ecd3af9b7e667", "e210c898bc3ff073", "b7abea86f26fee1c", "973294ef1984925c", "4e31ccb3da499f0f", "1fda63ea92492d23", "48626b95896d7d37"];
  const raw = blockingFindings(scanFileText(text, "data/x.json"), []);
  assert.deepEqual(raw.filter((f) => stopped.includes(f.sha256.slice(0, 16))).map((f) => f.path), []);
  assert.deepEqual(scan(text), []);
});

test("gate: a crypto asset named token passes only in its public shape; credential tokens always stop", () => {
  const pass = [
    { token_amount: "835335.7825230001" }, { base_token_price_quote_token: "2668.701" }, { token_name: "American Inu" },
    { token_symbol: "NUTFLEX" }, { token_mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }, { token: "USDC" },
    { tokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, { wallet_address: "69aiAKU3uJMxMLRkUEGFNt6nQ43PiVimE4ZbErJ7VSM1" },
    { wallet: "69aiAKU3uJMxMLRkUEGFNt6nQ43PiVimE4ZbErJ7VSM1" }, { tokens: [{ mint: "So11111111111111111111111111111111111111112", symbol: "SOL" }] },
  ];
  for (const o of pass) assert.deepEqual(scan(withDetail(JSON.stringify(o))), [], JSON.stringify(o));
  const r = seeded(31);
  const stop = [
    { access_token: "USDC" }, { id_token: "1234" }, { refresh_token: alnum(r, 10) }, { api_token: "12.5" }, { token: alnum(r, 8).toLowerCase() },
    { token: digits20() }, { token_amount: alnum(r, 20) }, { tokenValue: "100" }, { wallet: base58(bytes(r, 64)) }, { token: { value: alnum(r, 8) } },
  ];
  for (const o of stop) assert.ok(scan(withDetail(JSON.stringify(o))).length > 0, JSON.stringify(o));
  function digits20() {
    return "31415926535897932384";
  }
});

test("gate: public ids in their exact format, words and vet402's own fields do not stop", () => {
  const detail = JSON.stringify({
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    tx: "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW",
    evm: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    hash: "bac028774b9f783fa6841b80bf99ef70179857ac7779686cb979f1c45811ca5f",
    uuid: "299de0e8-cfd8-4343-8fff-9fdd698b68df",
    txid: "E4IQN3GHQ6AHYKKRIS5D6DD5GE4OXCA3G6ZILCA7YDAHPU5WKSTA",
    cid: "https://ipfs.io/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    link: "https://solscan.io/tx/5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW",
    host: "https://www.x402financialdata.com/v1/prices",
    words: "Strait of Hormuz traffic returns to normal by December 31?",
    network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    redacted: `{"auth":{"id_token":"${SELLER_TOKEN_REDACTION}`,
  });
  assert.deepEqual(scan(withDetail(detail)).map((f) => f.shape), []);
  const own = {
    rows: [{ key: "2026-09-29|226DYoWb2e6uYxDkFp7vK8jZhzzh2VNvHH6DgbDsNueC|0", signature: "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW" }],
    records: [{ memo: "6b8a31553d743adb2a527c909e20678e", onChain: { memo: "6b8a31553d743adb2a527c909e20678e" } }],
    payableTotalWithFeeReserve: 1,
  };
  assert.deepEqual(scan(JSON.stringify(own)).map((f) => `${f.path} ${f.kind}`), []);
  // the same own field with a value off its format stops
  assert.ok(scan(JSON.stringify({ rows: [{ key: alnum(seeded(5), 32) }] })).length > 0);
  // an id in its exact format with no field that says what it is stops (a hex key looks like a hash)
  assert.ok(scan(withDetail(`{"note":"${hex(seeded(6), 64)}"}`)).length > 0);
});

test("gate: copy refuses a result with an unknown shape and writes nothing, never printing the value", () => {
  const dir = tmp();
  const raw = JSON.parse(read(join(FIX, "remeasure-solana-2026-09-29.subset.json")));
  const secret = `${b64url(seeded(9), 33)}Q9`;
  raw.rows[2].detail = `{"session":"${secret}","user":"vet402"}`;
  writeFileSync(join(dir, "in.json"), JSON.stringify(raw));
  const out = join(dir, "out", "solana-2026-09-29.json");
  const r = gateCli("copy", join(dir, "in.json"), out);
  assert.equal(r.status, 3, r.stdout + r.stderr);
  assert.match(r.stderr, /blocked: solana-2026-09-29\.json rows\[2\]\.detail secret-field/);
  assert.ok(!existsSync(out));
  assert.ok(!r.stderr.includes(secret.slice(0, 20)), "the value is never printed");
  rmSync(dir, { recursive: true });
});

test("gate: copy redacts a seller token in a body and passes the rest", () => {
  const dir = tmp();
  const jwt = `eyJhbGciOiJSUzI1NiIsImtpZCI6IjEifQ.${b64url(seeded(4), 160)}`;
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
  const r = seeded(21);
  const secret = Buffer.from(Array.from({ length: 64 }, () => Math.floor(r() * 256)));
  writeFileSync(join(dir, "payer.json"), JSON.stringify([...secret]));
  const needles = ownKeyNeedles(dir);
  assert.ok(needles.length >= 4);
  for (const n of needles) {
    const found = scanFileText(withDetail(`{"x":"${n}"}`), "x.json", { ownKeys: needles });
    const own = found.find((f) => f.kind === "own-key")!;
    assert.ok(own);
    assert.ok(kinds(blockingFindings(found, [{ sha256: own.sha256, kind: "own-key", reason: "no" }])).includes("own-key"));
  }
  writeFileSync(join(dir, "allow.json"), JSON.stringify({ kind: "vet402-secret-gate-allow", allow: [{ sha256: "a".repeat(64), kind: "own-key", reason: "x" }] }));
  assert.throws(() => loadAllowList(join(dir, "allow.json")), /can never be allowed/);
  writeFileSync(join(dir, "allow.json"), JSON.stringify({ kind: "vet402-secret-gate-allow", allow: [{ sha256: "a".repeat(64), kind: "jwt", reason: " " }] }));
  assert.throws(() => loadAllowList(join(dir, "allow.json")), /needs a sha256 and a reason/);
  rmSync(dir, { recursive: true });
});

// ---------- decisions ----------

const PAYTO = "226DYoWb2e6uYxDkFp7vK8jZhzzh2VNvHH6DgbDsNueC";
const plan = (o: { chain?: string; day?: string; per?: number; would?: number; est?: string; perRun?: string; monthLeft?: string; bal?: string } = {}) => {
  const day = o.day ?? "2026-10-01";
  const would = o.would ?? 93;
  const est = o.est ?? "1.133000";
  const rows = Array.from({ length: would }, (_, i) => ({ key: `${day}|${PAYTO}|${i}`, outcome: "would_pay", priceUsdc: i === 0 ? est : "0.000000" }));
  return {
    kind: "vet402-remeasure-dry-run",
    chain: o.chain ?? "solana",
    createdAt: `${day}T01:17:30.000Z`,
    perPayTo: o.per ?? 1,
    caps: { perPurchase: "0.100000", perRun: o.perRun ?? "3.000000", perMonth: "30.000000", monthLeft: o.monthLeft ?? "25.000000" },
    summary: { would, estimate: est, payerUsdcBefore: o.bal ?? "45.000000", payerUsdcEBefore: o.bal ?? "16.000000" },
    rows: [...rows, { key: `${day}|${PAYTO}|x`, outcome: "refused", priceUsdc: "0.050000" }],
  };
};

test("plan: pays within the caps; stops over the run cap, the month, the balance, or on another day's plan", () => {
  assert.equal(planVerdict(plan(), "solana", "2026-10-01", 1).pay, true);
  const stops: [ReturnType<typeof plan>, RegExp][] = [
    [plan({ est: "3.500000" }), /over the run cap 3\.000000/],
    [plan({ est: "2.000000", monthLeft: "1.500000" }), /over what is left this month/],
    [plan({ est: "2.000000", bal: "1.000000" }), /over the payer balance/],
    [plan({ day: "2026-09-30" }), /not UTC day 2026-10-01/],
    [plan({ per: 2 }), /--per-payto 2, not 1/],
    [{ ...plan(), kind: "something else" }, /not a remeasure dry run/],
    [{ ...plan(), rows: undefined } as unknown as ReturnType<typeof plan>, /the plan has no rows/],
  ];
  for (const [p, re] of stops) {
    const v = planVerdict(p, "solana", "2026-10-01", 1);
    assert.ok(!v.pay && v.stop, v.line);
    assert.match(v.line, re);
  }
  const none = planVerdict(plan({ would: 0, est: "0.000000" }), "solana", "2026-10-01", 1);
  assert.ok(!none.pay && !none.stop);
});

test("plan: slots already in the spend ledger are left out of the estimate (a second run the same day)", () => {
  // 3.5 USDC planned, but the slot holding it was bought in the morning run: nothing left over the cap.
  const p = plan({ est: "3.500000", would: 2 });
  const bought = ledgerKeys({ purchases: [{ key: `2026-10-01|${PAYTO}|0`, amount: "3500000" }] });
  const v = planVerdict(p, "solana", "2026-10-01", 1, bought);
  assert.ok(v.pay, v.line);
  assert.match(v.line, /1 purchases \(1 already in the ledger\), estimate 0\.000000/);
  const all = ledgerKeys({ entries: [{ key: `2026-10-01|${PAYTO}|0` }, { key: `2026-10-01|${PAYTO}|1` }] });
  const done = planVerdict(p, "solana", "2026-10-01", 1, all);
  assert.ok(!done.pay && !done.stop);
  assert.match(done.line, /nothing to buy \(2 already in the ledger\)/);
});

test("plan: Tempo counts the fee reserve against the cap", () => {
  // 0.95 + 35 x 0.002 = 1.02 > 1.00
  const v = planVerdict(plan({ chain: "tempo", would: 35, est: "0.950000", perRun: "1.000000" }), "tempo", "2026-10-01", 1);
  assert.ok(!v.pay && v.stop);
  assert.match(v.line, /fee reserve = 1\.020000 is over the run cap 1\.000000/);
  assert.equal(planVerdict(plan({ chain: "tempo", would: 35, est: "0.847250", perRun: "1.000000" }), "tempo", "2026-10-01", 1).pay, true);
});

test("plan: the CLI exits 4 on an over-cap plan and 0 within the caps, reading the ledger it is given", () => {
  const dir = tmp();
  writeFileSync(join(dir, "over.json"), JSON.stringify(plan({ est: "3.500000" })));
  writeFileSync(join(dir, "ok.json"), JSON.stringify(plan()));
  writeFileSync(join(dir, "ledger.json"), JSON.stringify({ purchases: [{ key: `2026-10-01|${PAYTO}|0` }] }));
  const over = stepsCli("check-plan", join(dir, "over.json"), "--chain", "solana", "--day", "2026-10-01", "--per-payto", "1");
  assert.equal(over.status, 4);
  assert.match(over.stdout, /over the run cap/);
  assert.equal(stepsCli("check-plan", join(dir, "ok.json"), "--chain", "solana", "--day", "2026-10-01", "--per-payto", "1").status, 0);
  assert.equal(stepsCli("check-plan", join(dir, "over.json"), "--chain", "solana", "--day", "2026-10-01", "--per-payto", "1", "--ledger", join(dir, "ledger.json")).status, 0);
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
  const text = read(join(FIX, "manifest.json"));
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
  const same = updateManifest(r.text, { label: "remeasure/solana-2026-09-30", path: "remeasure/solana-2026-09-30.json", sha256: "f".repeat(64), source: "", day: "2026-09-30", redactions: [] });
  assert.equal(same.changed, false);
  const e29 = before.files.find((f: { label: string }) => f.label === "remeasure/solana-2026-09-29");
  assert.equal(updateManifest(text, { label: e29.label, path: e29.path, sha256: e29.sha256, source: e29.source, day: "2026-09-29", redactions: [] }).changed, false);
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
    // host names and slugs (us-east-2 in a seller's host) are not wording
    const words = t.replace(/\bUS\b/g, "").replace(/[A-Za-z0-9]+(?:[-.][A-Za-z0-9]+)+/g, " ");
    assert.ok(!FIRST_PLURAL.test(words), `${f}: first person plural`);
    assert.ok(!/\/Users\/[a-z]/.test(t.replace(/\/Users\/<name>\//g, "").replace(/\/Users\/runner\//g, "")), `${f}: a home path`);
  }
});

// ---------- run.sh against a throwaway repository ----------

const RUN = join(ROOT, "scripts", "daily", "run.sh");
const at = (iso: string) => String(Math.floor(Date.parse(iso) / 1000));
/**
 * The pre-push review gate the runner checks every data commit against, as installed in vet402's clones
 * (git notes --ref=review SHIP required unless every changed path is data/ or site/). The sandbox installs
 * this copy itself, so the tests do not depend on the clone they run in.
 */
const PRE_PUSH_HOOK = `#!/bin/bash
set -u
DATA_RE="\${REVIEW_GATE_DATA_RE:-$(git config --get reviewgate.datare || echo '^$')}"
zero=0000000000000000000000000000000000000000
fail=0
while read -r lref lsha rref rsha; do
  [ "$lsha" = "$zero" ] && continue
  if [ "$rsha" = "$zero" ]; then range="$lsha --not --remotes"; else range="$rsha..$lsha"; fi
  for c in $(git rev-list $range); do
    paths=$(git diff-tree --no-commit-id --name-only -r "$c")
    nondata=$(printf '%s\\n' "$paths" | grep -Ev "$DATA_RE" | grep -v '^$' || true)
    [ -z "$nondata" ] && continue
    if ! git notes --ref=review show "$c" 2>/dev/null | grep -q '^SHIP'; then
      echo "review-gate: $(git log -1 --format='%h %s' "$c") has no review SHIP note" >&2
      fail=1
    fi
  done
done
[ $fail -eq 0 ] || { echo "review-gate: push refused" >&2; exit 1; }
`;

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
  receipts: string;
  env: NodeJS.ProcessEnv;
}

function git(cwd: string, ...args: string[]) {
  const r = spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const FAKE_REMEASURE = `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2), v = (n) => a[a.indexOf(n) + 1];
appendFileSync(process.env.FAKE_CALLS, a.join(" ") + "\\n");
if (a.includes("--pay")) process.exit(0);
const chain = v("--chain"), out = v("--out"), day = new Date(Number(process.env.VET402_DAILY_NOW) * 1000).toISOString().slice(0, 10);
const est = process.env["FAKE_ESTIMATE_" + chain.toUpperCase()] ?? process.env.FAKE_ESTIMATE ?? "0.500000";
const rows = Array.from({ length: 10 }, (_, i) => ({ key: day + "|226DYoWb2e6uYxDkFp7vK8jZhzzh2VNvHH6DgbDsNueC|" + i, outcome: "would_pay", priceUsdc: i === 0 ? est : "0.000000" }));
mkdirSync(out, { recursive: true });
writeFileSync(out + "/" + chain + "-" + day + ".dry-run.json", JSON.stringify({ kind: "vet402-remeasure-dry-run", chain, createdAt: day + "T01:18:00.000Z", perPayTo: Number(v("--per-payto")),
  caps: { perRun: chain === "solana" ? "3.000000" : "1.000000", monthLeft: "25.000000" },
  summary: { would: 10, estimate: est, payerUsdcBefore: "40.000000", payerUsdcEBefore: "15.000000" }, rows }));
`;

const FAKE_RANK = `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2), out = a[a.indexOf("--out") + 1], m = JSON.parse(readFileSync("data/manifest.json", "utf8"));
mkdirSync(out, { recursive: true });
writeFileSync(out + "/rank-" + m.date + ".json", JSON.stringify({ date: m.date, inputs: m.files.length }) + "\\n");
`;

const FAKE_BUILD_SITE = `import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2), report = a[a.indexOf("--report") + 1], out = a[a.indexOf("--out") + 1];
mkdirSync(out, { recursive: true });
writeFileSync(out + "/rank.json", readFileSync(report, "utf8"));
`;

/** Stand-ins for the daily-records scripts: they log their arguments and write what the real ones would. */
const FAKE_RECORDS: Record<string, string> = {
  "build-receipts.ts": `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2), v = (n: string) => a[a.indexOf(n) + 1];
appendFileSync(process.env.FAKE_CALLS!, "build-receipts " + a.join(" ") + "\\n");
mkdirSync(v("--out") + "/" + v("--day"), { recursive: true });
writeFileSync(v("--out") + "/" + v("--day") + "/sources.json", "{}");
writeFileSync(v("--out") + "/" + v("--day") + "/obs_" + v("--day") + "_000001.json", "{}");
`,
  "verify-receipt.ts": `import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_CALLS!, "verify-receipt " + process.argv[2] + "\\n");
console.log("RESULT: OK (not yet anchored)");
`,
  "publish-records.ts": `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2), v = (n: string) => a[a.indexOf(n) + 1];
appendFileSync(process.env.FAKE_CALLS!, "publish-records " + a.join(" ") + "\\n");
mkdirSync(v("--data") + "/records/" + v("--day"), { recursive: true });
writeFileSync(v("--data") + "/records/" + v("--day") + "/index.json", JSON.stringify({ day: v("--day") }) + "\\n");
`,
  "anchor-receipts.ts": `import { appendFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2), v = (n: string) => a[a.indexOf(n) + 1];
appendFileSync(process.env.FAKE_CALLS!, "anchor-receipts " + a.join(" ") + "\\n");
if (a.includes("--send")) writeFileSync(process.env.FAKE_RECEIPTS + "/" + v("--day") + "/anchor-sent.json", JSON.stringify({ status: "sent" }, null, 2));
`,
};

/** A bare origin, a clone on main that looks like this repository to run.sh, and fake scripts. */
function sandbox(opts: { records?: boolean } = {}): Sandbox {
  const dir = tmp();
  const home = join(dir, "home");
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  mkdirSync(join(home, ".config", "vet402-daily"), { recursive: true });
  mkdirSync(join(seed, "fake"), { recursive: true });
  const pkg = { name: "fake", private: true, type: "module", scripts: { remeasure: "node fake/remeasure.mjs", rank: "node fake/rank.mjs", typecheck: "node -e 0", test: "node -e 0" } };
  writeFileSync(join(seed, "package.json"), JSON.stringify(pkg, null, 2));
  writeFileSync(join(seed, "package-lock.json"), JSON.stringify({ name: "fake", lockfileVersion: 3, requires: true, packages: { "": { name: "fake" } } }, null, 2));
  writeFileSync(join(seed, ".gitignore"), "node_modules/\n");
  cpSync(join(ROOT, "scripts", "daily"), join(seed, "scripts", "daily"), { recursive: true });
  cpSync(join(ROOT, "src", "daily"), join(seed, "src", "daily"), { recursive: true });
  writeFileSync(join(seed, "fake", "remeasure.mjs"), FAKE_REMEASURE);
  writeFileSync(join(seed, "fake", "rank.mjs"), FAKE_RANK);
  writeFileSync(join(seed, "scripts", "build-site.ts"), FAKE_BUILD_SITE);
  if (opts.records) {
    mkdirSync(join(seed, "src", "receipt"), { recursive: true });
    writeFileSync(join(seed, "src", "receipt", "sources.ts"), "export function assertDaySourcesCurrent() {}\n");
    for (const [name, body] of Object.entries(FAKE_RECORDS)) writeFileSync(join(seed, "scripts", name), body);
  }
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
  writeFileSync(join(repo, ".git", "hooks", "pre-push"), PRE_PUSH_HOOK);
  chmodSync(join(repo, ".git", "hooks", "pre-push"), 0o755);
  const rmdir = join(repo, "results", "remeasure");
  mkdirSync(rmdir, { recursive: true });
  const state = join(dir, "state");
  const alerts = join(dir, "ALERTS.md");
  const receipts = join(dir, "receipts");
  mkdirSync(receipts, { recursive: true });
  writeFileSync(join(home, ".config", "vet402-daily", "env"), `VET402_ALERTS_FILE=${alerts}\n`);
  const gh = join(dir, "gh");
  writeFileSync(gh, `#!/bin/bash\necho "gh $*" >> "$FAKE_CALLS"\n[ "$1 $2" = "run list" ] && echo "completed success"\nexit 0\n`);
  chmodSync(gh, 0o755);
  const sb: Sandbox = { dir, home, repo, pub: join(home, "vet402-solana-publish"), origin, state, alerts, calls: join(dir, "calls.log"), rmdir, receipts, env: {} };
  sb.env = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    VET402_TSX: TSX,
    VET402_GH: gh,
    VET402_KEYS: join(dir, "keys"),
    VET402_RECEIPTS: receipts,
    VET402_DAILY_STATE: state,
    VET402_DAILY_LOGS: join(dir, "logs"),
    VET402_DAILY_NOTIFY: "0",
    VET402_PAGES_POLL: "0",
    FAKE_CALLS: sb.calls,
    FAKE_RECEIPTS: receipts,
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

test("run.sh: without ~/.config/vet402-daily/env (the alert file) nothing runs", () => {
  const sb = sandbox();
  rmSync(join(sb.home, ".config", "vet402-daily", "env"));
  const r = runSh(sb, ["am"], { VET402_DAILY_NOW: at("2026-10-01T01:17:00Z") });
  assert.equal(r.status, 3);
  assert.match(logs(sb), /env is missing or has no VET402_ALERTS_FILE; nothing ran/);
  assert.equal(calls(sb), "");
  rmSync(sb.dir, { recursive: true });
});

test("run.sh: on or after 2026-10-09 (JST) nothing runs", () => {
  const sb = sandbox();
  const r = runSh(sb, ["am"], { VET402_DAILY_NOW: at("2026-10-09T01:17:00Z") });
  assert.equal(r.status, 0);
  assert.match(logs(sb), /JST 2026-10-09 is on or after 2026-10-09: nothing runs/);
  assert.equal(alerts(sb), "");
  assert.equal(calls(sb), "");
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

test("run.sh: Tempo over its cap after Solana: no Tempo payment, the lane halts, what Solana bought is still published", () => {
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
  writeFileSync(join(sb.rmdir, "solana-2026-10-01.json"), JSON.stringify({ kind: "vet402-remeasure", chain: "solana", date: "2026-10-01", runs: [], rows: [{ host: "a.example", outcome: "sent", detail: `{"session":"Zq8${b64url(seeded(8), 30)}"}` }] }));
  const r = runSh(sb, ["am", "--dry-run"], { VET402_DAILY_NOW: at("2026-10-01T01:17:00Z") });
  assert.equal(r.status, 1, logs(sb));
  assert.match(alerts(sb), /am stopped \(dry run\): secret gate stopped the copy of solana-2026-10-01\.json/);
  assert.match(logs(sb), /blocked: solana-2026-10-01\.json rows\[0\]\.detail secret-field/);
  assert.ok(!existsSync(join(sb.pub, "data", "remeasure", "solana-2026-10-01.json")));
  assert.ok(!calls(sb).includes("--pay"));
  assert.equal(git(sb.pub, "status", "--porcelain"), "");
  rmSync(sb.dir, { recursive: true });
});

test("run.sh --dry-run: copies through the gate, runs the tests, commits data/ and site/ only, passes the pre-push gate, never pushes", () => {
  const sb = sandbox();
  const jwt = `eyJhbGciOiJSUzI1NiJ9.${b64url(seeded(6), 90)}`;
  writeFileSync(join(sb.rmdir, "solana-2026-10-01.json"), JSON.stringify({ kind: "vet402-remeasure", chain: "solana", date: "2026-10-01", runs: [], rows: [{ host: "a.example", outcome: "sent", settled: true, delivered: true, detail: `{"auth":{"id_token":"${jwt}` }] }));
  const originBefore = git(sb.origin, "rev-parse", "main");
  const r = runSh(sb, ["am", "--dry-run"], { VET402_DAILY_NOW: at("2026-10-01T01:17:00Z") });
  assert.equal(r.status, 0, logs(sb));
  assert.equal(alerts(sb), "");
  assert.match(logs(sb), /> typecheck[\s\S]*> npm test/);
  const m = logs(sb).match(/commit ([0-9a-f]{40}): (.*)/);
  assert.ok(m, logs(sb));
  assert.equal(m[2], "data: 2026-10-01 remeasure on Solana (1 rows: 1 paid, 1 settled, 1 delivered); a seller-issued token redacted");
  assert.deepEqual(git(sb.repo, "diff-tree", "--no-commit-id", "--name-only", "-r", m[1]!).split("\n").sort(), ["data/manifest.json", "data/remeasure/solana-2026-10-01.json", "site/rank.json"]);
  const copy = git(sb.repo, "show", `${m[1]}:data/remeasure/solana-2026-10-01.json`);
  assert.ok(!copy.includes(jwt) && copy.includes(SELLER_TOKEN_REDACTION));
  assert.equal(git(sb.origin, "rev-parse", "main"), originBefore, "nothing pushed");
  assert.equal(git(sb.pub, "rev-parse", "HEAD"), originBefore, "publish worktree back at origin/main");
  assert.equal(git(sb.pub, "status", "--porcelain"), "");
  assert.ok(!calls(sb).includes("--pay"));
  rmSync(sb.dir, { recursive: true });
});

test("run.sh --dry-run with nothing new: the same typecheck and tests still run", () => {
  const sb = sandbox();
  const r = runSh(sb, ["pm", "--dry-run"], { VET402_DAILY_NOW: at("2026-10-01T13:17:00Z") });
  assert.equal(r.status, 0, logs(sb));
  assert.match(logs(sb), /no remeasure result for 2026-10-01: nothing to publish/);
  // with a result that is already published, the publish step runs the tests before finding nothing to commit
  writeFileSync(join(sb.rmdir, "solana-2026-10-01.json"), JSON.stringify({ kind: "vet402-remeasure", rows: [] }));
  const r2 = runSh(sb, ["pm", "--dry-run"], { VET402_DAILY_NOW: at("2026-10-01T13:17:00Z") });
  assert.equal(r2.status, 0, logs(sb));
  rmSync(sb.dir, { recursive: true });
});

// ---------- run.sh records: every closed day not anchored, oldest first, at most 3 ----------

function recordsBox() {
  const sb = sandbox({ records: true });
  for (const d of ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"]) writeFileSync(join(sb.rmdir, `solana-${d}.json`), "{}");
  mkdirSync(join(sb.receipts, "2026-09-29"), { recursive: true });
  writeFileSync(join(sb.receipts, "2026-09-29", "anchor-sent.json"), JSON.stringify({ status: "sent" }, null, 2));
  mkdirSync(join(sb.repo, "data", "records", "2026-09-29"), { recursive: true }); // anchored and published: done
  return sb;
}

test("records: without records-enabled, the open days (oldest first, at most 3) run as a dry run: simulated anchor, nothing pushed", () => {
  const sb = recordsBox();
  const originBefore = git(sb.origin, "rev-parse", "main");
  const r = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-03T00:10:00Z") });
  assert.equal(r.status, 0, logs(sb));
  assert.match(logs(sb), /records-enabled is absent: records run as a dry run/);
  assert.match(logs(sb), /days to record \(oldest first, at most 3\): 2026-09-30 2026-10-01 2026-10-02/);
  const anchors = calls(sb).split("\n").filter((l) => l.startsWith("anchor-receipts"));
  assert.equal(anchors.length, 3);
  assert.ok(anchors.every((l) => !l.includes("--send") && l.includes("--from")), anchors.join("\n"));
  assert.ok(!calls(sb).includes("2026-10-03"), "the open UTC day is left alone");
  assert.equal(git(sb.origin, "rev-parse", "main"), originBefore, "nothing pushed");
  assert.ok(!existsSync(join(sb.receipts, "2026-09-30")), "the real records folder is untouched");
  rmSync(sb.dir, { recursive: true });
});

test("records: with records-enabled, each open day is built, verified, anchored with --send once, then one publish", () => {
  const sb = recordsBox();
  writeFileSync(join(sb.home, ".config", "vet402-daily", "records-enabled"), "");
  const r = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-03T00:10:00Z") });
  assert.equal(r.status, 0, logs(sb));
  const anchors = calls(sb).split("\n").filter((l) => l.startsWith("anchor-receipts"));
  assert.deepEqual(anchors, ["anchor-receipts --day 2026-09-30 --send", "anchor-receipts --day 2026-10-01 --send", "anchor-receipts --day 2026-10-02 --send"]);
  assert.match(git(sb.origin, "log", "-1", "--format=%s", "main"), /^records: 2026-09-30,2026-10-01,2026-10-02 delivery records and each day's root, anchored on Solana$/);
  // The next run finds nothing left: every closed day is anchored.
  const r2 = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-03T00:20:00Z") });
  assert.equal(r2.status, 0, logs(sb));
  assert.match(logs(sb), /no closed day with purchases waits for its records/);
  assert.equal(calls(sb).split("\n").filter((l) => l.includes("--send")).length, 3);
  rmSync(sb.dir, { recursive: true });
});

test("run.sh --dry-run on a day with no purchase: a made-up copy of the newest day, dated today, goes through the whole publish", () => {
  const sb = sandbox();
  writeFileSync(join(sb.rmdir, "solana-2026-09-30.json"), JSON.stringify({ kind: "vet402-remeasure", chain: "solana", date: "2026-09-30", runs: [], rows: [{ host: "a.example", key: "2026-09-30|226DYoWb2e6uYxDkFp7vK8jZhzzh2VNvHH6DgbDsNueC|0", outcome: "sent", settled: true, delivered: true, detail: "{}" }] }));
  const r = runSh(sb, ["pm", "--dry-run"], { VET402_DAILY_NOW: at("2026-10-01T13:17:00Z") });
  assert.equal(r.status, 0, logs(sb));
  assert.match(logs(sb), /solana has no result for 2026-10-01; publishing a made-up copy of 2026-09-30 dated 2026-10-01/);
  assert.match(logs(sb), /> typecheck[\s\S]*> npm test[\s\S]*commit [0-9a-f]{40}: data: 2026-10-01 remeasure on Solana/);
  rmSync(sb.dir, { recursive: true });
});

test("records: a day anchored but not on main (its publish failed) is published again without a second anchor", () => {
  const sb = sandbox({ records: true });
  writeFileSync(join(sb.rmdir, "solana-2026-09-30.json"), "{}");
  mkdirSync(join(sb.receipts, "2026-09-30"), { recursive: true });
  writeFileSync(join(sb.receipts, "2026-09-30", "sources.json"), "{}");
  writeFileSync(join(sb.receipts, "2026-09-30", "obs_2026-09-30_000001.json"), "{}");
  writeFileSync(join(sb.receipts, "2026-09-30", "anchor-sent.json"), JSON.stringify({ status: "sent" }, null, 2));
  writeFileSync(join(sb.home, ".config", "vet402-daily", "records-enabled"), "");
  const r = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-01T00:10:00Z") });
  assert.equal(r.status, 0, logs(sb));
  assert.match(logs(sb), /days to record \(oldest first, at most 3\): 2026-09-30/);
  assert.match(logs(sb), /2026-09-30 root already anchored/);
  assert.ok(!calls(sb).includes("anchor-receipts"), "no anchor sent again");
  assert.match(git(sb.origin, "log", "-1", "--format=%s", "main"), /^records: 2026-09-30 delivery records/);
  rmSync(sb.dir, { recursive: true });
});

test("launch.sh: when run.sh is missing, launchd's start still writes the alert line", () => {
  const dir = tmp();
  const home = join(dir, "home");
  mkdirSync(join(home, ".config", "vet402-daily"), { recursive: true });
  writeFileSync(join(home, ".config", "vet402-daily", "env"), `VET402_ALERTS_FILE=${join(dir, "ALERTS.md")}\n`);
  const r = spawnSync("/bin/bash", [join(ROOT, "scripts", "daily", "launchd", "launch.sh"), "am"], { env: { HOME: home, PATH: "/usr/bin:/bin", VET402_DAILY_NOTIFY: "0" }, encoding: "utf8" });
  assert.equal(r.status, 3);
  assert.match(read(join(dir, "ALERTS.md")), /\[vet402_daily\] am did not run: .*vet402-solana\/scripts\/daily\/run\.sh is missing/);
  rmSync(dir, { recursive: true });
});

test("run.sh end dates: on 2026-10-09 JST records still records UTC 2026-10-08 while am and pm do nothing; on 2026-10-10 records stops too", () => {
  const sb = sandbox({ records: true });
  writeFileSync(join(sb.rmdir, "solana-2026-10-08.json"), "{}");
  const am = runSh(sb, ["am"], { VET402_DAILY_NOW: at("2026-10-09T01:17:00Z") });
  const pm = runSh(sb, ["pm"], { VET402_DAILY_NOW: at("2026-10-09T13:17:00Z") });
  assert.equal(am.status, 0);
  assert.equal(pm.status, 0);
  assert.match(logs(sb), /JST 2026-10-09 is on or after 2026-10-09: nothing runs/);
  assert.ok(!calls(sb).includes("remeasure") && !calls(sb).includes("--chain"), "no remeasure on 2026-10-09");
  const rec = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-09T00:05:00Z") });
  assert.equal(rec.status, 0, logs(sb));
  assert.match(logs(sb), /days to record \(oldest first, at most 3\): 2026-10-08/);
  assert.match(calls(sb), /anchor-receipts --day 2026-10-08/);
  const before = calls(sb);
  const late = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-10T00:05:00Z") });
  assert.equal(late.status, 0);
  assert.match(logs(sb), /JST 2026-10-10 is on or after 2026-10-10: nothing runs/);
  assert.equal(calls(sb), before, "records does nothing on 2026-10-10");
  rmSync(sb.dir, { recursive: true });
});

// ---------- run.sh board: the vet402-algorand board workflow, watched from outside ----------

/** A stand-in for gh: FAKE_BOARD is the board file on main (unset = 404), FAKE_RUNNING the unfinished runs. */
function fakeGh(dir: string): string {
  const p = join(dir, "gh");
  writeFileSync(
    p,
    `#!/bin/bash
echo "gh $*" >> "$FAKE_CALLS"
case "$1" in
  api)
    if [ -n "\${FAKE_API_ERROR:-}" ]; then echo "gh: Server Error (HTTP 502)" >&2; exit 1; fi
    if [ -n "\${FAKE_BOARD:-}" ]; then printf '%s' "$FAKE_BOARD"; else printf '{"message":"Not Found","status":"404"}'; echo "gh: Not Found (HTTP 404)" >&2; exit 1; fi ;;
  run) echo "\${FAKE_RUNNING:-0}" ;;
  workflow) exit 0 ;;
esac
`,
  );
  chmodSync(p, 0o755);
  return p;
}

function boardBox() {
  const dir = tmp();
  const home = join(dir, "home");
  mkdirSync(join(home, ".config", "vet402-daily"), { recursive: true });
  const alertsFile = join(dir, "ALERTS.md");
  writeFileSync(join(home, ".config", "vet402-daily", "env"), `VET402_ALERTS_FILE=${alertsFile}\n`);
  const env = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    VET402_GH: fakeGh(dir),
    VET402_DAILY_STATE: join(dir, "state"),
    VET402_DAILY_LOGS: join(dir, "logs"),
    VET402_DAILY_NOTIFY: "0",
    VET402_DAILY_NOW: at("2026-10-01T10:05:00Z"),
    FAKE_CALLS: join(dir, "calls.log"),
  };
  const run = (extra: NodeJS.ProcessEnv = {}, args: string[] = []) => spawnSync("/bin/bash", [RUN, "board", ...args], { env: { ...env, ...extra }, encoding: "utf8", timeout: 60_000 });
  const ghCalls = () => (existsSync(env.FAKE_CALLS) ? read(env.FAKE_CALLS) : "");
  const dispatches = () => ghCalls().split("\n").filter((l) => l.startsWith("gh workflow run")).length;
  const alertText = () => (existsSync(alertsFile) ? read(alertsFile) : "");
  const logText = () => (existsSync(env.VET402_DAILY_LOGS) ? readdirSync(env.VET402_DAILY_LOGS).map((f) => read(join(env.VET402_DAILY_LOGS, f))).join("\n") : "");
  return { dir, run, ghCalls, dispatches, alertText, logText };
}

test("board: completedAt on main: nothing is started", () => {
  const b = boardBox();
  const r = b.run({ FAKE_BOARD: JSON.stringify({ date: "2026-10-01", completedAt: "2026-10-01T06:40:00.000Z" }) });
  assert.equal(r.status, 0, b.logText());
  assert.equal(b.dispatches(), 0);
  assert.match(b.ghCalls(), /gh api -H Accept: application\/vnd\.github\.raw repos\/kzmttkc\/vet402-algorand\/contents\/board\/2026-10-01\.json\?ref=main/);
  assert.equal(b.alertText(), "");
  rmSync(b.dir, { recursive: true });
});

test("board: no completedAt but a board run queued or running: nothing is started", () => {
  const b = boardBox();
  assert.equal(b.run({ FAKE_RUNNING: "1" }).status, 0, b.logText());
  assert.equal(b.run({ FAKE_RUNNING: "1", FAKE_BOARD: JSON.stringify({ date: "2026-10-01" }) }).status, 0, b.logText());
  assert.equal(b.dispatches(), 0);
  assert.match(b.logText(), /1 board run\(s\) queued or running: nothing to do/);
  rmSync(b.dir, { recursive: true });
});

test("board: no completedAt and nothing running: board.yml mode=daily is started once, with a notice", () => {
  const b = boardBox();
  assert.equal(b.run({ FAKE_BOARD: JSON.stringify({ date: "2026-10-01", finishedAt: "2026-10-01T06:30:00Z" }) }).status, 0, b.logText());
  assert.equal(b.dispatches(), 1);
  assert.match(b.ghCalls(), /^gh workflow run board\.yml -R kzmttkc\/vet402-algorand --ref main -f mode=daily$/m);
  assert.match(b.alertText(), /\[vet402_daily\] board: 2026-10-01 had no completedAt on main and no board run in progress; started board\.yml \(mode=daily\) once/);
  assert.equal(b.run().status, 0);
  assert.equal(b.dispatches(), 1);
  assert.equal(b.run({ VET402_DAILY_NOW: at("2026-10-02T10:05:00Z") }).status, 0);
  assert.equal(b.dispatches(), 2);
  rmSync(b.dir, { recursive: true });
});

test("board: dry run, an unreadable file, or on/after 2026-10-31 JST: nothing is started", () => {
  const b = boardBox();
  assert.equal(b.run({}, ["--dry-run"]).status, 0);
  assert.match(b.logText(), /dry run: would run gh workflow run board\.yml -R kzmttkc\/vet402-algorand --ref main -f mode=daily/);
  assert.equal(b.run({ FAKE_API_ERROR: "1" }).status, 1);
  assert.match(b.alertText(), /board stopped: could not read board\/2026-10-01\.json/);
  assert.equal(b.run({ FAKE_BOARD: "not json" }).status, 1);
  assert.equal(b.run({ VET402_DAILY_NOW: at("2026-10-30T15:00:00Z") }).status, 0);
  assert.match(b.logText(), /JST 2026-10-31 is on or after 2026-10-31: nothing runs/);
  assert.equal(b.dispatches(), 0);
  rmSync(b.dir, { recursive: true });
});
