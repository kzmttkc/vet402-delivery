/**
 * Reading Mercator's directory (https://mercator.sh/openapi.json).
 *
 * Mercator has no "list all services" endpoint: only search (ranked, <= 25 per query) and
 * describe-by-id. Its catalog is aggregated from nine sources (mpp.dev directory, CDP x402
 * Bazaar, Orthogonal, Locus, …). So the census enumerates from seeds + a query sweep:
 *   seeds  = ids in the mpp.dev directory (Mercator's `mpp-directory` source)
 *          + `orth-<slug>` for every API listed at https://mpp.orthogonal.com
 *   sweep  = search queries; every service returned is added, with the best rank it reached.
 * Then every id is described. The Tempo subset found this way is what the census probes.
 *
 * Rank: Mercator's rank is per query (1 = first). The census keeps each service's best rank
 * across the sweep and the query that produced it. Mercator's public ranking strategy is
 * `relevance-price-v1` (score = relevance and price); it exposes no reliability number. The
 * only quality signal is `quality.tier` (standard / reviewed / tempo-managed), visible in the
 * diagnostic search (`evidence=pre-confidence`), which the sweep uses.
 */
import { MERCATOR_ORIGIN, MPP_DIRECTORY_URL, TEMPO_MAINNET_CAIP2, USER_AGENT, USDC_E, normAddr } from "./constants.js";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface PaymentOffer {
  protocol?: string;
  method?: string;
  intent?: string;
  network?: string;
  currency?: string;
  amount?: string;
  decimals?: number;
  recipient?: string;
  description?: string;
}

export interface MercatorEndpoint {
  method: string;
  path: string;
  description?: string;
  requestFormat?: "json" | "query";
  inputExample?: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  paymentOffers?: PaymentOffer[];
}

export interface MercatorService {
  id: string;
  name: string;
  serviceUrl: string;
  realm?: string;
  status?: string;
  integration?: string;
  categories?: string[];
  recipientPolicy?: { mode?: string; recipients?: string[] };
  sourceRefs?: { sourceId: string; externalId: string }[];
  endpoints: MercatorEndpoint[];
}

export interface RankInfo {
  bestRank: number;
  query: string;
  score: number | null;
  price: number | null;
  relevance: number | null;
  tier: string | null;
  appearances: number;
}

export interface CatalogStats {
  serviceCount: number | null;
  endpointCount: number | null;
  generatedAt: string | null;
  sourceVersion: string | null;
  rankingStrategy: string | null;
}

