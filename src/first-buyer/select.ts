/**
 * Who the first-buyer mode may buy from. Pure: nothing here fetches, signs or pays.
 *
 * Steps (each one names why a seller dropped out):
 *   1. hosts: the census union (PayAI + CDP Bazaar + Pay.sh, one cheapest GET per host, 0.10 cap,
 *      own hosts removed, example input filled), minus tunnel hosts, minus hosts not new since --since.
 *   2. payTo: after the unpaid 402 gave each host a locked payTo, one target per payTo (cheapest),
 *      minus vet402's own payTos, opt-outs, and payTos the ledger does not allow.
 *   3. chain: minus payTos that ever received USDC, vet402 included (src/first-buyer/receipts.ts chainFence).
 *   4. caps: in price order, what fits in the run and month caps.
 */
import { OWN_HOSTS, SOLANA_MAINNET } from "../constants.js";
import { hostOf, type Listing } from "../discovery.js";
import { normalizeAccept } from "../guard.js";
import type { CensusTarget, HostPlan } from "../census.js";
import type { Eligibility } from "./ledger.js";
import { TEMP_HOST_SUFFIXES } from "./constants.js";

export interface Excluded {
  host: string;
  payTo: string | null;
  reason: string;
  detail: string;
}

export function isTempHost(host: string): boolean {
  const h = host.toLowerCase();
  return TEMP_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

function isOwnHost(h: string): boolean {
  return OWN_HOSTS.some((o) => h === o || h.endsWith(`.${o}`));
}

/** payTos that vet402's own listings declare (PayAI / CDP). These are never bought. */
export function ownPayTosFromListings(listings: Listing[]): string[] {
  const out = new Set<string>();
  for (const l of listings) {
    if (!isOwnHost(hostOf(String(l.resource ?? "")))) continue;
    for (const a of l.accepts ?? []) {
      const n = normalizeAccept(a);
      if (n.network === SOLANA_MAINNET && n.payTo) out.add(n.payTo);
    }
  }
  return [...out].sort();
}

/**
 * Hosts vet402 has seen in earlier runs (results/first-buyer-seen.json). Once a run older than
 * --since exists, "new since" means "not seen before --since". Before that, the catalogs'
 * lastUpdated is the only date there is, and it is a last-update time, not a first-listing time.
 */
export interface SeenSnapshot {
  runs: string[]; // YYYY-MM-DD
  firstSeen: Record<string, string>; // host -> YYYY-MM-DD
}

export function emptySeen(): SeenSnapshot {
  return { runs: [], firstSeen: {} };
}

export function recordSeen(s: SeenSnapshot, hosts: Iterable<string>, day: string): SeenSnapshot {
  const firstSeen = { ...s.firstSeen };
  for (const h of hosts) if (!firstSeen[h] || firstSeen[h]! > day) firstSeen[h] = day;
  const runs = [...new Set([...s.runs, day])].sort();
  return { runs, firstSeen };
}

export type NewnessBasis = "seen_snapshot" | "catalog_lastUpdated";

/** Which rule decides "new since" for this run. */
export function newnessBasis(seen: SeenSnapshot, since: string): NewnessBasis {
  return seen.runs.some((d) => d < since) ? "seen_snapshot" : "catalog_lastUpdated";
}

/** The latest catalog date on any listing of this host (PayAI / CDP lastUpdated), or null. */
export function latestListingDate(hp: HostPlan): string | null {
  let best: string | null = null;
  for (const c of [...hp.candidates, ...hp.placeholder]) {
    const d = c.lastUpdated;
    if (typeof d === "string" && !Number.isNaN(Date.parse(d)) && (best === null || d > best)) best = d;
  }
  return best;
}

export function preselectHosts(
  hosts: HostPlan[],
  opts: { since: string; seen?: SeenSnapshot },
): { keep: HostPlan[]; excluded: Excluded[]; basis: NewnessBasis } {
  const seen = opts.seen ?? emptySeen();
  const basis = newnessBasis(seen, opts.since);
  const keep: HostPlan[] = [];
  const excluded: Excluded[] = [];
  const x = (hp: HostPlan, reason: string, detail: string) => excluded.push({ host: hp.host, payTo: null, reason, detail });
  for (const hp of hosts) {
    if (isTempHost(hp.host)) {
      x(hp, "temporary_host", "tunnel or preview host");
      continue;
    }
    if (basis === "seen_snapshot") {
      const first = seen.firstSeen[hp.host];
      if (first !== undefined && first < opts.since) {
        x(hp, "not_new_since", `first seen ${first}`);
        continue;
      }
    } else {
      const d = latestListingDate(hp);
      if (d === null) {
        x(hp, "no_listing_date", "no lastUpdated in any catalog (Pay.sh only) and no earlier run to compare with");
        continue;
      }
      if (d.slice(0, 10) < opts.since) {
        x(hp, "not_new_since", `last updated ${d.slice(0, 10)}`);
        continue;
      }
    }
    if (hp.candidates.length === 0) {
      x(hp, "placeholder_unfillable", "the listing declares inputs without a usable example; nothing is sent");
      continue;
    }
    keep.push(hp);
  }
  return { keep, excluded, basis };
}

/**
 * One target per payTo (cheapest first), minus own payTos, opt-outs and what the ledger refuses.
 * `targets` are hosts whose live unpaid 402 passed every accept check (lock.payTo from it).
 */
export function choosePerPayTo<T extends Pick<CensusTarget, "host" | "lock">>(
  targets: T[],
  ctx: { own: ReadonlySet<string>; optOut: ReadonlySet<string>; ledger: (payTo: string) => Eligibility },
): { kept: T[]; excluded: Excluded[] } {
  const sorted = [...targets].sort((a, b) => {
    const x = BigInt(a.lock.amount);
    const y = BigInt(b.lock.amount);
    return x < y ? -1 : x > y ? 1 : a.host.localeCompare(b.host);
  });
  const kept: T[] = [];
  const excluded: Excluded[] = [];
  const seen = new Set<string>();
  for (const t of sorted) {
    const p = t.lock.payTo;
    const x = (reason: string, detail: string) => excluded.push({ host: t.host, payTo: p, reason, detail });
    if (seen.has(p)) {
      x("same_payto", "another host with the same payTo is already a target");
      continue;
    }
    seen.add(p);
    if (ctx.own.has(p)) {
      x("own_payto", "payTo is a vet402 address");
      continue;
    }
    if (ctx.optOut.has(p)) {
      x("opted_out", "the seller opted out");
      continue;
    }
    const e = ctx.ledger(p);
    if (!e.ok) {
      x(e.reason, e.detail);
      continue;
    }
    kept.push(t);
  }
  return { kept, excluded };
}

/** Read the opt-out list: a JSON array of payTo strings, or { payTo: [...] }. */
export function parseOptOut(text: string): string[] {
  const j = JSON.parse(text) as unknown;
  const arr = Array.isArray(j) ? j : Array.isArray((j as { payTo?: unknown })?.payTo) ? (j as { payTo: unknown[] }).payTo : null;
  if (!arr || !arr.every((x) => typeof x === "string")) throw new Error("opt-out file must be a JSON array of payTo strings");
  return arr as string[];
}

export function tally(ex: Excluded[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of ex) out[e.reason] = (out[e.reason] ?? 0) + 1;
  return out;
}
