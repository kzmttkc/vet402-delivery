/**
 * "What an escrow would have returned": from the purchases in data/ (the same inputs and the same rules as the
 * ranking), the purchases whose payment settled on chain and where the ranking puts the failure on the seller's
 * side (src/rank/classify.ts: settled_not_delivered and paid_not_delivered). An escrow that pays the seller only
 * on a DELIVERED record and returns the money on NOT_DELIVERED would have returned these.
 *
 * Read-only: reads data/ and checks every file against data/manifest.json. Signs and sends nothing.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OWN_HOSTS } from "../constants.js";
import { classifyFailure } from "../rank/classify.js";
import { SETTLED_LINE } from "../rank/report.js";
import {
  annotateTempoInput,
  normalizeAlgorand,
  normalizeBase,
  normalizeSolanaCensus,
  normalizeSolanaGate1,
  normalizeTempoLedger,
  parseTempoRunLog,
  tempoPlanUrls,
} from "../rank/normalize.js";
import { sellerKeys } from "../rank/score.js";
import type { Attempt, Chain } from "../rank/types.js";
import { notifiedSellers, sellerWasTold, type NotifiedFile } from "../receipt/publish.js";
import { normalizeRemeasure } from "../remeasure/normalize.js";
import type { LanePublic } from "../evm/site.js";

interface DataEntry {
  label: string;
  path: string;
  sha256: string;
  loggedAt?: string;
}

/** The ranking's purchases from data/ only, read exactly as `npm run rank -- --data data --offline` reads them. */
export function loadAttemptsFromData(dataDir: string): { date: string; attempts: Attempt[] } {
  const manifest = JSON.parse(readFileSync(join(dataDir, "manifest.json"), "utf8")) as { date: string; files: DataEntry[] };
  const entry = (label: string): DataEntry => {
    const e = manifest.files.find((f) => f.label === label);
    if (!e) throw new Error(`data/manifest.json has no input "${label}"`);
    return e;
  };
  const read = (label: string): string => {
    const e = entry(label);
    const text = readFileSync(join(dataDir, e.path), "utf8");
    const got = createHash("sha256").update(text).digest("hex");
    if (got !== e.sha256) throw new Error(`data/${e.path}: sha256 ${got} != manifest ${e.sha256}`);
    return text;
  };
  const date = manifest.date;
  const attempts: Attempt[] = [];
  for (const d of ["2026-09-27", "2026-09-28"]) attempts.push(...normalizeAlgorand(JSON.parse(read(`algorand/census-${d}`)), `algorand/census-${d}`));
  attempts.push(...normalizeSolanaCensus(JSON.parse(read("solana/census-2026-09-28")), "solana/census-2026-09-28"));
  attempts.push(...normalizeSolanaGate1(JSON.parse(read("solana/gate1-2026-09-29")), "solana/gate1-2026-09-29"));
  const plan = JSON.parse(read("tempo/census-plan-2026-09-28"));
  attempts.push(...normalizeTempoLedger(JSON.parse(read("tempo/ledger")), "tempo/ledger"));
  const logAt = entry("tempo/run-log").loggedAt;
  if (!logAt) throw new Error("data/manifest.json: tempo/run-log has no loggedAt");
  attempts.push(...parseTempoRunLog(read("tempo/run-log"), tempoPlanUrls(plan, "tempo/plan"), logAt, "tempo/run-log"));
  attempts.push(...normalizeBase(read("base/purchases"), JSON.parse(read("base/feedback-ledger")), "base/purchases"));
  const remeasure = manifest.files
    .map((f) => f.label)
    .filter((l) => /^remeasure\/(solana|tempo)-\d{4}-\d{2}-\d{2}$/.test(l) && l.slice(-10) <= date)
    .sort();
  for (const label of remeasure) attempts.push(...normalizeRemeasure(JSON.parse(read(label)), label));
  return { date, attempts: annotateTempoInput(attempts, plan, "tempo/plan") };
}

/** Rules whose failures an escrow keyed on the signed verdict would have returned to the buyer (fault: seller, payment settled). */
export const REFUND_RULES = ["settled_not_delivered", "paid_not_delivered"] as const;
/** Settled, not delivered, and the ranking puts it on vet402's side: vet402 sent a wrong request. Not an escrow refund. */
export const VET402_INPUT_RULES = ["paid_then_4xx_vet402_input"] as const;

/** A sum of USD stablecoin amounts in millionths (every chain here uses a 6-decimal USD token). */
interface Money {
  purchases: number;
  /** USD, 6 decimals, as a decimal string. */
  amountUsd: string;
  /** Purchases whose price the input did not record (counted in `purchases`, not in `amountUsd`). */
  priceNotRecorded: number;
}

/**
 * Chains whose purchases vet402 signs records for (x402-observation, data/records): only there can an escrow be
 * settled by a record. Algorand purchases are counted by the same rule but have no signed record, so they are
 * kept out of the headline totals and shown apart.
 */
