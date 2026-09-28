/**
 * Dry run: enumerate Mercator, pick one Tempo endpoint per service, read its unpaid 402,
 * and price the whole census. Nothing is signed.
 */
import { FEE_RESERVE_ATOMIC, PAYER_ADDRESS, USDC_E, atomicToUnits, tokenSymbol } from "./constants.js";
import { tempoChargeRequest } from "./challenge.js";
import { checkCharge, pickTempoCharge } from "./guard.js";
import {
  SWEEP_QUERIES,
  chooseEndpoint,
  describe,
  mapLimit,
  mergeRank,
  mppDirectoryIds,
  orthogonalIds,
  railOf,
  searchDiagnostic,
  tempoChargeOffer,
  type CatalogStats,
  type FetchLike,
  type MercatorService,
  type PaymentRail,
  type PlannedRequest,
  type RankInfo,
} from "./mercator.js";
import { probeUnpaid } from "./probe.js";

export interface LiveCharge {
  amount: string;
  token: string;
  currency: string;
  recipient: string | null;
  chainId: number | null;
  feePayer: boolean;
  realm: string | null;
  challengeId: string | null;
  expires: string | null;
}

export interface CensusRow {
  serviceId: string;
  name: string;
  serviceUrl: string;
  rail: PaymentRail;
  rank: RankInfo | null;
  endpoint: { method: string; path: string; url: string; inputSource: string } | null;
  catalogAmount: string | null;
  probe: { httpStatus: number | null; error: string | null; challenges: number; x402AlsoOffered: boolean } | null;
  live: LiveCharge | null;
  priceDiffersFromCatalog: boolean | null;
  verdict: string;
  detail: string | null;
}

export interface PlanEntry {
  serviceId: string;
  request: PlannedRequest;
  lockedRecipient: string;
  lockedAmount: string;
  sponsored: boolean;
  allowlist: string[];
}

export interface CensusReport {
  generatedAt: string;
  mode: "dry-run";
  payer: string;
  sources: Record<string, string>;
  mercatorCatalog: CatalogStats;
  counts: Record<string, number>;
  estimate: Record<string, string | number>;
  tokensSeen: Record<string, number>;
  rows: CensusRow[];
  plan: PlanEntry[];
}

export interface CensusOptions {
  fetchImpl: FetchLike;
  queries?: readonly string[];
  concurrency?: number;
  /** probe at most this many Tempo services (for quick runs) */
  limit?: number;
  now?: () => Date;
  log?: (s: string) => void;
}

