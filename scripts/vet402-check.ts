/**
 * Usage: npx tsx scripts/vet402-check.ts <x402 URL> [--bazaar-calls N] [--max-amount ATOMIC]
 * Prints one JSON document (CheckResult). Read-only: no wallet, no payment.
 */
import { vet402Check } from "../src/check/vet402-check.js";

const argv = process.argv.slice(2);
const url = argv.find((a) => /^https?:\/\//.test(a));
if (!url || /[\s;|`$<>]/.test(url)) {
  console.error("usage: vet402-check <https://seller/url> [--bazaar-calls N] [--max-amount ATOMIC]");
  process.exit(2);
}
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const bc = flag("--bazaar-calls");
const max = flag("--max-amount");
if (bc !== undefined && !/^\d+$/.test(bc)) throw new Error("--bazaar-calls must be an integer");
if (max !== undefined && !/^\d+$/.test(max)) throw new Error("--max-amount must be a positive integer (USDC atomic)");

const out = await vet402Check(url, { bazaarCalls30d: bc === undefined ? undefined : Number(bc), maxAmountAtomic: max });
console.log(JSON.stringify(out, null, 2));
