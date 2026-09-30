/**
 * ERC-8004 reputation writer for vet402: "vet402 bought it and it was delivered", with the tx.
 *
 * SIMULATE ONLY. This module builds calldata, reads chain state, runs eth_call and eth_estimateGas.
 * It has no signer, no wallet client and no sendTransaction path. The only identity it needs is the
 * public address that would submit the feedback (read from `.keys/evm.pub`, never `.keys/evm.json`).
 *
 * Spec (primary): https://eips.ethereum.org/EIPS/eip-8004 (ethereum/ERCs ERCS/erc-8004.md, status Draft).
 * `proofOfPayment` is NOT an argument of giveFeedback. It is a field of the OPTIONAL off-chain feedback
 * file that `feedbackURI` points to; `feedbackHash` = keccak256 of that file's bytes. We therefore put the
 * payment proof in the file and commit to it on-chain through feedbackHash.
 */
import {
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  keccak256,
  parseAbi,
  stringToBytes,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";

// ---------- addresses (sources in docs/erc8004.md) ----------

/** erc-8004/erc-8004-contracts README, master @ b9e466c (2026-08-15). Same vanity address on every mainnet. */
export const ERC8004_MAINNET = {
  identityRegistry: getAddress("0x8004A169FB4a3325136EB29fA0ceB6D2e539a432"),
  reputationRegistry: getAddress("0x8004BAa17C55a88189AE136b182e5fdA19dE9b63"),
} as const;

/** Same README: Ethereum Sepolia and Base Sepolia share these. Listed for reference; this code does not write to them either. */
export const ERC8004_TESTNET = {
  identityRegistry: getAddress("0x8004A818BFB912233c491871b3d84c89A494BD9e"),
  reputationRegistry: getAddress("0x8004B663056A597Dffe9eCcC1965A193B7388713"),
} as const;

export const CHAINS = {
  ethereum: { chainId: 1, caip2: "eip155:1", ...ERC8004_MAINNET },
  base: { chainId: 8453, caip2: "eip155:8453", ...ERC8004_MAINNET },
} as const;
export type ChainKey = keyof typeof CHAINS;

/** Chains the feedback writer (src/evm/rep-run.ts) serves. Same addresses; getVersion() = "2.0.0" on both registries of each (read 2026-09-30). */
export const REP_REGISTRIES = {
  base: CHAINS.base,
  tempo: { chainId: 4217, caip2: "eip155:4217", ...ERC8004_MAINNET },
  robinhood: { chainId: 4663, caip2: "eip155:4663", ...ERC8004_MAINNET },
  arbitrum: { chainId: 42161, caip2: "eip155:42161", ...ERC8004_MAINNET },
} as const;

/** Base USDC (Circle). Used to read the Transfer log of the purchase tx. */
export const BASE_USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");

// ---------- ABI ----------

/**
 * giveFeedback / getIdentityRegistry / getLastIndex / getVersion / NewFeedback: abis/ReputationRegistry.json
 * of erc-8004-contracts @ b9e466c, matched to the EIP text. isAuthorizedOrOwner is in
 * contracts/IdentityRegistryUpgradeable.sol but missing from abis/IdentityRegistry.json at that commit,
 * so it is written here by hand and confirmed by an eth_call in scripts/erc8004-simulate.ts.
 */
export const reputationAbi = parseAbi([
  "function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
  "function getIdentityRegistry() view returns (address)",
  "function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)",
  "function getVersion() pure returns (string)",
  "event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)",
]);

export const identityAbi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function getAgentWallet(uint256 agentId) view returns (address)",
  "function isAuthorizedOrOwner(address spender, uint256 agentId) view returns (bool)",
  "function getVersion() pure returns (string)",
]);

const erc20TransferEvent = parseAbi(["event Transfer(address indexed from, address indexed to, uint256 value)"]);

// ---------- the feedback file (off-chain JSON, EIP-8004 "Off-Chain Feedback File Structure") ----------

/** One vet402 purchase, as recorded by the vet402 observatory (/api/v1/observatory/endpoints/{id}/purchases). */
export interface Vet402Purchase {
  /** The seller URL vet402 bought. */
  resource: string;
  /** Chain the purchase settled on, CAIP-2 (e.g. eip155:8453). */
  network: string;
  /** Settlement tx hash. */
  txHash: Hex;
  /** USDC sender = vet402's payer wallet. */
  fromAddress: Address;
  /** USDC receiver = the seller's payTo. */
  toAddress: Address;
  /** Atomic USDC (6 decimals). */
  amountUnits: string;
  attemptedAt: string;
  httpStatusPaid: number | null;
  /** vet402 L2 check of the response against the seller's own declared schema. */
  l2Schema: string | null;
  /** Public evidence page. */
  evidenceUrl: string;
}

