/**
 * Build the rank report from normalized attempts and catalog snapshots.
 */
import { MEASURE_MAX_PER_SELLER, MEASURE_SPACING_MS } from "../constants.js";
import { FAULT_RULES } from "./classify.js";
import { compareWithCatalog, type CdpHost, type Comparison } from "./compare.js";
import { aggregate, D_UPPER, GRADE_LOWER, GRADES, MIN_COUNTED, MIN_DAYS, rank, WILSON_Z, type Grade, type RankedSeller, type SellerStats } from "./score.js";
import { CHAINS } from "./normalize.js";
import type { Attempt, Chain, Fault, ReasonCategory } from "./types.js";

export interface ChainSummary {
  chain: Chain;
  sources: string[];
  rows: number;
  tried: number;
  settled: number;
  delivered: number;
  notTried: Partial<Record<ReasonCategory, number>>;
  sellersTried: number;
  /** Delivered answers that were also checked against what the seller declared, and how many matched. */
  declared: { checked: number; matched: number };
  /** false when this chain's runner kept no body, so "delivered" there means settled + 2xx only. */
  bodyChecked: boolean;
}

export interface ChangeLogEntry {
  version: string;
  date: string;
  changes: string[];
}

export interface InputRecord {
  label: string;
  location: string;
  sha256: string;
  fetchedAt?: string;
  note?: string;
}

/**
 * Method v3: each page of the site is graded from its own chains' purchases only.
 * "main" is the first page (Solana, Tempo, Base); "algorand" is the Algorand page (data from vet402-algorand).
 */
export type GroupId = "main" | "algorand";

export interface GroupDef {
  id: GroupId;
  label: string;
  chains: readonly Chain[];
  /** The page of the public site that shows this group. */
  page: string;
}

export const GROUPS: readonly GroupDef[] = [
  { id: "main", label: "Solana, Tempo and Base", chains: ["solana", "tempo", "base"], page: "index.html" },
  { id: "algorand", label: "Algorand", chains: ["algorand"], page: "algorand.html" },
];

export function groupOf(chain: Chain): GroupDef {
  const g = GROUPS.find((x) => x.chains.includes(chain));
  if (!g) throw new Error(`no group for chain ${chain}`);
  return g;
}

/** Figures over a set of purchases. */
export interface Totals {
  attempts: number;
  tried: number;
  /** Tried purchases whose payment settled on chain. */
  settled: number;
  /** Settled on chain, and no answer with a body came back (counted directly, not settled - delivered). */
  settledNotDelivered: number;
  /** delivered + seller-side failures */
  counted: number;
  delivered: number;
  /** Tried failures not held against sellers. */
  excluded: { vet402_or_facilitator: number; unknown: number };
  /** Every tried failure by classification rule id. */
  failuresByRule: Record<string, number>;
  firstPurchaseAt: string | null;
  lastPurchaseAt: string | null;
}

export interface GroupTotals extends Totals {
  sellersSeen: number;
  /** Sellers with at least one tried purchase (all listed). */
  sellersListed: number;
  /** Sellers with a rank number. */
  sellersRanked: number;
  grades: Record<Grade, number>;
  payToChanged: number;
}

/** One page's sellers, graded from that page's chains only. */
export interface GroupReport {
  id: GroupId;
  label: string;
  chains: Chain[];
  page: string;
  totals: GroupTotals;
  comparisons: Comparison[];
  ranking: RankedSeller[];
}

export interface RankReport {
  kind: "vet402-seller-rank";
  date: string;
  generatedAt: string;
  method: {
    version: string;
    delivered: string;
    declared: string;
    counted: string;
    notCounted: string;
    faultRules: { id: string; fault: Fault; when: string }[];
    score: string;
    z: number;
    rankNumber: string;
    minCounted: number;
    minDays: number;
    grades: string;
    gradeLower: typeof GRADE_LOWER;
    dUpper: number;
    order: string;
    measurement: string;
    measureMaxPerSeller: number;
    measureSpacingMs: number;
    sellerIdentity: string;
    payTo: string;
    money: string;
    correction: string;
    limits: string[];
    changeLog: ChangeLogEntry[];
  };
  inputs: InputRecord[];
  chains: ChainSummary[];
  /** Every purchase in the report, all pages together. Grades and rank numbers live in groups only. */
  totals: Totals;
  catalogsWithoutOrder: { catalog: string; why: string }[];
  /** One entry per page, each graded from its own chains' purchases only (method v3). */
  groups: GroupReport[];
}

export function groupById(r: RankReport, id: GroupId): GroupReport {
  const g = r.groups.find((x) => x.id === id);
  if (!g) throw new Error(`report has no group ${id}`);
  return g;
}

