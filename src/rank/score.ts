/**
 * Per-seller figures, grades and the ranking (method v2).
 *
 * Method (also in src/rank/README.md and on the method page):
 *   counted  = delivered + failures attributed to the seller (./classify.ts). vet402/facilitator-side and
 *              can't-tell failures are shown as counts and never enter the grade.
 *   interval = Wilson score interval (95%, z = 1.96) of delivered / counted
 *   grade    = A/B/C when the LOWER bound clears 0.90/0.75/0.50; D only when the UPPER bound is below 0.50;
 *              otherwise "undecided". "measuring" (no grade, no rank number) below MIN_COUNTED counted
 *              purchases or on fewer than MIN_DAYS different UTC days.
 * Only vet402's own purchases count. Sellers cannot add rows, so call volume, payer counts and
 * self-purchases (wash trading) do not move anything.
 */
import { classifyFailure } from "./classify.js";
import type { Attempt, Chain, Fault, ReasonCategory } from "./types.js";

export const WILSON_Z = 1.96;

function checkCounts(k: number, n: number, fn: string): void {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) {
    throw new Error(`${fn}: bad counts k=${k} n=${n}`);
  }
}

function wilsonParts(k: number, n: number, z: number): { centre: number; margin: number; denom: number } {
  const p = k / n;
  const z2 = z * z;
  return {
    centre: p + z2 / (2 * n),
    margin: z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n)),
    denom: 1 + z2 / n,
  };
}

/** Wilson score interval lower bound for k successes out of n. n = 0 gives 0. */
export function wilsonLower(k: number, n: number, z: number = WILSON_Z): number {
  checkCounts(k, n, "wilsonLower");
  if (n === 0) return 0;
  const w = wilsonParts(k, n, z);
  return Math.max(0, (w.centre - w.margin) / w.denom);
}

/** Wilson score interval upper bound for k successes out of n. n = 0 gives 1. */
export function wilsonUpper(k: number, n: number, z: number = WILSON_Z): number {
  checkCounts(k, n, "wilsonUpper");
  if (n === 0) return 1;
  const w = wilsonParts(k, n, z);
  return Math.min(1, (w.centre + w.margin) / w.denom);
}

/** Rank numbers only with enough evidence: this many counted purchases … */
export const MIN_COUNTED = 10;
/** … spread over at least this many different UTC days. */
export const MIN_DAYS = 2;
/** Good marks need the interval's lower bound at or above these. */
export const GRADE_LOWER = { A: 0.9, B: 0.75, C: 0.5 } as const;
/** The bad mark needs the interval's upper bound below this. */
export const D_UPPER = 0.5;

export type Grade = "A" | "B" | "C" | "D" | "undecided" | "measuring";
export const GRADES: readonly Grade[] = ["A", "B", "C", "D", "undecided", "measuring"];

export function qualifies(counted: number, days: number): boolean {
  return counted >= MIN_COUNTED && days >= MIN_DAYS;
}

export function gradeFor(delivered: number, counted: number, days: number): Grade {
  if (!qualifies(counted, days)) return "measuring";
  const lo = wilsonLower(delivered, counted);
  if (lo >= GRADE_LOWER.A) return "A";
  if (lo >= GRADE_LOWER.B) return "B";
  if (lo >= GRADE_LOWER.C) return "C";
  if (wilsonUpper(delivered, counted) < D_UPPER) return "D";
  return "undecided";
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
  fault: Fault;
  rule: string;
  httpStatus: number | null;
  rawReason: string;
  detail: string | null;
  tx: string | null;
}

export interface RecentAttempt {
  at: string;
  chain: Chain;
  url: string;
  delivered: boolean;
  /** null when delivered. */
  fault: Fault | null;
  rule: string | null;
  httpStatus: number | null;
  declaredMatch: boolean | null;
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
  chains: Partial<Record<Chain, { tried: number; counted: number; delivered: number }>>;
  /** Every purchase vet402 committed to pay, whoever was at fault. */
  tried: number;
  /** delivered + seller-side failures: the grade's denominator. */
  counted: number;
  settled: number;
  delivered: number;
  settledRate: number;
  /** delivered / counted */
  deliveredRate: number;
  wilsonLower: number;
  wilsonUpper: number;
  /** Different UTC days with a counted purchase. */
  days: string[];
  grade: Grade;
  /** Enough evidence for a rank number (MIN_COUNTED on MIN_DAYS). */
  qualified: boolean;
  /** Tried failures not held against the seller, by fault. */
  excluded: { vet402_or_facilitator: number; unknown: number };
  /** Every tried failure by classification rule id (./classify.ts). */
  failuresByRule: Record<string, number>;
  /** Separate column: answers checked against what the seller declared, and how many matched. */
  declared: { checked: number; matched: number };
  /** Rows that did not count (not payable, vet402 policy, payTo refusals), by category. */
  notTried: Partial<Record<ReasonCategory, number>>;
  /** Every tried failure by category, whoever was at fault. */
  failures: Partial<Record<ReasonCategory, number>>;
  last: LastResult | null;
  lastMeasuredAt: string | null;
  /** Most recent delivered tx and most recent paid-but-failed tx, as evidence. */
  exampleDeliveredTx: { chain: Chain; tx: string; url: string } | null;
  exampleFailedTx: { chain: Chain; tx: string; url: string; category: ReasonCategory } | null;
  /** Most recent seller-side failure, with the runner's reason and detail. */
  lastFailure: FailureEvidence | null;
  /** Seller-side failures, newest first (at most 10). */
  sellerFailures: FailureEvidence[];
  /** Tried purchases, newest first (at most 10). */
  recent: RecentAttempt[];
  /** Tried rows that settled on-chain (tx) and still did not deliver. */
  paidButNotDelivered: number;
  payTos: string[];
  payToChanged: boolean;
  payToChanges: PayToChange[];
  firstAt: string;
  lastAt: string;
}