export const SIGNED_RECORD_CHAINS: ReadonlySet<Chain> = new Set<Chain>(["solana", "tempo", "base"]);

type Totals = { settled: number; wouldRefund: Money; vet402Input: Money; cantTell: Money; sellers: number; notToldSellers: number };

export interface ChainRefund {
  chain: Chain;
  /** vet402 signs records of this chain's purchases (SIGNED_RECORD_CHAINS). */
  signedRecords: boolean;
  /** Tried purchases whose payment settled on chain. */
  settled: number;
  delivered: number;
  /** Settled, nothing usable back, seller's side: an escrow would have returned these to the buyer. */
  wouldRefund: Money & { byRule: Record<(typeof REFUND_RULES)[number], number> };
  /** Settled, not delivered, vet402's wrong request: an escrow would not have returned these. */
  vet402Input: Money;
  /** Settled, not delivered, and the ranking can't tell whose side (4xx, a placeholder input): left out. */
  cantTell: Money;
  /** Sellers with at least one purchase in `wouldRefund`. */
  sellers: number;
  /** Of those, the sellers vet402 has told (data/records/notified.json), by name. Everyone else is a count only. */
  toldSellers: { seller: string; purchases: number; amountUsd: string }[];
  notToldSellers: number;
}

export interface WouldRefundReport {
  kind: "vet402-escrow-would-refund";
  version: 0;
  /** data/manifest.json date: the purchases up to this UTC day. */
  dataDate: string;
  definition: string[];
  chains: ChainRefund[];
  /** Chains with signed records only: what an escrow keyed on the records could have returned. */
  totals: Totals;
  /** The same rule on chains without signed records (Algorand): shown apart, not in `totals`. */
  withoutSignedRecords: Totals;
  /** Robinhood Chain and Arbitrum (data/evm/): results for sellers not yet told are not published, so they are a count only. */
  withheldLanes: { lane: string; withheldPurchases: number }[];
}

export const DEFINITION = [
  "Counted: a purchase vet402 paid for whose payment settled, where nothing usable came back and the ranking puts the failure on the seller's side (rules settled_not_delivered and paid_not_delivered in src/rank/classify.ts: a 402 again after settling, a 5xx, no answer, another non-2xx that is not a 4xx, or a 2xx with an empty body). It is the same line as the NOT_DELIVERED verdict of the signed records (src/receipt/build.ts). An escrow that releases only on DELIVERED and returns on NOT_DELIVERED would have returned them.",
  "Not counted, shown apart: a settled purchase where the request vet402 sent was wrong (rule paid_then_4xx_vet402_input). That is vet402's mistake, not the seller's.",
  "Not counted, shown apart: a settled purchase the ranking cannot put on either side (other 4xx answers, a 402 after a placeholder input; rules paid_then_4xx and paid_then_402_placeholder). The signed records call the 4xx case UNCLEAR, and the example escrow leaves UNCLEAR to its deadline.",
  SETTLED_LINE,
  "Not counted: purchases whose payment did not settle (no money left the buyer), purchases on vet402's own hosts, and rows where settlement is unknown.",
  "Sellers vet402 has told (data/records/notified.json) are named. Every other seller is in the counts and amounts, never by name.",
  "Amounts are the prices vet402 paid, in USD stablecoins (USDC, USDC.e, pathUSD), summed at 6 decimals.",
  "The headline totals are Solana, Tempo and Base, where vet402 signs a record of each purchase. Algorand purchases follow the same rule but have no signed record that an escrow could check, so they are shown apart and are not in the totals.",
  "Robinhood Chain and Arbitrum purchases come from data/evm/, where the results for sellers not yet told are not published yet. They are given as a count of those purchases and are not in the totals.",
];

const ZERO = (): { purchases: number; micros: bigint; priceNotRecorded: number } => ({ purchases: 0, micros: 0n, priceNotRecorded: 0 });

/** "0.0123" -> 12300n (millionths). Rejects anything that is not a plain non-negative decimal with up to 6 places. */
export function usdToMicros(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6})\d*)?$/.exec(s.trim());
  if (!m) throw new Error(`not a price: ${s}`);
  if (/^\d+\.\d{7,}$/.test(s.trim()) && !/^\d+\.\d{6}0+$/.test(s.trim())) throw new Error(`price with more than 6 decimals: ${s}`);
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
}

export function microsToUsd(v: bigint): string {
  return `${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, "0")}`;
}

function add(acc: ReturnType<typeof ZERO>, a: Attempt): void {
  acc.purchases++;
  if (a.priceUsdc === null) acc.priceNotRecorded++;
  else acc.micros += usdToMicros(a.priceUsdc);
}
const money = (acc: ReturnType<typeof ZERO>): Money => ({ purchases: acc.purchases, amountUsd: microsToUsd(acc.micros), priceNotRecorded: acc.priceNotRecorded });

