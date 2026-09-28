/**
 * Colosseum gate 1: do vet402's Solana payments settle, and does content come back,
 * for sellers listed only on PayAI's public discovery (host not in the CDP Bazaar)?
 *
 *   npx tsx scripts/gate1.ts --dry-run          # everything except paying; writes the plan
 *   npx tsx scripts/gate1.ts --pay              # pays the plan's 10 candidates once each
 *
 * Money limits (absolute, in src/constants.ts): 0.10 USDC per purchase, 1.00 USDC total,
 * 10 purchases, persisted in results/gate1-ledger.json.
 * Pass condition: >= 5 of 10 settled on chain AND returned content.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CDP_DISCOVERY, MAX_PURCHASES, PAYAI_DISCOVERY, PAYER_ADDRESS, atomicToUsdc } from "../src/constants.js";
import { fetchCatalog, selectPayaiOnly, type CatalogCandidate } from "../src/discovery.js";
import { Budget, checkAccept, pickSolanaAccept } from "../src/guard.js";
import { payOne, probe402, type PlanEntry, type PurchaseRecord } from "../src/pay.js";
import { jsonRpc, readBalances, waitForSettlement } from "../src/chain.js";
import { checkPaymentTransaction, usdcAta } from "../src/txcheck.js";
import { loadPayer, makeCreatePayment, throwawaySigner } from "../src/client.js";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const DATE = opt("--date") ?? "2026-09-29";
const RESULTS = join(ROOT, "results");
const PLAN_FILE = opt("--plan") ?? join(RESULTS, `gate1-${DATE}.dry-run.json`);
const OUT_FILE = join(RESULTS, `gate1-${DATE}.json`);
const LEDGER_FILE = join(RESULTS, "gate1-ledger.json");
const KEY_FILE = join(ROOT, ".keys", "payer.json");
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const N = MAX_PURCHASES;

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}

function writeJson(file: string, data: unknown) {
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

async function dryRun() {
  const rpc = jsonRpc(RPC_URL);
  const [payai, cdp] = await Promise.all([
    fetchCatalog(PAYAI_DISCOVERY, { pageLimit: 1000, sleepMs: 200 }),
    fetchCatalog(CDP_DISCOVERY, { pageLimit: 1000, sleepMs: 200 }),
  ]);
  if (!payai.complete || !cdp.complete) throw new Error("a catalogue did not finish paging; PayAI-only cannot be decided");
  const sel = selectPayaiOnly(payai.items, cdp.items);

  // Unpaid probe: up to 2 listings per host, until one returns a payable 402 that matches its listing.
  type HostProbe = { host: string; chosen: (CatalogCandidate & { lock: PlanEntry["lock"] }) | null; tried: { url: string; status: number | null; reason: string }[] };
  const probes = await pool(sel.hostOrder, 6, async (host): Promise<HostProbe> => {
    const tried: HostProbe["tried"] = [];
    for (const c of sel.byHost.get(host)!.slice(0, 2)) {
      const p = await probe402(c.requestUrl, fetch);
      if (p.status !== 402 || !p.paymentRequired) {
        tried.push({ url: c.requestUrl, status: p.status, reason: p.error ? "unparseable_or_error" : "not_402" });
        continue;
      }
      const a = pickSolanaAccept(p.accepts, c.declared.payTo);
      // Lock = the payTo the listing declares; the live 402 must agree.
      const r = checkAccept(a, { payer: PAYER_ADDRESS, lockedPayTo: c.declared.payTo });
      if (r) {
        tried.push({ url: c.requestUrl, status: 402, reason: r.refused });
        continue;
      }
      tried.push({ url: c.requestUrl, status: 402, reason: "ok" });
      return { host, chosen: { ...c, lock: { payTo: a!.payTo, amount: a!.amount, asset: a!.asset, network: a!.network, feePayer: String(a!.extra!.feePayer) } }, tried };
    }
    return { host, chosen: null, tried };
  });
  const funnel: Record<string, number> = {};
  for (const hp of probes) {
    const last = hp.chosen ? "ok" : (hp.tried.at(-1)?.reason ?? "none");
    funnel[last] = (funnel[last] ?? 0) + 1;
  }
  const ready = probes.filter((p) => p.chosen); // already in host rank order
  // One per host AND one per payTo (two hosts paying into the same wallet are one seller).
  const seenPayTo = new Set<string>();
  const picked: NonNullable<HostProbe["chosen"]>[] = [];
  for (const p of ready) {
    if (picked.length >= N) break;
    if (seenPayTo.has(p.chosen!.lock.payTo)) continue;
    seenPayTo.add(p.chosen!.lock.payTo);
    picked.push(p.chosen!);
  }

  // Everything except paying: same payOne path, throwaway signer, in-memory budget, nothing sent.
  const throwaway = await throwawaySigner();
  const budget = new Budget(null);
  const deps = {
    fetch,
    payer: PAYER_ADDRESS,
    signerAddress: throwaway.address,
    budget,
    dryRun: true,
    createPayment: makeCreatePayment(throwaway, RPC_URL),
    checkTx: checkPaymentTransaction,
    readBalances: () => readBalances(rpc, PAYER_ADDRESS),
    waitForSettlement: async () => null,
  };
  const candidates: (PlanEntry & { priceUsdc: string; exampleScore: number; dryRun: PurchaseRecord; x402Version?: number })[] = [];
  for (const c of picked) {
    const entry: PlanEntry = { host: c.host, requestUrl: c.requestUrl, exampleInput: c.exampleInput, lock: c.lock };
    const rec = await payOne(entry, deps);
    candidates.push({ ...entry, priceUsdc: atomicToUsdc(c.lock.amount), exampleScore: c.exampleScore, dryRun: rec, ...(c.x402Version ? { x402Version: c.x402Version } : {}) });
  }
  const bal = await readBalances(rpc, PAYER_ADDRESS);
  const out = {
    kind: "gate1-dry-run",
    createdAt: new Date().toISOString(),
    payer: PAYER_ADDRESS,
    payerBalances: { lamports: bal.lamports.toString(), usdc: atomicToUsdc(bal.usdcAtomic) },
    definition: "PayAI-only = listing host appears nowhere in the CDP Bazaar; GET; Solana mainnet USDC exact; price <= 0.10; one listing per host and per payTo",
    catalogue: { payaiTotal: payai.total, cdpTotal: cdp.total, ...sel.stats },
    probeFunnel: { hostsProbed: probes.length, byOutcome: funnel, payableHosts: ready.length, payableSellers: new Set(ready.map((p) => p.chosen!.lock.payTo)).size },
    plannedTotalUsdc: atomicToUsdc(candidates.reduce((s, c) => s + BigInt(c.lock.amount), 0n)),
    candidates,
    probes: probes.map((p) => ({ host: p.host, ok: !!p.chosen, tried: p.tried })),
  };
  writeJson(PLAN_FILE, out);
  console.log(`plan written: ${PLAN_FILE}`);
  console.log(`PayAI ${payai.total} / CDP ${cdp.total}; PayAI Solana ${sel.stats.payaiSolana}; PayAI-only by URL ${sel.stats.payaiOnlyByUrl} (${sel.stats.payaiOnlyByUrlHosts} hosts); by host ${sel.stats.payaiOnlyByHost} (${sel.stats.payaiOnlyByHostHosts} hosts); eligible GET<=0.10 ${sel.stats.eligible} (${sel.stats.eligibleHosts} hosts)`);
  console.log(`probe funnel: ${JSON.stringify(funnel)}`);
  for (const c of candidates) {
    console.log(`${c.dryRun.outcome.padEnd(9)} ${c.host.padEnd(40)} ${c.priceUsdc} payTo=${c.lock.payTo} feePayer=${c.lock.feePayer} input=${c.exampleInput ? JSON.stringify(c.exampleInput) : "none"}${c.dryRun.refusal ? ` refusal=${c.dryRun.refusal.refused}: ${c.dryRun.refusal.detail}` : ""}`);
  }
  console.log(`planned total ${out.plannedTotalUsdc} USDC; payer SOL ${bal.lamports} lamports, USDC ${atomicToUsdc(bal.usdcAtomic)}`);
}

async function pay() {
  if (!existsSync(PLAN_FILE)) throw new Error(`no plan at ${PLAN_FILE}; run --dry-run first`);
  const plan = JSON.parse(readFileSync(PLAN_FILE, "utf8")) as { kind: string; candidates: PlanEntry[] };
  if (plan.kind !== "gate1-dry-run") throw new Error("plan file is not a gate1 dry run");
  const entries = plan.candidates.slice(0, N);
  const rpc = jsonRpc(RPC_URL);
  const signer = await loadPayer(KEY_FILE);
  const payerAta = await usdcAta(PAYER_ADDRESS);
  const budget = new Budget(LEDGER_FILE);
  const start = await readBalances(rpc, PAYER_ADDRESS);
  budget.setBaselineIfMissing(start.usdcAtomic);
  const deps = {
    fetch,
    payer: PAYER_ADDRESS,
    budget,
    createPayment: makeCreatePayment(signer, RPC_URL),
    checkTx: checkPaymentTransaction,
    readBalances: () => readBalances(rpc, PAYER_ADDRESS),
    waitForSettlement: (sig: string | null, memo: string | null, payTo: string) =>
      waitForSettlement({ rpc, signature: sig, memo, payer: PAYER_ADDRESS, payerUsdcAta: payerAta, payTo }),
  };
  const records: PurchaseRecord[] = [];
  const summarize = () => {
    const sent = records.filter((r) => r.outcome === "sent");
    const both = sent.filter((r) => r.settled && r.delivered).length;
    return {
      attempted: records.length,
      sent: sent.length,
      settled: sent.filter((r) => r.settled).length,
      delivered: sent.filter((r) => r.delivered).length,
      settledAndDelivered: both,
      spentUsdc: atomicToUsdc(sent.filter((r) => r.settled).reduce((s, r) => s + BigInt(r.probe.amount ?? "0"), 0n)),
      gate: both >= 5 ? "PASS (>=5/10): proceed as planned" : "FAIL (<5/10): narrow to the CDP side",
    };
  };
  const save = (aborted?: string) =>
    writeJson(OUT_FILE, { kind: "gate1-live", ranAt: new Date().toISOString(), payer: PAYER_ADDRESS, plan: PLAN_FILE, startBalances: { lamports: start.lamports.toString(), usdc: atomicToUsdc(start.usdcAtomic) }, summary: summarize(), ...(aborted ? { aborted } : {}), records });
  for (const e of entries) {
    const rec = await payOne(e, deps);
    records.push(rec);
    save();
    console.log(`${rec.outcome.padEnd(8)} ${e.host.padEnd(40)} settled=${rec.settled ?? "-"} delivered=${rec.delivered ?? "-"} sig=${rec.signature ?? "-"}${rec.refusal ? ` ${rec.refusal.refused}: ${rec.refusal.detail}` : ""}`);
    if (rec.solDecreased) {
      save("payer SOL decreased; stopped");
      throw new Error(`payer SOL decreased after ${e.host}; stopped before the next purchase`);
    }
  }
  console.log(JSON.stringify(summarize()));
  console.log(`results: ${OUT_FILE}`);
}

if (flag("--dry-run")) await dryRun();
else if (flag("--pay")) await pay();
else {
  console.error("usage: gate1.ts --dry-run | --pay   (paying requires the explicit --pay flag)");
  process.exit(2);
}
