/**
 * The daily root of an EVM lane's purchases, in DeliveryRoots (contracts/src/DeliveryRoots.sol) on the chain the
 * lane bought on: one record(day, root, n) per closed UTC day with purchases, written by the DeliveryRoots key
 * (src/evm/key.ts ROOTS_POSTER_ADDRESS), never by the payer wallet.
 *
 * The leaf. A purchase line in results/evm/<lane>-purchases.jsonl holds the seller's answer and stays on the
 * runner, so the root is not taken over it. Each sent purchase becomes a public leaf record (publicLeaf): what
 * vet402 paid, to whom, the settlement tx, what came back (status, size, sha256 of the body vet402 kept, not the
 * body), the verdict of the current rules (src/evm/settle-cause.ts, the same call scripts/evm-publish.ts makes),
 * and 32 random bytes (`salt`). digest = keccak256(canonical JSON of the leaf record); the tree is
 * src/receipt/merkle.ts.
 *
 * What is published (data/evm/roots/<lane>.json). A leaf that settled and came back, or whose seller vet402 has
 * told (data/records/notified.json), is published with its record and proof. Any other leaf is a negative result
 * for a seller not told yet: only its index is published. Its leaf hash still shows up as a sibling in other
 * proofs, and the salt is what keeps that hash from being guessed back into a verdict.
 *
 * Until a day is sent, its leaves are made again from the lines on every run (a rule change reaches them); only
 * the salts are kept (results/evm/anchors/<lane>-<day>.salts.json). The leaves that were sent are kept in
 * <lane>-<day>.sent.json and are the only ones ever published for that day.
 */
import { createHash, randomBytes } from "node:crypto";
import { encodeAbiParameters, getAddress, getContractAddress, isAddressEqual, parseAbi, type Address, type Hex } from "viem";
import { buildTree, verifyInclusion } from "../receipt/merkle.js";
import { EVM_CHAINS, LANES, type EvmChainKey } from "./chains.js";
import { DELIVERY_ROOTS_ARTIFACT } from "./delivery-roots-artifact.js";
import { dayNumber, dayRoot, recordDigest, type DayRoot } from "./evm-anchor.js";
import type { ChainBuyRecord } from "./evm-buy.js";
import { ROOTS_POSTER_ADDRESS } from "./key.js";
import { classifyRecord } from "./settle-cause.js";

export type RootsLane = "robinhood" | "arbitrum";
export const ROOTS_LANES: readonly RootsLane[] = ["robinhood", "arbitrum"];

/**
 * DeliveryRoots is the DeliveryRoots key's first transaction on each chain, so its address is the same on both:
 * CREATE from that key at nonce 0. scripts/evm-roots-deploy.ts refuses to deploy at any other nonce.
 */
export const ROOTS_REGISTRY: Address = getAddress("0x84DB4733f8F9e6803Af811fD9E438aEBc0b90145");

export interface RootsDeployment {
  lane: RootsLane;
  chain: EvmChainKey;
  registry: Address;
  writer: Address;
  explorerAddress: string;
  /** record(): above this gas limit or this fee bound (gas x maxFeePerGas, wei) nothing is signed. */
  recordMaxGas: bigint;
  recordMaxFeeWei: bigint;
  /** The deployment: the same, once. */
  deployMaxGas: bigint;
  deployMaxFeeWei: bigint;
}

// 2026-10-01 eth_estimateGas: deploy 341,371 gas (Arbitrum) / 337,396 (Robinhood); record() see scripts/evm-anchor.ts --sample.
// Gas price 0.020 / 0.020 gwei. Each cap is about 10x the quote (gas x 1.25 at today's price).
export const ROOTS_DEPLOYMENTS: Record<RootsLane, RootsDeployment> = {
  arbitrum: {
    lane: "arbitrum",
    chain: "arbitrum",
    registry: ROOTS_REGISTRY,
    writer: ROOTS_POSTER_ADDRESS,
    explorerAddress: "https://arbiscan.io/address/",
    recordMaxGas: 150_000n,
    recordMaxFeeWei: 20_000_000_000_000n,
    deployMaxGas: 600_000n,
    deployMaxFeeWei: 100_000_000_000_000n,
  },
  robinhood: {
    lane: "robinhood",
    chain: "robinhood",
    registry: ROOTS_REGISTRY,
    writer: ROOTS_POSTER_ADDRESS,
    explorerAddress: "https://robinhoodchain.blockscout.com/address/",
    recordMaxGas: 150_000n,
    recordMaxFeeWei: 20_000_000_000_000n,
    deployMaxGas: 600_000n,
    deployMaxFeeWei: 100_000_000_000_000n,
  },
};

