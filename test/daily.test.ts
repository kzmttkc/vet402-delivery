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
import { dirname, join, resolve } from "node:path";
import {
  blockingFindings,
  describe,
  gateTree,
  isSecretName,
  loadAllowList,
  ownKeyNeedles,
  publicJson,
  redactKnown,
  POSTAL_ADDRESS_REDACTION,
  POSTAL_COORD_REDACTION,
  scanFileText,
  SELLER_TOKEN_REDACTION,
  type Finding,
} from "../src/daily/secret-gate.js";
import { alnum, b64url, base58, bytes, GATE_SHAPES, hex, seeded, withDetail } from "../src/daily/gate-shapes.js";
import { commitMessage, isMonthCapStop, ledgerKeys, planVerdict, redactionNote, runOutcome, updateManifest } from "../src/daily/steps.js";

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

test("gate: a public image URL passes by rule (the 2026-10-01 api.cookin.fun image_uri values), with no allow entry", () => {
  // the first 300 characters of rows[83] and rows[271] of data/remeasure/solana-2026-10-01.json, as published
  const row83 =
    '{"data":[{"name":"ICEPATRICK","description":null,"mint":"HSeQk9uf1PFB2Ghz7x5GpA7CuH2YrLvNF9FZFRP5ei5y","symbol":"ICEPATRICK","mcap":8148,"deployed_at":"2026-10-01T01:23:20.669800Z","launchpad":"pumpfun","image_uri":"https://metadata.j7tracker.io/images/6AY5H115fg","website":null,"twitter":"https://x';
  const row271 =
    '{"data":[{"name":"I Am Jane Doe","description":null,"mint":"FEVYjz1uqrGxF5gUfbAb7hHUTGFv7hycLWywsanJtLhm","symbol":"Jane","mcap":49364,"deployed_at":"2026-10-01T13:20:53.510321Z","launchpad":"pumpfun","image_uri":"https://axiomtrading-v2.axiom-cdn.io/A4VEVJchzfEvYzzCEuSGJLSwe1wcBjwNxHADhVGtxz6T.webp';
  // io/images/6AY5H115fg, io/A4VE...6T and A4VE...6T: allowed by hand on 2026-10-01 (the entries stay)
  const allowedByHand = ["9bb03c48056f56e5", "df176e971a7aaa55", "b74365b4f21c6ca0"];
  for (const body of [row83, row271]) {
    assert.equal(body.length, 300);
    const raw = blockingFindings(scanFileText(JSON.stringify({ rows: [{ detail: body }] }), "data/x.json"), []);
    assert.deepEqual(raw.map((f) => `${f.kind} ${f.shape}`), []);
    assert.deepEqual(raw.filter((f) => allowedByHand.includes(f.sha256.slice(0, 16))), []);
  }
  // a new random file name every day: passes in any of the image forms, without an allow entry
  const r = seeded(20261001);
  const none = (text: string, opts = {}) => blockingFindings(scanFileText(text, "data/x.json", opts), []);
  for (let i = 0; i < 40; i++) {
    const id = base58(bytes(r, 32));
    const forms = [
      `https://axiomtrading-v2.axiom-cdn.io/${id}.webp`, `https://cdn.example.io/token/${id}.png`, `https://cdn.example.io/a/${alnum(r, 30)}.JPG`,
      `https://cdn.example.io/${alnum(r, 30)}.jpeg`, `https://img.example.io:8443/${alnum(r, 30)}.gif`, `https://cdn.example.io/${b64url(r, 30)}.svg`,
      `https://metadata.j7tracker.io/images/${alnum(r, 30)}`, `https://cdn.example.io/images/${alnum(r, 20)}/${alnum(r, 30)}`,
    ];
    for (const u of forms) {
      assert.deepEqual(none(withDetail(`{"image_uri":"${u}","website":null}`)).map((f) => f.shape), [], u);
      // under a name that says nothing, inside prose, and with JSON-escaped slashes in a line that is not JSON
      assert.deepEqual(none(withDetail(`{"x":"see ${u} here"}`)).map((f) => f.shape), [], u);
      assert.deepEqual(none(`{"logo":"${u.replace(/\//g, "\\/")}"}`, "data/x.txt").map((f) => f.shape), [], u);
      assert.deepEqual(none(`{"detail":"{\\"logo\\":\\"${u.replace(/\//g, "\\\\\\/")}\\"}"`, "data/x.txt").map((f) => f.shape), [], u);
    }
  }
});

test("gate: an image URL with a query, a fragment, a secret in its path, or not an image still stops", () => {
  const r = seeded(20261002);
  const stops = (text: string, opts = {}) => blockingFindings(scanFileText(text, "data/x.json", opts), []).map((f) => f.kind);
  for (let i = 0; i < 30; i++) {
    const id = base58(bytes(r, 32));
    const img = `https://axiomtrading-v2.axiom-cdn.io/${id}.webp`;
    const cases: [string, Finding["kind"]][] = [
      // signed URLs: the query or the fragment holds the secret
      [`${img}?token=${alnum(r, 20)}`, "url-query-secret"],
      [`${img}?sig=${b64url(r, 40)}&exp=1`, "url-query-secret"],
      [`https://bucket.s3.amazonaws.com/images/${id}.png?X-Amz-Credential=AKIA${alnum(r, 16).toUpperCase()}&X-Amz-Signature=${hex(r, 64)}`, "url-query-secret"],
      [`${img}?v=${alnum(r, 30)}`, "opaque-40"],
      [`${img}#access_token=${alnum(r, 30)}`, "url-query-secret"],
      // not an image path: no extension, another extension, plain http, a trailing slash
      [`https://axiomtrading-v2.axiom-cdn.io/${id}`, "opaque-40"],
      [`https://cdn.example.io/${id}.json`, "opaque-40"],
      [`http://axiomtrading-v2.axiom-cdn.io/${id}.webp`, "opaque-40"],
      [`https://cdn.example.io/media/${alnum(r, 30)}/`, "opaque-40"],
      [`https://cdn.example.io/${alnum(r, 30)}/images`, "opaque-40"],
      // a path step that is not plain, or that signs the URL
      [`https://api.telegram.org/file/bot${String(100000000 + i)}:${alnum(r, 35)}/photos/file_1.jpg`, "opaque-40"],
      [`https://res.cloudinary.com/demo/image/upload/s--${alnum(r, 8)}--/${alnum(r, 30)}.png`, "opaque-40"],
      // the checks before the image rule still see the path
      [`https://cdn.example.io/eyJhbGciOiJIUzI1NiJ9.${b64url(r, 40)}.png`, "jwt"],
      [`https://cdn.example.io/sk_live_${alnum(r, 24)}.png`, "vendor-key"],
      [`https://admin:${alnum(r, 16)}@cdn.example.io/${id}.png`, "url-query-secret"],
    ];
    for (const [u, kind] of cases) assert.ok(stops(withDetail(`{"image_uri":"${u}"}`)).includes(kind), `${u}: ${JSON.stringify(stops(withDetail(`{"image_uri":"${u}"}`)))}`);
    // a value under a secret name stops even when it is an image URL
    assert.ok(stops(withDetail(`{"session":"${img}"}`)).includes("secret-field"));
  }
  // the runner's own key in an image URL path stops
  const key = base58(bytes(r, 64));
  assert.ok(stops(withDetail(`{"image":"https://cdn.example.io/${key}.png"}`), { ownKeys: [key] }).includes("own-key"));
});

test("gate: an image URL cut at the end of a 300-character body passes only under a field named for an image", () => {
  // rows[271] of 2026-10-01 ended exactly at .webp; a longer token name the next day cuts the same URL earlier
  const head = '{"data":[{"name":"I Am Jane Doe","description":null,"mint":"FEVYjz1uqrGxF5gUfbAb7hHUTGFv7hycLWywsanJtLhm","symbol":"Jane","mcap":49364,"deployed_at":"2026-10-01T13:20:53.510321Z","launchpad":"pumpfun",';
  const url = "https://axiomtrading-v2.axiom-cdn.io/A4VEVJchzfEvYzzCEuSGJLSwe1wcBjwNxHADhVGtxz6T.webp";
  const none = (body: string) => blockingFindings(scanFileText(withDetail(body), "data/x.json"), []);
  for (let cut = "https://axiomtrading-v2.axiom-cdn.io/".length; cut <= url.length; cut++) {
    assert.deepEqual(none(`${head}"image_uri":"${url.slice(0, cut)}`).map((f) => f.shape), [], url.slice(0, cut));
    assert.deepEqual(none(`${head}"logoURI":"${url.slice(0, cut)}`).map((f) => f.shape), [], url.slice(0, cut));
  }
  const r = seeded(20261003);
  for (let i = 0; i < 30; i++) {
    const cutId = alnum(r, 20 + (i % 20));
    assert.deepEqual(none(`${head}"image_uri":"https://cdn.example.io/a/${cutId}`).map((f) => f.shape), [], cutId);
    const stops = (body: string) => none(body).map((f) => f.kind);
    // not under an image field, or not at the end (the URL was not cut), or a step that is not plain
    assert.ok(stops(`${head}"website":"https://cdn.example.io/a/${cutId}`).includes("opaque-40"));
    assert.ok(stops(`${head}"image_uri":"https://cdn.example.io/a/${cutId}","website":null`).includes("opaque-40"));
    assert.ok(stops(`${head}"image_uri":"https://api.telegram.org/file/bot123456789:${cutId}`).includes("opaque-40"));
    assert.ok(stops(`${head}"image_uri":"https://res.cloudinary.com/demo/image/upload/s--${alnum(r, 8)}--/${cutId}`).includes("opaque-40"));
    // a query cut at the end is still read
    assert.ok(stops(`${head}"image_uri":"https://cdn.example.io/a/b.png?token=${cutId}`).includes("url-query-secret"));
    assert.ok(stops(`${head}"image_uri":"https://cdn.example.io/a/b?v=${cutId}`).includes("opaque-40"));
  }
});

