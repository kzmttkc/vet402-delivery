/**
 * The EVM chains vet402 buys on, and the money limits of each purchase lane.
 * Changing any value here changes what money can move.
 *
 * One payer wallet (0x9B59…4E51, see key.ts) is shared by every EVM chain, so "the same buyer, only the
 * chain differs" holds by construction. Each lane keeps its own ledger file and its own caps, so a spend
 * on one chain never uses up (or hides) the budget of another.
 */
import { getAddress, type Address } from "viem";

export type EvmChainKey = "base" | "arbitrum" | "robinhood";

export interface EvmChainSpec {
  key: EvmChainKey;
  label: string;
  caip2: string;
  chainId: number;
  /** x402 v1 network names that mean this chain. */
  v1Names: readonly string[];
  /** Public RPC used when the env var is unset. Reads only; nothing here sends. */
  rpc: string;
  rpcEnv: string;
  /** The one token vet402 pays with on this chain. */
  asset: Address;
  assetSymbol: string;
  assetDecimals: number;
  /** EIP-712 domain of that token (read from the chain by the scripts before any signature). */
  domain: { name: string; version: string };
  /** @x402/evm lists this asset as the chain's default (then its USD spend cap applies). */
  libraryDefaultAsset: boolean;
  explorerTx: string;
  /** The daily root tx: above this gas limit or this total fee (gas x maxFeePerGas, wei) nothing is signed. */
  anchorMaxGas: bigint;
  anchorMaxFeeWei: bigint;
}