export const deliveryRootsReadAbi = parseAbi([
  "function writer() view returns (address)",
  "function rootOf(uint32 day) view returns (bytes32)",
  "function countOf(uint32 day) view returns (uint32)",
  "function verify(uint32 day, bytes32 digest, bytes32[] proof) view returns (bool)",
  "event RootRecorded(uint32 indexed day, bytes32 root, uint32 n)",
]);

// ---------- bytecode ----------

/** The creation code with the constructor argument (the writer). */
export function deployData(writer: Address): Hex {
  return (DELIVERY_ROOTS_ARTIFACT.creation + encodeAbiParameters([{ type: "address" }], [writer]).slice(2)) as Hex;
}

/** The runtime code DeliveryRoots(writer) has on chain: the artifact with `writer` written into its immutable slots. */
export function runtimeWithWriter(writer: Address): Hex {
  const word = writer.toLowerCase().slice(2).padStart(64, "0");
  let code = DELIVERY_ROOTS_ARTIFACT.runtime.slice(2).toLowerCase();
  for (const off of DELIVERY_ROOTS_ARTIFACT.writerOffsets) code = code.slice(0, off * 2) + word + code.slice(off * 2 + 64);
  return `0x${code}` as Hex;
}

/** Pure. The registry the writer's nonce-0 deployment makes, and whether it is the pinned one. */
export function expectedRegistry(writer: Address = ROOTS_POSTER_ADDRESS): Address {
  return getContractAddress({ from: writer, nonce: 0n });
}

/** Pure. Why the code at the registry is not DeliveryRoots(writer), or null. */
export function registryCodeProblem(code: Hex | undefined, writer: Address): string | null {
  if (!code || code === "0x") return "no code at the registry (not deployed)";
  if (code.toLowerCase() !== runtimeWithWriter(writer).toLowerCase()) return "the code at the registry is not DeliveryRoots with this writer";
  return null;
}

// ---------- leaves ----------

export interface PublicLeaf {
  kind: "vet402-evm-purchase";
  version: 0;
  lane: RootsLane;
  chain: string;
  at: string;
  method: string;
  resource: string;
  payer: string | null;
  payTo: string | null;
  asset: string;
  amountAtomic: string | null;
  settlementTx: string | null;
  settledOnChain: boolean | null;
  delivered: boolean;
  /** src/evm/settle-cause.ts with the rules of the run that made the leaf. */
  cause: string;
  httpStatus: number | null;
  responseBytes: number | null;
  /** 0x + sha256 of the answer body as vet402 kept it (cut at the lane's keepBodyBytes), or null. */
  bodyHash: string | null;
  /** 32 random bytes: a leaf hash that is not published cannot be guessed back into its record. */
  salt: string;
}

type LaneLine = ChainBuyRecord & { facilitator?: string | null; predictedProblem?: string | null };

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Pure. The public leaf record of one sent purchase line. */
export function publicLeaf(lane: RootsLane, r: LaneLine, salt: string): PublicLeaf {
  if (!/^0x[0-9a-f]{64}$/.test(salt)) throw new Error("salt must be 0x + 64 lowercase hex");
  const spec = EVM_CHAINS[LANES[lane].chain];
  return {
    kind: "vet402-evm-purchase",
    version: 0,
    lane,
    chain: spec.caip2,
    at: r.at,
    method: r.method,
    resource: r.resource,
    payer: r.payer ?? null,
    payTo: r.payTo ?? null,
    asset: spec.asset,
    amountAtomic: r.amountAtomic ?? null,
    settlementTx: r.settlementTx ?? null,
    settledOnChain: typeof r.settledOnChain === "boolean" ? r.settledOnChain : null,
    delivered: r.delivered === true,
    cause: classifyRecord(r, { facilitator: r.facilitator ?? null, problem: r.predictedProblem ?? null }).cause,
    httpStatus: r.response?.status ?? null,
    responseBytes: typeof r.response?.bytes === "number" ? r.response.bytes : null,
    bodyHash: typeof r.body === "string" ? `0x${sha256Hex(r.body)}` : null,
    salt,
  };
}

