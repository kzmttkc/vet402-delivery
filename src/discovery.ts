/**
 * Read the PayAI and CDP Bazaar discovery catalogues and pick gate-1 candidates.
 * Read-only: nothing here signs or pays.
 */
import { MAX_PER_PURCHASE_ATOMIC, OWN_HOSTS, SOLANA_MAINNET, USDC_MINT } from "./constants.js";
import { normalizeAccept, type SolAccept } from "./guard.js";
import { fillParams, isPlaceholder } from "./inputs/fill.js";
import { fromBazaar } from "./inputs/spec.js";

export interface Listing {
  resource: string;
  method?: string;
  x402Version?: number;
  lastUpdated?: string;
  accepts?: Record<string, unknown>[];
  extensions?: { bazaar?: { info?: { input?: Record<string, unknown> } } };
  inputSchema?: Record<string, unknown>;
  description?: string;
}

export async function fetchCatalog(
  baseUrl: string,
  opts: { pageLimit?: number; sleepMs?: number; fetchImpl?: typeof fetch; maxPages?: number } = {},
): Promise<{ items: Listing[]; total: number | null; complete: boolean }> {
  const f = opts.fetchImpl ?? fetch;
  const limit = opts.pageLimit ?? 1000;
  const items: Listing[] = [];
  let total: number | null = null;
  for (let page = 0; page < (opts.maxPages ?? 100); page++) {
    const url = `${baseUrl}?limit=${limit}&offset=${items.length}`;
    const res = await f(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`${baseUrl}: HTTP ${res.status}`);
    const body = (await res.json()) as { items?: Listing[]; pagination?: { total?: number } };
    const got = Array.isArray(body.items) ? body.items : [];
    if (typeof body.pagination?.total === "number") total = body.pagination.total;
    items.push(...got);
    if (got.length === 0 || (total !== null && items.length >= total)) return { items, total, complete: true };
    if (opts.sleepMs) await new Promise((r) => setTimeout(r, opts.sleepMs));
  }
  return { items, total, complete: false };
}

export function hostOf(u: string): string {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return "";
  }
}

export function normUrl(u: string): string {
  try {
    const x = new URL(u);
    return `${x.protocol}//${x.host.toLowerCase()}${x.pathname}`.replace(/\/+$/, "");
  } catch {
    return u;
  }
}

function isOwnHost(h: string): boolean {
  return OWN_HOSTS.some((o) => h === o || h.endsWith(`.${o}`));
}

/** The declared input, wherever this listing keeps it (v2 extension, inputSchema, v1 outputSchema.input). */
export function declaredInput(l: Listing): Record<string, unknown> | undefined {
  const fromExt = l.extensions?.bazaar?.info?.input;
  if (fromExt && typeof fromExt === "object") return fromExt;
  if (l.inputSchema && typeof l.inputSchema === "object") return l.inputSchema;
  for (const a of l.accepts ?? []) {
    const os = a.outputSchema as { input?: Record<string, unknown> } | undefined;
    if (os?.input && typeof os.input === "object") return os.input;
  }
  return undefined;
}

const PLACEHOLDER_RE = /<[^>]*>|\{[^}]*\}|\bYOUR[_ ]|\bREPLACE|\bxxx+\b|\.\.\./i;

export interface BuiltGet {
  ok: true;
  url: string;
  /** 2 = concrete example values, 1 = no input needed, 0 = inputs declared without a usable example */
  exampleScore: 0 | 1 | 2;
  exampleInput: Record<string, string> | null;
}