test("gate: a seller's request id under the key request_id passes by rule (the api.cookin.fun meta.request_id that stopped 2026-10-02, -03 and -04), with no allow entry", () => {
  const dir = tmp();
  const empty = join(dir, "allow.json");
  writeFileSync(empty, JSON.stringify({ kind: "vet402-secret-gate-allow", allow: [], files: [] }));
  const r = seeded(20261004);
  // the shape of rows[83].detail on those three days: 20 characters, new each time; letters and digits on 10-03
  // and 10-04, a - among them on 10-02 (the shape AAaAAaa-A9AAa99AAaaA)
  const cookin = (id: string) => `{"data":[],"meta":{"request_id":"${id}","cached_at":"2026-10-04T01:23:45.678901Z"}}`;
  for (const id of [alnum(r, 20), `${alnum(r, 7)}-${alnum(r, 12)}`, `${alnum(r, 5)}_${alnum(r, 6)}-${alnum(r, 7)}`, b64url(r, 20), b64url(r, 20)]) {
    writeFileSync(join(dir, "in.json"), JSON.stringify({ rows: [{ host: "api.cookin.fun", detail: cookin(id) }] }));
    const c = gateCli("copy", join(dir, "in.json"), join(dir, "out.json"), "--allow", empty);
    assert.equal(c.status, 0, c.stderr);
  }
  const none = (text: string, name = "data/x.json") => blockingFindings(scanFileText(text, name), []).map((f) => `${f.kind} ${f.shape}`);
  for (let n = 16; n <= 32; n++) for (const id of [alnum(r, n), b64url(r, n), `${alnum(r, n - 2)}-_`.split("").sort(() => r() - 0.5).join("")]) {
    // any host, anywhere in the body, as a parsed field, and with JSON-escaped quotes in a line that is not JSON
    assert.deepEqual(none(withDetail(`{"ok":true,"request_id":"${id}"}`)), [], id);
    assert.deepEqual(none(withDetail(`{"meta":{"request_id" : "${id}"},"data":[]}`)), [], id);
    assert.deepEqual(none(JSON.stringify({ rows: [{ host: "s.example", meta: { request_id: id } }] })), [], id);
    assert.deepEqual(none(`{"detail":"{\\"meta\\":{\\"request_id\\":\\"${id}\\"}}"}`, "data/x.txt"), [], id);
  }
  rmSync(dir, { recursive: true });
});

test("gate: under request_id a key's shape, a longer or cut value, the runner's key, and any other name still stop", () => {
  const r = seeded(20261005);
  const stops = (text: string, opts = {}) => blockingFindings(scanFileText(text, "data/x.json", opts), []).map((f) => f.kind);
  const body = (v: string, k = "request_id") => withDetail(`{"data":[],"meta":{"${k}":"${v}"}}`);
  const field = (v: string) => JSON.stringify({ rows: [{ host: "s.example", meta: { request_id: v } }] });
  // a key's shape under the very name the rule reads: each check before the rule stops it, including the vendor
  // keys with _ or - in them that fit in 32 characters (the rule's own range)
  const shaped: [string, Finding["kind"]][] = [
    [`sk_live_${alnum(r, 24)}`, "vendor-key"],
    [`sk_live_${alnum(r, 16)}`, "vendor-key"],
    [`rk_test_${alnum(r, 16)}`, "vendor-key"],
    [`ghp_${alnum(r, 36)}`, "vendor-key"],
    [`ghp_${alnum(r, 20)}`, "vendor-key"],
    [`github_pat_${alnum(r, 20)}`, "vendor-key"],
    [`glpat-${alnum(r, 16)}`, "vendor-key"],
    [`xoxb-${alnum(r, 12)}`, "vendor-key"],
    [`re_${alnum(r, 8)}_${alnum(r, 16)}`, "vendor-key"],
    [`sk-${alnum(r, 24)}`, "vendor-key"],
    [`AKIA${alnum(r, 16).toUpperCase()}`, "vendor-key"],
    [base58(bytes(r, 32)), "opaque-40"],
    [base58(bytes(r, 64)), "opaque-40"],
    [hex(r, 64), "opaque-40"],
    [`Bearer ${alnum(r, 24)}`, "bearer"],
    [`eyJhbGciOiJIUzI1NiJ9.${b64url(r, 40)}.${b64url(r, 20)}`, "jwt"],
    [`eyJ${alnum(r, 17)}`, "jwt"],
    [`eyJ${b64url(r, 25)}`, "jwt"],
    [`eyJhbGci.${b64url(r, 12)}`, "jwt"],
  ];
  for (const [v, kind] of shaped) {
    assert.ok(stops(body(v)).includes(kind), `${v.slice(0, 6)}: ${JSON.stringify(stops(body(v)))}`);
    assert.ok(stops(field(v)).includes(kind), `${v.slice(0, 6)} as a field: ${JSON.stringify(stops(field(v)))}`);
  }
  for (let i = 0; i < 5; i++) {
    const id = alnum(r, 20);
    // the same value under any other name, including names close to request_id
    for (const k of ["token", "api_key", "secret", "authorization", "x-request-id-signature", "x_request_id", "request_id_sig", "requestId", "Request_Id", "request-id", "ref"]) {
      assert.ok(stops(body(id, k)).length > 0, `${k}: passed`);
    }
    // longer than 32, or cut at the end of a body (no closing quote)
    assert.ok(stops(body(alnum(r, 33))).includes("opaque-40"));
    assert.ok(stops(body(alnum(r, 40))).includes("opaque-40"));
    assert.ok(stops(field(alnum(r, 33))).includes("opaque-40"));
    assert.ok(stops(withDetail(`{"data":[],"meta":{"request_id":"${id}`)).includes("opaque-40"));
    // - and _ in the value pass (the 2026-10-02 shape); any other character does not
    assert.deepEqual(stops(body(`${alnum(r, 7)}-${alnum(r, 12)}`)), []);
    assert.deepEqual(stops(body(`${alnum(r, 5)}_${alnum(r, 6)}-${alnum(r, 7)}`)), []);
    assert.deepEqual(stops(field(`${alnum(r, 7)}-${alnum(r, 12)}`)), []);
    assert.ok(stops(body(`${alnum(r, 20)}.${alnum(r, 8)}`)).includes("opaque-40"));
    assert.ok(stops(body(`${alnum(r, 20)}+${alnum(r, 8)}`)).includes("opaque-40"));
    assert.ok(stops(body(`${alnum(r, 20)}/${alnum(r, 8)}`)).includes("opaque-40"));
    // the runner's own key stops whatever its length and place
    assert.ok(stops(body(id), { ownKeys: [id] }).includes("own-key"));
    assert.ok(stops(field(id), { ownKeys: [id] }).includes("own-key"));
  }
  // through the CLI with --keys-dir: each encoding of the runner's key under request_id stops the copy
  const dir = tmp();
  const keys = join(dir, "keys");
  mkdirSync(keys);
  writeFileSync(join(keys, "payer.json"), JSON.stringify([...bytes(r, 64)]));
  const empty = join(dir, "allow.json");
  writeFileSync(empty, JSON.stringify({ kind: "vet402-secret-gate-allow", allow: [], files: [] }));
  for (const n of ownKeyNeedles(keys)) {
    writeFileSync(join(dir, "in.json"), JSON.stringify({ rows: [{ detail: `{"data":[],"meta":{"request_id":"${n}"}}` }] }));
    const c = gateCli("copy", join(dir, "in.json"), join(dir, "out.json"), "--keys-dir", keys, "--allow", empty);
    assert.equal(c.status, 3, c.stdout);
    assert.match(c.stderr, /own-key/);
    assert.ok(!existsSync(join(dir, "out.json")));
  }
  rmSync(dir, { recursive: true });
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

/**
 * The shape of 2026-09-30 Solana rows[230] (rentcast.x402.paysponge.com /avm/rent/long-term): the street address
 * vet402 sent stands in the request URL, and the answer repeats it as an id slug, formattedAddress and
 * addressLine1, next to the house's coordinates. The address and coordinates here are made up; the real ones
 * are what the gate is for.
 */
const HOME = { line: "100 Sample Ave", full: "100 Sample Ave, Anytown, TX 75001", slug: "100-Sample-Ave,-Anytown,-TX-75001", query: "100+Sample+Ave%2C+Anytown%2C+TX%2C+75001" };
const addressRow = () => ({
  host: "rentcast.x402.paysponge.com",
  requestUrl: `https://rentcast.x402.paysponge.com/avm/rent/long-term?address=${HOME.query}&compCount=5`,
  detail: `{"rent":1640,"rentRangeLow":1510,"rentRangeHigh":1770,"latitude":29.123456,"longitude":-98.123456,"subjectProperty":{"id":"${HOME.slug}","formattedAddress":"${HOME.full}","addressLine1":"${HOME.line}","addressLine2":null,"city":"Anytown","state":"TX","zipCode":"75001","county":"Bexar","propertyType":"Single Family"}}`.slice(0, 300),
});

test("gate: a street address in a seller's answer and in the request vet402 sent is redacted in every form (the 2026-09-30 Solana rows[230] shape)", () => {
  const { value, redactions } = redactKnown({ rows: [addressRow()] });
  const row = (value as { rows: { requestUrl: string; detail: string }[] }).rows[0]!;
  const text = publicJson(value);
  for (const form of [HOME.line, HOME.slug, "Sample+Ave", "29.123456", "-98.123456"]) assert.ok(!text.includes(form), form);
  assert.equal(row.requestUrl, "https://rentcast.x402.paysponge.com/avm/rent/long-term?address=%5Bredacted%3A+street+address%5D&compCount=5");
  assert.equal(new URL(row.requestUrl).searchParams.get("address"), POSTAL_ADDRESS_REDACTION);
  assert.equal(row.detail.split(POSTAL_ADDRESS_REDACTION).length - 1, 3, row.detail);
  assert.ok(row.detail.includes(`"latitude":"${POSTAL_COORD_REDACTION}","longitude":"${POSTAL_COORD_REDACTION}"`), row.detail);
  // a city, a state and a ZIP code alone stay
  assert.ok(row.detail.includes(`"city":"Anytown","state":"TX"`), row.detail);
  assert.deepEqual(redactions, [
    { path: "rows[0].requestUrl", what: "postal-address" },
    { path: "rows[0].detail", what: "postal-address" },
  ]);
  // Left in, the address stops the gate as a known shape; no allow entry can let it through.
  const left = blockingFindings(scanFileText(JSON.stringify({ rows: [addressRow()] }, null, 2), "x.json"), loadAllowList(ALLOW));
  const addr = left.filter((f) => f.kind === "postal-address");
  assert.deepEqual([...new Set(addr.map((f) => f.path))].sort(), ["rows[0].detail", "rows[0].requestUrl"]);
  assert.deepEqual([...new Set(addr.filter((f) => f.known).map((f) => f.path))].sort(), ["rows[0].detail", "rows[0].requestUrl"]);
  const dir = tmp();
  writeFileSync(join(dir, "allow.json"), JSON.stringify({ kind: "vet402-secret-gate-allow", allow: [{ sha256: "a".repeat(64), kind: "postal-address", reason: "x" }] }));
  assert.throws(() => loadAllowList(join(dir, "allow.json")), /can never be allowed/);
  // The copy step: redacted and written, nothing stops.
  writeFileSync(join(dir, "in.json"), JSON.stringify({ rows: [addressRow()] }));
  const r = gateCli("copy", join(dir, "in.json"), join(dir, "out.json"));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(join(dir, "out.json")), text);
  assert.deepEqual(JSON.parse(r.stdout).redactions, redactions);
  rmSync(dir, { recursive: true });
});

test("gate: a listed public address, a city, a state or a ZIP code alone, and prose with numbers are not redacted", () => {
  const keep = [
    "354 Oyster Point Blvd, South San Francisco, CA 94080",
    "https://x.example/avm?address=354+Oyster+Point+Blvd%2C+South+San+Francisco%2C+CA+94080",
    "?q=1600+Pennsylvania+Ave+NW%2C+Washington%2C+DC&limit=1",
    "Anytown, TX 75001",
    "https://x402-factory.com/v1/forecast/san-antonio/window",
    "3 days to run the first way",
    "Top 10 Dr Pepper flavors",
    "rows 4 and 192 Main results",
  ];
  const doc = { rows: keep.map((detail) => ({ detail })) };
  const { value, redactions } = redactKnown(doc);
  assert.deepEqual(value, doc);
  assert.deepEqual(redactions, []);
  assert.deepEqual(scanFileText(JSON.stringify(doc), "x.json").filter((f) => f.kind === "postal-address"), []);
  assert.equal(redactionNote("remeasure/x.json", [{ path: "rows[1].requestUrl", what: "postal-address" }, { path: "rows[1].detail", what: "postal-address" }]), "remeasure/x.json rows[1].requestUrl and rows[1].detail: a street address (a seller's example input, or an answer that repeats it) is replaced with [redacted]");
});

test("gate: a street address in lower case, in a lower-case URL slug, split over two fields, or with number coordinates is redacted and stops the scan", () => {
  // Made up, as HOME above. Each form was missed before (review of 752facd).
  const lower = "100 sample ave, anytown, tx 75001";
  const strings = [
    lower,
    "100 SAMPLE AVE, ANYTOWN, TX 75001",
    "https://x.test/properties/100-sample-ave-anytown-tx-75001?limit=1",
    "/properties/100_sample_ave_anytown_tx_75001",
    "100%20sample%20ave%2c%20anytown%2c%20tx%2075001",
    "https://x.test/avm?address=100+sample+ave&limit=1",
    `{"address":"100 sample ave","limit":1}`,
  ];
  for (const s of strings) {
    const { value, redactions } = redactKnown({ detail: s });
    const text = JSON.stringify(value);
    assert.ok(!/100.sample/i.test(text) && !/100%20sample/i.test(text), `${s} -> ${text}`);
    assert.deepEqual(redactions, [{ path: "detail", what: "postal-address" }], s);
    assert.ok(scan(JSON.stringify({ detail: s })).some((f) => f.kind === "postal-address" && f.known), s);
    assert.deepEqual(scan(text).filter((f) => f.kind === "postal-address"), [], `after redaction: ${text}`);
  }
  const objects: [unknown, unknown][] = [
    // a lower-case address under an address-named field
    [{ address: "100 sample ave" }, { address: POSTAL_ADDRESS_REDACTION }],
    // house number and street name in fields of their own
    [{ houseNumber: "100", streetName: "Sample Ave", city: "Anytown" }, { houseNumber: POSTAL_ADDRESS_REDACTION, streetName: POSTAL_ADDRESS_REDACTION, city: "Anytown" }],
    [{ streetNumber: 100, street: "sample ave" }, { streetNumber: POSTAL_ADDRESS_REDACTION, street: POSTAL_ADDRESS_REDACTION }],
    // coordinates as JSON numbers next to the address, and one level up (the rentcast answer's shape parsed)
    [
      { rent: 1640, latitude: 29.123456, longitude: -98.123456, subjectProperty: { formattedAddress: lower, latitude: 29.1 } },
      { rent: 1640, latitude: POSTAL_COORD_REDACTION, longitude: POSTAL_COORD_REDACTION, subjectProperty: { formattedAddress: POSTAL_ADDRESS_REDACTION, latitude: POSTAL_COORD_REDACTION } },
    ],
    // a geocoder's answer: the coordinates sit deeper than the address
    [
      { results: [{ formatted_address: "100 Sample Ave, Anytown, TX 75001", geometry: { location: { lat: 29.1, lng: -98.1 } } }] },
      { results: [{ formatted_address: POSTAL_ADDRESS_REDACTION, geometry: { location: { lat: POSTAL_COORD_REDACTION, lng: POSTAL_COORD_REDACTION } } }] },
    ],
  ];
  for (const [input, want] of objects) {
    const { value, redactions } = redactKnown(input);
    assert.deepEqual(value, want, JSON.stringify(input));
    assert.ok(redactions.length > 0 && redactions.every((r) => r.what === "postal-address"), JSON.stringify(redactions));
    assert.ok(scan(JSON.stringify(input)).some((f) => f.kind === "postal-address" && f.known), JSON.stringify(input));
    assert.deepEqual(scan(JSON.stringify(value)).filter((f) => f.kind === "postal-address"), [], JSON.stringify(value));
  }
  // Number coordinates left next to the mark of a redacted address still stop the scan.
  assert.ok(scan(JSON.stringify({ formattedAddress: POSTAL_ADDRESS_REDACTION, lat: 29.1, lng: -98.1 })).some((f) => f.kind === "postal-address"));
});

test("gate: lower-case prose with numbers and street words, public addresses with coordinates, wallet addresses and lone coordinates stay", () => {
  const keep: unknown[] = [
    { detail: "the 3 in first place" },
    { detail: "a 5-inch-drive bay" },
    { detail: "https://x.test/products/5-inch-drive-bay" },
    { detail: "i paid 5 dollars st" },
    { detail: "block 12345 solana mainnet ln" },
    { detail: "took 2 days on the way home, tx 0xabc" },
    { detail: "they got 12 new sellers in the way, ca 94105 later" },
    { detail: "v2 api route 3 way" },
    { address: "354 Oyster Point Blvd, South San Francisco, CA 94080", lat: 37.66, lng: -122.38 },
    { address: "0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51", lat: 1.5 },
    { lat: 37.7749, lng: -122.4194, city: "San Francisco" },
    { houseNumber: "12", note: "no street field" },
    // a redacted address in one row does not reach the coordinates of another row
    { rows: [{ requestUrl: "https://x.test/a?address=%5Bredacted%3A+street+address%5D" }, { answer: { lat: 37.7749, lng: -122.4 } }] },
  ];
  for (const doc of keep) {
    const { value, redactions } = redactKnown(doc);
    assert.deepEqual(value, doc, JSON.stringify(doc));
    assert.deepEqual(redactions, []);
    assert.deepEqual(scanFileText(JSON.stringify(doc), "x.json").filter((f) => f.kind === "postal-address"), [], JSON.stringify(doc));
  }
});

test("gate: results/ tracks only the files docs/ and test/ name, and the secret gate reads results/ in the scan and in the daily publish", () => {
  // results/evm/declared-inputs.jsonl: rule 0's material for the EVM lanes (src/evm/lane-records.ts), names and sources only.
  const KEPT = ["results/base-buy-dryrun.json", "results/base-feedback-dryrun.json", "results/erc8004-simulate.json", "results/evm/arbitrum-dryrun.json", "results/evm/declared-inputs.jsonl", "results/evm/robinhood-dryrun.json"];
  const ls = spawnSync("git", ["ls-files", "results"], { cwd: ROOT, encoding: "utf8" });
  if (ls.status === 0 && ls.stdout.trim() !== "") assert.deepEqual(ls.stdout.trim().split("\n").sort(), KEPT);
  assert.match(read(join(ROOT, "scripts", "daily", "run.sh")), /gate scan "\$PUB" data site results\b/);
  assert.match(read(join(ROOT, "scripts", "daily", "secret-gate.ts")), /\["data", "site", "results"\]/);
  // The kept files pass the gate as they are (checked on copies: a working tree may hold other, local results).
  const dir = tmp();
  for (const f of KEPT) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), read(join(ROOT, f)));
  }
  assert.deepEqual(gateTree(dir, ["results"], loadAllowList(ALLOW)).blocking.map(describe), []);
  rmSync(dir, { recursive: true });
});

