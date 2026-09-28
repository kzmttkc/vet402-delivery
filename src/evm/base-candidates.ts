/**
 * Candidates for Base purchases: ERC-8004 agents on Base whose on-chain agentWallet is the payTo of a
 * Bazaar listing that vet402 has already bought and got a delivery from. Read-only.
 */
import { getAddress, isAddress, isAddressEqual, type Address } from "viem";
import { MAX_PER_PURCHASE_ATOMIC } from "../constants.js";
import { decide, type Purchase } from "../check/vet402-check.js";
import type { Listing } from "../discovery.js";
import { BASE_USDC } from "./erc8004.js";
import { BASE_CAIP2, type BuyEntry } from "./base-buy.js";

/**
 * Agent ids whose agentWallet or owner matched a Bazaar Base payTo on 8004scan
 * (8 searches on 2026-09-28, https://8004scan.io/api/v1/public/agents/search?chainId=8453).
 * A hint only: every id is re-read on chain and kept only if getAgentWallet(id) == payTo.
 * Agent402 (94639) first, as instructed. 46603, 46604 ("x402_deployer") and 47167 ("agentutility_ai") share one
 * agentWallet; 47167 comes first because its name matches the seller host, and the others are dropped as duplicates.
 */
export const DEFAULT_AGENT_IDS = [
  "94639", "95791", "57355", "47167", "46603", "46604", "55673", "86957", "17449", "59998",
  "53923", "45948", "59265", "38351", "84609", "84581", "30271", "1380", "55030",
];

export const VET402_EXPORT = "https://vet402.com/api/v1/observatory/export.csv?days=30";

export interface ExportRow {
  attempted_at: string;
  resource_key: string;
  network: string;
  status: string;
  amount_units: string;
  tx_hash: string;
  http_status_paid: string;
  l2_schema: string;
  request_body: string;
  request_query: string;
}

