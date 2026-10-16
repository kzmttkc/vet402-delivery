/**
 * The copy step and an unclear value in a seller's answer (src/daily/secret-gate.ts gateCopy).
 *
 * On 2026-10-07, -10, -15 and -16 the daily publish stopped on one value each in rows[N].detail, the text a seller
 * answered with: a piece of a public Reddit URL, a pool contract address, a checkout URL under a get_api_key name.
 * Each was let through by a person adding its sha256 to scripts/daily/secret-allow.json. Now such a value
 * (opaque-40, secret-field or url-query-secret, not on the allow list, only inside a seller's answer) is replaced in
 * the public copy, said in the copy's redactions, and the copy is written. Everything else stops as before: the
 * runner's own key in any encoding, the same value anywhere outside the seller's answer, a known secret shape, and
 * the scan of the tree.
 *
 * Every value here is made up from a fixed seed. Nothing reads data/, site/ or the runner's files.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { blockingFindings, gateTree, ownKeyNeedles, readings, scanFileText, sha256Hex, UNCLEAR_VALUE_REDACTION } from "../src/daily/secret-gate.js";
import { alnum, bytes, seeded } from "../src/daily/gate-shapes.js";
import { commitMessage, redactionNote } from "../src/daily/steps.js";

const ROOT = resolve(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const gateCli = (...args: string[]) => spawnSync(TSX, [join(ROOT, "scripts", "daily", "secret-gate.ts"), ...args], { encoding: "utf8" });
const read = (p: string) => readFileSync(p, "utf8");

/** A scratch folder with an empty allow list (or the given entries), so the repository's own list changes nothing here. */
function scratch(allow: object[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "vet402-gate-unclear-"));
  const allowFile = join(dir, "allow.json");
  writeFileSync(allowFile, JSON.stringify({ kind: "vet402-secret-gate-allow", allow, files: [] }));
  return { dir, allowFile, inFile: join(dir, "in.json"), outFile: join(dir, "out", "solana-2026-10-16.json") };
}

/** A remeasure result with the given rows (vet402's own fields filled in the way remeasure writes them). */
const result = (rows: object[]) => ({
  kind: "vet402-remeasure",
  version: 1,
  chain: "solana",
  date: "2026-10-16",
  payer: "69aiAKU3uJMxMLRkUEGFNt6nQ43PiVimE4ZbErJ7VSM1",
  runs: [],
  rows: rows.map((r) => ({ at: "2026-10-16T01:17:00.000Z", host: "s.example", url: "https://s.example/search", requestUrl: "https://s.example/search?q=solana", outcome: "sent", reason: "sent", ...r })),
});

/** What the gate finds in the copy as remeasure wrote it, before this change: the stop of 2026-10-16. */
const stopsBefore = (raw: object) => blockingFindings(scanFileText(JSON.stringify(raw, null, 2), "solana-2026-10-16.json"), []);

/** The shape of 2026-10-16 rows[25].detail: search results with a Reddit post URL whose id and slug read as random. */
const redditAnswer = (piece: string) =>
  `{"results":[{"title":"Solana validators","url":"https://www.reddit.com/r/solana/comments/${piece}/","score":41}]}`;

