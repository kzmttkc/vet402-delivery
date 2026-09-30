/**
 * Write a lane's daily purchase root on its chain (see src/evm/evm-anchor.ts).
 *
 *   npx tsx scripts/evm-anchor.ts --lane robinhood --day 2026-10-04            plan: root, tx, eth_estimateGas
 *   npx tsx scripts/evm-anchor.ts --lane arbitrum --sample 90                  quote only, with a made-up root of 90 leaves
 *   VET402_ANCHOR_SEND=<lane> npx tsx scripts/evm-anchor.ts --lane <lane> --day <day> --send
 *
 * Plan writes results/evm/anchors/<lane>-<day>.plan.json with the sha256 of the input lines. --send refuses
 * when that plan is missing or its hash differs from the lines now on disk, when the day is not over in UTC,
 * or when results/evm/anchors/<lane>-<day>.sent.json already exists; it writes that file ("sending") before
 * it sends, sends once and marks it "sent". --registry <address> writes DeliveryRoots.record instead of calldata.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, getAddress, http, keccak256, stringToBytes, type Address, type PublicClient } from "viem";
import { buildTree } from "../src/receipt/merkle.js";
import { EVM_CHAINS, LANES, type LaneId } from "../src/evm/chains.js";
import { anchorFees, assertAnchorOnly, buildAnchorTx, dayRoot, quoteAnchor, type DayRoot } from "../src/evm/evm-anchor.js";
import { loadEvmAccount, readPublicAddress } from "../src/evm/key.js";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const laneId = arg("--lane") as LaneId | undefined;
if (laneId !== "robinhood" && laneId !== "arbitrum") throw new Error("--lane robinhood | arbitrum");
const lane = LANES[laneId];
const spec = EVM_CHAINS[lane.chain];
const send = argv.includes("--send");
if (send && process.env.VET402_ANCHOR_SEND !== laneId) throw new Error(`--send also needs VET402_ANCHOR_SEND=${laneId}`);
const registry = arg("--registry") ? getAddress(arg("--registry")!) : undefined;
const sample = arg("--sample");
const from: Address = readPublicAddress();
const client = createPublicClient({ transport: http(process.env[spec.rpcEnv] ?? spec.rpc) }) as PublicClient;
if ((await client.getChainId()) !== spec.chainId) throw new Error("RPC chainId mismatch");

let r: DayRoot;
if (sample) {
  if (send) throw new Error("--sample is for a quote only");
  const n = Number(sample);
  const digests = Array.from({ length: n }, (_, i) => keccak256(stringToBytes(`sample-${i}`)));
  const t = buildTree(digests);
  const y = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  r = { chain: spec.caip2, day: y, n, root: t.root, digests, proofs: t.proofs, inputSha256: "sample" };
} else {
  const day = arg("--day");
  if (!day) throw new Error("--day YYYY-MM-DD");
  const input = arg("--input") ?? `results/evm/${laneId}-purchases.jsonl`;
  r = dayRoot(spec, day, readFileSync(input, "utf8").split("\n"));
}

const tx = buildAnchorTx(r, from, registry);
assertAnchorOnly(tx, r, registry);
const q = registry ? null : await quoteAnchor(client, tx);
const plan = {
  lane: laneId,
  chain: spec.caip2,
  day: r.day,
  n: r.n,
  root: r.root,
  inputSha256: r.inputSha256,
  tx: { mode: tx.mode, from: tx.from, to: tx.to, value: "0", data: tx.data },
  quote: q ? { gas: q.gas.toString(), gasPriceWei: q.gasPriceWei.toString(), feeWei: q.feeWei.toString(), dataBytes: q.dataBytes } : "registry mode: quoted after deployment",
  sample: !!sample,
};
console.log(JSON.stringify(plan, null, 2));
if (sample) process.exit(0);

mkdirSync("results/evm/anchors", { recursive: true });
const planFile = `results/evm/anchors/${laneId}-${r.day}.plan.json`;
const sentFile = `results/evm/anchors/${laneId}-${r.day}.sent.json`;
if (!send) {
  writeFileSync(planFile, JSON.stringify({ ...plan, proofs: r.proofs, digests: r.digests }, null, 2) + "\n");
  process.exit(0);
}

// ---- send: every refusal before the key is read ----
if (!existsSync(planFile)) throw new Error(`no plan ${planFile}: run without --send first`);
const saved = JSON.parse(readFileSync(planFile, "utf8")) as { inputSha256: string; root: string };
if (saved.inputSha256 !== r.inputSha256 || saved.root !== r.root) throw new Error("the input changed since the plan; plan again and look at the difference");
if (existsSync(sentFile)) throw new Error(`${sentFile} exists: this day was already sent (or is being sent)`);
// Gas and fee caps, and the wallet's ETH, before the key is read (throws when over).
const estimate = await client.estimateGas({ account: from, to: tx.to, value: 0n, data: tx.data });
const quoted = await client.estimateFeesPerGas();
const fees = anchorFees(spec, estimate, { maxFeePerGas: quoted.maxFeePerGas, maxPriorityFeePerGas: quoted.maxPriorityFeePerGas }, await client.getBalance({ address: from }));
console.log(`anchor limits: gas ${fees.gas}, maxFeePerGas ${fees.maxFeePerGas}, bound ${fees.boundWei} wei (cap ${spec.anchorMaxFeeWei})`);
const account = loadEvmAccount();
if (getAddress(account.address) !== from) throw new Error("key != evm.pub");
writeFileSync(sentFile, JSON.stringify({ ...plan, status: "sending", at: new Date().toISOString() }, null, 2) + "\n");
const wallet = createWalletClient({ account, transport: http(process.env[spec.rpcEnv] ?? spec.rpc) });
const hash = await wallet.sendTransaction({ chain: null, to: tx.to, value: 0n, data: tx.data, gas: fees.gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas });
const rc = await client.waitForTransactionReceipt({ hash });
writeFileSync(sentFile, JSON.stringify({ ...plan, status: rc.status === "success" ? "sent" : "failed", hash, block: rc.blockNumber.toString(), at: new Date().toISOString() }, null, 2) + "\n");
console.log(`${rc.status} ${spec.explorerTx}${hash}`);
