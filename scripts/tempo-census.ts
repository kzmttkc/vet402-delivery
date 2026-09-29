/**
 * vet402 Tempo census: buy each Mercator service on Tempo once and show whether it delivered.
 *
 *   npx tsx scripts/tempo-census.ts --dry-run [--limit N] [--out file]
 *       Enumerate Mercator, pick one Tempo USDC.e endpoint per service, read its unpaid 402
 *       (price, token, recipient, feePayer), total the cost. Signs nothing. Writes a plan.
 *
 *   npx tsx scripts/tempo-census.ts --pay --plan results/tempo-census-<date>.dry-run.json
 *       [--cap 2.00] [--max N] [--key <repo>/.keys/evm.json] [--ledger results/tempo-ledger.json]
 *       Pays each planned endpoint once. Guards: <= 0.10 USDC.e per call, total cap (<= 5.00,
 *       counted as max(ledger, on-chain outflow)), recipient and price locked to the dry run,
 *       Tempo mainnet 4217 only, USDC.e only, no splits, persistent ledger written before signing,
 *       signed tx decoded and checked before it leaves the process.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_TOTAL_CAP_ATOMIC,
  MAX_TOTAL_ATOMIC,
  PAYER_ADDRESS,
  TEMPO_EXPLORER_TX,
  atomicToUnits,
} from "../src/tempo/constants.js";
import { runCensus, type CensusReport, type PlanEntry } from "../src/tempo/census.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(name);

function usdToAtomic(s: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new Error(`bad amount ${s}`);
  const [w, f = ""] = s.split(".");
  return BigInt(w!) * 1_000_000n + BigInt(f.padEnd(6, "0"));
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));

function printDryRun(rep: CensusReport, out: string): void {
  const tempo = rep.rows.filter((r) => r.rail === "tempo");
  console.log(`\nMercator catalog: ${rep.mercatorCatalog.serviceCount} services / ${rep.mercatorCatalog.endpointCount} endpoints (generated ${rep.mercatorCatalog.generatedAt}, ranking ${rep.mercatorCatalog.rankingStrategy})`);
  console.log(`described ${rep.counts.described}: ${Object.entries(rep.counts).filter(([k]) => k.startsWith("rail_")).map(([k, v]) => `${k.slice(5)} ${v}`).join(", ")}`);
  console.log(`\n${pad("service", 34)} ${pad("rank", 5)} ${pad("tier", 9)} ${pad("http", 4)} ${pad("price", 10)} ${pad("token", 7)} ${pad("fee", 9)} verdict`);
  const sorted = [...tempo].sort((a, b) => (a.rank?.bestRank ?? 99) - (b.rank?.bestRank ?? 99) || a.serviceId.localeCompare(b.serviceId));
  for (const r of sorted) {
    const price = r.live ? atomicToUnits(r.live.amount) : r.catalogAmount ? `(${atomicToUnits(r.catalogAmount)})` : "-";
    const fee = r.live ? (r.live.feePayer ? "sponsor" : "self") : "-";
    console.log(
      `${pad(r.serviceId, 34)} ${pad(r.rank ? String(r.rank.bestRank) : "-", 5)} ${pad(r.rank?.tier ?? "-", 9)} ${pad(String(r.probe?.httpStatus ?? "-"), 4)} ${pad(price, 10)} ${pad(r.live?.token ?? "-", 7)} ${pad(fee, 9)} ${r.verdict}`,
    );
  }
  console.log("\ncounts", JSON.stringify(Object.fromEntries(Object.entries(rep.counts).filter(([k]) => k.startsWith("verdict_") || k.startsWith("payable") || k === "tempoProbed"))));
  console.log("tokens in live 402s", JSON.stringify(rep.tokensSeen));
  console.log("estimate", JSON.stringify(rep.estimate, null, 1));
  console.log(`\nwrote ${out}`);
}

async function dryRun(): Promise<void> {
  const limit = arg("--limit");
  const rep = await runCensus({
    fetchImpl: fetch,
    ...(limit ? { limit: Number(limit) } : {}),
    log: (s) => console.error(`[census] ${s}`),
  });
  const out = arg("--out") ?? join(ROOT, "results", `tempo-census-${rep.generatedAt.slice(0, 10)}.dry-run.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(rep, null, 2) + "\n");
  printDryRun(rep, out);
}

async function pay(): Promise<void> {
  // The key's one census ledger (src/tempo/key-ledgers.ts). Any other file would count the real census
  // ledger as "another ledger" of the key and pass the chain check: refused before anything else.
  const { TEMPO_KEY_LEDGERS, assertCensusLedger, unaccountedChainSpent } = await import("../src/tempo/key-ledgers.js");
  const ledgerPath = arg("--ledger") ?? join(ROOT, "results", "tempo-ledger.json");
  try {
    assertCensusLedger(ledgerPath, TEMPO_KEY_LEDGERS);
  } catch (e) {
    console.error(`[pay] ${(e as Error).message}. Run --pay where that ledger lives, or pass --ledger ${TEMPO_KEY_LEDGERS.census}.`);
    process.exit(2);
  }
  const planFile = arg("--plan");
  if (!planFile) throw new Error("--pay needs --plan <dry-run json>");
  const rep = JSON.parse(readFileSync(planFile, "utf8")) as CensusReport;
  if (rep.mode !== "dry-run" || !Array.isArray(rep.plan)) throw new Error("plan file is not a census dry-run");
  if (rep.payer.toLowerCase() !== PAYER_ADDRESS.toLowerCase()) throw new Error("plan was made for another payer");
  const cap = arg("--cap") ? usdToAtomic(arg("--cap")!) : DEFAULT_TOTAL_CAP_ATOMIC;
  if (cap > MAX_TOTAL_ATOMIC) throw new Error(`--cap above the hard ceiling ${atomicToUnits(MAX_TOTAL_ATOMIC)}`);
  const max = arg("--max") ? Number(arg("--max")) : rep.plan.length;

  // Network and key are loaded only on this path.
  const chain = await import("../src/tempo/chain.js");
  const { Ledger } = await import("../src/tempo/ledger.js");
  const { runPlan } = await import("../src/tempo/pay.js");
  await chain.assertMainnet();
  const keyFile = arg("--key") ?? process.env.VET402_EVM_KEY_FILE ?? join(ROOT, ".keys", "evm.json");
  const signer = chain.loadSigner(keyFile);
  const ledger = new Ledger(ledgerPath, PAYER_ADDRESS, cap, { lock: true });
  console.error(`[pay] payer ${signer.address} cap ${atomicToUnits(cap)} USDC.e, ledger committed ${atomicToUnits(ledger.committed())}`);

  const plan: PlanEntry[] = rep.plan.slice(0, max);
  try {
    const { stopped } = await runPlan(
      plan,
      {
        fetchImpl: fetch,
        signer,
        ledger,
        payer: PAYER_ADDRESS,
        balance: () => chain.usdcBalance(PAYER_ADDRESS),
        // The key also pays remeasure's day ledgers: outflow they account for is not this ledger's (src/tempo/key-ledgers.ts).
        chainSpent: unaccountedChainSpent(ledgerPath, () => chain.usdcOutflowSinceStart(PAYER_ADDRESS), PAYER_ADDRESS),
        verify: (h, e) => chain.verifySettlement(h, e),
      },
      (entry, o) => {
        const tx = o.txHash ? ` ${TEMPO_EXPLORER_TX}${o.txHash}` : "";
        const fee = o.feePaid ? ` fee ${o.feePaid}` : "";
        console.log(
          `${pad(entry.serviceId, 34)} ${o.result} ${o.refusal ? `${o.refusal.refused} (${o.refusal.detail})` : `http ${o.httpStatus} settled ${o.settled} delivered ${o.delivered}${fee}${tx}`}`,
        );
      },
    );
    if (stopped) {
      console.error(`[pay] STOPPED at ${stopped.serviceId}: ${stopped.reason}. Nothing further was signed.`);
      process.exitCode = 2;
    }
  } finally {
    ledger.release();
  }
}

if (has("--pay") && has("--dry-run")) throw new Error("choose --dry-run or --pay");
await (has("--pay") ? pay() : dryRun());
