/**
 * Who remeasure buys from: resources vet402 already paid for and whose payment settled on chain.
 *   Solana: the census result (rows) and the gate1 result (records), settled = true.
 *   Tempo:  the Tempo ledger, settled = true, with the request (method, body) from the census plan.
 * The payTo is locked to the one that payment went to; the price is locked to what was paid then.
 * New sellers are never added here (that is the census and first-buyer).
 *
 * Pure: no network, no files.
 */
import { OWN_HOSTS, PAYER_ADDRESS, SOLANA_MAINNET, USDC_MINT } from "../constants.js";
import type { PlanEntry as SolanaPlanEntry } from "../pay.js";
import type { PlanEntry as TempoPlanEntry } from "../tempo/census.js";
import { PAYER_ADDRESS as TEMPO_PAYER, normAddr } from "../tempo/constants.js";
import type { RemeasureChain } from "./constants.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const s = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export interface Target {
  chain: RemeasureChain;
  /** Lower-cased host of the resource (the rank's seller key, with `service` on Tempo). */
  host: string;
  service: string | null;
  /** URL as the rank already knows this resource (keeps "payTo changed" detection on the same URL). */
  url: string;
  requestUrl: string;
  /** Recipient of the earlier settled payment. Solana address, or lower-cased 0x address on Tempo. */
  payTo: string;
  /** Atomic price of the earlier settled payment. A live 402 may ask less, never more. */
  amountAtomic: string;
  /** Where the lock came from, e.g. "solana/census-2026-09-28". */
  from: string;
  solana?: { lock: SolanaPlanEntry["lock"] };
  /** censusHttpStatus: the status the settled census purchase of this request got back (the ledger's `httpStatus`). */
  tempo?: { plan: TempoPlanEntry; feeReserveAtomic: string; censusHttpStatus?: number | null };
}

function usdcToAtomic(v: string | null): string | null {
  if (!v || !/^\d+(\.\d{1,6})?$/.test(v)) return null;
  const [w, f = ""] = v.split(".");
  return (BigInt(w!) * 1_000_000n + BigInt(f.padEnd(6, "0"))).toString();
}