/** The GET request vet402 would send, from the seller's own example. */
export function buildGet(l: Listing, today: string = new Date().toISOString().slice(0, 10)): BuiltGet | { ok: false; reason: string } {
  const inp = declaredInput(l) ?? {};
  const method = String(inp.method ?? l.method ?? "GET").toUpperCase();
  if (method !== "GET") return { ok: false, reason: "not_get" };
  let u: URL;
  try {
    u = new URL(l.resource);
  } catch {
    return { ok: false, reason: "bad_url" };
  }
  if (u.protocol !== "https:") return { ok: false, reason: "not_https" };
  let path = u.pathname;
  try {
    path = decodeURI(path);
  } catch {
    /* keep raw */
  }
  if (/\{[^}]*\}|\/:[A-Za-z_]|<[^>]*>/.test(path)) return { ok: false, reason: "path_params" };
  let q = inp.queryParams as Record<string, unknown> | undefined;
  if (q && typeof q === "object" && (q as Record<string, unknown>).type === "http" && typeof (q as Record<string, unknown>).queryParams === "object") {
    q = (q as { queryParams: Record<string, unknown> }).queryParams;
  }
  const example: Record<string, string> = {};
  let unusable = 0;
  // JSON-schema style: { type: "object", properties: {...}, required: [...] }
  if (q && q.type === "object" && q.properties && typeof q.properties === "object") {
    const req = Array.isArray(q.required) ? (q.required as string[]) : [];
    const props = q.properties as Record<string, Record<string, unknown>>;
    q = {};
    for (const [k, s] of Object.entries(props)) {
      const v = s?.example ?? s?.default ?? (Array.isArray(s?.examples) ? (s.examples as unknown[])[0] : undefined) ?? (Array.isArray(s?.enum) ? (s.enum as unknown[])[0] : undefined);
      if (v !== undefined) (q as Record<string, unknown>)[k] = v;
      else if (req.includes(k)) unusable++;
    }
  }
  if (q && typeof q === "object" && !Array.isArray(q)) {
    for (const [k, raw] of Object.entries(q)) {
      const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
      const v = s ? (s.example ?? s.default) : raw;
      if (!(typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
        if (s?.required === true || s === undefined) unusable++;
        continue;
      }
      const sv = String(v);
      if (sv === "" || PLACEHOLDER_RE.test(sv)) {
        unusable++;
        continue;
      }
      example[k] = sv;
      u.searchParams.set(k, sv);
    }
  }
  const hasExample = Object.keys(example).length > 0;
  // A placeholder the regex above lets through ("example", "string") or a parameter without a usable example:
  // fill it from the listing's schema and src/inputs/values.ts. If that is not possible the listing stays at score 0
  // (nothing is sent), as before.
  if (unusable > 0 || Object.values(example).some((v) => isPlaceholder(v))) {
    const filled = fillFromListing(l, q, today);
    if (filled) return { ok: true, url: filled.url, exampleScore: 2, exampleInput: filled.input };
  }
  const exampleScore: 0 | 1 | 2 = unusable > 0 ? 0 : hasExample ? 2 : 1;
  return { ok: true, url: u.toString(), exampleScore, exampleInput: hasExample ? example : null };
}

/** The listing's query with its placeholders and missing required parameters filled; null when one cannot be. */
function fillFromListing(l: Listing, q: Record<string, unknown> | undefined, today: string): { url: string; input: Record<string, string> } | null {
  const sent: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(q ?? {})) {
    const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
    const v = s ? (s.example ?? s.default ?? null) : raw;
    sent[k] = typeof v === "string" && PLACEHOLDER_RE.test(v) ? null : v;
  }
  const spec = fromBazaar(l as unknown as Record<string, unknown>, "listing");
  const r = fillParams(sent, spec ? { ...spec, params: spec.params.filter((p) => p.in === "query") } : null, today, new URL(l.resource).pathname);
  if (!r.ok) return null;
  const u = new URL(l.resource);
  const input: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.params)) {
    if (v === null || v === undefined || typeof v === "object") return null;
    input[k] = String(v);
    u.searchParams.set(k, String(v));
  }
  return Object.keys(input).length > 0 ? { url: u.toString(), input } : null;
}

export interface CatalogCandidate {
  host: string;
  resource: string;
  requestUrl: string;
  exampleScore: 0 | 1 | 2;
  exampleInput: Record<string, string> | null;
  declared: SolAccept;
  lastUpdated?: string;
  x402Version?: number;
}

