/**
 * Weekly Merkle roots of vet402 Celo purchases (eip155:42220), written into DeliveryRoots on Celo.
 * Source rows are the public observatory export (https://vet402.com/api/v1/observatory/export.csv);
 * anyone can rebuild each leaf from those columns with publicLeafFromExport.
 */
import { createHash } from "node:crypto";
import { getAddress, isAddressEqual, type Address, type Hex } from "viem";
import { buildTree, verifyInclusion } from "../receipt/merkle.js";
import { parseCsv } from "./base-candidates.js";
import { dayNumber, recordDigest, type DayRoot } from "./evm-anchor.js";
import { LEAF_RULE } from "./roots.js";
import { EXPECTED_ADDRESS, ROOTS_POSTER_ADDRESS } from "./key.js";

export const CELO_CAIP2 = "eip155:42220" as const;
export const CELO_EXPORT_URL = "https://vet402.com/api/v1/observatory/export.csv";

/** DeliveryRoots on Celo mainnet (writer = ROOTS_POSTER_ADDRESS). */
export const CELO_REGISTRY: Address = getAddress("0x3050Ae4C0D77Eb27C64f4Cc5dd1B07F93C593855");

/** DeliveryRoots deploy on Celo mainnet; do not scan eth_getLogs before this block in --check. */
export const CELO_DEPLOY_BLOCK = 80_301_788n;
export const CELO_DEPLOY_TX: Hex = "0x09334ea83c010c08e9e2f452a5daba91104b31395d2cc69fe7d28054d927468a";

export const CELO_CHAIN = {
  label: "Celo",
  caip2: CELO_CAIP2,
  chainId: 42220,
  rpc: "https://forno.celo.org",
  rpcEnv: "CELO_RPC_URL",
  explorerTx: "https://celoscan.io/tx/",
  explorerAddress: "https://celoscan.io/address/",
  /** USDC on Celo (Circle). */
  asset: getAddress("0xcebA9300b2Ee9482aC3Ed268AEB685A8f46a2923"),
  nativeSymbol: "CELO",
  anchorMaxGas: 150_000n,
  /** ~10× a forno record() quote at ~242 gwei (gas × 1.25 × maxFeePerGas). */
  anchorMaxFeeWei: 250_000_000_000_000_000n,
  recordMaxGas: 150_000n,
  recordMaxFeeWei: 250_000_000_000_000_000n,
  registry: CELO_REGISTRY,
  writer: ROOTS_POSTER_ADDRESS,
} as const;

export interface CeloExportRow {
  attempted_at: string;
  resource_key: string;
  network: string;
  status: string;
  amount_units: string;
  spent_units: string;
  tx_hash: string;
  http_status_paid: string;
  latency_ms: string;
  l2_schema: string;
  held_reason: string;
  request_body: string;
  request_body_sha256: string;
  settlement_source: string;
  request_query: string;
  request_query_sha256: string;
  confirmed_units: string;
  purchase_id: string;
  l2_reading: string;
}

/** Same fact fields as src/evm/roots.ts PublicLeaf, rebuilt from export.csv only. */
export interface CeloPublicLeaf {
  kind: "vet402-evm-purchase";
  version: 0;
  lane: "celo";
  chain: typeof CELO_CAIP2;
  agentId: string;
  at: string;
  method: string;
  resource: string;
  payer: string;
  payTo: string | null;
  asset: string;
  amountAtomic: string | null;
  chainCheck: string;
  settlementTx: string | null;
  httpStatus: number | null;
  responseBytes: number | null;
  bodyHash: string | null;
  salt: string;
}

export type CeloSalts = Record<string, string>;