async function getJson(fetchImpl: FetchLike, url: string): Promise<unknown> {
  const res = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

export async function mppDirectoryIds(fetchImpl: FetchLike): Promise<string[]> {
  const d = (await getJson(fetchImpl, MPP_DIRECTORY_URL)) as { services?: { id?: string }[] };
  return (d.services ?? []).map((s) => String(s.id ?? "")).filter(Boolean);
}

export async function orthogonalIds(fetchImpl: FetchLike): Promise<string[]> {
  const res = await fetchImpl("https://mpp.orthogonal.com", { headers: { "user-agent": USER_AGENT } });
  if (!res.ok) return [];
  const text = await res.text();
  const slugs = new Set<string>();
  for (const m of text.matchAll(/https:\/\/mpp\.orthogonal\.com\/([a-z0-9-]+)\/openapi\.json/g)) slugs.add(m[1]!);
  return [...slugs].map((s) => `orth-${s}`);
}

interface DiagCandidate {
  serviceId: string;
  rank: number;
  score?: number;
  scoreDetails?: { price?: number; relevance?: number };
  quality?: { tier?: string };
}

/** One diagnostic search. Returns candidates and the catalog stats Mercator reports with it. */
export async function searchDiagnostic(
  fetchImpl: FetchLike,
  query: string,
): Promise<{ candidates: DiagCandidate[]; stats: CatalogStats }> {
  const u = `${MERCATOR_ORIGIN}/v1/services/search?${new URLSearchParams({ query, limit: "25", evidence: "pre-confidence" })}`;
  const d = (await getJson(fetchImpl, u)) as {
    endpoints?: DiagCandidate[];
    internal?: {
      catalog?: { serviceCount?: number; endpointCount?: number; generatedAt?: string; sourceVersion?: string };
      retrieval?: { candidates?: DiagCandidate[]; ranking?: { strategy?: string } };
    };
  };
  const cat = d.internal?.catalog;
  const candidates = d.internal?.retrieval?.candidates ?? d.endpoints ?? [];
  return {
    candidates,
    stats: {
      serviceCount: cat?.serviceCount ?? null,
      endpointCount: cat?.endpointCount ?? null,
      generatedAt: cat?.generatedAt ?? null,
      sourceVersion: cat?.sourceVersion ?? null,
      rankingStrategy: d.internal?.retrieval?.ranking?.strategy ?? null,
    },
  };
}

export function mergeRank(ranks: Map<string, RankInfo>, query: string, cands: DiagCandidate[]): void {
  for (const c of cands) {
    if (!c.serviceId || typeof c.rank !== "number") continue;
    const cur = ranks.get(c.serviceId);
    const next: RankInfo = {
      bestRank: c.rank,
      query,
      score: c.score ?? null,
      price: c.scoreDetails?.price ?? null,
      relevance: c.scoreDetails?.relevance ?? null,
      tier: c.quality?.tier ?? null,
      appearances: (cur?.appearances ?? 0) + 1,
    };
    if (!cur || c.rank < cur.bestRank || (c.rank === cur.bestRank && (c.score ?? 0) > (cur.score ?? 0))) ranks.set(c.serviceId, next);
    else cur.appearances += 1;
  }
}

export async function describe(fetchImpl: FetchLike, id: string): Promise<MercatorService | null> {
  const res = await fetchImpl(`${MERCATOR_ORIGIN}/v1/services/${encodeURIComponent(id)}`, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`describe ${id} -> HTTP ${res.status}`);
  const d = (await res.json()) as { service?: MercatorService };
  return d.service ?? null;
}

/** Tempo mainnet charge offer in USDC.e, if the endpoint has one. */
export function tempoChargeOffer(ep: MercatorEndpoint): PaymentOffer | null {
  for (const o of ep.paymentOffers ?? []) {
    if (o.method === "tempo" && o.intent === "charge" && o.network === TEMPO_MAINNET_CAIP2 && normAddr(o.currency) === USDC_E) return o;
  }
  return null;
}

export type PaymentRail = "tempo" | "tempo-session-only" | "x402" | "stripe" | "none";

export function railOf(s: MercatorService): PaymentRail {
  const offers = s.endpoints.flatMap((e) => e.paymentOffers ?? []);
  if (offers.some((o) => o.method === "tempo" && o.intent === "charge" && o.network === TEMPO_MAINNET_CAIP2)) return "tempo";
  if (offers.some((o) => o.method === "tempo")) return "tempo-session-only";
  if (offers.some((o) => o.protocol === "x402")) return "x402";
  if (offers.some((o) => o.method === "stripe")) return "stripe";
  return "none";
}

const PATH_PARAM = /\{([A-Za-z0-9_]+)\}|:([A-Za-z0-9_]+)/g;

/** Fill `{id}` / `:id` from the input example; null when a parameter has no value. */
export function fillPath(path: string, example: Record<string, unknown>): { path: string; used: string[] } | null {
  const used: string[] = [];
  let missing = false;
  const filled = path.replace(PATH_PARAM, (_m, a: string | undefined, b: string | undefined) => {
    const key = (a ?? b)!;
    const v = example[key];
    if (v === undefined || v === null || typeof v === "object") {
      missing = true;
      return "";
    }
    used.push(key);
    return encodeURIComponent(String(v));
  });
  return missing ? null : { path: filled, used };
}

export interface PlannedRequest {
  url: string;
  method: string;
  body: string | null;
  contentType: string | null;
  /** where the request inputs came from */
  inputSource: "mercator_example" | "none";
}

export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return b + p;
}

