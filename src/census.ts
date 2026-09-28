/**
 * The Solana x402 census: the union of PayAI discovery, the CDP Bazaar's Solana listings and
 * Pay.sh's x402 endpoints, deduplicated by URL and by host, one cheapest GET listing per host.
 * Pure: nothing here fetches, signs or pays.
 */
import { MAX_PER_PURCHASE_ATOMIC, OWN_HOSTS, SOLANA_MAINNET, USDC_MINT, atomicToUsdc } from "./constants.js";
import { buildGet, hostOf, normUrl, type Listing } from "./discovery.js";
import { normalizeAccept, type SolAccept } from "./guard.js";
import type { PayshListing } from "./paysh.js";
import type { PlanEntry, PurchaseRecord } from "./pay.js";
import { declarationFromListing, declarationScore, type Declaration } from "./verdict.js";
import type { Classified } from "./classify.js";

export type Source = "payai" | "cdp" | "paysh";
export const SOURCES: readonly Source[] = ["payai", "cdp", "paysh"];

export interface CensusCandidate {
  source: Source;
  /** Every catalog that lists this URL. */
  sources: Source[];
  url: string;
  host: string;
  requestUrl: string;
  exampleScore: 0 | 1 | 2;
  exampleInput: Record<string, string> | null;
  /** Catalog price (atomic USDC). The live 402 decides what is paid. */
  priceAtomic: bigint;
  /** The Solana accept the listing declares (PayAI / CDP); null for Pay.sh. */
  declaredAccept: SolAccept | null;
  declared: Declaration;
  lastUpdated?: string;
}

export interface HostPlan {
  host: string;
  /** Which catalogs list any URL on this host. */
  hostSources: Source[];
  /** Buyable listings, best first (cheapest). Empty when only placeholder listings exist. */
  candidates: CensusCandidate[];
  /** Listings whose declared inputs have no usable example: nothing is sent (placeholder). */
  placeholder: CensusCandidate[];
}

export interface SourceStats {
  items: number;
  /** PayAI/CDP: listings with a Solana accept. Pay.sh: x402 endpoints. */
  solana: number;
  solanaHosts: number;
  eligible: number;
  eligibleHosts: number;
  dropped: Record<string, number>;
}

export interface CensusSelection {
  hosts: HostPlan[];
  stats: {
    bySource: Record<Source, SourceStats>;
    unionUrls: number;
    unionHosts: number;
    /** URLs listed by more than one catalog. */
    sharedUrls: number;
    hostsWithBuyable: number;
    hostsPlaceholderOnly: number;
    hostsAlreadyBought: string[];
    hostsOwn: number;
  };
}

interface Entry {
  source: Source;
  url: string;
  norm: string;
  host: string;
  requestUrl: string | null;
  exampleScore: 0 | 1 | 2;
  exampleInput: Record<string, string> | null;
  priceAtomic: bigint | null;
  declaredAccept: SolAccept | null;
  declared: Declaration;
  lastUpdated?: string;
  drop?: string;
}

const SOURCE_RANK: Record<Source, number> = { payai: 0, cdp: 1, paysh: 2 };

function isOwnHost(h: string): boolean {
  return OWN_HOSTS.some((o) => h === o || h.endsWith(`.${o}`));
}

/** The Solana USDC `exact` accept a PayAI/CDP listing declares (cheapest), or why there is none. */
export function declaredSolanaAccept(l: Listing, maxPer: bigint = MAX_PER_PURCHASE_ATOMIC): { accept: SolAccept } | { drop: string } {
  const sol = (l.accepts ?? []).map((a) => normalizeAccept(a)).filter((a) => a.network === SOLANA_MAINNET);
  if (sol.length === 0) return { drop: "no_solana_accept" };
  const usdc = sol.filter((a) => a.asset === USDC_MINT && a.scheme === "exact" && /^\d{1,18}$/.test(a.amount) && BigInt(a.amount) > 0n);
  if (usdc.length === 0) return { drop: "no_usdc_exact_accept" };
  usdc.sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : BigInt(a.amount) > BigInt(b.amount) ? 1 : 0));
  const a = usdc[0]!;
  if (BigInt(a.amount) > maxPer) return { drop: "price_over_0.10" };
  return { accept: a };
}

function fromCatalog(source: "payai" | "cdp", l: Listing, maxPer: bigint): Entry | null {
  const url = String(l.resource ?? "");
  const sol = (l.accepts ?? []).some((a) => normalizeAccept(a).network === SOLANA_MAINNET);
  if (!sol) return null; // not part of the Solana market
  const e: Entry = {
    source,
    url,
    norm: normUrl(url),
    host: hostOf(url),
    requestUrl: null,
    exampleScore: 0,
    exampleInput: null,
    priceAtomic: null,
    declaredAccept: null,
    declared: declarationFromListing(l),
    ...(l.lastUpdated ? { lastUpdated: l.lastUpdated } : {}),
  };
  const acc = declaredSolanaAccept(l, maxPer);
  if ("drop" in acc) return { ...e, drop: acc.drop };
  e.declaredAccept = acc.accept;
  e.priceAtomic = BigInt(acc.accept.amount);
  const b = buildGet(l);
  if (!b.ok) return { ...e, drop: b.reason };
  return { ...e, requestUrl: b.url, exampleScore: b.exampleScore, exampleInput: b.exampleInput };
}

