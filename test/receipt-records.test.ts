/**
 * Published delivery records (data/records/ -> site/records/):
 *  - policy: no NOT_DELIVERED / MISMATCH / UNCLEAR record is public unless its seller (host, or host#service
 *    as in the ranking) is in notified.json; a bare host never opens another service behind that host
 *  - every published record verifies against vet402's key, is listed with its sha256, and nothing else sits there
 *  - no credential, local path or query string in a published record
 *  - site/records/ is exactly what build-site makes from data/records/ (JSON byte for byte)
 *  - record pages: CSP forbids scripts, no script tag, hostile values escaped
 *  - verify-receipt reads a record from a URL, says OK, and says FAIL after a one-character change
 *  - the anchor transaction is memo-only (the send / resume paths are in test/receipt-anchor.test.ts)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
} from "@solana/kit";
import { publicPage, siteSlugs } from "../src/rank/html.js";
import type { RankReport } from "../src/rank/report.js";
import { assertMemoOnly, compileMemoTx } from "../src/receipt/anchor.js";
import { MEMO_PROGRAM, PAYER_ADDRESS } from "../src/constants.js";
import { isPublishable, loadPublishedRecords, notifiedSellers, publicRecordProblems, sha256Hex, withAnchorTx, type NotifiedFile, type RecordIndex } from "../src/receipt/publish.js";
import { renderRecordsSite } from "../src/receipt/site.js";
import type { Observation } from "../src/receipt/types.js";
import { verifyOffline } from "../src/receipt/verify.js";
import { VET402_OBSERVER_KEYS } from "../src/receipt/observers.js";

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECORDS = join(ROOT, "data", "records");

function copyRecords(): string {
  const dir = mkdtempSync(join(tmpdir(), "vet402-records-"));
  cpSync(RECORDS, dir, { recursive: true });
  return dir;
}
function firstFile(dir: string): { path: string; text: string; index: RecordIndex } {
  const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as RecordIndex;
  const path = join(dir, index.records[0]!.file);
  return { path, text: readFileSync(path, "utf8"), index };
}

test("records policy: every published record is DELIVERED unless its seller is in notified.json", async () => {
  const loaded = await loadPublishedRecords(RECORDS);
  const told = notifiedSellers(loaded.notified);
  assert.equal(loaded.index.notifiedSellers, loaded.notified.sellers.length);
  assert.ok(loaded.records.length > 0);
  for (const r of loaded.records) if (r.obs.verdict.code !== "DELIVERED") assert.ok(told.has(r.entry.seller), `${r.entry.file}: ${r.obs.verdict.code} for a seller not in notified.json`);
  // the same count straight from the files, not through the loader
  const files = readdirSync(RECORDS).filter((d) => /^\d{4}-/.test(d)).flatMap((d) => readdirSync(join(RECORDS, d)).map((f) => join(RECORDS, d, f)));
  assert.equal(files.length, loaded.records.length);
  const site = readdirSync(join(ROOT, "site", "records")).filter((f) => f.endsWith(".json"));
  assert.equal(site.length, loaded.records.length);
});

test("records policy: a negative record is publishable only for its notified seller", () => {
  const neg = { verdict: { code: "NOT_DELIVERED" }, resourceUrl: "https://s.example/x" } as Observation;
  const pos = { verdict: { code: "DELIVERED" }, resourceUrl: "https://s.example/x" } as Observation;
  assert.equal(isPublishable(pos, "s.example", new Set()), true);
  assert.equal(isPublishable(neg, "s.example", new Set()), false);
  assert.equal(isPublishable(neg, "s.example", new Set(["other.example"])), false);
  assert.equal(isPublishable(neg, "s.example", new Set(["s.example"])), true);
  assert.equal(isPublishable(pos, "other.example", new Set()), false, "a seller key of another host is refused");
});

test("#8 host#service: a bare host opens none of the services behind a shared host; each service is opened by its own key", () => {
  const proxy = (svc: string) => ({ verdict: { code: "NOT_DELIVERED" }, resourceUrl: `https://mpp.orthogonal.com/${svc}/x` }) as Observation;
  const a = proxy("voygr");
  const b = proxy("linkup");
  assert.equal(isPublishable(a, "mpp.orthogonal.com#orth-voygr", new Set(["mpp.orthogonal.com"])), false, "bare host does not open a service");
  assert.equal(isPublishable(a, "mpp.orthogonal.com#orth-voygr", new Set(["mpp.orthogonal.com#orth-voygr"])), true);
  assert.equal(isPublishable(b, "mpp.orthogonal.com#orth-linkup", new Set(["mpp.orthogonal.com#orth-voygr"])), false, "another service stays held");
  // a host with a single service has the bare host as its ranking key, so a bare host entry opens it
  assert.equal(isPublishable({ ...a, resourceUrl: "https://one.example/x" } as Observation, "one.example", new Set(["one.example"])), true);
  // notified.json takes host#service keys, and refuses the old { host } shape
  assert.deepEqual([...notifiedSellers({ note: "", sellers: [{ seller: "mpp.orthogonal.com#orth-voygr", notifiedAt: "2026-09-30" }] })], ["mpp.orthogonal.com#orth-voygr"]);
  assert.throws(() => notifiedSellers({ note: "", hosts: [{ host: "a.example", notifiedAt: "2026-09-30" }] } as unknown as NotifiedFile), /replaced by "sellers"/);
  assert.throws(() => notifiedSellers({ note: "", sellers: [{ seller: "https://a.example", notifiedAt: "2026-09-30" }] }), /bad entry/);
});

test("records loader refuses a negative record whose host was not told, and accepts it once the host is listed", async () => {
  const dir = copyRecords();
  try {
    const { path, index } = firstFile(dir);
    const o = JSON.parse(readFileSync(path, "utf8")) as Observation;
    // Re-label the index entry only: the file still says DELIVERED, so the loader must see the mismatch.
    index.records[0]!.verdict = "NOT_DELIVERED";
    writeFileSync(join(dir, "index.json"), JSON.stringify(index));
    await assert.rejects(loadPublishedRecords(dir), /index\.json does not describe the file/);
    // A real negative record from the unit fixtures is not needed: the policy check runs on the file's verdict.
    const negText = readFileSync(path, "utf8").replace('"code": "DELIVERED"', '"code": "NOT_DELIVERED"');
    writeFileSync(path, negText);
    index.records[0]!.sha256 = sha256Hex(negText);
    writeFileSync(join(dir, "index.json"), JSON.stringify(index));
    await assert.rejects(loadPublishedRecords(dir), new RegExp(`NOT_DELIVERED for seller ${index.records[0]!.seller.replace(/\./g, "\\.")}, which is not in notified\\.json`));
    const already = (JSON.parse(readFileSync(join(dir, "notified.json"), "utf8")) as NotifiedFile).sellers;
    writeFileSync(join(dir, "notified.json"), JSON.stringify({ note: "", sellers: [...already, { seller: index.records[0]!.seller, notifiedAt: "2026-09-30" }] }));
    // Now the policy allows it, and what is left is that the altered record no longer verifies.
    await assert.rejects(loadPublishedRecords(dir), (e: Error) => !/not in notified\.json/.test(e.message) && /does not verify/.test(e.message));
    assert.equal(o.verdict.code, "DELIVERED");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#8 records loader: a bare host in notified.json does not open a service's negative record; its own key does", async () => {
  const dir = copyRecords();
  try {
    const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as RecordIndex;
    const e = index.records.find((r) => r.seller.includes("#"))!;
    assert.ok(e, "a host#service record is published");
    const path = join(dir, e.file);
    const neg = readFileSync(path, "utf8").replace('"code": "DELIVERED"', '"code": "NOT_DELIVERED"');
    writeFileSync(path, neg);
    e.sha256 = sha256Hex(neg);
    e.verdict = "NOT_DELIVERED";
    writeFileSync(join(dir, "index.json"), JSON.stringify(index));
    const already = (JSON.parse(readFileSync(join(dir, "notified.json"), "utf8")) as NotifiedFile).sellers;
    const told = (seller: string) => writeFileSync(join(dir, "notified.json"), JSON.stringify({ note: "", sellers: [...already, { seller, notifiedAt: "2026-09-30" }] }));
    told(e.host);
    await assert.rejects(loadPublishedRecords(dir), /which is not in notified\.json/);
    told(`${e.host}#some-other-service`);
    await assert.rejects(loadPublishedRecords(dir), /which is not in notified\.json/);
    told(e.seller);
    await assert.rejects(loadPublishedRecords(dir), (err: Error) => !/not in notified\.json/.test(err.message));
    // the index cannot move a record to another host's seller key
    e.seller = "other.example";
    writeFileSync(join(dir, "index.json"), JSON.stringify(index));
    await assert.rejects(loadPublishedRecords(dir), /is not the record's host/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("records loader refuses a one-character change, an unlisted file and a missing file", async () => {
  const dir = copyRecords();
  try {
    const { path, text } = firstFile(dir);
    writeFileSync(path, text.replace(/"amount": "(\d)/, (_m, d: string) => `"amount": "${d === "9" ? "8" : String(Number(d) + 1)}`));
    await assert.rejects(loadPublishedRecords(dir), /sha256 differs[\s\S]*does not verify/);
    writeFileSync(path, text);
    await loadPublishedRecords(dir);
    writeFileSync(join(dir, "2026-09-28", "extra.json"), "{}");
    await assert.rejects(loadPublishedRecords(dir), /extra\.json: not listed/);
    rmSync(join(dir, "2026-09-28", "extra.json"));
    rmSync(path);
    await assert.rejects(loadPublishedRecords(dir), /missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("published records: no credential shape, local path, query string or response body", async () => {
  const loaded = await loadPublishedRecords(RECORDS);
  for (const r of loaded.records) {
    assert.deepEqual(publicRecordProblems(r.text, r.obs), [], r.entry.id);
    assert.ok(!("body" in r.obs.response), `${r.entry.id}: no response body`);
  }
  const base = loaded.records[0]!;
  const bad = (s: string) => publicRecordProblems(s, base.obs);
  assert.ok(bad(base.text.replace('"contact"', '"x": "/Users/someone/vet402/.keys/payer.json", "contact"')).includes("local path"));
  assert.ok(bad(`${base.text} Bearer abcdefghijklmnop`).includes("bearer token"));
  assert.ok(bad(`${base.text} eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijkl`).includes("JWT"));
  assert.ok(bad(base.text.replace('"contact"', '"access_token": "x", "contact"')).includes("credential field"));
  assert.ok(publicRecordProblems(base.text, { ...base.obs, resourceUrl: "https://s.example/x?key=1" }).some((p) => /query/.test(p)));
});

test("site/records is what build-site makes from data/records (JSON byte for byte)", async () => {
  const loaded = await loadPublishedRecords(RECORDS);
  const report = JSON.parse(readFileSync(join(ROOT, "site", "rank.json"), "utf8")) as RankReport;
  const slugs = siteSlugs(report);
  const pages = renderRecordsSite(loaded, { sellerSlug: (k) => slugs.get(k) ?? null, page: publicPage });
  const onDisk = readdirSync(join(ROOT, "site", "records"));
  assert.equal(onDisk.length, pages.size + loaded.records.length);
  for (const [rel, html] of pages) assert.equal(readFileSync(join(ROOT, "site", rel), "utf8"), html, `site/${rel} is up to date`);
  for (const r of loaded.records) assert.equal(readFileSync(join(ROOT, "site", "records", `${r.entry.id}.json`), "utf8"), r.text);
  // every seller in the records has a ranking page, and that page links back to each of its records
  for (const r of loaded.records) {
    const slug = slugs.get(r.entry.seller);
    assert.ok(slug, `${r.entry.seller} is in the ranking`);
    assert.ok(readFileSync(join(ROOT, "site", "seller", `${slug}.html`), "utf8").includes(`href="../records/${r.entry.id}.html"`), `${slug} links ${r.entry.id}`);
  }
});

test("record pages: CSP forbids scripts, no script tag, no external script or style, hostile values escaped", async () => {
  for (const f of readdirSync(join(ROOT, "site", "records")).filter((x) => x.endsWith(".html"))) {
    const html = readFileSync(join(ROOT, "site", "records", f), "utf8");
    assert.ok(html.includes("script-src 'none'"), `${f}: CSP`);
    assert.ok(!/<script/i.test(html), `${f}: no script`);
    assert.ok(!/<link[^>]+stylesheet|src="https?:/i.test(html), `${f}: nothing loaded from elsewhere`);
    assert.ok(!/data-copy=/.test(html), `${f}: no copy buttons that cannot work without script`);
  }
  const loaded = await loadPublishedRecords(RECORDS);
  const evil = `"><script>alert(1)</script>`;
  const r = loaded.records[0]!;
  const hostile = { ...loaded, records: [{ ...r, entry: { ...r.entry, seller: `x.example${evil}` }, obs: { ...r.obs, resourceUrl: `https://x.example/${evil}` } }] };
  for (const [, html] of renderRecordsSite(hostile, { sellerSlug: () => null, page: publicPage })) {
    assert.ok(!html.includes("<script>alert"), "escaped");
    assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "shown as text");
  }
});

test("verify-receipt: a record read from a URL passes by default against vet402's key; one changed character fails", async () => {
  const loaded = await loadPublishedRecords(RECORDS);
  const r = loaded.records[0]!;
  const tampered = r.text.replace(r.obs.payment.payTo, `${r.obs.payment.payTo.slice(0, -1)}${r.obs.payment.payTo.endsWith("A") ? "B" : "A"}`);
  assert.equal(tampered.length, r.text.length);
  assert.notEqual(tampered, r.text);
  const server = createServer((req, res) => {
    const body = req.url === "/records/good.json" ? r.text : req.url === "/records/bad.json" ? tampered : null;
    res.writeHead(body === null ? 404 : 200, { "content-type": "application/json" });
    res.end(body ?? "");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  const verify = async (url: string) => {
    try {
      const { stdout } = await run(process.execPath, ["--import", "tsx", "scripts/verify-receipt.ts", url, "--offline"], { cwd: ROOT, encoding: "utf8" });
      return { code: 0, out: stdout };
    } catch (e) {
      const err = e as { code: number; stdout: string };
      return { code: err.code, out: err.stdout };
    }
  };
  try {
    const good = await verify(`http://127.0.0.1:${port}/records/good.json`);
    assert.equal(good.code, 0, good.out);
    assert.match(good.out, new RegExp(`OK   key .*${VET402_OBSERVER_KEYS[0]}`));
    assert.match(good.out, /OK   signature .*expected vet402 key/);
    assert.match(good.out, /OK   merkle/);
    assert.match(good.out, /RESULT: OK \(not yet anchored/);
    assert.match(good.out, /Not shown until the day's root is on chain/);
    const bad = await verify(`http://127.0.0.1:${port}/records/bad.json`);
    assert.equal(bad.code, 1, bad.out);
    assert.match(bad.out, /FAIL signature/);
    assert.match(bad.out, /RESULT: FAIL/);
    const missing = await verify(`http://127.0.0.1:${port}/records/none.json`);
    assert.equal(missing.code, 1);
    assert.match(missing.out, /FAIL read .*HTTP 404/);
    const plainHttp = await verify("http://example.com/records/x.json");
    assert.match(plainHttp.out, /FAIL read .*use https/);
  } finally {
    server.close();
  }
});

test("anchor: the memo transaction holds one Memo instruction and nothing else; anything more is refused", () => {
  const memo = "x402-observation/v0 day=2026-09-28 root=0x00 n=1 seq=1-1 observer=0x00";
  const tx = compileMemoTx(PAYER_ADDRESS, memo, "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", 123n);
  assert.doesNotThrow(() => assertMemoOnly(tx.messageBytes, PAYER_ADDRESS, memo));
  assert.throws(() => assertMemoOnly(tx.messageBytes, PAYER_ADDRESS, `${memo}x`), /memo bytes differ/);
  assert.throws(() => assertMemoOnly(tx.messageBytes, "11111111111111111111111111111111", memo), /accounts/);
  const other = "BPFLoaderUpgradeab1e11111111111111111111111";
  const two = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(address(PAYER_ADDRESS), m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N" as Blockhash, lastValidBlockHeight: 1n }, m),
      (m) => appendTransactionMessageInstructions([{ programAddress: address(MEMO_PROGRAM), data: new TextEncoder().encode(memo) }, { programAddress: address(other), data: new Uint8Array([1]) }], m),
    ),
  );
  assert.throws(() => assertMemoOnly(two.messageBytes, PAYER_ADDRESS, memo), /anchor transaction refused/);
});

test("anchor marking keeps the signature and the proof, and refuses a second anchor", async () => {
  const loaded = await loadPublishedRecords(RECORDS);
  const published = loaded.records[0]!.obs;
  // The published records may already carry the real anchor; start from the pending state.
  const o = { ...published, anchor: { ...published.anchor!, status: "pending" as const, tx: null, anchoredAt: null } };
  const marked = withAnchorTx(o, "5".repeat(88), "2026-09-30T00:00:00.000Z");
  assert.equal(marked.anchor!.status, "anchored");
  const v = await verifyOffline(marked, { expectedSigner: VET402_OBSERVER_KEYS[0]! });
  assert.ok(v.signature.ok && v.merkle.ok, JSON.stringify(v));
  assert.throws(() => withAnchorTx(marked, "6".repeat(88), "2026-09-30T00:00:00.000Z"), /already anchored/);
});
