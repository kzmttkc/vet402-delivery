import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, stringToBytes, type Hex } from "viem";
import {
  assemble,
  decideVerdict,
  factsFromBasePurchases,
  factsFromSolanaCensus,
  factsFromTempoLedger,
  HASH_NOT_RECORDED,
  resourceUrlOf,
  type Facts,
} from "../src/receipt/build.js";
import { canonicalize } from "../src/receipt/jcs.js";
import { contentHash, observationDigest, recoverObserver, signObservation } from "../src/receipt/eip712.js";
import { anchorMemo, buildTree, parseAnchorMemo, rootFromProof, verifyInclusion } from "../src/receipt/merkle.js";
import { esc, formatAmount, renderObservationPage, summarySentence } from "../src/receipt/html.js";
import { validateObservation } from "../src/receipt/schema.js";
import { verifyOffline } from "../src/receipt/verify.js";
import { buildUnsignedMemoTx } from "../src/receipt/anchor.js";
import type { Observation } from "../src/receipt/types.js";

const account = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const observer = { id: "did:web:vet402.com#obs-key-test", address: account.address };
const SALT = `0x${"11".repeat(32)}` as Hex;

function facts(over: Partial<Facts> = {}): Facts {
  return {
    dataset: "test",
    row: "rows[0]",
    observedAt: "2026-09-28T07:14:50.439Z",
    requestUrl: "https://api.example.com/v1/quote?b=2&a=1",
    method: "GET",
    requestTs: null,
    payment: {
      network: "eip155:8453",
      scheme: "x402-exact",
      transaction: `0x${"ab".repeat(32)}`,
      payer: "0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51",
      payTo: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "10000",
      decimals: 6,
      assetSymbol: "USDC",
    },
    paymentSettled: true,
    httpStatus: 200,
    contentType: "application/json",
    bytes: 2341,
    bodyNonEmpty: true,
    receivedAt: "2026-09-28T07:14:50.439Z",
    declaredFormatMatched: null,
    notRecorded: [],
    ...over,
  };
}

async function signed(over: Partial<Facts> = {}, seq = 1): Promise<Observation> {
  return signObservation(assemble(facts(over), seq, observer, SALT, 1790000000), account);
}

function rooted(obs: Observation[]): Observation[] {
  const tree = buildTree(obs.map((o) => observationDigest(o)));
  return obs.map((o, i) => ({
    ...o,
    anchor: {
      status: "pending",
      day: "2026-09-28",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      tx: null,
      root: tree.root,
      leafIndex: i,
      proof: tree.proofs[i]!,
      count: obs.length,
      sequenceRange: [obs[0]!.observer.sequence, obs[obs.length - 1]!.observer.sequence],
      observerAddress: account.address,
      anchoredAt: null,
    },
  }));
}

// ---------- JCS ----------

test("JCS sorts keys, keeps numbers in ES form, rejects undefined and non-finite", () => {
  assert.equal(canonicalize({ b: 1, a: [true, null, "x"], c: { z: 1.5, y: 1e21 } }), '{"a":[true,null,"x"],"b":1,"c":{"y":1e+21,"z":1.5}}');
  assert.equal(canonicalize({ "é": 1, e: 2 }), '{"e":2,"é":1}');
  assert.throws(() => canonicalize({ a: undefined }));
  assert.throws(() => canonicalize({ a: Number.NaN }));
  assert.throws(() => canonicalize({ a: 1n }));
});

// ---------- signing and verification ----------

test("a signed record recovers to the observer and passes offline verification", async () => {
  const [o] = rooted([await signed()]);
  assert.equal((await recoverObserver(o!)).toLowerCase(), account.address.toLowerCase());
  const v = await verifyOffline(o!, { expectedSigner: account.address });
  assert.deepEqual(validateObservation(o), []);
  assert.equal(v.schema.ok, true);
  assert.equal(v.signature.ok, true, v.signature.detail);
  assert.equal(v.verdict.ok, true, v.verdict.detail);
  assert.equal(v.merkle.ok, true, v.merkle.detail);
});

test("signing refuses a record that names another observer address", async () => {
  const o = assemble(facts(), 1, observer, SALT, 1790000000);
  await assert.rejects(signObservation(o, other), /not the signing key/);
});