export const EVM_CHAINS: Record<EvmChainKey, EvmChainSpec> = {
  base: {
    key: "base",
    label: "Base",
    caip2: "eip155:8453",
    chainId: 8453,
    v1Names: ["base"],
    rpc: "https://base-rpc.publicnode.com",
    rpcEnv: "BASE_RPC_URL",
    asset: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
    assetSymbol: "USDC",
    assetDecimals: 6,
    domain: { name: "USD Coin", version: "2" },
    libraryDefaultAsset: true,
    explorerTx: "https://basescan.org/tx/",
    anchorMaxGas: 60_000n,
    anchorMaxFeeWei: 10_000_000_000_000n,
  },
  arbitrum: {
    key: "arbitrum",
    label: "Arbitrum One",
    caip2: "eip155:42161",
    chainId: 42161,
    v1Names: ["arbitrum"],
    rpc: "https://arb1.arbitrum.io/rpc",
    rpcEnv: "ARBITRUM_RPC_URL",
    asset: getAddress("0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
    assetSymbol: "USDC",
    assetDecimals: 6,
    domain: { name: "USD Coin", version: "2" },
    libraryDefaultAsset: true,
    explorerTx: "https://arbiscan.io/tx/",
    // 2026-09-30 quote: 23,914 gas x 0.02004 gwei = 4.79e11 wei. The cap is about 20x that.
    anchorMaxGas: 60_000n,
    anchorMaxFeeWei: 10_000_000_000_000n,
  },
  robinhood: {
    key: "robinhood",
    label: "Robinhood Chain",
    caip2: "eip155:4663",
    chainId: 4663,
    v1Names: ["robinhood"],
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    rpcEnv: "ROBINHOOD_RPC_URL",
    /** Global Dollar (USDG, Paxos). EIP-3009 transferWithAuthorization and DOMAIN_SEPARATOR checked by eth_call on 2026-09-30. */
    asset: getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
    assetSymbol: "USDG",
    assetDecimals: 6,
    domain: { name: "Global Dollar", version: "1" },
    libraryDefaultAsset: false,
    explorerTx: "https://robinhoodchain.blockscout.com/tx/",
    // 2026-09-30 quote: 23,686 gas x 0.023712 gwei = 5.62e11 wei. The cap is about 18x that.
    anchorMaxGas: 60_000n,
    anchorMaxFeeWei: 10_000_000_000_000n,
  },
};

export function chainByCaip2(network: string): EvmChainSpec | null {
  return Object.values(EVM_CHAINS).find((c) => c.caip2 === network || c.v1Names.includes(network)) ?? null;
}

export type LaneId = "robinhood" | "arbitrum" | "base-compare";

/**
 * A purchase lane: one chain, one ledger, its own caps. The existing Base lane (scripts/base-buy.ts,
 * results/base-ledger.json, 0.10 / 1.00 / 10) is not one of these and is untouched.
 */
export interface LaneSpec {
  id: LaneId;
  chain: EvmChainKey;
  ledger: string;
  maxPerAtomic: bigint;
  maxTotalAtomic: bigint;
  maxCount: number;
  /** --pay also needs this value in VET402_EVM_PAY (comma-separated). One value per lane, so allowing one lane never allows another. */
  payGate: string;
  /** The lane's purchases get a daily root on its chain (scripts/evm-anchor.ts), so a paying run needs ETH for it. */
  anchored: boolean;
}

/** Which lanes a --pay run touches. The Arbitrum run buys on Arbitrum AND on Base (the side-by-side). */
export const RUN_LANES: Record<"robinhood" | "arbitrum", LaneId[]> = { robinhood: ["robinhood"], arbitrum: ["arbitrum", "base-compare"] };

/** Pure. null when every lane the run pays on is named in VET402_EVM_PAY; else what is missing. */
/** Pure. Why a paying run must not start on this lane, or null: token for the planned total, ETH for one anchor. */
export function fundingProblem(lane: LaneSpec, plannedAtomic: bigint, assetAtomic: bigint, ethWei: bigint): string | null {
  const c = EVM_CHAINS[lane.chain];
  const capped = plannedAtomic > lane.maxTotalAtomic ? lane.maxTotalAtomic : plannedAtomic;
  if (assetAtomic < capped) return `lane ${lane.id}: ${c.assetSymbol} balance ${assetAtomic} < planned ${capped}`;
  if (lane.anchored && ethWei < c.anchorMaxFeeWei) return `lane ${lane.id}: ETH ${ethWei} wei < ${c.anchorMaxFeeWei} wei kept for the daily root on ${c.label}`;
  return null;
}

export function payGateProblem(run: "robinhood" | "arbitrum", env: string | undefined): string | null {
  const allowed = new Set((env ?? "").split(",").map((x) => x.trim()).filter(Boolean));
  const need = RUN_LANES[run].map((l) => LANES[l].payGate);
  const missing = need.filter((g) => !allowed.has(g));
  return missing.length ? `--pay --lane ${run} pays on ${need.join(" and ")}; VET402_EVM_PAY must name each (missing: ${missing.join(", ")}). Example: VET402_EVM_PAY=${need.join(",")}` : null;
}

export const LANES: Record<LaneId, LaneSpec> = {
  /** Every payTo that declares Robinhood Chain in its live 402, once, plus the stock-data check. */
  robinhood: { id: "robinhood", chain: "robinhood", ledger: "results/evm/robinhood-ledger.json", maxPerAtomic: 100_000n, maxTotalAtomic: 1_000_000n, maxCount: 20, payGate: "robinhood", anchored: true },
  /** Every payTo that declares Arbitrum One with the same address as its Base accept, once. */
  arbitrum: { id: "arbitrum", chain: "arbitrum", ledger: "results/evm/arbitrum-ledger.json", maxPerAtomic: 100_000n, maxTotalAtomic: 2_000_000n, maxCount: 90, payGate: "arbitrum", anchored: true },
  /** The same payTo and endpoint on Base, the same UTC day, for the side-by-side table. */
  "base-compare": { id: "base-compare", chain: "base", ledger: "results/evm/base-compare-ledger.json", maxPerAtomic: 100_000n, maxTotalAtomic: 1_500_000n, maxCount: 81, payGate: "base-compare", anchored: false },
};
