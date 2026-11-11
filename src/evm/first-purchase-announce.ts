/**
 * 3.11-7: a chain's first purchases are announced (to anyone, inside or outside) only after the public purchase
 * ledger (data/evm/<lane>.json) holds them. The count is read from that ledger, never passed in.
 */
import { MONAD_311_STATUS, MONAD_CAIP2 } from "./311-memo.js";
import { POLYGON_CAIP2 } from "./evm-pay-gates.js";
import { publishedEvmPurchaseCounts } from "./published-purchase-chains.js";

export const ANNOUNCE_ALLOWED_CHAINS = new Set([POLYGON_CAIP2]);

export function firstPurchaseAnnounceProblem(chainCaip2: string, publishedPurchaseCount: number): string | null {
  if (chainCaip2 === MONAD_CAIP2 && MONAD_311_STATUS === "FAIL") {
    return `Monad 3.11.0 is FAIL; do not announce Monad purchases`;
  }
  if (!ANNOUNCE_ALLOWED_CHAINS.has(chainCaip2)) return `${chainCaip2} is not a 3.11 lane; do not announce purchases on it`;
  if (publishedPurchaseCount <= 0) {
    return `no published purchase rows on ${chainCaip2}; do not announce purchases on it`;
  }
  return null;
}

/** The check an announcer runs: the count comes from the public ledger under dataDir. */
export function firstPurchaseAnnounceFromLedgerProblem(chainCaip2: string, dataDir: string): { problem: string | null; published: number } {
  const published = publishedEvmPurchaseCounts(dataDir).get(chainCaip2) ?? 0;
  return { problem: firstPurchaseAnnounceProblem(chainCaip2, published), published };
}
