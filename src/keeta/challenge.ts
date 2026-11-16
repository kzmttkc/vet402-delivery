/**
 * Keeta 402 parsing and accept checks. Pure, no signer.
 */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { toCaip2 } from "../constants.js";
export type KeetaRefusal = { refused: string; detail: string };
import {
  KEETA_CAIP2,
  KEETA_MAX_PER_PURCHASE_ATOMIC,
  KEETA_TESTNET_CAIP2,
  KEETA_USDC,
  type KeetaSeller,
} from "./constants.js";

const parser = new x402HTTPClient(new x402Client());

export interface KeetaAccept {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

export function normalizeKeetaAccept(raw: Record<string, unknown>): KeetaAccept {
  const extra = raw.extra && typeof raw.extra === "object" ? (raw.extra as Record<string, unknown>) : undefined;
  return {
    scheme: String(raw.scheme ?? ""),
    network: toCaip2(raw.network),
    amount: String(raw.amount ?? raw.maxAmountRequired ?? ""),
    asset: String(raw.asset ?? ""),
    payTo: String(raw.payTo ?? ""),
    ...(typeof raw.maxTimeoutSeconds === "number" ? { maxTimeoutSeconds: raw.maxTimeoutSeconds } : {}),
    ...(extra ? { extra } : {}),
  };
}

export function parseKeeta402(getHeader: (name: string) => string | null, body: unknown): PaymentRequired {
  const get = (n: string) => getHeader(n) ?? getHeader(n.toLowerCase()) ?? getHeader(n.toUpperCase());
  try {
    return parser.getPaymentRequiredResponse(get, body);
  } catch (e) {
    if (body && typeof body === "object" && "x402Version" in body && (body as { x402Version: number }).x402Version === 2) {
      return body as PaymentRequired;
    }
    throw e;
  }
}

function checkKeetaAccept(a: KeetaAccept, lock: { payTo: string; maxAtomic: bigint }): KeetaRefusal | null {
  if (a.network === KEETA_TESTNET_CAIP2) return { refused: "testnet_chain", detail: `network ${a.network}` };
  if (a.network !== KEETA_CAIP2) return { refused: "network_mismatch", detail: `network ${a.network}` };
  if (a.scheme !== "exact") return { refused: "scheme_mismatch", detail: `scheme ${a.scheme} (only exact)` };
  if (a.asset !== KEETA_USDC) return { refused: "mint_mismatch", detail: `asset ${a.asset} is not Keeta USDC ${KEETA_USDC}` };
  if (!/^[1-9]\d{0,17}$/.test(a.amount)) return { refused: "bad_amount", detail: `amount ${JSON.stringify(a.amount)}` };
  const amount = BigInt(a.amount);
  if (amount > lock.maxAtomic) return { refused: "price_over_cap", detail: `amount ${amount} > cap ${lock.maxAtomic}` };
  if (a.payTo !== lock.payTo) return { refused: "payto_mismatch", detail: `payTo ${a.payTo} != recorded ${lock.payTo}` };
  return null;
}

/**
 * From live accepts, the one vet402 would pay on Keeta mainnet for the locked payTo.
 * When no matching accept exists, the first Keeta-shaped accept is checked so the refusal names why.
 */
export function pickKeetaAccept(
  accepts: KeetaAccept[],
  lock: { payTo: string; maxAtomic: bigint },
): { accept: KeetaAccept } | KeetaRefusal {
  if (accepts.some((a) => a.network === KEETA_TESTNET_CAIP2) && !accepts.some((a) => a.network === KEETA_CAIP2)) {
    return { refused: "testnet_chain", detail: "only testnet Keeta accept" };
  }
  const main = accepts.filter((a) => a.network === KEETA_CAIP2);
  if (main.length === 0) {
    const anyKeeta = accepts.filter((a) => String(a.network ?? "").startsWith("keeta:"));
    if (anyKeeta.length === 0) return { refused: "no_keeta_accept", detail: "the 402 has no Keeta mainnet accept" };
    const r0 = checkKeetaAccept(normalizeKeetaAccept(anyKeeta[0] as unknown as Record<string, unknown>), lock);
    return r0 ?? { refused: "no_keeta_accept", detail: "no Keeta mainnet accept" };
  }
  const good = main.filter((a) => a.scheme === "exact" && a.asset === KEETA_USDC && a.payTo === lock.payTo);
  const a = good[0] ?? main[0]!;
  const r = checkKeetaAccept(a, lock);
  if (r) return r;
  if (typeof a.extra?.external === "string") {
    return { accept: { ...a, extra: { ...a.extra, external: a.extra.external } } };
  }
  return { accept: a };
}

export interface CatalogResource {
  url: string;
  method?: string;
  accepts?: unknown[];
}

export interface KeetaCatalog {
  resources?: CatalogResource[];
}

export interface KeetaCatalogCandidate {
  url: string;
  payTo: string;
  accept: KeetaAccept;
}

export function keetaCandidatesFromCatalog(catalog: KeetaCatalog, seller: KeetaSeller): KeetaCatalogCandidate[] {
  const out: KeetaCatalogCandidate[] = [];
  const lock = { payTo: seller.payTo, maxAtomic: KEETA_MAX_PER_PURCHASE_ATOMIC };
  for (const r of catalog.resources ?? []) {
    if ((r.method ?? "GET").toUpperCase() !== "GET") continue;
    let host: string;
    try {
      host = new URL(r.url).host;
    } catch {
      continue;
    }
    if (host !== seller.host) continue;
    const accepts = (r.accepts ?? []).map((x) => normalizeKeetaAccept(x as Record<string, unknown>));
    if (accepts.length === 0) continue;
    const picked = pickKeetaAccept(accepts, lock);
    if ("refused" in picked) continue;
    out.push({ url: r.url, payTo: seller.payTo, accept: picked.accept });
  }
  return out;
}

export function paymentRequiredFromCatalogAccept(accept: KeetaAccept): PaymentRequired {
  return { x402Version: 2, accepts: [accept] } as PaymentRequired;
}

export function catalogAcceptForUrl(catalog: KeetaCatalog, seller: KeetaSeller, url: string): KeetaAccept | null {
  const norm = url.replace(/\/$/, "");
  for (const r of catalog.resources ?? []) {
    const ru = r.url.replace(/\/$/, "");
    if (ru !== norm && ru !== url) continue;
    const accepts = (r.accepts ?? []).map((x) => normalizeKeetaAccept(x as Record<string, unknown>));
    const picked = pickKeetaAccept(accepts, { payTo: seller.payTo, maxAtomic: KEETA_MAX_PER_PURCHASE_ATOMIC });
    if ("accept" in picked) return picked.accept;
  }
  return null;
}