/**
 * check_before_paying: what vet402's public record holds about a seller, read before an agent pays it.
 *
 * Input: the URL about to be paid, and optionally the chain and the payTo the 402 names. Output: facts
 * only. How many purchases vet402 tried from that seller, how many settled, how many came back with an
 * answer, the newest purchase and its tx, the failures counted against the seller and the ones that
 * are not, the grade as rank.json prints it (`measuring` included), and the signed records published
 * for that seller. When vet402 holds nothing, the answer says so. The decision stays with the caller.
 */
import { type PublicData } from "./sources.js";
import { PUBLIC_SITE_URL } from "./sources.js";
import { verdictFor, type Held, type Verdict, type VerdictBasis } from "./verdict.js";
import { notifiedSellers, type NotifiedFile } from "../../../src/receipt/publish.js";

export interface CheckInput {
  /** The resource URL about to be paid. */
  url: string;
  /** solana, tempo, base, algorand, or a CAIP-2 id (solana:5eykt..., eip155:4217, eip155:8453, algorand:...). */
  chain?: string;
  /** The payTo (recipient) the 402 names. */
  payTo?: string;
}

export interface Attempt {
  at: string;
  chain: string;
  url: string;
  /** rank.json's category for the purchase (delivered, settled_error_status, ...). */
  category: string;
  httpStatus: number | null;
  tx: string | null;
  explorer: string | null;
}

export interface SellerFacts {
  /** Seller key in rank.json: the host, or host#service for one service behind a shared host. */
  key: string;
  /** The rank.json page the figures come from: "main" (Solana, Tempo and Base) or "algorand". */
  page: string;
  pageLabel: string;
  sellerPage: string;
  grade: string;
  rank: number | null;
  tried: number;
  settled: number;
  /** Settled and answered 2xx with a non-empty body. */
  delivered: number;
  /** Purchases that count toward the grade: delivered, or failed on the seller's side. */
  counted: number;
  /** Different UTC days with counted purchases (rank.json's `days`, page-wide). */
  days: number;
  byChain: Record<string, { tried: number; settled: number; counted: number; delivered: number; lastAt: string | null }>;
  firstAt: string | null;
  lastAt: string | null;
  /** Failures rank.json counts against the seller, by rule. */
  sellerSideFailures: Record<string, number>;
  /** Failures rank.json does not count against the seller: vet402 or the facilitator, or cause unknown. */
  notCountedAgainstSeller: { vet402OrFacilitator: number; causeUnknown: number; byRule: Record<string, number> };
  last: Attempt | null;
  lastSellerSideFailure: (Attempt & { rule: string | null; detail: string | null }) | null;
  /** Among the purchases rank.json lists as recent for this seller, the ones to exactly this URL. */
  sameUrlInRecent: { listed: number; tried: number; delivered: number };
  payTos: string[];
  payToChanged: boolean;
  /**
   * Robinhood Chain and Arbitrum (data/evm/<lane>.json): purchases whose result is held until the seller is
   * told (status "withheld"). They are not in `tried`; their result is not published, so it is not here.
   */
  held?: number;
  /** The figures the verdict may rest on: only purchases whose payment settled (see PAID_SELLER_RULES). */
  paid: PaidFigures;
}

/**
 * Purchases whose payment settled and that count: delivered, plus seller-side failures that came after a
 * settled payment. A seller-side failure with no settlement (server_error_5xx: the seller's server answered
 * 5xx and no payment settled) is not a paid call, so it never enters a verdict.
 */
export interface PaidFigures {
  counted: number;
  answered: number;
  /** UTC days with such purchases. Exact when every counted purchase settled; otherwise counted from the newest purchases rank.json lists (a lower bound). */
  days: number;
  /** Per chain; null when rank.json's figures cannot be split by chain without guessing. */
  byChain: Record<string, { counted: number; answered: number; days: number } | null>;
}