test("a record signed by another key fails against the expected vet402 key", async () => {
  const o = await signObservation(assemble(facts(), 1, { ...observer, address: other.address }, SALT, 1790000000), other);
  const v = await verifyOffline(o, { expectedSigner: account.address });
  assert.equal(v.signature.ok, false);
  assert.match(v.signature.detail, /not the expected vet402 key/);
});

test("anchor, corrections and signature are outside the signed content; everything else is inside", async () => {
  const o = await signed();
  const h = contentHash(o);
  assert.equal(contentHash({ ...o, corrections: [{ at: "2026-09-29T00:00:00Z", kind: "seller-note", by: "seller", text: "fixed", ref: null }] }), h);
  assert.notEqual(contentHash({ ...o, notRecorded: [...o.notRecorded, "x"] }), h);
  assert.notEqual(contentHash({ ...o, scope: { ...o.scope, text: "Proves everything." } }), h);
});

// ---------- tamper detection ----------

const TAMPERS: [string, (o: Observation) => Observation][] = [
  ["verdict word", (o) => ({ ...o, verdict: { ...o.verdict, code: "NOT_DELIVERED" } })],
  ["verdict reason", (o) => ({ ...o, verdict: { ...o.verdict, reason: "Seller is a scam." } })],
  ["amount", (o) => ({ ...o, payment: { ...o.payment, amount: "1" } })],
  ["payTo", (o) => ({ ...o, payment: { ...o.payment, payTo: "0x0000000000000000000000000000000000000001" } })],
  ["transaction", (o) => ({ ...o, payment: { ...o.payment, transaction: `0x${"cd".repeat(32)}` } })],
  ["http status", (o) => ({ ...o, response: { ...o.response, status: 503 } })],
  ["resourceUrl", (o) => ({ ...o, resourceUrl: "https://evil.example/v1/quote" })],
  ["issuedAt", (o) => ({ ...o, issuedAt: o.issuedAt + 1 })],
  ["sequence", (o) => ({ ...o, observer: { ...o.observer, sequence: 99 } })],
  ["params_hash", (o) => ({ ...o, request: { ...o.request, params_hash: `0x${"00".repeat(32)}` } })],
  ["notRecorded list", (o) => ({ ...o, notRecorded: [] })],
];

for (const [name, tamper] of TAMPERS) {
  test(`tampering with ${name} breaks the signature`, async () => {
    const [o] = rooted([await signed()]);
    const t = tamper(o!);
    const v = await verifyOffline(t, { expectedSigner: account.address });
    assert.equal(v.signature.ok, false, `${name}: ${v.signature.detail}`);
    assert.equal(v.merkle.ok, false, `${name}: merkle should not include the altered record`);
  });
}

test("a verdict word that does not follow from the checks is caught even when re-signed", async () => {
  const o = assemble(facts(), 1, observer, SALT, 1790000000);
  const lying = await signObservation({ ...o, verdict: { ...o.verdict, code: "NOT_DELIVERED" } }, account);
  const v = await verifyOffline(lying);
  assert.equal(v.signature.ok, true);
  assert.equal(v.verdict.ok, false);
  assert.match(v.verdict.detail, /give DELIVERED/);
});

test("a corrupted signature fails without throwing", async () => {
  const o = await signed();
  const sig = o.signature!.signature;
  const bad = { ...o, signature: { format: "eip712" as const, signature: `${sig.slice(0, -4)}${sig.slice(-4) === "1b1c" ? "0000" : "1b1c"}` } };
  const v = await verifyOffline(bad, { expectedSigner: account.address });
  assert.equal(v.signature.ok, false);
});

// ---------- Merkle ----------

test("every leaf of trees of size 1..17 proves into the root; odd tails carry up", () => {
  for (let n = 1; n <= 17; n++) {
    const digests = Array.from({ length: n }, (_, i) => keccak256(stringToBytes(`leaf-${n}-${i}`)));
    const t = buildTree(digests);
    digests.forEach((d, i) => assert.equal(verifyInclusion(d, t.proofs[i]!, t.root), true, `n=${n} i=${i}`));
    assert.equal(verifyInclusion(keccak256(stringToBytes("stranger")), t.proofs[0]!, t.root), false);
  }
});

