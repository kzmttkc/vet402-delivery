/**
 * Base purchases from 0x9B59 to ERC-8004-registered sellers vet402 already saw deliver.
 *
 *   npx tsx scripts/base-buy.ts --dry-run [--agents 94639,...]   (default; throwaway signer, nothing sent)
 *   VET402_BASE_PAY=yes npx tsx scripts/base-buy.ts --pay [--agents ...]
 *
 * Dry run: plan, unpaid 402, all checks, a signature from a throwaway key (read back and verified), stop.
 * The real key (.keys/evm.json) is read only with --pay AND VET402_BASE_PAY=yes.
 * Outputs: results/base-buy-dryrun.json | results/base-purchases.jsonl + results/base-ledger.json (--pay).
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createPublicClient, erc20Abi, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { CDP_DISCOVERY, MAX_PURCHASES } from "../src/constants.js";
import { fetchCatalog } from "../src/discovery.js";
import { Budget } from "../src/guard.js";
import { buyOne, probeBase402, pickBaseAccept, USDC_DOMAIN, type BuyRecord, type TypedDataSigner } from "../src/evm/base-buy.js";
import { DEFAULT_AGENT_IDS, parseCsv, planCandidates, VET402_EXPORT, type AgentInfo, type ExportRow } from "../src/evm/base-candidates.js";
import { BASE_USDC, identityAbi, readUsdcTransfer, CHAINS } from "../src/evm/erc8004.js";
import { loadEvmAccount, readPublicAddress } from "../src/evm/key.js";

const argv = process.argv.slice(2);
const pay = argv.includes("--pay");
if (pay && argv.includes("--dry-run")) throw new Error("choose one of --dry-run / --pay");
if (pay && process.env.VET402_BASE_PAY !== "yes") throw new Error("--pay also needs VET402_BASE_PAY=yes (set only after the independent review)");
const agentsArg = argv[argv.indexOf("--agents") + 1];
const agentIds = argv.includes("--agents") && agentsArg ? agentsArg.split(",").filter((s) => /^\d+$/.test(s)) : DEFAULT_AGENT_IDS;

const reader = createPublicClient({ chain: base, transport: http(process.env.BASE_RPC_URL ?? "https://base-rpc.publicnode.com") }) as PublicClient;
const receipts = createPublicClient({ chain: base, transport: http(process.env.BASE_RECEIPT_RPC_URL ?? "https://mainnet.base.org") }) as PublicClient;
const payer: Address = readPublicAddress();
const ID = CHAINS.base.identityRegistry;

// The EIP-712 domain the fence insists on must be the token's own.
const tokenAbi = parseAbi(["function name() view returns (string)", "function version() view returns (string)"]);
const [tName, tVersion] = await Promise.all([
  reader.readContract({ address: BASE_USDC, abi: tokenAbi, functionName: "name" }),
  reader.readContract({ address: BASE_USDC, abi: tokenAbi, functionName: "version" }),
]);
if (tName !== USDC_DOMAIN.name || tVersion !== USDC_DOMAIN.version) throw new Error(`Base USDC domain is ${tName}/${tVersion}`);

async function readAgent(id: string): Promise<AgentInfo> {
  try {
    const owner = await reader.readContract({ address: ID, abi: identityAbi, functionName: "ownerOf", args: [BigInt(id)] });
    const agentWallet = await reader.readContract({ address: ID, abi: identityAbi, functionName: "getAgentWallet", args: [BigInt(id)] });
    return { agentId: id, owner, agentWallet };
  } catch {
    return { agentId: id, owner: null, agentWallet: null };
  }
}

const agents: AgentInfo[] = [];
for (const id of agentIds) agents.push(await readAgent(id));
const catalog = await fetchCatalog(CDP_DISCOVERY, { pageLimit: 1000, sleepMs: 300 });
const csv = await fetch(VET402_EXPORT, { signal: AbortSignal.timeout(60_000) });
if (!csv.ok) throw new Error(`vet402 export: HTTP ${csv.status}`);
const rows = parseCsv(await csv.text()) as unknown as ExportRow[];
const candidates = planCandidates(agents, catalog.items, rows);

// Confirm the lock against the seller's live unpaid 402 (no payment; same request vet402 made).
for (const c of candidates) {
  if (!c.chosen) continue;
  const p = await probeBase402(c.chosen.entry, fetch);
  const a = pickBaseAccept(p.accepts, c.chosen.entry.lock.payTo);
  (c as { live402?: unknown }).live402 = { status: p.status, payTo: a?.payTo ?? null, amount: a?.amount ?? null, error: p.error };
  if (a) c.chosen.entry.lock = { payTo: a.payTo, amount: a.amount };
}

const usdcBalance = () => reader.readContract({ address: BASE_USDC, abi: erc20Abi, functionName: "balanceOf", args: [payer] });

async function verifySettlement(tx: Hex, payTo: string, amount: string) {
  for (let i = 0; i < 20; i++) {
    try {
      const r = await readUsdcTransfer(receipts, tx, { to: payTo as Address, amountUnits: amount });
      return { ok: r.ok, from: r.from, reason: r.reason, blockNumber: r.blockNumber?.toString() };
    } catch {
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
  return { ok: false, reason: "receipt not found in 60 s" };
}

let signer: TypedDataSigner;
let budget: Budget;
if (pay) {
  signer = loadEvmAccount();
  budget = new Budget("results/base-ledger.json");
} else {
  signer = privateKeyToAccount(generatePrivateKey()); // throwaway: its signature pays nobody
  budget = new Budget(null);
}

const entries = candidates.flatMap((c) => (c.chosen ? [c.chosen.entry] : [])).slice(0, MAX_PURCHASES);
const records: BuyRecord[] = [];
mkdirSync("results", { recursive: true });
for (const e of entries) {
  const rec = await buyOne(e, {
    fetch,
    payer,
    signer,
    budget,
    readUsdcBalance: usdcBalance,
    readAgentWallet: (id) => reader.readContract({ address: ID, abi: identityAbi, functionName: "getAgentWallet", args: [BigInt(id)] }),
    verifySettlement,
    dryRun: !pay,
  });
  records.push(rec);
  if (pay) appendFileSync("results/base-purchases.jsonl", JSON.stringify(rec) + "\n");
}

const summary = {
  generatedAt: new Date().toISOString(),
  mode: pay ? "pay" : "dry-run",
  payer,
  usdcBalanceAtomic: (await usdcBalance()).toString(),
  catalog: { items: catalog.items.length, complete: catalog.complete },
  vet402ExportRows: rows.length,
  candidates: candidates.map((c) => ({
    agentId: c.agentId,
    agentWallet: c.agentWallet,
    owner: c.owner,
    bazaarListingsToWallet: c.listings,
    vet402DeliveredListings: c.deliveredListings,
    excluded: c.excluded ?? null,
    chosen: c.chosen
      ? {
          resource: c.chosen.resource,
          method: c.chosen.method,
          priceAtomic: c.chosen.priceAtomic,
          payTo: c.chosen.payTo,
          payToIsAgentWallet: c.chosen.payToIsAgentWallet,
          vet402LastDelivery: c.chosen.vet402LastDelivery,
          simpleRequest: c.chosen.simpleRequest,
          live402: (c as { live402?: unknown }).live402,
        }
      : null,
  })),
  records,
  budget: { spentAtomic: budget.spent.toString(), count: budget.count },
};
if (!pay) writeFileSync("results/base-buy-dryrun.json", JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
