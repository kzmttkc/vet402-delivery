/**
 * Before copy that asks for a deposit: wallet registry, funding_need latest.json, Monad FAIL block.
 */
import { monadFundingGateProblem } from "./evm-pay-gates.js";
import { fundingRegistryGate } from "./chains.js";

export interface FundingCheckLatest {
  need_deposit?: boolean;
  unreadable?: boolean;
  generatedAt?: string;
  chains?: Record<string, unknown>;
}

export function fundingLatestAgeProblem(generatedAt: string | undefined, nowMs: number, maxAgeMs = 60 * 60 * 1000): string | null {
  if (!generatedAt?.trim()) return "funding_need latest.json has no generatedAt";
  const t = Date.parse(generatedAt);
  if (Number.isNaN(t)) return `funding_need latest.json generatedAt unreadable: ${generatedAt}`;
  if (nowMs - t > maxAgeMs) return `funding_need latest.json is older than ${maxAgeMs} ms`;
  return null;
}

/** Why a deposit request must not be emitted yet. null when copy may proceed. */
export function depositRequestCopyProblem(
  caip2: string,
  registeredChains: readonly string[],
  latest: FundingCheckLatest | null | "missing",
  nowMs: number,
): string | null {
  const monad = monadFundingGateProblem(caip2, registeredChains);
  if (monad) return monad;
  const reg = fundingRegistryGate(caip2, registeredChains);
  if (reg) return reg;
  if (latest === "missing" || latest === null) return "funding_need latest.json is missing; do not request a deposit";
  if (latest.unreadable) return "funding_need latest.json is unreadable; do not request a deposit";
  if (latest.need_deposit !== true) return "funding_need latest.json need_deposit is not true; do not request a deposit";
  const age = fundingLatestAgeProblem(latest.generatedAt, nowMs);
  if (age) return age;
  return null;
}