export interface FeedbackInput {
  chain: ChainKey;
  agentId: bigint;
  /** Address that would call giveFeedback (vet402's feedback wallet; public address only). */
  clientAddress: Address;
  purchase: Vet402Purchase;
  /** 1 = delivered, 0 = paid but not delivered. */
  delivered: boolean;
  createdAt: string;
}

export const TAG1 = "x402Delivered";
export const TAG2 = "vet402-L1";

/** Build the feedback file. Key order is fixed so the bytes (and so feedbackHash) are reproducible. */
export function buildFeedbackFile(input: FeedbackInput): Record<string, unknown> {
  const c = CHAINS[input.chain];
  const chainIdOfPayment = input.purchase.network.startsWith("eip155:") ? input.purchase.network.slice("eip155:".length) : input.purchase.network;
  return {
    agentRegistry: `${c.caip2}:${c.identityRegistry}`,
    agentId: Number(input.agentId),
    clientAddress: `${c.caip2}:${getAddress(input.clientAddress)}`,
    createdAt: input.createdAt,
    value: input.delivered ? 1 : 0,
    valueDecimals: 0,
    tag1: TAG1,
    tag2: TAG2,
    endpoint: input.purchase.resource,
    proofOfPayment: {
      fromAddress: getAddress(input.purchase.fromAddress),
      toAddress: getAddress(input.purchase.toAddress),
      chainId: chainIdOfPayment,
      txHash: input.purchase.txHash,
    },
    vet402: {
      what: "vet402 paid this x402 endpoint with its own wallet and recorded what came back.",
      attemptedAt: input.purchase.attemptedAt,
      amountUnits: input.purchase.amountUnits,
      asset: "USDC",
      httpStatusPaid: input.purchase.httpStatusPaid,
      l2Schema: input.purchase.l2Schema,
      evidence: input.purchase.evidenceUrl,
    },
  };
}

export function feedbackFileBytes(file: Record<string, unknown>): Uint8Array {
  return stringToBytes(JSON.stringify(file));
}

/**
 * feedbackURI. Default is a self-contained data: URI, so the proof sits in the NewFeedback log itself and
 * needs no host to stay up. Pass `externalUri` to point at a hosted copy instead (hash still required,
 * because a non-content-addressed URI can change under the reader).
 */
export function feedbackUri(bytes: Uint8Array, externalUri?: string): string {
  if (externalUri) return externalUri;
  return `data:application/json;base64,${Buffer.from(bytes).toString("base64")}`;
}

export interface GiveFeedbackArgs {
  agentId: bigint;
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackURI: string;
  feedbackHash: Hex;
}

export function buildGiveFeedbackArgs(input: FeedbackInput, externalUri?: string): { args: GiveFeedbackArgs; file: Record<string, unknown>; fileBytes: Uint8Array } {
  const file = buildFeedbackFile(input);
  const fileBytes = feedbackFileBytes(file);
  return {
    file,
    fileBytes,
    args: {
      agentId: input.agentId,
      value: input.delivered ? 1n : 0n,
      valueDecimals: 0,
      tag1: TAG1,
      tag2: TAG2,
      endpoint: input.purchase.resource,
      feedbackURI: feedbackUri(fileBytes, externalUri),
      feedbackHash: keccak256(fileBytes),
    },
  };
}

export function encodeGiveFeedback(a: GiveFeedbackArgs): Hex {
  return encodeFunctionData({
    abi: reputationAbi,
    functionName: "giveFeedback",
    args: [a.agentId, a.value, a.valueDecimals, a.tag1, a.tag2, a.endpoint, a.feedbackURI, a.feedbackHash],
  });
}

/** Decode a data: feedbackURI back to the file and check it against feedbackHash (what a reader does). */
export function verifyDataUri(feedbackURI: string, feedbackHash: Hex): { ok: boolean; file?: unknown } {
  const prefix = "data:application/json;base64,";
  if (!feedbackURI.startsWith(prefix)) return { ok: false };
  const bytes = new Uint8Array(Buffer.from(feedbackURI.slice(prefix.length), "base64"));
  if (keccak256(bytes) !== feedbackHash) return { ok: false };
  return { ok: true, file: JSON.parse(Buffer.from(bytes).toString("utf8")) };
}

