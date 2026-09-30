/**
 * Re-check an x402-observation record without trusting vet402. No account, no payment.
 *
 *   npx tsx scripts/verify-receipt.ts <record.json | https URL> [--signer 0x...] [--did <did.json path or https URL>] [--index <path|url>] [--offline]
 *
 * A published record can be checked straight from the site:
 *   npx tsx scripts/verify-receipt.ts https://kzmttkc.github.io/vet402-delivery/records/<id>.json
 *
 * Checks: shape (JSON Schema), vet402's EIP-712 signature, that the verdict follows from the recorded
 * checks, Merkle inclusion in the day's root, and (unless --offline) the payment on chain and, once the
 * root is written, the anchor memo (sent by vet402's anchor wallet; a memo from any other wallet is not an
 * anchor), and, when the records index names one for the day (days[].tempoAnchor), the same root in
 * vet402's Tempo memo (anchor-tempo). The index is --index, else data/records/index.json next to a local
 * record (<records>/<day>/<id>.json), else the published one for a record read over https. Exit 0 only
 * when every check that could run passed. "RESULT: OK (not yet anchored)" says the day's root is not on chain
 * yet, and the next line says what that leaves unproven.
 * RPCs: SOLANA_RPC_URL, BASE_RPC_URL, TEMPO_RPC_URL (public defaults).
 */
import { existsSync, readFileSync } from "node:fs";
import { jsonRpc } from "../src/chain.js";
import { checkAnchorOnChain, checkPayment, DEFAULT_RPC, findDayAnchors, memoMatches } from "../src/receipt/chain.js";
import type { Observation } from "../src/receipt/types.js";
import { VET402_OBSERVER_KEYS } from "../src/receipt/observers.js";
import { verifyOffline } from "../src/receipt/verify.js";
import { dirname, join } from "node:path";
import { checkTempoDayAnchor, TEMPO_ANCHOR_NETWORK, tempoAnchorFromIndex } from "../src/receipt/tempo-anchor.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const file = process.argv[2];
if (!file || file.startsWith("--")) {
  console.error("usage: verify-receipt.ts <record.json | https URL> [--signer 0x...] [--did <path|url>] [--index <path|url>] [--offline]");
  process.exit(2);
}
/** A record is a few KB; anything far larger is not a record. */
const MAX_RECORD_BYTES = 1_000_000;
/** The published records index (the same file packages/check reads). */
const PUBLIC_RECORDS_INDEX = "https://raw.githubusercontent.com/kzmttkc/vet402-delivery/main/data/records/index.json";
const MAX_INDEX_BYTES = 20_000_000;