function ownHost(host: string): boolean {
  return OWN_HOSTS.some((o) => host === o || host.endsWith(`.${o}`));
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Solana census result (kind census-live): one row per host; settled rows only. */
export function solanaFromCensus(json: unknown, from: string): Target[] {
  if (!isObj(json) || json.kind !== "census-live" || !Array.isArray(json.rows)) throw new Error(`${from}: expected a census-live result with rows`);
  const out: Target[] = [];
  for (const r of json.rows) {
    if (!isObj(r) || r.settled !== true) continue;
    const url = s(r.url);
    const requestUrl = s(r.requestUrl);
    const payTo = s(r.payTo);
    const feePayer = s(r.feePayer);
    const amount = usdcToAtomic(s(r.priceUsdc));
    const host = s(r.host)?.toLowerCase() ?? null;
    if (!url || !requestUrl || !payTo || !feePayer || !amount || !host) throw new Error(`${from}: settled row without url/requestUrl/payTo/feePayer/priceUsdc/host (${String(r.host)})`);
    out.push({
      chain: "solana",
      host,
      service: null,
      url,
      requestUrl,
      payTo,
      amountAtomic: amount,
      from,
      solana: { lock: { payTo, amount, asset: USDC_MINT, network: SOLANA_MAINNET, feePayer } },
    });
  }
  return out;
}

/** Solana gate1 result (kind gate1-live): settled records only. */
export function solanaFromGate1(json: unknown, from: string): Target[] {
  if (!isObj(json) || json.kind !== "gate1-live" || !Array.isArray(json.records)) throw new Error(`${from}: expected a gate1-live result with records`);
  const out: Target[] = [];
  for (const r of json.records) {
    if (!isObj(r) || r.outcome !== "sent" || r.settled !== true) continue;
    const probe = isObj(r.probe) ? r.probe : {};
    const requestUrl = s(r.requestUrl);
    const payTo = s(probe.payTo);
    const feePayer = s(probe.feePayer);
    const amount = s(probe.amount);
    const host = s(r.host)?.toLowerCase() ?? null;
    if (!requestUrl || !payTo || !feePayer || !amount || !/^\d+$/.test(amount) || !host) throw new Error(`${from}: settled record without requestUrl/payTo/feePayer/amount/host (${String(r.host)})`);
    out.push({
      chain: "solana",
      host,
      service: null,
      url: requestUrl,
      requestUrl,
      payTo,
      amountAtomic: amount,
      from,
      solana: { lock: { payTo, amount, asset: USDC_MINT, network: SOLANA_MAINNET, feePayer } },
    });
  }
  return out;
}

/** Tempo ledger (settled entries) joined with the census plan (request method and body, allowlist). */
export function tempoFromLedger(ledger: unknown, plan: unknown, from: string): Target[] {
  if (!isObj(ledger) || !Array.isArray(ledger.entries)) throw new Error(`${from}: expected a Tempo ledger with entries`);
  if (!isObj(plan) || !Array.isArray(plan.plan)) throw new Error(`${from}: expected a Tempo census plan`);
  const planById = new Map<string, TempoPlanEntry>();
  for (const p of plan.plan as TempoPlanEntry[]) planById.set(p.serviceId, p);
  const out: Target[] = [];
  for (const e of ledger.entries) {
    if (!isObj(e) || e.status !== "sent" || e.settled !== true) continue;
    const key = s(e.key);
    const url = s(e.url);
    const recipient = s(e.recipient);
    const amount = s(e.amount);
    const feeReserve = s(e.feeReserve) ?? "0";
    if (!key || !url || !recipient || !amount || !/^\d+$/.test(amount) || !/^\d+$/.test(feeReserve)) throw new Error(`${from}: settled entry without key/url/recipient/amount (${String(e.key)})`);
    const p = planById.get(key);
    if (!p) throw new Error(`${from}: no census plan entry for service "${key}"`);
    if (p.request.url !== url) throw new Error(`${from}: service "${key}" plan URL differs from the ledger URL`);
    const host = hostOf(url);
    if (!host) throw new Error(`${from}: bad URL for service "${key}"`);
    const payTo = normAddr(recipient);
    out.push({
      chain: "tempo",
      host,
      service: key,
      url,
      requestUrl: url,
      payTo,
      amountAtomic: amount,
      from,
      tempo: {
        plan: { ...p, lockedRecipient: payTo, lockedAmount: amount, sponsored: feeReserve === "0" },
        feeReserveAtomic: feeReserve,
        censusHttpStatus: typeof e.httpStatus === "number" ? e.httpStatus : null,
      },
    });
  }
  return out;
}

export interface Selection {
  /** One entry per purchase slot, in buying order: every payTo's slot 0, then every payTo's slot 1 … */
  slots: { target: Target; slot: number }[];
  payTos: number;
  resources: number;
  excluded: { url: string; payTo: string; reason: string }[];
}

/**
 * Remove vet402's own hosts and addresses and duplicates (same payTo and URL), then give each payTo
 * `perPayTo` slots. A payTo with several resources gets them in a fixed order (cheapest first, then URL),
 * so the same resource is measured every day and piles up counted purchases; slot i takes resource
 * i mod n.
 */
export function selectSlots(targets: readonly Target[], perPayTo: number): Selection {
  if (!Number.isInteger(perPayTo) || perPayTo < 1) throw new Error(`perPayTo ${perPayTo}`);
  const own = new Set([PAYER_ADDRESS, normAddr(TEMPO_PAYER)]);
  const excluded: Selection["excluded"] = [];
  const byPayTo = new Map<string, Target[]>();
  const seen = new Set<string>();
  for (const t of targets) {
    if (ownHost(t.host)) {
      excluded.push({ url: t.url, payTo: t.payTo, reason: "own_host" });
      continue;
    }
    if (own.has(t.payTo)) {
      excluded.push({ url: t.url, payTo: t.payTo, reason: "own_payto" });
      continue;
    }
    const k = `${t.chain} ${t.payTo} ${t.requestUrl} ${t.service ?? ""}`;
    if (seen.has(k)) {
      excluded.push({ url: t.url, payTo: t.payTo, reason: "duplicate" });
      continue;
    }
    seen.add(k);
    const g = byPayTo.get(t.payTo) ?? [];
    g.push(t);
    byPayTo.set(t.payTo, g);
  }
  const groups = [...byPayTo.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [, g] of groups) {
    g.sort((a, b) => {
      const d = BigInt(a.amountAtomic) - BigInt(b.amountAtomic);
      if (d !== 0n) return d < 0n ? -1 : 1;
      const ka = `${a.requestUrl} ${a.service ?? ""}`;
      const kb = `${b.requestUrl} ${b.service ?? ""}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }
  const slots: Selection["slots"] = [];
  for (let slot = 0; slot < perPayTo; slot++) {
    for (const [, g] of groups) slots.push({ target: g[slot % g.length]!, slot });
  }
  return { slots, payTos: groups.length, resources: seen.size, excluded };
}
