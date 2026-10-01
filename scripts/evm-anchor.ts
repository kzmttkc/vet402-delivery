/**
 * Write a lane's daily purchase root into DeliveryRoots on its chain (src/evm/roots.ts, src/evm/evm-anchor.ts).
 *
 *   npx tsx scripts/evm-anchor.ts --lane robinhood --day 2026-09-30            plan: leaves, root, record() tx, eth_estimateGas
 *   npx tsx scripts/evm-anchor.ts --lane arbitrum --sample 70                  quote only, a made-up root of 70 leaves
 *   npx tsx scripts/evm-anchor.ts --lane arbitrum --open-days --data data      closed days with purchases not written or not published
 *   VET402_ANCHOR_SEND=<lane> npx tsx scripts/evm-anchor.ts --lane <lane> --day <day> --send
 *
 * The leaves are public records (src/evm/roots.ts publicLeaf) made from the lane's merged reading of each purchase
 * (results/evm/<lane>-purchases.jsonl, -reverify.jsonl, -chaincheck.jsonl, as scripts/evm-publish.ts reads them),
 * not from the lines themselves, so anyone can rebuild them from data/evm/roots/<lane>.json. A day with a sent
 * purchase the chain check has not decided is refused: run scripts/evm-chaincheck.ts first. Each line's salt is kept in results/evm/anchors/<lane>-<day>.salts.json, and
 * the plan in <lane>-<day>.plan.json. Before DeliveryRoots is deployed the record() gas is quoted with the
 * contract's code put at its address by a state override (eth_estimateGas only).
 *
 * --send is signed by the DeliveryRoots key (.keys/evm-roots-poster.json), never the payer wallet. It refuses
 * when: the contract at ROOTS_REGISTRY is not DeliveryRoots with that key as writer, the plan is missing or its
 * root or input differs from now, the day already holds another root, or the gas, the fee bound or the key's ETH
 * is out of bounds (src/evm/roots.ts caps). It writes <lane>-<day>.sent.json ("sending", with the leaves) before
 * it sends, sends once, reads rootOf(day) back and marks it "sent". A day already "sent" is not sent again. A
 * "sending" day whose root is on chain is completed from the RootRecorded log; otherwise it is left to a person.
 * Exit 4: the day on chain holds another root, or the code at the registry is not DeliveryRoots(writer).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, createWalletClient, formatEther, http, keccak256, stringToBytes, type Hex, type PublicClient } from "viem";
import { buildTree } from "../src/receipt/merkle.js";
import { EVM_CHAINS, LANES } from "../src/evm/chains.js";
import { anchorFees, assertAnchorOnly, buildAnchorTx, dayNumber, type DayRoot } from "../src/evm/evm-anchor.js";
import { loadRootsPoster, ROOTS_POSTER_ADDRESS } from "../src/evm/key.js";
import { deliveryRootsReadAbi, lanesDayRoot, laneReadings, openRootDays, purchaseDays, registryCodeProblem, ROOTS_DEPLOYMENTS, runtimeWithWriter, type RootsFile, type RootsLane, type Salts, type SentDay } from "../src/evm/roots.js";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const laneId = arg("--lane");
if (laneId !== "robinhood" && laneId !== "arbitrum") throw new Error("--lane robinhood | arbitrum");
const lane = laneId as RootsLane;
const spec = EVM_CHAINS[LANES[lane].chain];
const dep = ROOTS_DEPLOYMENTS[lane];
const send = argv.includes("--send");
if (send && process.env.VET402_ANCHOR_SEND !== lane) throw new Error(`--send also needs VET402_ANCHOR_SEND=${lane}`);
const DEFAULT_ANCHORS = "results/evm/anchors";
const anchorsDir = arg("--anchors-dir") ?? DEFAULT_ANCHORS;
if (send && resolve(anchorsDir) !== resolve(DEFAULT_ANCHORS)) throw new Error(`--send only uses ${DEFAULT_ANCHORS}`);
const resultsDir = arg("--results-dir") ?? "results/evm";
if (send && arg("--results-dir")) throw new Error("--send only reads results/evm");
const readLines = (): string[] =>
  laneReadings(
    lane,
    ["purchases", "reverify", "chaincheck"].map((k) => `${resultsDir}/${lane}-${k}.jsonl`).map((f) => (existsSync(f) ? readFileSync(f, "utf8") : "")),
  );
const sentFileOf = (day: string) => `${anchorsDir}/${lane}-${day}.sent.json`;
/** Plan, salts and sent files hold the salts: owner-only, also when the file already existed. */
const writePrivate = (f: string, text: string): void => {
  writeFileSync(f, text, { mode: 0o600 });
  chmodSync(f, 0o600);
};
const readJson = <T>(f: string): T => JSON.parse(readFileSync(f, "utf8")) as T;