function fromPaysh(p: PayshListing, maxPer: bigint): Entry | null {
  if (!p.protocol.includes("x402")) return null; // MPP-only or unlabelled: not x402
  const e: Entry = {
    source: "paysh",
    url: p.resource,
    norm: normUrl(p.resource),
    host: hostOf(p.resource),
    requestUrl: null,
    exampleScore: 0,
    exampleInput: null,
    priceAtomic: p.priceAtomic,
    declaredAccept: null,
    declared: p.description ? { description: p.description } : {},
  };
  if (p.priceAtomic === null) return { ...e, drop: "price_unknown" };
  if (p.priceAtomic <= 0n) return { ...e, drop: "price_zero" };
  if (p.priceAtomic > maxPer) return { ...e, drop: "price_over_0.10" };
  const b = buildGet({ resource: p.resource, method: p.method } as Listing);
  if (!b.ok) return { ...e, drop: b.reason };
  return { ...e, requestUrl: b.url, exampleScore: b.exampleScore, exampleInput: b.exampleInput };
}

/** Which of several listings of one URL speaks for it: buyable first, richer declaration, then PayAI > CDP > Pay.sh. */
function betterEntry(a: Entry, b: Entry): Entry {
  const buy = (e: Entry) => (e.drop ? 0 : e.exampleScore > 0 ? 2 : 1);
  return (
    buy(b) - buy(a) ||
    declarationScore(b.declared) - declarationScore(a.declared) ||
    SOURCE_RANK[a.source] - SOURCE_RANK[b.source]
  ) > 0
    ? b
    : a;
}

/** Cheapest first, then a usable example, then the richer declaration, then fresher, then URL. */
export function rankCandidates(a: CensusCandidate, b: CensusCandidate): number {
  return (
    (a.priceAtomic < b.priceAtomic ? -1 : a.priceAtomic > b.priceAtomic ? 1 : 0) ||
    b.exampleScore - a.exampleScore ||
    declarationScore(b.declared) - declarationScore(a.declared) ||
    String(b.lastUpdated ?? "").localeCompare(String(a.lastUpdated ?? "")) ||
    a.requestUrl.localeCompare(b.requestUrl)
  );
}

export function selectCensus(
  input: { payai: Listing[]; cdp: Listing[]; paysh: PayshListing[] },
  opts: { alreadyBoughtHosts?: Iterable<string>; maxPer?: bigint } = {},
): CensusSelection {
  const maxPer = opts.maxPer ?? MAX_PER_PURCHASE_ATOMIC;
  const bought = new Set([...(opts.alreadyBoughtHosts ?? [])].map((h) => h.toLowerCase()));
  const bySource = {} as Record<Source, SourceStats>;
  for (const s of SOURCES) bySource[s] = { items: 0, solana: 0, solanaHosts: 0, eligible: 0, eligibleHosts: 0, dropped: {} };
  bySource.payai.items = input.payai.length;
  bySource.cdp.items = input.cdp.length;
  bySource.paysh.items = input.paysh.length;

  const entries: Entry[] = [];
  const solHosts: Record<Source, Set<string>> = { payai: new Set(), cdp: new Set(), paysh: new Set() };
  const eligHosts: Record<Source, Set<string>> = { payai: new Set(), cdp: new Set(), paysh: new Set() };
  const add = (e: Entry | null) => {
    if (!e) return;
    const st = bySource[e.source];
    st.solana++;
    solHosts[e.source].add(e.host);
    if (e.drop) st.dropped[e.drop] = (st.dropped[e.drop] ?? 0) + 1;
    else {
      st.eligible++;
      eligHosts[e.source].add(e.host);
    }
    entries.push(e);
  };
  for (const l of input.payai) add(fromCatalog("payai", l, maxPer));
  for (const l of input.cdp) add(fromCatalog("cdp", l, maxPer));
  for (const p of input.paysh) {
    const e = fromPaysh(p, maxPer);
    if (e) add(e);
    else bySource.paysh.dropped["not_x402_protocol"] = (bySource.paysh.dropped["not_x402_protocol"] ?? 0) + 1;
  }
  for (const s of SOURCES) {
    bySource[s].solanaHosts = solHosts[s].size;
    bySource[s].eligibleHosts = eligHosts[s].size;
  }

  // Deduplicate by URL.
  const byUrl = new Map<string, { best: Entry; sources: Set<Source> }>();
  for (const e of entries) {
    if (!e.host) continue;
    const cur = byUrl.get(e.norm);
    if (!cur) byUrl.set(e.norm, { best: e, sources: new Set([e.source]) });
    else {
      cur.sources.add(e.source);
      cur.best = betterEntry(cur.best, e);
    }
  }
  const sortSources = (s: Iterable<Source>) => [...s].sort((a, b) => SOURCE_RANK[a] - SOURCE_RANK[b]);

  // Group by host.
  const hosts = new Map<string, HostPlan>();
  const hostSources = new Map<string, Set<Source>>();
  let own = 0;
  const alreadyBought = new Set<string>();
  for (const { best, sources } of byUrl.values()) {
    const h = best.host;
    const hs = hostSources.get(h) ?? new Set<Source>();
    for (const s of sources) hs.add(s);
    hostSources.set(h, hs);
    if (isOwnHost(h)) continue;
    if (bought.has(h)) {
      alreadyBought.add(h);
      continue;
    }
    if (best.drop || best.requestUrl === null || best.priceAtomic === null) continue;
    const c: CensusCandidate = {
      source: best.source,
      sources: sortSources(sources),
      url: best.url,
      host: h,
      requestUrl: best.requestUrl,
      exampleScore: best.exampleScore,
      exampleInput: best.exampleInput,
      priceAtomic: best.priceAtomic,
      declaredAccept: best.declaredAccept,
      declared: best.declared,
      ...(best.lastUpdated ? { lastUpdated: best.lastUpdated } : {}),
    };
    const hp = hosts.get(h) ?? { host: h, hostSources: [], candidates: [], placeholder: [] };
    (c.exampleScore > 0 ? hp.candidates : hp.placeholder).push(c);
    hosts.set(h, hp);
  }
  for (const h of hostSources.keys()) if (isOwnHost(h)) own++;
  for (const hp of hosts.values()) {
    hp.hostSources = sortSources(hostSources.get(hp.host) ?? []);
    hp.candidates.sort(rankCandidates);
    hp.placeholder.sort(rankCandidates);
  }
  const first = (hp: HostPlan) => hp.candidates[0] ?? hp.placeholder[0]!;
  const ordered = [...hosts.values()].sort(
    (a, b) => (a.candidates.length ? 0 : 1) - (b.candidates.length ? 0 : 1) || rankCandidates(first(a), first(b)) || a.host.localeCompare(b.host),
  );
  return {
    hosts: ordered,
    stats: {
      bySource,
      unionUrls: byUrl.size,
      unionHosts: hostSources.size,
      sharedUrls: [...byUrl.values()].filter((v) => v.sources.size > 1).length,
      hostsWithBuyable: ordered.filter((h) => h.candidates.length > 0).length,
      hostsPlaceholderOnly: ordered.filter((h) => h.candidates.length === 0).length,
      hostsAlreadyBought: [...alreadyBought].sort(),
      hostsOwn: own,
    },
  };
}

