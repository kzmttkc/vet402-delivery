/**
 * The daily root of an EVM lane's purchases, in DeliveryRoots (contracts/src/DeliveryRoots.sol) on the chain the
 * lane bought on: one record(day, root, n) per closed UTC day with purchases, written by the DeliveryRoots key
 * (src/evm/key.ts ROOTS_POSTER_ADDRESS), never by the payer wallet.
 *
 * The leaf holds facts only. The material is the lane's own reading of each purchase, as scripts/evm-publish.ts
 * reads it: results/evm/<lane>-purchases.jsonl, then -reverify.jsonl, then -chaincheck.jsonl
 * (src/evm/chaincheck.ts mergeReadings: a later reading of the same purchase replaces the earlier). Those lines
 * hold the seller's answer and stay on the runner, so the root is not taken over them. Each sent purchase becomes
 * a public leaf record (publicLeaf): what vet402 paid (amount, token), to whom, the settlement transaction the
 * chain check found and its result, what came back (HTTP status, size, sha256 of the body vet402 kept, not the
 * body), and 32 random bytes (`salt`). No verdict is in a leaf: delivered or not, and whose side a failure is on,
 * are decided each time the file is published, with the rules of that day (verdictOf: src/evm/settle-cause.ts and
 * the row status of src/evm/site.ts, the same calls the lane pages make). A rule change therefore never leaves an
 * old verdict on chain. digest = keccak256(canonical JSON of the leaf record); the tree is src/receipt/merkle.ts.
 * A day with a sent purchase the chain check has not read (or read while its window was open) gets no root.
 *
 * What is published (data/evm/roots/<lane>.json). A leaf whose verdict today says nothing against the seller
 * (src/evm/site.ts isNegative, the rule of the lane pages), or whose seller vet402 has told
 * (data/records/notified.json), is published with its record, proof and today's verdict. Any other leaf is
 * shown by its index only. Its leaf hash still shows up as a sibling in other proofs, and the salt is what keeps
 * that hash from being guessed back into its facts.
 *
 * Until a day is sent, its leaves are made again from the lines on every run; only the salts are kept
 * (results/evm/anchors/<lane>-<day>.salts.json, keyed by the purchase, not the line, so a later chain check keeps
 * the salt). The leaves that were sent are kept in <lane>-<day>.sent.json and are the only ones ever published for
 * that day.
 */
import { createHash, randomBytes } from "node:crypto";
import { encodeAbiParameters, getAddress, getContractAddress, isAddressEqual, parseAbi, type Address, type Hex } from "viem";
import { buildTree, verifyInclusion } from "../receipt/merkle.js";
import { EVM_CHAINS, LANES, type EvmChainKey } from "./chains.js";
import { DELIVERY_ROOTS_ARTIFACT } from "./delivery-roots-artifact.js";
import { dayNumber, dayRoot, recordDigest, type DayRoot } from "./evm-anchor.js";
import type { ChainBuyRecord } from "./evm-buy.js";
import { ROOTS_POSTER_ADDRESS } from "./key.js";
import { mergeReadings, recordKey } from "./chaincheck.js";
import { classifyRecord, type CauseResult } from "./settle-cause.js";
import { isNegative, statusOf, type LaneRow, type RowStatus } from "./site.js";

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
  /** The purchase's identity with lane, at and resource (src/evm/chaincheck.ts recordKey). */
  agentId: string;
  at: string;
  method: string;
  resource: string;
  payer: string | null;
  payTo: string | null;
  asset: string;
  amountAtomic: string | null;
  /** What the chain check read (src/evm/chaincheck.ts): transfer_found, no_transfer or ambiguous. */
  chainCheck: string;
  /** The transfer the chain check tied to this purchase, when it found one. */
  settlementTx: string | null;
  httpStatus: number | null;
  responseBytes: number | null;
  /** 0x + sha256 of the answer body as vet402 kept it (cut at the lane's keepBodyBytes), or null. */
  bodyHash: string | null;
  /** 32 random bytes: a leaf hash that is not published cannot be guessed back into its record. */
  salt: string;
}

type LaneLine = ChainBuyRecord & { facilitator?: string | null; predictedProblem?: string | null; lane?: string };

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Pure. The public leaf record (facts only) of one sent purchase reading that the chain check has read. */
export function publicLeaf(lane: RootsLane, r: LaneLine, salt: string): PublicLeaf {
  if (!/^0x[0-9a-f]{64}$/.test(salt)) throw new Error("salt must be 0x + 64 lowercase hex");
  if (!r.chainCheck || r.chainCheck.result === "pending") throw new Error(`${r.resource} at ${r.at}: no chain check`);
  const spec = EVM_CHAINS[LANES[lane].chain];
  return {
    kind: "vet402-evm-purchase",
    version: 0,
    lane,
    chain: spec.caip2,
    agentId: r.agentId,
    at: r.at,
    method: r.method,
    resource: r.resource,
    payer: r.payer ?? null,
    payTo: r.payTo ?? null,
    asset: spec.asset,
    amountAtomic: r.amountAtomic ?? null,
    chainCheck: r.chainCheck.result,
    settlementTx: r.chainCheck.result === "transfer_found" ? (r.chainCheck.tx ?? null) : null,
    httpStatus: r.response?.status ?? null,
    responseBytes: typeof r.response?.bytes === "number" ? r.response.bytes : null,
    bodyHash: typeof r.body === "string" ? `0x${sha256Hex(r.body)}` : null,
    salt,
  };
}