/** RFC 4180 CSV (quoted fields, doubled quotes). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        f += '"';
        i++;
      } else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(f);
      f = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(f);
      rows.push(row);
      row = [];
      f = "";
    } else f += c;
  }
  if (f.length || row.length) {
    row.push(f);
    rows.push(row);
  }
  const [head, ...body] = rows.filter((r) => r.length > 1 || r[0] !== "");
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

/** "https://host/path?x" -> "host/path" (vet402's resource_key form). */
export function resourceKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`.replace(/\/$/, "");
  } catch {
    return url;
  }
}

export interface AgentInfo {
  agentId: string;
  owner: Address | null;
  agentWallet: Address | null;
}

export interface Candidate {
  agentId: string;
  agentWallet: Address | null;
  owner: Address | null;
  /** Bazaar Base listings to that wallet. */
  listings: number;
  /** Of those, ones vet402 has a delivery from (latest decisive purchase delivered, on Base). */
  deliveredListings: number;
  chosen: {
    resource: string;
    method: "GET" | "POST";
    priceAtomic: string;
    payTo: Address;
    payToIsAgentWallet: boolean;
    vet402LastDelivery: { at: string; tx: string };
    simpleRequest: boolean;
    entry: BuyEntry;
  } | null;
  excluded?: string;
}

function baseAccepts(l: Listing): { payTo: string; amount: string; scheme: string; asset: string }[] {
  return (l.accepts ?? [])
    .map((a) => ({ payTo: String(a.payTo ?? ""), amount: String(a.amount ?? a.maxAmountRequired ?? ""), scheme: String(a.scheme ?? ""), asset: String(a.asset ?? ""), network: String(a.network ?? "") }))
    .filter((a) => a.network === BASE_CAIP2 || a.network === "base");
}

const eq = (a: string, b: string) => isAddress(a) && isAddress(b) && isAddressEqual(a, b);

/** Pure: pick at most one resource per agent. */
export function planCandidates(agents: AgentInfo[], catalog: Listing[], rows: ExportRow[]): Candidate[] {
  const byKey = new Map<string, ExportRow[]>();
  for (const r of rows) {
    if (r.network !== BASE_CAIP2) continue;
    const list = byKey.get(r.resource_key) ?? [];
    list.push(r);
    byKey.set(r.resource_key, list);
  }
  const walletTaken = new Map<string, string>();
  return agents.map((ag): Candidate => {
    const base: Candidate = { agentId: ag.agentId, agentWallet: ag.agentWallet, owner: ag.owner, listings: 0, deliveredListings: 0, chosen: null };
    if (!ag.owner) return { ...base, excluded: "agent not registered on Base" };
    if (!ag.agentWallet || /^0x0{40}$/i.test(ag.agentWallet)) return { ...base, excluded: "agentWallet not set (owner match is not enough)" };
    const wallet = ag.agentWallet;
    const prior = walletTaken.get(wallet.toLowerCase());
    if (prior) return { ...base, excluded: `same agentWallet as agent ${prior} (one purchase per seller)` };
    walletTaken.set(wallet.toLowerCase(), ag.agentId);
    const mine = catalog.filter((l) => baseAccepts(l).some((a) => eq(a.payTo, wallet)));
    base.listings = mine.length;
    const options: NonNullable<Candidate["chosen"]>[] = [];
    for (const l of mine) {
      const acc = baseAccepts(l).find((a) => a.scheme === "exact" && eq(a.payTo, wallet) && eq(a.asset, BASE_USDC));
      if (!acc || !/^\d+$/.test(acc.amount)) continue;
      const hist = (byKey.get(resourceKey(l.resource)) ?? []).slice().sort((a, b) => b.attempted_at.localeCompare(a.attempted_at));
      const purchases: Purchase[] = hist.map((h) => ({
        attemptedAt: h.attempted_at,
        status: h.status,
        amountUnits: h.amount_units || null,
        txHash: h.tx_hash || null,
        httpStatusPaid: /^\d+$/.test(h.http_status_paid) ? Number(h.http_status_paid) : null,
        l2Schema: h.l2_schema || null,
        network: h.network,
      }));
      const d = decide(purchases);
      if (d.verdict !== "delivered" || !d.lastDelivery?.txHash) continue;
      base.deliveredListings++;
      if (BigInt(acc.amount) > MAX_PER_PURCHASE_ATOMIC) continue;
      const lastRow = hist.find((h) => h.tx_hash === d.lastDelivery!.txHash)!;
      const input = (l.extensions?.bazaar?.info?.input ?? {}) as { method?: string; queryParams?: Record<string, unknown>; body?: unknown };
      const method = String(input.method ?? l.method ?? "GET").toUpperCase() === "POST" ? "POST" : "GET";
      const query = input.queryParams && typeof input.queryParams === "object"
        ? Object.fromEntries(Object.entries(input.queryParams).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]))
        : null;
      const simpleRequest = ["none", "empty", ""].includes(lastRow.request_body) && ["empty", ""].includes(lastRow.request_query) && method === "GET";
      options.push({
        resource: l.resource,
        method,
        priceAtomic: acc.amount,
        payTo: getAddress(acc.payTo),
        payToIsAgentWallet: true,
        vet402LastDelivery: { at: d.lastDelivery.attemptedAt, tx: d.lastDelivery.txHash },
        simpleRequest,
        entry: {
          agentId: ag.agentId,
          resource: l.resource,
          method,
          query: lastRow.request_query === "declared" ? query : null,
          body: lastRow.request_body === "declared" ? (input.body ?? {}) : null,
          agentWallet: wallet,
          lock: { payTo: getAddress(acc.payTo), amount: acc.amount },
        },
      });
    }
    options.sort((a, b) => Number(b.simpleRequest) - Number(a.simpleRequest) || Number(BigInt(a.priceAtomic) - BigInt(b.priceAtomic)) || b.vet402LastDelivery.at.localeCompare(a.vet402LastDelivery.at));
    const chosen = options[0] ?? null;
    if (!chosen) {
      const why = base.listings === 0 ? "no Bazaar Base listing pays its agentWallet" : base.deliveredListings ? "every delivered listing is over 0.10 USDC" : "vet402 has no delivery from any of its listings";
      return { ...base, excluded: why };
    }
    return { ...base, chosen };
  });
}
