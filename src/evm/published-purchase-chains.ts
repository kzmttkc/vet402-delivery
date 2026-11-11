/**
 * 3.11-5 and 3.11-7: what the public purchase ledger holds per EVM chain, read from the published lane files
 * (data/evm/<lane>.json, written by scripts/evm-publish.ts), and the checks that use it before a public text
 * states a purchase-chain count or another session is told a chain has purchases.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MONAD_311_STATUS } from "./311-memo.js";
import { publicChainCountClaimProblem, PRODUCT_PURCHASE_CHAIN_TARGET } from "./evm-pay-gates.js";

const HEX_TX = /^0x[0-9a-fA-F]{64}$/;

/** Published purchases (rows with a settlement tx) per CAIP-2, from every data/evm/<lane>.json. */
export function publishedEvmPurchaseCounts(dataDir: string): Map<string, number> {
  const out = new Map<string, number>();
  const dir = join(dataDir, "evm");
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    const j = JSON.parse(readFileSync(join(dir, name), "utf8")) as { kind?: string; chain?: string; rows?: { settlementTx?: string | null }[] };
    if (j.kind !== "vet402-evm-lane" || typeof j.chain !== "string") continue;
    const n = (j.rows ?? []).filter((r) => typeof r.settlementTx === "string" && HEX_TX.test(r.settlementTx)).length;
    out.set(j.chain, (out.get(j.chain) ?? 0) + n);
  }
  return out;
}

/** CAIP-2 of each EVM chain with at least one published purchase. */
export function publishedEvmPurchaseChains(dataDir: string): string[] {
  return [...publishedEvmPurchaseCounts(dataDir)].filter(([, n]) => n > 0).map(([c]) => c).sort();
}

/** Fail-closed guard for one stated count. */
export function validatePublicPurchaseChainClaim(claimedChains: number, publishedPurchaseChains: readonly string[]): string | null {
  return publicChainCountClaimProblem(claimedChains, publishedPurchaseChains);
}

export function maxClaimablePublicPurchaseChainsWhileMonadFail(): number {
  return MONAD_311_STATUS === "FAIL" ? 10 : PRODUCT_PURCHASE_CHAIN_TARGET;
}

const NUMBER_WORDS: Record<string, number> = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15 };
/** "12 chains", "twelve purchase chains", "11 EVM networks", "12 blockchains" (tags stripped first). */
const COUNT_CLAIM = /\b(\d{1,3}|ten|eleven|twelve|thirteen|fourteen|fifteen)(?:\s|&nbsp;|-)+(?:(?:evm|purchase|payment|public|supported)(?:\s|&nbsp;|-)+)?(?:block)?(?:chains|networks)\b/gi;

/** Every purchase-chain count a public text states. */
export function chainCountClaimsInCopy(text: string): number[] {
  const plain = text.replace(/<[^>]*>/g, " ");
  return [...plain.matchAll(COUNT_CLAIM)].map((m) => {
    const w = m[1]!.toLowerCase();
    return NUMBER_WORDS[w] ?? Number(w);
  });
}

/** The first count in `text` that the public ledger does not allow, with where it came from; null when none. */
export function publicCopyChainCountProblem(where: string, text: string, publishedPurchaseChains: readonly string[]): string | null {
  for (const n of chainCountClaimsInCopy(text)) {
    const p = publicChainCountClaimProblem(n, publishedPurchaseChains);
    if (p) return `${where}: ${p}`;
  }
  return null;
}

/** Throws before the public site is written when any page states a count the ledger does not allow. */
export function assertPublicPagesChainCounts(pages: Iterable<[string, string]>, publishedPurchaseChains: readonly string[]): void {
  const bad = [...pages].map(([rel, body]) => publicCopyChainCountProblem(rel, body, publishedPurchaseChains)).filter((x): x is string => x !== null);
  if (bad.length) throw new Error(`refusing to write the site: ${bad.join("; ")}`);
}
