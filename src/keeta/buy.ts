/**
 * One Keeta remeasure purchase: 402, budget, sign, paid GET, ledger verify.
 */
import { existsSync, readFileSync } from "node:fs";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { atomicToUsdc } from "../constants.js";
import { PayloadNotCreatedError } from "../guard.js";
import { firstSentence } from "../pay.js";
import { RM_NOTE, RM_PAID_TIMEOUT_MS } from "../remeasure/constants.js";
import type { RemeasureRow } from "../remeasure/results.js";
import { cutDetail } from "../daily/detail-cut.js";
import { toAtomic } from "../daily/steps.js";
import {
  normalizeKeetaAccept,
  parseKeeta402,
  paymentRequiredFromCatalogAccept,
  pickKeetaAccept,
  type KeetaAccept,
} from "./challenge.js";
import { keetaBudgetKey, normalizeKeetaPurchaseUrl, type KeetaBudget } from "./budget.js";
import { KEETA_VERIFY_TRIES, KEETA_VERIFY_WAIT_MS, verifyKeetaPayment, type KeetaLedgerReader } from "./ledger.js";
import { KEETA_CAIP2, KEETA_MAX_PER_PURCHASE_ATOMIC, KEETA_SELLERS, KEETA_USDC } from "./constants.js";
import { KeetaSignTimeoutError } from "./sign.js";

export type KeetaRemeasureRow = Omit<RemeasureRow, "chain"> & { chain: "keeta"; sellerTx?: string | null };

export interface KeetaBuyEntry {
  url: string;
  host: string;
  expectedPayTo: string;
  /** Atomic USDC from the dry-run plan. Live 402 amounts above this are refused (price_raised). */
  plannedPriceAtomic?: string;
  freeTrial?: boolean;
  /** Catalog USDC accept for pay-first (freeTrial) buys. */
  catalogAccept?: KeetaAccept;
}

export interface KeetaBuyDeps {
  fetch: typeof fetch;
  payer: string;
  createPayment: (pr: PaymentRequired, accept: KeetaAccept) => Promise<{ headers: Record<string, string>; blockHash: string; blockBase64: string }>;
  reader: KeetaLedgerReader;
  budget: KeetaBudget;
  balance: () => Promise<bigint | null>;
  now: () => Date;
  paidTimeoutMs?: number;
  sleep: (ms: number) => Promise<void>;
}

const httpClient = new x402HTTPClient(new x402Client());

function headerGetter(h: Headers): (n: string) => string | null {
  return (n) => h.get(n);
}

export type BuyKeetaOneResult = { row: KeetaRemeasureRow; stop?: string };