/** Today's verdict on one purchase: the lane page's row status and the cause, with the rules of this run. */
export interface Verdict {
  status: RowStatus;
  cause: CauseResult["cause"];
  rule: string;
}

/** Pure. verdictOf for every reading, by purchase (recordKey). */
export function verdictsOf(lane: RootsLane, lines: readonly string[]): Map<string, Verdict> {
  const out = new Map<string, Verdict>();
  for (const l of lines) {
    if (!l.trim()) continue;
    const r = JSON.parse(l) as LaneLine;
    const cause = classifyRecord(r, { facilitator: r.facilitator ?? null, problem: r.predictedProblem ?? null });
    out.set(recordKey({ ...r, lane }), { status: statusOf({ ...r, lane, cause }), cause: cause.cause, rule: cause.rule });
  }
  return out;
}

export const leafKey = (leaf: PublicLeaf): string => recordKey(leaf);

/** sha256 of a purchase's identity (src/evm/chaincheck.ts recordKey) -> its salt. */
export type Salts = Record<string, string>;

export const newSalt = (): string => `0x${randomBytes(32).toString("hex")}`;

/**
 * Pure. The lane's readings as scripts/evm-publish.ts merges them: the contents of
 * <lane>-purchases.jsonl, -reverify.jsonl and -chaincheck.jsonl in that order, one record per purchase, as
 * JSON lines (the material of the day's leaves).
 */
export function laneReadings(lane: RootsLane, fileTexts: readonly string[]): string[] {
  const rows = fileTexts.flatMap((t) => t.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as LaneLine & { lane?: string }));
  return mergeReadings(rows)
    .filter((r) => (r.lane ?? lane) === lane)
    .map((r) => JSON.stringify(r));
}

/**
 * The day's root over public leaves, from laneReadings. Refuses a day with a sent purchase the chain check has
 * not decided. A purchase that has a salt keeps it; a new one gets a new one (`salts` is returned with it, to be
 * saved before the root is used).
 */