test("gate: redactKnown changes no published data/ file (the address in the 2026-09-28 Tempo census plan is already redacted)", () => {
  const walkJson = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walkJson(join(d, e.name)) : e.name.endsWith(".json") ? [join(d, e.name)] : []));
  const files = walkJson(join(ROOT, "data"));
  assert.ok(files.length > 10);
  for (const p of files) {
    const parsed = JSON.parse(read(p));
    const { value, redactions } = redactKnown(parsed);
    assert.deepEqual(redactions, [], p);
    assert.deepEqual(value, parsed, p);
  }
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

test("run outcome: a run that ended at the month cap is an end (ok, monthCap); the run cap, the day cap and other stops are not", () => {
  const since = "2026-10-13T13:17:40.000Z";
  const file = (stopped: string | null) => ({ runs: [{ startedAt: "2026-10-13T13:17:41.000Z", endedAt: "2026-10-13T13:40:00.000Z", stopped, perPayTo: 2 }], rows: [] });
  const sol = runOutcome(file("total_cap_reached: month 29960000 + 50000 > 30000000"), since);
  assert.equal(sol.ok, true);
  assert.equal(sol.monthCap, true);
  assert.match(sol.line, /ended at the month cap \(total_cap_reached: month /);
  const tem = runOutcome(file("month_cap_reached: 29990000 (ledgers 29990000, chain 29990000) + 12000 > 30000000"), since);
  assert.equal(tem.ok && tem.monthCap, true);
  for (const s of ["total_cap_reached: run 2990000 + 50000 > 3000000", "total_cap_reached: run/day 990000 + 12000 > 1000000", "total_cap_reached", "chain_spend_exceeds_ledger", "tx_check_failed"]) {
    const v = runOutcome(file(s), since);
    assert.equal(v.ok, false, s);
    assert.equal(v.monthCap, undefined, s);
    assert.equal(isMonthCapStop(s), false, s);
  }
  assert.equal(runOutcome(file(null), since).monthCap, undefined, "a run without a stop is ok without monthCap");
});

test("plan: the Tempo purchase key in the plan: one that cannot sign leaves Tempo out (skip, not stop); one near its expiry warns; Solana and old plans are unchanged", () => {
  const tempo = (signer?: Record<string, unknown>) => ({ ...plan({ chain: "tempo", would: 20, est: "0.500000", perRun: "1.000000" }), ...(signer ? { signer } : {}) });
  const base = planVerdict(tempo(), "tempo", "2026-10-01", 1);
  assert.equal(base.pay, true);
  assert.equal(base.warn, undefined);
  // the same plan with a root key, or an access key well ahead of its expiry: the same verdict, the same line
  for (const signer of [{ kind: "root", problem: null, warn: null }, { kind: "access-key", keyId: "0x1e9a", expiresAt: "2026-12-31T23:59:59.000Z", problem: null, warn: null }]) {
    assert.deepEqual(planVerdict(tempo(signer), "tempo", "2026-10-01", 1), base);
  }
  const skip = planVerdict(tempo({ kind: "access-key", problem: "access key expires at 1791590399 (now 1791600000) (expiry 2026-10-09T23:59:59.000Z)", warn: null }), "tempo", "2026-10-10", 1);
  // The day check comes before the key: a plan of another day still stops.
  assert.ok(!skip.pay && skip.stop, "a plan of another day stops before the key is looked at");
  const s2 = planVerdict(tempo({ kind: "access-key", problem: "access key expires at 1791590399 (now 1791600000)", warn: null }), "tempo", "2026-10-01", 1);
  assert.ok(!s2.pay && !s2.stop && s2.skip, s2.line);
  assert.match(s2.line, /^tempo: not buying today, the purchase key cannot sign: access key expires at/);
  const w = planVerdict(tempo({ kind: "access-key", problem: null, warn: "the Tempo purchase key 0x1e9a expires at 2026-10-09T23:59:59.000Z; renew it before then (README, Tempo access key)" }), "tempo", "2026-10-01", 1);
  assert.equal(w.pay, true);
  assert.equal(w.line, base.line, "a warning changes nothing about the purchase");
  assert.match(w.warn!, /^tempo: the Tempo purchase key 0x1e9a expires at 2026-10-09/);
  // a warning does not lift a cap stop, and is not attached to it
  const over = planVerdict({ ...plan({ chain: "tempo", would: 35, est: "0.950000", perRun: "1.000000" }), signer: { kind: "access-key", problem: null, warn: "expires soon" } }, "tempo", "2026-10-01", 1);
  assert.ok(over.stop && over.warn === undefined);
  // Solana ignores a signer field: its key is not the Tempo key
  assert.deepEqual(planVerdict({ ...plan(), signer: { kind: "access-key", problem: "expired", warn: null } }, "solana", "2026-10-01", 1), planVerdict(plan(), "solana", "2026-10-01", 1));
});

test("plan: a dry run that left slots out because the chain shows more spent than the ledgers stops (halt), even with nothing else to buy", () => {
  const p = { ...plan({ chain: "tempo", would: 0, est: "0.000000", perRun: "1.000000" }), skipped: [{ url: "https://a.example/x", payTo: "0xab", slot: 0, reason: "chain_spend_exceeds_ledger", detail: "month outflow on chain 29950001 > ledgers 29950000; 29950001 + 100000 > 30000000" }] };
  const v = planVerdict(p, "tempo", "2026-10-01", 1);
  assert.ok(!v.pay && v.stop, v.line);
  assert.match(v.line, /^tempo: chain_spend_exceeds_ledger: month outflow on chain 29950001 > ledgers 29950000/);
  const cap = { ...p, skipped: [{ ...p.skipped[0]!, reason: "month_cap_reached", detail: "29990000 (ledgers 29990000, chain 29990000) + 100000 > 30000000" }] };
  const c = planVerdict(cap, "tempo", "2026-10-01", 1);
  assert.ok(!c.pay && !c.stop, "the month cap proper: nothing to buy, not a stop");
});

test("plan: the CLI exits 11 for a Tempo plan whose key cannot sign, and prints a WARN line next to a paying verdict", () => {
  const dir = tmp();
  const t = { ...plan({ chain: "tempo", would: 20, est: "0.500000", perRun: "1.000000" }) };
  writeFileSync(join(dir, "skip.json"), JSON.stringify({ ...t, signer: { kind: "access-key", problem: "access key is revoked", warn: null } }));
  writeFileSync(join(dir, "warn.json"), JSON.stringify({ ...t, signer: { kind: "access-key", problem: null, warn: "expires soon" } }));
  const skip = stepsCli("check-plan", join(dir, "skip.json"), "--chain", "tempo", "--day", "2026-10-01", "--per-payto", "1");
  assert.equal(skip.status, 11);
  assert.match(skip.stdout, /not buying today, the purchase key cannot sign: access key is revoked/);
  const warn = stepsCli("check-plan", join(dir, "warn.json"), "--chain", "tempo", "--day", "2026-10-01", "--per-payto", "1");
  assert.equal(warn.status, 0);
  assert.match(warn.stdout, /^WARN: tempo: expires soon$/m);
  rmSync(dir, { recursive: true });
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
const chain = v("--chain"), out = v("--out"), day = new Date(Number(process.env.VET402_DAILY_NOW) * 1000).toISOString().slice(0, 10);
if (a.includes("--pay")) {
  // FAKE_PAY_WRITE: write the result file a real --pay run leaves (one run, one paid row), stopped as FAKE_PAY_STOP_<CHAIN> says.
  if (process.env.FAKE_PAY_WRITE) {
    const at = new Date().toISOString();
    mkdirSync("results/remeasure", { recursive: true });
    writeFileSync("results/remeasure/" + chain + "-" + day + ".json", JSON.stringify({ kind: "vet402-remeasure", chain, date: day,
      runs: [{ startedAt: at, endedAt: at, perPayTo: Number(v("--per-payto")), stopped: process.env["FAKE_PAY_STOP_" + chain.toUpperCase()] || null }],
      rows: [{ host: "a.example", outcome: "sent", settled: true, delivered: true, detail: "{}" }] }));
  }
  process.exit(0);
}
const signer = chain === "tempo" && process.env.FAKE_SIGNER ? { signer: JSON.parse(process.env.FAKE_SIGNER) } : {};
const est = process.env["FAKE_ESTIMATE_" + chain.toUpperCase()] ?? process.env.FAKE_ESTIMATE ?? "0.500000";
const rows = Array.from({ length: 10 }, (_, i) => ({ key: day + "|226DYoWb2e6uYxDkFp7vK8jZhzzh2VNvHH6DgbDsNueC|" + i, outcome: "would_pay", priceUsdc: i === 0 ? est : "0.000000" }));
mkdirSync(out, { recursive: true });
writeFileSync(out + "/" + chain + "-" + day + ".dry-run.json", JSON.stringify({ kind: "vet402-remeasure-dry-run", chain, createdAt: day + "T01:18:00.000Z", perPayTo: Number(v("--per-payto")),
  caps: { perRun: chain === "solana" ? "3.000000" : "1.000000", monthLeft: "25.000000" },
  summary: { would: 10, estimate: est, payerUsdcBefore: "40.000000", payerUsdcEBefore: "15.000000" }, rows, ...signer }));
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
if (a.includes("--post-root")) {
  if (process.env.FAKE_POST_ROOT_EXIT) process.exit(Number(process.env.FAKE_POST_ROOT_EXIT));
  if (a.includes("--send")) writeFileSync(process.env.FAKE_RECEIPTS + "/" + v("--day") + "/anchor-program-sent.json", JSON.stringify({ status: "posted" }, null, 2));
} else if (a.includes("--send")) writeFileSync(process.env.FAKE_RECEIPTS + "/" + v("--day") + "/anchor-sent.json", JSON.stringify({ status: "sent" }, null, 2));
`,
  // EVM daily roots: --open-days lists FAKE_EVM_DAYS ("lane:day,...") not yet sent and published; --send marks a day sent.
  "evm-anchor.ts": `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2), v = (n: string) => a[a.indexOf(n) + 1], lane = v("--lane");
appendFileSync(process.env.FAKE_CALLS!, "evm-anchor " + a.join(" ") + (a.includes("--send") ? " VET402_ANCHOR_SEND=" + process.env.VET402_ANCHOR_SEND + " EVM_KEY_DIR=" + process.env.EVM_KEY_DIR : "") + "\\n");
const sent = (d: string) => existsSync("results/evm/anchors/" + lane + "-" + d + ".sent.json");
if (a.includes("--open-days")) {
  const pub = v("--data") + "/evm/roots/" + lane + ".json";
  const published: string[] = existsSync(pub) ? JSON.parse(readFileSync(pub, "utf8")).days : [];
  for (const x of (process.env.FAKE_EVM_DAYS ?? "").split(",").filter(Boolean)) {
    const [l, d] = x.split(":");
    if (l === lane && !(sent(d!) && published.includes(d!))) console.log(d);
  }
  process.exit(0);
}
if (a.includes("--send")) {
  if (process.env.FAKE_EVM_FAIL === lane) process.exit(1);
  mkdirSync("results/evm/anchors", { recursive: true });
  writeFileSync("results/evm/anchors/" + lane + "-" + v("--day") + ".sent.json", "{}");
}
`,
  // The lane page: writes <data>/evm/<lane>.json (FAKE_EVM_PUBLISH_FAIL=<lane>: fails, writes nothing).
  "evm-publish.ts": `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2), v = (n: string) => a[a.indexOf(n) + 1];
appendFileSync(process.env.FAKE_CALLS!, "evm-publish " + a.join(" ") + "\\n");
if (process.env.FAKE_EVM_PUBLISH_FAIL === v("--lane")) process.exit(1);
mkdirSync(v("--data") + "/evm", { recursive: true });
writeFileSync(v("--data") + "/evm/" + v("--lane") + ".json", JSON.stringify({ page: v("--lane"), v: process.env.FAKE_EVM_PAGE ?? "1" }) + "\\n");
// FAKE_EVM_PUBLISH_WITHHELD=<lane>: the page is written, an unreadable line withheld a purchase (exit 3).
if (process.env.FAKE_EVM_PUBLISH_WITHHELD === v("--lane")) {
  mkdirSync("results/evm", { recursive: true });
  writeFileSync("results/evm/" + v("--lane") + "-publish-alert.txt", "wrote " + v("--data") + "/evm/" + v("--lane") + ".json with 1 purchase(s) withheld: unreadable line(s) in results/evm/declared-inputs.jsonl:3\\n");
  process.exit(3);
}
`,
  // The chain check: writes results/evm/<lane>-chaincheck.jsonl in the checkout (FAKE_EVM_CC_FAIL=<lane>:<exit code>).
  "evm-chaincheck.ts": `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2), lane = a[a.indexOf("--lane") + 1];