/** Build the request vet402 would send, from Mercator's cataloged input example. */
export function buildRequest(s: MercatorService, ep: MercatorEndpoint): PlannedRequest | null {
  const example = ep.inputExample ?? {};
  const filled = fillPath(ep.path, example);
  if (!filled) return null;
  const rest = Object.fromEntries(Object.entries(example).filter(([k]) => !filled.used.includes(k)));
  const method = ep.method.toUpperCase();
  const url = new URL(joinUrl(s.serviceUrl, filled.path));
  const asQuery = method === "GET" || method === "DELETE" || ep.requestFormat === "query";
  let body: string | null = null;
  if (asQuery) {
    for (const [k, v] of Object.entries(rest)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
  } else {
    body = JSON.stringify(rest);
  }
  return {
    url: url.toString(),
    method,
    body,
    contentType: body === null ? null : "application/json",
    inputSource: Object.keys(example).length > 0 ? "mercator_example" : "none",
  };
}

/**
 * A request vet402 can form honestly: the seller told us what to send (an input example), or the
 * call needs nothing (a GET with no required arguments). vouch's MPP lane sent `{}` / no query to
 * endpoints that needed input; 31 of its 47 settled-not-delivered rows are that (see docs).
 */
export function hasUsableInput(ep: MercatorEndpoint, req: PlannedRequest): boolean {
  if (req.inputSource === "mercator_example") return true;
  const required = (ep.inputSchema as { required?: unknown } | undefined)?.required;
  const needs = Array.isArray(required) && required.length > 0;
  return req.method === "GET" && !needs;
}

/**
 * The one endpoint per service the census would buy: a Tempo USDC.e charge with a fillable path.
 * Order: usable input first, then fixed catalog price (cheapest) before dynamic price (known only
 * from the live 402), then GET.
 */
export function chooseEndpoint(
  s: MercatorService,
): { ep: MercatorEndpoint; offer: PaymentOffer; req: PlannedRequest; usableInput: boolean } | null {
  const cands: { ep: MercatorEndpoint; offer: PaymentOffer; req: PlannedRequest; amount: bigint | null; usable: boolean }[] = [];
  for (const ep of s.endpoints) {
    const offer = tempoChargeOffer(ep);
    if (!offer) continue;
    const req = buildRequest(s, ep);
    if (!req) continue;
    const fixed = /^\d+$/.test(String(offer.amount ?? ""));
    cands.push({ ep, offer, req, amount: fixed ? BigInt(offer.amount!) : null, usable: hasUsableInput(ep, req) });
  }
  if (cands.length === 0) return null;
  cands.sort((a, b) => {
    if (a.usable !== b.usable) return a.usable ? -1 : 1;
    if ((a.amount === null) !== (b.amount === null)) return a.amount === null ? 1 : -1;
    if (a.amount !== null && b.amount !== null && a.amount !== b.amount) return a.amount < b.amount ? -1 : 1;
    return (a.ep.method === "GET" ? 0 : 1) - (b.ep.method === "GET" ? 0 : 1);
  });
  const c = cands[0]!;
  return { ep: c.ep, offer: c.offer, req: c.req, usableInput: c.usable };
}

/** Query sweep used for rank. Broad capability words; Mercator ranks within each. */
export const SWEEP_QUERIES = [
  "weather forecast", "web search", "news search", "scrape a web page", "extract data from a website", "crawl a site map",
  "company enrichment", "people search", "email finder", "email verification", "phone lookup", "contact enrichment",
  "job postings", "hiring signals", "funding rounds", "technology stack of a company", "sec filings", "stock quotes",
  "company financials", "crypto prices", "wallet activity", "token market data", "blockchain data", "exchange rates",
  "flight search", "flight status", "hotel search", "travel", "maps and places", "geocoding", "directions and routing",
  "image generation", "video generation", "text to speech", "speech transcription", "llm chat completion", "embeddings",
  "translation", "ocr document parsing", "pdf extraction", "code sandbox execution", "browser automation",
  "send email", "send sms", "fax", "postal mail", "social media posts", "tiktok", "instagram", "twitter x posts", "reddit",
  "youtube", "reviews", "product search shopping", "sneakers resale prices", "real estate", "vehicles", "sports data",
  "academic papers", "patents", "legal", "domain whois dns", "ip geolocation", "captcha", "storage", "memory for agents",
];

export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
