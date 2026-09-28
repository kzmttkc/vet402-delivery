/**
 * vet402 check: the step between `awal x402 bazaar search` and `awal x402 pay`.
 *
 * Read-only. Every request here is an unauthenticated GET to a public, free endpoint. Nothing pays,
 * nothing signs. Endpoints (each confirmed live on 2026-09-28, see docs/erc8004.md "check sources"):
 *   vet402.com  GET /api/v1/resolve?q=<url>                         -> observatory_id of the exact URL
 *   vet402.com  GET /api/v1/observatory/endpoints/{id}/facts          -> L0/L1/L2 facts, 30d on-chain settlements
 *   vet402.com  GET /api/v1/observatory/endpoints/{id}/purchases      -> vet402's own paid attempts with tx hash
 *   CDP Bazaar  GET /platform/v2/x402/discovery/search?query=<url>    -> quality.l30DaysTotalCalls
 *   vet402-algorand GET /board/verdicts.json                          -> Algorand purchases (DELIVERED/MISMATCH)
 *   vet402-algorand GET /v1/buy?url=<url> (unpaid)                   -> 402 = vet402 can buy it for you; 422 = it cannot
 */

export const VET402 = "https://vet402.com";
export const VET402_ALGORAND = "https://vet402-algorand.vercel.app";
export const CDP_DISCOVERY = "https://api.cdp.coinbase.com/platform/v2/x402/discovery";

export type Verdict = "delivered" | "not_delivered" | "unverified";

export interface Purchase {
  attemptedAt: string;
  status: string;
  amountUnits: string | null;
  txHash: string | null;
  httpStatusPaid: number | null;
  l2Schema: string | null;
  network: string;
}

export interface CheckResult {
  url: string;
  checkedAt: string;
  verdict: Verdict;
  /** One line a person can read. */
  summary: string;
  lastDelivery: (Purchase & { explorer: string | null }) | null;
  lastAttempt: Purchase | null;
  counts: {
    vet402Attempts: number | null;
    vet402Settled: number | null;
    vet402Delivered: number | null;
    /** vet402's on-chain count of settlements to this resource in 30 days, wash and test excluded. */
    onchainSettlements30dReal: number | null;
    /** What the Bazaar listing itself reports. */
    bazaarCalls30d: number | null;
    /** bazaarCalls30d - onchainSettlements30dReal (positive: Bazaar reports more calls than vet402 can see settle). */
    gap: number | null;
  };
  next: {
    action: "pay" | "buy_via_vet402" | "do_not_pay";
    /** The exact awal command to run next, when there is one. */
    command: string | null;
    reason: string;
  };
  evidence: string[];
}

type Fetch = typeof fetch;

