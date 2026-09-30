/**
 * The secret gate against fresh randomness: every shape in src/daily/gate-shapes.ts, N times each (default
 * 2000). Prints how many passed the gate per shape; exit 1 if any did. No file is read or written.
 *
 *   npx tsx scripts/daily/gate-trial.ts [N]
 */
import { randomInt } from "node:crypto";
import { blockingFindings, scanFileText } from "../../src/daily/secret-gate.js";
import { GATE_SHAPES } from "../../src/daily/gate-shapes.js";

const n = Number(process.argv[2] ?? 2000);
const rand = () => randomInt(0, 2 ** 32) / 2 ** 32;
let total = 0;
for (const [label, make] of GATE_SHAPES) {
  let passed = 0;
  for (let i = 0; i < n; i++) if (blockingFindings(scanFileText(make(rand), "data/x.json"), []).length === 0) passed++;
  total += passed;
  console.log(`${label}: passed the gate ${passed}/${n}`);
}
console.log(`total passed ${total}`);
process.exit(total ? 1 : 0);