/** Seller-side rules that follow a settled payment (rank.json method.faultRules). */
export const PAID_SELLER_RULES = new Set(["paid_not_delivered", "settled_not_delivered"]);
/** Seller-side rules with no settled payment. Any seller-side rule in neither set is treated like these. */
export const UNPAID_SELLER_RULES = new Set(["server_error_5xx"]);

export interface RecordRef {
  id: string;
  day: string;
  verdict: string;
  network: string;
  resourceUrl: string;
  json: string;
  page: string;
  /** Whether that day's root is written in a Solana memo, and the memo tx. */
  anchor: { status: string; tx: string | null } | null;
}

export interface CheckResult {
  /** pay, avoid or unknown, from verdict.ts (the one place the rule lives). */
  verdict: Verdict;
  /** One English sentence; its numbers are the fields of `basis`. */
  why: string;
  /** The seller figures the verdict rests on; null when vet402 has no record. */
  basis: VerdictBasis | null;
  /** "seller_not_told": a negative result exists but is held until the seller has been told; the verdict is then "unknown". */
  held: Held;
  /** Purchases held until the seller is told (Robinhood Chain, Arbitrum); not used for the verdict. */
  heldPurchases: number;
  /** One sentence on those purchases, also at the end of why; null when there are none. */
  heldNote: string | null;
  kind: "vet402-check-before-paying";
  version: 0;
  asked: { url: string; host: string; chain: string | null; payTo: string | null };
  /** true when rank.json or the published records hold this seller (on the asked chain, when one is given). */
  found: boolean;
  /** Facts in one paragraph, for a log or an agent's reasoning. */
  summary: string;
  sellers: SellerFacts[];
  records: { published: number; byVerdict: Record<string, number>; sameUrl: number; newest: RecordRef[] };
  payTo: { asked: string; recordedByVet402: string[]; sameAsRecorded: boolean } | null;
  asOf: { rankDate: string | null; rankGeneratedAt: string | null; recordDays: string[]; recordsPublished: number };
  notes: string[];
  sources: string[];
}

/** Chain names as rank.json writes them, from a name or a CAIP-2 id. */
export function normalizeChain(chain: string): string {
  const c = chain.trim();
  const lower = c.toLowerCase();
  if (["solana", "tempo", "base", "algorand", "arbitrum", "robinhood"].includes(lower)) return lower;
  if (c === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") return "solana";
  if (lower === "eip155:4217") return "tempo";
  if (lower === "eip155:8453") return "base";
  if (lower === "eip155:42161") return "arbitrum";
  if (lower === "eip155:4663") return "robinhood";
  if (/^algorand:/i.test(c)) return "algorand";
  throw new Error(`${chain}: unknown chain; use solana, tempo, base, algorand, arbitrum, robinhood or their CAIP-2 id`);
}

export const NETWORK_OF: Record<string, string> = {
  solana: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  tempo: "eip155:4217",
  base: "eip155:8453",
};

export function explorerFor(chain: string, tx: string | null): string | null {
  if (!tx) return null;
  const t = encodeURIComponent(tx);
  if (chain === "solana") return `https://solscan.io/tx/${t}`;
  if (chain === "tempo") return `https://explore.tempo.xyz/tx/${t}`;
  if (chain === "base") return `https://basescan.org/tx/${t}`;
  if (chain === "algorand") return `https://allo.info/tx/${t}`;
  if (chain === "arbitrum") return `https://arbiscan.io/tx/${t}`;
  if (chain === "robinhood") return `https://robinhoodchain.blockscout.com/tx/${t}`;
  return null;
}

function chainOfNetwork(network: string): string | null {
  try {
    return normalizeChain(network);
  } catch {
    return null;
  }
}

/** Seller page file names, the same rule as the site (src/rank/html.ts sellerSlugs; a test keeps them equal). */
export function sellerSlugs(keys: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const key of keys) {
    let base = key
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "_")
      .replace(/\.{2,}/g, "_")
      .replace(/^[.-]+/, "_")
      .slice(0, 120);
    if (base === "" || base === "_") base = "seller";
    let slug = base;
    for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
    used.add(slug);
    out.set(key, slug);
  }
  return out;
}