/** sha256 of one purchase line -> its salt. */
export type Salts = Record<string, string>;

export const newSalt = (): string => `0x${randomBytes(32).toString("hex")}`;

/**
 * The day's root over public leaves. A line that has a salt keeps it; a new line gets a new one (`salts` is
 * returned with it, to be saved before the root is used).
 */
export function lanesDayRoot(lane: RootsLane, day: string, lines: string[], nowIso: string, salts: Salts, mint: () => string = newSalt): { root: Omit<DayRoot, "leaves"> & { leaves: PublicLeaf[] }; salts: Salts } {
  const next: Salts = { ...salts };
  const root = dayRoot(EVM_CHAINS[LANES[lane].chain], day, lines, nowIso, (rec, line) => {
    const k = sha256Hex(line);
    next[k] ??= mint();
    return publicLeaf(lane, rec as LaneLine, next[k]!);
  });
  return { root: root as Omit<DayRoot, "leaves"> & { leaves: PublicLeaf[] }, salts: next };
}

/** Closed UTC days (before `today`) with at least one sent purchase, oldest first. */
export function purchaseDays(lines: string[], today: string): string[] {
  const days = new Set<string>();
  for (const l of lines) {
    if (!l.trim()) continue;
    const r = JSON.parse(l) as { at?: string; outcome?: string };
    if (r.outcome === "sent" && typeof r.at === "string" && /^\d{4}-\d{2}-\d{2}/.test(r.at) && r.at.slice(0, 10) < today) days.add(r.at.slice(0, 10));
  }
  return [...days].sort();
}

// ---------- the published file ----------

const hostOf = (u: string): string | null => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/** Pure. Published with its record: settled and came back, or a seller vet402 has told. Anything else is withheld. */
export function leafIsPublic(leaf: PublicLeaf, notified: ReadonlySet<string>): boolean {
  if (leaf.delivered && leaf.settledOnChain === true && leaf.cause === "delivered") return true;
  const host = hostOf(leaf.resource);
  return host !== null && notified.has(host);
}

/** What <lane>-<day>.sent.json keeps of a day that was written. */
export interface SentDay {
  lane: RootsLane;
  day: string;
  root: Hex;
  n: number;
  status: "sending" | "sent" | "failed";
  hash?: Hex;
  block?: string;
  registry: Address;
  leaves: PublicLeaf[];
}

export type RootsLeafEntry = { leafIndex: number; digest: Hex; proof: Hex[]; record: PublicLeaf } | { leafIndex: number; withheld: true };

export interface RootsDay {
  day: string;
  dayNumber: number;
  root: Hex;
  n: number;
  published: number;
  tx: Hex;
  block: string | null;
  leaves: RootsLeafEntry[];
}

export interface RootsFile {
  kind: "vet402-evm-roots";
  version: 0;
  lane: RootsLane;
  chain: string;
  contract: { address: Address; writer: Address; deployTx: Hex | null };
  leafRule: string;
  policy: string;
  days: RootsDay[];
}

export const LEAF_RULE =
  "digest = keccak256(utf8(the record as canonical JSON: keys sorted, no whitespace)); leaf = keccak256(0x00 || digest); node = keccak256(0x01 || min(a, b) || max(a, b)); an odd node is carried up. DeliveryRoots.verify(dayNumber, digest, proof) on the contract returns true for a record of that day.";
