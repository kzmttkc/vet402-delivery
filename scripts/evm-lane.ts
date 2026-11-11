/**
 * EVM purchase lanes on Robinhood Chain and Arbitrum One, from the shared payer 0x9B59…4E51.
 *
 *   npx tsx scripts/evm-lane.ts --lane robinhood [--dry-run]     (default; throwaway signer, nothing sent)
 *   npx tsx scripts/evm-lane.ts --lane robinhood --hosts [--run-date YYYY-MM-DD] [--dry-run|--pay]   (one purchase per host; its own ledger on the robinhood ledger; --pay requires --run-date, today's UTC date)
 *   npx tsx scripts/evm-lane.ts --lane arbitrum  [--dry-run]     (Arbitrum One + the same listings on Base)
 *   npx tsx scripts/evm-lane.ts --lane polygon --hosts [--dry-run|--pay --run-date YYYY-MM-DD --plan <dry run>]   (3.11; --pay stops,
 *     exit 8, before the key unless: Polygon USDC Transfer logs out of the payer since POLYGON_OUTFLOW_START_BLOCK are within the
 *     Polygon ledger, the owner approval record matches the planned total, the legal-check and independent SHIP files match
 *     their canonical copies in VET402_REVIEW_DIR, eip155:137 is in the wallet registry (VET402_WALLET_REGISTRY), neither
 *     HALT-pay nor Tempo's last stop is set, every Polygon transaction from the payer (its POL fees) is on the POL ledger
 *     (results/evm/polygon-pol-ledger.json), the payer holds POL for one daily root, and Polygon has a daily-root path
 *     (src/evm/polygon-anchor.ts).
 *     --lane monad exits 7: 3.11.0 is FAIL)
 *   VET402_EVM_PAY=<lane> npx tsx scripts/evm-lane.ts --lane <lane> --pay
 *
 * robinhood: every payTo that the CDP / Dexter / PayAI catalogs list with an exact USDG accept on Robinhood
 *   Chain, once, at the cheapest listing whose live 402 still offers it. The stock-price seller is bought
 *   once per ticker in src/robinhood/stock-check.ts, and each answer is compared with the Chainlink feed of
 *   that Stock Token (price, age against the heartbeat, oraclePaused, ERC-8056 multiplier).
 * arbitrum: every payTo listed with exact USDC on Arbitrum One and the same payTo on Base, once on each chain
 *   (lanes "arbitrum" and "base-compare", separate ledgers and caps).
 *
 * The real key (.keys/evm.json) is read only with --pay AND VET402_EVM_PAY=<lane>.
 * Outputs: results/evm/<lane>-dryrun.json (here; --hosts: robinhood-hosts-dryrun.json) | with --pay, in the results directory beside the key
 * (src/evm/run-dir.ts: ~/vet402-solana/results/evm unless VET402_EVM_RESULTS_DIR is set): <lane>-purchases.jsonl,
 * <lane>-paid-run.json (--hosts: robinhood-hosts-paid-run.json) and the lanes' ledgers. --pay stops first when a lane's ledger holds fewer purchases than its
 * records sent (exit 5), or when a line of the records does not parse (exit 4).
 * Options: --catalogs <dir> reads catalog_cdp.json / catalog_dexter.json / catalog_payai.json instead of fetching.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, erc20Abi, hashDomain, http, parseAbi, parseAbiItem, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CDP_DISCOVERY, MEASURE_MAX_PER_SELLER, MEASURE_SPACING_MS, OWN_HOSTS, PAYAI_DISCOVERY, atomicToUsdc } from "../src/constants.js";
import { fetchCatalog, type Listing } from "../src/discovery.js";
import { Budget } from "../src/guard.js";
import { EVM_CHAINS, LANES, RUN_LANES, fundingProblem, payGateProblem, type EvmChainSpec, type LaneId, type LaneSpec } from "../src/evm/chains.js";
import {
  walletRegistryPath,
  monadFundingGateProblem,
  parsePolygonOwnerApproval,
  polygonGatePaths,
  polygonPayGateProblem,
  readTextIfExists,
  walletRegistryChainsFromRegistryJson,
} from "../src/evm/evm-pay-gates.js";
import { buyOneOnChain, eqAddr, evmLaneStopsAfterRecord, probe402, type ChainBuyDeps, type ChainBuyEntry, type ChainBuyRecord, type TypedDataSigner } from "../src/evm/evm-buy.js";
import { laneLedgerCommitted, polygonLogsRpc, polygonOutflowScanner, POLYGON_OUTFLOW_START_BLOCK } from "../src/evm/evm-shared-payer-outflow.js";
import { measurePolygonPolSpend, polLedgerEntriesFromFile, polSpendReaderFromClients, POLYGON_POL_LEDGER_FILE } from "../src/evm/polygon-anchor.js";
import { MONAD_CAIP2, monadPurchaseBlockedReason } from "../src/evm/311-memo.js";
import { resolveSharedEvmTempoStop } from "../src/evm/tempo-evm-payer-stop.js";
import { homedir } from "node:os";
import { readUsdcTransfer } from "../src/evm/erc8004.js";
import { loadEvmAccount, readPublicAddress } from "../src/evm/key.js";
import { DEXTER_DISCOVERY, STOCK_SELLER, confirmLive, groupByPayTo, laneEntries, mirrorEntries, stockEntries, type LiveChoice, type Probe } from "../src/evm/lane-plan.js";
import { HOSTS_RUN, LEGACY_HOST_RUN_DATE, POLYGON_LEGACY_HOST_RUN_DATE, RunBudget, acquireHostRunLock, confirmLiveHosts, groupByHost, hostRunFiles, hostRunLedgerProblem, keepPlanned, laneCountCapForHostRun, pickHostEntries, type HostRunKind, type PlanRow } from "../src/evm/lane-hosts.js";
import { classifyRecord, predictFacilitator } from "../src/evm/settle-cause.js";
import { checkLaneFiles } from "../src/evm/chaincheck-run.js";
import { lastPaidByListing, type LastPaid } from "../src/evm/lane-input.js";
import { loadLaneRecordsChecked, payStopForUnreadableLines } from "../src/evm/lane-records.js";
import { laneLedgerPath, ledgerBehindRecords, overrideLedgerProblem, payResultsDir, payResultsDirProblem } from "../src/evm/run-dir.js";
import { CHAINLINK_DIRECTORY, STOCK_REFS, checkAgainstDirectory, compareStockAnswer, readStockReference, type StockReference } from "../src/robinhood/stock-check.js";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const laneArg = arg("--lane");
// 3.11.0 is FAIL (src/evm/311-memo.ts): Monad has no lane. Stop before anything is read.
if (laneArg === "monad" || laneArg === MONAD_CAIP2) {
  console.error(`${monadPurchaseBlockedReason() ?? "Monad has no purchase lane in this script yet"}; nothing read, nothing signed`);
  process.exit(7);
}
if (laneArg !== "robinhood" && laneArg !== "arbitrum" && laneArg !== "polygon") throw new Error("--lane robinhood | arbitrum | polygon");
const hostsRun = argv.includes("--hosts");
if (hostsRun && laneArg !== "robinhood" && laneArg !== "polygon") throw new Error("--hosts is only valid with --lane robinhood | polygon");
const hostRunKind: HostRunKind = laneArg === "polygon" ? "polygon" : "robinhood";
const hostRunLegacyDate = hostRunKind === "polygon" ? POLYGON_LEGACY_HOST_RUN_DATE : LEGACY_HOST_RUN_DATE;
const pay = argv.includes("--pay");
if (pay && argv.includes("--dry-run")) throw new Error("choose one of --dry-run / --pay");
// --run-date selects the host run's ledger. With --pay it is required and must be today's UTC date, before anything is read.
const todayUtc = new Date().toISOString().slice(0, 10);
if (argv.includes("--run-date") && !hostsRun) throw new Error("--run-date is only valid with --hosts");
let runDate = todayUtc;
if (hostsRun) {
  if (pay && !argv.includes("--run-date")) throw new Error("--hosts --pay requires --run-date <YYYY-MM-DD> equal to today's UTC date; nothing signed");
  if (argv.includes("--run-date")) runDate = arg("--run-date") ?? "";
  hostRunFiles(runDate, hostRunKind);
  if (pay && runDate !== todayUtc) throw new Error(`--run-date ${runDate} must equal today's UTC date ${todayUtc}; nothing signed`);
}
if (pay) {
  const problem = payGateProblem(laneArg, process.env.VET402_EVM_PAY);
  if (problem) throw new Error(`${problem} (set only after the independent review)`);
}
const catalogsDir = arg("--catalogs");

// Where this run reads and writes. A paying run: the results directory beside the key (src/evm/run-dir.ts), so its
// ledger is the production ledger whatever the working directory; a dry run: results/evm here.
if (pay) {
  // An override that would put the ledger anywhere but an existing absolute directory stops the run first.
  const dirProblem = payResultsDirProblem() ?? overrideLedgerProblem(RUN_LANES[laneArg].map((l) => LANES[l]));
  if (dirProblem) {
    console.error(dirProblem);
    process.exit(6);
  }
}
const resultsDir = pay ? payResultsDir() : "results/evm";
const recordLanes = RUN_LANES[laneArg];
if (pay) {
  // The ledger must hold at least every purchase the records sent, before anything else.
  const behind = ledgerBehindRecords(recordLanes.map((l) => LANES[l]), resultsDir);
  if (behind) {
    console.error(behind);
    process.exit(5);
  }
  if (hostsRun) {
    // This date's host-run ledger must hold every host purchase the records sent that day, and only one paying host run at a time.
    const hostBehind = hostRunLedgerProblem(resultsDir, runDate, hostRunKind);
    if (hostBehind) {
      console.error(hostBehind);
      process.exit(5);
    }
    const releaseLock = acquireHostRunLock(resultsDir, hostRunKind);
    process.on("exit", releaseLock);
  }
  console.error(`[pay] results and ledgers: ${resultsDir}`);
}
// The records this run reads (what not to buy again, and rule 0's material) must be whole before anything else:
// a paying run with an unreadable line stops here, before the key, the catalogs or any purchase.
const recordsRead = loadLaneRecordsChecked(recordLanes, resultsDir);
if (recordsRead.problems.length) {
  const stop = payStopForUnreadableLines(recordsRead.problems)!;
  if (pay) {
    console.error(stop);
    process.exit(4);
  }
  console.error(stop.replace("--pay stops before any purchase", "a paying run would stop here (dry run goes on)"));
}

const payer: Address = readPublicAddress();
const clients = new Map<string, PublicClient>();
const client = (c: EvmChainSpec): PublicClient => {
  if (!clients.has(c.key)) clients.set(c.key, createPublicClient({ transport: http(process.env[c.rpcEnv] ?? c.rpc) }) as PublicClient);
  return clients.get(c.key)!;
};

// ---- the token's own EIP-712 domain must be the one the fence insists on ----
const domainAbi = parseAbi(["function DOMAIN_SEPARATOR() view returns (bytes32)", "function name() view returns (string)"]);
async function checkDomain(c: EvmChainSpec): Promise<void> {
  const ds = await client(c).readContract({ address: c.asset, abi: domainAbi, functionName: "DOMAIN_SEPARATOR" });
  const want = hashDomain({
    domain: { name: c.domain.name, version: c.domain.version, chainId: BigInt(c.chainId), verifyingContract: c.asset },
    types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] },
  });
  if (ds.toLowerCase() !== want.toLowerCase()) throw new Error(`${c.label} ${c.assetSymbol} DOMAIN_SEPARATOR is not ${c.domain.name}/${c.domain.version}`);
  const cid = await client(c).getChainId();
  if (cid !== c.chainId) throw new Error(`${c.label} RPC chainId ${cid} != ${c.chainId}`);
}

// ---- catalogs ----
async function catalogs(): Promise<{ items: Listing[]; sources: Record<string, { items: number; complete: boolean | null }> }> {
  const src: [string, string][] = [["cdp", CDP_DISCOVERY], ["dexter", DEXTER_DISCOVERY], ["payai", PAYAI_DISCOVERY]];
  const items: Listing[] = [];
  const sources: Record<string, { items: number; complete: boolean | null }> = {};
  for (const [name, url] of src) {
    try {
      if (catalogsDir) {
        const f = join(catalogsDir, `catalog_${name}.json`);
        const d = JSON.parse(readFileSync(f, "utf8")) as { items?: Listing[] };
        items.push(...(d.items ?? []));
        sources[name] = { items: d.items?.length ?? 0, complete: null };
      } else {
        const c = await fetchCatalog(url, { pageLimit: 1000, sleepMs: 300 });
        items.push(...c.items);
        sources[name] = { items: c.items.length, complete: c.complete };
      }
    } catch (err) {
      sources[name] = { items: 0, complete: false };
      console.error(`catalog ${name}: ${(err as Error).message}`);
    }
  }
  return { items, sources };
}

// ---- probe that also keeps the raw 402 (header + body) for the facilitator hint ----
const probe: Probe = async (o) => {
  let raw = "";
  const docs: unknown[] = [];
  const capture = (async (u: RequestInfo | URL, init?: RequestInit) => {
    const r = await fetch(u, init);
    if (r.status === 402) {
      const h = r.headers.get("payment-required");
      let decoded = "";
      try {
        decoded = h ? Buffer.from(h, "base64").toString("utf8") : "";
      } catch {
        decoded = "";
      }
      const bodyText = await r.clone().text().catch(() => "");
      raw = `${decoded}\n${bodyText}`.slice(0, 20_000);
      for (const t of [decoded, bodyText]) {
        try {
          if (t) docs.push(JSON.parse(t));
        } catch {
          /* not JSON */
        }
      }
    }
    return r;
  }) as typeof fetch;
  const p = await probe402(o, capture);
  return { status: p.status, accepts: p.accepts, raw, docs, ...(p.error ? { error: p.error } : {}) };
};

