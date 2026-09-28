/**
 * First-buyer mode (Solana): buy once, for life, from each x402 seller (payTo) that no one outside
 * vet402 has paid yet, and publish whether the payment settled and content came back.
 *
 *   npx tsx scripts/first-buyer.ts --dry-run --since 2026-09-21   # everything except paying
 *   npx tsx scripts/first-buyer.ts --init-ledger                  # once, before the first --pay: empty ledger
 *   npx tsx scripts/first-buyer.ts --pay                          # pays today's dry-run plan (explicit flag only)
 *
 * Who: the census union (PayAI + CDP Bazaar + Pay.sh; one cheapest GET per host at or under 0.10 USDC,
 * example input filled, vet402's own hosts removed), minus tunnel hosts, minus hosts not new since
 * --since, one target per payTo, minus vet402's own payTos, opt-outs (src/first-buyer/first-buyer-optout.json),
 * payTos the ledger does not allow, and payTos that ever received USDC (vet402 included; read live on chain before each attempt).
 *
 * Money: the existing path only (src/pay.ts payOne: payTo lock, guard, transaction read-back, Budget).
 * Caps: 0.10 USDC per purchase, 5 USDC per run, 20 USDC per month (results/first-buyer-budget-YYYY-MM.json).
 * Lifetime once per payTo: results/first-buyer-ledger.json, written before anything is signed, and
 * on chain: a payTo whose USDC account ever received USDC (vet402 included) is never signed for.
 * --pay stops when the ledger file is missing, when results/first-buyer.lock exists (another run),
 * or when the ledger and the month budget file disagree.
 * The run stops if the payer's SOL goes down.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CDP_DISCOVERY, PAYAI_DISCOVERY, PAYER_ADDRESS, atomicToUsdc } from "../src/constants.js";
import { fetchCatalog } from "../src/discovery.js";
import { jsonRpc, readBalances, waitForSettlement } from "../src/chain.js";
import { checkPaymentTransaction, usdcAta } from "../src/txcheck.js";
import { loadPayer, makeCreatePayment, throwawaySigner } from "../src/client.js";
import { fetchPaysh, payshListings } from "../src/paysh.js";
import { selectCensus } from "../src/census.js";
import { FB_MAX_PER_MONTH_ATOMIC, FB_MAX_PER_PURCHASE_ATOMIC, FB_MAX_PER_RUN_ATOMIC, FB_NOTE, FB_OWN_ADDRESSES, FB_PLAN_MAX_AGE_MS } from "../src/first-buyer/constants.js";
import { FirstBuyerBudget, monthKey } from "../src/first-buyer/budget.js";
import { FirstBuyerLedger, initLedgerFile } from "../src/first-buyer/ledger.js";
import { openPayRun } from "../src/first-buyer/payrun.js";
import { checkOutsideReceipts, type ReceiptCheck } from "../src/first-buyer/receipts.js";
import { choosePerPayTo, emptySeen, ownPayTosFromListings, parseOptOut, preselectHosts, recordSeen, tally, type Excluded, type SeenSnapshot } from "../src/first-buyer/select.js";
import { buyAll, probeHost, type BuyRow, type FirstBuyerTarget } from "../src/first-buyer/run.js";
import { publicRows, walletsJson } from "../src/first-buyer/publish.js";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const opt = (n: string) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const TODAY = new Date().toISOString().slice(0, 10);
const DATE = opt("--date") ?? TODAY;
const SINCE = opt("--since");
const RESULTS = join(ROOT, "results");
const PLAN_FILE = opt("--plan") ?? join(RESULTS, `first-buyer-${DATE}.dry-run.json`);
const OUT_FILE = join(RESULTS, `first-buyer-${DATE}.json`);
const LEDGER_FILE = join(RESULTS, "first-buyer-ledger.json");
const LOCK_FILE = join(RESULTS, "first-buyer.lock");
const SEEN_FILE = join(RESULTS, "first-buyer-seen.json");
const WALLETS_FILE = join(RESULTS, "first-buyer", "wallets.json");
const PUBLIC_ROWS_FILE = join(RESULTS, "first-buyer", "purchases.json");
const OPTOUT_FILE = join(ROOT, "src", "first-buyer", "first-buyer-optout.json");
const KEY_FILE = join(ROOT, ".keys", "payer.json");
const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";

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
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
}

function readSeen(): SeenSnapshot {
  if (!existsSync(SEEN_FILE)) return emptySeen();
  const s = JSON.parse(readFileSync(SEEN_FILE, "utf8")) as SeenSnapshot;
  if (!Array.isArray(s.runs) || typeof s.firstSeen !== "object") throw new Error(`${SEEN_FILE} has an unexpected shape`);
  return s;
}

function readOptOut(): Set<string> {
  if (!existsSync(OPTOUT_FILE)) throw new Error(`opt-out file ${OPTOUT_FILE} is missing; refusing to run without it`);
  return new Set(parseOptOut(readFileSync(OPTOUT_FILE, "utf8")));
}

function monthFile(now: Date): string {
  return join(RESULTS, `first-buyer-budget-${monthKey(now)}.json`);
}

function requireSince(): string {
  if (!SINCE || !/^\d{4}-\d{2}-\d{2}$/.test(SINCE) || Number.isNaN(Date.parse(SINCE))) {
    console.error("--since YYYY-MM-DD is required (sellers new since that date)");
    process.exit(2);
  }
  return SINCE;
}

async function dryRun() {
  const since = requireSince();
  const now = new Date();
  const rpc = jsonRpc(RPC_URL);
  const before = await readBalances(rpc, PAYER_ADDRESS);
  const [payai, cdp, paysh] = await Promise.all([
    fetchCatalog(PAYAI_DISCOVERY, { pageLimit: 1000, sleepMs: 200 }),
    fetchCatalog(CDP_DISCOVERY, { pageLimit: 1000, sleepMs: 200 }),
    fetchPaysh(),
  ]);
  if (!payai.complete || !cdp.complete) throw new Error("a catalog did not finish paging; the union cannot be decided");
  if (paysh.failed.length) console.warn(`pay.sh: ${paysh.failed.length} provider detail files failed: ${paysh.failed.join(", ")}`);
  const own = new Set([...FB_OWN_ADDRESSES, ...ownPayTosFromListings([...payai.items, ...cdp.items])]);
  const sel = selectCensus({ payai: payai.items, cdp: cdp.items, paysh: payshListings(paysh.providers) }, { maxPer: FB_MAX_PER_PURCHASE_ATOMIC });
  const seen = readSeen();
  const pre = preselectHosts(sel.hosts, { since, seen });

  const probed = await pool(pre.keep, 6, (hp) => probeHost(hp, fetch));
  const probeExcluded: Excluded[] = probed.filter((p) => p.excluded).map((p) => p.excluded!);
  const locked: FirstBuyerTarget[] = probed.filter((p) => p.target).map((p) => p.target!);

  const ledger = new FirstBuyerLedger(LEDGER_FILE, true); // read, never written in a dry run
  const optOut = readOptOut();
  const chosen = choosePerPayTo(locked, { own, optOut, ledger: (p) => ledger.eligibility(p, now) });

  const receipts = new Map<string, ReceiptCheck>();
  await pool(chosen.kept, 3, async (t) => {
    receipts.set(t.lock.payTo, await checkOutsideReceipts(rpc, t.lock.payTo, own));
  });
  // RPC errors (rate limits) make a payTo "unverified"; read those again one at a time, slowly.
  for (const [p, c] of receipts) {
    if (c.verdict !== "unverified" || !c.detail.startsWith("rpc:")) continue;
    await new Promise((r) => setTimeout(r, 2_000));
    receipts.set(p, await checkOutsideReceipts(rpc, p, own));
  }

  const monthSpent = new FirstBuyerBudget(existsSync(monthFile(now)) ? monthFile(now) : null).spent;
  const monthLeft = FB_MAX_PER_MONTH_ATOMIC > monthSpent ? FB_MAX_PER_MONTH_ATOMIC - monthSpent : 0n;
  const budget = new FirstBuyerBudget(null, FB_MAX_PER_RUN_ATOMIC, monthLeft);
  const throwaway = await throwawaySigner();
  const res = await buyAll(chosen.kept, {
    pay: {
      fetch,
      payer: PAYER_ADDRESS,
      signerAddress: throwaway.address,
      dryRun: true,
      createPayment: makeCreatePayment(throwaway, RPC_URL),
      checkTx: checkPaymentTransaction,
      readBalances: () => readBalances(rpc, PAYER_ADDRESS),
      waitForSettlement: async () => null,
    },
    budget,
    ledger,
    own,
    optOut,
    checkReceipts: async (p) => receipts.get(p) ?? checkOutsideReceipts(rpc, p, own),
    now: () => now,
    continueAfterCap: true,
  });
  const after = await readBalances(rpc, PAYER_ADDRESS);

  const would = res.rows.filter((r) => r.outcome === "would_pay");
  const byPayTo = new Map(chosen.kept.map((t) => [t.lock.payTo, t]));
  const targets = would.map((r) => byPayTo.get(r.payTo)!);
  const total = targets.reduce((s, t) => s + BigInt(t.lock.amount), 0n);
  const loopExcluded: Excluded[] = res.rows.filter((r) => r.outcome !== "would_pay").map((r) => ({ host: r.host, payTo: r.payTo, reason: r.reason, detail: r.detail }));
  const excluded = [...pre.excluded, ...probeExcluded, ...chosen.excluded, ...loopExcluded];
  const receiptVerdicts: Record<string, number> = {};
  for (const c of receipts.values()) receiptVerdicts[c.verdict] = (receiptVerdicts[c.verdict] ?? 0) + 1;

  const summary = {
    since,
    newnessBasis: pre.basis,
    hostsInUnion: sel.hosts.length,
    hostsAfterCatalogFilters: pre.keep.length,
    hostsWithValid402: locked.length,
    payTosAfterLedgerOptOutOwn: chosen.kept.length,
    receiptVerdicts,
    payTosWithoutUsdcAccount: [...receipts.values()].filter((c) => !c.ataExists).length,
    targets: targets.length,
    estimatedTotalUsdc: atomicToUsdc(total),
    runCapUsdc: atomicToUsdc(FB_MAX_PER_RUN_ATOMIC),
    monthLeftUsdc: atomicToUsdc(monthLeft),
    perPurchaseCapUsdc: atomicToUsdc(FB_MAX_PER_PURCHASE_ATOMIC),
    excludedByReason: tally(excluded),
    payerUsdcBefore: atomicToUsdc(before.usdcAtomic),
    payerUsdcAfter: atomicToUsdc(after.usdcAtomic),
    payerLamportsBefore: before.lamports.toString(),
    payerLamportsAfter: after.lamports.toString(),
  };
  writeJson(PLAN_FILE, {
    kind: "first-buyer-dry-run",
    createdAt: now.toISOString(),
    payer: PAYER_ADDRESS,
    note: FB_NOTE,
    definition:
      "Census union (PayAI, CDP Bazaar, Pay.sh), one cheapest GET per host at or under 0.10 USDC with a usable example; not a tunnel host; new since --since; one per payTo; not vet402's own payTo; not opted out; allowed by the lifetime ledger; no USDC ever received by the payTo, vet402 included, and its USDC account exists; within 5 USDC per run and 20 USDC per month.",
    catalogs: { payai: payai.total, cdp: cdp.total, payshProviders: paysh.providerCount, payshDetailFilesFailed: paysh.failed },
    ownPayTos: [...own].sort(),
    summary,
    targets,
    rows: res.rows,
    excluded,
  });
  writeJson(SEEN_FILE, recordSeen(seen, sel.hosts.map((h) => h.host), DATE));
  writeJson(WALLETS_FILE, walletsJson());

  console.log(`plan written: ${PLAN_FILE}`);
  console.log(`union hosts ${sel.hosts.length} -> after catalog filters ${pre.keep.length} (newness basis: ${pre.basis}) -> valid 402 ${locked.length} -> payTos ${chosen.kept.length}`);
  console.log(`receipt check: ${JSON.stringify(receiptVerdicts)}; payTos without a USDC account: ${summary.payTosWithoutUsdcAccount}`);
  console.log(`excluded: ${JSON.stringify(summary.excludedByReason)}`);
  for (const t of targets) console.log(`would_pay ${t.host.padEnd(40)} ${atomicToUsdc(t.lock.amount)} payTo=${t.lock.payTo}`);
  console.log(`TARGETS ${targets.length} payTos, estimated ${summary.estimatedTotalUsdc} USDC (run cap ${summary.runCapUsdc}, month left ${summary.monthLeftUsdc}, <= ${summary.perPurchaseCapUsdc} each)`);
  console.log(`payer USDC before ${summary.payerUsdcBefore} after ${summary.payerUsdcAfter}; SOL lamports before ${summary.payerLamportsBefore} after ${summary.payerLamportsAfter}`);
}

async function pay(): Promise<number> {
  const now = new Date();
  // Lock, then the ledger (must exist), then the month budget; each stops the run on failure.
  const run = openPayRun({ lock: LOCK_FILE, ledger: LEDGER_FILE, month: monthFile(now) }, now);
  try {
    if (!existsSync(PLAN_FILE)) throw new Error(`no plan at ${PLAN_FILE}; run --dry-run first`);
    const plan = JSON.parse(readFileSync(PLAN_FILE, "utf8")) as { kind: string; createdAt: string; targets: FirstBuyerTarget[]; ownPayTos: string[] };
    if (plan.kind !== "first-buyer-dry-run") throw new Error("plan file is not a first-buyer dry run");
    if (!(Date.now() - Date.parse(plan.createdAt) <= FB_PLAN_MAX_AGE_MS)) throw new Error("plan is older than 24 hours; run --dry-run again");
    const { ledger, budget } = run;
    const rpc = jsonRpc(RPC_URL);
    const signer = await loadPayer(KEY_FILE);
    const payerAta = await usdcAta(PAYER_ADDRESS);
    const own = new Set([...FB_OWN_ADDRESSES, ...plan.ownPayTos]);
    const start = await readBalances(rpc, PAYER_ADDRESS);
    budget.setBaselineIfMissing(start.usdcAtomic);
    const rows: BuyRow[] = [];
    const save = (stopped: string | null) => {
      writeJson(OUT_FILE, { kind: "first-buyer-live", ranAt: now.toISOString(), payer: PAYER_ADDRESS, note: FB_NOTE, plan: PLAN_FILE, ledger: LEDGER_FILE, stopped, rows });
      writeJson(PUBLIC_ROWS_FILE, { kind: "vet402-first-buyer-purchases", note: FB_NOTE, rows: publicRows(ledger.data) });
      writeJson(WALLETS_FILE, walletsJson());
    };
    const res = await buyAll(plan.targets, {
      pay: {
        fetch,
        payer: PAYER_ADDRESS,
        createPayment: makeCreatePayment(signer, RPC_URL),
        checkTx: checkPaymentTransaction,
        readBalances: () => readBalances(rpc, PAYER_ADDRESS),
        waitForSettlement: (sig: string | null, memo: string | null, payTo: string) =>
          waitForSettlement({ rpc, signature: sig, memo, payer: PAYER_ADDRESS, payerUsdcAta: payerAta, payTo }),
      },
      budget,
      ledger,
      own,
      optOut: readOptOut(),
      // Live chain read right before each attempt (the chain fence); never a cached result.
      checkReceipts: (p) => checkOutsideReceipts(rpc, p, own),
      log: (r) => {
        rows.push(r);
        save(null);
        console.log(`${r.outcome.padEnd(8)} ${r.host.padEnd(40)} ${r.priceUsdc ?? "-"} settled=${r.settled ?? "-"} delivered=${r.delivered ?? "-"} tx=${r.tx ?? "-"} ${r.reason}`);
      },
    });
    save(res.stopped);
    console.log(`sent ${rows.filter((r) => r.outcome === "sent").length}, run spent ${atomicToUsdc(budget.runSpentAtomic)} USDC, month ledger ${atomicToUsdc(budget.spent)} USDC${res.stopped ? `; stopped: ${res.stopped}` : ""}`);
    console.log(`results: ${OUT_FILE}`);
    return res.stopped?.startsWith("payer SOL decreased") ? 1 : 0;
  } finally {
    run.release();
  }
}

if (flag("--dry-run")) await dryRun();
else if (flag("--init-ledger")) {
  initLedgerFile(LEDGER_FILE);
  console.log(`empty ledger created: ${LEDGER_FILE}`);
} else if (flag("--pay")) process.exitCode = await pay();
else {
  console.error("usage: first-buyer.ts --dry-run --since YYYY-MM-DD | --init-ledger (once) | --pay   (paying requires the explicit --pay flag)");
  process.exit(2);
}
