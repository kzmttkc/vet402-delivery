/**
 * Build the rank report from normalized attempts and catalog snapshots.
 */
import { compareWithCatalog, type CdpHost, type Comparison } from "./compare.js";
import { aggregate, rank, WILSON_Z, type RankedSeller } from "./score.js";
import { CHAINS } from "./normalize.js";
import type { Attempt, Chain, ReasonCategory } from "./types.js";

export interface ChainSummary {
  chain: Chain;
  sources: string[];
  rows: number;
  tried: number;
  settled: number;
  delivered: number;
  notTried: Partial<Record<ReasonCategory, number>>;
  sellersTried: number;
  deliveryCheck: string[];
}

export interface InputRecord {
  label: string;
  location: string;
  sha256: string;
  fetchedAt?: string;
  note?: string;
}

export interface RankReport {
  kind: "vet402-seller-rank";
  date: string;
  generatedAt: string;
  method: {
    score: string;
    z: number;
    counted: string;
    notCounted: string;
    order: string;
    sellerIdentity: string;
    payTo: string;
    money: string;
    deliveryCheck: string;
    limits: string[];
  };
  inputs: InputRecord[];
  chains: ChainSummary[];
  totals: { attempts: number; tried: number; delivered: number; sellersSeen: number; sellersRanked: number; payToChanged: number };
  comparisons: Comparison[];
  catalogsWithoutOrder: { catalog: string; why: string }[];
  ranking: RankedSeller[];
}

export const METHOD: RankReport["method"] = {
  score: "Wilson score lower bound of delivered / tried, 95% (z = 1.96).",
  z: WILSON_Z,
  counted:
    "Tried purchases only: vet402 committed to pay from its own wallet (delivered, not settled, settled then error status, settled then content not as declared, 5xx with settlement unknown).",
  notCounted:
    "Endpoints that were not buyable (no 402, no usable accept, unreachable), vet402's own skips (price cap, input it will not make up, duplicates), and refusals because payTo changed. These are listed per seller but never change the score.",
  order: "Score desc, then delivered rate desc, then number of tries desc, then seller key. Equal score, rate and tries share a rank.",
  sellerIdentity:
    "Seller = hostname. When one host fronts several catalog services that each pay their own recipient (a proxy), each service is its own seller: host#service.",
  payTo:
    "payTo changed = the same chain and URL asked for a different recipient in a later run, or vet402 refused to pay because the recipient differed from the one it had recorded. One recipient per chain is not a change. Shown as a flag; it does not change the score.",
  money:
    "vet402 buys with its own funds and takes no money from sellers: no listing fee, no paid placement, no referral cut. Call counts, payer counts and anything a seller reports about itself are not inputs, so a seller cannot buy a better rank by paying itself (wash trading).",
  deliveryCheck:
    "Each chain runner judged delivery itself and this report does not re-judge. Algorand and the Solana census check the answer's keys against what the seller declared (when it declared any); Tempo, Base and Solana gate1 accept any 2xx after settlement. The stricter check makes Algorand and Solana census failures more likely for the same seller behaviour.",
  limits: [
    "A seller that recognises vet402's payer address could serve vet402 better than others. The payer addresses are public.",
    "One or two tries give a low score by design; the score rises only with more tries.",
    "Sellers with many endpoints (and so many tries) dominate the top because their bound is tight.",
    "'Payment not settled' can have causes on the facilitator's or vet402's side (e.g. a Solana BlockhashNotFound simulation failure), not only the seller's. The raw reason is kept on every row.",
  ],
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
      deliveryCheck: [...new Set(rows.map((r) => r.deliveryCheck))],
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
  const stats = aggregate(opts.attempts, opts.excludeHosts);
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
  const tried = opts.attempts.filter((a) => a.tried && !opts.excludeHosts.includes(a.host));
  return {
    kind: "vet402-seller-rank",
    date: opts.date,
    generatedAt: opts.generatedAt,
    method: METHOD,
    inputs: opts.inputs,
    chains: summarizeChains(opts.attempts),
    totals: {
      attempts: opts.attempts.length,
      tried: tried.length,
      delivered: tried.filter((a) => a.delivered).length,
      sellersSeen: stats.length,
      sellersRanked: ranking.length,
      payToChanged: stats.filter((s) => s.payToChanged).length,
    },
    comparisons,
    catalogsWithoutOrder: [
      { catalog: "PayAI discovery", why: "Items carry no catalog-level call, payer or quality field (checked on 1,000 of 7,040 items on 2026-09-28; such words appear only inside sellers' own output examples), so there is no catalog order to compare." },
      { catalog: "mpp.dev/api/services", why: "A directory of 142 services with no usage, quality or rank field (checked 2026-09-28). Mercator's rank covers the same Tempo services." },
    ],
    ranking,
  };
}