// ---- balances and funding ----
async function balances(c: EvmChainSpec): Promise<{ assetAtomic: string; ethWei: string }> {
  const [a, e] = await Promise.all([
    client(c).readContract({ address: c.asset, abi: erc20Abi, functionName: "balanceOf", args: [payer] }),
    client(c).getBalance({ address: payer }),
  ]);
  return { assetAtomic: a.toString(), ethWei: e.toString() };
}

const receiptClients = new Map<string, PublicClient>();
const receiptClient = (c: EvmChainSpec): PublicClient => {
  if (!receiptClients.has(c.key)) receiptClients.set(c.key, createPublicClient({ transport: http(process.env[c.receiptRpcEnv] ?? c.receiptRpc) }) as PublicClient);
  return receiptClients.get(c.key)!;
};

function verifier(c: EvmChainSpec) {
  return async (tx: Hex, payTo: string, amount: string) => {
    for (let i = 0; i < 20; i++) {
      try {
        const r = await readUsdcTransfer(receiptClient(c), tx, { to: payTo as Address, amountUnits: amount, asset: c.asset, from: payer });
        return { ok: r.ok, from: r.from, reason: r.reason, blockNumber: r.blockNumber?.toString() };
      } catch {
        await new Promise((res) => setTimeout(res, 3000));
      }
    }
    return { ok: false, reason: "receipt not found in 60 s" };
  };
}