// ---- reading rank.json and the records index defensively (they are data from the network) ----

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

interface RankView {
  date: string | null;
  generatedAt: string | null;
  faultOf: Map<string, string>;
  groups: { id: string; label: string; ranking: Obj[] }[];
  slugs: Map<string, string>;
}

export function readRank(raw: unknown): RankView {
  if (!isObj(raw) || raw.kind !== "vet402-seller-rank") throw new Error("rank.json: not a vet402 seller rank");
  const method = isObj(raw.method) ? raw.method : {};
  const faultOf = new Map<string, string>();
  for (const r of arr(method.faultRules)) if (isObj(r) && str(r.id) && str(r.fault)) faultOf.set(r.id as string, r.fault as string);
  const groups = arr(raw.groups)
    .filter(isObj)
    .map((g) => ({ id: str(g.id) ?? "?", label: str(g.label) ?? str(g.id) ?? "?", ranking: arr(g.ranking).filter(isObj) }));
  const keys = [...new Set(groups.flatMap((g) => g.ranking.map((s) => str(s.key)).filter((k): k is string => k !== null)))].sort();
  return { date: str(raw.date), generatedAt: str(raw.generatedAt), faultOf, groups, slugs: sellerSlugs(keys) };
}

interface IndexEntry {
  id: string;
  day: string;
  file: string;
  sha256: string;
  network: string;
  verdict: string;
  resourceUrl: string;
  host: string;
  seller: string;
}

interface IndexView {
  entries: IndexEntry[];
  days: Map<string, { root: string; anchor: { status: string; tx: string | null } | null }>;
}

export function readRecordsIndex(raw: unknown): IndexView {
  if (!isObj(raw) || raw.kind !== "vet402-observation-records") throw new Error("records index: not a vet402 records index");
  const entries: IndexEntry[] = [];
  for (const e of arr(raw.records)) {
    if (!isObj(e)) continue;
    const id = str(e.id);
    if (!id) continue;
    entries.push({
      id,
      day: str(e.day) ?? "",
      file: str(e.file) ?? "",
      sha256: str(e.sha256) ?? "",
      network: str(e.network) ?? "",
      verdict: str(e.verdict) ?? "",
      resourceUrl: str(e.resourceUrl) ?? "",
      host: (str(e.host) ?? "").toLowerCase(),
      seller: str(e.seller) ?? "",
    });
  }
  const days = new Map<string, { root: string; anchor: { status: string; tx: string | null } | null }>();
  for (const d of arr(raw.days)) {
    if (!isObj(d) || !str(d.day)) continue;
    const a = isObj(d.anchor) ? { status: str(d.anchor.status) ?? "?", tx: str(d.anchor.tx) } : null;
    days.set(d.day as string, { root: str(d.root) ?? "", anchor: a });
  }
  return { entries, days };
}

// ---- Robinhood Chain and Arbitrum: data/evm/<lane>.json (one purchase per payTo, one run) ----

interface LaneRowView {
  status: string;
  resource: string;
  host: string;
  /** Every host the catalogs list for the same payTo (the same seller). */
  hosts: string[];
  payTo: string;
  tx: string | null;
  purchases: number;
}

interface LaneView {
  lane: "arbitrum" | "robinhood";
  label: string;
  generatedAt: string;
  rows: LaneRowView[];
}

const LANE_LABEL = { arbitrum: "Arbitrum One", robinhood: "Robinhood Chain" } as const;
/** The statuses in which vet402 sent a payment (the lane pages count these as "bought by vet402"). */
const LANE_BOUGHT = new Set(["delivered", "settled_no_answer", "not_settled", "unconfirmed", "withheld"]);

