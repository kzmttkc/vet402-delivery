/**
 * EVM purchase lanes on Robinhood Chain and Arbitrum One, from the shared payer 0x9B59…4E51.
 *
 *   npx tsx scripts/evm-lane.ts --lane robinhood [--dry-run]     (default; throwaway signer, nothing sent)
 *   npx tsx scripts/evm-lane.ts --lane arbitrum  [--dry-run]     (Arbitrum One + the same listings on Base)
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
 * Outputs: results/evm/<lane>-dryrun.json | results/evm/<lane>-purchases.jsonl (+ the lanes' ledgers) with --pay.
 * Options: --catalogs <dir> reads catalog_cdp.json / catalog_dexter.json / catalog_payai.json instead of fetching.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, erc20Abi, hashDomain, http, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { CDP_DISCOVERY, MEASURE_MAX_PER_SELLER, MEASURE_SPACING_MS, OWN_HOSTS, PAYAI_DISCOVERY, atomicToUsdc } from "../src/constants.js";
import { fetchCatalog, type Listing } from "../src/discovery.js";
import { Budget } from "../src/guard.js";
import { EVM_CHAINS, LANES, RUN_LANES, fundingProblem, payGateProblem, type EvmChainSpec, type LaneId, type LaneSpec } from "../src/evm/chains.js";
import { buyOneOnChain, eqAddr, probe402, type ChainBuyEntry, type ChainBuyRecord, type TypedDataSigner } from "../src/evm/evm-buy.js";
import { readUsdcTransfer } from "../src/evm/erc8004.js";
import { loadEvmAccount, readPublicAddress } from "../src/evm/key.js";
import { DEXTER_DISCOVERY, STOCK_SELLER, confirmLive, groupByPayTo, laneEntries, mirrorEntries, stockEntries, type LiveChoice, type Probe } from "../src/evm/lane-plan.js";
import { classifyRecord, predictFacilitator } from "../src/evm/settle-cause.js";
import { checkLaneFiles } from "../src/evm/chaincheck-run.js";
import { lastPaidByListing, type LastPaid } from "../src/evm/lane-input.js";
import { loadLaneRecordsChecked, payStopForUnreadableLines } from "../src/evm/lane-records.js";
import { CHAINLINK_DIRECTORY, STOCK_REFS, checkAgainstDirectory, compareStockAnswer, readStockReference, type StockReference } from "../src/robinhood/stock-check.js";

const argv = process.argv.slice(2);
const arg = (n: string): string | undefined => {
  const i = argv.indexOf(n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const laneArg = arg("--lane");
if (laneArg !== "robinhood" && laneArg !== "arbitrum") throw new Error("--lane robinhood | arbitrum");
const pay = argv.includes("--pay");
if (pay && argv.includes("--dry-run")) throw new Error("choose one of --dry-run / --pay");
if (pay) {
  const problem = payGateProblem(laneArg, process.env.VET402_EVM_PAY);
  if (problem) throw new Error(`${problem} (set only after the independent review)`);
}
const catalogsDir = arg("--catalogs");

// The records this run reads (what not to buy again, and rule 0's material) must be whole before anything else:
// a paying run with an unreadable line stops here, before the key, the catalogs or any purchase.
const recordLanes = RUN_LANES[laneArg];
const recordsRead = loadLaneRecordsChecked(recordLanes);
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

async function runLane(lane: LaneSpec, entries: ChainBuyEntry[], raw402: Map<string, string>, stockRefs: Map<string, StockReference>): Promise<LaneResult> {
  const c = EVM_CHAINS[lane.chain];
  const signer: TypedDataSigner = pay ? loadEvmAccount() : privateKeyToAccount(generatePrivateKey()); // dry run: throwaway, pays nobody
  if (pay && !eqAddr(signer.address, payer)) throw new Error("key address != evm.pub");
  const budget = new Budget(pay ? lane.ledger : null, lane.maxTotalAtomic, lane.maxCount, lane.maxPerAtomic);
  const lastAt = new Map<string, number>();
  const perSeller = new Map<string, number>();
  const out: LaneResult["records"] = [];
  let would = 0n;
  mkdirSync("results/evm", { recursive: true });
  for (const e of entries) {
    const k = e.lock.payTo.toLowerCase();
    if ((perSeller.get(k) ?? 0) >= MEASURE_MAX_PER_SELLER) continue;
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
        maxPerAtomic: lane.maxPerAtomic,
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
    if (pay) appendFileSync(`results/evm/${lane.id}-purchases.jsonl`, JSON.stringify(row) + "\n");
  }
  return {
    lane: lane.id,
    chain: c.caip2,
    entries: entries.length,
    records: out,
    wouldPayAtomic: would.toString(),
    budget: { spentAtomic: budget.spent.toString(), count: budget.count, maxTotalAtomic: lane.maxTotalAtomic.toString(), maxPerAtomic: lane.maxPerAtomic.toString(), maxCount: lane.maxCount },
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
function lastPaid(laneIds: LaneId[]): Map<string, LastPaid> {
  return lastPaidByListing(recordsRead.rows.filter((r) => laneIds.includes(r.lane as LaneId)));
}

// ---------- main ----------
const cat = await catalogs();
const today = new Date().toISOString().slice(0, 10);
const summary: Record<string, unknown> = { generatedAt: new Date().toISOString(), mode: pay ? "pay" : "dry-run", lane: laneArg, payer, catalogs: cat.sources };
const results: LaneResult[] = [];

if (laneArg === "robinhood") {
  const rh = EVM_CHAINS.robinhood;
  const lane = LANES.robinhood;
  await checkDomain(rh);
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
      const c = await checkLaneFiles(r.lane, payer);
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
  };
}
summary.funding = funding;
summary.results = results;
const text = JSON.stringify(summary, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n";
mkdirSync("results/evm", { recursive: true });
// A paying run plans again from live 402s; its plan is what the published rows must be read against.
writeFileSync(pay ? `results/evm/${laneArg}-paid-run.json` : `results/evm/${laneArg}-dryrun.json`, text);
const brief = results.map((r) => ({
  lane: r.lane,
  entries: r.entries,
  outcomes: r.records.reduce<Record<string, number>>((m, x) => ((m[x.outcome] = (m[x.outcome] ?? 0) + 1), m), {}),
  refusals: r.records.filter((x) => x.refusal).map((x) => `${x.resource} ${x.refusal!.refused}`),
  predictedProblems: r.records.filter((x) => x.predictedProblem).map((x) => `${x.resource}: ${x.predictedProblem}`),
  wouldPay: atomicToUsdc(r.wouldPayAtomic),
}));
console.log(JSON.stringify({ mode: summary.mode, lane: laneArg, catalogs: cat.sources, funding, brief }, null, 2));
if (!existsSync("results/evm")) mkdirSync("results/evm", { recursive: true });
