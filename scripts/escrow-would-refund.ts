/**
 * How many of vet402's paid purchases an escrow keyed on the signed record would have returned to the buyer, per chain:
 * payment settled on chain, nothing usable back, failure on the seller's side (src/escrow/would-refund.ts has the
 * definition). Reads data/ only (every file checked against data/manifest.json). Signs and sends nothing.
 *
 *   npx tsx scripts/escrow-would-refund.ts                  # prints the JSON
 *   npx tsx scripts/escrow-would-refund.ts --out <file>     # writes it
 *
 * The same report is built into the site as escrow.json, next to escrow.html (scripts/build-site.ts).
 */
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { wouldRefundFromData } from "../src/escrow/would-refund.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const i = args.indexOf("--data");
const dataDir = i >= 0 && args[i + 1] ? resolve(args[i + 1]!) : join(ROOT, "data");
const o = args.indexOf("--out");
const report = wouldRefundFromData(dataDir);
const text = JSON.stringify(report, null, 2) + "\n";
if (o >= 0) {
  const out = args[o + 1];
  if (!out || out.startsWith("--")) throw new Error("--out needs a file");
  writeFileSync(resolve(out), text);
  const t = report.totals;
  console.error(`escrow would return ${t.wouldRefund.purchases} purchases (${t.wouldRefund.amountUsd} USD) of ${t.settled} settled, up to ${report.dataDate}; wrote ${out}`);
} else process.stdout.write(text);