export function readLanes(raw: unknown[]): LaneView[] {
  const out: LaneView[] = [];
  for (const l of raw) {
    if (!isObj(l) || l.kind !== "vet402-evm-lane" || (l.lane !== "arbitrum" && l.lane !== "robinhood")) continue;
    const rows: LaneRowView[] = [];
    for (const r of arr(l.rows)) {
      if (!isObj(r) || !LANE_BOUGHT.has(str(r.status) ?? "") || !str(r.resource)) continue;
      let host: string;
      try {
        host = new URL(r.resource as string).hostname.toLowerCase();
      } catch {
        continue;
      }
      const hosts = arr(r.hosts).map(str).filter((h): h is string => h !== null).map((h) => h.toLowerCase());
      rows.push({ status: r.status as string, resource: r.resource as string, host, hosts, payTo: str(r.payTo) ?? "", tx: str(r.settlementTx), purchases: Math.max(1, num(r.purchases)) });
    }
    out.push({ lane: l.lane, label: LANE_LABEL[l.lane], generatedAt: str(l.generatedAt) ?? "", rows });
  }
  return out;
}

/** One lane's purchases from the URL's host, as SellerFacts. Exact-URL rows first when there are any. */
function laneFacts(l: LaneView, u: URL): SellerFacts | null {
  const host = u.hostname.toLowerCase();
  const rows = l.rows.filter((r) => r.host === host || r.hosts.includes(host));
  if (!rows.length) return null;
  const n = (st: string) => rows.filter((r) => r.status === st).reduce((k, r) => k + r.purchases, 0);
  const delivered = n("delivered");
  const noAnswer = n("settled_no_answer");
  const held = n("withheld");
  const unclear = n("not_settled") + n("unconfirmed");
  const tried = delivered + noAnswer + unclear;
  const at = l.generatedAt || null;
  const shown = rows.filter((r) => r.status !== "withheld");
  const lastRow = shown.find((r) => sameUrl(r.resource, u.href)) ?? shown[0] ?? null;
  const same = shown.filter((r) => sameUrl(r.resource, u.href));
  return {
    key: host,
    page: l.lane,
    pageLabel: l.label,
    sellerPage: `${PUBLIC_SITE_URL}/${l.lane}.html`,
    grade: "measuring",
    rank: null,
    tried,
    settled: delivered + noAnswer,
    delivered,
    counted: delivered + noAnswer,
    days: delivered + noAnswer > 0 ? 1 : 0,
    byChain: { [l.lane]: { tried, settled: delivered + noAnswer, counted: delivered + noAnswer, delivered, lastAt: at } },
    firstAt: at,
    lastAt: at,
    sellerSideFailures: noAnswer ? { settled_no_answer: noAnswer } : {},
    notCountedAgainstSeller: { vet402OrFacilitator: 0, causeUnknown: unclear, byRule: unclear ? { not_settled: unclear } : {} },
    last: lastRow ? { at: at ?? "", chain: l.lane, url: lastRow.resource, category: lastRow.status, httpStatus: null, tx: lastRow.tx, explorer: explorerFor(l.lane, lastRow.tx) } : null,
    lastSellerSideFailure: null,
    sameUrlInRecent: { listed: shown.length, tried: same.length, delivered: same.filter((r) => r.status === "delivered").length },
    payTos: [...new Set(rows.map((r) => r.payTo).filter(Boolean))],
    payToChanged: false,
    ...(held ? { held } : {}),
    // One run: every purchase on one day.
    paid: { counted: delivered + noAnswer, answered: delivered, days: delivered + noAnswer > 0 ? 1 : 0, byChain: { [l.lane]: { counted: delivered + noAnswer, answered: delivered, days: delivered + noAnswer > 0 ? 1 : 0 } } },
  };
}

// ---- the lookup ----

