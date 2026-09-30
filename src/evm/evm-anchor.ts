/**
 * The daily root of an EVM lane's purchase records, written once per closed UTC day on the chain the lane
 * bought on (Robinhood Chain, Arbitrum One).
 *
 *   digest = keccak256(utf8(canonical JSON of one record))      (keys sorted, no whitespace)
 *   root   = the Merkle root of src/receipt/merkle.ts over the day's digests in file order
 *            (leaf = keccak256(0x00 || digest), node = keccak256(0x01 || min || max))
 *
 * Two ways to write it, both one transaction from the payer wallet:
 *   calldata   a 0-value transaction to the payer itself whose data is the text
 *              "vet402-purchases/v0 chain=<caip2> day=<day> root=<root> n=<n>". Cheapest: no contract.
 *   registry   DeliveryRoots.record(day, root, n) on a deployed contracts/DeliveryRoots.sol, which then
 *              answers verify(day, digest, proof) for any other contract.
 * This module builds and checks the transaction and asks the RPC for eth_estimateGas. It never signs and
 * never sends.
 */
import { createHash } from "node:crypto";
import { encodeFunctionData, isAddressEqual, keccak256, parseAbi, stringToBytes, stringToHex, type Address, type Hex, type PublicClient } from "viem";
import { buildTree } from "../receipt/merkle.js";
import type { EvmChainSpec } from "./chains.js";

export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export function recordDigest(record: unknown): Hex {
  return keccak256(stringToBytes(canonicalJson(record)));
}

export interface DayRoot {
  chain: string;
  day: string;
  n: number;
  root: Hex;
  digests: Hex[];
  proofs: Hex[][];
  /** sha256 of the exact input lines used, so a later run can refuse a changed input. */
  inputSha256: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Records of one UTC day (by `at`) that sent a payment. Refuses an open day: the day must be over in UTC. */
export function dayRoot(spec: EvmChainSpec, day: string, lines: string[], nowIso: string = new Date().toISOString()): DayRoot {
  if (!DAY.test(day)) throw new Error(`day ${day} is not YYYY-MM-DD`);
  if (day >= nowIso.slice(0, 10)) throw new Error(`day ${day} is not over in UTC (now ${nowIso}); anchor only a closed day`);
  const picked: string[] = [];
  const records: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as { at?: string; outcome?: string };
    if (typeof r.at !== "string" || r.at.slice(0, 10) !== day || r.outcome !== "sent") continue;
    picked.push(line);
    records.push(r);
  }
  if (records.length === 0) throw new Error(`no sent purchase on ${day}`);
  const digests = records.map(recordDigest);
  const tree = buildTree(digests);
  return {
    chain: spec.caip2,
    day,
    n: records.length,
    root: tree.root,
    digests,
    proofs: tree.proofs,
    inputSha256: createHash("sha256").update(picked.join("\n")).digest("hex"),
  };
}

export function anchorText(r: Pick<DayRoot, "chain" | "day" | "root" | "n">): string {
  return `vet402-purchases/v0 chain=${r.chain} day=${r.day} root=${r.root} n=${r.n}`;
}

export function parseAnchorText(s: string): { chain: string; day: string; root: Hex; n: number } | null {
  const m = /^vet402-purchases\/v0 chain=(eip155:\d+) day=(\d{4}-\d{2}-\d{2}) root=(0x[0-9a-f]{64}) n=(\d+)$/.exec(s);
  return m ? { chain: m[1]!, day: m[2]!, root: m[3] as Hex, n: Number(m[4]) } : null;
}

export const deliveryRootsAbi = parseAbi([
  "function record(uint32 day, bytes32 root, uint32 n)",
  "function verify(uint32 day, bytes32 digest, bytes32[] proof) view returns (bool)",
  "function rootOf(uint32 day) view returns (bytes32)",
]);

/** Days since 1970-01-01 (UTC), the registry's day key. */
export function dayNumber(day: string): number {
  if (!DAY.test(day)) throw new Error(`day ${day}`);
  return Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

export interface AnchorTx {
  mode: "calldata" | "registry";
  from: Address;
  to: Address;
  value: 0n;
  data: Hex;
}

export function buildAnchorTx(r: DayRoot, from: Address, registry?: Address): AnchorTx {
  if (registry) {
    return { mode: "registry", from, to: registry, value: 0n, data: encodeFunctionData({ abi: deliveryRootsAbi, functionName: "record", args: [dayNumber(r.day), r.root, r.n] }) };
  }
  return { mode: "calldata", from, to: from, value: 0n, data: stringToHex(anchorText(r)) };
}

/** Refuse anything but the anchor: value 0, calldata mode to the sender itself with exactly the text, registry mode to the named contract with exactly record(day, root, n). */
export function assertAnchorOnly(tx: AnchorTx, r: DayRoot, registry?: Address): void {
  const want = buildAnchorTx(r, tx.from, registry);
  const fail = (why: string): never => {
    throw new Error(`anchor transaction refused: ${why}`);
  };
  if (tx.value !== 0n) fail("value is not 0");
  if (tx.mode !== want.mode) fail("mode");
  if (!isAddressEqual(tx.to, want.to)) fail(`to ${tx.to}`);
  if (tx.data.toLowerCase() !== want.data.toLowerCase()) fail("data differs");
}

export interface AnchorQuote {
  gas: bigint;
  /** Wei per gas the RPC quotes now (eth_gasPrice). */
  gasPriceWei: bigint;
  feeWei: bigint;
  dataBytes: number;
}

export interface AnchorFees {
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  boundWei: bigint;
}

/**
 * Pure. The limits the anchor tx is signed with: gas = estimate x 1.25, maxFeePerGas as quoted. Refuses
 * (throws) when the gas limit is over the chain's anchorMaxGas, the bound gas x maxFeePerGas is over
 * anchorMaxFeeWei, or the wallet's ETH does not cover the bound.
 */
export function anchorFees(spec: Pick<EvmChainSpec, "label" | "anchorMaxGas" | "anchorMaxFeeWei">, estimate: bigint, fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }, ethBalanceWei: bigint): AnchorFees {
  const gas = (estimate * 125n + 99n) / 100n;
  if (gas > spec.anchorMaxGas) throw new Error(`anchor refused: gas ${gas} > ${spec.anchorMaxGas} on ${spec.label}`);
  const boundWei = gas * fees.maxFeePerGas;
  if (boundWei > spec.anchorMaxFeeWei) throw new Error(`anchor refused: fee bound ${boundWei} wei > ${spec.anchorMaxFeeWei} on ${spec.label}`);
  if (ethBalanceWei < boundWei) throw new Error(`anchor refused: ETH ${ethBalanceWei} wei < fee bound ${boundWei} wei on ${spec.label}`);
  const prio = fees.maxPriorityFeePerGas > fees.maxFeePerGas ? fees.maxFeePerGas : fees.maxPriorityFeePerGas;
  return { gas, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: prio, boundWei };
}

/** eth_estimateGas and eth_gasPrice only. */
export async function quoteAnchor(client: Pick<PublicClient, "estimateGas" | "getGasPrice">, tx: AnchorTx): Promise<AnchorQuote> {
  const [gas, gasPriceWei] = await Promise.all([client.estimateGas({ account: tx.from, to: tx.to, value: 0n, data: tx.data }), client.getGasPrice()]);
  return { gas, gasPriceWei, feeWei: gas * gasPriceWei, dataBytes: (tx.data.length - 2) / 2 };
}