// ---------- on-chain proof of the purchase (read only) ----------

export interface TransferProof {
  ok: boolean;
  reason?: string;
  from?: Address;
  to?: Address;
  value?: bigint;
  blockNumber?: bigint;
}

/** Read the purchase tx receipt and find the USDC Transfer to the seller. Nothing is signed. */
export async function readUsdcTransfer(
  client: Pick<PublicClient, "getTransactionReceipt">,
  txHash: Hex,
  expect: { to: Address; amountUnits?: string; asset?: Address; from?: Address },
): Promise<TransferProof> {
  const asset = expect.asset ?? BASE_USDC;
  const r = await client.getTransactionReceipt({ hash: txHash });
  if (r.status !== "success") return { ok: false, reason: `tx_status_${r.status}` };
  if (expect.from !== undefined) {
    // Only this payer's own transfer counts: a batched settlement can carry other buyers' transfers to the same payTo.
    const mine: { from: Address; to: Address; value: bigint }[] = [];
    for (const log of r.logs) {
      if (!isAddressEqual(log.address, asset)) continue;
      try {
        const ev = decodeEventLog({ abi: erc20TransferEvent, data: log.data, topics: log.topics });
        if (isAddressEqual(ev.args.to, expect.to) && isAddressEqual(ev.args.from, expect.from)) mine.push(ev.args);
      } catch {
        /* not a Transfer */
      }
    }
    const exact = expect.amountUnits === undefined ? mine[0] : mine.find((m) => m.value === BigInt(expect.amountUnits!));
    if (exact) return { ok: true, from: exact.from, to: exact.to, value: exact.value, blockNumber: r.blockNumber };
    if (mine[0]) return { ok: false, reason: "amount_mismatch", from: mine[0].from, to: mine[0].to, value: mine[0].value, blockNumber: r.blockNumber };
    return { ok: false, reason: "no_usdc_transfer_to_seller" };
  }
  for (const log of r.logs) {
    if (!isAddressEqual(log.address, asset)) continue;
    try {
      const ev = decodeEventLog({ abi: erc20TransferEvent, data: log.data, topics: log.topics });
      if (!isAddressEqual(ev.args.to, expect.to)) continue;
      if (expect.amountUnits !== undefined && ev.args.value !== BigInt(expect.amountUnits)) {
        return { ok: false, reason: "amount_mismatch", from: ev.args.from, to: ev.args.to, value: ev.args.value, blockNumber: r.blockNumber };
      }
      return { ok: true, from: ev.args.from, to: ev.args.to, value: ev.args.value, blockNumber: r.blockNumber };
    } catch {
      /* not a Transfer */
    }
  }
  return { ok: false, reason: "no_usdc_transfer_to_seller" };
}

// ---------- pre-flight reads + simulate + estimate ----------

export interface Preflight {
  identityRegistryMatches: boolean;
  reputationVersion: string | null;
  agentOwner: Address | null;
  agentWallet: Address | null;
  /** Spec: the submitter MUST NOT be the owner or an approved operator. */
  clientIsOwnerOrOperator: boolean | null;
  /** agentWallet (or owner) equals the payTo vet402 paid: the agent really is that seller. */
  sellerBinding: "agentWallet" | "owner" | "none";
  lastIndexBefore: bigint;
}

export async function preflight(client: PublicClient, input: FeedbackInput): Promise<Preflight> {
  const c = CHAINS[input.chain];
  const [idReg, version, lastIndex] = await Promise.all([
    client.readContract({ address: c.reputationRegistry, abi: reputationAbi, functionName: "getIdentityRegistry" }),
    client.readContract({ address: c.reputationRegistry, abi: reputationAbi, functionName: "getVersion" }).catch(() => null),
    client.readContract({ address: c.reputationRegistry, abi: reputationAbi, functionName: "getLastIndex", args: [input.agentId, input.clientAddress] }),
  ]);
  let owner: Address | null = null;
  let wallet: Address | null = null;
  let authorized: boolean | null = null;
  try {
    owner = await client.readContract({ address: c.identityRegistry, abi: identityAbi, functionName: "ownerOf", args: [input.agentId] });
    wallet = await client.readContract({ address: c.identityRegistry, abi: identityAbi, functionName: "getAgentWallet", args: [input.agentId] });
    authorized = await client.readContract({ address: c.identityRegistry, abi: identityAbi, functionName: "isAuthorizedOrOwner", args: [input.clientAddress, input.agentId] });
  } catch {
    /* nonexistent agent: owner stays null */
  }
  const payTo = input.purchase.toAddress;
  const binding: Preflight["sellerBinding"] =
    wallet && !isAddressEqual(wallet, "0x0000000000000000000000000000000000000000") && isAddressEqual(wallet, payTo)
      ? "agentWallet"
      : owner && isAddressEqual(owner, payTo)
        ? "owner"
        : "none";
  return {
    identityRegistryMatches: isAddressEqual(idReg, c.identityRegistry),
    reputationVersion: version,
    agentOwner: owner,
    agentWallet: wallet,
    clientIsOwnerOrOperator: authorized,
    sellerBinding: binding,
    lastIndexBefore: lastIndex,
  };
}

