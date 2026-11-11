/**
 * 3.11-6, fixed for Polygon: the daily root's fee is on the ledger. On Polygon the payer (0x9B59…4E51, the purchase
 * key) pays the daily root in POL, so POL leaves the same wallet the USDC purchases leave. Every POL fee is written
 * to the Polygon POL ledger (results/evm/polygon-pol-ledger.json) at its signed bound (gas x maxFeePerGas + value)
 * before its transaction is signed, and before each Polygon signature the lane reads what POL actually left the
 * payer on chain. POL that left outside that ledger is chain_spend_exceeds_ledger, and the lane stops before the
 * next signature, as USDC outflow beyond the Polygon USDC ledger does.
 *
 * How POL that left is read: POL leaves an EOA only by a transaction it signs, and each one raises its nonce. The
 * payer's nonce since POLYGON_PAYER_START_NONCE is the number of Polygon transactions it sent; each ledger entry is
 * read back (from, nonce, gasUsed x effectiveGasPrice + value). A sent transaction that is not on the ledger, or a
 * ledger transaction whose actual cost is above what the ledger holds, stops the lane. No file can move the start.
 *
 * A purchase day must also be able to get its root, and that root must be checkable. Until Polygon is a roots lane
 * (a DeliveryRoots deployment in ROOTS_DEPLOYMENTS, and scripts/evm-anchor.ts --lane polygon), a paying Polygon run
 * stops before the key.
 */
import { isAddressEqual, type Address, type Hex, type PublicClient } from "viem";
import { ROOTS_LANES } from "./roots.js";

export function polygonDailyRootProblem(rootsLanes: readonly string[] = ROOTS_LANES): string | null {
  if (rootsLanes.includes("polygon")) return null;
  return "no daily-root path on Polygon: DeliveryRoots is not a Polygon roots lane yet, so a Polygon purchase day could not get a root that can be checked";
}

/** The Polygon POL ledger, beside the lane's USDC ledger in the EVM results directory. */
export const POLYGON_POL_LEDGER_FILE = "polygon-pol-ledger.json";
/**
 * The payer's first Polygon nonce the lane accounts for: eth_getTransactionCount of 0x9B59…4E51 on Polygon was 0 at
 * block 97,130,027 (2026-11-11), before any Polygon transaction from it. Fixed in the code: no file can move it.
 */
export const POLYGON_PAYER_START_NONCE = 0n;

/** One POL spend the payer signs on Polygon (a daily root), written before it is signed. */
export interface PolLedgerEntry {
  tx: Hex;
  nonce: number;
  /** gas x maxFeePerGas + value, in wei: the most this transaction can take from the payer. */
  boundWei: string;
  day?: string;
}

/** The entries of the POL ledger file. No file is an empty ledger; a file that cannot be read throws (the caller stops). */
export function polLedgerEntriesFromFile(text: string | null): PolLedgerEntry[] {
  if (text === null) return [];
  const j = JSON.parse(text) as { entries?: unknown };
  if (!Array.isArray(j.entries)) throw new Error("POL ledger has no entries array");
  return j.entries.map((e: Partial<PolLedgerEntry>, i) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(e?.tx ?? "")) throw new Error(`POL ledger entry ${i} has no transaction hash`);
    if (!Number.isSafeInteger(e.nonce) || (e.nonce as number) < 0) throw new Error(`POL ledger entry ${i} has no nonce`);
    if (!/^\d+$/.test(e.boundWei ?? "")) throw new Error(`POL ledger entry ${i} has no boundWei`);
    return { tx: e.tx as Hex, nonce: e.nonce as number, boundWei: e.boundWei as string, ...(e.day ? { day: e.day } : {}) };
  });
}

/** One payer transaction on Polygon as the chain reports it. feeWei = gasUsed x effectiveGasPrice. */
export interface PolTxReading {
  from: string;
  nonce: number;
  feeWei: bigint;
  valueWei: bigint;
}

export interface PolSpendReader {
  /** The payer's nonce at the latest block: how many transactions it has sent on Polygon. */
  nonce(): Promise<bigint>;
  /** A mined transaction with its receipt, or null when it is not mined. */
  tx(hash: Hex): Promise<PolTxReading | null>;
}

export interface PolSpend {
  /** POL the ledger holds for the payer's Polygon transactions (their bounds). */
  ledgerWei: bigint;
  /** POL those ledger transactions took on chain. */
  chainWei: bigint;
  /** Payer transactions on Polygon since the start nonce that are not on the ledger. */
  offLedgerTxs: bigint;
}

/** The chain reads for measurePolygonPolSpend. Only "not found" reads as not mined; any other failure throws. */
export function polSpendReaderFromClients(client: PublicClient, receiptClient: PublicClient, payer: Address): PolSpendReader {
  const notFound = (err: unknown) => /NotFoundError$/.test((err as Error)?.name ?? "");
  return {
    nonce: async () => BigInt(await client.getTransactionCount({ address: payer, blockTag: "latest" })),
    tx: async (hash) => {
      let t, r;
      try {
        t = await client.getTransaction({ hash });
        r = await receiptClient.getTransactionReceipt({ hash });
      } catch (err) {
        if (notFound(err)) return null;
        throw err;
      }
      return { from: t.from, nonce: t.nonce, feeWei: r.gasUsed * r.effectiveGasPrice, valueWei: t.value };
    },
  };
}

/** Reads what POL left the payer on Polygon against the POL ledger. A failed read throws, and the caller signs nothing. */
export async function measurePolygonPolSpend(
  reader: PolSpendReader,
  entries: readonly PolLedgerEntry[],
  payer: string,
  startNonce: bigint = POLYGON_PAYER_START_NONCE,
): Promise<PolSpend> {
  const chainNonce = await reader.nonce();
  const nonces = new Set<number>();
  let ledgerWei = 0n;
  let chainWei = 0n;
  let mined = 0n;
  for (const e of entries) {
    if (BigInt(e.nonce) < startNonce) continue;
    if (nonces.has(e.nonce)) throw new Error(`POL ledger lists nonce ${e.nonce} twice`);
    nonces.add(e.nonce);
    ledgerWei += BigInt(e.boundWei);
    const r = await reader.tx(e.tx);
    // Not mined: the bound stays reserved. If another transaction took that nonce, it is counted as off the ledger.
    if (!r) continue;
    if (!isAddressEqual(r.from as Hex, payer as Hex) || r.nonce !== e.nonce) {
      throw new Error(`POL ledger transaction ${e.tx} is not the payer's nonce ${e.nonce}`);
    }
    mined++;
    chainWei += r.feeWei + r.valueWei;
  }
  const sent = chainNonce > startNonce ? chainNonce - startNonce : 0n;
  return { ledgerWei, chainWei, offLedgerTxs: sent > mined ? sent - mined : 0n };
}

/** Same stop word as the USDC outflow (chain_spend_exceeds_ledger). Pure. */
export function polygonPolSpendProblem(m: PolSpend): string | null {
  if (m.offLedgerTxs > 0n) {
    return `chain_spend_exceeds_ledger: ${m.offLedgerTxs} Polygon transaction(s) from the payer are not on the POL ledger, so their POL fees left outside it`;
  }
  if (m.chainWei > m.ledgerWei) return `chain_spend_exceeds_ledger: Polygon POL outflow ${m.chainWei} wei > POL ledger ${m.ledgerWei} wei`;
  return null;
}