export const ROOTS_POLICY =
  "A purchase that settled on chain and came back is published with its record. Any other result names a seller next to a failure, so its record is published only after vet402 has told that seller (data/records/notified.json); until then only its index is shown. Every purchase is in the root either way.";

/** Pure. The public file of one lane from the days that were written (status "sent"), oldest first. */
export function buildRootsFile(lane: RootsLane, sent: SentDay[], deployTx: Hex | null, notified: ReadonlySet<string>): RootsFile {
  const dep = ROOTS_DEPLOYMENTS[lane];
  const days = sent
    .filter((s) => s.status === "sent" && s.hash)
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((s): RootsDay => {
      if (s.lane !== lane) throw new Error(`${s.day}: sent file of lane ${s.lane}, not ${lane}`);
      if (!isAddressEqual(s.registry, dep.registry)) throw new Error(`${lane} ${s.day}: written to ${s.registry}, not ${dep.registry}`);
      const digests = s.leaves.map(recordDigest);
      const tree = buildTree(digests);
      if (tree.root.toLowerCase() !== s.root.toLowerCase() || s.leaves.length !== s.n) throw new Error(`${lane} ${s.day}: the kept leaves do not make the root that was written`);
      const leaves = s.leaves.map((rec, i): RootsLeafEntry => (leafIsPublic(rec, notified) ? { leafIndex: i, digest: digests[i]!, proof: tree.proofs[i]!, record: rec } : { leafIndex: i, withheld: true }));
      return { day: s.day, dayNumber: dayNumber(s.day), root: s.root, n: s.n, published: leaves.filter((l) => "record" in l).length, tx: s.hash!, block: s.block ?? null, leaves };
    });
  return {
    kind: "vet402-evm-roots",
    version: 0,
    lane,
    chain: EVM_CHAINS[LANES[lane].chain].caip2,
    contract: { address: dep.registry, writer: dep.writer, deployTx },
    leafRule: LEAF_RULE,
    policy: ROOTS_POLICY,
    days,
  };
}

const HEX32 = /^0x[0-9a-f]{64}$/;

/**
 * Pure. The checks build-site makes before a roots file reaches a page: the right lane, contract and writer,
 * every published record rebuilds its digest and proves into its day's root, every index once, and no
 * negative record for a seller not told.
 */
export function rootsFileProblems(f: RootsFile, lane: RootsLane, notified: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const dep = ROOTS_DEPLOYMENTS[lane];
  if (f.kind !== "vet402-evm-roots" || f.lane !== lane) return [`not a vet402 ${lane} roots file`];
  if (!isAddressEqual(f.contract.address, dep.registry) || !isAddressEqual(f.contract.writer, dep.writer)) out.push("contract or writer is not the pinned one");
  if (f.contract.deployTx !== null && !HEX32.test(f.contract.deployTx)) out.push("deployTx");
  for (const d of f.days) {
    if (!HEX32.test(d.root) || !HEX32.test(d.tx) || d.dayNumber !== dayNumber(d.day)) out.push(`${d.day}: root, tx or dayNumber`);
    const idx = d.leaves.map((l) => l.leafIndex);
    if (d.leaves.length !== d.n || new Set(idx).size !== d.n || idx.some((i) => i < 0 || i >= d.n)) out.push(`${d.day}: leaf indexes`);
    for (const l of d.leaves) {
      if (!("record" in l)) continue;
      if (recordDigest(l.record) !== l.digest || !verifyInclusion(l.digest, l.proof, d.root)) out.push(`${d.day} #${l.leafIndex}: does not prove into the root`);
      if (!leafIsPublic(l.record, notified)) out.push(`${d.day} #${l.leafIndex}: a negative result for a seller not in notified.json`);
    }
    if (d.published !== d.leaves.filter((l) => "record" in l).length) out.push(`${d.day}: published count`);
  }
  return out;
}

/** Days with purchases that are not done: done = written ("sent") and in the published file. */
export function openRootDays(purchaseDayList: string[], sentStatus: (day: string) => string | null, publishedDays: ReadonlySet<string>): string[] {
  return purchaseDayList.filter((d) => !(sentStatus(d) === "sent" && publishedDays.has(d)));
}
