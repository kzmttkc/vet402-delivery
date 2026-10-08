/**
 * Named reasons next to the verdict, and a policy that maps each reason to what the hook does.
 *
 *   paid_not_delivered  vet402's newest paid purchase from this seller settled and came back with no answer
 *                       (rank.json's seller-side rules after a settled payment). Only for a seller vet402 has
 *                       told about its results, the same gate as the "avoid" verdict (verdict.ts).
 *   payto_differs       the payTo in the 402 is not one vet402 paid this seller (vet402 recorded at least one).
 *   price_jump          the amount in the 402 is more than PRICE_JUMP_FACTOR times the highest amount vet402
 *                       paid for the same URL in the same asset (signed records).
 *   asset_unseen        the asset in the 402 is not one vet402 paid this seller on that chain (signed records).
 *   never_bought        vet402 has no purchase from this seller (on the asked chain).
 *   stale               vet402's newest purchase from this seller is more than STALE_DAYS days old.
 *
 * Reasons are facts with their evidence (date, chain, tx). They never change the verdict. What to do with
 * them is the caller's: `policy` in wrapFetchWithCheck, or the caller's own code.
 */
import { explorerFor, PAID_SELLER_RULES } from "./check.js";

export const REASONS = ["paid_not_delivered", "payto_differs", "price_jump", "asset_unseen", "never_bought", "stale"] as const;
export type Reason = (typeof REASONS)[number];

export const POLICY_ACTIONS = ["allow", "warn", "block", "ask_human"] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];
/** What the hook does for each reason. A reason left out is "allow". */
export type Policy = Partial<Record<Reason, PolicyAction>>;

/** More than this many times the highest recorded amount is a price_jump (10x exactly is not). */
export const PRICE_JUMP_FACTOR = 10n;
/** A newest purchase older than this many days is stale. */
export const STALE_DAYS = 7;

/** One purchase vet402 made, as rank.json lists it (the newest ones per seller). */
export interface PurchaseRow {
  seller: string;
  at: string;
  chain: string;
  url: string;
  /** delivered, or the rule rank.json gave the failure (paid_not_delivered, payment_tx_rejected, ...). */
  result: string;
  /** seller, vet402_or_facilitator or unknown for a failure; null when delivered. */
  fault: string | null;
  httpStatus: number | null;
  tx: string | null;
  explorer: string | null;
}

/** One payment from a signed record: what vet402 paid, to whom, in which asset. */
export interface RecordedPayment {
  id: string;
  /** The seller key in the records index. */
  seller?: string;
  day: string;
  at: string | null;
  url: string;
  network: string;
  payTo: string;
  asset: string;
  amount: string;
  tx: string;
  verdict: string;
  json: string;
}

