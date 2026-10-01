/**
 * The JSON body of GET /v1/check, from a lookup: verdict and why first, then the numbers they come from.
 * Kept apart from http.ts so the site build (src/rank/html.ts) can show the same body without importing
 * the HTTP handler.
 */
import type { CheckResult } from "./check.js";
import { PUBLIC_SITE_URL } from "./sources.js";

/** The JSON answer: verdict and why first, then the numbers they come from, then the rest of the facts. */
export function checkBody(r: CheckResult) {
  const b = r.basis;
  const f = b ? r.sellers.find((s) => s.key === b.seller && s.page === b.page) : undefined;
  const last = f?.last ?? null;
  return {
    verdict: r.verdict,
    why: r.why,
    url: r.asked.url,
    chain: r.asked.chain,
    payTo: r.asked.payTo,
    seller: b?.seller ?? null,
    chains: b?.chains ?? [],
    tried: b?.tried ?? 0,
    settled: b?.settled ?? 0,
    counted: b?.counted ?? 0,
    answered: b?.answered ?? 0,
    notCounted: b?.notCounted ?? 0,
    days: b?.days ?? 0,
    /** Purchases whose result is held until the seller is told (Robinhood Chain, Arbitrum): in no other number. */
    held: b?.held ?? 0,
    interval: b ? { lower: b.lower, upper: b.upper } : null,
    newest: last ? { at: last.at, chain: last.chain, result: last.category, httpStatus: last.httpStatus, tx: last.tx, explorer: last.explorer } : null,
    sellerPage: f?.sellerPage ?? null,
    records: {
      published: r.records.published,
      byVerdict: r.records.byVerdict,
      newest: r.records.newest.map((x) => ({ id: x.id, day: x.day, verdict: x.verdict, json: x.json, page: x.page, anchorTx: x.anchor?.status === "anchored" ? x.anchor.tx : null })),
    },
    payToRecorded: r.payTo ? r.payTo.sameAsRecorded : null,
    asOf: { rankDate: r.asOf.rankDate, rankGeneratedAt: r.asOf.rankGeneratedAt, recordsPublished: r.asOf.recordsPublished },
    summary: r.summary,
    notes: r.notes,
    rule:
      "pay: the 95% interval of answered / counted is at or above 0.5 (grade C's line), on 2+ days. " +
      "avoid: its upper bound is below 0.5 (grade D's line), on 2+ days. Otherwise unknown. Counted = paid calls: purchases whose payment settled, " +
      "answered or failed on the seller's side; a seller's 5xx with no settled payment, failures on vet402's or the facilitator's side, " +
      "and failures of unknown cause are left out. No settled payment: unknown.",
    method: `${PUBLIC_SITE_URL}/method.html`,
  };
}

