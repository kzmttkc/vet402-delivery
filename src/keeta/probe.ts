/**
 * Dry-run probe: one GET without payment to classify a route.
 */
import { atomicToUsdc } from "../constants.js";
import { KEETA_MAX_PER_PURCHASE_ATOMIC } from "./constants.js";
import { keetaBudgetKey, normalizeKeetaPurchaseUrl } from "./budget.js";
import { normalizeKeetaAccept, parseKeeta402, pickKeetaAccept } from "./challenge.js";
import { keetaHost, sellerForHost, type KeetaBuyEntry, type KeetaRemeasureRow } from "./buy.js";

function headerGetter(h: Headers): (n: string) => string | null {
  return (n) => h.get(n);
}

function dryRow(
  at: string,
  date: string,
  entry: KeetaBuyEntry,
  outcome: KeetaRemeasureRow["outcome"],
  reason: string,
  detail: string | null,
  httpStatus: number | null,
  payTo: string | null = null,
  priceUsdc: string | null = null,
  slot: number = 1,
): KeetaRemeasureRow {
  return {
    at,
    chain: "keeta",
    host: entry.host,
    service: null,
    url: entry.url,
    requestUrl: entry.url,
    payTo,
    expectedPayTo: entry.expectedPayTo,
    outcome,
    reason,
    detail,
    settled: null,
    delivered: null,
    httpStatus,
    bodyBytes: null,
    tx: null,
    sellerTx: null,
    priceUsdc,
    slot,
    key: keetaBudgetKey(date, entry.url),
  };
}

export async function probePayable(
  url: string,
  payTo: string,
  fetchImpl: typeof fetch,
  ctx: { at: string; date: string },
): Promise<KeetaRemeasureRow | null> {
  const norm = normalizeKeetaPurchaseUrl(url);
  const seller = sellerForHost(keetaHost(norm));
  if (!seller) return null;
  const entry: KeetaBuyEntry = { url: norm, host: seller.host, expectedPayTo: payTo };
  let res: Response;
  try {
    res = await fetchImpl(norm, { method: "GET", headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    return dryRow(ctx.at, ctx.date, entry, "refused", "no_keeta_accept", `fetch: ${(e as Error).message}`.slice(0, 200), null);
  }
  if (res.status !== 402) {
    await res.body?.cancel().catch(() => undefined);
    return dryRow(ctx.at, ctx.date, entry, "refused", "no_keeta_accept", `status ${res.status}`, res.status);
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  let pr;
  try {
    pr = parseKeeta402(headerGetter(res.headers), body);
  } catch (e) {
    return dryRow(ctx.at, ctx.date, entry, "refused", "no_keeta_accept", (e as Error).message, 402);
  }
  const accepts = (pr.accepts as unknown as Record<string, unknown>[]).map(normalizeKeetaAccept);
  const picked = pickKeetaAccept(accepts, { payTo, maxAtomic: KEETA_MAX_PER_PURCHASE_ATOMIC });
  if ("refused" in picked) {
    return dryRow(
      ctx.at,
      ctx.date,
      entry,
      "refused",
      picked.refused,
      picked.detail,
      402,
      accepts[0]?.payTo ?? null,
      accepts[0]?.amount ? atomicToUsdc(accepts[0].amount) : null,
    );
  }
  return dryRow(ctx.at, ctx.date, entry, "would_pay", "would_pay", null, 402, picked.accept.payTo, atomicToUsdc(picked.accept.amount));
}

export { dryRow as keetaDryRow };