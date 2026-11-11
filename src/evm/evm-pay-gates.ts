/**
 * 3.11 Polygon pay gates: owner approval on disk (not env alone), wallet registry,
 * Tempo shared-payer outflow stop, legal-check memo, independent SHIP. Pure readers.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PAYER_ADDRESS } from "../tempo/constants.js";
import { EXPECTED_ADDRESS } from "./key.js";
import { evmOutflowExceedsLedger } from "./evm-ledger-guard.js";
import { fundingRegistryGate } from "./chains.js";
import { MONAD_311_STATUS, monadPurchaseBlockedReason } from "./311-memo.js";
import { sharedEvmSignBlockedByTempo } from "./tempo-evm-payer-stop.js";
import { polygonDailyRootProblem, polygonPolSpendProblem, type PolSpend } from "./polygon-anchor.js";

export const POLYGON_CAIP2 = "eip155:137";

export function evmSharesTempoPayer(): boolean {
  return PAYER_ADDRESS.toLowerCase() === EXPECTED_ADDRESS.toLowerCase();
}

/** When Tempo and EVM share one payer, the same chain_spend_exceeds_ledger stop applies. */
export function sharedPayerOutflowStop(ledgerCommitted: bigint, chainSpent: bigint): string | null {
  if (!evmSharesTempoPayer()) return null;
  return evmOutflowExceedsLedger(ledgerCommitted, chainSpent);
}

export const POLYGON_OWNER_APPROVAL_KIND = "vet402-evm-polygon-owner-approval" as const;

export interface PolygonOwnerApprovalRecord {
  kind: typeof POLYGON_OWNER_APPROVAL_KIND;
  approvedTotalAtomic: string;
  approvedAt: string;
}

export function parsePolygonOwnerApproval(text: string): PolygonOwnerApprovalRecord | null {
  try {
    const x = JSON.parse(text) as PolygonOwnerApprovalRecord;
    if (x?.kind !== POLYGON_OWNER_APPROVAL_KIND) return null;
    if (!/^\d+$/.test(x.approvedTotalAtomic ?? "")) return null;
    if (!x.approvedAt?.trim()) return null;
    return x;
  } catch {
    return null;
  }
}

/**
 * Owner approval must be a record on disk. VET402_EVM_OWNER_APPROVED_TOTAL alone never passes,
 * even when it matches the planned total.
 */
export function ownerPayApprovalProblem(
  plannedTotalAtomic: bigint,
  record: PolygonOwnerApprovalRecord | null,
  env: Record<string, string | undefined> = {},
): string | null {
  if (!record) {
    const envOnly = env.VET402_EVM_OWNER_APPROVED_TOTAL?.trim();
    if (envOnly && /^\d+$/.test(envOnly) && BigInt(envOnly) === plannedTotalAtomic) {
      return `planned total ${plannedTotalAtomic} atomic USDC; owner approval record missing (VET402_EVM_OWNER_APPROVED_TOTAL alone is not approval)`;
    }
    return `planned total ${plannedTotalAtomic} atomic USDC; owner approval record missing`;
  }
  if (BigInt(record.approvedTotalAtomic) !== plannedTotalAtomic) {
    return `owner approval record ${record.approvedTotalAtomic} != planned total ${plannedTotalAtomic}`;
  }
  return null;
}

export function legalCheckMemoProblem(text: string | null | undefined): string | null {
  if (!text?.trim()) return "polygon --pay needs legal-check memo on disk before signing";
  return null;
}