/** Where sellers ask for a correction: new issue in the public repo that holds this ranking (issues on; checked 2026-09-28). */
export const APPEAL_ISSUES_URL = "https://github.com/kzmttkc/vet402-delivery/issues/new";

export const METHOD_VERSION = "v3";

/** How vet402 pays for the ranking; the same sentence on every page, in README.md and in src/rank/README.md. */
export const MONEY_LINE =
  "Grades come only from vet402's own purchases. vet402 also sells paid checks (on Algorand); a paid check is a separate report and never moves a grade.";

/** What "came back with an answer" (delivered) covers, and what it does not. */
export const DELIVERED_LINE =
  "Came back with an answer = vet402's payment settled, then the seller answered 2xx with a non-empty body. vet402 did not check that the answer is what the listing promised; whether its keys matched what the seller declared is a separate column.";

export const CHANGE_LOG: ChangeLogEntry[] = [
  {
    version: "v3",
    date: "2026-09-29",
    changes: [
      "Grades are computed per page. The first page (Solana, Tempo and Base) is graded from Solana, Tempo and Base purchases only; the Algorand page from Algorand purchases only. In v2 one grade per seller mixed the purchases of every chain.",
      "Effect on the 2026-09-29 report: no grade and no rank number changed. Five sellers were bought on both sides (agent402.tools, coil.trade, whaletape.xyz, api.syraa.fun, midax402.com). The three with grade A in v2 keep A and their rank on the Algorand page, now counted from Algorand purchases only (agent402.tools 43/43 instead of 46/46, coil.trade 40/40 instead of 42/42, whaletape.xyz 50/50 instead of 52/52), and are measuring on the first page.",
      "The first page shows every Solana, Tempo and Base purchase per chain and per seller, even before any seller there has a grade. The Algorand page lists all its sellers without folding any.",
      "Comparisons with catalog order are made per page.",
      "Inputs: the daily re-purchases (remeasure) from Solana and Tempo sellers vet402 already paid are read as purchases on their day. They have been read since 2026-09-29; this entry is the first to say so.",
      "Wording only, no change to the test: \"delivered\" is shown as \"came back with an answer\", with the note that vet402 did not check the answer against the listing. The money sentence now reads: grades come only from vet402's own purchases, and a paid check is a separate report that never moves a grade.",
    ],
  },
  {
    version: "v2",
    date: "2026-09-28",
    changes: [
      "Failures are split by who was at fault: seller side, vet402 or facilitator side, can't tell. Only seller-side failures count toward the grade; the other two are shown as counts.",
      "HTTP 429 and subcent_quota_exceeded from vet402 buying hundreds of one seller's items within minutes are vet402's side.",
      "One delivery test on every chain: settled, then 2xx with a non-empty body. Whether the answer matched what the seller declared is a separate column.",
      `Rank numbers only with ${MIN_COUNTED}+ counted purchases on ${MIN_DAYS}+ different days; everyone else is "measuring".`,
      `Grades A–D. Good marks by the interval's lower bound; D only when the upper bound is below ${D_UPPER}.`,
      `Measuring from now on: at most ${MEASURE_MAX_PER_SELLER} purchases per seller per run, ${MEASURE_SPACING_MS / 1000} s apart.`,
      "2026-09-28: the 6 corrected rows of the Algorand census are in (see Corrections in the vet402-algorand README): paid on chain, answered 402, delivered nothing; counted on the seller side.",
    ],
  },
  {
    version: "v1",
    date: "2026-09-28",
    changes: [
      "Score = Wilson lower bound of delivered / every tried purchase. Each chain runner's own delivery check. Every seller with one try got a rank number.",
    ],
  },
];

