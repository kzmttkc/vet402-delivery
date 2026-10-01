/**
 * Deploy DeliveryRoots (contracts/src/DeliveryRoots.sol) on Arbitrum One or Robinhood Chain, writer = the
 * DeliveryRoots key (src/evm/key.ts ROOTS_POSTER_ADDRESS). Simulates by default.
 *
 *   npx tsx scripts/evm-roots-deploy.ts --chain arbitrum                                simulate: eth_call, eth_estimateGas, fee
 *   VET402_ROOTS_DEPLOY=arbitrum npx tsx scripts/evm-roots-deploy.ts --chain arbitrum --send
 *
 * Simulation: the creation code (src/evm/delivery-roots-artifact.ts) run by eth_call from the key must return
 * exactly the runtime code DeliveryRoots(writer) should have; eth_estimateGas; the fee at the current price.
 * --send refuses, before the key is read, when: the key's nonce is not 0 (the contract would not land at
 * ROOTS_REGISTRY, the same address on both chains), code is already there, the gas or the fee bound is over the
 * cap in src/evm/roots.ts, or the key's ETH does not cover the bound. It writes
 * results/evm/anchors/deploy-<chain>.json ("sending") before it sends, sends once, and after the receipt reads
 * the code and writer() back ("deployed"). A deployed chain is reported and nothing is sent.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, formatEther, http, isAddressEqual, type PublicClient } from "viem";
import { EVM_CHAINS } from "../src/evm/chains.js";
import { anchorFees } from "../src/evm/evm-anchor.js";
import { loadRootsPoster, ROOTS_POSTER_ADDRESS } from "../src/evm/key.js";
import { deliveryRootsReadAbi, deployData, expectedRegistry, registryCodeProblem, ROOTS_DEPLOYMENTS, ROOTS_REGISTRY, runtimeWithWriter, type RootsLane } from "../src/evm/roots.js";

const argv = process.argv.slice(2);
const chainArg = argv[argv.indexOf("--chain") + 1];
if (chainArg !== "arbitrum" && chainArg !== "robinhood") throw new Error("--chain arbitrum | robinhood");
const lane = chainArg as RootsLane;
const send = argv.includes("--send");
if (send && process.env.VET402_ROOTS_DEPLOY !== lane) throw new Error(`--send also needs VET402_ROOTS_DEPLOY=${lane}`);
const dep = ROOTS_DEPLOYMENTS[lane];
const spec = EVM_CHAINS[dep.chain];
const writer = ROOTS_POSTER_ADDRESS;
if (!isAddressEqual(expectedRegistry(writer), ROOTS_REGISTRY)) throw new Error("ROOTS_REGISTRY is not the key's nonce-0 address");
const rpc = process.env[spec.rpcEnv] ?? spec.rpc;
const client = createPublicClient({ transport: http(rpc) }) as PublicClient;
if ((await client.getChainId()) !== spec.chainId) throw new Error("RPC chainId mismatch");

const data = deployData(writer);
const [code, nonce, balance] = await Promise.all([client.getCode({ address: ROOTS_REGISTRY }), client.getTransactionCount({ address: writer, blockTag: "pending" }), client.getBalance({ address: writer })]);
if (code && code !== "0x") {
  const problem = registryCodeProblem(code, writer);
  const w = problem ? null : await client.readContract({ address: ROOTS_REGISTRY, abi: deliveryRootsReadAbi, functionName: "writer" });
  console.log(JSON.stringify({ chain: spec.caip2, registry: ROOTS_REGISTRY, deployed: true, problem, writer: w }, null, 2));
  process.exit(problem ? 4 : 0);
}

// eth_call of the creation code returns the runtime code it would leave.
const sim = await client.call({ account: writer, data });
const runtimeOk = (sim.data ?? "0x").toLowerCase() === runtimeWithWriter(writer).toLowerCase();
const gasEstimate = await client.estimateGas({ account: writer, data });
const fees = await client.estimateFeesPerGas();
const gasPrice = await client.getGasPrice();
const plan = {
  chain: spec.caip2,
  registry: ROOTS_REGISTRY,
  writer,
  nonce,
  runtimeMatchesArtifact: runtimeOk,
  gasEstimate: gasEstimate.toString(),
  gasPriceWei: gasPrice.toString(),
  feeAtGasPriceEth: formatEther(gasEstimate * gasPrice),
  maxFeePerGasWei: fees.maxFeePerGas.toString(),
  boundEth: formatEther(((gasEstimate * 125n + 99n) / 100n) * fees.maxFeePerGas),
  capEth: formatEther(dep.deployMaxFeeWei),
  balanceEth: formatEther(balance),
};
console.log(JSON.stringify(plan, null, 2));
if (!runtimeOk) throw new Error("the simulated deployment does not leave the artifact's runtime code");
if (nonce !== 0) throw new Error(`the key's nonce on ${spec.label} is ${nonce}, not 0: the contract would not land at ${ROOTS_REGISTRY}`);
if (!send) process.exit(0);

// ---- send: every refusal before the key is read ----
mkdirSync("results/evm/anchors", { recursive: true });
const out = `results/evm/anchors/deploy-${lane}.json`;
if (existsSync(out)) throw new Error(`${out} exists (${(JSON.parse(readFileSync(out, "utf8")) as { status?: string }).status}): look before sending again`);
const limits = anchorFees({ label: spec.label, anchorMaxGas: dep.deployMaxGas, anchorMaxFeeWei: dep.deployMaxFeeWei }, gasEstimate, { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }, balance);
console.log(`deploy limits: gas ${limits.gas}, maxFeePerGas ${limits.maxFeePerGas}, bound ${formatEther(limits.boundWei)} ETH (cap ${formatEther(dep.deployMaxFeeWei)})`);
const account = loadRootsPoster();
writeFileSync(out, JSON.stringify({ ...plan, status: "sending", at: new Date().toISOString() }, null, 2) + "\n");
const wallet = createWalletClient({ account, transport: http(rpc) });
const hash = await wallet.sendTransaction({ chain: null, data, value: 0n, nonce: 0, gas: limits.gas, maxFeePerGas: limits.maxFeePerGas, maxPriorityFeePerGas: limits.maxPriorityFeePerGas });
writeFileSync(out, JSON.stringify({ ...plan, status: "sent", hash, at: new Date().toISOString() }, null, 2) + "\n");
const rc = await client.waitForTransactionReceipt({ hash });
const after = await client.getCode({ address: ROOTS_REGISTRY });
const problem = rc.status !== "success" ? `receipt ${rc.status}` : rc.contractAddress && !isAddressEqual(rc.contractAddress, ROOTS_REGISTRY) ? `landed at ${rc.contractAddress}` : registryCodeProblem(after, writer);
const w = problem ? null : await client.readContract({ address: ROOTS_REGISTRY, abi: deliveryRootsReadAbi, functionName: "writer" });
const ok = !problem && w !== null && isAddressEqual(w, writer);
writeFileSync(out, JSON.stringify({ ...plan, status: ok ? "deployed" : "failed", problem, hash, block: rc.blockNumber.toString(), gasUsed: rc.gasUsed.toString(), at: new Date().toISOString() }, null, 2) + "\n");
console.log(`${ok ? "deployed" : `FAILED: ${problem}`} ${spec.explorerTx}${hash}`);
process.exit(ok ? 0 : 1);