export function wouldRefund(opts: { date: string; attempts: readonly Attempt[]; notified: NotifiedFile | null; lanes?: readonly LanePublic[] }): WouldRefundReport {
  const own = new Set(OWN_HOSTS);
  const keep = opts.attempts.filter((a) => !own.has(a.host));
  const keys = sellerKeys(keep);
  const told = opts.notified ? notifiedSellers(opts.notified) : new Set<string>();
  const order: Chain[] = [];
  for (const a of keep) if (!order.includes(a.chain)) order.push(a.chain);
  const chains: ChainRefund[] = [];
  const acc = () => ({ refund: ZERO(), input: ZERO(), unclear: ZERO(), settled: 0, sellers: new Set<string>(), notTold: new Set<string>() });
  const signed = acc();
  const unsigned = acc();
  for (const chain of order) {
    const rows = keep.filter((a) => a.chain === chain && a.tried);
    const refund = ZERO();
    const input = ZERO();
    const unclear = ZERO();
    const byRule = { settled_not_delivered: 0, paid_not_delivered: 0 };
    const perSeller = new Map<string, ReturnType<typeof ZERO>>();
    let settled = 0;
    let delivered = 0;
    for (const a of rows) {
      if (a.settled !== true) continue;
      settled++;
      if (a.delivered) {
        delivered++;
        continue;
      }
      const c = classifyFailure(a);
      if ((REFUND_RULES as readonly string[]).includes(c.rule)) {
        if (c.fault !== "seller") throw new Error(`rule ${c.rule} is no longer on the seller's side`);
        add(refund, a);
        byRule[c.rule as (typeof REFUND_RULES)[number]]++;
        const k = keys.get(a)!;
        const s = perSeller.get(k) ?? ZERO();
        add(s, a);
        perSeller.set(k, s);
      } else if ((VET402_INPUT_RULES as readonly string[]).includes(c.rule)) add(input, a);
      else if (c.fault === "seller") throw new Error(`settled seller-side rule ${c.rule} is not in REFUND_RULES`);
      else add(unclear, a);
    }
    const toldSellers = [...perSeller]
      .filter(([k]) => sellerWasTold(k, told))
      .map(([seller, s]) => ({ seller, purchases: s.purchases, amountUsd: microsToUsd(s.micros) }))
      .sort((a, b) => b.purchases - a.purchases || a.seller.localeCompare(b.seller));
    const notTold = [...perSeller.keys()].filter((k) => !sellerWasTold(k, told));
    const all = SIGNED_RECORD_CHAINS.has(chain) ? signed : unsigned;
    chains.push({
      chain,
      signedRecords: SIGNED_RECORD_CHAINS.has(chain),
      settled,
      delivered,
      wouldRefund: { ...money(refund), byRule },
      vet402Input: money(input),
      cantTell: money(unclear),
      sellers: perSeller.size,
      toldSellers,
      notToldSellers: notTold.length,
    });
    for (const [to, from] of [
      [all.refund, refund],
      [all.input, input],
      [all.unclear, unclear],
    ] as const) {
      to.purchases += from.purchases;
      to.micros += from.micros;
      to.priceNotRecorded += from.priceNotRecorded;
    }
    all.settled += settled;
    for (const k of perSeller.keys()) all.sellers.add(`${chain} ${k}`);
    for (const k of notTold) all.notTold.add(`${chain} ${k}`);
  }
  const withheldLanes = (opts.lanes ?? []).map((l) => ({
    lane: l.lane,
    withheldPurchases: l.rows.filter((r) => r.status === "withheld").reduce((n, r) => n + (r.purchases ?? 1), 0),
  }));
  return {
    kind: "vet402-escrow-would-refund",
    version: 0,
    dataDate: opts.date,
    definition: DEFINITION,
    chains,
    totals: totalsOf(signed),
    withoutSignedRecords: totalsOf(unsigned),
    withheldLanes,
  };
}

function totalsOf(a: { refund: ReturnType<typeof ZERO>; input: ReturnType<typeof ZERO>; unclear: ReturnType<typeof ZERO>; settled: number; sellers: Set<string>; notTold: Set<string> }): Totals {
  return { settled: a.settled, wouldRefund: money(a.refund), vet402Input: money(a.input), cantTell: money(a.unclear), sellers: a.sellers.size, notToldSellers: a.notTold.size };
}

/** The whole report from a data/ folder. `recordsDir` is where notified.json is read (default <dataDir>/records). */
export function wouldRefundFromData(dataDir: string, recordsDir: string = join(dataDir, "records")): WouldRefundReport {
  const { date, attempts } = loadAttemptsFromData(dataDir);
  const nf = join(recordsDir, "notified.json");
  const notified = existsSync(nf) ? (JSON.parse(readFileSync(nf, "utf8")) as NotifiedFile) : null;
  const lanes: LanePublic[] = [];
  for (const l of ["robinhood", "arbitrum"]) {
    const p = join(dataDir, "evm", `${l}.json`);
    if (existsSync(p)) lanes.push(JSON.parse(readFileSync(p, "utf8")) as LanePublic);
  }
  return wouldRefund({ date, attempts, notified, lanes });
}