// ---- days that wait (no network) ----
if (argv.includes("--open-days")) {
  const today = new Date(Number(process.env.VET402_DAILY_NOW ?? Date.now() / 1000) * 1000).toISOString().slice(0, 10);
  const pub = `${arg("--data") ?? "data"}/evm/roots/${lane}.json`;
  const published = new Set(existsSync(pub) ? readJson<RootsFile>(pub).days.map((d) => d.day) : []);
  const status = (d: string) => (existsSync(sentFileOf(d)) ? (readJson<{ status?: string }>(sentFileOf(d)).status ?? null) : null);
  for (const d of openRootDays(purchaseDays(readLines(), today), status, published)) console.log(d);
  process.exit(0);
}

const poster = ROOTS_POSTER_ADDRESS;
const registry = dep.registry;
const rpc = process.env[spec.rpcEnv] ?? spec.rpc;
const client = createPublicClient({ transport: http(rpc) }) as PublicClient;
if ((await client.getChainId()) !== spec.chainId) throw new Error("RPC chainId mismatch");

const sample = arg("--sample");
let r: DayRoot;
let salts: Salts | null = null;
const saltsFile = (day: string) => `${anchorsDir}/${lane}-${day}.salts.json`;
if (sample) {
  if (send) throw new Error("--sample is for a quote only");
  const n = Number(sample);
  const digests = Array.from({ length: n }, (_, i) => keccak256(stringToBytes(`sample-${i}`)));
  const t = buildTree(digests);
  const y = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  r = { chain: spec.caip2, day: y, n, root: t.root, digests, proofs: t.proofs, leaves: [], lines: [], inputSha256: "sample" };
} else {
  const day = arg("--day");
  if (!day) throw new Error("--day YYYY-MM-DD");
  const kept: Salts = existsSync(saltsFile(day)) ? readJson<Salts>(saltsFile(day)) : {};
  const made = lanesDayRoot(lane, day, readLines(), new Date().toISOString(), kept);
  r = made.root;
  salts = made.salts;
}

const tx = buildAnchorTx(r, poster, registry);
assertAnchorOnly(tx, r, registry);
const code = await client.getCode({ address: registry });
const codeProblem = registryCodeProblem(code, poster);
const deployed = code !== undefined && code !== "0x";
const zero = `0x${"0".repeat(64)}` as Hex;
const onChain = deployed && !codeProblem ? await client.readContract({ address: registry, abi: deliveryRootsReadAbi, functionName: "rootOf", args: [dayNumber(r.day)] }) : null;
const state = !deployed ? "not_deployed" : codeProblem ? "not_delivery_roots" : onChain === zero ? "open" : onChain!.toLowerCase() === r.root.toLowerCase() ? "already_on_chain" : "other_root_on_chain";

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
    if (state === "not_deployed") quoteNote = "quoted with the contract's code put at its address (state override): DeliveryRoots is not deployed yet";
  } catch (e) {
    quoteNote = `eth_estimateGas failed: ${(e as Error).message.split("\n")[0]}`;
  }
}
const gasPrice = await client.getGasPrice();
const plan = {
  lane,
  chain: spec.caip2,
  day: r.day,
  dayNumber: dayNumber(r.day),
  n: r.n,
  root: r.root,
  inputSha256: r.inputSha256,
  registry,
  writer: poster,
  state,
  tx: { to: tx.to, from: tx.from, value: "0", data: tx.data },
  quote: gas === null ? null : { gas: gas.toString(), gasPriceWei: gasPrice.toString(), feeEth: formatEther(gas * gasPrice), boundCapEth: formatEther(dep.recordMaxFeeWei) },
  quoteNote,
  sample: !!sample,
};
console.log(JSON.stringify(plan, null, 2));
if (state === "other_root_on_chain" || state === "not_delivery_roots") {
  console.error(state === "other_root_on_chain" ? `day ${r.day} on chain holds ${onChain}, not ${r.root}` : codeProblem);
  process.exit(4);
}
if (sample) process.exit(0);

mkdirSync(anchorsDir, { recursive: true });
const planFile = `${anchorsDir}/${lane}-${r.day}.plan.json`;
const sentFile = sentFileOf(r.day);
if (!send) {
  // The salts first: a root is shown only once the salts that make it are kept.
  writePrivate(saltsFile(r.day), JSON.stringify(salts, null, 2) + "\n");
  writePrivate(planFile, JSON.stringify({ ...plan, leaves: r.leaves, digests: r.digests, proofs: r.proofs }, null, 2) + "\n");
  process.exit(0);
}

