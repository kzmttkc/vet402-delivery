/**
 * Catalog order vs vet402's own purchases.
 *
 * Catalog signals used (each is what the catalog itself publishes):
 *   CDP Bazaar  quality.l30DaysTotalCalls (summed per host), quality.l30DaysUniquePayers (max per host)
 *   Mercator    best rank a service reached across a query sweep (1 = first), from the Tempo census plan
 * PayAI discovery and mpp.dev/api/services publish no usage or quality number, so they have no order to compare.
 *
 * Both CDP numbers can be raised by the seller paying itself from many wallets; vet402's number cannot,
 * because only vet402's wallet writes it.
 */
import type { FailureEvidence, RankedSeller } from "./score.js";
import type { Chain, ReasonCategory } from "./types.js";

export interface CdpHost {
  host: string;
  resources: number;
  calls30d: number;
  maxUniquePayers30d: number;
  lastCalledAt: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Aggregate CDP discovery items (the `items` of every page) per host. */
export function cdpByHost(items: readonly unknown[]): Map<string, CdpHost> {
  const m = new Map<string, CdpHost>();
  for (const it of items) {
    if (!isObj(it) || typeof it.resource !== "string") continue;
    let host: string;
    try {
      host = new URL(it.resource).hostname.toLowerCase();
    } catch {
      continue;
    }
    const q = isObj(it.quality) ? it.quality : {};
    const calls = typeof q.l30DaysTotalCalls === "number" ? q.l30DaysTotalCalls : 0;
    const payers = typeof q.l30DaysUniquePayers === "number" ? q.l30DaysUniquePayers : 0;
    const last = typeof q.lastCalledAt === "string" ? q.lastCalledAt : null;
    const h = m.get(host) ?? { host, resources: 0, calls30d: 0, maxUniquePayers30d: 0, lastCalledAt: null };
    h.resources++;
    h.calls30d += calls;
    h.maxUniquePayers30d = Math.max(h.maxUniquePayers30d, payers);
    if (last && (h.lastCalledAt === null || last > h.lastCalledAt)) h.lastCalledAt = last;
    m.set(host, h);
  }
  return m;
}

export interface CompareRow {
  key: string;
  host: string;
  catalogValue: number;
  catalogPos: number;
  /** null = "measuring" (not enough counted purchases or days for a rank number). */
  vet402Rank: number | null;
  /** delivered + seller-side failures (vet402/facilitator-side and can't-tell failures are left out). */
  tried: number;
  delivered: number;
  deliveredRate: number;
  wilsonLower: number;
  chains: Chain[];
  failures: Partial<Record<ReasonCategory, number>>;
  paidButNotDelivered: number;
  tx: { chain: Chain; tx: string; url: string } | null;
  lastFailure: FailureEvidence | null;
}

export interface Comparison {
  catalog: string;
  metric: string;
  /** "desc": bigger catalog value = higher in the catalog (call counts). "asc": smaller = higher (rank). */
  direction: "desc" | "asc";
  overlap: number;
  /** Top half of the overlap by catalog order, rounded up. */
  highCutoffPos: number;
  highButNeverDelivered: CompareRow[];
  /** Of highButNeverDelivered: vet402's payment settled on-chain at least once and still nothing was delivered. */
  highButNeverDeliveredDespitePaidTx: number;
  lowButAlwaysDelivered: CompareRow[];
  misaligned: number;
  /** Spearman rank correlation between catalog order and vet402's Wilson score (ties averaged). */
  spearman: number | null;
  rule: string;
}

function avgRanks(values: readonly number[]): number[] {
  const idx = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(values.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1]![0] === idx[i]![0]) j++;
    const r = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k]![1]] = r;
    i = j + 1;
  }
  return out;
}

export function spearman(x: readonly number[], y: readonly number[]): number | null {
  if (x.length !== y.length || x.length < 3) return null;
  const rx = avgRanks(x);
  const ry = avgRanks(y);
  const n = x.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i]! - mx;
    const b = ry[i]! - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  return dx === 0 || dy === 0 ? null : num / Math.sqrt(dx * dy);
}

/**
 * `catalogValue(seller)` returns the catalog's number for that seller, or null when the catalog
 * does not list it. Only listed sellers are compared.
 */
export function compareWithCatalog(
  ranked: readonly RankedSeller[],
  catalog: string,
  metric: string,
  direction: "desc" | "asc",
  catalogValue: (s: RankedSeller) => number | null,
): Comparison {
  // Sellers with no counted purchase (every failure on vet402's side or unclear) are not compared.
  const listed = ranked
    .filter((s) => s.counted > 0)
    .map((s) => ({ s, v: catalogValue(s) }))
    .filter((x): x is { s: RankedSeller; v: number } => x.v !== null);
  listed.sort((a, b) => (direction === "desc" ? b.v - a.v : a.v - b.v) || (a.s.key < b.s.key ? -1 : a.s.key > b.s.key ? 1 : 0));
  const cutoff = Math.ceil(listed.length / 2);
  const rows: CompareRow[] = listed.map(({ s, v }, i) => ({
    key: s.key,
    host: s.host,
    catalogValue: v,
    catalogPos: i + 1,
    vet402Rank: s.rank,
    tried: s.counted,
    delivered: s.delivered,
    deliveredRate: s.deliveredRate,
    wilsonLower: s.wilsonLower,
    chains: Object.keys(s.chains) as Chain[],
    failures: s.failures,
    paidButNotDelivered: s.paidButNotDelivered,
    lastFailure: s.lastFailure,
    tx: s.delivered === 0 ? (s.exampleFailedTx ? { chain: s.exampleFailedTx.chain, tx: s.exampleFailedTx.tx, url: s.exampleFailedTx.url } : null) : s.exampleDeliveredTx,
  }));
  const high = rows
    .filter((r) => r.catalogPos <= cutoff && r.delivered === 0)
    .sort((a, b) => b.paidButNotDelivered - a.paidButNotDelivered || a.catalogPos - b.catalogPos);
  const low = rows
    .filter((r) => r.catalogPos > cutoff && r.delivered === r.tried)
    .sort((a, b) => b.tried - a.tried || b.catalogPos - a.catalogPos);
  const sign = direction === "desc" ? 1 : -1;
  return {
    catalog,
    metric,
    direction,
    overlap: rows.length,
    highCutoffPos: cutoff,
    highButNeverDelivered: high,
    highButNeverDeliveredDespitePaidTx: high.filter((r) => r.paidButNotDelivered > 0).length,
    lowButAlwaysDelivered: low,
    misaligned: high.length + low.length,
    spearman: spearman(
      listed.map((x) => sign * x.v),
      listed.map((x) => x.s.wilsonLower),
    ),
    rule:
      `Among ranked sellers the catalog lists (${rows.length}), "high" = top ${cutoff} by ${metric}. ` +
      `"High but never delivered" = high and 0 delivered out of every counted vet402 purchase. ` +
      `"Low but always delivered" = not high and every counted vet402 purchase delivered. ` +
      `Counted = delivered or failed on the seller's side.`,
  };
}