async function getJson(f: Fetch, url: string): Promise<{ status: number; body: any }> {
  const res = await f(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

const is2xx = (n: number | null) => n !== null && n >= 200 && n < 300;

/**
 * A paid attempt counts as delivered when it settled and the paid response was 2xx: the same rule as the
 * observatory's `l1.n_delivered`. An L2 schema mismatch is still a delivery there; it is reported, not hidden.
 */
export function isDelivered(p: Purchase): boolean {
  return p.status === "settled" && is2xx(p.httpStatusPaid);
}

export function explorerFor(network: string, tx: string | null): string | null {
  if (!tx) return null;
  if (network === "eip155:8453") return `https://basescan.org/tx/${tx}`;
  if (network === "eip155:1") return `https://etherscan.io/tx/${tx}`;
  if (network.startsWith("solana:")) return `https://solscan.io/tx/${tx}`;
  if (network.startsWith("algorand:")) return `https://allo.info/tx/${tx}`;
  return null;
}

/**
 * A settled purchase answered 4xx is inconclusive, as in the vet402 observatory (`inconclusiveByReason.settled4xx`):
 * the request vet402 sent may have been what was wrong, so it is not counted against the seller.
 */
export function isInconclusive(p: Purchase): boolean {
  return p.status === "settled" && p.httpStatusPaid !== null && p.httpStatusPaid >= 400 && p.httpStatusPaid < 500;
}

/** Decide from vet402's own purchases, newest first, using the latest settled purchase that is not inconclusive. Pure. */
export function decide(purchases: Purchase[]): { verdict: Verdict; lastDelivery: Purchase | null; lastSettled: Purchase | null } {
  const decisive = purchases.filter((p) => p.status === "settled" && !isInconclusive(p));
  const lastSettled = decisive[0] ?? null;
  const lastDelivery = purchases.find(isDelivered) ?? null;
  if (!lastSettled) return { verdict: "unverified", lastDelivery: null, lastSettled: null };
  return { verdict: isDelivered(lastSettled) ? "delivered" : "not_delivered", lastDelivery, lastSettled };
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function vet402Check(
  url: string,
  opts: { fetchImpl?: Fetch; now?: () => Date; bazaarCalls30d?: number | null; maxAmountAtomic?: string } = {},
): Promise<CheckResult> {
  const f = opts.fetchImpl ?? fetch;
  const checkedAt = (opts.now ?? (() => new Date()))().toISOString();
  const evidence: string[] = [];
  const enc = encodeURIComponent(url);

  // 1. Bazaar's own call count (skip if the caller already has it from `awal x402 bazaar search --json`).
  let bazaarCalls30d: number | null = opts.bazaarCalls30d ?? null;
  if (opts.bazaarCalls30d === undefined) {
    const s = await getJson(f, `${CDP_DISCOVERY}/search?query=${enc}&limit=5`).catch(() => null);
    const hit = (s?.body?.resources ?? []).find((r: any) => r?.resource === url);
    const n = hit?.quality?.l30DaysTotalCalls;
    bazaarCalls30d = typeof n === "number" ? n : null;
    evidence.push(`${CDP_DISCOVERY}/search?query=${enc}`);
  }

  // 2. vet402.com: exact URL -> observatory id -> facts + purchases.
  let purchases: Purchase[] = [];
  let facts: any = null;
  // A failed lookup is not "no record": throw, so the caller cannot mistake an outage (or a 429) for "unverified".
  const r = await getJson(f, `${VET402}/api/v1/resolve?q=${enc}`);
  if (r.status !== 200) throw new Error(`vet402 resolve: HTTP ${r.status}`);
  evidence.push(`${VET402}/api/v1/resolve?q=${enc}`);
  const obsId: string | undefined = r.body?.resource?.canonical_url === url ? r.body.resource.observatory_id : undefined;
  if (obsId) {
    const [fa, pu] = await Promise.all([
      getJson(f, `${VET402}/api/v1/observatory/endpoints/${obsId}/facts`),
      getJson(f, `${VET402}/api/v1/observatory/endpoints/${obsId}/purchases`),
    ]);
    if (fa.status !== 200 || pu.status !== 200) throw new Error(`vet402 facts/purchases: HTTP ${fa.status}/${pu.status}`);
    evidence.push(`${VET402}/api/v1/observatory/endpoints/${obsId}/facts`, `${VET402}/observatory/e/${obsId}`);
    facts = fa.body?.facts ?? null;
    const net: string = pu.body?.network ?? "";
    purchases = (pu.body?.purchases ?? []).map((p: any) => ({
      attemptedAt: String(p.attemptedAt),
      status: String(p.status),
      amountUnits: p.amountUnits ?? null,
      txHash: p.txHash ?? null,
      httpStatusPaid: typeof p.httpStatusPaid === "number" ? p.httpStatusPaid : null,
      l2Schema: p.l2Schema ?? null,
      network: net,
    }));
  }

  // 3. vet402-algorand board (Algorand sellers). Used only when vet402.com has nothing settled.
  if (!purchases.some((p) => p.status === "settled")) {
    const b = await getJson(f, `${VET402_ALGORAND}/board/verdicts.json`).catch(() => null);
    const rows = (b?.body?.verdicts ?? []).filter((v: any) => v?.resource === url);
    if (rows.length) {
      evidence.push(`${VET402_ALGORAND}/board/verdicts.json`);
      rows.sort((a: any, b: any) => String(b.checkedAt).localeCompare(String(a.checkedAt)));
      purchases = rows.map((v: any) => ({
        attemptedAt: String(v.checkedAt),
        status: "settled",
        amountUnits: null,
        txHash: v.purchaseTx ?? null,
        httpStatusPaid: v.class === "DELIVERED" ? 200 : null,
        l2Schema: v.class === "DELIVERED" ? "match" : "mismatch",
        network: String(v.network),
      }));
    }
  }

  const d = decide(purchases);
  const onchain = typeof facts?.settlement_30d_real === "number" ? facts.settlement_30d_real : null;
  const counts = {
    vet402Attempts: facts?.l1?.n_attempts ?? (purchases.length || null),
    vet402Settled: facts?.l1?.n_settled ?? (purchases.filter((p) => p.status === "settled").length || null),
    vet402Delivered: facts?.l1?.n_delivered ?? (purchases.filter(isDelivered).length || null),
    onchainSettlements30dReal: onchain,
    bazaarCalls30d,
    gap: bazaarCalls30d !== null && onchain !== null ? bazaarCalls30d - onchain : null,
  };

  const max = opts.maxAmountAtomic ? ` --max-amount ${opts.maxAmountAtomic}` : "";
  let next: CheckResult["next"];
  if (d.verdict === "delivered") {
    const l2 = d.lastSettled?.l2Schema === "mismatch" ? " The response did not match the seller's own declared schema (L2 mismatch); check the fields you need." : "";
    next = { action: "pay", command: `npx awal@2.12.1 x402 pay ${shellQuote(url)}${max}`, reason: `vet402 paid this URL and it delivered on the last settled purchase.${l2}` };
  } else if (d.verdict === "not_delivered") {
    next = { action: "do_not_pay", command: null, reason: "vet402's last settled purchase of this URL paid and did not get a valid delivery." };
  } else {
    // Unverified: route the purchase through vet402 only if vet402 says (unpaid, free) that it can buy this seller.
    const buyUrl = `${VET402_ALGORAND}/v1/buy?url=${enc}`;
    const pre = await f(buyUrl, { method: "GET", signal: AbortSignal.timeout(20_000) }).catch(() => null);
    evidence.push(`${buyUrl} (unpaid preflight: HTTP ${pre?.status ?? "error"})`);
    if (pre?.status === 402) {
      next = {
        action: "buy_via_vet402",
        command: `npx awal@2.12.1 x402 pay ${shellQuote(buyUrl)}${max}`,
        reason: "vet402 has no settled purchase of this URL. vet402 /v1/buy pays the seller for you only after checking it, and hands back the seller's response.",
      };
    } else {
      next = {
        action: "do_not_pay",
        command: null,
        reason: `vet402 has no settled purchase of this URL and cannot buy it for you (vet402 /v1/buy answered ${pre?.status ?? "no response"}). Ask the user before paying an unverified seller.`,
      };
    }
  }

  const last = d.lastDelivery;
  const summary =
    d.verdict === "delivered"
      ? `delivered: vet402 paid ${last!.attemptedAt.slice(0, 10)} (tx ${last!.txHash}); Bazaar says ${bazaarCalls30d ?? "?"} calls/30d, vet402 sees ${onchain ?? "?"} settlements on-chain.`
      : d.verdict === "not_delivered"
        ? `not delivered: vet402's last settled purchase ${d.lastSettled!.attemptedAt.slice(0, 10)} (tx ${d.lastSettled!.txHash}) got HTTP ${d.lastSettled!.httpStatusPaid ?? "?"}.`
        : purchases.some(isInconclusive)
          ? `unverified: vet402 paid this URL but the seller answered 4xx (inconclusive, not counted against the seller).`
          : `unverified: vet402 has no settled purchase of this URL.`;

  return {
    url,
    checkedAt,
    verdict: d.verdict,
    summary,
    lastDelivery: last ? { ...last, explorer: explorerFor(last.network, last.txHash) } : null,
    lastAttempt: purchases[0] ?? null,
    counts,
    next,
    evidence,
  };
}