export interface SelectionStats {
  payaiItems: number;
  cdpItems: number;
  payaiSolana: number;
  payaiOnlyByUrl: number;
  payaiOnlyByUrlHosts: number;
  payaiOnlyByHost: number;
  payaiOnlyByHostHosts: number;
  eligible: number;
  eligibleHosts: number;
  dropped: Record<string, number>;
}

/**
 * PayAI-only = the listing's host appears nowhere in the CDP Bazaar (stricter than URL-level).
 * Eligible = GET, https, a Solana USDC `exact` accept at or under 0.10, not our own host.
 * Returns listings grouped per host, best first: example score, then freshness, then price.
 */
export function selectPayaiOnly(payai: Listing[], cdp: Listing[]): { byHost: Map<string, CatalogCandidate[]>; hostOrder: string[]; stats: SelectionStats } {
  const cdpUrls = new Set(cdp.map((i) => normUrl(String(i.resource ?? ""))));
  const cdpHosts = new Set(cdp.map((i) => hostOf(String(i.resource ?? ""))));
  const dropped: Record<string, number> = {};
  const drop = (r: string) => (dropped[r] = (dropped[r] ?? 0) + 1);

  const solAcceptsOf = (l: Listing) => (l.accepts ?? []).map((a) => normalizeAccept(a)).filter((a) => a.network === SOLANA_MAINNET);
  const sol = payai.filter((l) => solAcceptsOf(l).length > 0);
  const onlyUrl = sol.filter((l) => !cdpUrls.has(normUrl(l.resource)));
  const onlyHost = onlyUrl.filter((l) => !cdpHosts.has(hostOf(l.resource)));

  const byHost = new Map<string, CatalogCandidate[]>();
  for (const l of onlyHost) {
    const host = hostOf(l.resource);
    if (!host || isOwnHost(host)) {
      drop("own_or_bad_host");
      continue;
    }
    const acc = solAcceptsOf(l).find((a) => a.asset === USDC_MINT && a.scheme === "exact" && /^\d+$/.test(a.amount) && BigInt(a.amount) > 0n && BigInt(a.amount) <= MAX_PER_PURCHASE_ATOMIC);
    if (!acc) {
      drop("no_usdc_accept_at_or_under_0.10");
      continue;
    }
    const b = buildGet(l);
    if (!b.ok) {
      drop(b.reason);
      continue;
    }
    const c: CatalogCandidate = {
      host,
      resource: l.resource,
      requestUrl: b.url,
      exampleScore: b.exampleScore,
      exampleInput: b.exampleInput,
      declared: acc,
      ...(l.lastUpdated ? { lastUpdated: l.lastUpdated } : {}),
      ...(typeof l.x402Version === "number" ? { x402Version: l.x402Version } : {}),
    };
    const arr = byHost.get(host) ?? [];
    arr.push(c);
    byHost.set(host, arr);
  }
  const rank = (a: CatalogCandidate, b: CatalogCandidate) =>
    b.exampleScore - a.exampleScore ||
    String(b.lastUpdated ?? "").localeCompare(String(a.lastUpdated ?? "")) ||
    Number(BigInt(a.declared.amount) - BigInt(b.declared.amount)) ||
    a.requestUrl.localeCompare(b.requestUrl);
  for (const arr of byHost.values()) arr.sort(rank);
  const hostOrder = [...byHost.keys()].sort((x, y) => rank(byHost.get(x)![0]!, byHost.get(y)![0]!) || x.localeCompare(y));
  let eligible = 0;
  for (const arr of byHost.values()) eligible += arr.length;
  return {
    byHost,
    hostOrder,
    stats: {
      payaiItems: payai.length,
      cdpItems: cdp.length,
      payaiSolana: sol.length,
      payaiOnlyByUrl: onlyUrl.length,
      payaiOnlyByUrlHosts: new Set(onlyUrl.map((l) => hostOf(l.resource))).size,
      payaiOnlyByHost: onlyHost.length,
      payaiOnlyByHostHosts: new Set(onlyHost.map((l) => hostOf(l.resource))).size,
      eligible,
      eligibleHosts: byHost.size,
      dropped,
    },
  };
}