export interface SimulateResult {
  chain: ChainKey;
  chainId: number;
  to: Address;
  from: Address;
  calldata: Hex;
  calldataBytes: number;
  feedbackHash: Hex;
  simulateOk: boolean;
  revertReason: string | null;
  gas: bigint | null;
  /** EIP-1559 maxFeePerGas the node suggests now. */
  maxFeePerGas: bigint | null;
  /** Current base fee + priority, i.e. what the write would likely cost now. */
  gasPrice: bigint | null;
  costWeiAtGasPrice: bigint | null;
  costWeiAtMaxFee: bigint | null;
  /** Base (OP stack) also charges an L1 data fee for the calldata; null on Ethereum. */
  l1DataFeeWei: bigint | null;
  fromBalanceWei: bigint;
  blockNumber: bigint;
}

const GAS_PRICE_ORACLE = getAddress("0x420000000000000000000000000000000000000F");
const gasOracleAbi = parseAbi(["function getL1Fee(bytes _data) view returns (uint256)"]);

/**
 * eth_call + eth_estimateGas for giveFeedback, from the public address. No signature exists anywhere,
 * so nothing here can land on chain.
 */
export async function simulateGiveFeedback(client: PublicClient, input: FeedbackInput, a: GiveFeedbackArgs): Promise<SimulateResult> {
  const c = CHAINS[input.chain];
  const data = encodeGiveFeedback(a);
  const blockNumber = await client.getBlockNumber();
  let simulateOk = false;
  let revertReason: string | null = null;
  try {
    await client.call({ account: input.clientAddress, to: c.reputationRegistry, data, blockNumber });
    simulateOk = true;
  } catch (e) {
    revertReason = shortError(e);
  }
  let gas: bigint | null = null;
  if (simulateOk) {
    try {
      gas = await client.estimateGas({ account: input.clientAddress, to: c.reputationRegistry, data, blockNumber });
    } catch (e) {
      revertReason = `estimateGas: ${shortError(e)}`;
    }
  }
  const [fees, gasPrice, balance] = await Promise.all([
    client.estimateFeesPerGas().catch(() => null),
    client.getGasPrice().catch(() => null),
    client.getBalance({ address: input.clientAddress }),
  ]);
  let l1DataFeeWei: bigint | null = null;
  if (input.chain === "base") {
    // Fee oracle wants the unsigned tx bytes; calldata plus a fixed allowance for the signed envelope.
    const approx = (data + "00".repeat(68)) as Hex;
    l1DataFeeWei = await client.readContract({ address: GAS_PRICE_ORACLE, abi: gasOracleAbi, functionName: "getL1Fee", args: [approx] }).catch(() => null);
  }
  const maxFee = fees?.maxFeePerGas ?? null;
  return {
    chain: input.chain,
    chainId: c.chainId,
    to: c.reputationRegistry,
    from: input.clientAddress,
    calldata: data,
    calldataBytes: (data.length - 2) / 2,
    feedbackHash: a.feedbackHash,
    simulateOk,
    revertReason,
    gas,
    maxFeePerGas: maxFee,
    gasPrice,
    costWeiAtGasPrice: gas !== null && gasPrice !== null ? gas * gasPrice + (l1DataFeeWei ?? 0n) : null,
    costWeiAtMaxFee: gas !== null && maxFee !== null ? gas * maxFee + (l1DataFeeWei ?? 0n) : null,
    l1DataFeeWei,
    fromBalanceWei: balance,
    blockNumber,
  };
}

function shortError(e: unknown): string {
  const m = e instanceof Error ? ((e as { shortMessage?: string }).shortMessage ?? e.message) : String(e);
  return m.split("\n")[0]!.slice(0, 300);
}
