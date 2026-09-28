/**
 * The Solana x402 census: buy every seller host in the Solana x402 market once, with vet402's
 * own money, and publish "settled and delivered" per host with the transaction signature.
 *
 *   npx tsx scripts/census.ts --dry-run   # catalogs + unpaid 402 probes + plan; pays nothing
 *   npx tsx scripts/census.ts --pay       # pays the plan's targets once each (explicit flag only)
 *
 * Catalogs: PayAI discovery, the CDP Bazaar (listings with any Solana accept), Pay.sh (x402 endpoints),
 * deduplicated by URL and by host; per host the cheapest GET listing at or under 0.10 USDC; one per payTo.
 *
 * Money guards are gate 1's, unchanged (src/guard.ts, src/txcheck.ts, src/client.ts, src/pay.ts):
 * a single TransferChecked of USDC to ATA(payTo), the payTo lock from plan time, the facilitator
 * as fee payer, and a persistent ledger. Census limits (src/constants.ts): 0.10 USDC per purchase,
 * 35 USDC total, one purchase per host, in results/census-ledger.json (separate from gate 1's).
 * Hosts already bought in gate 1 (results/gate1-ledger.json) are not bought again.
 * The run stops if the payer's SOL goes down.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CDP_DISCOVERY,
  CENSUS_MAX_PER_PURCHASE_ATOMIC,
  CENSUS_MAX_PURCHASES,
  CENSUS_MAX_TOTAL_ATOMIC,
  PAYAI_DISCOVERY,
  PAYER_ADDRESS,
  atomicToUsdc,
} from "../src/constants.js";
import { fetchCatalog } from "../src/discovery.js";
import { Budget, checkAccept, pickSolanaAccept } from "../src/guard.js";
import { payOne, probe402, type PlanEntry, type PurchaseRecord } from "../src/pay.js";
import { jsonRpc, readBalances, waitForSettlement } from "../src/chain.js";
import { checkPaymentTransaction, usdcAta } from "../src/txcheck.js";
import { loadPayer, makeCreatePayment, throwawaySigner } from "../src/client.js";
import { fetchPaysh, payshListings } from "../src/paysh.js";
import { SOURCES, censusRow, onePerPayTo, selectCensus, type CensusCandidate, type CensusRow, type CensusTarget, type HostPlan, type Source } from "../src/census.js";
import { classifyRecord, displayClass, failureMode, refusalInput, type Classified, type ClassInput } from "../src/classify.js";
import { judgeDelivery } from "../src/verdict.js";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const DATE = opt("--date") ?? new Date().toISOString().slice(0, 10);
const RESULTS = join(ROOT, "results");
const PLAN_FILE = opt("--plan") ?? join(RESULTS, `census-${DATE}.dry-run.json`);
const OUT_FILE = join(RESULTS, `census-${DATE}.json`);
const LEDGER_FILE = join(RESULTS, "census-ledger.json");
const PRIOR_LEDGER = opt("--prior-ledger") ?? join(RESULTS, "gate1-ledger.json");
const KEY_FILE = join(ROOT, ".keys", "payer.json");
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const BUILD_SAMPLE = Number(opt("--build-sample") ?? "20");
const PROBE_TRIES = 3;

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
  writeFileSync(file, JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
}

/** Hosts a previous ledger (gate 1) already bought. Missing file = none, said out loud. */
function priorHosts(file: string): { hosts: string[]; found: boolean } {
  if (!existsSync(file)) return { hosts: [], found: false };
  const l = JSON.parse(readFileSync(file, "utf8")) as { purchases?: { key: string }[] };
  return { hosts: (l.purchases ?? []).map((p) => p.key).filter((k) => k && k !== "?"), found: true };
}

function classifiedFrom(status: Classified["status"], input: ClassInput): Classified {
  return { status, settled: false, delivered: false, reason: input.reason, detail: (input.detail ?? "").slice(0, 300), category: failureMode(input), displayClass: displayClass(input) };
}