test("copy: an opaque-40 inside a seller's answer (a piece of a Reddit post URL) is redacted and the copy is written (exit 0)", () => {
  const s = scratch();
  const piece = alnum(seeded(1016), 24);
  const raw = result([{ detail: redditAnswer(piece) }, { detail: "ok" }]);
  // the same file stopped the copy before this change
  const before = stopsBefore(raw);
  assert.ok(before.length > 0 && before.every((f) => f.kind === "opaque-40" && f.path === "rows[0].detail"), JSON.stringify(before));
  writeFileSync(s.inFile, JSON.stringify(raw));
  const c = gateCli("copy", s.inFile, s.outFile, "--allow", s.allowFile);
  assert.equal(c.status, 0, c.stderr);
  const out = read(s.outFile);
  assert.ok(!out.includes(piece), "the value is not in the public copy");
  const row = JSON.parse(out).rows[0];
  assert.ok(row.detail.includes(UNCLEAR_VALUE_REDACTION), row.detail);
  // the gate's run covers the path after the host (com/r/solana/comments/<id>/), so that much goes and the rest stays
  assert.equal(row.detail, `{"results":[{"title":"Solana validators","url":"https://www.reddit.${UNCLEAR_VALUE_REDACTION}","score":41}]}`);
  assert.equal(JSON.parse(out).rows[1].detail, "ok");
  // the copy says where and what, never the value: file, path, kind and the first 16 hex of the finding's sha256
  const reds = JSON.parse(c.stdout).redactions as { file: string; path: string; what: string; kind: string; sha256: string }[];
  assert.ok(reds.length >= 1);
  const shas = new Set(before.map((f) => f.sha256.slice(0, 16)));
  for (const r of reds) {
    assert.deepEqual(Object.keys(r).sort(), ["file", "kind", "path", "sha256", "what"]);
    assert.equal(r.file, "solana-2026-10-16.json");
    assert.equal(r.path, "rows[0].detail");
    assert.equal(r.what, "unclear-value");
    assert.equal(r.kind, "opaque-40");
    assert.match(r.sha256, /^[0-9a-f]{16}$/);
    assert.ok(shas.has(r.sha256), r.sha256);
  }
  assert.ok(!c.stdout.includes(piece) && !c.stderr.includes(piece));
  // the public copy passes the scan as it is
  assert.deepEqual(blockingFindings(scanFileText(out, "solana-2026-10-16.json"), []), []);
  rmSync(s.dir, { recursive: true });
});

test("copy: a secret-field and a url-query-secret inside a seller's answer are redacted and said with their kinds", () => {
  const s = scratch();
  const r = seeded(1015);
  const session = alnum(r, 28);
  const query = alnum(r, 22);
  const raw = result([{ detail: `{"session":"${session}","user":"vet402"}` }, { detail: `{"next":"https://x.example/cb?access_token=${query}&page=2"}` }]);
  assert.ok(stopsBefore(raw).some((f) => f.kind === "secret-field"));
  assert.ok(stopsBefore(raw).some((f) => f.kind === "url-query-secret"));
  writeFileSync(s.inFile, JSON.stringify(raw));
  const c = gateCli("copy", s.inFile, s.outFile, "--allow", s.allowFile);
  assert.equal(c.status, 0, c.stderr);
  const rows = JSON.parse(read(s.outFile)).rows;
  assert.equal(rows[0].detail, `{"session":"${UNCLEAR_VALUE_REDACTION}","user":"vet402"}`);
  // the gate reads access_token=<value> as one random run, so the name goes with the value
  assert.equal(rows[1].detail, `{"next":"https://x.example/cb?${UNCLEAR_VALUE_REDACTION}&page=2"}`);
  assert.ok(!read(s.outFile).includes(session) && !read(s.outFile).includes(query));
  const kinds = new Set((JSON.parse(c.stdout).redactions as { kind: string }[]).map((x) => x.kind));
  assert.ok(kinds.has("secret-field") && kinds.has("url-query-secret"), [...kinds].join(","));
  rmSync(s.dir, { recursive: true });
});