/** Who submitted the settlement tx (the facilitator's relayer). */
async function relayerOf(c: EvmChainSpec, tx: string | null | undefined): Promise<string | null> {
  if (!tx) return null;
  try {
    return (await receiptClient(c).getTransaction({ hash: tx as Hex })).from;
  } catch {
    return null;
  }
}

// ---- one lane run ----
interface LaneResult {
  lane: LaneId;
  chain: string;
  entries: number;
  records: (ChainBuyRecord & { lane: LaneId; chain: string; facilitator: string | null; predictedProblem: string | null; cause: ReturnType<typeof classifyRecord>; relayer?: string | null; stock?: unknown })[];
  wouldPayAtomic: string;
  budget: { spentAtomic: string; count: number; maxTotalAtomic: string; maxPerAtomic: string; maxCount: number };
}

/** Before any signature in a paying run: print what will be paid, and refuse when the wallet cannot cover it. */
async function preflight(lane: LaneSpec, entries: ChainBuyEntry[]): Promise<void> {
  const c = EVM_CHAINS[lane.chain];
  const total = entries.reduce((n, e) => n + BigInt(e.lock.amount), 0n);
  const b = await balances(c);
  console.error(`[pay] lane ${lane.id} on ${c.label} (${c.caip2}): up to ${entries.length} purchases, at most ${atomicToUsdc(total > lane.maxTotalAtomic ? lane.maxTotalAtomic : total)} ${c.assetSymbol} (lane cap ${atomicToUsdc(lane.maxTotalAtomic)}); wallet ${payer} holds ${atomicToUsdc(b.assetAtomic)} ${c.assetSymbol} and ${b.ethWei} wei`);
  const problem = fundingProblem(lane, total, BigInt(b.assetAtomic), BigInt(b.ethWei));
  if (problem) throw new Error(`${problem}; nothing signed`);
}