type Probed = { hp: HostPlan; target: CensusTarget | null; row: CensusRow | null };

/** Unpaid 402 per host: the first listing (cheapest first) whose live 402 passes every accept check gives the lock. */
async function probeHost(hp: HostPlan): Promise<Probed> {
  const meta = (c: CensusCandidate) => ({ url: c.url, requestUrl: c.requestUrl, host: hp.host, source: c.source, sources: c.sources, declared: c.declared });
  if (hp.candidates.length === 0) {
    const c = hp.placeholder[0]!;
    const cl = classifiedFrom("not_sent", { verdict: "REFUSE", reason: "placeholder_unfillable", detail: "the listing declares inputs without a usable example; nothing was sent" });
    return { hp, target: null, row: censusRow(meta(c), cl) };
  }
  let last: CensusRow | null = null;
  for (const c of hp.candidates.slice(0, PROBE_TRIES)) {
    const p = await probe402(c.requestUrl, fetch);
    const a = pickSolanaAccept(p.accepts, c.declaredAccept?.payTo);
    const probe = {
      status: p.status,
      x402Version: p.x402Version,
      payTo: a?.payTo ?? null,
      amount: a?.amount ?? null,
      asset: a?.asset ?? null,
      feePayer: typeof a?.extra?.feePayer === "string" ? a.extra.feePayer : null,
      ...(p.error ? { error: p.error } : {}),
    };
    const rec: PurchaseRecord = { host: hp.host, requestUrl: c.requestUrl, probe, outcome: "refused" };
    if (p.status !== 402 || !p.paymentRequired) {
      last = censusRow(meta(c), classifiedFrom("refused", refusalInput(rec)), rec);
      continue;
    }
    // Lock: the payTo the listing declares (PayAI/CDP); for a Pay.sh-only listing, the payTo of its own 402.
    const lockedPayTo = c.declaredAccept?.payTo ?? a?.payTo ?? "";
    const r = checkAccept(a, { payer: PAYER_ADDRESS, lockedPayTo });
    if (r) {
      rec.refusal = r;
      last = censusRow(meta(c), classifiedFrom("refused", refusalInput(rec)), rec);
      continue;
    }
    const lock = { payTo: a!.payTo, amount: a!.amount, asset: a!.asset, network: a!.network, feePayer: String(a!.extra!.feePayer) };
    return {
      hp,
      target: {
        host: hp.host,
        requestUrl: c.requestUrl,
        exampleInput: c.exampleInput,
        lock,
        url: c.url,
        source: c.source,
        sources: c.sources,
        hostSources: hp.hostSources,
        declared: c.declared,
        priceAtomic: a!.amount,
      },
      row: null,
    };
  }
  return { hp, target: null, row: last };
}

function targetMeta(t: CensusTarget) {
  return { url: t.url, requestUrl: t.requestUrl, host: t.host, source: t.source, sources: t.sources, declared: t.declared };
}

function breakdown(targets: CensusTarget[]) {
  const primary = Object.fromEntries(SOURCES.map((s) => [s, { hosts: 0, usdc: "0.000000" }])) as Record<Source, { hosts: number; usdc: string }>;
  const sums = Object.fromEntries(SOURCES.map((s) => [s, 0n])) as Record<Source, bigint>;
  const listedIn = Object.fromEntries(SOURCES.map((s) => [s, 0])) as Record<Source, number>;
  const combos: Record<string, number> = {};
  for (const t of targets) {
    primary[t.source].hosts++;
    sums[t.source] += BigInt(t.lock.amount);
    for (const s of t.hostSources) listedIn[s]++;
    const k = t.hostSources.join("+");
    combos[k] = (combos[k] ?? 0) + 1;
  }
  for (const s of SOURCES) primary[s].usdc = atomicToUsdc(sums[s]);
  return { byChosenListingSource: primary, hostsListedIn: listedIn, byCatalogCombination: combos };
}

