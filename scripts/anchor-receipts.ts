/**
 * Write one day's Merkle root of x402-observation records into a Solana memo (src/receipt/anchor-run.ts).
 *
 *   npx tsx scripts/anchor-receipts.ts --day 2026-09-28                  # simulate only (default)
 *   npx tsx scripts/anchor-receipts.ts --day 2026-09-28 --send           # sign and send once
 *   npx tsx scripts/anchor-receipts.ts --day 2026-09-28 --resume         # read the chain after an interrupted send
 *   npx tsx scripts/anchor-receipts.ts --day 2026-09-28 --resume --send  # ... and send again if it is safe
 *
 * Records are read from ~/vet402-solana-receipt/results/receipts, the one place the signed records are
 * built. --from <dir> reads elsewhere for a simulation; --send and --resume refuse any other folder
 * unless --other-receipts-dir is given as well, so a stray copy can never be anchored by accident.
 *
 * Without --send nothing is signed or sent. With --send the Solana payer key (.keys/payer.json, mode
 * 600, must be the anchor wallet) signs a memo-only transaction; the network fee is the only thing that
 * leaves the wallet, and above MAX_FEE_LAMPORTS nothing is signed. RPC: SOLANA_RPC_URL.
 */
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPayer } from "../src/client.js";
import { jsonRpc } from "../src/chain.js";
import { PAYER_ADDRESS } from "../src/constants.js";
import { plan, resume, send, type AnchorDeps } from "../src/receipt/anchor-run.js";

export const DEFAULT_RECEIPTS_DIR = join(homedir(), "vet402-solana-receipt", "results", "receipts");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`);
  return v;
};
const day = argValue("--day");
if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
  console.error("usage: anchor-receipts.ts --day YYYY-MM-DD [--send] [--resume] [--from <dir> [--other-receipts-dir]]");
  process.exit(2);
}
const doSend = args.includes("--send");
const doResume = args.includes("--resume");
const from = resolve(argValue("--from") ?? DEFAULT_RECEIPTS_DIR);
if ((doSend || doResume) && from !== DEFAULT_RECEIPTS_DIR && !args.includes("--other-receipts-dir")) {
  console.error(`--send and --resume only use ${DEFAULT_RECEIPTS_DIR} (got ${from}); add --other-receipts-dir to override`);
  process.exit(2);
}

const deps: AnchorDeps = {
  rpc: jsonRpc(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"),
  dayDir: join(from, day),
  day,
  feePayer: PAYER_ADDRESS,
  loadSigner: () => loadPayer(join(ROOT, ".keys", "payer.json")), // mode 600, address must be PAYER_ADDRESS
  log: (l) => console.log(l),
};

if (doResume) {
  console.log(JSON.stringify(await resume(deps, { send: doSend }), null, 2));
} else if (doSend) {
  console.log(JSON.stringify(await send(deps), null, 2));
} else {
  const p = await plan(deps);
  console.log(JSON.stringify(p.plan, null, 2));
  console.log("simulate only: nothing was signed or sent (pass --send to write the root on chain)");
  process.exit(p.plan.simulation.ok ? 0 : 1);
}
