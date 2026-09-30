/**
 * Write one day's Merkle root of x402-observation records on Tempo as well (src/receipt/anchor-tempo-run.ts):
 * a TIP-20 transferWithMemo of 1 atomic USDC.e from vet402's Tempo anchor key to vet402's observer
 * address, the root as the 32-byte memo.
 *
 *   npx tsx scripts/anchor-receipts-tempo.ts --day 2026-09-29                  # simulate only (default)
 *   npx tsx scripts/anchor-receipts-tempo.ts --day 2026-09-29 --send           # sign and send once
 *   npx tsx scripts/anchor-receipts-tempo.ts --day 2026-09-29 --resume         # read the chain after an interrupted send
 *   npx tsx scripts/anchor-receipts-tempo.ts --day 2026-09-29 --resume --send  # ... and rebroadcast or send again if it is safe
 *   npx tsx scripts/anchor-receipts-tempo.ts --keygen                          # create .keys/tempo-anchor.json (prints the address only)
 *
 * The same gates as scripts/anchor-receipts.ts: records only from ~/vet402-solana-receipt/results/receipts
 * for --send and --resume (unless --other-receipts-dir), and src/receipt/sources.ts first (inputs unchanged
 * since the build; a day built while open is refused). --resume without --send skips the sources check.
 *
 * Without --send nothing is signed or sent. With --send the anchor key (.keys/tempo-anchor.json, mode 600,
 * must be vet402's Tempo anchor key in src/receipt/observers.ts) signs one transferWithMemo; above
 * MAX_TEMPO_ANCHOR_FEE_ATOMIC nothing is signed. RPC: TEMPO_RPC_URL.
 *
 * Fund the anchor key with USDC.e from any address but the payer (src/tempo/constants.ts PAYER_ADDRESS):
 * USDC.e leaving the payer outside a purchase ledger stops every Tempo purchase run
 * (chain_spend_exceeds_ledger, src/tempo/key-ledgers.ts).
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Transaction } from "viem/tempo";
import { jsonRpc } from "../src/chain.js";
import { plan, resume, send, type TempoAnchorDeps } from "../src/receipt/anchor-tempo-run.js";
import { VET402_TEMPO_ANCHOR_SENDERS } from "../src/receipt/observers.js";
import { assertDaySourcesCurrent } from "../src/receipt/sources.js";
import { RM_PROD_DIR } from "../src/remeasure/constants.js";
import { PAYER_ADDRESS, TEMPO_RPC_URL } from "../src/tempo/constants.js";
/** The same folder as scripts/anchor-receipts.ts DEFAULT_RECEIPTS_DIR (not imported: that script runs on import). */
const DEFAULT_RECEIPTS_DIR = join(homedir(), "vet402-solana-receipt", "results", "receipts");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`);
  return v;
};
const keyFile = resolve(argValue("--key") ?? join(ROOT, ".keys", "tempo-anchor.json"));

if (args.includes("--keygen")) {
  const pk = generatePrivateKey();
  writeFileSync(keyFile, `${JSON.stringify({ privateKey: pk })}\n`, { flag: "wx", mode: 0o600 });
  console.log(`wrote ${keyFile} (mode 600). Tempo anchor key address: ${privateKeyToAccount(pk).address}`);
  process.exit(0);
}

const day = argValue("--day");
if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
  console.error("usage: anchor-receipts-tempo.ts --day YYYY-MM-DD [--send] [--resume] [--from <dir> [--other-receipts-dir]] [--remeasure-dir <dir>] | --keygen");
  process.exit(2);
}
const doSend = args.includes("--send");
const doResume = args.includes("--resume");
const from = resolve(argValue("--from") ?? DEFAULT_RECEIPTS_DIR);
if ((doSend || doResume) && from !== DEFAULT_RECEIPTS_DIR && !args.includes("--other-receipts-dir")) {
  console.error(`--send and --resume only use ${DEFAULT_RECEIPTS_DIR} (got ${from}); add --other-receipts-dir to override`);
  process.exit(2);
}
const remeasureDir = resolve(argValue("--remeasure-dir") ?? RM_PROD_DIR);
if ((doSend || doResume) && remeasureDir !== resolve(RM_PROD_DIR) && !args.includes("--other-receipts-dir")) {
  console.error(`--send and --resume only check the day against ${RM_PROD_DIR} (got ${remeasureDir}); add --other-receipts-dir to override`);
  process.exit(2);
}
if (!doResume || doSend) {
  try {
    assertDaySourcesCurrent(join(from, day), day, remeasureDir);
  } catch (e) {
    console.error(`not anchoring: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}

/** Loads the anchor key; the key is never printed (fixed messages: a JSON error could quote it). */
async function loadSigner() {
  if ((statSync(keyFile).mode & 0o077) !== 0) throw new Error(`${keyFile} must be mode 600`);
  let pk: string | undefined;
  try {
    pk = (JSON.parse(readFileSync(keyFile, "utf8")) as { privateKey?: string }).privateKey;
  } catch {
    throw new Error(`${keyFile}: unreadable key file`);
  }
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error(`${keyFile}: no privateKey`);
  const account = privateKeyToAccount(pk as Hex);
  return {
    address: account.address,
    signTransaction: (tx: Parameters<Awaited<ReturnType<TempoAnchorDeps["loadSigner"]>>["signTransaction"]>[0]) =>
      account.signTransaction(tx as never, { serializer: Transaction.serialize as never }),
  };
}

const deps: TempoAnchorDeps = {
  rpc: jsonRpc(process.env.TEMPO_RPC_URL ?? TEMPO_RPC_URL),
  dayDir: join(from, day),
  day,
  sender: VET402_TEMPO_ANCHOR_SENDERS[0]!,
  loadSigner,
  log: (l) => console.log(l),
  // Plan only: try the call from another address before the anchor key holds USDC.e (send refuses it).
  ...(argValue("--simulate-from") ? { simulateFrom: argValue("--simulate-from")! } : {}),
};

if (doResume) {
  console.log(JSON.stringify(await resume(deps, { send: doSend }), null, 2));
} else if (doSend) {
  console.log(JSON.stringify(await send(deps), null, 2));
} else {
  const p = await plan(deps);
  console.log(JSON.stringify(p.plan, null, 2));
  console.log("simulate only: nothing was signed or sent (pass --send to write the root on Tempo)");
  console.log(`funding: send USDC.e to the anchor key ${p.plan.sender} from any address but the payer ${PAYER_ADDRESS} (a transfer out of the payer stops every Tempo purchase run)`);
  process.exit(p.plan.simulation.ok ? 0 : 1);
}