export function lanesDayRoot(lane: RootsLane, day: string, lines: string[], nowIso: string, salts: Salts, mint: () => string = newSalt): { root: Omit<DayRoot, "leaves"> & { leaves: PublicLeaf[] }; salts: Salts } {
  const ofDay = lines.filter((l) => l.trim()).map((l) => JSON.parse(l) as LaneLine).filter((r) => typeof r.at === "string" && r.at.slice(0, 10) === day);
  // Every sent purchase, settled at purchase time or not: the chain check's reading is a fact in its leaf.
  const unchecked = ofDay.filter((r) => r.outcome === "sent" && (!r.chainCheck || r.chainCheck.result === "pending")).map((r) => `${lane} ${r.resource}`);
  if (unchecked.length) throw new Error(`${lane} ${day}: ${unchecked.length} sent purchase(s) without a chain check; run npx tsx scripts/evm-chaincheck.ts --lane ${lane} first: ${unchecked.slice(0, 3).join("; ")}`);
  const next: Salts = { ...salts };
  const root = dayRoot(EVM_CHAINS[LANES[lane].chain], day, lines, nowIso, (rec) => {
    const r = rec as LaneLine;
    const k = sha256Hex(recordKey({ ...r, lane }));
    next[k] ??= mint();
    return publicLeaf(lane, r, next[k]!);
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

/** Pure. Published with its record when today's verdict says nothing against the seller, or vet402 has told the seller. */
export function leafIsPublic(leaf: PublicLeaf, verdict: Verdict | null, notified: ReadonlySet<string>): boolean {
  const host = hostOf(leaf.resource);
  if (host !== null && notified.has(host)) return true;
  if (!verdict) return false; // no reading today: not judged, not shown
  return !isNegative(verdict.status, { cause: verdict.cause, rule: verdict.rule, evidence: "none", fix: null });
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

export type RootsLeafEntry = { leafIndex: number; digest: Hex; proof: Hex[]; record: PublicLeaf; verdict: Verdict | null } | { leafIndex: number; withheld: true };

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

export const LEAF_RULE = String.raw`digest = keccak256(utf8(the record as canonical JSON)); leaf = keccak256(0x00 || digest); node = keccak256(0x01 || min(a, b) || max(a, b)); an odd node is carried up. Canonical JSON: object keys sorted by UTF-16 code unit (JavaScript's default sort), no whitespace, null kept, strings escaped exactly as JavaScript's JSON.stringify does (only \" \\ and control characters: \b \f \n \r \t, the others as \u00xx in lowercase hex; non-ASCII characters and / are not escaped), integers in plain decimal. DeliveryRoots.verify(dayNumber, digest, proof) on the contract returns true for a record of that day.`;
export const ROOTS_POLICY =
  "A leaf holds facts only (payment, settlement read on chain, HTTP status, size and sha256 of the answer); no verdict is in the root. Each time this file is published, every purchase is judged with the rules of that day (verdict). A purchase whose verdict says nothing against the seller is published with its record. Any other result names a seller next to a failure, so its record is published only after vet402 has told that seller (data/records/notified.json); until then only its index is shown. Every purchase is in the root either way.";

/**
 * Pure. The public file of one lane from the days that were written (status "sent"), oldest first, each leaf
 * judged by today's `verdicts` (verdictsOf over the lane's current readings).
 */
export function buildRootsFile(lane: RootsLane, sent: SentDay[], deployTx: Hex | null, notified: ReadonlySet<string>, verdicts: ReadonlyMap<string, Verdict>): RootsFile {
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
      const leaves = s.leaves.map((rec, i): RootsLeafEntry => {
        const v = verdicts.get(leafKey(rec)) ?? null;
        return leafIsPublic(rec, v, notified) ? { leafIndex: i, digest: digests[i]!, proof: tree.proofs[i]!, record: rec, verdict: v } : { leafIndex: i, withheld: true };
      });
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
 * Pure. The checks before a roots file is written or reaches a page: the right lane, contract and writer, every
 * published record rebuilds its digest and proves into its day's root, every index once, and no record published
 * that today's judgment would withhold. Today's judgment is `now.verdicts` when the readings are at hand
 * (scripts/evm-roots-publish.ts: the stored verdict must be today's, and a withheld leaf must still be one), else
 * the lane page's rows (`now.rows`, data/evm/<lane>.json, written with today's rules by scripts/evm-publish.ts):
 * a record whose own purchase is a withheld row there is stale.
 */
export function rootsFileProblems(f: RootsFile, lane: RootsLane, notified: ReadonlySet<string>, now: { verdicts?: ReadonlyMap<string, Verdict>; rows?: readonly LaneRow[] }): string[] {
  const out: string[] = [];
  const dep = ROOTS_DEPLOYMENTS[lane];
  if (f.kind !== "vet402-evm-roots" || f.lane !== lane) return [`not a vet402 ${lane} roots file`];
  if (!isAddressEqual(f.contract.address, dep.registry) || !isAddressEqual(f.contract.writer, dep.writer)) out.push("contract or writer is not the pinned one");
  if (f.contract.deployTx !== null && !HEX32.test(f.contract.deployTx)) out.push("deployTx");
  // The lane page's rows that stand for exactly one purchase, by payTo + resource.
  const single = new Map<string, LaneRow>();
  for (const r of now.rows ?? []) if (r.resource && r.purchases === undefined) single.set(`${r.payTo.toLowerCase()}|${r.resource}`, r);
  for (const d of f.days) {
    if (!HEX32.test(d.root) || !HEX32.test(d.tx) || d.dayNumber !== dayNumber(d.day)) out.push(`${d.day}: root, tx or dayNumber`);
    const idx = d.leaves.map((l) => l.leafIndex);
    if (d.leaves.length !== d.n || new Set(idx).size !== d.n || idx.some((i) => i < 0 || i >= d.n)) out.push(`${d.day}: leaf indexes`);
    for (const l of d.leaves) {
      if (!("record" in l)) continue;
      const at = `${d.day} #${l.leafIndex}`;
      if (recordDigest(l.record) !== l.digest || !verifyInclusion(l.digest, l.proof, d.root)) out.push(`${at}: does not prove into the root`);
      if (!leafIsPublic(l.record, l.verdict, notified)) out.push(`${at}: a negative result for a seller not in notified.json`);
      if (now.verdicts) {
        const v = now.verdicts.get(leafKey(l.record)) ?? null;
        if (JSON.stringify(v) !== JSON.stringify(l.verdict)) out.push(`${at}: the verdict is not today's`);
        if (!leafIsPublic(l.record, v, notified)) out.push(`${at}: today's rules withhold it`);
      }
      const row = single.get(`${(l.record.payTo ?? "").toLowerCase()}|${l.record.resource}`);
      if (row && row.status === "withheld") out.push(`${at}: the lane page withholds this purchase today (stale roots file: run scripts/evm-roots-publish.ts)`);
    }
    if (d.published !== d.leaves.filter((l) => "record" in l).length) out.push(`${d.day}: published count`);
  }
  return out;
}

/** Days with purchases that are not done: done = written ("sent") and in the published file. */
export function openRootDays(purchaseDayList: string[], sentStatus: (day: string) => string | null, publishedDays: ReadonlySet<string>): string[] {
  return purchaseDayList.filter((d) => !(sentStatus(d) === "sent" && publishedDays.has(d)));
}