// ---- send: every refusal before the key is read ----
if (state === "not_deployed") throw new Error(`DeliveryRoots is not deployed at ${registry} on ${spec.label}: scripts/evm-roots-deploy.ts --chain ${lane} first`);
if (existsSync(sentFile)) {
  const s = readJson<SentDay>(sentFile);
  if (s.status === "sent") {
    console.log(`${sentFile}: already sent (${s.hash})`);
    process.exit(0);
  }
  if (s.status !== "sending" || state !== "already_on_chain" || s.root.toLowerCase() !== r.root.toLowerCase()) throw new Error(`${sentFile} is "${s.status}" and the day on chain is ${state}: look by hand (the transaction may still be pending)`);
  // Sent before, the receipt not recorded: the RootRecorded log names the transaction. Read from the block the
  // sending file noted just before the send (or, for an older file, the deployment's block), never from block 0.
  const deployFile = `${anchorsDir}/deploy-${lane}.json`;
  const deployBlock = existsSync(deployFile) ? readJson<{ block?: string }>(deployFile).block : undefined;
  const from = s.fromBlock ?? deployBlock;
  if (!from || !/^\d+$/.test(from)) throw new Error(`${sentFile} names no block to read the log from, and ${deployFile} has none: look by hand`);
  const logs = await client.getContractEvents({ address: registry, abi: deliveryRootsReadAbi, eventName: "RootRecorded", args: { day: dayNumber(r.day) }, fromBlock: BigInt(from), strict: true });
  const log = logs.find((l) => l.args.root?.toLowerCase() === r.root.toLowerCase());
  if (!log?.transactionHash) throw new Error(`the root is on chain but no RootRecorded log was found for ${r.day}: look by hand`);
  writePrivate(sentFile, JSON.stringify({ ...s, status: "sent", hash: log.transactionHash, block: log.blockNumber?.toString() ?? null, readBack: true, completedFromLog: true }, null, 2) + "\n");
  console.log(`sent (completed from the log) ${spec.explorerTx}${log.transactionHash}`);
  process.exit(0);
}
if (state !== "open") throw new Error(`day ${r.day} is ${state} with no sent file: look by hand`);
if (!existsSync(planFile)) throw new Error(`no plan ${planFile}: run without --send first`);
const saved = readJson<{ inputSha256: string; root: string }>(planFile);
if (saved.inputSha256 !== r.inputSha256 || saved.root !== r.root) throw new Error("the input or the rules changed since the plan; plan again and look at the difference");
if (gas === null) throw new Error(quoteNote ?? "no gas estimate");
const quoted = await client.estimateFeesPerGas();
const fees = anchorFees({ label: spec.label, anchorMaxGas: dep.recordMaxGas, anchorMaxFeeWei: dep.recordMaxFeeWei }, gas, { maxFeePerGas: quoted.maxFeePerGas, maxPriorityFeePerGas: quoted.maxPriorityFeePerGas }, await client.getBalance({ address: poster }));
console.log(`record limits: gas ${fees.gas}, maxFeePerGas ${fees.maxFeePerGas}, bound ${formatEther(fees.boundWei)} ETH (cap ${formatEther(dep.recordMaxFeeWei)})`);
const account = loadRootsPoster();
// The transaction lands at or after this block: where an interrupted send's log is looked for.
const fromBlock = (await client.getBlockNumber()).toString();
const sending: SentDay = { lane, day: r.day, root: r.root, n: r.n, status: "sending", registry, fromBlock, leaves: r.leaves as SentDay["leaves"] };
writePrivate(sentFile, JSON.stringify({ ...sending, at: new Date().toISOString() }, null, 2) + "\n");
const wallet = createWalletClient({ account, transport: http(rpc) });
const hash = await wallet.sendTransaction({ chain: null, to: tx.to, value: 0n, data: tx.data, gas: fees.gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
writePrivate(sentFile, JSON.stringify({ ...sending, hash, at: new Date().toISOString() }, null, 2) + "\n");
const rc = await client.waitForTransactionReceipt({ hash });
const back = rc.status === "success" ? await client.readContract({ address: registry, abi: deliveryRootsReadAbi, functionName: "rootOf", args: [dayNumber(r.day)] }) : null;
const ok = back !== null && back.toLowerCase() === r.root.toLowerCase();
writePrivate(sentFile, JSON.stringify({ ...sending, status: ok ? "sent" : "failed", hash, block: rc.blockNumber.toString(), readBack: ok, at: new Date().toISOString() }, null, 2) + "\n");
console.log(`${ok ? "sent" : "FAILED"} ${spec.explorerTx}${hash}`);
process.exit(ok ? 0 : 1);