async function dryRun() {
  const rpc = jsonRpc(RPC_URL);
  const [payai, cdp, paysh] = await Promise.all([
    fetchCatalog(PAYAI_DISCOVERY, { pageLimit: 1000, sleepMs: 200 }),
    fetchCatalog(CDP_DISCOVERY, { pageLimit: 1000, sleepMs: 200 }),
    fetchPaysh(),
  ]);
  if (!payai.complete || !cdp.complete) throw new Error("a catalog did not finish paging; the union cannot be decided");
  if (paysh.failed.length) console.warn(`pay.sh: ${paysh.failed.length} provider detail files failed: ${paysh.failed.join(", ")}`);
  const prior = priorHosts(PRIOR_LEDGER);
  if (!prior.found) console.warn(`WARNING: prior ledger ${PRIOR_LEDGER} not found; gate 1 hosts are NOT excluded`);
  const sel = selectCensus({ payai: payai.items, cdp: cdp.items, paysh: payshListings(paysh.providers) }, { alreadyBoughtHosts: prior.hosts, maxPer: CENSUS_MAX_PER_PURCHASE_ATOMIC });

  const probed = await pool(sel.hosts, 6, probeHost);
  const rows: CensusRow[] = probed.filter((p) => p.row).map((p) => p.row!);
  const ready = probed.filter((p) => p.target).map((p) => p.target!);
  ready.sort((a, b) => (BigInt(a.lock.amount) < BigInt(b.lock.amount) ? -1 : BigInt(a.lock.amount) > BigInt(b.lock.amount) ? 1 : a.host.localeCompare(b.host)));
  const { kept, dropped } = onePerPayTo(ready);
  for (const t of dropped) {
    rows.push(censusRow(targetMeta(t), classifiedFrom("refused", { verdict: "REFUSE", reason: "same_payto", detail: `payTo ${t.lock.payTo} is already a target under another host` })));
  }
  // Simulate the census caps in order (cheapest first): what fits in 35 USDC is the target list.
  const sim = new Budget(null, CENSUS_MAX_TOTAL_ATOMIC, CENSUS_MAX_PURCHASES, CENSUS_MAX_PER_PURCHASE_ATOMIC);
  const targets: CensusTarget[] = [];
  for (const t of kept) {
    const r = sim.reserve(BigInt(t.lock.amount), t.host);
    if ("refused" in r) rows.push(censusRow(targetMeta(t), classifiedFrom("refused", { verdict: "REFUSE", reason: r.refused, detail: r.detail })));
    else targets.push(t);
  }

  // Build and read back the payment for a sample of targets with a throwaway key: nothing is sent.
  const throwaway = await throwawaySigner();
  const deps = {
    fetch,
    payer: PAYER_ADDRESS,
    signerAddress: throwaway.address,
    budget: new Budget(null, CENSUS_MAX_TOTAL_ATOMIC, CENSUS_MAX_PURCHASES, CENSUS_MAX_PER_PURCHASE_ATOMIC),
    dryRun: true,
    createPayment: makeCreatePayment(throwaway, RPC_URL),
    checkTx: checkPaymentTransaction,
    readBalances: () => readBalances(rpc, PAYER_ADDRESS),
    waitForSettlement: async () => null,
  };
  const built: Record<string, number> = {};
  for (const t of targets.slice(0, Math.max(0, BUILD_SAMPLE))) {
    const rec = await payOne(t, deps);
    const c = classifyRecord(rec);
    const k = c.status === "planned" ? "would_pay" : `${c.status}:${c.reason}`;
    built[k] = (built[k] ?? 0) + 1;
  }
  for (const t of targets) rows.push(censusRow(targetMeta(t), { status: "planned", settled: false, delivered: false, reason: "would_pay", detail: "", category: null, displayClass: null }));

  const bal = await readBalances(rpc, PAYER_ADDRESS);
  const total = targets.reduce((s, t) => s + BigInt(t.lock.amount), 0n);
  const notTargets: Record<string, number> = {};
  for (const r of rows) if (r.status !== "planned") notTargets[`${r.status}:${r.category ?? r.reason}`] = (notTargets[`${r.status}:${r.category ?? r.reason}`] ?? 0) + 1;
  const summary = {
    targetHosts: targets.length,
    estimatedTotalUsdc: atomicToUsdc(total),
    capUsdc: atomicToUsdc(CENSUS_MAX_TOTAL_ATOMIC),
    perPurchaseCapUsdc: atomicToUsdc(CENSUS_MAX_PER_PURCHASE_ATOMIC),
    ...breakdown(targets),
    hostsProbed: sel.hosts.length,
    hostsNotTargets: notTargets,
    sameSellerDropped: dropped.length,
    txBuildSample: { size: Math.min(targets.length, Math.max(0, BUILD_SAMPLE)), results: built },
  };
  const out = {
    kind: "census-dry-run",
    createdAt: new Date().toISOString(),
    payer: PAYER_ADDRESS,
    payerBalances: { lamports: bal.lamports.toString(), usdc: atomicToUsdc(bal.usdcAtomic) },
    definition:
      "Union of PayAI discovery, CDP Bazaar listings with any Solana accept, and Pay.sh x402 endpoints; deduplicated by URL and host; per host the cheapest GET listing with a Solana mainnet USDC exact price <= 0.10; one per payTo; live unpaid 402 must match (payTo lock, USDC, facilitator fee payer).",
    catalogs: {
      payai: { total: payai.total, fetched: payai.items.length },
      cdp: { total: cdp.total, fetched: cdp.items.length },
      paysh: { providers: paysh.providerCount, detailFilesFailed: paysh.failed, generatedAt: paysh.generatedAt },
      ...sel.stats,
    },
    priorLedger: { path: PRIOR_LEDGER, found: prior.found, hostsExcluded: sel.stats.hostsAlreadyBought },
    summary,
    targets,
    rows,
  };
  writeJson(PLAN_FILE, out);

  const s = sel.stats;
  console.log(`plan written: ${PLAN_FILE}`);
  for (const src of SOURCES) {
    const b = s.bySource[src];
    console.log(`${src.padEnd(5)} items ${b.items}  solana/x402 ${b.solana} (${b.solanaHosts} hosts)  eligible GET<=0.10 ${b.eligible} (${b.eligibleHosts} hosts)  dropped ${JSON.stringify(b.dropped)}`);
  }
  console.log(`union: ${s.unionUrls} URLs (${s.sharedUrls} in >1 catalog), ${s.unionHosts} hosts; buyable ${s.hostsWithBuyable}, placeholder-only ${s.hostsPlaceholderOnly}, already bought in gate 1 ${s.hostsAlreadyBought.length}, own ${s.hostsOwn}`);
  console.log(`not targets: ${JSON.stringify(notTargets)}`);
  console.log(`TARGETS ${targets.length} hosts, estimated ${summary.estimatedTotalUsdc} USDC (cap ${summary.capUsdc}, <= ${summary.perPurchaseCapUsdc} each)`);
  console.log(`by chosen listing's source: ${JSON.stringify(summary.byChosenListingSource)}`);
  console.log(`hosts listed in: ${JSON.stringify(summary.hostsListedIn)}  combinations: ${JSON.stringify(summary.byCatalogCombination)}`);
  console.log(`tx build sample (throwaway key, not sent): ${JSON.stringify(summary.txBuildSample)}`);
  console.log(`payer SOL ${bal.lamports} lamports, USDC ${atomicToUsdc(bal.usdcAtomic)}`);
}