export function parseUrl(url: string): URL {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    throw new Error(`${url}: not a URL`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${url}: not an http(s) URL`);
  return u;
}

function recordedUrls(s: Obj): string[] {
  const out: string[] = [];
  for (const k of ["last", "exampleDeliveredTx", "exampleFailedTx", "lastFailure"]) if (isObj(s[k]) && str((s[k] as Obj).url)) out.push((s[k] as Obj).url as string);
  for (const k of ["recent", "sellerFailures"]) for (const r of arr(s[k])) if (isObj(r) && str(r.url)) out.push(r.url as string);
  return out;
}

function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

const firstSegment = (u: string): string | null => {
  try {
    return new URL(u).pathname.split("/").filter(Boolean)[0] ?? null;
  } catch {
    return null;
  }
};

/**
 * The rank.json entries for the URL's host. When one host fronts several services that vet402 counts as
 * separate sellers (host#service), keep the ones whose recorded URLs are this URL or share its first
 * path segment; if none do, keep them all and say so.
 */
function sellersForUrl(rank: RankView, u: URL, notes: string[]): { group: RankView["groups"][number]; s: Obj }[] {
  const host = u.hostname.toLowerCase();
  const all = rank.groups.flatMap((group) => group.ranking.filter((s) => (str(s.host) ?? "").toLowerCase() === host).map((s) => ({ group, s })));
  const services = new Set(all.filter(({ s }) => str(s.service)).map(({ s }) => str(s.key)));
  if (services.size <= 1) return all;
  const seg = firstSegment(u.href);
  const exact = all.filter(({ s }) => recordedUrls(s).some((r) => sameUrl(r, u.href)));
  if (exact.length) return exact;
  const bySeg = seg === null ? [] : all.filter(({ s }) => recordedUrls(s).some((r) => firstSegment(r) === seg));
  if (bySeg.length) return bySeg;
  notes.push(`${host} fronts ${services.size} services that vet402 counts as separate sellers; no recorded URL of theirs shares this URL's path, so all of them are listed.`);
  return all;
}

function attemptOf(r: Obj | undefined, fallbackChain: string | null = null): Attempt | null {
  if (!r) return null;
  const chain = str(r.chain) ?? fallbackChain ?? "?";
  const tx = str(r.tx);
  const http = typeof r.httpStatus === "number" ? r.httpStatus : null;
  const raw = str(r.rawReason);
  const fromRaw = raw ? /http (\d{3})/.exec(raw) : null;
  return {
    at: str(r.at) ?? "",
    chain,
    url: str(r.url) ?? "",
    category: str(r.category) ?? (r.delivered === true ? "delivered" : r.delivered === false ? "not_delivered" : "?"),
    httpStatus: http ?? (fromRaw ? Number(fromRaw[1]) : null),
    tx,
    explorer: explorerFor(chain, tx),
  };
}

function sellerFacts(rank: RankView, group: RankView["groups"][number], s: Obj, u: URL): SellerFacts {
  const key = str(s.key) ?? "?";
  const byRule = isObj(s.failuresByRule) ? s.failuresByRule : {};
  const sellerSide: Record<string, number> = {};
  const notCounted: Record<string, number> = {};
  for (const [rule, n] of Object.entries(byRule)) {
    if (!num(n)) continue;
    if (rank.faultOf.get(rule) === "seller") sellerSide[rule] = num(n);
    else notCounted[rule] = num(n);
  }
  const excluded = isObj(s.excluded) ? s.excluded : {};
  const byChain: SellerFacts["byChain"] = {};
  if (isObj(s.chains))
    for (const [c, v] of Object.entries(s.chains))
      if (isObj(v)) byChain[c] = { tried: num(v.tried), settled: num(v.settled), counted: num(v.counted), delivered: num(v.delivered), lastAt: str(v.lastAt) };
  const recent = arr(s.recent).filter(isObj);
  const same = recent.filter((r) => str(r.url) !== null && sameUrl(r.url as string, u.href));
  // Verdict figures: settled purchases only.
  const unpaidSellerFailures = Object.entries(sellerSide).filter(([rule]) => !PAID_SELLER_RULES.has(rule)).reduce((n, [, k]) => n + k, 0);
  const paidSellerFailures = Object.entries(sellerSide).filter(([rule]) => PAID_SELLER_RULES.has(rule)).reduce((n, [, k]) => n + k, 0);
  const isPaidCounted = (r: Obj): boolean => r.delivered === true || (r.fault === "seller" && PAID_SELLER_RULES.has(str(r.rule) ?? ""));
  const daysOf = (rows: Obj[]) => new Set(rows.map((r) => (str(r.at) ?? "").slice(0, 10)).filter(Boolean)).size;
  const listed = [...recent, ...arr(s.sellerFailures).filter(isObj)].filter(isPaidCounted);
  const pageDays = arr(s.days).length;
  const paidByChain: PaidFigures["byChain"] = {};
  for (const [c, v] of Object.entries(byChain)) {
    // rank.json splits counted and delivered by chain, not failures by rule: split only when every
    // counted purchase settled; days per chain only from the purchases listed for that chain.
    paidByChain[c] = unpaidSellerFailures === 0 ? { counted: v.counted, answered: v.delivered, days: daysOf(listed.filter((r) => r.chain === c)) } : null;
  }
  const paid: PaidFigures = {
    counted: num(s.delivered) + paidSellerFailures,
    answered: num(s.delivered),
    days: unpaidSellerFailures === 0 ? pageDays : daysOf(listed),
    byChain: paidByChain,
  };
  const lf = isObj(s.lastFailure) ? s.lastFailure : undefined;
  const lastFail = lf && lf.fault === "seller" ? lf : (arr(s.sellerFailures).find(isObj) as Obj | undefined);
  const lastFailAttempt = attemptOf(lastFail);
  return {
    key,
    page: group.id,
    pageLabel: group.label,
    sellerPage: `${PUBLIC_SITE_URL}/seller/${rank.slugs.get(key) ?? "seller"}.html`,
    grade: str(s.grade) ?? "?",
    rank: typeof s.rank === "number" ? s.rank : null,
    tried: num(s.tried),
    settled: num(s.settled),
    delivered: num(s.delivered),
    counted: num(s.counted),
    days: arr(s.days).length,
    byChain,
    firstAt: str(s.firstAt),
    lastAt: str(s.lastAt),
    sellerSideFailures: sellerSide,
    notCountedAgainstSeller: { vet402OrFacilitator: num(excluded.vet402_or_facilitator), causeUnknown: num(excluded.unknown), byRule: notCounted },
    last: attemptOf(isObj(s.last) ? s.last : undefined),
    lastSellerSideFailure: lastFailAttempt && lastFail ? { ...lastFailAttempt, rule: str(lastFail.rule), detail: str(lastFail.detail) } : null,
    sameUrlInRecent: { listed: recent.length, tried: same.length, delivered: same.filter((r) => r.delivered === true).length },
    payTos: arr(s.payTos).map(str).filter((p): p is string => p !== null),
    payToChanged: s.payToChanged === true,
    paid,
  };
}

function samePayTo(a: string, b: string): boolean {
  return /^0x[0-9a-f]{40}$/i.test(a) && /^0x[0-9a-f]{40}$/i.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : "?");

function countsText(m: Record<string, number>): string {
  const parts = Object.entries(m)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k, n]) => `${k} ${n}`);
  return parts.length ? parts.join(", ") : "none";
}

