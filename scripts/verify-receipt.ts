/**
 * Re-check an x402-observation record without trusting vet402. No account, no payment.
 *
 *   npx tsx scripts/verify-receipt.ts <record.json> [--signer 0x...] [--did <did.json path or https URL>] [--offline]
 *
 * Checks: shape (JSON Schema), vet402's EIP-712 signature, that the verdict follows from the recorded
 * checks, Merkle inclusion in the day's root, and (unless --offline) the payment on chain and, once the
 * root is written, the anchor memo. Exit 0 only when every check that could run passed.
 * RPCs: SOLANA_RPC_URL, BASE_RPC_URL, TEMPO_RPC_URL (public defaults).
 */
import { readFileSync } from "node:fs";
import { checkAnchorOnChain, checkPayment } from "../src/receipt/chain.js";
import type { Observation } from "../src/receipt/types.js";
import { verifyOffline } from "../src/receipt/verify.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const file = process.argv[2];
if (!file || file.startsWith("--")) {
  console.error("usage: verify-receipt.ts <record.json> [--signer 0x...] [--did <path|url>] [--offline]");
  process.exit(2);
}
const obs = JSON.parse(readFileSync(file, "utf8")) as Observation;

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
    lines.push(a ? [a.ok, "anchor", a.detail] : [null, "anchor", "root not yet written on chain (pending); inclusion checked against the root in the record"]);
  } catch (e) {
    lines.push([false, "anchor", `could not read chain: ${e instanceof Error ? e.message : String(e)}`]);
  }
} else {
  lines.push([null, "payment", "skipped (--offline)"]);
}

lines.push([null, "response", obs.response.responseHash ? `responseHash ${obs.response.responseHash}: recompute it from the body you hold (${obs.response.responseHashEncoding})` : `responseHash: ${obs.response.responseHashNote ?? "not recorded"}`]);

console.log(`${obs.id}  ${obs.verdict.code}  ${obs.resourceUrl}`);
for (const [ok, k, d] of lines) console.log(`${ok === true ? "OK  " : ok === false ? "FAIL" : "--  "} ${k.padEnd(10)} ${d}`);
const failed = lines.some(([ok]) => ok === false);
console.log(failed ? "RESULT: FAIL" : "RESULT: OK (every check that could run passed)");
process.exit(failed ? 1 : 0);