/** Where the records index is: --index, else next to a local record, else the published one for an https record. null = none known. */
function indexSource(src: string): string | null {
  const given = arg("--index");
  if (given) return given;
  if (/^https?:\/\//i.test(src)) return /^https:\/\//i.test(src) ? PUBLIC_RECORDS_INDEX : null;
  // Next to a local record only a records index counts (a build folder has other index files).
  const p = join(dirname(src), "..", "index.json");
  try {
    return existsSync(p) && (JSON.parse(readFileSync(p, "utf8")) as { kind?: unknown }).kind === "vet402-observation-records" ? p : null;
  } catch {
    return null;
  }
}

async function readIndex(src: string): Promise<unknown> {
  if (/^http:\/\//i.test(src) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//i.test(src)) throw new Error("use https");
  if (!/^https?:\/\//i.test(src)) return JSON.parse(readFileSync(src, "utf8"));
  const res = await fetch(src, { signal: AbortSignal.timeout(15_000), redirect: "follow", headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${src} -> HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_INDEX_BYTES) throw new Error(`${src}: ${text.length} bytes is not a records index`);
  return JSON.parse(text);
}

async function readRecord(src: string): Promise<string> {
  const loopback = /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//i.test(src); // a local copy of the site
  if (/^http:\/\//i.test(src) && !loopback) throw new Error("use https");
  if (!/^https:\/\//i.test(src) && !loopback) return readFileSync(src, "utf8");
  const res = await fetch(src, { signal: AbortSignal.timeout(15_000), redirect: "follow", headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${src} -> HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_RECORD_BYTES) throw new Error(`${src}: ${text.length} bytes is not a record`);
  return text;
}

let obs: Observation;
try {
  obs = JSON.parse(await readRecord(file)) as Observation;
} catch (e) {
  console.log(`FAIL read       ${e instanceof Error ? e.message : String(e)}`);
  console.log("RESULT: FAIL");
  process.exit(1);
}

async function signerFromDid(src: string, keyId: string): Promise<string | null> {
  const text = /^https:\/\//.test(src) ? await (await fetch(src, { signal: AbortSignal.timeout(15_000) })).text() : readFileSync(src, "utf8");
  const doc = JSON.parse(text) as { verificationMethod?: { id: string; blockchainAccountId?: string }[] };
  const vm = doc.verificationMethod?.find((m) => m.id === keyId);
  const m = vm?.blockchainAccountId ? /^eip155:\d+:(0x[0-9a-fA-F]{40})$/.exec(vm.blockchainAccountId) : null;
  return m ? m[1]! : null;
}

let expected = arg("--signer");
const did = arg("--did");
if (did) {
  const fromDid = await signerFromDid(did, obs.observer.id);
  if (!fromDid) {
    console.log(`FAIL key       ${obs.observer.id} is not in ${did}`);
    process.exit(1);
  }
  expected = fromDid;
}

const lines: [boolean | null, string, string][] = [];
let anchorOnChain = false;
// Without --signer or --did, the record must be signed by one of vet402's published keys (src/receipt/observers.ts).
if (!expected) {
  const known = VET402_OBSERVER_KEYS.find((k) => k.toLowerCase() === obs.observer.address.toLowerCase());
  if (known) {
    expected = known;
    lines.push([true, "key", `${known} is a vet402 observation key (src/receipt/observers.ts)`]);
  } else {
    lines.push([false, "key", `${obs.observer.address} is not a vet402 observation key; pass --signer or --did to check another observer`]);
  }
} else {
  lines.push([true, "key", `expected signer ${expected} (${did ? did : "--signer"})`]);
}
const off = await verifyOffline(obs, expected ? { expectedSigner: expected } : {});
lines.push([off.schema.ok, "schema", off.schema.ok ? "matches x402-observation/v0" : off.schema.errors.join("; ")]);
lines.push([off.signature.ok, "signature", off.signature.detail]);
lines.push([off.verdict.ok, "verdict", off.verdict.detail]);
lines.push([off.merkle.ok, "merkle", off.merkle.detail]);

if (!process.argv.includes("--offline")) {
  try {
    const p = await checkPayment(obs);
    lines.push([p.ok, "payment", `${obs.payment.network} ${obs.payment.transaction}: ${p.detail}`]);
  } catch (e) {
    lines.push([false, "payment", `could not read chain: ${e instanceof Error ? e.message : String(e)}`]);
  }
  try {
    const a = await checkAnchorOnChain(obs);
    if (a) {
      lines.push([a.ok, "anchor", a.detail]);
      anchorOnChain = a.ok;
    } else if (obs.anchor && obs.anchor.network.startsWith("solana:")) {
      // The record says pending. Look for vet402's own memo for that day anyway: the root may have been
      // written after this copy of the record was made.
      const anc = obs.anchor;
      const look = await findDayAnchors(jsonRpc(DEFAULT_RPC[anc.network] ?? ""), anc.day);
      const match = look.found.find((f) => memoMatches(f.memo, anc) === null);
      if (match) {
        lines.push([true, "anchor", `the record says pending, but vet402's memo for ${anc.day} (${match.signature}) holds this root`]);
        anchorOnChain = true;
      } else if (look.found.length) {
        lines.push([false, "anchor", `vet402 wrote a different root for ${anc.day} (${look.found.map((f) => f.signature).join(", ")}): ${memoMatches(look.found[0]!.memo, anc)}`]);
      } else {
        lines.push([null, "anchor", look.complete ? `no vet402 memo for ${anc.day} on chain yet (root not yet written)` : `vet402's memo history was not read back to ${anc.day}; could not tell whether the root is written`]);
      }
    } else {
      lines.push([null, "anchor", "the record is not in a daily root"]);
    }
  } catch (e) {
    lines.push([false, "anchor", `could not read chain: ${e instanceof Error ? e.message : String(e)}`]);
  }
  // The same root also written on Tempo (a TIP-20 memo), when the records index names it for the day.
  const idxSrc = obs.anchor ? indexSource(file) : null;
  if (idxSrc) {
    let idx: unknown = null;
    try {
      idx = await readIndex(idxSrc);
    } catch (e) {
      lines.push([null, "anchor-tempo", `records index ${idxSrc} not read (${e instanceof Error ? e.message : String(e)}); Tempo not checked`]);
    }
    if (idx !== null) {
      const t = tempoAnchorFromIndex(idx, obs);
      if (t.problem) lines.push([false, "anchor-tempo", `${idxSrc}: ${t.problem}`]);
      else if (t.entry) {
        try {
          const c = await checkTempoDayAnchor(t.entry, { day: obs.anchor!.day, root: obs.anchor!.root }, jsonRpc(DEFAULT_RPC[TEMPO_ANCHOR_NETWORK] ?? ""));
          lines.push([c.ok, "anchor-tempo", c.detail]);
        } catch (e) {
          lines.push([false, "anchor-tempo", `could not read Tempo: ${e instanceof Error ? e.message : String(e)}`]);
        }
      }
    }
  }
} else {
  lines.push([null, "payment", "skipped (--offline)"]);
  lines.push([null, "anchor", "skipped (--offline)"]);
}

lines.push([null, "response", obs.response.responseHash ? `responseHash ${obs.response.responseHash}: recompute it from the body you hold (${obs.response.responseHashEncoding})` : `responseHash: ${obs.response.responseHashNote ?? "not recorded"}`]);

console.log(`${obs.id}  ${obs.verdict.code}  ${obs.resourceUrl}`);
for (const [ok, k, d] of lines) console.log(`${ok === true ? "OK  " : ok === false ? "FAIL" : "--  "} ${k.padEnd(10)} ${d}`);
const failed = lines.some(([ok]) => ok === false);
if (failed) console.log("RESULT: FAIL");
else if (anchorOnChain) console.log("RESULT: OK (every check passed; the day's root is on chain from vet402's anchor wallet)");
else {
  console.log(`RESULT: OK (not yet anchored${process.argv.includes("--offline") ? "; offline: payment and anchor not checked" : ""})`);
  console.log(
    "Not shown until the day's root is on chain: that this record belongs to the day vet402 committed to, or that it existed at that time. The merkle line only shows that the proof and the root inside this record agree.",
  );
}
process.exit(failed ? 1 : 0);