export interface ReasonHit {
  reason: Reason;
  /** One English sentence; its dates and numbers are in `evidence`. */
  detail: string;
  /** The purchases or records the reason rests on. */
  evidence: { at: string; chain: string; url: string; result: string; httpStatus: number | null; tx: string | null; explorer: string | null; amount?: string; asset?: string; payTo?: string; record?: string }[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * The purchases rank.json lists for these sellers (recent, sellerFailures, last, lastFailure), newest first,
 * one row per purchase. rank.json keeps only the newest few per seller. Seller-written text (detail) is left out.
 */
export function listedPurchases(rankRaw: unknown, sellerKeys: ReadonlySet<string>): PurchaseRow[] {
  if (!isObj(rankRaw)) return [];
  const rows = new Map<string, PurchaseRow>();
  for (const g of arr(rankRaw.groups)) {
    if (!isObj(g)) continue;
    for (const s of arr(g.ranking)) {
      if (!isObj(s) || !sellerKeys.has(str(s.key) ?? "")) continue;
      const seller = s.key as string;
      const candidates = [...arr(s.recent), ...arr(s.sellerFailures), s.last, s.lastFailure].filter(isObj);
      for (const r of candidates) {
        const at = str(r.at);
        if (!at) continue;
        const chain = str(r.chain) ?? "?";
        const tx = str(r.tx);
        const url = str(r.url) ?? "";
        const delivered = r.delivered === true || r.category === "delivered";
        const rule = str(r.rule);
        const status = typeof r.httpStatus === "number" ? r.httpStatus : null;
        const key = `${at}|${tx ?? ""}|${url}`;
        const prev = rows.get(key);
        const row: PurchaseRow = {
          seller,
          at,
          chain,
          url,
          result: delivered ? "delivered" : rule ?? str(r.category) ?? "not_delivered",
          fault: delivered ? null : str(r.fault),
          httpStatus: status,
          tx,
          explorer: explorerFor(chain, tx),
        };
        // Keep the row with the most detail (a failure row carries rule and fault).
        if (!prev || (prev.fault === null && row.fault !== null) || (prev.httpStatus === null && row.httpStatus !== null)) rows.set(key, prev ? { ...prev, ...row, httpStatus: row.httpStatus ?? prev.httpStatus } : row);
      }
    }
  }
  return [...rows.values()].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** A paid call that counts: delivered, or a seller-side failure after a settled payment. */
export const isPaidCounted = (r: PurchaseRow): boolean => r.result === "delivered" || (r.fault === "seller" && PAID_SELLER_RULES.has(r.result));

const evidenceOf = (r: PurchaseRow): ReasonHit["evidence"][number] => ({ at: r.at, chain: r.chain, url: r.url, result: r.result, httpStatus: r.httpStatus, tx: r.tx, explorer: r.explorer });

const dayOf = (iso: string): string => iso.slice(0, 10);

export interface BaseReasonInput {
  /** The sellers found for the URL, with their facts (check.ts SellerFacts). */
  sellers: { key: string; tried: number; lastAt: string | null; byChain: Record<string, { tried: number; lastAt: string | null }> }[];
  chain: string | null;
  /** Sellers vet402 has told about their results (notified.json). */
  told: (seller: string) => boolean;
  purchases: PurchaseRow[];
  payTo: { asked: string; recordedByVet402: string[]; sameAsRecorded: boolean } | null;
  now: number;
}

/** The reasons that need only rank.json: never_bought, stale, paid_not_delivered, payto_differs. */
export function baseReasons(x: BaseReasonInput): ReasonHit[] {
  const hits: ReasonHit[] = [];
  const onChain = x.chain ? ` on ${x.chain}` : "";
  const scoped = x.sellers.map((f) => (x.chain && f.byChain[x.chain] ? { key: f.key, tried: f.byChain[x.chain]!.tried, lastAt: f.byChain[x.chain]!.lastAt } : { key: f.key, tried: f.tried, lastAt: f.lastAt }));
  const bought = scoped.filter((f) => f.tried > 0);
  if (!bought.length) {
    hits.push({ reason: "never_bought", detail: `vet402 has no purchase from this seller${onChain}.`, evidence: [] });
  } else {
    const newest = bought.map((f) => f.lastAt).filter((a): a is string => a !== null).sort().at(-1) ?? null;
    if (newest) {
      const ageDays = Math.floor((x.now - Date.parse(newest)) / 86_400_000);
      if (Number.isFinite(ageDays) && ageDays > STALE_DAYS) {
        const row = x.purchases.find((r) => r.at === newest);
        hits.push({
          reason: "stale",
          detail: `vet402's newest purchase from this seller${onChain} is from ${dayOf(newest)}, ${ageDays} days before this check (more than ${STALE_DAYS}).`,
          evidence: row ? [evidenceOf(row)] : [],
        });
      }
    }
  }
  for (const f of bought) {
    if (!x.told(f.key)) continue;
    const paid = x.purchases.filter((r) => r.seller === f.key && (!x.chain || r.chain === x.chain) && isPaidCounted(r));
    const newest = paid[0];
    if (!newest || newest.result === "delivered") continue;
    const failed = paid.filter((r) => r.result !== "delivered");
    hits.push({
      reason: "paid_not_delivered",
      detail:
        `vet402's newest paid purchase from ${f.key}${onChain} (${dayOf(newest.at)}${newest.tx ? `, tx ${newest.tx}` : ""}) settled and came back with no answer` +
        `${newest.httpStatus !== null ? ` (HTTP ${newest.httpStatus})` : ""}; ${failed.length} of the ${paid.length} newest paid purchases listed did the same.`,
      evidence: failed.slice(0, 10).map(evidenceOf),
    });
  }
  if (x.payTo && !x.payTo.sameAsRecorded && x.payTo.recordedByVet402.length) {
    hits.push({
      reason: "payto_differs",
      detail: `The payTo in this 402 (${x.payTo.asked}) is not one vet402 paid this seller (${x.payTo.recordedByVet402.join(", ")}).`,
      evidence: [],
    });
  }
  return hits;
}

const sameAddress = (a: string, b: string): boolean => (/^0x[0-9a-f]+$/i.test(a) && /^0x[0-9a-f]+$/i.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b);

function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return a === b;
  }
}

/** The 402 being compared: its amount (atomic units, as x402 writes it), asset, chain and URL. */
export interface OfferToCompare {
  url: string;
  chain: string | null;
  amount: string | null;
  asset: string | null;
}

export interface OfferComparison {
  amount: string | null;
  asset: string | null;
  chain: string | null;
  /** Signed records of this seller on this chain that were read. */
  recordsRead: number;
  /** Assets vet402 paid this seller in on this chain. */
  assetsPaid: string[];
  /** The highest amount vet402 paid for this exact URL in this asset, and the record it comes from. */
  priceReference: { amount: string; asset: string; record: string; day: string; tx: string } | null;
  /** amount / priceReference.amount, rounded to 2 places; null when there is no reference. */
  ratio: number | null;
}

/**
 * Compare a 402's amount and asset with what vet402 paid (signed records of the same seller and chain).
 * price_jump needs a record for the same URL in the same asset; asset_unseen needs at least one record on
 * the chain. With no record to compare with, neither is said.
 */
export function compareOffer(offer: OfferToCompare, paid: RecordedPayment[]): { hits: ReasonHit[]; comparison: OfferComparison } {
  const network = offer.chain;
  const onChain = paid.filter((p) => network === null || chainOfNetwork(p.network) === network);
  const assetsPaid = [...new Set(onChain.map((p) => p.asset))];
  const hits: ReasonHit[] = [];
  const ev = (p: RecordedPayment): ReasonHit["evidence"][number] => ({
    at: p.at ?? p.day,
    chain: chainOfNetwork(p.network) ?? p.network,
    url: p.url,
    result: p.verdict,
    httpStatus: null,
    tx: p.tx,
    explorer: explorerFor(chainOfNetwork(p.network) ?? "", p.tx),
    amount: p.amount,
    asset: p.asset,
    payTo: p.payTo,
    record: p.json,
  });
  if (offer.asset && onChain.length && !assetsPaid.some((a) => sameAddress(a, offer.asset!))) {
    hits.push({
      reason: "asset_unseen",
      detail: `The asset in this 402 (${offer.asset}) is not one vet402 paid this seller in${network ? ` on ${network}` : ""} (${assetsPaid.join(", ")}, ${onChain.length} signed record${onChain.length === 1 ? "" : "s"}).`,
      evidence: onChain.slice(0, 5).map(ev),
    });
  }
  let priceReference: OfferComparison["priceReference"] = null;
  let ratio: number | null = null;
  const amount = offer.amount !== null && /^\d{1,78}$/.test(offer.amount) ? BigInt(offer.amount) : null;
  const sameAsset = (p: RecordedPayment) => (offer.asset ? sameAddress(p.asset, offer.asset) : assetsPaid.length === 1);
  const refs = onChain.filter((p) => sameUrl(p.url, offer.url) && sameAsset(p) && /^\d{1,78}$/.test(p.amount));
  if (refs.length) {
    const top = refs.reduce((m, p) => (BigInt(p.amount) > BigInt(m.amount) ? p : m));
    priceReference = { amount: top.amount, asset: top.asset, record: top.json, day: top.day, tx: top.tx };
    const ref = BigInt(top.amount);
    if (amount !== null && ref > 0n) {
      ratio = Math.round(Number((amount * 100n) / ref)) / 100;
      if (amount > ref * PRICE_JUMP_FACTOR)
        hits.push({
          reason: "price_jump",
          detail: `This 402 asks ${offer.amount} (atomic units of ${top.asset}), ${ratio} times the most vet402 paid for this URL (${top.amount} on ${top.day}, tx ${top.tx}).`,
          evidence: refs.slice(0, 5).map(ev),
        });
    }
  }
  return { hits, comparison: { amount: offer.amount, asset: offer.asset, chain: network, recordsRead: onChain.length, assetsPaid, priceReference, ratio } };
}

function chainOfNetwork(network: string): string | null {
  if (network === "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") return "solana";
  if (network.toLowerCase() === "eip155:8453") return "base";
  if (network.toLowerCase() === "eip155:4217") return "tempo";
  return null;
}

/** Read the payment part of a signed record (payment.network, payTo, asset, amount, transaction). */
export function paymentOfRecord(raw: unknown, json: string, day: string): RecordedPayment | null {
  if (!isObj(raw) || !isObj(raw.payment)) return null;
  const p = raw.payment;
  const id = str(raw.id);
  const network = str(p.network);
  const payTo = str(p.payTo);
  const asset = str(p.asset);
  const amount = str(p.amount);
  const tx = str(p.transaction);
  if (!id || !network || !payTo || !asset || !amount || !tx) return null;
  const req = isObj(raw.request) ? raw.request : {};
  const verdict = isObj(raw.verdict) ? str(raw.verdict.code) ?? "?" : "?";
  return { id, day, at: str(req.ts), url: str(raw.resourceUrl) ?? "", network, payTo, asset, amount, tx, verdict, json };
}

const RANK: Record<PolicyAction, number> = { allow: 0, warn: 1, ask_human: 2, block: 3 };

/** Check a policy given by a caller: known reasons, known actions. Throws on a typo. */
export function checkPolicy(policy: unknown): Policy {
  if (!isObj(policy)) throw new Error("policy must be an object such as { price_jump: \"block\" }");
  for (const [k, v] of Object.entries(policy)) {
    if (!(REASONS as readonly string[]).includes(k)) throw new Error(`policy: unknown reason ${JSON.stringify(k)}; reasons are ${REASONS.join(", ")}`);
    if (!(POLICY_ACTIONS as readonly string[]).includes(v as string)) throw new Error(`policy.${k}: ${JSON.stringify(v)} is not one of ${POLICY_ACTIONS.join(", ")}`);
  }
  return policy as Policy;
}

export interface PolicyDecision {
  /** The strictest action among the hits: block, then ask_human, then warn, then allow. */
  action: PolicyAction;
  hits: (ReasonHit & { action: PolicyAction })[];
}

/** Apply a policy to the reasons found. */
export function applyPolicy(policy: Policy, hits: ReasonHit[]): PolicyDecision {
  const withAction = hits.map((h) => ({ ...h, action: policy[h.reason] ?? ("allow" as const) }));
  const action = withAction.reduce<PolicyAction>((m, h) => (RANK[h.action] > RANK[m] ? h.action : m), "allow");
  return { action, hits: withAction };
}