export const METHOD: RankReport["method"] = {
  version: METHOD_VERSION,
  delivered: `${DELIVERED_LINE} The same test on every chain, except Tempo, where the runner kept no body: there it means settled, then 2xx.`,
  declared:
    "Separate column, never part of the grade: whether the answer's keys or shape matched what the seller declared. Checked only where the runner compared them (Algorand census, Solana census) and the seller declared something.",
  counted:
    "Counted = delivered purchases plus failures on the seller's side (payment settled and nothing usable came back, or the seller's server answered 5xx). Paid on chain, answered 402, delivered nothing is counted on the seller's side, also when a facilitator error such as \"already in ledger\" came with it: the buyer paid and received nothing, and the seller chose the facilitator.",
  notCounted:
    "Not counted, shown as numbers: failures on vet402's or the facilitator's side, failures where the cause can't be told, endpoints that were not buyable, vet402's own skips (price cap, input it will not make up, duplicates) and refusals because payTo changed.",
  faultRules: FAULT_RULES.map((r) => ({ id: r.id, fault: r.fault, when: r.when })),
  score: "95% Wilson score interval of delivered / counted (z = 1.96).",
  z: WILSON_Z,
  rankNumber: `Each page is graded from its own chains' purchases only: the first page from Solana, Tempo and Base, the Algorand page from Algorand. A rank number needs at least ${MIN_COUNTED} counted purchases on at least ${MIN_DAYS} different UTC days on that page's chains. Below that the seller is listed as "measuring", with no grade and no number.`,
  minCounted: MIN_COUNTED,
  minDays: MIN_DAYS,
  grades: `A: lower bound ≥ ${GRADE_LOWER.A}. B: lower bound ≥ ${GRADE_LOWER.B}. C: lower bound ≥ ${GRADE_LOWER.C}. D: upper bound < ${D_UPPER}. Otherwise undecided. Even ${MIN_COUNTED} deliveries out of ${MIN_COUNTED} have a lower bound of 0.72 (grade C); an A needs about 35 out of 35.`,
  gradeLower: GRADE_LOWER,
  dUpper: D_UPPER,
  order: "Sellers with a rank number: lower bound desc, then delivered rate desc, then counted purchases desc, then seller name. Equal values share a number. Measuring sellers follow by name.",
  measurement: `From method v2 on: at most ${MEASURE_MAX_PER_SELLER} purchases per seller in one run, at least ${MEASURE_SPACING_MS / 1000} s apart. Amounts, payTo checks and money caps are unchanged. The 2026-09-27/28 Algorand runs predate this and bought up to ~500 items of one seller in under an hour. From 2026-09-29, vet402 also buys again about once a day from the Solana and Tempo sellers whose earlier payment settled (one purchase per recipient per day, payTo and price locked to the earlier payment), so each seller's record grows day by day. Base sellers have been bought once.`,
  measureMaxPerSeller: MEASURE_MAX_PER_SELLER,
  measureSpacingMs: MEASURE_SPACING_MS,
  sellerIdentity:
    "Seller = hostname. When one host fronts several catalog services that each pay their own recipient (a proxy), each service is its own seller: host#service.",
  payTo:
    "payTo changed = the same chain and URL asked for a different recipient in a later run, or vet402 refused to pay because the recipient differed from the one it had recorded. One recipient per chain is not a change. Shown as a flag; it does not change the grade.",
  money: `${MONEY_LINE} No listing fee, no paid placement, no referral cut. The ranking reads only the purchase files listed in data/manifest.json, and on Algorand those purchases were paid from a different wallet than the paid checks. Call counts, payer counts and anything a seller reports about itself are not inputs, so a seller cannot buy a better place by paying itself (wash trading).`,
  correction:
    "A seller who thinks a row is wrong opens a GitHub issue with the URL or tx. vet402 checks it against the chain and the raw result; a wrong row is fixed and the fix is noted in the change log.",
  limits: [
    "A seller that recognises vet402's payer address could serve vet402 better than others. The payer addresses are public.",
    "Purchases from one seller in the same run are not independent (one outage fails many at once), so the interval is narrower than it should be for runs before v2 pacing.",
    "The Tempo runner kept no response body, so on Tempo 'delivered' means settled + 2xx without the body test.",
    "The vet402-or-facilitator rules for 429 and subcent_quota_exceeded rest on how vet402 bought, not on the seller's word. If paced purchases still get them, they move to the seller side.",
    "Every input is a copy in data/ of a vet402 runner's result file, listed with its sha256 in data/manifest.json. The runners' wallets and full logs are not published.",
  ],
  changeLog: CHANGE_LOG,
};

export function summarizeChains(attempts: readonly Attempt[]): ChainSummary[] {
  return CHAINS.map((chain) => {
    const rows = attempts.filter((a) => a.chain === chain);
    const tried = rows.filter((a) => a.tried);
    const notTried: ChainSummary["notTried"] = {};
    for (const r of rows) if (!r.tried) notTried[r.category] = (notTried[r.category] ?? 0) + 1;
    return {
      chain,
      sources: [...new Set(rows.map((r) => r.source))],
      rows: rows.length,
      tried: tried.length,
      settled: tried.filter((a) => a.settled === true).length,
      delivered: tried.filter((a) => a.delivered).length,
      notTried,
      sellersTried: new Set(tried.map((a) => a.host + (a.service ? `#${a.service}` : ""))).size,
      declared: {
        checked: tried.filter((a) => a.declaredMatch !== null).length,
        matched: tried.filter((a) => a.declaredMatch === true).length,
      },
      bodyChecked: rows.every((r) => r.bodyChecked),
    };
  });
}