async function runLane(
  lane: LaneSpec,
  entries: ChainBuyEntry[],
  raw402: Map<string, string>,
  stockRefs: Map<string, StockReference>,
  over?: {
    budget?: Pick<Budget, "setBaselineIfMissing" | "reserve" | "release" | "commit" | "spent" | "count">;
    minAtomic?: bigint;
    maxPerAtomic?: bigint;
    beforeSign?: ChainBuyDeps["beforeSign"];
    outflowCheck?: ChainBuyDeps["outflowCheck"];
  },
): Promise<LaneResult> {
  const c = EVM_CHAINS[lane.chain];
  const signer: TypedDataSigner = pay ? loadEvmAccount() : privateKeyToAccount(generatePrivateKey()); // dry run: throwaway, pays nobody
  if (pay && !eqAddr(signer.address, payer)) throw new Error("key address != evm.pub");
  const budget = over?.budget ?? new Budget(pay ? laneLedgerPath(lane, resultsDir) : null, lane.maxTotalAtomic, lane.maxCount, lane.maxPerAtomic);
  const maxPerAtomic = over?.maxPerAtomic ?? lane.maxPerAtomic;
  const lastAt = new Map<string, number>();
  const perSeller = new Map<string, number>();
  const out: LaneResult["records"] = [];
  let would = 0n;
  mkdirSync(resultsDir, { recursive: true });
  for (const e of entries) {
    const k = e.lock.payTo.toLowerCase();
    // The host run plans at most HOSTS_RUN.maxCount entries itself; a payTo behind several hosts is not cut here.
    if (!over?.budget && (perSeller.get(k) ?? 0) >= MEASURE_MAX_PER_SELLER) continue;
    if (pay && lastAt.has(k)) {
      const wait = MEASURE_SPACING_MS - (Date.now() - lastAt.get(k)!);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    const rec = await buyOneOnChain(
      c,
      e,
      {
        fetch,
        payer,
        signer,
        budget,
        readAssetBalance: () => client(c).readContract({ address: c.asset, abi: erc20Abi, functionName: "balanceOf", args: [payer] }),
        verifySettlement: verifier(c),
        dryRun: !pay,
        maxPerAtomic,
        ...(over?.minAtomic !== undefined ? { minAtomic: over.minAtomic } : {}),
        ...(over?.beforeSign ? { beforeSign: over.beforeSign } : {}),
        ...(over?.outflowCheck ? { outflowCheck: over.outflowCheck } : {}),
      },
      { keepSettleResponse: true, keepBodyBytes: 20_000 },
    );
    lastAt.set(k, Date.now());
    perSeller.set(k, (perSeller.get(k) ?? 0) + 1);
    if (rec.outcome === "would_pay" && rec.amountAtomic) would += BigInt(rec.amountAtomic);
    const predicted = predictFacilitator(raw402.get(e.resource) ?? "", c.caip2, rec.amountAtomic ?? e.lock.amount);
    const relayer = pay ? await relayerOf(c, rec.settlementTx) : undefined;
    const row = { lane: lane.id, chain: c.caip2, ...rec, facilitator: predicted.facilitator, predictedProblem: predicted.problem, cause: classifyRecord(rec, predicted), ...(relayer !== undefined ? { relayer } : {}) } as LaneResult["records"][number];
    const ticker = e.agentId.startsWith("stock:") ? e.agentId.slice(6) : null;
    if (ticker && stockRefs.has(ticker)) {
      // In a paying run the reference is read again right after the answer, so both sides are from the same minute.
      const stockRef = STOCK_REFS.find((x) => x.ticker === ticker);
      const refNow = pay && stockRef ? await readStockReference(client(c), stockRef).catch(() => stockRefs.get(ticker)!) : stockRefs.get(ticker)!;
      row.stock = rec.delivered && rec.body ? { ...compareStockAnswer(ticker, rec.body, refNow, rec.at), reference: refNow } : { ticker, verdict: "not_bought_yet", reference: refNow };
    }
    out.push(row);
    if (pay) appendFileSync(join(resultsDir, `${lane.id}-purchases.jsonl`), JSON.stringify(row) + "\n");
    if (evmLaneStopsAfterRecord(rec, pay)) break;
  }
  return {
    lane: lane.id,
    chain: c.caip2,
    entries: entries.length,
    records: out,
    wouldPayAtomic: would.toString(),
    budget: over?.budget
      ? { spentAtomic: budget.spent.toString(), count: budget.count, maxTotalAtomic: HOSTS_RUN.maxTotalAtomic.toString(), maxPerAtomic: HOSTS_RUN.maxPerAtomic.toString(), maxCount: HOSTS_RUN.maxCount }
      : { spentAtomic: budget.spent.toString(), count: budget.count, maxTotalAtomic: lane.maxTotalAtomic.toString(), maxPerAtomic: lane.maxPerAtomic.toString(), maxCount: lane.maxCount },
  };
}

function choiceSummary(ch: LiveChoice[]) {
  return ch.map((c) => ({
    payTo: c.payTo,
    catalogListings: c.listings,
    hosts: c.hosts,
    chosen: c.chosen ? { resource: c.chosen.resource, method: c.chosen.method, query: c.chosen.query, catalogAmount: c.chosen.amount, liveAmount: c.chosen.liveAmount, sameOnPayTo: c.chosen.sameOnPayTo } : null,
    tried: c.tried,
  }));
}

/**
 * vet402's last paid answer per listing on these lanes (src/evm/lane-input.ts lastPaidByListing), read the way the
 * pages read it: the records with rule 0's material applied (src/evm/lane-records.ts). It decides which listing the
 * plan offers (a 400/404/422 holds the same request 30 or 7 days). It does not decide whether a seller is paid
 * again: with --pay the lane's ledger allows each seller once (Budget, already_bought), so an ended hold buys
 * nothing unless the ledger has been changed.
 */
/** How many purchases the lane ledger file holds. 0 when the file is missing or unreadable. */
function laneLedgerPurchaseCount(file: string): number {
  try {
    const purchases = (JSON.parse(readFileSync(file, "utf8")) as { purchases?: unknown }).purchases;
    return Array.isArray(purchases) ? purchases.length : 0;
  } catch {
    return 0;
  }
}

function lastPaid(laneIds: LaneId[]): Map<string, LastPaid> {
  return lastPaidByListing(recordsRead.rows.filter((r) => laneIds.includes(r.lane as LaneId)));
}

// ---------- main ----------
const cat = await catalogs();
const today = new Date().toISOString().slice(0, 10);
const summary: Record<string, unknown> = { generatedAt: new Date().toISOString(), mode: pay ? "pay" : "dry-run", lane: laneArg, payer, catalogs: cat.sources };
const results: LaneResult[] = [];
/** wallet_registry.json chains, read by the Polygon run (the deposit line below depends on it). */
let polygonRegisteredChains: string[] | null = null;

if (laneArg === "polygon") {
  if (!hostsRun) throw new Error("--lane polygon requires --hosts (trial buys are host runs only while Monad 3.11.0 is FAIL)");
  const pg = EVM_CHAINS.polygon;
  const lane = LANES.polygon;
  await checkDomain(pg);
  const groups = groupByHost(cat.items, pg, { minAtomic: HOSTS_RUN.minAtomic, maxPerAtomic: HOSTS_RUN.maxPerAtomic, ownHosts: OWN_HOSTS, today: runDate, lastPaid: lastPaid(["polygon"]) });
  const choices = await confirmLiveHosts(groups, pg, probe, { payer, minAtomic: HOSTS_RUN.minAtomic, maxPerAtomic: HOSTS_RUN.maxPerAtomic });
  const picked = pickHostEntries(choices, { maxTotalAtomic: HOSTS_RUN.maxTotalAtomic, maxCount: HOSTS_RUN.maxCount, runDate, hostRunKind: "polygon" });
  if (picked.entries.length > HOSTS_RUN.maxCount || picked.totalAtomic > HOSTS_RUN.maxTotalAtomic) {
    throw new Error(`host run plan is ${picked.entries.length} purchases totaling ${picked.totalAtomic} atomic, above ${HOSTS_RUN.maxCount} or ${HOSTS_RUN.maxTotalAtomic}; nothing signed`);
  }
  if (pay) {
    const planFile = arg("--plan");
    if (!planFile) throw new Error("--hosts --pay needs --plan <results/evm/polygon-hosts-dryrun.json>; nothing signed");
    const sent = (JSON.parse(readFileSync(planFile, "utf8")) as { polygonHosts?: { plan?: PlanRow[] } }).polygonHosts?.plan;
    if (!Array.isArray(sent)) throw new Error(`${planFile} has no polygonHosts.plan; nothing signed`);
    const kept = keepPlanned(picked.entries, sent);
    for (const d of kept.dropped) console.error(`[plan] not paid: ${d.host}: ${d.why}`);
    picked.left.push(...kept.dropped);
    picked.entries = kept.entries;
    picked.totalAtomic = kept.entries.reduce((n, e) => n + BigInt(e.lock.amount), 0n);
  }
  const raw402 = new Map(choices.flatMap((c) => (c.chosen ? [[c.chosen.resource, c.chosen.raw402] as const] : [])));
  const plan = picked.entries.map((e) => ({ host: e.agentId.slice("host:".length), resource: e.resource, method: e.method, payTo: e.lock.payTo, amountAtomic: e.lock.amount }));
  summary.polygonHosts = {
    hostsInCatalogs: groups.length,
    hostsWithLive402: choices.filter((c) => c.chosen).length,
    plan,
    planTotalAtomic: picked.totalAtomic.toString(),
    left: picked.left,
    choices: choices.map((c) => ({ host: c.host, chosen: c.chosen ? { resource: c.chosen.resource, liveAmount: c.chosen.liveAmount, payTo: c.chosen.payTo } : null, tried: c.tried })),
  };
  console.error(["host", "amount", "payTo", "resource"].join("\t"));
  for (const row of plan) console.error([row.host, row.amountAtomic, row.payTo, row.resource].join("\t"));
  console.error(`total\t${picked.totalAtomic}`);
  const gatePaths = polygonGatePaths(resultsDir);
  let registeredChains: string[] = [];
  try {
    const registry = walletRegistryPath();
    registeredChains = registry ? walletRegistryChainsFromRegistryJson(readFileSync(registry, "utf8")) : [];
  } catch {
    registeredChains = [];
  }
  polygonRegisteredChains = registeredChains;
  const legalMemo = readTextIfExists(gatePaths.legalCheck);
  const reviewShip = readTextIfExists(gatePaths.reviewShip);
  const reviewShipCanonical = readTextIfExists(gatePaths.reviewShipCanonical);
  const legalCheckCanonical = readTextIfExists(gatePaths.legalCheckCanonical);
  const stateDir = process.env.VET402_STATE_DIR ?? join(homedir(), "vet402-solana/state");
  const polyClient = client(pg);
  // USDC out of the payer on Polygon, from the Transfer logs since POLYGON_OUTFLOW_START_BLOCK (not a balance difference).
  const transfer = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
  const logsClient = createPublicClient({ transport: http(polygonLogsRpc()) }) as PublicClient;
  const polygonOutflow = polygonOutflowScanner({
    head: () => logsClient.getBlockNumber(),
    outflow: async (fromBlock, toBlock) => {
      const logs = await logsClient.getLogs({ address: pg.asset, event: transfer, args: { from: payer }, fromBlock, toBlock });
      return logs.reduce((n, l) => n + (l.args.value ?? 0n), 0n);
    },
  });
  // Only the Polygon lane's ledger: the Robinhood, Arbitrum and Tempo ledgers are other assets on other chains.
  const polygonLedgerCommitted = () => laneLedgerCommitted(resultsDir, "polygon");
  // POL that left the payer (the daily-root fees it pays) against the POL ledger, from its nonce and the receipts.
  const polReader = polSpendReaderFromClients(polyClient, receiptClient(pg), payer);
  const polSpendNow = () => measurePolygonPolSpend(polReader, polLedgerEntriesFromFile(readTextIfExists(join(resultsDir, POLYGON_POL_LEDGER_FILE))), payer);
  /** Every stop before a Polygon signature, read again from disk and chain each time. */
  const payGate = async (): Promise<string | null> => {
    let chainSpent: bigint;
    try {
      chainSpent = await polygonOutflow();
    } catch (err) {
      return `Polygon USDC outflow unreadable (${(err as Error).message.slice(0, 200)})`;
    }
    let polSpend: Awaited<ReturnType<typeof polSpendNow>>;
    try {
      polSpend = await polSpendNow();
    } catch (err) {
      return `Polygon POL outflow unreadable (${(err as Error).message.slice(0, 200)})`;
    }
    return polygonPayGateProblem({
      plannedTotalAtomic: picked.totalAtomic,
      ownerApproval: parsePolygonOwnerApproval(readTextIfExists(gatePaths.ownerApproval) ?? ""),
      env: process.env as Record<string, string | undefined>,
      legalCheckMemo: legalMemo,
      reviewShip,
      reviewShipCanonical,
      legalCheckCanonical,
      registeredChains,
      ...resolveSharedEvmTempoStop({ repoStateDir: stateDir }),
      paying: true,
      ledgerCommitted: polygonLedgerCommitted(),
      chainSpent,
      polSpend,
    });
  };
  if (pay) {
    // Before the preflight, the key and any signature: a stop here ends the run (exit 8).
    const stop = await payGate();
    if (stop) {
      console.error(`${stop}; nothing signed`);
      process.exit(8);
    }
    await preflight(lane, picked.entries);
  } else {
    // The dry run says what a paying run would stop on now. It reads the same files and logs, and signs nothing.
    const wouldStop = await payGate();
    (summary.polygonHosts as Record<string, unknown>).payWouldStopOn = wouldStop;
    (summary.polygonHosts as Record<string, unknown>).outflowSinceBlock = POLYGON_OUTFLOW_START_BLOCK.toString();
    console.error(`[gate] a paying run would ${wouldStop ? `stop: ${wouldStop}` : "pass the 3.11 gates"}`);
  }
  const laneHeld = laneLedgerPurchaseCount(laneLedgerPath(lane, resultsDir));
  const laneBudgetFile = pay ? laneLedgerPath(lane, resultsDir) : null;
  const laneBudget = new Budget(laneBudgetFile, lane.maxTotalAtomic, laneCountCapForHostRun(laneHeld), lane.maxPerAtomic);
  const budget = new RunBudget(
    new Budget(pay ? join(resultsDir, hostRunFiles(runDate, "polygon").ledger) : null, HOSTS_RUN.maxTotalAtomic, HOSTS_RUN.maxCount, HOSTS_RUN.maxPerAtomic),
    laneBudget,
  );
  // Each purchase: the outflow against the Polygon ledger before it is reserved, then every gate again before the signature.
  const beforeSign = pay ? payGate : undefined;
  const outflowCheck = pay ? async () => ({ ledgerCommitted: polygonLedgerCommitted(), chainSpent: await polygonOutflow() }) : undefined;
  results.push(
    await runLane(lane, picked.entries, raw402, new Map(), {
      budget,
      minAtomic: HOSTS_RUN.minAtomic,
      maxPerAtomic: HOSTS_RUN.maxPerAtomic,
      ...(beforeSign ? { beforeSign } : {}),
      ...(outflowCheck ? { outflowCheck } : {}),
    }),
  );
} else if (laneArg === "robinhood") {
  const rh = EVM_CHAINS.robinhood;
  const lane = LANES.robinhood;
  await checkDomain(rh);
  if (hostsRun) {
    // One purchase per host, inside the host run's own caps. No stock entries: those stay on the plain robinhood lane.
    const groups = groupByHost(cat.items, rh, { minAtomic: HOSTS_RUN.minAtomic, maxPerAtomic: HOSTS_RUN.maxPerAtomic, ownHosts: OWN_HOSTS, today: runDate, lastPaid: lastPaid(["robinhood"]) });
    const choices = await confirmLiveHosts(groups, rh, probe, { payer, minAtomic: HOSTS_RUN.minAtomic, maxPerAtomic: HOSTS_RUN.maxPerAtomic });
    const picked = pickHostEntries(choices, { maxTotalAtomic: HOSTS_RUN.maxTotalAtomic, maxCount: HOSTS_RUN.maxCount, runDate, hostRunKind: "robinhood" });
    if (picked.entries.length > HOSTS_RUN.maxCount || picked.totalAtomic > HOSTS_RUN.maxTotalAtomic) {
      throw new Error(`host run plan is ${picked.entries.length} purchases totaling ${picked.totalAtomic} atomic, above ${HOSTS_RUN.maxCount} or ${HOSTS_RUN.maxTotalAtomic}; nothing signed`);
    }
    if (pay) {
      // A paying host run buys only what the plan sent before paying says (--plan <the dry run's output>).
      const planFile = arg("--plan");
      if (!planFile) throw new Error("--hosts --pay needs --plan <results/evm/robinhood-hosts-dryrun.json>; nothing signed");
      const sent = (JSON.parse(readFileSync(planFile, "utf8")) as { robinhoodHosts?: { plan?: PlanRow[] } }).robinhoodHosts?.plan;
      if (!Array.isArray(sent)) throw new Error(`${planFile} has no robinhoodHosts.plan; nothing signed`);
      const kept = keepPlanned(picked.entries, sent);
      for (const d of kept.dropped) console.error(`[plan] not paid: ${d.host}: ${d.why}`);
      picked.left.push(...kept.dropped);
      picked.entries = kept.entries;
      picked.totalAtomic = kept.entries.reduce((n, e) => n + BigInt(e.lock.amount), 0n);
    }
    const raw402 = new Map(choices.flatMap((c) => (c.chosen ? [[c.chosen.resource, c.chosen.raw402] as const] : [])));
    const plan = picked.entries.map((e) => ({ host: e.agentId.slice("host:".length), resource: e.resource, method: e.method, payTo: e.lock.payTo, amountAtomic: e.lock.amount }));
    summary.robinhoodHosts = {
      hostsInCatalogs: groups.length,
      hostsWithLive402: choices.filter((c) => c.chosen).length,
      plan,
      planTotalAtomic: picked.totalAtomic.toString(),
      left: picked.left,
      choices: choices.map((c) => ({ host: c.host, chosen: c.chosen ? { resource: c.chosen.resource, liveAmount: c.chosen.liveAmount, payTo: c.chosen.payTo } : null, tried: c.tried })),
    };
    console.error(["host", "amount", "payTo", "resource"].join("\t"));
    for (const row of plan) console.error([row.host, row.amountAtomic, row.payTo, row.resource].join("\t"));
    console.error(`total\t${picked.totalAtomic}`);
    if (pay) await preflight(lane, picked.entries);
    const laneHeld = laneLedgerPurchaseCount(laneLedgerPath(lane, resultsDir));
    const budget = new RunBudget(
      new Budget(pay ? join(resultsDir, hostRunFiles(runDate, "robinhood").ledger) : null, HOSTS_RUN.maxTotalAtomic, HOSTS_RUN.maxCount, HOSTS_RUN.maxPerAtomic),
      // The lane ledger takes the run's purchases on top of what it already holds, in this run only: LANES.robinhood stays as it is.
      new Budget(pay ? laneLedgerPath(lane, resultsDir) : null, lane.maxTotalAtomic, laneCountCapForHostRun(laneHeld), lane.maxPerAtomic),
    );
    results.push(await runLane(lane, picked.entries, raw402, new Map(), { budget, minAtomic: HOSTS_RUN.minAtomic, maxPerAtomic: HOSTS_RUN.maxPerAtomic }));
  } else {
    const groups = groupByPayTo(cat.items, rh, { maxPerAtomic: lane.maxPerAtomic, ownHosts: OWN_HOSTS, today, lastPaid: lastPaid(["robinhood"]) });
    const choices = await confirmLive(groups, rh, probe, { payer, maxPerAtomic: lane.maxPerAtomic });
    const raw402 = new Map(choices.flatMap((c) => (c.chosen ? [[c.chosen.resource, c.chosen.raw402] as const] : [])));
    let entries = laneEntries(choices, rh);

    // The stock-price check replaces that seller's single census purchase (same payTo, one ticker each).
    const stockProbe = await probe({ resource: STOCK_SELLER.resource, query: { ticker: STOCK_REFS[0]!.ticker }, method: "GET", body: null });
    const stockAccept = stockProbe.accepts.find((a) => a.network === rh.caip2 && a.scheme === "exact" && eqAddr(a.asset, rh.asset));
    const refs = new Map<string, StockReference>();
    let directory: string[] = ["not read"];
    try {
      const dir = (await (await fetch(CHAINLINK_DIRECTORY, { signal: AbortSignal.timeout(30_000) })).json()) as { name?: string; proxyAddress?: string; heartbeat?: number }[];
      directory = checkAgainstDirectory(STOCK_REFS, dir);
    } catch (err) {
      directory = [`directory unreadable: ${(err as Error).message}`];
    }
    if (directory.length) throw new Error(`Chainlink directory disagrees with the fixed feeds: ${directory.join("; ")}`);
    for (const r of STOCK_REFS) refs.set(r.ticker, await readStockReference(client(rh), r));
    if (stockAccept) {
      const stock = stockEntries(stockAccept.payTo as Address, stockAccept.amount);
      entries = [...entries.filter((e) => !eqAddr(e.lock.payTo, stockAccept.payTo)), ...stock];
      for (const s of stock) raw402.set(s.resource, stockProbe.raw);
    }
    summary.robinhood = {
      payTosInCatalogs: groups.length,
      payTosWithLive402: choices.filter((c) => c.chosen).length,
      choices: choiceSummary(choices),
      stockSeller: stockAccept ? { resource: STOCK_SELLER.resource, payTo: stockAccept.payTo, amount: stockAccept.amount } : { resource: STOCK_SELLER.resource, live402: stockProbe.status, note: "no Robinhood Chain USDG accept now" },
      stockReferences: [...refs.values()],
      chainlinkDirectoryCheck: "fixed feeds match the directory (name, proxy, heartbeat)",
    };
    if (pay) await preflight(lane, entries);
    results.push(await runLane(lane, entries, raw402, refs));
  }
} else {
  const arb = EVM_CHAINS.arbitrum;
  const base = EVM_CHAINS.base;
  await checkDomain(arb);
  await checkDomain(base);
  const lane = LANES.arbitrum;
  const groups = groupByPayTo(cat.items, arb, { sameOn: base, maxPerAtomic: lane.maxPerAtomic, ownHosts: OWN_HOSTS, today, lastPaid: lastPaid(["arbitrum", "base-compare"]) });
  const choices = await confirmLive(groups, arb, probe, { payer, maxPerAtomic: lane.maxPerAtomic, sameOn: base });
  const raw402 = new Map(choices.flatMap((c) => (c.chosen ? [[c.chosen.resource, c.chosen.raw402] as const] : [])));
  const arbEntries = laneEntries(choices, arb, base);
  const baseEntries = mirrorEntries(arbEntries, choices, base, arb);
  summary.arbitrum = { payTosInCatalogs: groups.length, payTosWithLive402: choices.filter((c) => c.chosen).length, choices: choiceSummary(choices) };
  // Both lanes are checked before either signs anything.
  if (pay) {
    await preflight(lane, arbEntries);
    await preflight(LANES["base-compare"], baseEntries);
  }
  results.push(await runLane(lane, arbEntries, raw402, new Map()));
  results.push(await runLane(LANES["base-compare"], baseEntries, raw402, new Map()));
}

// ---- the chain check: whether each purchase settled is read from the chain, not from the seller's header ----
if (pay) {
  for (const r of results) {
    try {
      const c = await checkLaneFiles(r.lane, payer, resultsDir);
      console.error(`[chain check] ${r.lane}: ${JSON.stringify(c.tally)}${c.failed ? " (unmatched, ambiguous or pending: run scripts/evm-chaincheck.ts again after the windows close)" : ""}`);
      if (c.failed) process.exitCode = 1;
    } catch (err) {
      console.error(`[chain check] ${r.lane} failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  }
}

// ---- funding: what 0x9B59 needs on each chain for these purchases (the facilitator pays the gas) ----
const funding: Record<string, unknown> = {};
for (const r of results) {
  const c = Object.values(EVM_CHAINS).find((x) => x.caip2 === r.chain)!;
  const b = await balances(c);
  const need = BigInt(r.wouldPayAtomic) - BigInt(b.assetAtomic);
  funding[r.lane] = {
    chain: c.caip2,
    asset: c.assetSymbol,
    wouldPayAtomic: r.wouldPayAtomic,
    wouldPay: atomicToUsdc(r.wouldPayAtomic),
    balanceAtomic: b.assetAtomic,
    balanceEthWei: b.ethWei,
    shortfallAtomic: (need > 0n ? need : 0n).toString(),
    purchases: r.records.filter((x) => x.outcome === "would_pay" || x.outcome === "sent").length,
    // 3.11-4: a deposit is asked only for a chain in wallet_registry.json, after funding_need_check.py; never Monad while FAIL.
    ...(r.lane === "polygon" ? { depositRequest: monadFundingGateProblem(c.caip2, polygonRegisteredChains ?? []) ?? "registered: ask only after funding_need_check.py writes latest.json" } : {}),
  };
}
summary.funding = funding;
summary.results = results;
const text = JSON.stringify(summary, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n";
mkdirSync(resultsDir, { recursive: true });
// A paying run plans again from live 402s; its plan is what the published rows must be read against.
const hostsOut = runDate === hostRunLegacyDate
  ? (pay ? `${hostRunKind}-hosts-paid-run.json` : `${hostRunKind}-hosts-dryrun.json`)
  : (pay ? `${hostRunKind}-hosts-${runDate}-paid-run.json` : `${hostRunKind}-hosts-${runDate}-dryrun.json`);
const outName = hostsRun ? hostsOut : pay ? `${laneArg}-paid-run.json` : `${laneArg}-dryrun.json`;
writeFileSync(join(resultsDir, outName), text);
const brief = results.map((r) => ({
  lane: r.lane,
  entries: r.entries,
  outcomes: r.records.reduce<Record<string, number>>((m, x) => ((m[x.outcome] = (m[x.outcome] ?? 0) + 1), m), {}),
  refusals: r.records.filter((x) => x.refusal).map((x) => `${x.resource} ${x.refusal!.refused}`),
  predictedProblems: r.records.filter((x) => x.predictedProblem).map((x) => `${x.resource}: ${x.predictedProblem}`),
  wouldPay: atomicToUsdc(r.wouldPayAtomic),
}));
console.log(JSON.stringify({ mode: summary.mode, lane: laneArg, catalogs: cat.sources, funding, brief }, null, 2));
if (!existsSync(resultsDir)) mkdirSync(resultsDir, { recursive: true });
