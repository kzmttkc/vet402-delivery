/**
 * Run before announcing that a 3.11 chain has purchases (3.11-7).
 * It reads the public purchase ledger itself (data/evm/<lane>.json); a count cannot be passed in.
 * Exits 2, and nothing may be sent, when the ledger has no purchase on that chain or the chain is Monad while FAIL.
 *
 *   npx tsx scripts/first-purchase-announce-gate.ts <caip2> [--data <dir>]
 */
import { firstPurchaseAnnounceFromLedgerProblem } from "../src/evm/first-purchase-announce.js";

const argv = process.argv.slice(2);
const caip2 = argv[0];
const di = argv.indexOf("--data");
const dataDir = di >= 0 ? argv[di + 1] : "data";
const extra = argv.filter((a, i) => i !== 0 && a !== "--data" && i !== di + 1);
if (!caip2 || !/^eip155:\d+$/.test(caip2) || !dataDir || extra.length) {
  console.error("usage: first-purchase-announce-gate.ts <caip2> [--data <dir>] (the published count is read from the ledger, not passed)");
  process.exit(2);
}
const { problem, published } = firstPurchaseAnnounceFromLedgerProblem(caip2, dataDir);
if (problem) {
  console.error(`${problem}; nothing sent`);
  process.exit(2);
}
console.log(`announce allowed for ${caip2}: ${published} published purchase row(s) in ${dataDir}/evm`);