// ---------------- plan and rows ----------------

export interface CensusTarget extends PlanEntry {
  url: string;
  source: Source;
  sources: Source[];
  hostSources: Source[];
  declared: Declaration;
  priceAtomic: string;
}

/** One purchase per payTo: two hosts that pay into the same wallet are one seller (first, i.e. cheapest, wins). */
export function onePerPayTo<T extends { lock: { payTo: string } }>(targets: T[]): { kept: T[]; dropped: T[] } {
  const seen = new Set<string>();
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const t of targets) {
    if (seen.has(t.lock.payTo)) dropped.push(t);
    else {
      seen.add(t.lock.payTo);
      kept.push(t);
    }
  }
  return { kept, dropped };
}

export interface CensusRow {
  url: string;
  requestUrl: string;
  host: string;
  source: Source;
  sources: Source[];
  declared: { description: string | null; mimeType: string | null; outputSchema: Record<string, unknown> | null; outputExample: unknown };
  status: Classified["status"];
  settled: boolean;
  delivered: boolean;
  signature: string | null;
  first300: string | null;
  reason: string;
  category: Classified["category"];
  displayClass: Classified["displayClass"];
  detail: string;
  priceUsdc: string | null;
  payTo: string | null;
  feePayer: string | null;
  httpStatus: number | null;
  at: string;
}

export function declaredOut(d: Declaration): CensusRow["declared"] {
  return {
    description: d.description ?? null,
    mimeType: d.mimeType ?? null,
    outputSchema: d.outputSchema ?? null,
    outputExample: d.outputExample ?? null,
  };
}

export function censusRow(
  t: { url: string; requestUrl: string; host: string; source: Source; sources: Source[]; declared: Declaration },
  c: Classified,
  rec?: PurchaseRecord,
  at: string = new Date().toISOString(),
): CensusRow {
  const amount = rec?.probe.amount ?? null;
  return {
    url: t.url,
    requestUrl: t.requestUrl,
    host: t.host,
    source: t.source,
    sources: t.sources,
    declared: declaredOut(t.declared),
    status: c.status,
    settled: c.settled,
    delivered: c.delivered,
    signature: rec?.signature ?? null,
    first300: rec?.response?.first300 ?? null,
    reason: c.reason,
    category: c.category,
    displayClass: c.displayClass,
    detail: c.detail,
    priceUsdc: amount && /^\d+$/.test(amount) ? atomicToUsdc(amount) : null,
    payTo: rec?.probe.payTo ?? null,
    feePayer: rec?.probe.feePayer ?? null,
    httpStatus: rec?.response?.status ?? rec?.probe.status ?? null,
    at,
  };
}
