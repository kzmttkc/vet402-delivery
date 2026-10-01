/**
 * Who each EVM lane buys from. Read-only: catalogs and unpaid 402s, nothing signed or paid.
 *
 *   robinhood     every payTo that a catalog lists with an exact USDG accept on Robinhood Chain, once, at
 *                 the cheapest listing whose live 402 still offers it; plus the stock-price check entries.
 *   arbitrum      every payTo listed with exact USDC on Arbitrum One AND the same payTo on Base in the same
 *                 listing, once; the Base side of the same listing goes to the base-compare lane.
 */
import { getAddress, type Address } from "viem";
import type { Listing } from "../discovery.js";
import { normalizeAccept } from "../guard.js";
import { STOCK_REFS } from "../robinhood/stock-check.js";
import { EVM_CHAINS, chainByCaip2, type EvmChainSpec } from "./chains.js";
import { checkChainAccept, eqAddr, payToOn, type ChainBuyEntry, type EvmAccept } from "./evm-buy.js";
import { repairLaneRequest, type LastPaid } from "./lane-input.js";

export const DEXTER_DISCOVERY = "https://x402.dexter.cash/discovery/resources";

export interface ListingOption {
  resource: string;
  method: "GET" | "POST";
  query: Record<string, string> | null;
  body: unknown;
  payTo: Address;
  amount: string;
  /** Needs no input beyond the seller's own declared example. */
  simple: boolean;
  /** Parameters vet402 filled (src/evm/lane-input.ts); absent when nothing was filled. */
  filled?: { param: string; rule: string }[];
  /** The catalog's URL of this listing (`resource` is the filled request's URL). */
  listingResource: string;
  /** Parameter names the listing declares. */
  declaredParams: string[];
  /** The UTC date used to fill the request, and the parameters vet402 filled with it. */
  inputDate: string;
  datedParams: string[];
}

export interface PayToGroup {
  payTo: Address;
  listings: number;
  hosts: string[];
  options: ListingOption[];
  /** Listings not bought because vet402 cannot fill their input (src/evm/lane-input.ts). */
  inputSkipped?: { resource: string; why: string }[];
}

function chainAccepts(l: Listing, spec: EvmChainSpec): EvmAccept[] {
  return (l.accepts ?? []).map((raw) => {
    const a = normalizeAccept(raw);
    const c = chainByCaip2(a.network);
    return c ? { ...a, network: c.caip2 } : a;
  }).filter((a) => a.network === spec.caip2 && a.scheme === "exact" && eqAddr(a.asset, spec.asset));
}

function requestOf(l: Listing): { method: "GET" | "POST"; query: Record<string, string> | null; body: unknown; simple: boolean } {
  const input = (l.extensions?.bazaar?.info?.input ?? {}) as { method?: string; queryParams?: Record<string, unknown>; body?: unknown };
  const method = String(input.method ?? l.method ?? "GET").toUpperCase() === "POST" ? "POST" : "GET";
  const query =
    input.queryParams && typeof input.queryParams === "object" && Object.keys(input.queryParams).length
      ? Object.fromEntries(Object.entries(input.queryParams).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]))
      : null;
  return { method, query, body: method === "POST" ? (input.body ?? {}) : null, simple: method === "GET" };
}

const hostOf = (u: string): string => {
  try {
    return new URL(u).host.toLowerCase();
  } catch {
    return "";
  }
};

/** Pure. One group per payTo on `spec`; with `sameOn`, only listings whose `sameOn` accept has the same payTo. */
export function groupByPayTo(
  catalog: Listing[],
  spec: EvmChainSpec,
  opts: { sameOn?: EvmChainSpec; maxPerAtomic: bigint; ownHosts?: string[]; today?: string; lastPaid?: ReadonlyMap<string, LastPaid>; nowMs?: number },
): PayToGroup[] {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const groups = new Map<string, PayToGroup>();
  for (const l of catalog) {
    if (!l.resource || seen.has(l.resource)) continue;
    seen.add(l.resource);
    const host = hostOf(l.resource);
    if (!host || (opts.ownHosts ?? []).some((o) => host === o || host.endsWith(`.${o}`))) continue;
    for (const a of chainAccepts(l, spec)) {
      if (!/^\d+$/.test(a.amount) || !a.payTo) continue;
      if (opts.sameOn && !chainAccepts(l, opts.sameOn).some((b) => eqAddr(b.payTo, a.payTo))) continue;
      let payTo: Address;
      try {
        payTo = getAddress(a.payTo);
      } catch {
        continue;
      }
      const g = groups.get(payTo.toLowerCase()) ?? { payTo, listings: 0, hosts: [], options: [] };
      g.listings++;
      if (!g.hosts.includes(host)) g.hosts.push(host);
      if (BigInt(a.amount) > 0n && BigInt(a.amount) <= opts.maxPerAtomic) {
        // The request is filled the way the Solana and Tempo purchases are; one that cannot be is not bought.
        const req = requestOf(l);
        const fix = repairLaneRequest(l, { resource: l.resource, method: req.method, query: req.query, body: req.body }, today, opts.lastPaid?.get(l.resource) ?? null, opts.nowMs ?? Date.now());
        if (!fix.ok) (g.inputSkipped ??= []).push({ resource: l.resource, why: `input_unfillable: ${fix.reason.replace(/^input_unfillable:/, "")}${fix.param ? ` (${fix.param})` : ""}` });
        else g.options.push({ payTo, amount: a.amount, ...fix.request, simple: req.simple, listingResource: l.resource, inputDate: today, datedParams: fix.datedParams, declaredParams: fix.declaredParams, ...(fix.changed ? { filled: fix.filled } : {}) });
      }
      groups.set(payTo.toLowerCase(), g);
    }
  }
  for (const g of groups.values()) {
    g.hosts.sort();
    // Simple GET first, then cheapest, then by URL so the plan does not depend on catalog order.
    g.options.sort((a, b) => Number(b.simple) - Number(a.simple) || Number(BigInt(a.amount) - BigInt(b.amount)) || a.resource.localeCompare(b.resource));
  }
  return [...groups.values()].sort((a, b) => a.payTo.toLowerCase().localeCompare(b.payTo.toLowerCase()));
}