appendFileSync(process.env.FAKE_CALLS!, "evm-chaincheck " + a.join(" ") + " EVM_KEY_DIR=" + process.env.EVM_KEY_DIR + "\\n");
const [fl, code] = (process.env.FAKE_EVM_CC_FAIL ?? "").split(":");
if (fl === lane && code !== "3") process.exit(Number(code));
mkdirSync("results/evm", { recursive: true });
writeFileSync("results/evm/" + lane + "-chaincheck.jsonl", "{}\\n");
if (fl === lane) process.exit(3);
`,
  "evm-roots-publish.ts": `import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2), data = a[a.indexOf("--data") + 1];
// FAKE_EVM_REFRESH: today's rules judge a published purchase differently until the file is written once.
if (a.includes("--check")) {
  appendFileSync(process.env.FAKE_CALLS!, "evm-roots-publish --check\\n");
  process.exit(process.env.FAKE_EVM_REFRESH && !existsSync(data + "/evm/roots/refreshed") ? 10 : 0);
}
appendFileSync(process.env.FAKE_CALLS!, "evm-roots-publish\\n");
if (process.env.FAKE_EVM_ROOTS_FAIL) process.exit(1);
if (process.env.FAKE_EVM_REFRESH) {
  mkdirSync(data + "/evm/roots", { recursive: true });
  writeFileSync(data + "/evm/roots/refreshed", "1\\n");
}
const files = existsSync("results/evm/anchors") ? readdirSync("results/evm/anchors") : [];
for (const lane of ["robinhood", "arbitrum"]) {
  const days = files.filter((f) => f.startsWith(lane + "-")).map((f) => f.slice(lane.length + 1, lane.length + 11));
  if (!days.length) continue;
  mkdirSync(data + "/evm/roots", { recursive: true });
  writeFileSync(data + "/evm/roots/" + lane + ".json", JSON.stringify({ days }) + "\\n");
}
`,
  "anchor-receipts-tempo.ts": `import { appendFileSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2), v = (n: string) => a[a.indexOf(n) + 1];
