/**
 * Print why a deposit request must not be sent, or exit 0 when allowed.
 * Usage: npx tsx scripts/deposit-request-gate.ts <caip2> <wallet_registry.json> <funding_check/latest.json>
 * (or VET402_WALLET_REGISTRY and VET402_FUNDING_LATEST). A missing path reads as missing: the request is refused.
 */
import { readFileSync, existsSync } from "node:fs";
import { walletRegistryChainsFromRegistryJson } from "../src/evm/evm-pay-gates.js";
import { depositRequestCopyProblem, type FundingCheckLatest } from "../src/evm/funding-request-gate.js";

const caip2 = process.argv[2];
if (!caip2) throw new Error("usage: deposit-request-gate.ts <caip2> <registry> <latest.json>");
const registryPath = process.argv[3] ?? process.env.VET402_WALLET_REGISTRY ?? null;
const latestPath = process.argv[4] ?? process.env.VET402_FUNDING_LATEST ?? null;

let chains: string[] = [];
try {
  chains = registryPath ? walletRegistryChainsFromRegistryJson(readFileSync(registryPath, "utf8")) : [];
} catch {
  chains = [];
}

let latest: FundingCheckLatest | null | "missing" = "missing";
if (latestPath && existsSync(latestPath)) {
  try {
    latest = JSON.parse(readFileSync(latestPath, "utf8")) as FundingCheckLatest;
  } catch {
    latest = { unreadable: true };
  }
}

const problem = depositRequestCopyProblem(caip2, chains, latest, Date.now());
if (problem) {
  console.error(problem);
  process.exit(2);
}
console.log(`deposit copy allowed for ${caip2}`);