export type Probe = (o: Pick<ListingOption, "resource" | "query" | "method" | "body">) => Promise<{ status: number | null; accepts: EvmAccept[]; raw: string; error?: string }>;

export interface LiveChoice {
  payTo: Address;
  listings: number;
  hosts: string[];
  /** The listing that will be bought, confirmed against its live 402; null when none still offers it. */
  chosen: (ListingOption & { liveAmount: string; raw402: string; sameOnPayTo: string | null }) | null;
  tried: { resource: string; status: number | null; why: string }[];
}

/** Probe up to `maxTries` listings per payTo until one's live 402 passes every accept check (dry). */
export async function confirmLive(
  groups: PayToGroup[],
  spec: EvmChainSpec,
  probe: Probe,
  opts: { payer: string; maxPerAtomic: bigint; sameOn?: EvmChainSpec; maxTries?: number; concurrency?: number },
): Promise<LiveChoice[]> {
  const out: LiveChoice[] = new Array(groups.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= groups.length) return;
      const g = groups[i]!;
      const c: LiveChoice = { payTo: g.payTo, listings: g.listings, hosts: g.hosts, chosen: null, tried: (g.inputSkipped ?? []).map((x) => ({ resource: x.resource, status: null, why: x.why })) };
      for (const o of g.options.slice(0, opts.maxTries ?? 3)) {
        const p = await probe(o);
        if (p.status !== 402) {
          c.tried.push({ resource: o.resource, status: p.status, why: p.error ?? `HTTP ${p.status ?? "none"}` });
          continue;
        }
        const a = p.accepts.find((x) => x.network === spec.caip2 && x.scheme === "exact" && eqAddr(x.payTo, g.payTo)) ?? p.accepts.find((x) => x.network === spec.caip2) ?? null;
        const sameOnPayTo = opts.sameOn ? payToOn(p.accepts, opts.sameOn.caip2, g.payTo) : null;
        const r = checkChainAccept(spec, a, {
          payer: opts.payer,
          lockedPayTo: g.payTo,
          lockedAmount: o.amount,
          maxPerAtomic: opts.maxPerAtomic,
          ...(opts.sameOn ? { crossChainPayTo: { network: opts.sameOn.caip2, payTo: sameOnPayTo } } : {}),
        });
        if (r) {
          c.tried.push({ resource: o.resource, status: 402, why: `${r.refused}: ${r.detail}` });
          continue;
        }
        c.chosen = { ...o, liveAmount: a!.amount, raw402: p.raw, sameOnPayTo };
        break;
      }
      out[i] = c;
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 6 }, worker));
  return out;
}

/** One lane entry per confirmed payTo. The lock takes the live price when it is lower, never higher. */
export function laneEntries(choices: LiveChoice[], spec: EvmChainSpec, sameOn?: EvmChainSpec): ChainBuyEntry[] {
  return choices.flatMap((c) => {
    if (!c.chosen) return [];
    const amount = BigInt(c.chosen.liveAmount) < BigInt(c.chosen.amount) ? c.chosen.liveAmount : c.chosen.amount;
    return [
      {
        agentId: `payto:${c.payTo}`,
        resource: c.chosen.resource,
        method: c.chosen.method,
        query: c.chosen.query,
        body: c.chosen.body,
        listingResource: c.chosen.listingResource,
        inputDate: c.chosen.inputDate,
        ...(c.chosen.datedParams.length ? { datedParams: c.chosen.datedParams } : {}),
        ...(c.chosen.declaredParams.length ? { declaredParams: c.chosen.declaredParams } : {}),
        ...(sameOn ? { sameSellerOn: sameOn.caip2 } : {}),
        lock: { payTo: c.payTo, amount },
      },
    ];
  });
}

/** The same listings on the other chain (base-compare lane): same resource, the other chain's accept, same payTo required. */
export function mirrorEntries(entries: ChainBuyEntry[], choices: LiveChoice[], mirror: EvmChainSpec, origin: EvmChainSpec): ChainBuyEntry[] {
  return entries.flatMap((e) => {
    const c = choices.find((x) => x.chosen?.resource === e.resource);
    if (!c?.chosen?.sameOnPayTo) return [];
    return [{ ...e, sameSellerOn: origin.caip2, lock: { payTo: c.chosen.sameOnPayTo, amount: e.lock.amount } }];
  });
}

/** The stock-price entries: `equity` endpoint of a seller that sells share prices, one per ticker. */
export const STOCK_SELLER = { resource: "https://equity.lonestaroracle.xyz/equity", queryKey: "ticker" } as const;

export function stockEntries(payTo: Address, amount: string, tickers: readonly string[] = STOCK_REFS.map((r) => r.ticker)): ChainBuyEntry[] {
  return tickers.map((t) => ({
    agentId: `stock:${t}`,
    resource: STOCK_SELLER.resource,
    method: "GET" as const,
    query: { [STOCK_SELLER.queryKey]: t },
    body: null,
    ledgerKey: `robinhood-stock:${new URL(STOCK_SELLER.resource).host}:${t}`,
    lock: { payTo, amount },
  }));
}

export { EVM_CHAINS };