function sellerLine(f: SellerFacts, chain: string | null): string {
  const chains = Object.keys(f.byChain);
  const scope = chain && chains.length > 1 && f.byChain[chain] ? { ...f.byChain[chain]! } : null;
  const head = scope
    ? `${f.key} (${f.pageLabel} page): on ${chain}, vet402 tried ${scope.tried} purchase${scope.tried === 1 ? "" : "s"}; ${scope.settled} settled, ${scope.delivered} came back with an answer. Across ${chains.join(", ")} from ${day(f.firstAt)} to ${day(f.lastAt)}: tried ${f.tried}, settled ${f.settled}, came back with an answer ${f.delivered}`
    : `${f.key} (${f.pageLabel} page): vet402 tried ${f.tried} purchase${f.tried === 1 ? "" : "s"} on ${chains.join(", ") || "?"} from ${day(f.firstAt)} to ${day(f.lastAt)}; ${f.settled} settled, ${f.delivered} came back with an answer`;
  const nc = f.notCountedAgainstSeller;
  const last = f.last
    ? ` Newest purchase: ${f.last.at} on ${f.last.chain}, ${f.last.category}${f.last.httpStatus !== null ? ` (HTTP ${f.last.httpStatus})` : ""}${f.last.tx ? `, tx ${f.last.tx}` : ", no tx"}.`
    : "";
  return (
    `${head}. Failures counted against the seller: ${countsText(f.sellerSideFailures)}. ` +
    `Not counted against the seller: ${nc.vet402OrFacilitator + nc.causeUnknown} (vet402 or facilitator ${nc.vet402OrFacilitator}, cause unknown ${nc.causeUnknown}). ` +
    `Grade: ${f.grade}${f.rank !== null ? `, rank ${f.rank}` : ""}.${last}` +
    (f.held ? ` Results of ${f.held} more purchase${f.held === 1 ? "" : "s"} are held until the seller is told.` : "")
  );
}