appendFileSync(process.env.FAKE_CALLS!, "tempo-anchor " + a.join(" ") + "\\n");
if (process.env.FAKE_TEMPO_FAIL) process.exit(1);
if (a.includes("--send")) writeFileSync(process.env.FAKE_RECEIPTS + "/" + v("--day") + "/anchor-tempo-sent.json", JSON.stringify({ status: "sent" }, null, 2));
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
  const pkg = { name: "fake", private: true, type: "module", scripts: { remeasure: "node fake/remeasure.mjs", rank: "node fake/rank.mjs", typecheck: "node -e 0", test: "node -e \"process.exit(process.env.FAKE_TEST_FAIL ? 1 : 0)\"" } };
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
  // No automatic maintenance in any sandbox repository. The seed commit and the push otherwise start
  // `git maintenance run --auto --detach`, which (git 2.54, measured) repacks in the background once objects/17
  // holds two loose objects: one blob of the seed plus a seed commit whose id, which depends on the second the
  // test runs in, starts with 17. The local clone below copies objects/ file by file while the repack deletes
  // the loose objects it has packed, and the clone misses them ("unable to read tree"). The bare origin needs
  // the settings in its own config: git does not pass GIT_CONFIG_* on to receive-pack.
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "--git-dir", origin, "config", "receive.autogc", "false");
  git(dir, "--git-dir", origin, "config", "maintenance.auto", "false");
  git(seed, "init", "-q", "-b", "main");
  git(seed, "config", "maintenance.auto", "false");
  git(seed, "config", "user.name", "Test");
  git(seed, "config", "user.email", "test@example.com");
  git(seed, "add", "-A");
  git(seed, "commit", "-q", "-m", "seed");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  const repo = join(home, "vet402-solana");
  git(dir, "clone", "-q", origin, repo);
  git(repo, "config", "maintenance.auto", "false");
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

test("sandbox: no repository starts a background repack that the local clone could race ('unable to read tree')", () => {
  const sb = sandbox();
  for (const d of [sb.origin, join(sb.dir, "seed"), sb.repo]) assert.equal(git(d, "config", "--get", "maintenance.auto"), "false", d);
  assert.equal(git(sb.origin, "config", "--get", "receive.autogc"), "false");
  rmSync(sb.dir, { recursive: true });
});

test("run.sh: without ~/.config/vet402-daily/env (the alert file) nothing runs", () => {
  const sb = sandbox();
  rmSync(join(sb.home, ".config", "vet402-daily", "env"));
  const r = runSh(sb, ["am"], { VET402_DAILY_NOW: at("2026-10-01T01:17:00Z") });
  assert.equal(r.status, 3);
  assert.match(logs(sb), /env is missing or has no VET402_ALERTS_FILE; nothing ran/);
  assert.equal(calls(sb), "");
  rmSync(sb.dir, { recursive: true });
});

test("run.sh: no default end date: am runs after 2026-10-09 (JST); VET402_DAILY_END stops it from that day; an end that is not a date stops with an alert", () => {
  const sb = sandbox();
  for (const iso of ["2026-10-09T01:17:00Z", "2026-11-15T01:17:00Z", "2027-03-01T01:17:00Z"]) {
    const r = runSh(sb, ["am", "--dry-run"], { VET402_DAILY_NOW: at(iso) });
    assert.equal(r.status, 0, logs(sb));
  }
  assert.equal((calls(sb).match(/--chain solana --dry-run --per-payto 1/g) ?? []).length, 3, "the dry run of each of the three days");
  assert.ok(!/nothing runs/.test(logs(sb)));
  const before = calls(sb);
  const r = runSh(sb, ["am"], { VET402_DAILY_NOW: at("2026-12-01T01:17:00Z"), VET402_DAILY_END: "2026-12-01" });
  assert.equal(r.status, 0);
  assert.match(logs(sb), /JST 2026-12-01 is on or after 2026-12-01: nothing runs/);
  assert.equal(alerts(sb), "");
  assert.equal(calls(sb), before);
  const r2 = runSh(sb, ["pm", "--dry-run"], { VET402_DAILY_NOW: at("2026-11-30T13:17:00Z"), VET402_DAILY_END: "2026-12-01" });
  assert.equal(r2.status, 0, logs(sb));
  assert.match(calls(sb), /--chain solana --dry-run --per-payto 2/);
  const bad = calls(sb);
  const r3 = runSh(sb, ["am"], { VET402_DAILY_NOW: at("2026-11-30T01:17:00Z"), VET402_DAILY_END: "2026-12" });
  assert.equal(r3.status, 1);
  assert.match(alerts(sb), /am stopped: the end date for am is '2026-12', not a day in YYYY-MM-DD/);
  for (const end of ["2026-13-01", "2026-02-30", "2026-00-10"]) {
    const rx = runSh(sb, ["am"], { VET402_DAILY_NOW: at("2026-11-30T01:17:00Z"), VET402_DAILY_END: end });
    assert.equal(rx.status, 1, end);
    assert.match(alerts(sb), new RegExp(`the end date for am is '${end}', not a day in YYYY-MM-DD`));
  }
  assert.equal(calls(sb), bad, "nothing ran");
  assert.ok(!existsSync(join(sb.state, "HALT-pay")), "a bad setting is not a halt: it stops until the setting is fixed");
  rmSync(sb.dir, { recursive: true });
});