/** Pure. One purchase_id on Celo -> its leaf salt (export.csv alone fixes the root). */
export function saltFromCeloExport(row: Pick<CeloExportRow, "purchase_id">): string {
  const h = createHash("sha256").update(`vet402/celo-weekly/v0/${CELO_CAIP2}/${row.purchase_id}`).digest("hex");
  return `0x${h}`;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** UTC day-of-week: 0 = Sunday … 6 = Saturday. */
export function utcDow(iso: string): number {
  const d = iso.slice(0, 10);
  if (!DAY.test(d)) throw new Error(`not a date: ${iso}`);
  return new Date(`${d}T12:00:00Z`).getUTCDay();
}

/** The Sunday (YYYY-MM-DD) of the UTC week that contains `iso` (week = Mon 00:00 – Sun 24:00). */
export function weekSundayOf(iso: string): string {
  const d = iso.slice(0, 10);
  if (!DAY.test(d)) throw new Error(`not a date: ${iso}`);
  const t = Date.parse(`${d}T00:00:00Z`);
  const dow = new Date(t).getUTCDay();
  const daysToSun = dow === 0 ? 0 : 7 - dow;
  return new Date(t + daysToSun * 86_400_000).toISOString().slice(0, 10);
}

export function assertWeekSunday(day: string): void {
  if (!DAY.test(day)) throw new Error(`week ${day} is not YYYY-MM-DD`);
  if (utcDow(`${day}T00:00:00Z`) !== 0) throw new Error(`week ${day} is not a Sunday (UTC)`);
}

/** Monday 00:00:00Z of the week that ends on `sunday`. */
export function weekMondayUtc(sunday: string): number {
  assertWeekSunday(sunday);
  return Date.parse(`${sunday}T00:00:00Z`) - 6 * 86_400_000;
}

/** True when attempted_at falls in the UTC week ending on `sunday` (Mon 00:00 ≤ t < next Mon 00:00). */
export function inWeek(attemptedAt: string, sunday: string): boolean {
  const t = Date.parse(attemptedAt.endsWith("Z") || attemptedAt.includes("+") ? attemptedAt : `${attemptedAt}Z`);
  if (!Number.isFinite(t)) throw new Error(`bad timestamp ${attemptedAt}`);
  const start = weekMondayUtc(sunday);
  const end = start + 7 * 86_400_000;
  return t >= start && t < end;
}

/** The latest fully closed week (Sunday date), from `now`. */
export function lastClosedWeekSunday(now = new Date()): string {
  const curSun = weekSundayOf(now.toISOString());
  const end = weekMondayUtc(curSun) + 7 * 86_400_000;
  if (now.getTime() < end) {
    const prev = new Date(Date.parse(`${curSun}T00:00:00Z`) - 7 * 86_400_000);
    return prev.toISOString().slice(0, 10);
  }
  return curSun;
}

export function resourceFromExport(row: CeloExportRow): string {
  const q = row.request_query?.trim();
  const base = row.resource_key.startsWith("http") ? row.resource_key : `https://${row.resource_key}`;
  return q ? `${base}?${q}` : base;
}

export function methodFromExport(row: CeloExportRow): string {
  const b = row.request_body?.trim() ?? "";
  if (b === "declared" || (b !== "" && b !== "none" && b !== "empty")) return "POST";
  return "GET";
}

export function chainCheckFromExport(row: CeloExportRow): string {
  const tx = row.tx_hash?.trim();
  if (!tx) return "no_transfer";
  if (row.l2_reading === "match") return "transfer_found";
  return "not_checked";
}

export function amountFromExport(row: CeloExportRow): string | null {
  const c = row.confirmed_units?.trim();
  if (/^\d+$/.test(c) && BigInt(c) > 0n) return c;
  return null;
}

/** A purchase row included in the weekly root: Celo network and payment sent (spent_units > 0). */
export function rowInRoot(row: CeloExportRow): boolean {
  return row.network === CELO_CAIP2 && /^\d+$/.test(row.spent_units) && BigInt(row.spent_units) > 0n;
}

/** Pure. Rebuild the public leaf of one export row (facts only). */
export function publicLeafFromExport(row: CeloExportRow, salt: string): CeloPublicLeaf {
  if (!/^0x[0-9a-f]{64}$/.test(salt)) throw new Error("salt must be 0x + 64 lowercase hex");
  const http = /^\d+$/.test(row.http_status_paid) ? Number(row.http_status_paid) : null;
  return {
    kind: "vet402-evm-purchase",
    version: 0,
    lane: "celo",
    chain: CELO_CAIP2,
    agentId: `purchase:${row.purchase_id}`,
    at: row.attempted_at,
    method: methodFromExport(row),
    resource: resourceFromExport(row),
    payer: EXPECTED_ADDRESS,
    payTo: null,
    asset: CELO_CHAIN.asset,
    amountAtomic: amountFromExport(row),
    chainCheck: chainCheckFromExport(row),
    settlementTx: row.tx_hash?.trim() ? row.tx_hash.trim() : null,
    httpStatus: http,
    responseBytes: null,
    bodyHash: null,
    salt,
  };
}

export function parseCeloExport(text: string): CeloExportRow[] {
  return parseCsv(text) as unknown as CeloExportRow[];
}

export function rowsForWeek(rows: readonly CeloExportRow[], sunday: string): CeloExportRow[] {
  assertWeekSunday(sunday);
  return rows
    .filter((r) => rowInRoot(r) && inWeek(r.attempted_at, sunday))
    .slice()
    .sort((a, b) => a.attempted_at.localeCompare(b.attempted_at) || a.purchase_id.localeCompare(b.purchase_id));
}

export function weekRootFromRows(
  sunday: string,
  picked: readonly CeloExportRow[],
  nowIso: string,
): { root: DayRoot & { leaves: CeloPublicLeaf[] }; salts: CeloSalts } {
  assertWeekSunday(sunday);
  const close = weekMondayUtc(sunday) + 7 * 86_400_000;
  if (Date.parse(nowIso) < close) throw new Error(`week ending ${sunday} is not over in UTC (now ${nowIso})`);
  if (picked.length === 0) throw new Error(`no Celo purchase in week ending ${sunday}`);
  const salts: CeloSalts = {};
  const leaves = picked.map((row) => {
    const salt = saltFromCeloExport(row);
    salts[row.purchase_id] = salt;
    return publicLeafFromExport(row, salt);
  });
  const digests = leaves.map(recordDigest);
  const tree = buildTree(digests);
  const lines = picked.map((r) => JSON.stringify(r));
  const root: DayRoot & { leaves: CeloPublicLeaf[] } = {
    chain: CELO_CAIP2,
    day: sunday,
    n: leaves.length,
    root: tree.root,
    digests,
    proofs: tree.proofs,
    leaves,
    lines,
    inputSha256: createHash("sha256").update(lines.join("\n")).digest("hex"),
  };
  return { root, salts };
}

export const CELO_LEAF_FROM_EXPORT =
  "Each leaf is a vet402-evm-purchase record from one export row: salt = 0x + sha256(utf8 \"vet402/celo-weekly/v0/eip155:42220/\" + purchase_id) as lowercase hex; network eip155:42220 and spent_units > 0; attempted_at, purchase_id, resource_key, request_query, request_body, spent_units, confirmed_units, tx_hash, http_status_paid, l2_reading; amountAtomic is confirmed_units when that is a positive integer, otherwise null; payer is vet402's EVM wallet; payTo is null (not in the export); asset is Celo USDC; responseBytes and bodyHash are null. Rows are sorted by attempted_at then purchase_id. Week = UTC Monday 00:00 through Sunday 24:00; record(day, root, n) uses day = that Sunday's dayNumber.";

export const CELO_ROOTS_POLICY =
  "A leaf holds facts only, taken from the public observatory export; no verdict is in the root. Every purchase in the week is published with its record and proof.";

export type CeloRootsLeafEntry = {
  leafIndex: number;
  digest: Hex;
  proof: Hex[];
  record: CeloPublicLeaf;
};

export interface CeloRootsDay {
  day: string;
  dayNumber: number;
  root: Hex;
  n: number;
  published: number;
  tx: Hex;
  block: string | null;
  leaves: CeloRootsLeafEntry[];
}

export interface CeloRootsFile {
  kind: "vet402-evm-roots";
  version: 0;
  lane: "celo";
  chain: typeof CELO_CAIP2;
  cadence: "weekly";
  source: typeof CELO_EXPORT_URL;
  contract: { address: Address; writer: Address; deployTx: Hex | null };
  leafRule: string;
  policy: string;
  days: CeloRootsDay[];
}

export interface CeloSentWeek {
  lane: "celo";
  week: string;
  root: Hex;
  n: number;
  status: "sending" | "sent" | "failed";
  hash?: Hex;
  block?: string;
  registry: Address;
  fromBlock?: string;
  leaves: CeloPublicLeaf[];
}

export function buildCeloRootsFile(sent: CeloSentWeek[], deployTx: Hex | null): CeloRootsFile {
  const days = sent
    .filter((s) => s.status === "sent" && s.hash)
    .sort((a, b) => a.week.localeCompare(b.week))
    .map((s): CeloRootsDay => {
      if (!isAddressEqual(s.registry, CELO_REGISTRY)) throw new Error(`${s.week}: written to ${s.registry}, not ${CELO_REGISTRY}`);
      const digests = s.leaves.map(recordDigest);
      const tree = buildTree(digests);
      if (tree.root.toLowerCase() !== s.root.toLowerCase() || s.leaves.length !== s.n) throw new Error(`${s.week}: kept leaves do not make the root on chain`);
      const leaves = s.leaves.map((rec, i): CeloRootsLeafEntry => ({
        leafIndex: i,
        digest: digests[i]!,
        proof: tree.proofs[i]!,
        record: rec,
      }));
      return {
        day: s.week,
        dayNumber: dayNumber(s.week),
        root: s.root,
        n: s.n,
        published: leaves.length,
        tx: s.hash!,
        block: s.block ?? null,
        leaves,
      };
    });
  return {
    kind: "vet402-evm-roots",
    version: 0,
    lane: "celo",
    chain: CELO_CAIP2,
    cadence: "weekly",
    source: CELO_EXPORT_URL,
    contract: { address: CELO_REGISTRY, writer: CELO_CHAIN.writer, deployTx },
    leafRule: `${LEAF_RULE} ${CELO_LEAF_FROM_EXPORT}`,
    policy: CELO_ROOTS_POLICY,
    days,
  };
}

const HEX32 = /^0x[0-9a-f]{64}$/;

/** Pure. Checks before writing data/evm/roots/celo.json. */
export function celoRootsFileProblems(f: CeloRootsFile): string[] {
  const errors: string[] = [];
  if (f.kind !== "vet402-evm-roots" || f.lane !== "celo" || f.chain !== CELO_CAIP2) errors.push("not a vet402 celo roots file");
  if (!isAddressEqual(f.contract.address, CELO_REGISTRY) || !isAddressEqual(f.contract.writer, CELO_CHAIN.writer)) errors.push("contract or writer is not the pinned one");
  if (f.contract.deployTx !== null && !HEX32.test(f.contract.deployTx)) errors.push("deployTx");
  for (const d of f.days) {
    if (!HEX32.test(d.root) || !HEX32.test(d.tx) || d.dayNumber !== dayNumber(d.day)) errors.push(`${d.day}: root, tx or dayNumber`);
    if (d.leaves.length !== d.n || d.published !== d.n) errors.push(`${d.day}: leaf count`);
    for (const l of d.leaves) {
      if (recordDigest(l.record) !== l.digest || !verifyInclusion(l.digest, l.proof, d.root)) errors.push(`${d.day} #${l.leafIndex}: does not prove into the root`);
    }
  }
  return errors;
}
