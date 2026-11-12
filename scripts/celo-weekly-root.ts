/**
 * Weekly Celo purchase root in DeliveryRoots (src/evm/celo-roots.ts).
 *
 *   npx tsx scripts/celo-weekly-root.ts                              plan for the latest closed UTC week
 *   npx tsx scripts/celo-weekly-root.ts --week 2026-11-08
 *   VET402_ANCHOR_SEND=celo npx tsx scripts/celo-weekly-root.ts --week <sunday> --send
 *   npx tsx scripts/celo-weekly-root.ts --check                        stale if > 8 days since RootRecorded
 *
 * Leaves come from https://vet402.com/api/v1/observatory/export.csv (network eip155:42220).
 * record(day, root, n) uses day = that week's Sunday (dayNumber). --send uses the DeliveryRoots key
 * (src/evm/key.ts ROOTS_POSTER_ADDRESS), never the payer wallet.
 * RPC defaults to https://forno.celo.org. VET402_CELO_RPC_URL replaces it; CELO_RPC_URL is the next fallback.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, formatEther, http, type Hex, type PublicClient } from "viem";
import {
  assertWeekSunday,
  CELO_CHAIN,
  CELO_DEPLOY_BLOCK,
  CELO_EXPORT_URL,
  lastClosedWeekSunday,
  parseCeloExport,
  rowsForWeek,
  weekRootFromRows,
  type CeloExportRow,
  type CeloSentWeek,
} from "../src/evm/celo-roots.js";
import { anchorFees, assertAnchorOnly, buildAnchorTx, dayNumber } from "../src/evm/evm-anchor.js";
import { loadRootsPoster, ROOTS_POSTER_ADDRESS } from "../src/evm/key.js";
import { deliveryRootsReadAbi, registryCodeProblem, runtimeWithWriter } from "../src/evm/roots.js";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const check = argv.includes("--check");
const send = argv.includes("--send");
if (send && process.env.VET402_ANCHOR_SEND !== "celo") throw new Error("--send also needs VET402_ANCHOR_SEND=celo");
const DEFAULT_ANCHORS = "results/evm/anchors";
const anchorsDir = arg("--anchors-dir") ?? DEFAULT_ANCHORS;
if (send && resolve(anchorsDir) !== resolve(DEFAULT_ANCHORS)) throw new Error(`--send only uses ${DEFAULT_ANCHORS}`);

const poster = ROOTS_POSTER_ADDRESS;
const registry = CELO_CHAIN.registry;
const rpc = process.env.VET402_CELO_RPC_URL ?? process.env[CELO_CHAIN.rpcEnv] ?? CELO_CHAIN.rpc;
const client = createPublicClient({ transport: http(rpc) }) as PublicClient;

const writePrivate = (f: string, text: string): void => {
  writeFileSync(f, text, { mode: 0o600 });
  chmodSync(f, 0o600);
};
const readJson = <T>(f: string): T => JSON.parse(readFileSync(f, "utf8")) as T;

const LOG_CHUNK = 5_000n;

async function lastRootRecorded(): Promise<{ day: number; block: bigint } | null> {
  const head = await client.getBlockNumber();
  let to = head;
  while (to >= CELO_DEPLOY_BLOCK) {
    let from = to > LOG_CHUNK ? to - LOG_CHUNK + 1n : CELO_DEPLOY_BLOCK;
    if (from < CELO_DEPLOY_BLOCK) from = CELO_DEPLOY_BLOCK;
    const logs = await client.getContractEvents({
      address: registry,
      abi: deliveryRootsReadAbi,
      eventName: "RootRecorded",
      fromBlock: from,
      toBlock: to,
      strict: true,
    });
    if (logs.length > 0) {
      let best: { day: number; block: bigint } | null = null;
      for (const log of logs) {
        const day = Number(log.args.day);
        const block = log.blockNumber ?? 0n;
        if (!best || block > best.block || (block === best.block && day > best.day)) best = { day, block };
      }
      return best;
    }
    if (from <= CELO_DEPLOY_BLOCK) break;
    to = from - 1n;
  }
  return null;
}

if (check) {
  if ((await client.getChainId()) !== CELO_CHAIN.chainId) throw new Error("RPC chainId mismatch");
  const last = await lastRootRecorded();
  if (!last) {
    console.error("no RootRecorded on Celo DeliveryRoots");
    process.exit(1);
  }
  const block = await client.getBlock({ blockNumber: last.block });
  const ageDays = (Date.now() / 1000 - Number(block.timestamp)) / 86_400;
  console.log(JSON.stringify({ lastDay: last.day, block: last.block.toString(), ageDays: Math.round(ageDays * 100) / 100 }, null, 2));
  if (ageDays > 8) process.exit(1);
  process.exit(0);
}

let week = arg("--week");
if (!week) week = lastClosedWeekSunday();
assertWeekSunday(week);

const sentFile = `${anchorsDir}/celo-week-${week}.sent.json`;
if (send && existsSync(sentFile)) {
  const s = readJson<CeloSentWeek>(sentFile);
  if (s.status === "sent") {
    console.log(`${sentFile}: already sent (${s.hash})`);
    process.exit(0);
  }
}

const csvPath = arg("--csv");
if (send && csvPath) throw new Error("--send only uses the public export; omit --csv");
let rows: CeloExportRow[];
if (csvPath) {
  rows = parseCeloExport(readFileSync(csvPath, "utf8"));
} else {
  const res = await fetch(CELO_EXPORT_URL, { headers: { "user-agent": "vet402-celo-weekly-root/0.1" } });
  if (!res.ok) throw new Error(`${CELO_EXPORT_URL} -> HTTP ${res.status}`);
  rows = parseCeloExport(await res.text());
}

const picked = rowsForWeek(rows, week);
const saltsFile = `${anchorsDir}/celo-week-${week}.salts.json`;
const planFile = `${anchorsDir}/celo-week-${week}.plan.json`;
const nowIso = new Date(Number(process.env.VET402_DAILY_NOW ?? Date.now() / 1000) * 1000).toISOString();
const made = weekRootFromRows(week, picked, nowIso);
const r = made.root;
const salts = made.salts;

if ((await client.getChainId()) !== CELO_CHAIN.chainId) throw new Error("RPC chainId mismatch");

const tx = buildAnchorTx(r, poster, registry);
assertAnchorOnly(tx, r, registry);
const code = await client.getCode({ address: registry });
const codeProblem = registryCodeProblem(code, poster);
const deployed = code !== undefined && code !== "0x";
const zero = `0x${"0".repeat(64)}` as Hex;
const dayN = dayNumber(week);
const onChain = deployed && !codeProblem ? await client.readContract({ address: registry, abi: deliveryRootsReadAbi, functionName: "rootOf", args: [dayN] }) : null;
const state =
  !deployed ? "not_deployed" : codeProblem ? "not_delivery_roots" : onChain === zero ? "open" : onChain!.toLowerCase() === r.root.toLowerCase() ? "already_on_chain" : "other_root_on_chain";

let gas: bigint | null = null;
let quoteNote: string | null = null;
if (state === "open" || state === "not_deployed") {
  try {
    gas = await client.estimateGas({
      account: poster,
      to: tx.to,
      value: 0n,
      data: tx.data,
      ...(state === "not_deployed" ? { stateOverride: [{ address: registry, code: runtimeWithWriter(poster) }] } : {}),
    });
    if (state === "not_deployed") quoteNote = "quoted with state override: DeliveryRoots not at registry";
  } catch (e) {
    quoteNote = `eth_estimateGas failed: ${(e as Error).message.split("\n")[0]}`;
  }
}
const gasPrice = await client.getGasPrice();
const plan = {
  lane: "celo",
  cadence: "weekly",
  chain: CELO_CHAIN.caip2,
  week,
  day: week,
  dayNumber: dayN,
  n: r.n,
  root: r.root,
  inputSha256: r.inputSha256,
  registry,
  writer: poster,
  state,
  tx: { to: tx.to, from: tx.from, value: "0", data: tx.data },
  quote: gas === null ? null : { gas: gas.toString(), gasPriceWei: gasPrice.toString(), feeNative: formatEther(gas * gasPrice), boundCapNative: formatEther(CELO_CHAIN.recordMaxFeeWei) },
  quoteNote,
};
console.log(JSON.stringify(plan, null, 2));
if (state === "other_root_on_chain" || state === "not_delivery_roots") {
  console.error(state === "other_root_on_chain" ? `week ${week} on chain holds ${onChain}, not ${r.root}` : codeProblem);
  process.exit(4);
}

mkdirSync(anchorsDir, { recursive: true });
if (!send) {
  writePrivate(saltsFile, JSON.stringify(salts, null, 2) + "\n");
  writePrivate(planFile, JSON.stringify({ ...plan, leaves: r.leaves, digests: r.digests, proofs: r.proofs }, null, 2) + "\n");
  process.exit(0);
}

if (state === "not_deployed") throw new Error(`DeliveryRoots is not at ${registry} on Celo`);
if (existsSync(sentFile)) {
  const s = readJson<CeloSentWeek>(sentFile);
  if (s.status !== "sending" || state !== "already_on_chain" || s.root.toLowerCase() !== r.root.toLowerCase())
    throw new Error(`${sentFile} is "${s.status}" and on chain is ${state}: look by hand`);
  const deployFile = `${anchorsDir}/deploy-celo.json`;
  const deployBlock = existsSync(deployFile) ? readJson<{ block?: string }>(deployFile).block : undefined;
  const from = s.fromBlock ?? deployBlock;
  if (!from || !/^\d+$/.test(from)) throw new Error(`${sentFile} names no fromBlock and deploy-celo.json has none`);
  const logs = await client.getContractEvents({
    address: registry,
    abi: deliveryRootsReadAbi,
    eventName: "RootRecorded",
    args: { day: dayN },
    fromBlock: BigInt(from),
    strict: true,
  });
  const log = logs.find((l) => l.args.root?.toLowerCase() === r.root.toLowerCase());
  if (!log?.transactionHash) throw new Error(`root on chain but no RootRecorded log for ${week}`);
  writePrivate(sentFile, JSON.stringify({ ...s, status: "sent", hash: log.transactionHash, block: log.blockNumber?.toString() ?? null, completedFromLog: true }, null, 2) + "\n");
  console.log(`sent (from log) ${CELO_CHAIN.explorerTx}${log.transactionHash}`);
  process.exit(0);
}
if (state !== "open") throw new Error(`week ${week} is ${state} with no sent file: look by hand`);
if (!existsSync(planFile)) throw new Error(`no plan ${planFile}: run without --send first`);
const saved = readJson<{ inputSha256: string; root: string }>(planFile);
if (saved.inputSha256 !== r.inputSha256 || saved.root !== r.root) throw new Error("input changed since the plan; plan again");
if (gas === null) throw new Error(quoteNote ?? "no gas estimate");
const quoted = await client.estimateFeesPerGas();
const fees = anchorFees(
  { label: CELO_CHAIN.label, anchorMaxGas: CELO_CHAIN.recordMaxGas, anchorMaxFeeWei: CELO_CHAIN.recordMaxFeeWei },
  gas,
  { maxFeePerGas: quoted.maxFeePerGas, maxPriorityFeePerGas: quoted.maxPriorityFeePerGas },
  await client.getBalance({ address: poster }),
);
console.log(`record limits: gas ${fees.gas}, maxFeePerGas ${fees.maxFeePerGas}, bound ${formatEther(fees.boundWei)} ${CELO_CHAIN.nativeSymbol}`);
const account = loadRootsPoster();
const fromBlock = (await client.getBlockNumber()).toString();
const sending: CeloSentWeek = { lane: "celo", week, root: r.root, n: r.n, status: "sending", registry, fromBlock, leaves: r.leaves };
writePrivate(sentFile, JSON.stringify({ ...sending, at: new Date().toISOString() }, null, 2) + "\n");
const wallet = createWalletClient({ account, transport: http(rpc) });
const hash = await wallet.sendTransaction({
  chain: null,
  to: tx.to,
  value: 0n,
  data: tx.data,
  gas: fees.gas,
  maxFeePerGas: fees.maxFeePerGas,
  maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
});
writePrivate(sentFile, JSON.stringify({ ...sending, hash, at: new Date().toISOString() }, null, 2) + "\n");
const rc = await client.waitForTransactionReceipt({ hash });
// Read at the receipt's block and retry: a load balanced RPC can answer from a node that has not seen the block yet.
async function readBack(): Promise<string | null> {
  if (rc.status !== "success") return null;
  for (let i = 0; i < 6; i++) {
    const v = await client.readContract({ address: registry, abi: deliveryRootsReadAbi, functionName: "rootOf", args: [dayN], blockNumber: rc.blockNumber }).catch(() => null);
    if (v && /[1-9a-f]/i.test(v.slice(2))) return v;
    await new Promise((res) => setTimeout(res, 5000));
  }
  return null;
}
const back = await readBack();
const ok = back !== null && back.toLowerCase() === r.root.toLowerCase();
writePrivate(sentFile, JSON.stringify({ ...sending, status: ok ? "sent" : "failed", hash, block: rc.blockNumber.toString(), at: new Date().toISOString() }, null, 2) + "\n");
console.log(`${ok ? "sent" : "FAILED"} ${CELO_CHAIN.explorerTx}${hash}`);
process.exit(ok ? 0 : 1);
