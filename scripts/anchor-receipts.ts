/**
 * Write one day's Merkle root of x402-observation records into a Solana memo (src/receipt/anchor-run.ts).
 *
 *   npx tsx scripts/anchor-receipts.ts --day 2026-09-28                  # simulate only (default)
 *   npx tsx scripts/anchor-receipts.ts --day 2026-09-28 --send           # sign and send once
 *   npx tsx scripts/anchor-receipts.ts --day 2026-09-28 --resume         # read the chain after an interrupted send
 *   npx tsx scripts/anchor-receipts.ts --day 2026-09-28 --resume --send  # ... and send again if it is safe
 *   npx tsx scripts/anchor-receipts.ts --day 2026-09-28 --post-root          # simulate post_root
 *   npx tsx scripts/anchor-receipts.ts --day 2026-09-28 --post-root --send   # write it
 *
 * --post-root (off by default) copies an already anchored day's root into the observation-roots program
 * (src/receipt/roots-post.ts), after checking the day's memo on chain. The memo stays the primary record.
 * With --send, once the day's account is on chain (posted now, or already there) and reads back with
 * exactly the memo's root, count, sequence range and observer, <day>/anchor-program-sent.json records the
 * program, the account, the post_root transaction and its slot (src/receipt/roots-index.ts), and
 * publish-records puts them in data/records/index.json (days[].programRoot). Exit 3: the posting key holds
 * too little SOL for one more day, and nothing was signed.
 * VET402_ROOTS_RPC selects the cluster (default SOLANA_RPC_URL); the program and the posting key are the
 * ones pinned for that cluster's genesis in ROOTS_DEPLOYMENTS_BY_GENESIS, and any other cluster is refused.
 * post_root is signed and paid (fee and the day account's rent) by the posting key
 * (.keys/mainnet/roots-poster.json on mainnet), never by the payer wallet.
 *
 * Records are read from ~/vet402-solana-receipt/results/receipts, the one place the signed records are
 * built. --from <dir> reads elsewhere for a simulation; --send and --resume refuse any other folder
 * unless --other-receipts-dir is given as well, so a stray copy can never be anchored by accident.
 *
 * Before anything else the day must pass src/receipt/sources.ts: its inputs in the remeasure folder
 * (--remeasure-dir, default the production one) unchanged since the build, and not built while its UTC
 * day was open. --resume without --send skips this, since it only records a send already made.
 *
 * Without --send nothing is signed or sent. With --send the Solana payer key (.keys/payer.json, mode
 * 600, must be the anchor wallet) signs a memo-only transaction; the network fee is the only thing that
 * leaves the wallet, and above MAX_FEE_LAMPORTS nothing is signed. RPC: SOLANA_RPC_URL.
 */
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPayer } from "../src/client.js";
import { jsonRpc } from "../src/chain.js";
import { PAYER_ADDRESS } from "../src/constants.js";
import { dayRoot, plan, readDay, resume, send, type AnchorDeps } from "../src/receipt/anchor-run.js";
import { checkAnchorOnChain } from "../src/receipt/chain.js";
import { dayRootOnChain, PROGRAM_ROOT_FILE } from "../src/receipt/roots-index.js";
import { loadKeyFile, planPostRoot, PosterBalanceTooLow, postRootArgsFromRecord, sendPostRoot, type PostRootDeps } from "../src/receipt/roots-post.js";
import { ROOTS_DEPLOYMENTS_BY_GENESIS } from "../src/receipt/roots-program.js";
import { assertDaySourcesCurrent } from "../src/receipt/sources.js";
import { RM_PROD_DIR } from "../src/remeasure/constants.js";

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
  console.error("usage: anchor-receipts.ts --day YYYY-MM-DD [--send] [--resume] [--from <dir> [--other-receipts-dir]] [--remeasure-dir <dir>]");
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
// The day's inputs must be what it was signed from, and it must not have been built while open.
// --resume alone only reads the chain for a send already made, so it is not held back.
if (!doResume || doSend) {
  try {
    assertDaySourcesCurrent(join(from, day), day, remeasureDir);
  } catch (e) {
    console.error(`not anchoring: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}

const deps: AnchorDeps = {
  rpc: jsonRpc(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com"),
  dayDir: join(from, day),
  day,
  feePayer: PAYER_ADDRESS,
  loadSigner: () => loadPayer(join(ROOT, ".keys", "payer.json")), // mode 600, address must be PAYER_ADDRESS
  log: (l) => console.log(l),
};

if (args.includes("--post-root")) {
  // Off unless asked for: mirror the day's memo into the observation-roots program.
  // Only a day whose memo is already on chain qualifies; the memo stays the primary record.
  // The program and the posting key are pinned per cluster (src/receipt/roots-program.ts), never taken
  // from the environment. The posting key is its own key, not the payer wallet.
  const rootsRpc = jsonRpc(process.env.VET402_ROOTS_RPC ?? process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com");
  const genesis = (await rootsRpc("getGenesisHash", [])) as string;
  const deployment = ROOTS_DEPLOYMENTS_BY_GENESIS[genesis];
  if (!deployment) {
    console.error(`not posting: no observation-roots deployment is pinned for the cluster with genesis ${genesis}`);
    process.exit(2);
  }
  const obs = readDay(deps);
  dayRoot(deps, obs, { allowAnchored: true }); // the records on disk still give the root they carry
  if (obs.some((o) => o.anchor?.status !== "anchored")) {
    console.error(`not posting: ${day} is not fully anchored by memo yet (run --send first)`);
    process.exit(2);
  }
  const memo = await checkAnchorOnChain(obs[0]!, () => deps.rpc);
  if (!memo?.ok) {
    console.error(`not posting: the memo for ${day} does not check on chain: ${memo?.detail}`);
    process.exit(2);
  }
  const rootsDeps: PostRootDeps = {
    rpc: rootsRpc,
    program: deployment.program,
    feePayer: deployment.poster,
    loadSigner: () => loadKeyFile(join(ROOT, deployment.posterKeyFile), deployment.poster), // mode 600, address checked
    log: deps.log,
  };
  const a = postRootArgsFromRecord(obs[0]!);
  try {
    if (doSend) {
      console.log(JSON.stringify(await sendPostRoot(rootsDeps, a), null, 2));
      // Posted now or before: read the account back and record where the root is, for the records index.
      // The RPC's signature index can trail the account by a few seconds after a fresh post: read again before giving up.
      let entry: Awaited<ReturnType<typeof dayRootOnChain>> | null = null;
      for (let i = 0; entry === null; i++) {
        try {
          entry = await dayRootOnChain(rootsRpc, { program: deployment.program, poster: deployment.poster }, a, "confirmed");
        } catch (e) {
          if (i >= 9 || /differs from the day's root|owned by|paid by/.test(String(e))) throw e;
          await new Promise((r) => setTimeout(r, 3000));
        }
      }
      writeFileSync(join(deps.dayDir, PROGRAM_ROOT_FILE), `${JSON.stringify({ status: "posted", ...entry }, null, 2)}\n`);
      console.log(`${day}: ${PROGRAM_ROOT_FILE} names ${entry.account} (tx ${entry.tx}, slot ${entry.slot})`);
    } else {
      const p = await planPostRoot(rootsDeps, a);
      const { tx: _tx, ...shown } = p as typeof p & { tx?: unknown };
      console.log(JSON.stringify(shown, null, 2));
      console.log("simulate only: nothing was signed or sent (pass --post-root --send to write it)");
    }
  } catch (e) {
    if (!(e instanceof PosterBalanceTooLow)) throw e;
    console.error(`not posting: ${e.message}`);
    process.exit(3);
  }
} else if (doResume) {
  console.log(JSON.stringify(await resume(deps, { send: doSend }), null, 2));
} else if (doSend) {
  console.log(JSON.stringify(await send(deps), null, 2));
} else {
  const p = await plan(deps);
  console.log(JSON.stringify(p.plan, null, 2));
  console.log("simulate only: nothing was signed or sent (pass --send to write the root on chain)");
  process.exit(p.plan.simulation.ok ? 0 : 1);
}