async function pay() {
  if (!existsSync(PLAN_FILE)) throw new Error(`no plan at ${PLAN_FILE}; run --dry-run first`);
  const plan = JSON.parse(readFileSync(PLAN_FILE, "utf8")) as { kind: string; targets: CensusTarget[] };
  if (plan.kind !== "census-dry-run") throw new Error("plan file is not a census dry run");
  const prior = new Set(priorHosts(PRIOR_LEDGER).hosts);
  const rpc = jsonRpc(RPC_URL);
  const signer = await loadPayer(KEY_FILE);
  const payerAta = await usdcAta(PAYER_ADDRESS);
  const budget = new Budget(LEDGER_FILE, CENSUS_MAX_TOTAL_ATOMIC, CENSUS_MAX_PURCHASES, CENSUS_MAX_PER_PURCHASE_ATOMIC);
  const start = await readBalances(rpc, PAYER_ADDRESS);
  budget.setBaselineIfMissing(start.usdcAtomic);
  const base = {
    fetch,
    payer: PAYER_ADDRESS,
    budget,
    createPayment: makeCreatePayment(signer, RPC_URL),
    checkTx: checkPaymentTransaction,
    readBalances: () => readBalances(rpc, PAYER_ADDRESS),
    waitForSettlement: (sig: string | null, memo: string | null, payTo: string) =>
      waitForSettlement({ rpc, signature: sig, memo, payer: PAYER_ADDRESS, payerUsdcAta: payerAta, payTo }),
  };
  const rows: CensusRow[] = [];
  const records: PurchaseRecord[] = [];
  const summarize = () => {
    const by = (f: (r: CensusRow) => boolean) => rows.filter(f).length;
    const bySource = Object.fromEntries(SOURCES.map((s) => [s, { rows: by((r) => r.source === s), settledAndDelivered: by((r) => r.source === s && r.settled && r.delivered) }]));
    return {
      attempted: rows.length,
      settled: by((r) => r.settled),
      delivered: by((r) => r.delivered),
      settledAndDelivered: by((r) => r.settled && r.delivered),
      spentUsdcLedger: atomicToUsdc(budget.spent),
      bySource,
    };
  };
  const save = (aborted?: string) =>
    writeJson(OUT_FILE, {
      kind: "census-live",
      ranAt: new Date().toISOString(),
      payer: PAYER_ADDRESS,
      plan: PLAN_FILE,
      ledger: LEDGER_FILE,
      startBalances: { lamports: start.lamports.toString(), usdc: atomicToUsdc(start.usdcAtomic) },
      summary: summarize(),
      ...(aborted ? { aborted } : {}),
      rows,
      records,
    });
  const seenHosts = new Set<string>();
  for (const t of plan.targets) {
    if (seenHosts.has(t.host) || prior.has(t.host)) continue; // one purchase per host (the ledger enforces it again)
    seenHosts.add(t.host);
    const entry: PlanEntry = { host: t.host, requestUrl: t.requestUrl, exampleInput: t.exampleInput, lock: t.lock };
    const rec = await payOne(entry, { ...base, judge: (d) => judgeDelivery(t.declared, d) });
    records.push(rec);
    rows.push(censusRow(targetMeta(t), classifyRecord(rec), rec));
    save();
    console.log(`${rows.at(-1)!.status.padEnd(22)} ${t.host.padEnd(40)} ${rows.at(-1)!.priceUsdc ?? "-"} sig=${rec.signature ?? "-"} ${rows.at(-1)!.category ?? ""}`);
    if (rec.solDecreased) {
      save("payer SOL decreased; stopped");
      throw new Error(`payer SOL decreased after ${t.host}; stopped before the next purchase`);
    }
    if (rec.refusal?.refused === "total_cap_reached" || rec.refusal?.refused === "purchase_count_reached" || rec.refusal?.refused === "ledger_unreadable") {
      save(`stopped: ${rec.refusal.refused}`);
      break;
    }
  }
  save();
  console.log(JSON.stringify(summarize()));
  console.log(`results: ${OUT_FILE}`);
}

if (flag("--dry-run")) await dryRun();
else if (flag("--pay")) await pay();
else {
  console.error("usage: census.ts --dry-run | --pay   (paying requires the explicit --pay flag)");
  process.exit(2);
}
