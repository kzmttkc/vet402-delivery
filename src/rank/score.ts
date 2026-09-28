/**
 * Per-seller figures and the ranking.
 *
 * Method (also in src/rank/README.md and on the HTML page):
 *   score = Wilson score lower bound (95%, z = 1.96) of delivered / tried
 * Only vet402's own tried purchases count. Sellers cannot add rows, so call volume, payer counts
 * and self-purchases (wash trading) do not move the score.
 */
import type { Attempt, Chain, ReasonCategory } from "./types.js";

export const WILSON_Z = 1.96;

/** Wilson score interval lower bound for k successes out of n. n = 0 gives 0. */
export function wilsonLower(k: number, n: number, z: number = WILSON_Z): number {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) {
    throw new Error(`wilsonLower: bad counts k=${k} n=${n}`);
  }
  if (n === 0) return 0;
  const p = k / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

export interface LastResult {
  at: string;
  chain: Chain;
  category: ReasonCategory;
  rawReason: string;
  url: string;
  tx: string | null;
}

export interface FailureEvidence {
  at: string;
  chain: Chain;
  url: string;
  category: ReasonCategory;
  rawReason: string;
  detail: string | null;
  tx: string | null;
}

export interface PayToChange {
  chain: Chain;
  url: string;
  from: string;
  to: string;
  seenAt: string;
  how: "refused_at_payment" | "differs_between_runs";
}

export interface SellerStats {
  key: string;
  host: string;
  service: string | null;
  /** Every catalog service id seen for this seller (Tempo / Mercator ids). */
  services: string[];
  chains: Partial<Record<Chain, { tried: number; delivered: number }>>;
  tried: number;
  settled: number;
  delivered: number;
  settledRate: number;
  deliveredRate: number;
  wilsonLower: number;
  /** Rows that did not count (not payable, vet402 policy, payTo refusals), by category. */
  notTried: Partial<Record<ReasonCategory, number>>;
  failures: Partial<Record<ReasonCategory, number>>;
  last: LastResult | null;
  /** Most recent delivered tx and most recent paid-but-failed tx, as evidence. */
  exampleDeliveredTx: { chain: Chain; tx: string; url: string } | null;
  exampleFailedTx: { chain: Chain; tx: string; url: string; category: ReasonCategory } | null;
  /** Most recent tried-but-not-delivered row, with the runner's reason and detail. */
  lastFailure: FailureEvidence | null;
  /** Tried rows that settled on-chain (tx) and still did not deliver. */
  paidButNotDelivered: number;
  payTos: string[];
  payToChanged: boolean;
  payToChanges: PayToChange[];
  firstAt: string;
  lastAt: string;
}

export interface RankedSeller extends SellerStats {
  rank: number;
}

/**
 * Seller identity. Normally the host. When one host fronts several catalog services
 * (e.g. a proxy whose services each pay a different recipient), each service is its own seller.
 */
export function sellerKeys(attempts: readonly Attempt[]): Map<Attempt, string> {
  const servicesByHost = new Map<string, Set<string>>();
  for (const a of attempts) {
    if (a.service === null) continue;
    const s = servicesByHost.get(a.host) ?? new Set<string>();
    s.add(a.service);
    servicesByHost.set(a.host, s);
  }
  const out = new Map<Attempt, string>();
  for (const a of attempts) {
    const multi = (servicesByHost.get(a.host)?.size ?? 0) > 1;
    out.set(a, multi && a.service !== null ? `${a.host}#${a.service}` : a.host);
  }
  return out;
}

function normAddr(a: string): string {
  return a.startsWith("0x") ? a.toLowerCase() : a;
}

function byAt(a: Attempt, b: Attempt): number {
  return a.at < b.at ? -1 : a.at > b.at ? 1 : 0;
}