export async function runCensus(opts: CensusOptions): Promise<CensusReport> {
  const f = opts.fetchImpl;
  const log = opts.log ?? (() => undefined);
  const conc = opts.concurrency ?? 6;
  const queries = opts.queries ?? SWEEP_QUERIES;

  const [mppIds, orthIds] = await Promise.all([mppDirectoryIds(f).catch(() => []), orthogonalIds(f).catch(() => [])]);
  log(`seeds: mpp.dev ${mppIds.length}, orthogonal ${orthIds.length}`);

  const ranks = new Map<string, RankInfo>();
  let stats: CatalogStats = { serviceCount: null, endpointCount: null, generatedAt: null, sourceVersion: null, rankingStrategy: null };
  let searchErrors = 0;
  await mapLimit(queries, Math.min(conc, 4), async (q) => {
    try {
      const r = await searchDiagnostic(f, q);
      mergeRank(ranks, q, r.candidates);
      if (r.stats.serviceCount !== null) stats = r.stats;
    } catch {
      searchErrors++;
    }
  });
  log(`sweep: ${queries.length} queries, ${ranks.size} services ranked, ${searchErrors} errors`);

  const ids = [...new Set([...mppIds, ...orthIds, ...ranks.keys()])].sort();
  let notInMercator = 0;
  let describeErrors = 0;
  const described = (
    await mapLimit(ids, conc, async (id) => {
      try {
        const s = await describe(f, id);
        if (!s) notInMercator++;
        return s;
      } catch {
        describeErrors++;
        return null;
      }
    })
  ).filter((s): s is MercatorService => s !== null);
  log(`described ${described.length} (not in Mercator ${notInMercator}, errors ${describeErrors})`);

  const railCount: Record<string, number> = {};
  for (const s of described) railCount[railOf(s)] = (railCount[railOf(s)] ?? 0) + 1;

  const rows: CensusRow[] = [];
  const plan: PlanEntry[] = [];
  const tempoServices = described.filter((s) => railOf(s) === "tempo");
  const toProbe = opts.limit !== undefined ? tempoServices.slice(0, opts.limit) : tempoServices;

  for (const s of described) {
    const rail = railOf(s);
    if (rail === "tempo") continue;
    rows.push({
      serviceId: s.id,
      name: s.name,
      serviceUrl: s.serviceUrl,
      rail,
      rank: ranks.get(s.id) ?? null,
      endpoint: null,
      catalogAmount: cheapestCatalogAmount(s),
      probe: null,
      live: null,
      priceDiffersFromCatalog: null,
      verdict: rail === "tempo-session-only" ? "session_only" : `not_tempo_${rail}`,
      detail: null,
    });
  }

  const now = opts.now ?? (() => new Date());
  const probed = await mapLimit(toProbe, conc, async (s): Promise<{ row: CensusRow; plan: PlanEntry | null }> => {
    const base: CensusRow = {
      serviceId: s.id,
      name: s.name,
      serviceUrl: s.serviceUrl,
      rail: "tempo",
      rank: ranks.get(s.id) ?? null,
      endpoint: null,
      catalogAmount: null,
      probe: null,
      live: null,
      priceDiffersFromCatalog: null,
      verdict: "no_fillable_endpoint",
      detail: null,
    };
    const pick = chooseEndpoint(s);
    if (!pick) return { row: base, plan: null };
    base.endpoint = { method: pick.ep.method, path: pick.ep.path, url: pick.req.url, inputSource: pick.req.inputSource };
    base.catalogAmount = pick.offer.amount !== undefined && pick.offer.amount !== null ? String(pick.offer.amount) : null;
    const p = await probeUnpaid(f, pick.req);
    base.probe = { httpStatus: p.httpStatus, error: p.error, challenges: p.challenges.length, x402AlsoOffered: p.x402AlsoOffered };
    if (p.httpStatus === null) return { row: { ...base, verdict: "probe_error", detail: p.error }, plan: null };
    if (p.httpStatus !== 402) return { row: { ...base, verdict: `unpaid_${p.httpStatus}` }, plan: null };
    const allow = s.recipientPolicy?.mode === "allowlist" ? (s.recipientPolicy.recipients ?? []) : [];
    const ch = pickTempoCharge(p.challenges, allow[0]);
    const req = ch ? tempoChargeRequest(ch) : null;
    if (ch && req) {
      base.live = {
        amount: req.amount,
        token: tokenSymbol(req.currency),
        currency: req.currency,
        recipient: req.recipient,
        chainId: req.chainId,
        feePayer: req.feePayer,
        realm: ch.realm,
        challengeId: ch.id,
        expires: ch.expires,
      };
      base.priceDiffersFromCatalog = base.catalogAmount === null ? null : req.amount !== base.catalogAmount;
    }
    const refusal = checkCharge(ch, { payer: PAYER_ADDRESS, allowlist: allow, now: now() });
    if (refusal) return { row: { ...base, verdict: refusal.refused, detail: refusal.detail }, plan: null };
    if (!pick.usableInput)
      return { row: { ...base, verdict: "no_input_example", detail: "payable, but no cataloged input: a paid call would likely 4xx" }, plan: null };
    return {
      row: { ...base, verdict: "payable" },
      plan: {
        serviceId: s.id,
        request: pick.req,
        lockedRecipient: req!.recipient!,
        lockedAmount: req!.amount,
        sponsored: req!.feePayer,
        allowlist: allow,
      },
    };
  });
  for (const r of probed) {
    rows.push(r.row);
    if (r.plan) plan.push(r.plan);
  }

  const tempoRows = rows.filter((r) => r.rail === "tempo");
  const verdicts: Record<string, number> = {};
  for (const r of tempoRows) verdicts[r.verdict] = (verdicts[r.verdict] ?? 0) + 1;
  const tokensSeen: Record<string, number> = {};
  for (const r of tempoRows) if (r.live) tokensSeen[r.live.token] = (tokensSeen[r.live.token] ?? 0) + 1;

  const payableSum = plan.reduce((a, p) => a + BigInt(p.lockedAmount), 0n);
  const selfPaid = plan.filter((p) => !p.sponsored).length;
  const feeReserve = BigInt(selfPaid) * FEE_RESERVE_ATOMIC;
  const liveAll = tempoRows.filter((r) => r.live && /^\d+$/.test(r.live.amount) && r.live.currency === USDC_E);
  const liveAllSum = liveAll.reduce((a, r) => a + BigInt(r.live!.amount), 0n);
  const catalogTempoSum = tempoServices.reduce((a, s) => a + BigInt(cheapestTempoCatalogAmount(s) ?? "0"), 0n);
  const x402Rows = rows.filter((r) => r.rail === "x402" && r.catalogAmount && /^\d+$/.test(r.catalogAmount));
  const x402Sum = x402Rows.reduce((a, r) => a + BigInt(r.catalogAmount!), 0n);

  return {
    generatedAt: now().toISOString(),
    mode: "dry-run",
    payer: PAYER_ADDRESS,
    sources: {
      mercator: "https://mercator.sh/v1/services/search (evidence=pre-confidence) + /v1/services/{id}",
      mppDirectory: "https://mpp.dev/api/services",
      orthogonal: "https://mpp.orthogonal.com",
    },
    mercatorCatalog: stats,
    counts: {
      seedsMppDirectory: mppIds.length,
      seedsOrthogonal: orthIds.length,
      sweepQueries: queries.length,
      rankedBySweep: ranks.size,
      idsTried: ids.length,
      notInMercator,
      described: described.length,
      ...Object.fromEntries(Object.entries(railCount).map(([k, v]) => [`rail_${k}`, v])),
      tempoProbed: toProbe.length,
      ...Object.fromEntries(Object.entries(verdicts).map(([k, v]) => [`verdict_${k}`, v])),
      payable: plan.length,
      payableSelfPaidFee: selfPaid,
      payableFeeSponsored: plan.length - selfPaid,
    },
    estimate: {
      payableTotal: atomicToUnits(payableSum),
      feeReserveForSelfPaid: atomicToUnits(feeReserve),
      payableTotalWithFeeReserve: atomicToUnits(payableSum + feeReserve),
      live402TotalAllTempo: atomicToUnits(liveAllSum),
      catalogCheapestAllTempoServices: atomicToUnits(catalogTempoSum),
      x402ReachedServices: x402Rows.length,
      x402ReachedCheapestTotalBaseUsdc: atomicToUnits(x402Sum),
      currency: "USDC.e (Tempo mainnet, eip155:4217)",
    },
    tokensSeen,
    rows,
    plan,
  };
}

function cheapestTempoCatalogAmount(s: MercatorService): string | null {
  const amts = s.endpoints
    .map((e) => tempoChargeOffer(e)?.amount)
    .filter((a): a is string => typeof a === "string" && /^\d+$/.test(a))
    .map((a) => BigInt(a))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return amts.length ? amts[0]!.toString() : null;
}

function cheapestCatalogAmount(s: MercatorService): string | null {
  const amts = s.endpoints
    .flatMap((e) => e.paymentOffers ?? [])
    .map((o) => String(o.amount ?? ""))
    .filter((a) => /^\d+$/.test(a))
    .map((a) => BigInt(a))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return amts.length ? amts[0]!.toString() : null;
}
