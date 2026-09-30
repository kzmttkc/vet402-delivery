/**
 * Base purchases from 0x9B59 (x402 v2 `exact`, EIP-3009 TransferWithAuthorization only).
 *
 * Who is bought from: sellers that (1) vet402 has already bought from and got a delivery, and
 * (2) are registered in ERC-8004 on Base with agentWallet == the payTo vet402 paid. One purchase per agent.
 *
 * Money guards, all before any signature:
 *   0.10 USDC per purchase, 1.00 USDC total, 10 purchases, one per agent (persistent ledger, fail-closed),
 *   payTo locked to the on-chain agentWallet, price may drop but never rise, USDC on Base only,
 *   assetTransferMethod must be EIP-3009 (Permit2 / approve paths are refused: they can move funds on-chain
 *   from the wallet itself), maxTimeoutSeconds <= 3600.
 * The signer handed to the x402 client can only sign that one TransferWithAuthorization (see fencedSigner).
 * It has no transaction-sending capability at all.
 *
 * The code lives in evm-buy.ts with the chain as an argument; this file binds it to Base and keeps the
 * Base-only rule that payTo must be the agent's on-chain agentWallet.
 */
import type { PaymentRequired } from "@x402/core/types";
import type { Address, Hex } from "viem";
import type { Budget } from "../guard.js";
import { EVM_CHAINS } from "./chains.js";
import {
  AUTH_TYPES,
  MAX_TIMEOUT_SECONDS,
  buyOneOnChain,
  checkChainAccept,
  createChainPayment,
  fencedChainSigner,
  pickChainAccept,
  probe402,
  requestUrl,
  type ChainBuyRecord,
  type CreatedEvmPayment,
  type EvmAccept,
  type EvmRefusal,
  type SignLock,
  type TypedDataSigner,
} from "./evm-buy.js";

export { AUTH_TYPES, MAX_TIMEOUT_SECONDS, requestUrl };
export type { CreatedEvmPayment, EvmAccept, EvmRefusal, SignLock, TypedDataSigner };

const BASE = EVM_CHAINS.base;
export const BASE_CAIP2 = BASE.caip2;
export const BASE_CHAIN_ID = BASE.chainId;
/** Circle USDC on Base, EIP-712 domain (read from the token: name() = "USD Coin", version "2"). */
export const USDC_DOMAIN = BASE.domain;

/** Among a live 402's accepts, the Base USDC exact accept to the locked payTo (else the first Base one, so the check says why). */
export function pickBaseAccept(accepts: EvmAccept[], lockedPayTo: string): EvmAccept | null {
  return pickChainAccept(BASE, accepts, lockedPayTo);
}

export interface BaseAcceptContext {
  payer: string;
  /** payTo recorded at plan time from the unpaid 402. */
  lockedPayTo: string;
  lockedAmount?: string;
  /** getAgentWallet(agentId) read on Base. */
  agentWallet: string;
}

/** Every per-accept check. null = may go on to the budget. Pure. */
export function checkBaseAccept(a: EvmAccept | null, ctx: BaseAcceptContext): EvmRefusal | null {
  return checkChainAccept(BASE, a, ctx);
}

/**
 * Wrap a signer so it signs exactly one EIP-3009 TransferWithAuthorization: Base USDC domain, from the signer,
 * to the locked payTo, for the locked amount (<= 0.10), valid for at most MAX_TIMEOUT_SECONDS. Anything else throws.
 * No readContract / sendTransaction is exposed, so the x402 library cannot take the approve or Permit2 paths.
 */
export function fencedSigner(inner: TypedDataSigner, lock: SignLock): TypedDataSigner & { signed: number } {
  return fencedChainSigner(BASE, inner, lock);
}

/** Build the x402 payment for exactly `accept`, then read it back and verify the signature against the payer. */
export async function createBasePayment(signer: TypedDataSigner, pr: PaymentRequired, accept: EvmAccept): Promise<CreatedEvmPayment> {
  return createChainPayment(BASE, signer, pr, accept);
}

// ---------- one purchase ----------

export interface BuyEntry {
  agentId: string;
  resource: string;
  method: "GET" | "POST";
  /** Declared example input from the seller's own Bazaar listing (what vet402 sent when it got a delivery). */
  query: Record<string, string> | null;
  body: unknown;
  agentWallet: Address;
  /** From the unpaid 402 at plan time. */
  lock: { payTo: string; amount: string };
}

export interface BuyDeps {
  fetch: typeof fetch;
  payer: Address;
  signer: TypedDataSigner;
  budget: Budget;
  readUsdcBalance: () => Promise<bigint>;
  /** Re-read agentWallet right before paying. */
  readAgentWallet: (agentId: string) => Promise<Address>;
  /** Base tx -> USDC Transfer check (payer -> payTo, amount). */
  verifySettlement: (tx: Hex, payTo: string, amount: string) => Promise<{ ok: boolean; from?: string; reason?: string; blockNumber?: string }>;
  dryRun: boolean;
}

export type BuyRecord = ChainBuyRecord;

export async function probeBase402(e: BuyEntry, f: typeof fetch): Promise<{ status: number | null; pr: PaymentRequired | null; accepts: EvmAccept[]; error?: string }> {
  return probe402(e, f);
}

export async function buyOne(e: BuyEntry, deps: BuyDeps): Promise<BuyRecord> {
  return buyOneOnChain(BASE, e, {
    fetch: deps.fetch,
    payer: deps.payer,
    signer: deps.signer,
    budget: deps.budget,
    readAssetBalance: deps.readUsdcBalance,
    readAgentWallet: deps.readAgentWallet,
    verifySettlement: deps.verifySettlement,
    dryRun: deps.dryRun,
  });
}
