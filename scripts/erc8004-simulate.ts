/**
 * ERC-8004 giveFeedback: encode + eth_call + eth_estimateGas on Ethereum L1 and Base mainnet. Never sends.
 *
 * Usage: npx tsx scripts/erc8004-simulate.ts [--out results/erc8004-simulate.json]
 * Env (optional): ETH_RPC_URL, BASE_RPC_URL, BASE_RECEIPT_RPC_URL, EVM_PUB_PATH
 *
 * The submitter is the PUBLIC address in .keys/evm.pub. .keys/evm.json (the private key) is never opened.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, formatEther, getAddress, http, type Address, type Hex, type PublicClient } from "viem";
import { base, mainnet } from "viem/chains";
import {
  BASE_USDC,
  buildGiveFeedbackArgs,
  CHAINS,
  preflight,
  readUsdcTransfer,
  simulateGiveFeedback,
  verifyDataUri,
  type ChainKey,
  type FeedbackInput,
  type Vet402Purchase,
} from "../src/evm/erc8004.js";

const KEY_PUB = process.env.EVM_PUB_PATH ?? new URL("../../vet402-solana/.keys/evm.pub", import.meta.url);
const outIdx = process.argv.indexOf("--out");
const outPath = outIdx >= 0 ? process.argv[outIdx + 1] : undefined;

const from = getAddress(readFileSync(KEY_PUB, "utf8").trim()) as Address;

const clients: Record<ChainKey, PublicClient> = {
  ethereum: createPublicClient({ chain: mainnet, transport: http(process.env.ETH_RPC_URL ?? "https://ethereum-rpc.publicnode.com") }) as PublicClient,
  base: createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL ?? "https://base-rpc.publicnode.com") }) as PublicClient,
};

/**
 * The purchase: vet402's own L1 purchase of an agent402.tools endpoint on Base
 * (vet402.com/api/v1/observatory/export.csv row 2026-09-22T06:01:07Z, status settled, HTTP 200, l2 match).
 * fromAddress is filled from the receipt, not typed in.
 */
const PURCHASE_TX = "0xdd04604154ed4d93d359026c70cd16133e537ad079462fd6c7aca4428eb31693" as Hex;
const SELLER_PAYTO = getAddress("0xabf4fabd7c416fb67202e5f9002389fc75e2a9d0");
const purchaseBase: Omit<Vet402Purchase, "fromAddress"> = {
  resource: "https://agent402.tools/api/skill/schema-guard",
  network: "eip155:8453",
  txHash: PURCHASE_TX,
  toAddress: SELLER_PAYTO,
  amountUnits: "4000",
  attemptedAt: "2026-09-22T06:01:07Z",
  httpStatusPaid: 200,
  l2Schema: "match",
  evidenceUrl: "https://vet402.com/api/v1/observatory/export.csv?days=30",
};

/**
 * Targets. Base 94639 = "Agent402"; its agentWallet equals the payTo above (8004scan account lookup, then
 * re-read on chain in preflight). Ethereum 46981 = "minia2a": no L1 agent was found for a seller vet402 has
 * a delivery from, so this one only measures gas; preflight reports sellerBinding "none" and the plan says
 * not to write it for real.
 */
const TARGETS: { chain: ChainKey; agentId: bigint; note: string }[] = [
  { chain: "base", agentId: 94639n, note: "Agent402 (agentWallet = payTo of the purchase)" },
  { chain: "ethereum", agentId: 46981n, note: "minia2a (gas measurement only; not bound to this purchase)" },
];

// publicnode refuses receipts older than its window without a token; the Base public RPC serves them.
const receiptClient = createPublicClient({ chain: base, transport: http(process.env.BASE_RECEIPT_RPC_URL ?? "https://mainnet.base.org") }) as PublicClient;
const proof = await readUsdcTransfer(receiptClient, PURCHASE_TX, { to: SELLER_PAYTO, amountUnits: purchaseBase.amountUnits, asset: BASE_USDC });
if (!proof.ok || !proof.from) throw new Error(`purchase tx does not prove the payment: ${proof.reason}`);
const purchase: Vet402Purchase = { ...purchaseBase, fromAddress: proof.from };

const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const results = [];
for (const t of TARGETS) {
  const input: FeedbackInput = { chain: t.chain, agentId: t.agentId, clientAddress: from, purchase, delivered: true, createdAt };
  const { args, file, fileBytes } = buildGiveFeedbackArgs(input);
  const roundTrip = verifyDataUri(args.feedbackURI, args.feedbackHash);
  const pf = await preflight(clients[t.chain], input);
  const sim = await simulateGiveFeedback(clients[t.chain], input, args);
  const writable = sim.simulateOk && pf.sellerBinding !== "none" && pf.clientIsOwnerOrOperator === false && pf.identityRegistryMatches;
  results.push({
    target: { ...t, agentId: t.agentId.toString() },
    registry: { reputation: CHAINS[t.chain].reputationRegistry, identity: CHAINS[t.chain].identityRegistry },
    preflight: { ...pf, lastIndexBefore: pf.lastIndexBefore.toString() },
    feedbackFile: file,
    feedbackFileBytes: fileBytes.length,
    feedbackUriRoundTrip: roundTrip.ok,
    simulate: {
      ...sim,
      calldata: `${sim.calldata.slice(0, 74)}... (${sim.calldataBytes} bytes)`,
      gas: sim.gas?.toString() ?? null,
      maxFeePerGas: sim.maxFeePerGas?.toString() ?? null,
      gasPrice: sim.gasPrice?.toString() ?? null,
      costWeiAtGasPrice: sim.costWeiAtGasPrice?.toString() ?? null,
      costEthAtGasPrice: sim.costWeiAtGasPrice !== null ? formatEther(sim.costWeiAtGasPrice) : null,
      costWeiAtMaxFee: sim.costWeiAtMaxFee?.toString() ?? null,
      costEthAtMaxFee: sim.costWeiAtMaxFee !== null ? formatEther(sim.costWeiAtMaxFee) : null,
      l1DataFeeWei: sim.l1DataFeeWei?.toString() ?? null,
      fromBalanceWei: sim.fromBalanceWei.toString(),
      blockNumber: sim.blockNumber.toString(),
    },
    plan: writable ? "writable after funding (not sent)" : "do not write for real (see preflight.sellerBinding / simulate)",
  });
}

const out = {
  generatedAt: createdAt,
  sent: false,
  submitter: from,
  submitterSource: ".keys/evm.pub (public address only; the private key file is never opened)",
  purchaseProof: { tx: PURCHASE_TX, chain: "eip155:8453", from: proof.from, to: proof.to, value: proof.value?.toString(), blockNumber: proof.blockNumber?.toString() },
  results,
};
const json = JSON.stringify(out, null, 2);
if (outPath) writeFileSync(outPath, json + "\n");
console.log(json);