test("a leaf cannot be passed off as an inner node (domain-separated hashing)", () => {
  const digests = [1, 2, 3, 4].map((i) => keccak256(stringToBytes(`d${i}`)));
  const t = buildTree(digests);
  // The first-level node over leaves 0 and 1 must not verify as a leaf with the remaining proof.
  const inner = rootFromProof(digests[0]!, [t.proofs[0]![0]!]);
  assert.equal(verifyInclusion(inner, t.proofs[0]!.slice(1), t.root), false);
});

test("the Merkle root changes if a record is dropped from the day (selective issuing shows)", async () => {
  const all = [await signed({}, 1), await signed({ httpStatus: 503, row: "r2" }, 2), await signed({ row: "r3" }, 3)];
  const full = buildTree(all.map((o) => observationDigest(o))).root;
  const without = buildTree([all[0]!, all[2]!].map((o) => observationDigest(o))).root;
  assert.notEqual(full, without);
});

test("anchor memo round-trips and names count, sequence range and observer", () => {
  const root = keccak256(stringToBytes("r"));
  const memo = anchorMemo({ day: "2026-09-28", root, count: 3, sequenceRange: [1, 3], observerAddress: account.address });
  assert.deepEqual(parseAnchorMemo(memo), { day: "2026-09-28", root, count: 3, seq: [1, 3], observer: account.address });
  assert.ok(new TextEncoder().encode(memo).length < 566);
  // builds an unsigned v0 memo transaction without any key
  assert.ok(buildUnsignedMemoTx("9VaAPD1CPE4i8pquaRwE7LvZXMmvGdgffD4Q8xJgaQRu", memo).length > 100);
});

// ---------- NOT DELIVERED stands on vet402's observation alone ----------

test("NOT DELIVERED (5xx / 402 again / no response / empty 2xx) verifies with no seller receipt", async () => {
  const cases: Partial<Facts>[] = [
    { httpStatus: 503, bytes: null, bodyNonEmpty: null, contentType: null },
    { httpStatus: 402, bytes: null, bodyNonEmpty: null, contentType: null },
    { httpStatus: null, bytes: null, bodyNonEmpty: null, contentType: null },
    { httpStatus: 200, bytes: 0, bodyNonEmpty: false },
  ];
  const obs = rooted(await Promise.all(cases.map((c, i) => signed({ ...c, row: `r${i}` }, i + 1))));
  for (const o of obs) {
    assert.equal(o.verdict.code, "NOT_DELIVERED", o.verdict.reason);
    assert.equal(o.sellerReceipt, null);
    assert.equal(o.verdict.checks.sellerReceiptValid, null);
    assert.equal(o.response.responseHash, null);
    const v = await verifyOffline(o, { expectedSigner: account.address });
    assert.equal(v.schema.ok && v.signature.ok && v.verdict.ok && v.merkle.ok, true, JSON.stringify(v));
  }
});

test("verdict rule: 4xx after payment is UNCLEAR with a recheck, never NOT_DELIVERED; no record for unsettled payments", () => {
  const base = { paymentSettled: true, bodyNonEmpty: true, declaredFormatMatched: null };
  for (const s of [400, 401, 404, 422]) {
    const v = decideVerdict({ ...base, httpStatus: s });
    assert.equal(v.code, "UNCLEAR");
    assert.ok(v.recheck);
  }
  assert.equal(decideVerdict({ ...base, httpStatus: 200, declaredFormatMatched: false, formatMismatchDetail: "missing keys: status" }).code, "MISMATCH");
  assert.equal(decideVerdict({ ...base, httpStatus: 200, bodyNonEmpty: null }).code, "DELIVERED");
  assert.throws(() => decideVerdict({ ...base, paymentSettled: false, httpStatus: 200 }), /did not settle/);
});

test("the four words are the only words; reasons carry no rating vocabulary", async () => {
  const statuses = [200, 402, 404, 500, null];
  for (const s of statuses) {
    const o = await signed({ httpStatus: s });
    assert.ok(["DELIVERED", "MISMATCH", "NOT_DELIVERED", "UNCLEAR"].includes(o.verdict.code));
    const text = `${o.verdict.reason} ${summarySentence(o)} ${o.scope.text}`;
    assert.doesNotMatch(text, /\b(scam|fraud|bad|good|trusted|verified|reliable|score|rating|grade)\b/i);
  }
});

// ---------- hashes only, salted params, recorded gaps ----------