export interface RankedSeller extends SellerStats {
  /** null = not enough evidence yet ("measuring"). */
  rank: number | null;
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
    const fault = new Map<Attempt, { fault: Fault; rule: string }>();
    for (const r of tried) if (!r.delivered) fault.set(r, classifyFailure(r));
    const isCounted = (r: Attempt) => r.delivered || fault.get(r)?.fault === "seller";
    const counted = tried.filter(isCounted);
    const delivered = counted.filter((r) => r.delivered).length;
    const settled = tried.filter((r) => r.settled === true).length;
    const days = [...new Set(counted.map((r) => r.at.slice(0, 10)))].sort();
    const chains: SellerStats["chains"] = {};
    const notTried: SellerStats["notTried"] = {};
    const failures: SellerStats["failures"] = {};
    const failuresByRule: Record<string, number> = {};
    const excluded = { vet402_or_facilitator: 0, unknown: 0 };
    const declared = { checked: 0, matched: 0 };
    for (const r of rows) {
      if (r.tried) {
        const c = (chains[r.chain] ??= { tried: 0, counted: 0, delivered: 0 });
        c.tried++;
        if (isCounted(r)) c.counted++;
        if (r.delivered) c.delivered++;
        if (r.declaredMatch !== null) {
          declared.checked++;
          if (r.declaredMatch) declared.matched++;
        }
        const f = fault.get(r);
        if (f) {
          failures[r.category] = (failures[r.category] ?? 0) + 1;
          failuresByRule[f.rule] = (failuresByRule[f.rule] ?? 0) + 1;
          if (f.fault !== "seller") excluded[f.fault]++;
        }
      } else {
        notTried[r.category] = (notTried[r.category] ?? 0) + 1;
      }
    }
    const evidence = (r: Attempt): FailureEvidence => {
      const f = fault.get(r)!;
      return { at: r.at, chain: r.chain, url: r.url, category: r.category, fault: f.fault, rule: f.rule, httpStatus: r.httpStatus, rawReason: r.rawReason, detail: r.detail, tx: r.tx };
    };
    const newestFirst = [...tried].reverse();
    const sellerFails = newestFirst.filter((r) => fault.get(r)?.fault === "seller");
    const lastTried = tried.at(-1);
    const lastDel = newestFirst.find((r) => r.delivered && r.tx);
    const lastFail = sellerFails.find((r) => r.tx);

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
      counted: counted.length,
      settled,
      delivered,
      settledRate: tried.length ? settled / tried.length : 0,
      deliveredRate: counted.length ? delivered / counted.length : 0,
      wilsonLower: wilsonLower(delivered, counted.length),
      wilsonUpper: wilsonUpper(delivered, counted.length),
      days,
      grade: gradeFor(delivered, counted.length, days.length),
      qualified: qualifies(counted.length, days.length),
      excluded,
      failuresByRule,
      declared,
      notTried,
      failures,
      lastMeasuredAt: lastTried?.at ?? null,
      last: lastTried
        ? { at: lastTried.at, chain: lastTried.chain, category: lastTried.category, rawReason: lastTried.rawReason, url: lastTried.url, tx: lastTried.tx }
        : null,
      exampleDeliveredTx: lastDel ? { chain: lastDel.chain, tx: lastDel.tx!, url: lastDel.url } : null,
      exampleFailedTx: lastFail ? { chain: lastFail.chain, tx: lastFail.tx!, url: lastFail.url, category: lastFail.category } : null,
      lastFailure: sellerFails[0] ? evidence(sellerFails[0]) : null,
      sellerFailures: sellerFails.slice(0, 10).map(evidence),
      recent: newestFirst.slice(0, 10).map((r) => {
        const f = fault.get(r) ?? null;
        return { at: r.at, chain: r.chain, url: r.url, delivered: r.delivered, fault: f?.fault ?? null, rule: f?.rule ?? null, httpStatus: r.httpStatus, declaredMatch: r.declaredMatch, tx: r.tx };
      }),
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
 * Every seller with at least one tried purchase. Qualified sellers (MIN_COUNTED on MIN_DAYS) come first
 * with rank numbers: lower bound desc, then delivered rate desc, then counted desc, then key. Equal lower
 * bound, rate and count share a rank (1, 2, 2, 4 …). The rest follow by key with rank null ("measuring").
 */
export function rank(stats: readonly SellerStats[]): RankedSeller[] {
  const byKey = (a: SellerStats, b: SellerStats) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const withTries = stats.filter((s) => s.tried > 0);
  const ranked = withTries
    .filter((s) => s.qualified)
    .sort((a, b) => b.wilsonLower - a.wilsonLower || b.deliveredRate - a.deliveredRate || b.counted - a.counted || byKey(a, b));
  const out: RankedSeller[] = [];
  for (const [i, s] of ranked.entries()) {
    const prev = out[i - 1];
    const tie = prev !== undefined && prev.wilsonLower === s.wilsonLower && prev.deliveredRate === s.deliveredRate && prev.counted === s.counted;
    out.push({ ...s, rank: tie ? prev.rank : i + 1 });
  }
  for (const s of withTries.filter((x) => !x.qualified).sort(byKey)) out.push({ ...s, rank: null });
  return out;
}