export function independentReviewShipProblem(text: string | null | undefined, canonicalText?: string | null): string | null {
  const raw = text?.trim();
  if (!canonicalText?.trim()) {
    return "polygon --pay needs the independent review artifact on disk (VET402_REVIEW_DIR/polygon-review-ship.txt)";
  }
  if (!raw) return "polygon --pay needs independent review SHIP before signing";
  const line = raw.split(/\s/)[0]?.trim();
  if (line !== "SHIP") return "polygon --pay needs independent review SHIP before signing";
  const lines = raw.split(/\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return "polygon --pay needs the full independent review artifact, not a one-word SHIP";
  if (!/polygon|eip155:137/i.test(raw)) return "polygon --pay needs independent review scoped to Polygon (eip155:137)";
  if (raw !== canonicalText.trim()) {
    return "polygon review ship copy must match the independent review artifact on disk";
  }
  return null;
}

export function walletRegistryChainsFromRegistryJson(text: string): string[] {
  const j = JSON.parse(text) as { chains?: Record<string, unknown> };
  return Object.keys(j.chains ?? {}).sort();
}

/** Monad must not be funded for purchase while 3.11.0 is FAIL. */
export function monadFundingGateProblem(caip2: string, registeredChains: readonly string[]): string | null {
  if (caip2 === "eip155:143" && MONAD_311_STATUS === "FAIL") return monadPurchaseBlockedReason();
  return fundingRegistryGate(caip2, registeredChains);
}

export interface PolygonPayGateInput {
  plannedTotalAtomic: bigint;
  ownerApproval: PolygonOwnerApprovalRecord | null;
  env: Record<string, string | undefined>;
  legalCheckMemo: string | null;
  reviewShip: string | null;
  /** When set, reviewShip must match this text (the independent review file body). */
  reviewShipCanonical?: string | null;
  legalCheckCanonical?: string | null;
  registeredChains: readonly string[];
  ledgerCommitted: bigint | null;
  chainSpent: bigint | null;
  haltPayBody?: string | null;
  lastTempoStopReason?: string | null;
  /** When true, every stop that applies before --pay / signing is enforced. */
  paying: boolean;
  /** Roots lanes with a daily-root path (default ROOTS_LANES). */
  rootsLanes?: readonly string[];
  /**
   * POL that left the payer on Polygon against the POL ledger (src/evm/polygon-anchor.ts measurePolygonPolSpend).
   * The payer pays the Polygon daily root, so its fee is on that ledger. Unmeasured, a paying run stops.
   */
  polSpend?: PolSpend | null;
}

/** All gates that must pass before Polygon --pay or EIP-3009 signing. Monad FAIL does not block Polygon. */
export function polygonPayGateProblem(input: PolygonPayGateInput): string | null {
  const tempo = sharedEvmSignBlockedByTempo({ haltPayBody: input.haltPayBody, lastTempoStopReason: input.lastTempoStopReason });
  if (tempo) return tempo;
  const reg = fundingRegistryGate(POLYGON_CAIP2, input.registeredChains);
  if (reg) return reg;
  // Outflow beyond the Polygon ledger stops the lane whether or not Tempo shares the payer.
  if (input.ledgerCommitted !== null && input.chainSpent !== null) {
    const out = evmOutflowExceedsLedger(input.ledgerCommitted, input.chainSpent);
    if (out) return out;
  } else if (input.paying) {
    return "Polygon USDC outflow from the payer was not measured against the Polygon ledger";
  }
  // POL (daily-root fees) that left the payer outside the POL ledger stops the lane the same way.
  if (input.polSpend) {
    const pol = polygonPolSpendProblem(input.polSpend);
    if (pol) return pol;
  } else if (input.paying) {
    return "Polygon POL outflow from the payer was not measured against the POL ledger";
  }
  if (!input.paying) return null;
  const approval = ownerPayApprovalProblem(input.plannedTotalAtomic, input.ownerApproval, input.env);
  if (approval) return approval;
  const legal = legalCheckMemoProblemWithCanonical(input.legalCheckMemo, input.legalCheckCanonical ?? null);
  if (legal) return legal;
  const ship = independentReviewShipProblem(input.reviewShip, input.reviewShipCanonical);
  if (ship) return ship;
  // Last: with every other gate met, a purchase day must still be able to get its root on Polygon.
  const root = polygonDailyRootProblem(input.rootsLanes);
  if (root) return root;
  return null;
}

/** The wallet registry (read-only). No default: unset, the registry reads as empty and a deposit or --pay stops. */
export function walletRegistryPath(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.VET402_WALLET_REGISTRY?.trim() || null;
}

export function readTextIfExists(path: string | null): string | null {
  if (!path || !existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

/**
 * Polygon gate files: the copies beside the EVM results dir, and the independent review and legal-check files in
 * VET402_REVIEW_DIR (written by the reviewer, outside this repository). Unset, the canonical files read as missing
 * and --pay stops.
 */
export function polygonGatePaths(resultsDir: string, env: NodeJS.ProcessEnv = process.env): {
  ownerApproval: string;
  legalCheck: string;
  reviewShip: string;
  reviewShipCanonical: string | null;
  legalCheckCanonical: string | null;
} {
  const review = env.VET402_REVIEW_DIR?.trim() || null;
  return {
    ownerApproval: join(resultsDir, "polygon-owner-approval.json"),
    legalCheck: join(resultsDir, "polygon-legal-check.memo"),
    reviewShip: join(resultsDir, "polygon-review-ship.txt"),
    reviewShipCanonical: review ? join(review, "polygon-review-ship.txt") : null,
    legalCheckCanonical: review ? join(review, "polygon-legal-check.memo") : null,
  };
}

/** Legal-check must be non-empty and match the canonical memo when that file exists. */
export function legalCheckMemoProblemWithCanonical(text: string | null | undefined, canonical: string | null): string | null {
  if (!canonical?.trim()) {
    return "polygon --pay needs the independent legal-check memo on disk (VET402_REVIEW_DIR/polygon-legal-check.memo)";
  }
  const base = legalCheckMemoProblem(text);
  if (base) return base;
  if (text?.trim() !== canonical.trim()) {
    return "polygon legal-check copy must match the independent legal-check memo on disk";
  }
  return null;
}

/**
 * Product plan: the public purchase-chain count is 12 only after Robinhood Chain, Polygon and Monad are all on the
 * public purchase ledger. 3.8b's 10 stays the IG 10: adding Robinhood (or Polygon) to it to say 11 is not a count
 * the plan has. L0 byChain had 12 rows on 2026-11-09, but that is not this 12.
 */
export const PRODUCT_PURCHASE_CHAIN_TARGET = 12;
export const IG_PURCHASE_CHAIN_COUNT = 10;
/** The chains the 12 adds to the IG 10: Robinhood Chain, Polygon, Monad. */
export const PRODUCT_ADDED_PURCHASE_CHAINS = ["eip155:4663", POLYGON_CAIP2, "eip155:143"] as const;

/**
 * Why a public text must not state this purchase-chain count, or null. `publishedPurchaseChains` is the CAIP-2 of
 * every chain with a purchase on the public ledger (publishedEvmPurchaseChains for the EVM lanes).
 */
export function publicChainCountClaimProblem(claimedPublicPurchaseChains: number, publishedPurchaseChains: readonly string[]): string | null {
  const n = claimedPublicPurchaseChains;
  if (n <= IG_PURCHASE_CHAIN_COUNT) return null;
  if (n === IG_PURCHASE_CHAIN_COUNT + 1) {
    return `do not claim ${n} public purchase chains: the IG count stays ${IG_PURCHASE_CHAIN_COUNT} (Robinhood is not added to it), and the next published count is ${PRODUCT_PURCHASE_CHAIN_TARGET}`;
  }
  if (n !== PRODUCT_PURCHASE_CHAIN_TARGET) return `do not claim ${n} public purchase chains: the product count is ${PRODUCT_PURCHASE_CHAIN_TARGET}`;
  if (MONAD_311_STATUS === "FAIL") {
    return `do not claim ${n} public purchase chains while Monad 3.11.0 is FAIL and has 0 published purchases`;
  }
  const missing = PRODUCT_ADDED_PURCHASE_CHAINS.filter((c) => !publishedPurchaseChains.includes(c));
  if (missing.length) return `do not claim ${n} public purchase chains: no published purchase on ${missing.join(", ")}`;
  return null;
}