test("response hash is null and says why; params are salted; resourceUrl has no query", async () => {
  const o = await signed();
  assert.equal(o.response.responseHash, null);
  assert.equal(o.response.responseHashNote, HASH_NOT_RECORDED);
  assert.ok(o.notRecorded.some((n) => n.includes(HASH_NOT_RECORDED)));
  assert.equal(o.resourceUrl, "https://api.example.com/v1/quote");
  assert.equal(o.request.params_salted, true);
  const o2 = assemble(facts(), 1, observer, `0x${"22".repeat(32)}`, 1790000000);
  assert.notEqual(o.request.params_hash, o2.request.params_hash, "different salt, different params_hash");
  const reordered = assemble(facts({ requestUrl: "https://api.example.com/v1/quote?a=1&b=2" }), 1, observer, SALT, 1790000000);
  assert.equal(reordered.request.params_hash, o.request.params_hash, "query order does not matter");
  assert.equal(resourceUrlOf("https://h.example/p?q=1#f"), "https://h.example/p");
  const post = assemble(facts({ method: "POST" }), 1, observer, SALT, 1790000000);
  assert.equal(post.request.params_hash, null);
  assert.ok(post.notRecorded.some((n) => n.startsWith("request.params_hash")));
});

// ---------- adapters on the real shapes ----------