test("run.sh: a Tempo purchase key that cannot sign leaves Tempo out with one alert line; Solana still buys and publishes; no HALT", () => {
  const sb = sandbox();
  writeFileSync(join(sb.rmdir, "solana-2026-10-10.json"), JSON.stringify({ kind: "vet402-remeasure", chain: "solana", date: "2026-10-10", runs: [], rows: [{ host: "a.example", outcome: "sent", settled: true, delivered: true, detail: "{}" }] }));
  const signer = JSON.stringify({ kind: "access-key", keyId: "0x1e9a", expiresAt: "2026-10-09T23:59:59.000Z", problem: "access key expires at 1791590399 (now 1791595020) (expiry 2026-10-09T23:59:59.000Z)", warn: null });
  const r = runSh(sb, ["am", "--dry-run"], { VET402_DAILY_NOW: at("2026-10-10T01:17:00Z"), FAKE_SIGNER: signer });
  assert.equal(r.status, 0, logs(sb));
  assert.match(alerts(sb), /\[vet402_daily\] am \(dry run\): remeasure tempo failed, publish continues: tempo: not buying today, the purchase key cannot sign: access key expires at 1791590399/);
  assert.equal((alerts(sb).match(/^## /gm) ?? []).length, 1, "one line");
  assert.ok(!existsSync(join(sb.state, "HALT-pay")));
  assert.match(calls(sb), /--chain tempo --dry-run/);
  assert.ok(!/--chain tempo --pay/.test(calls(sb)));
  assert.match(logs(sb), /commit [0-9a-f]{40}: data: 2026-10-10 remeasure on Solana/);
  rmSync(sb.dir, { recursive: true });
});

test("run.sh: a Tempo purchase key near its expiry: one notice line, and the run goes on as before", () => {
  const sb = sandbox();
  const warn = "the Tempo purchase key 0x1e9a expires at 2026-10-09T23:59:59.000Z; renew it before then (README, Tempo access key)";
  const r = runSh(sb, ["am", "--dry-run"], { VET402_DAILY_NOW: at("2026-10-07T01:17:00Z"), FAKE_SIGNER: JSON.stringify({ kind: "access-key", problem: null, warn }) });
  assert.equal(r.status, 0, logs(sb));
  assert.match(alerts(sb), /\[vet402_daily\] am: tempo: the Tempo purchase key 0x1e9a expires at 2026-10-09T23:59:59\.000Z; renew it/);
  assert.equal((alerts(sb).match(/^## /gm) ?? []).length, 1);
  assert.match(logs(sb), /dry run: would pay now \(remeasure --chain tempo --pay --per-payto 1\)/);
  assert.ok(!existsSync(join(sb.state, "HALT-pay")));
  rmSync(sb.dir, { recursive: true });
});

test("run.sh: a --pay run that ends at the month cap is published with one notice line, no HALT; a run-cap stop still halts", () => {
  const sb = sandbox();
  const r = runSh(sb, ["pm"], { VET402_DAILY_NOW: at("2026-10-13T13:17:00Z"), FAKE_PAY_WRITE: "1", FAKE_PAY_STOP_SOLANA: "total_cap_reached: month 29960000 + 50000 > 30000000" });
  assert.equal(r.status, 0, logs(sb));
  assert.match(calls(sb), /--chain solana --pay --per-payto 2/);
  assert.match(alerts(sb), /\[vet402_daily\] pm: remeasure solana reached the month cap: run .* ended at the month cap \(total_cap_reached: month 29960000/);
  assert.equal((alerts(sb).match(/^## /gm) ?? []).length, 1);
  assert.ok(!existsSync(join(sb.state, "HALT-pay")));
  assert.match(logs(sb), /commit [0-9a-f]{40}: data: 2026-10-13 remeasure on Solana/);
  const sb2 = sandbox();
  const r2 = runSh(sb2, ["pm"], { VET402_DAILY_NOW: at("2026-10-13T13:17:00Z"), FAKE_PAY_WRITE: "1", FAKE_PAY_STOP_SOLANA: "total_cap_reached: run 2990000 + 50000 > 3000000" });
  assert.equal(r2.status, 2, logs(sb2));
  assert.match(alerts(sb2), /pm stopped: remeasure solana --pay exit 0: the run stopped: total_cap_reached: run/);
  assert.ok(existsSync(join(sb2.state, "HALT-pay")));
  rmSync(sb.dir, { recursive: true });
  rmSync(sb2.dir, { recursive: true });
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

test("run.sh: a failing npm test on the data commit halts the lane and puts the publish worktree back at origin/main, so the next run is not stopped by a dirty tree", () => {
  const sb = sandbox();
  writeFileSync(join(sb.rmdir, "solana-2026-10-01.json"), JSON.stringify({ kind: "vet402-remeasure", chain: "solana", date: "2026-10-01", runs: [], rows: [{ host: "a.example", outcome: "sent", settled: true, delivered: true, detail: "{}" }] }));
  const originBefore = git(sb.origin, "rev-parse", "main");
  const r = runSh(sb, ["am", "--dry-run"], { VET402_DAILY_NOW: at("2026-10-01T01:17:00Z"), FAKE_TEST_FAIL: "1" });
  assert.equal(r.status, 1, logs(sb));
  assert.match(alerts(sb), /am stopped \(dry run\): npm test failed on the data commit; .*vet402-solana-publish is back at origin\/main, clean/);
  assert.ok(existsSync(join(sb.state, "HALT-pay")));
  assert.equal(git(sb.pub, "status", "--porcelain"), "");
  assert.equal(git(sb.pub, "rev-parse", "HEAD"), originBefore);
  assert.doesNotMatch(logs(sb), /commit [0-9a-f]{40}:/);
  // A person looks and removes the HALT file: the next run publishes instead of stopping on "not clean".
  rmSync(join(sb.state, "HALT-pay"));
  const r2 = runSh(sb, ["am", "--dry-run"], { VET402_DAILY_NOW: at("2026-10-01T01:17:00Z") });
  assert.equal(r2.status, 0, logs(sb));
  assert.doesNotMatch(alerts(sb), /not clean/);
  assert.match(logs(sb), /commit [0-9a-f]{40}: data: 2026-10-01 remeasure on Solana/);
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
  // The posting key's file (git-ignored in the real checkout); run.sh only checks that it is there.
  mkdirSync(join(sb.repo, ".keys", "mainnet"), { recursive: true });
  writeFileSync(join(sb.repo, ".keys", "mainnet", "roots-poster.json"), "[]");
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
  const anchors = calls(sb).split("\n").filter((l) => l.startsWith("anchor-receipts") && !l.includes("--post-root"));
  assert.deepEqual(anchors, ["anchor-receipts --day 2026-09-30 --send", "anchor-receipts --day 2026-10-01 --send", "anchor-receipts --day 2026-10-02 --send"]);
  assert.match(git(sb.origin, "log", "-1", "--format=%s", "main"), /^records: 2026-09-30,2026-10-01,2026-10-02 delivery records and each day's root, anchored on Solana$/);
  // The next run finds nothing left: every closed day is anchored.
  const r2 = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-03T00:20:00Z") });
  assert.equal(r2.status, 0, logs(sb));
  assert.match(logs(sb), /no closed day with purchases waits for its records/);
  assert.equal(calls(sb).split("\n").filter((l) => l.includes("--send") && !l.includes("--post-root")).length, 3);
  rmSync(sb.dir, { recursive: true });
});

test("records: each day's root also goes into the observation-roots program with --post-root --send, after the memo and Tempo and before the last publish, once", () => {
  const sb = recordsBox();
  writeFileSync(join(sb.home, ".config", "vet402-daily", "records-enabled"), "");
  writeFileSync(join(sb.home, ".config", "vet402-daily", "tempo-anchor-enabled"), "");
  const r = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-03T00:10:00Z") });
  assert.equal(r.status, 0, logs(sb));
  const lines = calls(sb).split("\n");
  const days = ["2026-09-30", "2026-10-01", "2026-10-02"];
  assert.deepEqual(lines.filter((l) => l.includes("--post-root")), days.map((d) => `anchor-receipts --day ${d} --post-root --send`));
  for (const d of days) {
    const sol = lines.indexOf(`anchor-receipts --day ${d} --send`);
    const tem = lines.findIndex((l) => l.startsWith(`tempo-anchor --day ${d}`));
    const prog = lines.indexOf(`anchor-receipts --day ${d} --post-root --send`);
    const pubAfter = lines.findIndex((l, i) => i > prog && l.startsWith("publish-records") && l.includes(`--day ${d}`));
    assert.ok(sol >= 0 && tem > sol && prog > tem && pubAfter > prog, `${d}: memo, Tempo, program, then publish-records\n${lines.join("\n")}`);
    assert.ok(existsSync(join(sb.receipts, d, "anchor-program-sent.json")), d);
  }
  assert.equal(alerts(sb), "", "no alert");
  runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-03T00:20:00Z") });
  assert.equal(calls(sb).split("\n").filter((l) => l.includes("--post-root")).length, 3, "a done day is not posted again");
  rmSync(sb.dir, { recursive: true });
});

test("records: a failed post_root is alerted, not retried, and the records are still published; exit 3 (posting key too low) has its own line", () => {
  for (const [code, re] of [
    ["1", /\] records: post_root failed, publish continues: anchor-receipts --day 2026-09-30 --post-root --send exited 1 \(the memo stands; rerun by hand, a posted day is not sent twice\)/],
    ["3", /\] records: post_root failed, publish continues: the posting key Ew2RYGSWQygVoPTgp1kQzQUcyAfsQ6n5RPZYr2B7CsxW holds too little SOL for one day: the 2026-09-30 root is not in the observation-roots program \(nothing signed; the memo stands\)/],
  ] as const) {
    const sb = recordsBox();
    writeFileSync(join(sb.home, ".config", "vet402-daily", "records-enabled"), "");
    const r = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-01T00:10:00Z"), FAKE_POST_ROOT_EXIT: code });
    assert.equal(r.status, 0, logs(sb));
    assert.match(alerts(sb), re);
    assert.ok(!alerts(sb).includes("records stopped"), alerts(sb));
    assert.equal(alerts(sb).trim().split("\n").filter((l) => l.trim()).length, 1, alerts(sb));
    assert.match(git(sb.origin, "log", "-1", "--format=%s", "main"), /^records: 2026-09-30 delivery records and each day's root, anchored on Solana$/);
    assert.ok(!existsSync(join(sb.state, "HALT-records")), "no HALT for a post_root failure");
    assert.equal(calls(sb).split("\n").filter((l) => l.includes("--post-root")).length, 1);
    rmSync(sb.dir, { recursive: true });
  }
});

test("records: without the posting key file nothing is posted and one alert says so; a dry run only simulates post_root for a day whose memo is on chain", () => {
  const sb = recordsBox();
  rmSync(join(sb.repo, ".keys"), { recursive: true });
  writeFileSync(join(sb.home, ".config", "vet402-daily", "records-enabled"), "");
  const r = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-01T00:10:00Z") });
  assert.equal(r.status, 0, logs(sb));
  assert.match(alerts(sb), /\] records: post_root failed, publish continues: no posting key at .*roots-poster\.json: the 2026-09-30 root is not in the observation-roots program/);
  assert.ok(!calls(sb).includes("--post-root"), calls(sb));
  rmSync(sb.dir, { recursive: true });

  const dry = recordsBox();
  const r2 = runSh(dry, ["records", "--dry-run"], { VET402_DAILY_NOW: at("2026-10-01T00:10:00Z") });
  assert.equal(r2.status, 0, logs(dry));
  assert.ok(!calls(dry).includes("--post-root"), "the memo was only simulated, so nothing to post");
  assert.match(logs(dry), /2026-09-30 memo is not on chain \(dry run\): no program root/);
  rmSync(dry.dir, { recursive: true });
});

test("records --dry-run: a day whose memo is already on chain (anchored, not yet published) gets post_root simulated, without --send, on the scratch copy", () => {
  const sb = recordsBox();
  mkdirSync(join(sb.receipts, "2026-09-30"), { recursive: true });
  writeFileSync(join(sb.receipts, "2026-09-30", "sources.json"), "{}");
  writeFileSync(join(sb.receipts, "2026-09-30", "obs_2026-09-30_000001.json"), "{}");
  writeFileSync(join(sb.receipts, "2026-09-30", "anchor-sent.json"), JSON.stringify({ status: "sent" }, null, 2));
  const r = runSh(sb, ["records", "--dry-run"], { VET402_DAILY_NOW: at("2026-10-01T00:10:00Z") });
  assert.equal(r.status, 0, logs(sb));
  const lines = calls(sb).split("\n");
  const post = lines.filter((l) => l.includes("--post-root"));
  assert.equal(post.length, 1, lines.join("\n"));
  assert.match(post[0]!, /^anchor-receipts --day 2026-09-30 --post-root --from \S+dry-receipts$/);
  assert.ok(!post[0]!.includes("--send"));
  assert.ok(!lines.some((l) => l.startsWith("anchor-receipts --day 2026-09-30 --send")), "the memo is not sent again");
  assert.ok(!existsSync(join(sb.receipts, "2026-09-30", "anchor-program-sent.json")), "the real records folder gets nothing");
  assert.equal(alerts(sb), "");
  rmSync(sb.dir, { recursive: true });
});

test("records: without tempo-anchor-enabled (the default) nothing is written on Tempo", () => {
  const sb = recordsBox();
  writeFileSync(join(sb.home, ".config", "vet402-daily", "records-enabled"), "");
  const r = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-03T00:10:00Z") });
  assert.equal(r.status, 0, logs(sb));
  assert.ok(!calls(sb).includes("tempo-anchor"), calls(sb));
  rmSync(sb.dir, { recursive: true });
});

test("records: with tempo-anchor-enabled, each day's root also goes to Tempo with --send, after the Solana anchor and before the last publish", () => {
  const sb = recordsBox();
  writeFileSync(join(sb.home, ".config", "vet402-daily", "records-enabled"), "");
  writeFileSync(join(sb.home, ".config", "vet402-daily", "tempo-anchor-enabled"), "");
  const r = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-03T00:10:00Z") });
  assert.equal(r.status, 0, logs(sb));
  const lines = calls(sb).split("\n");
  const tempo = lines.filter((l) => l.startsWith("tempo-anchor"));
  const keyArg = `--key ${join(sb.dir, "keys", "tempo-anchor.json")}`;
  assert.deepEqual(tempo, ["2026-09-30", "2026-10-01", "2026-10-02"].map((d) => `tempo-anchor --day ${d} ${keyArg} --send`));
  for (const d of ["2026-09-30", "2026-10-01", "2026-10-02"]) {
    const sol = lines.indexOf(`anchor-receipts --day ${d} --send`);
    const tem = lines.findIndex((l) => l.startsWith(`tempo-anchor --day ${d}`));
    const pubAfter = lines.findIndex((l, i) => i > tem && l.startsWith("publish-records") && l.includes(`--day ${d}`));
    assert.ok(sol >= 0 && tem > sol && pubAfter > tem, `${d}: Solana anchor, then Tempo, then publish-records\n${lines.join("\n")}`);
  }
  // Done days are not sent to Tempo again.
  runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-03T00:20:00Z") });
  assert.equal(calls(sb).split("\n").filter((l) => l.startsWith("tempo-anchor")).length, 3);
  rmSync(sb.dir, { recursive: true });
});

test("records: a failed Tempo anchor is alerted, not retried, and the Solana-anchored records are still published", () => {
  const sb = recordsBox();
  writeFileSync(join(sb.home, ".config", "vet402-daily", "records-enabled"), "");
  writeFileSync(join(sb.home, ".config", "vet402-daily", "tempo-anchor-enabled"), "");
  const r = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-01T00:10:00Z"), FAKE_TEMPO_FAIL: "1" });
  assert.equal(r.status, 0, logs(sb));
  assert.match(alerts(sb), /\] records: Tempo anchor failed, publish continues: anchor-receipts-tempo --day 2026-09-30 --send exited non-zero \(not retried; the Solana anchor stands\)/);
  assert.ok(!alerts(sb).includes("records stopped"), alerts(sb));
  assert.match(git(sb.origin, "log", "-1", "--format=%s", "main"), /^records: 2026-09-30 delivery records and each day's root, anchored on Solana$/);
  assert.ok(!existsSync(join(sb.state, "HALT-records")), "no HALT for a Tempo failure");
  rmSync(sb.dir, { recursive: true });
});

test("records --dry-run with tempo-anchor-enabled: the Tempo anchor is only simulated, on the scratch copy", () => {
  const sb = recordsBox();
  writeFileSync(join(sb.home, ".config", "vet402-daily", "tempo-anchor-enabled"), "");
  const r = runSh(sb, ["records", "--dry-run"], { VET402_DAILY_NOW: at("2026-10-01T00:10:00Z") });
  assert.equal(r.status, 0, logs(sb));
  const tempo = calls(sb).split("\n").filter((l) => l.startsWith("tempo-anchor"));
  assert.equal(tempo.length, 1);
  assert.ok(!tempo[0]!.includes("--send") && tempo[0]!.includes("--from"), tempo[0] ?? "");
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

test("run.sh end dates: with VET402_DAILY_END=2026-10-09 and VET402_RECORDS_END=2026-10-10 set, records still records UTC 2026-10-08 on 2026-10-09 JST while am and pm do nothing; on 2026-10-10 records stops too; unset, records goes on", () => {
  const sb = sandbox({ records: true });
  const ends = { VET402_DAILY_END: "2026-10-09", VET402_RECORDS_END: "2026-10-10" };
  writeFileSync(join(sb.rmdir, "solana-2026-10-08.json"), "{}");
  const am = runSh(sb, ["am"], { VET402_DAILY_NOW: at("2026-10-09T01:17:00Z"), ...ends });
  const pm = runSh(sb, ["pm"], { VET402_DAILY_NOW: at("2026-10-09T13:17:00Z"), ...ends });
  assert.equal(am.status, 0);
  assert.equal(pm.status, 0);
  assert.match(logs(sb), /JST 2026-10-09 is on or after 2026-10-09: nothing runs/);
  assert.ok(!calls(sb).includes("remeasure") && !calls(sb).includes("--chain"), "no remeasure on 2026-10-09");
  const rec = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-09T00:05:00Z"), ...ends });
  assert.equal(rec.status, 0, logs(sb));
  assert.match(logs(sb), /days to record \(oldest first, at most 3\): 2026-10-08/);
  assert.match(calls(sb), /anchor-receipts --day 2026-10-08/);
  const before = calls(sb);
  const late = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-10T00:05:00Z"), ...ends });
  assert.equal(late.status, 0);
  assert.match(logs(sb), /JST 2026-10-10 is on or after 2026-10-10: nothing runs/);
  assert.equal(calls(sb), before, "records does nothing on 2026-10-10");
  writeFileSync(join(sb.rmdir, "solana-2026-10-20.json"), "{}");
  const goesOn = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-21T00:05:00Z") });
  assert.equal(goesOn.status, 0, logs(sb));
  assert.match(calls(sb), /anchor-receipts --day 2026-10-20/, "no default end: records goes on");
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

test("board: dry run, an unreadable file, or on/after VET402_BOARD_END (JST): nothing is started", () => {
  const b = boardBox();
  assert.equal(b.run({}, ["--dry-run"]).status, 0);
  assert.match(b.logText(), /dry run: would run gh workflow run board\.yml -R kzmttkc\/vet402-algorand --ref main -f mode=daily/);
  assert.equal(b.run({ FAKE_API_ERROR: "1" }).status, 1);
  assert.match(b.alertText(), /board stopped: could not read board\/2026-10-01\.json/);
  assert.equal(b.run({ FAKE_BOARD: "not json" }).status, 1);
  assert.equal(b.run({ VET402_DAILY_NOW: at("2026-10-30T15:00:00Z"), VET402_BOARD_END: "2026-10-31" }).status, 0);
  assert.match(b.logText(), /JST 2026-10-31 is on or after 2026-10-31: nothing runs/);
  assert.equal(b.dispatches(), 0);
  // No default end: unset, the board is still watched after 2026-10-31.
  assert.equal(b.run({ VET402_DAILY_NOW: at("2026-11-15T10:05:00Z") }).status, 0, b.logText());
  assert.equal(b.dispatches(), 1);
  rmSync(b.dir, { recursive: true });
});

// ---------- run.sh records: the EVM lanes' daily roots (DeliveryRoots on Robinhood Chain and Arbitrum One) ----------

/** No Solana day waits; the Robinhood Chain and Arbitrum lanes bought on 2026-09-30 (once). */
function evmBox(opts: { enabled?: boolean; records?: boolean } = {}) {
  const sb = sandbox({ records: true });
  mkdirSync(join(sb.repo, "results", "evm"), { recursive: true });
  for (const l of ["robinhood", "arbitrum", "base-compare"]) writeFileSync(join(sb.repo, "results", "evm", `${l}-purchases.jsonl`), "{}\n");
  mkdirSync(join(sb.dir, "keys"), { recursive: true });
  writeFileSync(join(sb.dir, "keys", "evm-roots-poster.json"), "{}");
  if (opts.enabled !== false) writeFileSync(join(sb.home, ".config", "vet402-daily", "evm-roots-enabled"), "");
  if (opts.records !== false) writeFileSync(join(sb.home, ".config", "vet402-daily", "records-enabled"), "");
  return sb;
}
const EVM_DAYS = { FAKE_EVM_DAYS: "robinhood:2026-09-30,arbitrum:2026-09-30" };
const evmCalls = (sb: Sandbox) => calls(sb).split("\n").filter((l) => l.startsWith("evm-"));
const pageCalls = (sb: Sandbox) => [
  `evm-chaincheck --lane robinhood EVM_KEY_DIR=${join(sb.dir, "keys")}`,
  `evm-publish --lane robinhood --data ${sb.pub}/data`,
  `evm-chaincheck --lane arbitrum EVM_KEY_DIR=${join(sb.dir, "keys")}`,
  `evm-chaincheck --lane base-compare EVM_KEY_DIR=${join(sb.dir, "keys")}`,
  `evm-publish --lane arbitrum --data ${sb.pub}/data`,
];


test("records: without evm-roots-enabled (the default) no EVM root is planned or written; the lane pages are still read on chain", () => {
  const sb = evmBox({ enabled: false });
  const r = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-01T00:10:00Z"), ...EVM_DAYS });
  assert.equal(r.status, 0, logs(sb));
  assert.ok(!evmCalls(sb).some((l) => l.startsWith("evm-anchor") || l.startsWith("evm-roots-publish")), evmCalls(sb).join("\n"));
  assert.equal(git(sb.origin, "log", "-1", "--format=%s", "main"), "records: EVM lane pages read again on chain");
  rmSync(sb.dir, { recursive: true });
});

test("records: with evm-roots-enabled, each lane-day with purchases is planned, sent once with its own variable and key folder, then data/evm/roots and one publish", () => {
  const sb = evmBox();
  const r = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-01T00:10:00Z"), ...EVM_DAYS });
  assert.equal(r.status, 0, logs(sb));
  const keys = join(sb.dir, "keys");
  assert.deepEqual(evmCalls(sb).filter((l) => !l.includes("--open-days")), [
    ...pageCalls(sb),
    "evm-anchor --lane robinhood --day 2026-09-30",
    `evm-anchor --lane robinhood --day 2026-09-30 --send VET402_ANCHOR_SEND=robinhood EVM_KEY_DIR=${keys}`,
    "evm-anchor --lane arbitrum --day 2026-09-30",
    `evm-anchor --lane arbitrum --day 2026-09-30 --send VET402_ANCHOR_SEND=arbitrum EVM_KEY_DIR=${keys}`,
    "evm-roots-publish",
  ]);
  assert.equal(git(sb.origin, "log", "-1", "--format=%s", "main"), "records: EVM daily roots robinhood:2026-09-30,arbitrum:2026-09-30; EVM lane pages read again on chain");
  assert.ok(git(sb.origin, "show", "--name-only", "--format=", "main").split("\n").includes("data/evm/roots/arbitrum.json"));
  assert.equal(alerts(sb), "");
  // Written and on main: the next run has nothing to do, and a day with no purchase never gets a root.
  const before = evmCalls(sb).length;
  const r2 = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-02T00:10:00Z"), ...EVM_DAYS });
  assert.equal(r2.status, 0, logs(sb));
  assert.ok(!evmCalls(sb).slice(before).some((l) => l.startsWith("evm-anchor --lane") && l.includes("--day")), evmCalls(sb).join("\n"));
  assert.match(logs(sb), /no closed day with purchases waits for its records, and the EVM lane pages are unchanged/);
  rmSync(sb.dir, { recursive: true });
});

test("records: a failed EVM root is alerted, not retried, the other lane and the publish go on, and the next run lists the day again", () => {
  const sb = evmBox();
  const r = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-01T00:10:00Z"), ...EVM_DAYS, FAKE_EVM_FAIL: "robinhood" });
  assert.equal(r.status, 0, logs(sb));
  assert.match(alerts(sb), /\] records: EVM root failed, publish continues: evm-anchor --lane robinhood --day 2026-09-30 --send exited 1 \(not retried; look at results\/evm\/anchors\/robinhood-2026-09-30\.sent\.json\)/);
  assert.ok(!existsSync(join(sb.state, "HALT-records")), "no HALT for an EVM root");
  assert.equal(evmCalls(sb).filter((l) => l.includes("--send")).length, 2, "each lane tried once");
  assert.match(git(sb.origin, "show", "--name-only", "--format=", "main"), /data\/evm\/roots\/arbitrum\.json/);
  runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-01T00:20:00Z"), ...EVM_DAYS });
  assert.deepEqual(evmCalls(sb).filter((l) => l.includes("--send")).slice(2).map((l) => l.split(" ").slice(0, 6).join(" ")), ["evm-anchor --lane robinhood --day 2026-09-30 --send"]);
  rmSync(sb.dir, { recursive: true });
});

test("records: the Solana days and the EVM roots go in one publish; without records-enabled the EVM root is only planned, in scratch, and nothing is sent", () => {
  const sb = evmBox({ records: false });
  writeFileSync(join(sb.rmdir, "solana-2026-09-30.json"), "{}");
  const r = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-01T00:10:00Z"), ...EVM_DAYS });
  assert.equal(r.status, 0, logs(sb));
  const ev = evmCalls(sb).filter((l) => !l.includes("--open-days"));
  assert.ok(ev.filter((l) => l.startsWith("evm-anchor")).every((l) => !l.includes("--send") && l.includes("--anchors-dir")), ev.join("\n"));
  assert.match(logs(sb), /commit [0-9a-f]{40}: records: 2026-09-30 delivery records and each day's root \(simulated anchor\); EVM daily roots robinhood:2026-09-30,arbitrum:2026-09-30 \(simulated\)/);
  assert.ok(!existsSync(join(sb.repo, "results", "evm", "anchors")), "nothing marked sent");
  rmSync(sb.dir, { recursive: true });
});

test("records: a lane with no purchases file is not asked", () => {
  const sb = evmBox();
  rmSync(join(sb.repo, "results", "evm", "robinhood-purchases.jsonl"));
  const r = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-01T00:10:00Z"), ...EVM_DAYS });
  assert.equal(r.status, 0, logs(sb));
  assert.ok(!evmCalls(sb).some((l) => l.includes("robinhood")), evmCalls(sb).join("\n"));
  rmSync(sb.dir, { recursive: true });
});

test("records: with no day to write, a published roots file that today's rules judge differently is written again (and only then)", () => {
  const sb = evmBox();
  const r = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-02T00:10:00Z"), FAKE_EVM_REFRESH: "1" });
  assert.equal(r.status, 0, logs(sb));
  assert.deepEqual(evmCalls(sb).filter((l) => !l.includes("--open-days")), ["evm-roots-publish --check", ...pageCalls(sb), "evm-roots-publish"]);
  assert.equal(git(sb.origin, "log", "-1", "--format=%s", "main"), "records: EVM daily roots judged again with today's rules; EVM lane pages read again on chain");
  const before = evmCalls(sb).length;
  const r2 = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-02T00:20:00Z"), FAKE_EVM_REFRESH: "1" });
  assert.equal(r2.status, 0, logs(sb));
  assert.deepEqual(evmCalls(sb).slice(before).filter((l) => !l.includes("--open-days")), ["evm-roots-publish --check", ...pageCalls(sb)], "nothing to judge again");
  assert.match(logs(sb), /no closed day with purchases waits for its records, and the EVM lane pages are unchanged/);
  rmSync(sb.dir, { recursive: true });
});

test("records: a lane page that cannot be made (evm-publish fails) does not stop the run: the roots file follows the page on main, and the Solana records are published", () => {
  const sb = evmBox();
  writeFileSync(join(sb.rmdir, "solana-2026-09-30.json"), "{}");
  const r = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-01T00:10:00Z"), ...EVM_DAYS, FAKE_EVM_PUBLISH_FAIL: "arbitrum" });
  assert.equal(r.status, 0, logs(sb));
  assert.match(alerts(sb), /\] records: EVM lane page failed, publish continues: evm-publish --lane arbitrum failed: data\/evm\/arbitrum\.json stays as on main, and data\/evm\/roots\/arbitrum\.json shows nothing it withholds/);
  assert.ok(!existsSync(join(sb.state, "HALT-records")), "no HALT");
  const ev = evmCalls(sb);
  assert.ok(ev.indexOf("evm-roots-publish") > ev.findIndex((l) => l.startsWith("evm-publish --lane arbitrum")), "the roots file after the lane pages");
  assert.match(git(sb.origin, "log", "-1", "--format=%s", "main"), /^records: 2026-09-30 delivery records and each day's root, anchored on Solana; EVM daily roots /);
  assert.ok(git(sb.origin, "show", "--name-only", "--format=", "main").split("\n").includes("data/records/2026-09-30/index.json"), "the Solana records are on main");
  rmSync(sb.dir, { recursive: true });
});

test("records: evm-publish exit 3 (page written, a purchase withheld for an unreadable line) is said as it is, apart from a failure, and does not HALT", () => {
  const sb = evmBox();
  writeFileSync(join(sb.rmdir, "solana-2026-09-30.json"), "{}");
  const r = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-01T00:10:00Z"), ...EVM_DAYS, FAKE_EVM_PUBLISH_WITHHELD: "arbitrum" });
  assert.equal(r.status, 0, logs(sb));
  assert.match(alerts(sb), /EVM lane page: wrote .*\/data\/evm\/arbitrum\.json with 1 purchase\(s\) withheld: unreadable line\(s\) in results\/evm\/declared-inputs\.jsonl:3/);
  assert.doesNotMatch(alerts(sb), /EVM lane page failed/, "not called a failure");
  assert.doesNotMatch(alerts(sb), /evm-publish --lane arbitrum failed/, "not the failure sentence");
  assert.ok(!existsSync(join(sb.state, "HALT-records")), "no HALT");
  rmSync(sb.dir, { recursive: true });
});

test("records: a roots file that cannot be made puts the new lane pages back too (no new page beside an old roots file), alerts, and the Solana records are published", () => {
  const sb = evmBox();
  writeFileSync(join(sb.rmdir, "solana-2026-09-30.json"), "{}");
  const r = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-01T00:10:00Z"), ...EVM_DAYS, FAKE_EVM_ROOTS_FAIL: "1" });
  assert.equal(r.status, 0, logs(sb));
  assert.match(alerts(sb), /\] records: EVM root failed, publish continues: evm-roots-publish failed: data\/evm \(lane pages and roots\) stays as on main this run/);
  assert.ok(!existsSync(join(sb.state, "HALT-records")), "no HALT");
  const files = git(sb.origin, "show", "--name-only", "--format=", "main").split("\n");
  assert.ok(files.includes("data/records/2026-09-30/index.json"), "the Solana records are on main");
  assert.ok(!files.some((f) => f.startsWith("data/evm/")), files.join("\n"));
  rmSync(sb.dir, { recursive: true });
});

test("records: the chain check runs every morning, flag or not, before each lane page (Arbitrum with its Base side), writes into the checkout's results/, and an unchanged page publishes nothing", () => {
  const sb = evmBox({ enabled: false });
  const r = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-01T00:10:00Z") });
  assert.equal(r.status, 0, logs(sb));
  assert.deepEqual(evmCalls(sb), pageCalls(sb));
  for (const l of ["robinhood", "arbitrum", "base-compare"]) assert.ok(existsSync(join(sb.repo, "results", "evm", `${l}-chaincheck.jsonl`)), l);
  assert.equal(git(sb.repo, "status", "--porcelain", "--untracked-files=no"), "", "no tracked file in the checkout changed");
  const head = git(sb.origin, "rev-parse", "main");
  const r2 = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-02T00:10:00Z") });
  assert.equal(r2.status, 0, logs(sb));
  assert.equal(git(sb.origin, "rev-parse", "main"), head, "unchanged pages: nothing pushed");
  assert.match(logs(sb), /the EVM lane pages are unchanged/);
  assert.equal(alerts(sb), "");
  // The real checkout ignores the chain check's files.
  for (const l of ["robinhood", "arbitrum", "base-compare"]) assert.equal(spawnSync("/usr/bin/git", ["check-ignore", "-q", `results/evm/${l}-chaincheck.jsonl`], { cwd: ROOT }).status, 0, l);
  rmSync(sb.dir, { recursive: true });
});

test("records: a chain check that fails (an RPC error, or exit 3: a transfer without a purchase) is alerted, never a HALT, and the Solana records are published", () => {
  for (const [fail, re] of [
    ["arbitrum:1", /\] records: EVM chain check failed, publish continues: evm-chaincheck --lane arbitrum exited 1 \(an RPC error\?\): the arbitrum page is made from the previous chain check, if any/],
    ["base-compare:3", /\] records: EVM chain check failed, publish continues: evm-chaincheck --lane base-compare: a transfer out of the payer without a purchase, or a purchase ambiguous or still pending \(see log\)/],
  ] as const) {
    const sb = evmBox({ enabled: false });
    writeFileSync(join(sb.rmdir, "solana-2026-09-30.json"), "{}");
    const r = runSh(sb, ["records"], { VET402_DAILY_NOW: at("2026-10-01T00:10:00Z"), FAKE_EVM_CC_FAIL: fail });
    assert.equal(r.status, 0, logs(sb));
    assert.match(alerts(sb), re);
    assert.ok(!existsSync(join(sb.state, "HALT-records")), "no HALT");
    assert.ok(evmCalls(sb).includes(`evm-publish --lane arbitrum --data ${sb.pub}/data`), "the page is still made");
    assert.ok(git(sb.origin, "show", "--name-only", "--format=", "main").split("\n").includes("data/records/2026-09-30/index.json"), "the Solana records are on main");
    rmSync(sb.dir, { recursive: true });
  }
});
