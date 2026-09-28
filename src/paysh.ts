/**
 * Pay.sh catalog (solana-foundation/pay): `https://catalog.pay.sh/v1/skills.json` lists providers;
 * each provider's endpoints are in `{base_url}/providers/{fqn}.json` (the same files the `pay`
 * CLI fetches, see rust/crates/core/src/skills/mod.rs). Read-only.
 *
 * Pay.sh endpoints carry a method, a path, a USD price and the protocol ("x402" or "mpp").
 * They carry no payTo, no output schema and no example input: the payTo lock for a Pay.sh-only
 * listing comes from the seller's own unpaid 402, and delivery is judged without a declaration.
 */
import { PAYSH_INDEX } from "./constants.js";

export interface PayshEndpoint {
  method?: string;
  path?: string;
  description?: string;
  resource?: string;
  pricing?: { mode?: string; dimensions?: { tiers?: { price_usd?: number }[] }[] } | null;
  protocol?: string[];
}

export interface PayshProvider {
  fqn: string;
  title?: string;
  description?: string;
  service_url: string;
  sha?: string;
  endpoints?: PayshEndpoint[];
}

export interface PayshListing {
  fqn: string;
  resource: string;
  method: string;
  description?: string;
  protocol: string[];
  /** Flat single-tier price in atomic USDC, or null when the listing has no single price. */
  priceAtomic: bigint | null;
}

/** Join service_url and an endpoint path the way the pay CLI does (one slash between). */
export function endpointUrl(serviceUrl: string, path: string): string {
  return `${serviceUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** A flat, single-tier USD price as atomic USDC (6 decimals); null otherwise. */
export function flatPriceAtomic(p: PayshEndpoint["pricing"]): bigint | null {
  if (!p || (p.mode !== undefined && p.mode !== "flat")) return null;
  const dims = p.dimensions ?? [];
  if (dims.length !== 1) return null;
  const tiers = dims[0]!.tiers ?? [];
  if (tiers.length !== 1) return null;
  const usd = tiers[0]!.price_usd;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return null;
  return BigInt(Math.round(usd * 1_000_000));
}

export function payshListings(providers: PayshProvider[]): PayshListing[] {
  const out: PayshListing[] = [];
  for (const p of providers) {
    for (const e of p.endpoints ?? []) {
      if (!e.path || !p.service_url) continue;
      out.push({
        fqn: p.fqn,
        resource: endpointUrl(p.service_url, e.path),
        method: String(e.method ?? "GET").toUpperCase(),
        ...(e.description ? { description: e.description } : p.description ? { description: p.description } : {}),
        protocol: Array.isArray(e.protocol) ? e.protocol.map(String) : [],
        priceAtomic: flatPriceAtomic(e.pricing),
      });
    }
  }
  return out;
}

export async function fetchPaysh(
  opts: { fetchImpl?: typeof fetch; index?: string; concurrency?: number } = {},
): Promise<{ providers: PayshProvider[]; providerCount: number; failed: string[]; generatedAt: string | null }> {
  const f = opts.fetchImpl ?? fetch;
  const res = await f(opts.index ?? PAYSH_INDEX, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`pay.sh index: HTTP ${res.status}`);
  const idx = (await res.json()) as { base_url?: string; generated_at?: string; providers?: PayshProvider[] };
  const base = String(idx.base_url ?? "").replace(/\/+$/, "");
  const list = Array.isArray(idx.providers) ? idx.providers : [];
  if (!base) throw new Error("pay.sh index has no base_url");
  const providers: PayshProvider[] = [];
  const failed: string[] = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: opts.concurrency ?? 6 }, async () => {
      while (i < list.length) {
        const p = list[i++]!;
        try {
          const r = await f(`${base}/providers/${p.fqn}.json`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const d = (await r.json()) as PayshProvider;
          providers.push({ ...p, ...d, service_url: d.service_url ?? p.service_url });
        } catch {
          failed.push(p.fqn);
        }
      }
    }),
  );
  providers.sort((a, b) => a.fqn.localeCompare(b.fqn));
  return { providers, providerCount: list.length, failed, generatedAt: idx.generated_at ?? null };
}