export function aggregate(attempts: readonly Attempt[], excludeHosts: readonly string[] = []): SellerStats[] {
  const excluded = new Set(excludeHosts.map((h) => h.toLowerCase()));
  const keep = attempts.filter((a) => !excluded.has(a.host));
  const keys = sellerKeys(keep);
  const groups = new Map<string, Attempt[]>();
  for (const a of keep) {
    const k = keys.get(a)!;
    const g = groups.get(k) ?? [];
    g.push(a);
    groups.set(k, g);
  }
  const out: SellerStats[] = [];
  for (const [key, rows] of groups) {
    rows.sort(byAt);
    const tried = rows.filter((r) => r.tried);
    const delivered = tried.filter((r) => r.delivered).length;
    const settled = tried.filter((r) => r.settled === true).length;
    const chains: SellerStats["chains"] = {};
    const notTried: SellerStats["notTried"] = {};
    const failures: SellerStats["failures"] = {};
    for (const r of rows) {
      if (r.tried) {
        const c = (chains[r.chain] ??= { tried: 0, delivered: 0 });
        c.tried++;
        if (r.delivered) c.delivered++;
        if (!r.delivered) failures[r.category] = (failures[r.category] ?? 0) + 1;
      } else {
        notTried[r.category] = (notTried[r.category] ?? 0) + 1;
      }
    }
    const lastTried = tried.at(-1);
    const lastDel = [...tried].reverse().find((r) => r.delivered && r.tx);
    const lastFail = [...tried].reverse().find((r) => !r.delivered && r.tx);
    const lastFailAny = [...tried].reverse().find((r) => !r.delivered);

    // payTo: explicit refusals, plus the same URL asking for a different recipient later on.
    const changes: PayToChange[] = [];
    for (const r of rows) {
      if (r.category === "payto_changed" && r.payTo && r.expectedPayTo) {
        changes.push({ chain: r.chain, url: r.url, from: r.expectedPayTo, to: r.payTo, seenAt: r.at, how: "refused_at_payment" });
      }
    }
    // Same chain + same URL only: a seller that accepts several chains has one recipient per chain.
    const lastPayToByUrl = new Map<string, string>();
    for (const r of rows) {
      if (!r.payTo || r.category === "payto_changed") continue;
      const p = normAddr(r.payTo);
      const k = `${r.chain} ${r.url}`;
      const prev = lastPayToByUrl.get(k);
      if (prev !== undefined && prev !== p) {
        changes.push({ chain: r.chain, url: r.url, from: prev, to: p, seenAt: r.at, how: "differs_between_runs" });
      }
      lastPayToByUrl.set(k, p);
    }
    const payTos = [...new Set(rows.filter((r) => r.payTo && r.category !== "payto_changed").map((r) => normAddr(r.payTo!)))].sort();

    const first = rows[0]!;
    out.push({
      key,
      host: first.host,
      service: key.includes("#") ? first.service : null,
      services: [...new Set(rows.map((r) => r.service).filter((x): x is string => x !== null))].sort(),
      chains,
      tried: tried.length,
      settled,
      delivered,
      settledRate: tried.length ? settled / tried.length : 0,
      deliveredRate: tried.length ? delivered / tried.length : 0,
      wilsonLower: wilsonLower(delivered, tried.length),
      notTried,
      failures,
      last: lastTried
        ? { at: lastTried.at, chain: lastTried.chain, category: lastTried.category, rawReason: lastTried.rawReason, url: lastTried.url, tx: lastTried.tx }
        : null,
      exampleDeliveredTx: lastDel ? { chain: lastDel.chain, tx: lastDel.tx!, url: lastDel.url } : null,
      exampleFailedTx: lastFail ? { chain: lastFail.chain, tx: lastFail.tx!, url: lastFail.url, category: lastFail.category } : null,
      lastFailure: lastFailAny
        ? {
            at: lastFailAny.at,
            chain: lastFailAny.chain,
            url: lastFailAny.url,
            category: lastFailAny.category,
            rawReason: lastFailAny.rawReason,
            detail: lastFailAny.detail,
            tx: lastFailAny.tx,
          }
        : null,
      paidButNotDelivered: tried.filter((r) => !r.delivered && r.settled === true && r.tx !== null).length,
      payTos,
      payToChanged: changes.length > 0,
      payToChanges: changes,
      firstAt: first.at,
      lastAt: rows.at(-1)!.at,
    });
  }
  return out;
}

/**
 * Ranked = sellers with at least one tried purchase.
 * Order: Wilson lower bound desc, then delivered rate desc, then tried desc, then key asc.
 * Equal scores share a rank (1, 2, 2, 4 …).
 */
export function rank(stats: readonly SellerStats[]): RankedSeller[] {
  const sorted = stats
    .filter((s) => s.tried > 0)
    .sort(
      (a, b) =>
        b.wilsonLower - a.wilsonLower ||
        b.deliveredRate - a.deliveredRate ||
        b.tried - a.tried ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
  const out: RankedSeller[] = [];
  for (const [i, s] of sorted.entries()) {
    const prev = out[i - 1];
    const tie = prev !== undefined && prev.wilsonLower === s.wilsonLower && prev.deliveredRate === s.deliveredRate && prev.tried === s.tried;
    out.push({ ...s, rank: tie ? prev.rank : i + 1 });
  }
  return out;
}
