/**
 * Make the observation signing key: a secp256k1 key used only to sign x402-observation records.
 * It is not a payment key and must never hold funds.
 *
 *   npx tsx scripts/receipt-keygen.ts --out <dir>/attest.json
 *
 * Writes <out> (mode 600, { privateKey }) and <out minus .json>.pub (the address). Refuses to
 * overwrite. Prints only the address.
 */
import { writeFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const i = process.argv.indexOf("--out");
const out = i >= 0 ? process.argv[i + 1] : undefined;
if (!out || !out.endsWith(".json")) {
  console.error("usage: receipt-keygen.ts --out <path>/attest.json");
  process.exit(2);
}
if (existsSync(out)) {
  console.error(`${out} exists; not overwriting`);
  process.exit(2);
}
const pk = generatePrivateKey();
writeFileSync(out, `${JSON.stringify({ privateKey: pk, purpose: "x402-observation signing only; never a payment key" })}\n`, { mode: 0o600, flag: "wx" });
chmodSync(out, 0o600);
const addr = privateKeyToAccount(pk).address;
writeFileSync(out.replace(/\.json$/, ".pub"), `${addr}\n`, { flag: "wx" });
console.log(`observation key address ${addr} (mode ${(statSync(out).mode & 0o777).toString(8)})`);