export function buildReport(opts: {
  date: string;
  generatedAt: string;
  attempts: readonly Attempt[];
  excludeHosts: readonly string[];
  cdp: Map<string, CdpHost> | null;
  mercator: Map<string, number> | null;
  inputs: InputRecord[];
}): RankReport {
  const groups = GROUPS.map((def) => buildGroup(def, opts));
  return {
    kind: "vet402-seller-rank",
    date: opts.date,
    generatedAt: opts.generatedAt,
    method: METHOD,
    inputs: opts.inputs,
    chains: summarizeChains(opts.attempts),
    totals: totalsOf(opts.attempts, aggregate(opts.attempts, opts.excludeHosts), opts.excludeHosts),
    catalogsWithoutOrder: [
      { catalog: "PayAI discovery", why: "Items carry no catalog-level call, payer or quality field (checked on 1,000 of 7,040 items on 2026-09-28; such words appear only inside sellers' own output examples), so there is no catalog order to compare." },
      { catalog: "mpp.dev/api/services", why: "A directory of 142 services with no usage, quality or rank field (checked 2026-09-28). Mercator's rank covers the same Tempo services." },
    ],
    groups,
  };
}

/** Totals over purchases; the per-seller figures (stats) carry the fault split, so the sums agree with the pages. */
function totalsOf(attempts: readonly Attempt[], stats: readonly SellerStats[], excludeHosts: readonly string[]): Totals {
  const tried = attempts.filter((a) => a.tried && !excludeHosts.includes(a.host));
  const sum = (f: (s: SellerStats) => number) => stats.reduce((n, s) => n + f(s), 0);
  const failuresByRule: Record<string, number> = {};
  for (const s of stats) for (const [k, v] of Object.entries(s.failuresByRule)) failuresByRule[k] = (failuresByRule[k] ?? 0) + v;
  const ats = tried.map((a) => a.at).sort();
  return {
    attempts: attempts.length,
    tried: tried.length,
    settled: tried.filter((a) => a.settled === true).length,
    settledNotDelivered: tried.filter((a) => a.settled === true && !a.delivered).length,
    counted: sum((s) => s.counted),
    delivered: sum((s) => s.delivered),
    excluded: { vet402_or_facilitator: sum((s) => s.excluded.vet402_or_facilitator), unknown: sum((s) => s.excluded.unknown) },
    failuresByRule,
    firstPurchaseAt: ats[0] ?? null,
    lastPurchaseAt: ats.at(-1) ?? null,
  };
}

/** One page: only the purchases on its chains go into its sellers' figures, grades and rank numbers. */
function buildGroup(
  def: GroupDef,
  opts: { attempts: readonly Attempt[]; excludeHosts: readonly string[]; cdp: Map<string, CdpHost> | null; mercator: Map<string, number> | null },
): GroupReport {
  const attempts = opts.attempts.filter((a) => def.chains.includes(a.chain));
  const stats = aggregate(attempts, opts.excludeHosts);
  const ranking = rank(stats);
  const comparisons: Comparison[] = [];
  if (opts.cdp) {
    const cdp = opts.cdp;
    comparisons.push(
      compareWithCatalog(ranking, "CDP Bazaar", "l30DaysTotalCalls (sum per host)", "desc", (s) =>
        s.key === s.host ? (cdp.get(s.host)?.calls30d ?? null) : null,
      ),
    );
  }
  if (opts.mercator) {
    const mer = opts.mercator;
    comparisons.push(
      compareWithCatalog(ranking, "Mercator", "best search rank (1 = first)", "asc", (s) => {
        const ranks = s.services.map((id) => mer.get(id)).filter((r): r is number => r !== undefined);
        return ranks.length ? Math.min(...ranks) : null;
      }),
    );
  }
  const grades = Object.fromEntries(GRADES.map((g) => [g, ranking.filter((s) => s.grade === g).length])) as Record<Grade, number>;
  return {
    id: def.id,
    label: def.label,
    chains: [...def.chains],
    page: def.page,
    totals: {
      ...totalsOf(attempts, stats, opts.excludeHosts),
      sellersSeen: stats.length,
      sellersListed: ranking.length,
      sellersRanked: ranking.filter((s) => s.rank !== null).length,
      grades,
      payToChanged: stats.filter((s) => s.payToChanged).length,
    },
    // A catalog with no seller on this page has nothing to compare.
    comparisons: comparisons.filter((c) => c.overlap > 0),
    ranking,
  };
}