test("copy: the same value also in vet402's own fields stops the copy and writes nothing (as written and percent-encoded)", () => {
  const value = "plain-words-value";
  // a secret-field in the answer whose value is words: not a finding where vet402 wrote it, so only this check sees it
  const cases: [string, object][] = [
    ["service", { detail: `{"session":"${value}"}`, service: value }],
    ["requestUrl", { detail: `{"session":"${value}"}`, requestUrl: `https://s.example/search?q=${encodeURIComponent(value).replace(/-/g, "%2D")}` }],
    ["an object key", { detail: `{"session":"${value}"}`, input: { [value]: 1 } }],
  ];
  for (const [label, row] of cases) {
    const s = scratch();
    writeFileSync(s.inFile, JSON.stringify(result([row])));
    const c = gateCli("copy", s.inFile, s.outFile, "--allow", s.allowFile);
    assert.equal(c.status, 3, `${label}: ${c.stdout}`);
    assert.match(c.stderr, /blocked: solana-2026-10-16\.json rows\[0\]\.detail secret-field .*outside the seller's answer/, label);
    assert.ok(!existsSync(s.outFile), label);
    assert.ok(!c.stderr.includes(value), `${label}: the value is never printed`);
    rmSync(s.dir, { recursive: true });
  }
});

test("copy: the runner's own key stops even inside a seller's answer: as written, percent-encoded, JSON-escaped, and a piece of it", () => {
  const s = scratch();
  const keys = join(s.dir, "keys");
  mkdirSync(keys);
  writeFileSync(join(keys, "payer.json"), JSON.stringify([...bytes(seeded(402), 64)]));
  const needles = ownKeyNeedles(keys);
  assert.ok(needles.length >= 4);
  const pct = (t: string) => [...t].map((ch) => "%" + ch.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  const esc = (t: string) => [...t].map((ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  const forms: [string, string][] = [];
  for (const n of needles) forms.push([`as written`, n], [`percent-encoded`, pct(n)], [`JSON-escaped`, esc(n)]);
  forms.push(["a piece of the base58 key", needles[needles.length - 1]!.slice(4, 30)]);
  for (const [label, form] of forms) {
    writeFileSync(s.inFile, JSON.stringify(result([{ detail: `{"data":{"ref":"${form}"}}` }])));
    const c = gateCli("copy", s.inFile, s.outFile, "--keys-dir", keys, "--allow", s.allowFile);
    assert.equal(c.status, 3, `${label}: ${c.stdout}`);
    assert.match(c.stderr, /own-key|runner's own key/, label);
    assert.ok(!existsSync(s.outFile), label);
  }
  rmSync(s.dir, { recursive: true });
});

test("copy: a value the allow list names is not redacted (the list works as before)", () => {
  const piece = alnum(seeded(1010), 24);
  const raw = result([{ detail: redditAnswer(piece) }]);
  const before = stopsBefore(raw);
  const s = scratch(before.map((f) => ({ sha256: f.sha256, kind: f.kind, reason: "test: a public Reddit URL piece" })));
  writeFileSync(s.inFile, JSON.stringify(raw));
  const c = gateCli("copy", s.inFile, s.outFile, "--allow", s.allowFile);
  assert.equal(c.status, 0, c.stderr);
  assert.ok(read(s.outFile).includes(piece));
  assert.deepEqual(JSON.parse(c.stdout).redactions, []);
  rmSync(s.dir, { recursive: true });
});

test("copy: the value is redacted in every reading the gate makes (JSON escapes, percent-encoding, HTML references) and in every seller answer it stands in", () => {
  const s = scratch();
  const v = alnum(seeded(1007), 26);
  const pct = [...v].map((ch) => "%" + ch.charCodeAt(0).toString(16).toUpperCase()).join("");
  const esc = [...v].map((ch) => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  const html = [...v].map((ch) => `&#${ch.charCodeAt(0)};`).join("");
  const raw = result([
    { detail: `{"ref":"${v}"}` },
    { detail: `see https://x.example/p?ref=${pct}&lang=en` },
    { detail: `{\\"ref\\":\\"${esc}\\"}` },
    { detail: `<a data-ref="${html}">post</a>` },
  ]);
  assert.ok(stopsBefore(raw).length > 0);
  writeFileSync(s.inFile, JSON.stringify(raw));
  const c = gateCli("copy", s.inFile, s.outFile, "--allow", s.allowFile);
  assert.equal(c.status, 0, c.stderr);
  const out = JSON.parse(read(s.outFile));
  for (const [i, row] of (out.rows as { detail: string }[]).entries()) {
    assert.ok(!readings(row.detail).some((x) => x.includes(v)), `rows[${i}].detail still reads as the value`);
    assert.ok(row.detail.includes(UNCLEAR_VALUE_REDACTION), row.detail);
  }
  assert.deepEqual([...new Set((JSON.parse(c.stdout).redactions as { path: string }[]).map((x) => x.path))].sort(), ["rows[0].detail", "rows[1].detail", "rows[2].detail", "rows[3].detail"]);
  assert.ok(!read(s.outFile).includes(v) && !read(s.outFile).includes(pct) && !read(s.outFile).includes(html));
  rmSync(s.dir, { recursive: true });
});

test("copy: known secret shapes inside a seller's answer still stop (a vendor key, a Bearer value, a private key block, a key array)", () => {
  const r = seeded(77);
  for (const detail of [
    `{"k":"sk_live_${alnum(r, 24)}"}`,
    `Authorization: Bearer ${alnum(r, 32)}`,
    "-----BEGIN PRIVATE KEY-----\nMIIE",
    `[${[...bytes(r, 64)].join(",")}]`,
  ]) {
    const s = scratch();
    writeFileSync(s.inFile, JSON.stringify(result([{ detail }])));
    const c = gateCli("copy", s.inFile, s.outFile, "--allow", s.allowFile);
    assert.equal(c.status, 3, `${detail.slice(0, 20)}: ${c.stdout}`);
    assert.ok(!existsSync(s.outFile));
    rmSync(s.dir, { recursive: true });
  }
});

test("copy: an unclear value outside the seller's answer (vet402's own request, the run's settings) still stops", () => {
  const r = seeded(78);
  for (const row of [{ requestUrl: `https://s.example/search?session=${alnum(r, 24)}` }, { service: alnum(r, 30) }]) {
    const s = scratch();
    writeFileSync(s.inFile, JSON.stringify(result([row])));
    const c = gateCli("copy", s.inFile, s.outFile, "--allow", s.allowFile);
    assert.equal(c.status, 3, c.stdout);
    assert.ok(!existsSync(s.outFile));
    rmSync(s.dir, { recursive: true });
  }
  const s = scratch();
  writeFileSync(s.inFile, JSON.stringify({ ...result([{ detail: "ok" }]), note: `run ${alnum(r, 30)}` }));
  assert.equal(gateCli("copy", s.inFile, s.outFile, "--allow", s.allowFile).status, 3);
  rmSync(s.dir, { recursive: true });
});

test("scan: the same unclear value in a seller's answer still stops the scan of the tree (scan and baseline are unchanged)", () => {
  const s = scratch();
  const piece = alnum(seeded(1016), 24);
  mkdirSync(join(s.dir, "tree", "data", "remeasure"), { recursive: true });
  writeFileSync(join(s.dir, "tree", "data", "remeasure", "solana-2026-10-16.json"), JSON.stringify(result([{ detail: redditAnswer(piece) }]), null, 2));
  const c = gateCli("scan", join(s.dir, "tree"), "data", "--allow", s.allowFile);
  assert.equal(c.status, 3, c.stdout);
  assert.match(c.stderr, /blocked: data\/remeasure\/solana-2026-10-16\.json rows\[0\]\.detail opaque-40/);
  const t = gateTree(join(s.dir, "tree"), ["data"], { allow: [], files: [] });
  assert.ok(t.blocking.length > 0);
  const b = gateCli("baseline", join(s.dir, "tree"), "data", "--reason", "test", "--allow", s.allowFile);
  assert.equal(b.status, 0, b.stderr);
  assert.ok(JSON.parse(b.stdout).allow.length > 0, "baseline still lists it for a person to read");
  rmSync(s.dir, { recursive: true });
});

test("manifest note and commit subject: how many unclear values were redacted, never the value", () => {
  assert.equal(
    redactionNote("remeasure/solana-2026-10-16.json", [
      { path: "rows[25].detail", what: "unclear-value", kind: "opaque-40", sha256: "d116b53c4d47750e", file: "solana-2026-10-16.json" },
      { path: "rows[25].detail", what: "unclear-value", kind: "opaque-40", sha256: "0123456789abcdef", file: "solana-2026-10-16.json" },
      { path: "rows[77].detail", what: "unclear-value", kind: "secret-field", sha256: "0aa8cb44638e9ac5", file: "solana-2026-10-16.json" },
    ]),
    "remeasure/solana-2026-10-16.json rows[25].detail and rows[77].detail: a value in a seller's answer that the secret gate could not tell from a secret is replaced with [redacted]",
  );
  const file = { chain: "solana" as const, result: { kind: "vet402-remeasure", version: 1, chain: "solana", date: "2026-10-16", payer: "", note: "", runs: [], rows: [] } as never, redacted: false };
  assert.equal(commitMessage("2026-10-16", [file], 0), "data: 2026-10-16 remeasure on Solana (0 rows: 0 paid, 0 settled, 0 delivered)");
  assert.equal(commitMessage("2026-10-16", [file], 1), "data: 2026-10-16 remeasure on Solana (0 rows: 0 paid, 0 settled, 0 delivered); 1 unclear value in a seller answer redacted");
  assert.equal(commitMessage("2026-10-16", [{ ...file, redacted: true }], 3), "data: 2026-10-16 remeasure on Solana (0 rows: 0 paid, 0 settled, 0 delivered); a seller-issued token redacted; 3 unclear values in seller answers redacted");
});