test("adapters make records only for confirmed payments and skip the rest with a reason", () => {
  const census = factsFromSolanaCensus(
    {
      kind: "census-live",
      ranAt: "2026-09-28T08:33:41Z",
      payer: "9VaAPD1CPE4i8pquaRwE7LvZXMmvGdgffD4Q8xJgaQRu",
      rows: [
        { requestUrl: "https://a.example/x", settled: true, signature: "SIG1", httpStatus: 503, first300: "", payTo: "P1", at: "2026-09-28T07:00:00Z" },
        { requestUrl: "https://b.example/y", settled: false, signature: null, httpStatus: 402, first300: "", payTo: "P2", at: "2026-09-28T07:01:00Z" },
      ],
      records: [
        {
          requestUrl: "https://a.example/x",
          outcome: "sent",
          probe: { payTo: "P1", amount: "1000", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
          response: { status: 503, contentType: null, first300: "" },
          judgement: { expectedKeys: [], missingKeys: [], exampleKeys: [] },
          onChain: { signature: "SIG1", found: true, confirmed: true, err: null, payToDeltaAtomic: "1000", payerDeltaAtomic: "-1000" },
        },
        { requestUrl: "https://b.example/y", outcome: "sent", onChain: null },
      ],
    },
    "t",
  );
  assert.equal(census.facts.length, 1);
  assert.equal(census.skips.length, 1);
  assert.equal(assemble(census.facts[0]!, 1, observer, SALT, 1).verdict.code, "NOT_DELIVERED");

  const tempo = factsFromTempoLedger(
    {
      payer: "0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51",
      entries: [
        { key: "a", url: "https://t.example/a", recipient: "0x1", amount: "5000", status: "sent", reservedAt: "2026-09-28T08:00:00Z", httpStatus: 402, txHash: "0xaa", settled: true },
        { key: "b", url: "https://t.example/b", recipient: "0x2", amount: "5000", status: "sent", reservedAt: "2026-09-28T08:00:00Z", httpStatus: 502, txHash: null, settled: null },
        { key: "c", url: "https://t.example/c", recipient: "0x3", amount: "5000", status: "refused", reservedAt: "2026-09-28T08:00:00Z", httpStatus: null, txHash: null, settled: null },
      ],
    },
    "t",
  );
  assert.equal(tempo.facts.length, 1);
  assert.deepEqual(
    tempo.skips.map((s) => s.reason.split(" (")[0]),
    ["no payment transaction recorded", "not paid"],
  );
  const base = factsFromBasePurchases(
    [
      { resource: "https://b.example/r", method: "POST", at: "2026-09-28T08:16:44Z", outcome: "sent", payer: "0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51", payTo: "0x1", amountAtomic: "1000", response: { status: 200, contentType: "application/json", bytes: 10, first300: "{}" }, settlementTx: null, settledOnChain: false },
    ],
    "t",
  );
  assert.equal(base.facts.length, 0);
  assert.match(base.skips[0]!.reason, /no payment transaction recorded/);
});

// ---------- the human page ----------

test("escaping: hostile values never reach the page as markup", async () => {
  const evil = `"><script>alert(1)</script><img src=x onerror=alert(2)>`;
  const o = await signed({
    requestUrl: `https://api.example.com/${encodeURIComponent(evil)}`,
    contentType: `text/html"><script>alert(3)</script>`,
    notRecorded: [evil],
  });
  const withNote: Observation = { ...o, corrections: [{ at: "2026-09-29T00:00:00Z", kind: "seller-note", by: evil, text: evil, ref: null }] };
  const html = renderObservationPage(withNote, { jsonHref: `${evil}.json`, verifyCommand: `npx tsx scripts/verify-receipt.ts ${evil}` });
  const scripts = html.match(/<script>/g) ?? [];
  assert.equal(scripts.length, 1, "only the page's own script tag");
  assert.doesNotMatch(html, /<img/);
  // Attribute values are quoted with `"` escaped inside, so dropping them leaves only real markup.
  const markupOnly = html.replace(/="[^"]*"/g, '=""');
  assert.doesNotMatch(markupOnly, /<[^>]*\sonerror=/i);
  assert.doesNotMatch(markupOnly, /<img/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(esc(`<a href="x" onclick='y'>&`), "&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;");
});

test("the page reads in the designed order and states scope, vantage and gaps", async () => {
  const [ok] = rooted([await signed()]);
  const html = renderObservationPage(ok!, { jsonHref: "a.json", verifyCommand: "npx tsx scripts/verify-receipt.ts a.json" });
  const order = ["DELIVERED", "Proves:", "Doesn't prove:", "3 checks", "Verify it yourself", "All fields", "Seller response", "Correction history", "Are you the seller?"];
  let at = -1;
  for (const s of order) {
    const i = html.indexOf(s, at + 1);
    assert.ok(i > at, `${s} out of order`);
    at = i;
  }
  assert.match(html, /name="viewport" content="width=device-width/);
  assert.match(html, /28 Sep 2026 07:14 UTC/);
  assert.match(html, /hash not recorded \(this purchase predates receipts\)/);
  assert.doesNotMatch(html, /ago\b|Verified|Trusted|🔒|🛡/);

  const [bad] = rooted([await signed({ httpStatus: 503, bytes: null, bodyNonEmpty: null })]);
  const nd = renderObservationPage(bad!, { jsonHref: "b.json", verifyCommand: "x" });
  assert.match(nd, /NOT DELIVERED/);
  assert.match(nd, /Seen from vet402&#39;s network only\./);
  assert.ok(nd.indexOf("Are you the seller?") < nd.indexOf("3 checks"), "seller entry moves up for a negative verdict");
  assert.match(summarySentence(bad!), /^vet402 paid 0\.01 USDC on Base to api\.example\.com\/v1\/quote\. The seller answered HTTP 503\.$/);
});

test("amounts format from atomic units without floating point", () => {
  assert.equal(formatAmount("1000", 6), "0.001");
  assert.equal(formatAmount("10000", 6), "0.01");
  assert.equal(formatAmount("1234567", 6), "1.234567");
  assert.equal(formatAmount("5", 6), "0.000005");
  assert.equal(formatAmount("2000000", 6), "2");
});

test("verify-receipt with no --signer rejects a record signed by any key other than vet402's published key", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "receipt-"));
  const [forged] = rooted([await signed()]); // signed by a random key, not a vet402 key
  const file = join(dir, "forged.json");
  writeFileSync(file, JSON.stringify(forged));
  let code = 0;
  let out = "";
  try {
    out = execFileSync(process.execPath, ["--import", "tsx", "scripts/verify-receipt.ts", file, "--offline"], { encoding: "utf8" });
  } catch (e) {
    const err = e as { status: number; stdout: string };
    code = err.status;
    out = err.stdout;
  }
  assert.equal(code, 1);
  assert.match(out, /FAIL key .* is not a vet402 observation key/);
  assert.match(out, /RESULT: FAIL/);
});

test("a DELIVERED page says when only the HTTP status was recorded", async () => {
  const o = await signed({ bodyNonEmpty: null } as Partial<Facts>);
  assert.equal(o.verdict.code, "DELIVERED");
  const html = renderObservationPage(o, { jsonHref: "x.json", verifyCommand: "npx tsx scripts/verify-receipt.ts x.json" });
  assert.match(html, /only the HTTP status was recorded/);
});