export async function buyKeetaOne(entry: KeetaBuyEntry, deps: KeetaBuyDeps, date: string, slot: number): Promise<BuyKeetaOneResult> {
  const at = deps.now().toISOString();
  const requestUrl = normalizeKeetaPurchaseUrl(entry.url);
  const key = keetaBudgetKey(date, requestUrl);
  const lock = { payTo: entry.expectedPayTo, maxAtomic: KEETA_MAX_PER_PURCHASE_ATOMIC };

  if (new URL(entry.url).host !== entry.host) {
    return {
      row: row(at, entry, key, slot, {
        outcome: "refused",
        reason: "url_host_mismatch",
        detail: `url host ${new URL(entry.url).host} != plan host ${entry.host}`,
        httpStatus: null,
      }),
    };
  }

  const seller = sellerForHost(entry.host);
  const freeTrial = entry.freeTrial ?? seller?.freeTrial ?? false;

  let res: Response;
  try {
    res = await deps.fetch(requestUrl, { method: "GET", headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    return { row: row(at, entry, key, slot, {
      outcome: "refused",
      reason: "no_keeta_accept",
      detail: `fetch: ${(e as Error).message}`.slice(0, 200),
      httpStatus: null,
    }) };
  }

  let httpStatus = res.status;
  let body: unknown;
  let pr: PaymentRequired | null = null;

  if (freeTrial && httpStatus !== 402 && entry.catalogAccept) {
    if (httpStatus >= 200 && httpStatus < 300) {
      const buf = new Uint8Array(await res.arrayBuffer());
      const bodyBytes = buf.byteLength;
      const preview = new TextDecoder().decode(buf).slice(0, 300);
      if (bodyBytes > 0) {
        return payFirstFromCatalog(at, entry, key, slot, lock, deps, requestUrl, date);
      }
      return {
        row: row(at, entry, key, slot, {
          outcome: "free_response",
          reason: "free_response",
          detail: cutDetail(preview || null, 200),
          httpStatus,
          bodyBytes,
        }),
      };
    }
    await res.body?.cancel().catch(() => undefined);
    return {
      row: row(at, entry, key, slot, {
        outcome: "refused",
        reason: "no_keeta_accept",
        detail: `unpaid request returned ${httpStatus}`,
        httpStatus,
      }),
    };
  }

  if (httpStatus === 402) {
    try {
      const text = await res.text();
      body = text ? JSON.parse(text) : undefined;
      pr = parseKeeta402(headerGetter(res.headers), body);
    } catch (e) {
      return { row: row(at, entry, key, slot, {
        outcome: "refused",
        reason: "no_keeta_accept",
        detail: `unparseable 402: ${(e as Error).message}`.slice(0, 200),
        httpStatus,
      }) };
    }
  } else {
    await res.body?.cancel().catch(() => undefined);
    return { row: row(at, entry, key, slot, {
      outcome: "refused",
      reason: "no_keeta_accept",
      detail: `unpaid request returned ${httpStatus}`,
      httpStatus,
    }) };
  }

  const accepts = (pr!.accepts as unknown as Record<string, unknown>[]).map(normalizeKeetaAccept);
  const picked = pickKeetaAccept(accepts, lock);
  if ("refused" in picked) {
    return { row: row(at, entry, key, slot, {
      outcome: "refused",
      reason: picked.refused,
      detail: picked.detail,
      httpStatus,
      payTo: accepts[0]?.payTo ?? null,
    }) };
  }
  const accept = picked.accept;
  if (entry.plannedPriceAtomic !== undefined && BigInt(accept.amount) > BigInt(entry.plannedPriceAtomic)) {
    return {
      row: row(at, entry, key, slot, {
        outcome: "refused",
        reason: "price_raised",
        detail: `amount ${accept.amount} > planned ${entry.plannedPriceAtomic}`,
        httpStatus,
        payTo: accept.payTo,
        priceUsdc: atomicToUsdc(accept.amount),
      }),
    };
  }

  let bal: bigint | null = null;
  try {
    bal = await deps.balance();
  } catch {
    bal = null;
  }
  const resv = deps.budget.reserve(BigInt(accept.amount), key, bal);
  if ("refused" in resv) {
    return { row: row(at, entry, key, slot, {
      outcome: "refused",
      reason: resv.refused,
      detail: resv.detail,
      httpStatus,
      payTo: accept.payTo,
      priceUsdc: atomicToUsdc(accept.amount),
    }) };
  }

  let blockHash: string;
  let payHeaders: Record<string, string>;
  try {
    const created = await deps.createPayment(pr!, accept);
    blockHash = created.blockHash;
    payHeaders = created.headers;
  } catch (e) {
    deps.budget.release(resv.id);
    if (e instanceof KeetaSignTimeoutError) {
      // A sign timeout happens before the block is handed to the seller and no signed block leaves the process, so no payment can occur and keeping the reservation serves no purpose (budget.commit runs only after this).
      return {
        row: row(at, entry, key, slot, {
          outcome: "not_sent",
          reason: "keeta_sign_timeout",
          detail: firstSentence((e as Error).message).slice(0, 300),
          httpStatus,
          payTo: accept.payTo,
          priceUsdc: atomicToUsdc(accept.amount),
        }),
        stop: `keeta_sign_timeout: ${firstSentence((e as Error).message)}`,
      };
    }
    if (e instanceof PayloadNotCreatedError) {
      return { row: row(at, entry, key, slot, {
        outcome: "not_sent",
        reason: "payload_not_created",
        detail: firstSentence((e as Error).message).slice(0, 300),
        httpStatus,
        payTo: accept.payTo,
        priceUsdc: atomicToUsdc(accept.amount),
      }) };
    }
    throw e;
  }
  // Once the signed block is handed to the seller they can publish it anytime. Count the reservation as spent whether or not delivery succeeds (no double-buy of this URL today).
  deps.budget.commit(resv.id);

  let paidStatus: number | null = null;
  let bodyBytes: number | null = null;
  let detail: string | null = null;
  let sellerTx: string | null = null;
  try {
    const paid = await deps.fetch(requestUrl, {
      method: "GET",
      headers: { accept: "application/json", ...payHeaders },
      redirect: "manual",
      signal: AbortSignal.timeout(deps.paidTimeoutMs ?? RM_PAID_TIMEOUT_MS),
    });
    paidStatus = paid.status;
    const buf = new Uint8Array(await paid.arrayBuffer());
    bodyBytes = buf.byteLength;
    const preview = new TextDecoder().decode(buf).slice(0, 300);
    detail = preview || null;
    try {
      const settled = httpClient.getPaymentSettleResponse(headerGetter(paid.headers)) as { transaction?: string };
      if (settled.transaction) {
        sellerTx = settled.transaction;
        if (settled.transaction !== blockHash) {
          detail = `${cutDetail(detail, 160) ?? ""} Seller transaction ${settled.transaction} differs from vet402's block ${blockHash}.`.slice(0, 200);
        }
      }
    } catch {
      /* no settlement header */
    }
  } catch (e) {
    detail = `paid fetch: ${(e as Error).message}`.slice(0, 200);
  }

  let verified;
  try {
    verified = await verifyKeetaPayment(
      deps.reader,
      { blockHash, payer: deps.payer, payTo: accept.payTo, amount: accept.amount, asset: accept.asset },
      { tries: KEETA_VERIFY_TRIES, waitMs: KEETA_VERIFY_WAIT_MS, sleep: deps.sleep },
    );
  } catch (e) {
    return {
      row: row(at, entry, key, slot, {
        outcome: "sent",
        reason: "sent",
        detail: cutDetail(detail, 200),
        httpStatus: paidStatus,
        bodyBytes,
        payTo: accept.payTo,
        priceUsdc: atomicToUsdc(accept.amount),
        settled: null,
        delivered: null,
        tx: blockHash,
      }),
      stop: `keeta_ledger_unreadable: ${(e as Error).message}`,
    };
  }
  if (verified.settled === false) {
    return {
      row: row(at, entry, key, slot, {
        outcome: "sent",
        reason: "sent",
        detail: cutDetail(`${verified.detail}. ${detail ?? ""}`, 200),
        httpStatus: paidStatus,
        bodyBytes,
        payTo: accept.payTo,
        priceUsdc: atomicToUsdc(accept.amount),
        settled: false,
        delivered: null,
        tx: blockHash,
      }),
      stop: `keeta_tx_mismatch: ${verified.detail}`,
    };
  }
  if ("notFound" in verified && verified.notFound) {
    const nfDetail = `${cutDetail(detail, 160) ?? ""} ${verified.detail}`.slice(0, 200);
    return {
      row: row(at, entry, key, slot, {
        outcome: "sent",
        reason: "sent",
        detail: nfDetail,
        httpStatus: paidStatus,
        bodyBytes,
        payTo: accept.payTo,
        priceUsdc: atomicToUsdc(accept.amount),
        settled: null,
        delivered: null,
        tx: blockHash,
      }),
      stop: `keeta_tx_not_found: ${verified.detail}`,
    };
  }
  const settled = verified.settled === true ? true : verified.settled === false ? false : null;
  const delivered = settled === true && paidStatus !== null && paidStatus >= 200 && paidStatus < 300 && (bodyBytes ?? 0) > 0;

  return {
    row: row(at, entry, key, slot, {
      outcome: "sent",
      reason: "sent",
      detail: cutDetail(detail, 200),
      httpStatus: paidStatus,
      bodyBytes,
      payTo: accept.payTo,
      priceUsdc: atomicToUsdc(accept.amount),
      settled,
      delivered,
      tx: blockHash,
      sellerTx,
    }),
  };
}

async function payFirstFromCatalog(
  at: string,
  entry: KeetaBuyEntry,
  key: string,
  slot: number,
  lock: { payTo: string; maxAtomic: bigint },
  deps: KeetaBuyDeps,
  requestUrl: string,
  date: string,
): Promise<BuyKeetaOneResult> {
  const catalogAccept = normalizeKeetaAccept(entry.catalogAccept as unknown as Record<string, unknown>);
  const pr = paymentRequiredFromCatalogAccept(catalogAccept);
  const picked = pickKeetaAccept([catalogAccept], lock);
  if ("refused" in picked) {
    return {
      row: row(at, entry, key, slot, {
        outcome: "refused",
        reason: picked.refused,
        detail: picked.detail,
        httpStatus: null,
        payTo: catalogAccept.payTo,
      }),
    };
  }
  const accept = picked.accept;
  if (accept.payTo !== entry.expectedPayTo) {
    return {
      row: row(at, entry, key, slot, {
        outcome: "refused",
        reason: "payto_mismatch",
        detail: `catalog payTo ${accept.payTo} != recorded ${entry.expectedPayTo}`,
        httpStatus: null,
        payTo: accept.payTo,
      }),
    };
  }
  if (entry.plannedPriceAtomic !== undefined && BigInt(accept.amount) > BigInt(entry.plannedPriceAtomic)) {
    return {
      row: row(at, entry, key, slot, {
        outcome: "refused",
        reason: "price_raised",
        detail: `amount ${accept.amount} > planned ${entry.plannedPriceAtomic}`,
        httpStatus: null,
        payTo: accept.payTo,
        priceUsdc: atomicToUsdc(accept.amount),
      }),
    };
  }

  let bal: bigint | null = null;
  try {
    bal = await deps.balance();
  } catch {
    bal = null;
  }
  const resv = deps.budget.reserve(BigInt(accept.amount), key, bal);
  if ("refused" in resv) {
    return { row: row(at, entry, key, slot, {
      outcome: "refused",
      reason: resv.refused,
      detail: resv.detail,
      httpStatus: null,
      payTo: accept.payTo,
      priceUsdc: atomicToUsdc(accept.amount),
    }) };
  }

  let blockHash: string;
  let payHeaders: Record<string, string>;
  try {
    const created = await deps.createPayment(pr, accept);
    blockHash = created.blockHash;
    payHeaders = created.headers;
  } catch (e) {
    deps.budget.release(resv.id);
    if (e instanceof KeetaSignTimeoutError) {
      return {
        row: row(at, entry, key, slot, {
          outcome: "not_sent",
          reason: "keeta_sign_timeout",
          detail: firstSentence((e as Error).message).slice(0, 300),
          httpStatus: null,
          payTo: accept.payTo,
          priceUsdc: atomicToUsdc(accept.amount),
        }),
        stop: `keeta_sign_timeout: ${firstSentence((e as Error).message)}`,
      };
    }
    if (e instanceof PayloadNotCreatedError) {
      return { row: row(at, entry, key, slot, {
        outcome: "not_sent",
        reason: "payload_not_created",
        detail: firstSentence((e as Error).message).slice(0, 300),
        httpStatus: null,
        payTo: accept.payTo,
        priceUsdc: atomicToUsdc(accept.amount),
      }) };
    }
    throw e;
  }
  deps.budget.commit(resv.id);

  let paidStatus: number | null = null;
  let bodyBytes: number | null = null;
  let detail: string | null = null;
  let sellerTx: string | null = null;
  try {
    const paid = await deps.fetch(requestUrl, {
      method: "GET",
      headers: { accept: "application/json", ...payHeaders },
      redirect: "manual",
      signal: AbortSignal.timeout(deps.paidTimeoutMs ?? RM_PAID_TIMEOUT_MS),
    });
    paidStatus = paid.status;
    if (paidStatus === 402) {
      await paid.body?.cancel().catch(() => undefined);
      return {
        row: row(at, entry, key, slot, {
          outcome: "refused",
          reason: "paid_get_402",
          detail: "paid GET returned 402 after payment signature was sent",
          httpStatus: paidStatus,
          payTo: accept.payTo,
          priceUsdc: atomicToUsdc(accept.amount),
          tx: blockHash,
        }),
      };
    }
    const buf = new Uint8Array(await paid.arrayBuffer());
    bodyBytes = buf.byteLength;
    const preview = new TextDecoder().decode(buf).slice(0, 300);
    detail = preview || null;
    try {
      const settled = httpClient.getPaymentSettleResponse(headerGetter(paid.headers)) as { transaction?: string };
      if (settled.transaction) {
        sellerTx = settled.transaction;
        if (settled.transaction !== blockHash) {
          detail = `${cutDetail(detail, 160) ?? ""} Seller transaction ${settled.transaction} differs from vet402's block ${blockHash}.`.slice(0, 200);
        }
      }
    } catch {
      /* no settlement header */
    }
  } catch (e) {
    detail = `paid fetch: ${(e as Error).message}`.slice(0, 200);
  }

  let verified;
  try {
    verified = await verifyKeetaPayment(
      deps.reader,
      { blockHash, payer: deps.payer, payTo: accept.payTo, amount: accept.amount, asset: accept.asset },
      { tries: KEETA_VERIFY_TRIES, waitMs: KEETA_VERIFY_WAIT_MS, sleep: deps.sleep },
    );
  } catch (e) {
    return {
      row: row(at, entry, key, slot, {
        outcome: "sent",
        reason: "sent",
        detail: cutDetail(detail, 200),
        httpStatus: paidStatus,
        bodyBytes,
        payTo: accept.payTo,
        priceUsdc: atomicToUsdc(accept.amount),
        settled: null,
        delivered: null,
        tx: blockHash,
      }),
      stop: `keeta_ledger_unreadable: ${(e as Error).message}`,
    };
  }

  if (verified.settled === false) {
    return {
      row: row(at, entry, key, slot, {
        outcome: "sent",
        reason: "sent",
        detail: cutDetail(`${verified.detail}. ${detail ?? ""}`, 200),
        httpStatus: paidStatus,
        bodyBytes,
        payTo: accept.payTo,
        priceUsdc: atomicToUsdc(accept.amount),
        settled: false,
        delivered: null,
        tx: blockHash,
      }),
      stop: `keeta_tx_mismatch: ${verified.detail}`,
    };
  }
  if ("notFound" in verified && verified.notFound) {
    const nfDetail = `${cutDetail(detail, 160) ?? ""} ${verified.detail}`.slice(0, 200);
    return {
      row: row(at, entry, key, slot, {
        outcome: "sent",
        reason: "sent",
        detail: nfDetail,
        httpStatus: paidStatus,
        bodyBytes,
        payTo: accept.payTo,
        priceUsdc: atomicToUsdc(accept.amount),
        settled: null,
        delivered: null,
        tx: blockHash,
        sellerTx,
      }),
      stop: `keeta_tx_not_found: ${verified.detail}`,
    };
  }

  const settled = verified.settled === true ? true : verified.settled === false ? false : null;
  const delivered = settled === true && paidStatus !== null && paidStatus >= 200 && paidStatus < 300 && (bodyBytes ?? 0) > 0;

  return {
    row: row(at, entry, key, slot, {
      outcome: "sent",
      reason: "sent",
      detail: cutDetail(detail, 200),
      httpStatus: paidStatus,
      bodyBytes,
      payTo: accept.payTo,
      priceUsdc: atomicToUsdc(accept.amount),
      settled,
      delivered,
      tx: blockHash,
      sellerTx,
    }),
  };
}

function row(
  at: string,
  entry: KeetaBuyEntry,
  key: string,
  slot: number,
  o: {
    outcome: KeetaRemeasureRow["outcome"];
    reason: string;
    detail: string | null;
    httpStatus: number | null;
    payTo?: string | null;
    priceUsdc?: string | null;
    settled?: boolean | null;
    delivered?: boolean | null;
    bodyBytes?: number | null;
    tx?: string | null;
    sellerTx?: string | null;
  },
): KeetaRemeasureRow {
  return {
    at,
    chain: "keeta",
    host: entry.host,
    service: null,
    url: normalizeKeetaPurchaseUrl(entry.url),
    requestUrl: normalizeKeetaPurchaseUrl(entry.url),
    payTo: o.payTo ?? null,
    expectedPayTo: entry.expectedPayTo,
    outcome: o.outcome,
    reason: o.reason,
    detail: o.detail,
    settled: o.settled ?? null,
    delivered: o.delivered ?? null,
    httpStatus: o.httpStatus,
    bodyBytes: o.bodyBytes ?? null,
    tx: o.tx ?? null,
    sellerTx: o.sellerTx ?? null,
    priceUsdc: o.priceUsdc ?? null,
    slot,
    key,
  };
}

export function keetaHost(url: string): string {
  return new URL(url).host;
}

export function sellerForHost(host: string): (typeof KEETA_SELLERS)[number] | undefined {
  return KEETA_SELLERS.find((s) => s.host === host);
}

export interface KeetaResultFile {
  kind: "vet402-remeasure";
  version: 1;
  chain: "keeta";
  network: string;
  date: string;
  payer: string;
  note: string;
  runs: { startedAt: string; endedAt: string | null; perPayTo: number; stopped: string | null }[];
  rows: KeetaRemeasureRow[];
}

export function emptyKeetaResult(date: string, payer: string): KeetaResultFile {
  return { kind: "vet402-remeasure", version: 1, chain: "keeta", network: KEETA_CAIP2, date, payer, note: RM_NOTE, runs: [], rows: [] };
}

export interface KeetaDryRunPlan {
  kind: "vet402-remeasure-dry-run";
  chain: "keeta";
  createdAt: string;
  rows: { url?: string; host?: string; outcome?: string; priceUsdc?: string | null; expectedPayTo?: string }[];
}

export function readKeetaPayPlan(file: string, day: string, log: (msg: string) => void = console.error): KeetaBuyEntry[] {
  const plan = JSON.parse(readFileSync(file, "utf8")) as KeetaDryRunPlan;
  if (plan.kind !== "vet402-remeasure-dry-run" || plan.chain !== "keeta") {
    throw new Error(`${file} is not a Keeta remeasure dry-run plan`);
  }
  if (!plan.createdAt || plan.createdAt.slice(0, 10) !== day) {
    throw new Error(`${file} plan createdAt ${plan.createdAt ?? "?"} is not UTC day ${day}`);
  }
  if (!Array.isArray(plan.rows)) throw new Error(`${file} has no rows`);
  const out: KeetaBuyEntry[] = [];
  for (const r of plan.rows) {
    if (r.outcome !== "would_pay" || !r.url || !r.priceUsdc) continue;
    const urlHost = new URL(r.url).host;
    const rowHost = r.host ?? urlHost;
    const seller = sellerForHost(rowHost);
    if (!seller) {
      log(`${file}: row url host ${rowHost} is not a Keeta seller (${r.url})`);
      continue;
    }
    const catalogHost = new URL(seller.catalog).host;
    if (r.host && (urlHost !== catalogHost || r.host !== seller.host)) {
      log(`${file}: plan host ${r.host} does not match url host ${urlHost} for ${r.url}`);
      continue;
    }
    const planned = toAtomic(r.priceUsdc).toString();
    const catalogAccept: KeetaAccept | undefined = seller.freeTrial
      ? {
          scheme: "exact",
          network: KEETA_CAIP2,
          amount: planned,
          asset: KEETA_USDC,
          payTo: seller.payTo,
          maxTimeoutSeconds: 300,
        }
      : undefined;
    out.push({
      url: r.url,
      host: seller.host,
      expectedPayTo: seller.payTo,
      plannedPriceAtomic: planned,
      freeTrial: seller.freeTrial,
      catalogAccept,
    });
  }
  return out;
}

export function readKeetaResultFile(file: string, date: string, payer: string): KeetaResultFile {
  if (!existsSync(file)) return emptyKeetaResult(date, payer);
  const f = JSON.parse(readFileSync(file, "utf8")) as KeetaResultFile;
  if (
    f.kind !== "vet402-remeasure" ||
    f.chain !== "keeta" ||
    f.date !== date ||
    !Array.isArray(f.rows) ||
    !Array.isArray(f.runs)
  ) {
    throw new Error(`${file} is not a keeta remeasure file for ${date}. Refusing to append`);
  }
  if (f.payer.toLowerCase() !== payer.toLowerCase()) throw new Error(`${file} was written for another payer`);
  return f;
}