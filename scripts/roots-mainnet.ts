/**
 * After the observation-roots program is deployed on mainnet: check the deployment, then initialize it.
 *
 *   npx tsx scripts/roots-mainnet.ts check          # program, upgrade authority, on-chain bytes vs the local .so, config
 *   npx tsx scripts/roots-mainnet.ts init           # simulate initialize (posting authority = the pinned poster)
 *   npx tsx scripts/roots-mainnet.ts init --send    # sign with the upgrade authority key and send once
 *
 * The program, the upgrade authority and the poster are the ones pinned for mainnet in
 * src/receipt/roots-program.ts (ROOTS_DEPLOYMENTS_BY_GENESIS). Refuses any RPC that is not mainnet.
 * RPC: SOLANA_RPC_URL (default the public mainnet endpoint). Keys are read from .keys/mainnet/ and never printed.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonRpc } from "../src/chain.js";
import { loadKeyFile } from "../src/receipt/roots-post.js";
import {
  BPF_LOADER_UPGRADEABLE,
  configPda,
  decodeConfig,
  decodeProgramData,
  initializeIx,
  MAINNET_GENESIS,
  programDataAddress,
  ROOTS_DEPLOYMENTS_BY_GENESIS,
  sameProgramBytes,
} from "../src/receipt/roots-program.js";
import { sendIxs, simulateIxs } from "../src/receipt/roots-tx.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SO = join(ROOT, "solana-program/target/deploy/observation_roots.so");

const step = process.argv[2];
const doSend = process.argv.includes("--send");
if (step !== "check" && step !== "init") {
  console.error("usage: roots-mainnet.ts check | init [--send]");
  process.exit(2);
}
const rpc = jsonRpc(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com");
if ((await rpc("getGenesisHash", [])) !== MAINNET_GENESIS) throw new Error("RPC is not Solana mainnet; refusing");
const dep = ROOTS_DEPLOYMENTS_BY_GENESIS[MAINNET_GENESIS]!;
if (!dep.upgradeAuthority || !dep.upgradeAuthorityKeyFile) throw new Error("no upgrade authority pinned for mainnet");

type Acc = { value: { data: [string, string]; owner: string; executable: boolean; lamports: number } | null };
const account = async (a: string) => ((await rpc("getAccountInfo", [a, { encoding: "base64", commitment: "finalized" }])) as Acc).value;
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function check(): Promise<{ ok: boolean; config: ReturnType<typeof decodeConfig> | null; lines: string[] }> {
  const lines: string[] = [];
  let ok = true;
  const fail = (l: string) => {
    ok = false;
    lines.push(`FAIL ${l}`);
  };
  const prog = await account(dep.program);
  if (!prog) return { ok: false, config: null, lines: [`FAIL no account at ${dep.program}: not deployed`] };
  if (prog.owner !== BPF_LOADER_UPGRADEABLE || !prog.executable) fail(`${dep.program} is not an upgradeable program`);
  const pdAddr = await programDataAddress(dep.program);
  const pd = await account(pdAddr);
  if (!pd) return { ok: false, config: null, lines: [...lines, `FAIL no ProgramData at ${pdAddr}`] };
  const { upgradeAuthority: authority, program: onChain } = decodeProgramData(Buffer.from(pd.data[0], "base64"));
  if (authority === dep.upgradeAuthority) lines.push(`ok upgrade authority ${authority}`);
  else fail(`upgrade authority is ${authority ?? "none (frozen)"}, expected ${dep.upgradeAuthority}`);
  const local = readFileSync(SO);
  if (sameProgramBytes(onChain, local)) lines.push(`ok on-chain program bytes equal the local .so (${local.length} bytes, sha256 ${sha256(local)})`);
  else fail(`on-chain program bytes differ from ${SO} (local sha256 ${sha256(local)}, on-chain first ${local.length} bytes ${sha256(onChain.subarray(0, local.length))})`);
  const cfg = await account(await configPda(dep.program));
  const config = cfg ? decodeConfig(Buffer.from(cfg.data[0], "base64")) : null;
  lines.push(config ? `config: authority ${config.authority}, pending ${config.pendingAuthority ?? "none"}` : "config: not initialized");
  if (config && config.authority !== dep.poster) fail(`config authority is ${config.authority}, expected ${dep.poster}`);
  return { ok, config, lines };
}

const c = await check();
for (const l of c.lines) console.log(l);
if (step === "check") process.exit(c.ok ? 0 : 1);

if (!c.ok) {
  console.error("not initializing: the deployment does not check");
  process.exit(1);
}
if (c.config) {
  console.log("already initialized; nothing to do");
  process.exit(0);
}
const ix = await initializeIx({ program: dep.program, payer: dep.upgradeAuthority, authority: dep.poster });
const sim = await simulateIxs(rpc, dep.upgradeAuthority, [ix]);
console.log(`simulate initialize (authority ${dep.poster}): err ${JSON.stringify(sim.err)}, ${sim.unitsConsumed} CU`);
if (sim.err !== null) {
  console.error(sim.logs.join("\n"));
  process.exit(1);
}
if (!doSend) {
  console.log("simulate only: nothing was signed or sent (pass --send)");
  process.exit(0);
}
const signer = await loadKeyFile(join(ROOT, dep.upgradeAuthorityKeyFile), dep.upgradeAuthority);
const r = await sendIxs(rpc, signer, [ix]);
console.log(`initialize ${r.signature}: err ${JSON.stringify(r.err)}`);
process.exit(r.err === null ? 0 : 1);