/**
 * The lookup itself, over data already read. Pure. `lanesRaw`: data/evm/arbitrum.json and robinhood.json
 * (Arbitrum and Robinhood Chain), optional.
 */
export function lookup(rankRaw: unknown, indexRaw: unknown, input: CheckInput, sources: string[] = [], lanesRaw: unknown[] = [], notifiedRaw: unknown = null): CheckResult {
  const u = parseUrl(input.url);
  const host = u.hostname.toLowerCase();
  const chain = input.chain ? normalizeChain(input.chain) : null;
  const payTo = input.payTo?.trim() || null;
  const rank = readRank(rankRaw);
  const index = readRecordsIndex(indexRaw);
  const notes: string[] = [];

  let pairs = sellersForUrl(rank, u, notes);
  const onOtherChains = new Set<string>();
  if (chain) {
    const all = pairs;
    pairs = all.filter(({ s }) => isObj(s.chains) && chain in s.chains);
    if (!pairs.length) for (const { s } of all) if (isObj(s.chains)) for (const c of Object.keys(s.chains)) onOtherChains.add(c);
  }
  const sellers = pairs.map(({ group, s }) => sellerFacts(rank, group, s, u));
  for (const l of readLanes(lanesRaw)) {
    const f = laneFacts(l, u);
    if (!f) continue;
    if (chain && chain !== l.lane) {
      onOtherChains.add(l.lane);
      continue;
    }
    sellers.push(f);
  }
  if (sellers.length) onOtherChains.clear();
  const keys = new Set(sellers.map((f) => f.key));

  // Records: the sellers found, or the host when rank.json has none on that chain.
  const network = chain ? NETWORK_OF[chain] ?? null : null;
  const recs = index.entries
    .filter((e) => (keys.size ? keys.has(e.seller) : e.host === host && !onOtherChains.size))
    .filter((e) => !chain || chainOfNetwork(e.network) === chain)
    .sort((a, b) => (a.id < b.id ? 1 : -1));
  const byVerdict: Record<string, number> = {};
  for (const e of recs) byVerdict[e.verdict] = (byVerdict[e.verdict] ?? 0) + 1;
  const newest: RecordRef[] = recs.slice(0, 5).map((e) => ({
    id: e.id,
    day: e.day,
    verdict: e.verdict,
    network: e.network,
    resourceUrl: e.resourceUrl,
    json: `${PUBLIC_SITE_URL}/records/${e.id}.json`,
    page: `${PUBLIC_SITE_URL}/records/${e.id}.html`,
    anchor: index.days.get(e.day)?.anchor ?? null,
  }));
  const sameUrlRecords = recs.filter((e) => sameUrl(e.resourceUrl, u.href)).length;
  if (network === null && chain === "algorand" && recs.length === 0 && sellers.length) notes.push("Signed records are published for Solana, Tempo and Base purchases; the Algorand page has none.");

  const recordedPayTos = [...new Set(sellers.flatMap((f) => f.payTos))];
  const payToFact = payTo ? { asked: payTo, recordedByVet402: recordedPayTos, sameAsRecorded: recordedPayTos.some((p) => samePayTo(p, payTo)) } : null;

  const found = sellers.length > 0 || recs.length > 0;
  const asOfText = `rank.json of ${rank.date ?? "?"} and ${index.entries.length} published signed records`;
  let summary: string;
  if (!found) {
    summary = onOtherChains.size
      ? `vet402 has no record of this seller on ${chain}: ${host} is in ${asOfText} only for ${[...onOtherChains].sort().join(", ")}.`
      : `vet402 has no record of this seller: ${host} is not in ${asOfText}.`;
  } else {
    const lines = sellers.map((f) => sellerLine(f, chain));
    const recLine = recs.length
      ? `Signed records published: ${recs.length} (${countsText(byVerdict)})${sameUrlRecords ? `, ${sameUrlRecords} for this exact URL` : ""}; newest ${newest[0]!.id}${newest[0]!.anchor?.status === "anchored" && newest[0]!.anchor.tx ? `, its day's Merkle root is in Solana memo tx ${newest[0]!.anchor.tx}` : ", its day's root is not yet written on chain"}.`
      : sellers.length
        ? "No signed record of this seller is published."
        : "";
    const ptLine = payToFact
      ? payToFact.sameAsRecorded
        ? `The payTo asked about (${payTo}) is one vet402 recorded for this seller.`
        : `The payTo asked about (${payTo}) is not one vet402 recorded for this seller (${recordedPayTos.length ? recordedPayTos.join(", ") : "none recorded"}).`
      : "";
    summary = [...lines, recLine, ptLine].filter(Boolean).join(" ");
  }

  const asked = { url: u.href, host, chain, payTo };
  const v = verdictFor({ found, sellers, asked, payTo: payToFact }, toldSet(notifiedRaw));
  return {
    verdict: v.verdict,
    why: v.why,
    basis: v.basis,
    held: v.held,
    heldPurchases: v.heldPurchases,
    heldNote: v.heldNote,
    kind: "vet402-check-before-paying",
    version: 0,
    asked,
    found,
    summary,
    sellers,
    records: { published: recs.length, byVerdict, sameUrl: sameUrlRecords, newest },
    payTo: payToFact,
    asOf: { rankDate: rank.date, rankGeneratedAt: rank.generatedAt, recordDays: [...index.days.keys()].sort(), recordsPublished: index.entries.length },
    notes,
    sources,
  };
}

/** notified.json as the records loader reads it (src/receipt/publish.ts); unreadable or absent: nobody told. */
export function toldSet(raw: unknown): ReadonlySet<string> {
  if (!raw) return new Set();
  try {
    return notifiedSellers(raw as NotifiedFile);
  } catch {
    return new Set();
  }
}

/** Read the public data (or the sources `data` names) and look the URL up. Read-only. */
export async function checkBeforePaying(input: CheckInput, data: PublicData): Promise<CheckResult> {
  const [rankRaw, indexRaw, lanesRaw, notifiedRaw] = await Promise.all([data.rank(), data.recordsIndex(), data.lanes(), data.notified()]);
  return lookup(rankRaw, indexRaw, input, [data.sources.rank, data.sources.recordsIndex, ...data.sources.lanes, ...(data.sources.notified ? [data.sources.notified] : [])], lanesRaw, notifiedRaw);
}
