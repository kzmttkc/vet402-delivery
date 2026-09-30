/**
 * GET /v1/buy?url=<seller endpoint>: vet402 buys the seller's answer for the agent.
 * GET /v1/buy/records/<id> (or /v1/buy?record=<id>): the record of one purchase (public, no account).
 *
 * The unpaid request is free: vet402 reads the seller's 402, checks it, and answers 402 with the price (seller
 * price + fee) on every chain it can pay that seller on: an x402 PAYMENT-REQUIRED header for Solana, an MPP
 * WWW-Authenticate challenge for Tempo. The agent pays on one of them; vet402 pays the seller on the same chain.
 *
 * Before a paid request is taken: purchases that stopped half way (a function killed at its time limit, an
 * outcome not known) are reconciled first (reconcile.ts). While one of them still cannot be settled, new paid
 * requests from the same agent or to the same seller are refused (503, nothing charged).
 * With the flag off, nothing is quoted, verified, settled, written or paid (503). Tempo needs its own flag as well
 * (`tempoEnabled`): without it no Tempo price is offered and a Tempo payment is refused (503).
 * Requests per client are counted in the database, so the limit holds across serverless instances.
 */
import { createHash } from "node:crypto";
import { decodePaymentSignatureHeader } from "@x402/core/http";
import { Credential } from "mppx";
import { BUY_PATH, OFFER_TTL_SECONDS, QUOTES_PER_MINUTE, RECORD_PATH_PREFIX, REFUND_POLICY } from "./constants.js";
import type { Allowlist } from "./allowlist.js";
import type { DayCaps, Store } from "./store.js";
import { quote, type Quote, type QuoteDeps, type Refused } from "./quote.js";
import { paySolana, paymentRequiredHeader, solanaPriceInfo, solanaRequirements, type SolanaSide } from "./solana.js";
import { payTempo, tempoPriceInfo, tempoRoute, type TempoSide } from "./tempo.js";
import type { PaidAnswer } from "./flow.js";
import { reconcile } from "./reconcile.js";
import { atomicToUsdc } from "../constants.js";

export interface ProxyBuyOptions {
  enabled: boolean;
  /**
   * Tempo is taken only when this is true (VET402_PROXY_TEMPO_ENABLED=1): off, a Tempo payment is refused with 503
   * and no Tempo price is offered, even with Tempo configured.
   */
  tempoEnabled?: boolean;
  /** e.g. https://buy.example.com (used in record links and the x402 resource URL). */
  publicOrigin: string;
  feeAtomic: bigint;
  allowlist: Allowlist;
  store: Store;
  caps: { solana?: DayCaps; tempo?: DayCaps };
  maxRefund: bigint;
  quoteDeps: Omit<QuoteDeps, "allowlist">;
  solana?: SolanaSide;
  tempo?: TempoSide;
  now?: () => Date;
  quotesPerMinute?: number;
  /** How long one request may keep waiting on chains (below the platform's function limit). */
  requestBudgetMs?: number;
  /** A non-final purchase older than this is taken to be abandoned and goes to the reconciler. */
  staleMs?: number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** At most one reconcile turn per this many ms across instances before paid requests (0: every request). */
  reconcileGateMs?: number;
}

/** Default spacing of the reconcile turns that paid requests trigger (the cron runs every five minutes anyway). */
export const RECONCILE_GATE_MS = 30_000;

export interface ProxyBuy {
  handle(req: Request): Promise<Response>;
}

/** vercel.json gives api/buy.ts a maxDuration of 300 s; a request stops waiting on chains well before it. */
export const DEFAULT_REQUEST_BUDGET_MS = 240_000;
export const DEFAULT_STALE_MS = 330_000;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

/** The client address as the platform reports it (Vercel sets x-real-ip; the node adapter overwrites it with the socket address). */
function clientIp(req: Request): string {
  return req.headers.get("x-real-ip")?.trim() || req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function toResponse(a: PaidAnswer): Response {
  if (a.kind === "answer") return new Response(a.body as BodyInit, { status: a.status, headers: { "cache-control": "no-store", ...a.headers } });
  return json(a.status, a.body, a.headers ?? {});
}

function refusedResponse(r: Refused): Response {
  return json(r.status, { verdict: "REFUSE", reason: r.reason, detail: r.detail, charged: false });
}

export function createProxyBuy(o: ProxyBuyOptions): ProxyBuy {
  const now = o.now ?? (() => new Date());
  const perMinute = o.quotesPerMinute ?? QUOTES_PER_MINUTE;
  const tempo = o.tempoEnabled === true ? o.tempo : undefined;
  /** Requests per client per minute, counted in the database (every serverless instance sees one count). */
  const allowed = async (req: Request): Promise<boolean> => {
    const t = now();
    const ip = createHash("sha256").update(`vet402-buy-rate:${clientIp(req)}`).digest("hex").slice(0, 32);
    return o.store.bump(`rate:${ip}:${Math.floor(t.getTime() / 60_000)}`, perMinute, t);
  };
  const recordUrl = (id: string) => `${o.publicOrigin}${RECORD_PATH_PREFIX}${id}`;
  const quoteDeps: QuoteDeps = {
    ...o.quoteDeps,
    allowlist: o.allowlist,
    solanaPayer: o.solana ? o.quoteDeps.solanaPayer : null,
    tempoPayer: tempo ? o.quoteDeps.tempoPayer : null,
    now,
  };
  const staleMs = o.staleMs ?? DEFAULT_STALE_MS;
  const common = (caps: DayCaps) => ({
    store: o.store,
    feeAtomic: o.feeAtomic,
    now,
    recordUrl,
    caps,
    maxRefund: o.maxRefund,
    deadline: Date.now() + (o.requestBudgetMs ?? DEFAULT_REQUEST_BUDGET_MS),
    staleMs,
    ...(o.sleep ? { sleep: o.sleep } : {}),
    ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
  });
  const solCtx = () => ({ ...common(o.caps.solana!), side: o.solana!, resourceUrl: `${o.publicOrigin}${BUY_PATH}` });
  const tempoCtx = () => ({ ...common(o.caps.tempo!), side: tempo! });

  async function unpaid(req: Request, target: string | null): Promise<Response> {
    const q = await quote(target, quoteDeps);
    if ("ok" in q && q.ok === false) return refusedResponse(q);
    const qq = q as Quote;
    const headers: Record<string, string> = { "cache-control": "no-store" };
    const offers: Record<string, unknown> = {};
    if (qq.solana.ok && o.solana) {
      try {
        const c = { side: o.solana, feeAtomic: o.feeAtomic, resourceUrl: `${o.publicOrigin}${BUY_PATH}` };
        const reqs = await solanaRequirements(c, qq.solana, qq.target);
        headers["PAYMENT-REQUIRED"] = await paymentRequiredHeader(c, reqs, `vet402 buys ${new URL(qq.target).origin} for you: seller price + fee, answer returned as-is`);
        offers.solana = solanaPriceInfo(qq.solana, o.feeAtomic);
      } catch {
        offers.solana = { refused: "facilitator_unavailable", detail: "the facilitator could not be read" };
      }
    } else {
      offers.solana = qq.solana.ok ? { refused: "chain_not_offered" } : { refused: qq.solana.reason, detail: qq.solana.detail };
    }
    if (qq.tempo.ok && tempo) {
      const route = tempoRoute(qq.tempo, o.feeAtomic, qq.target);
      const expires = new Date(now().getTime() + OFFER_TTL_SECONDS * 1000).toISOString();
      const ch = await tempo.mpp.challenge(req, { ...route, expires });
      const www = ch.headers.get("www-authenticate");
      if (ch.status === 402 && www) {
        headers["www-authenticate"] = www;
        offers.tempo = tempoPriceInfo(qq.tempo, o.feeAtomic);
      } else {
        offers.tempo = { refused: "challenge_unavailable", detail: `mppx answered ${ch.status}` };
      }
    } else {
      offers.tempo = qq.tempo.ok || (o.tempo && !tempo) ? { refused: "chain_not_offered" } : { refused: qq.tempo.reason, detail: qq.tempo.detail };
    }
    if (!headers["PAYMENT-REQUIRED"] && !headers["www-authenticate"]) {
      return json(422, { verdict: "REFUSE", reason: "no_payable_offer", target: qq.target, offers, charged: false });
    }
    return json(
      402,
      {
        buy: {
          target: qq.target,
          what: "vet402 pays this seller from its own wallet after your payment settles, and returns the seller's answer with both transactions and a public record",
          fee: atomicToUsdc(o.feeAtomic),
          offers,
          refund: REFUND_POLICY,
          stops: "you are not charged when the seller's price or payTo changes before your payment settles, or when vet402's daily cap or balance would be passed",
        },
      },
      headers,
    );
  }

  /**
   * Purchases that stopped half way: give the reconciler a short, bounded turn before a paid request. This never
   * refuses the request by itself: a purchase that cannot be settled yet holds up only new requests from the same
   * agent or to the same seller (solana.ts / tempo.ts), so one stuck purchase cannot stop the service.
   */
  async function reconcileSome(): Promise<void> {
    if ((await o.store.stale(now(), staleMs, 1)).length === 0) return;
    // At most one such turn per window across all instances: paid requests cannot multiply the chain reads.
    const gate = o.reconcileGateMs ?? RECONCILE_GATE_MS;
    if (gate > 0 && !(await o.store.bump(`reconcile-gate:${Math.floor(now().getTime() / gate)}`, 1, now()).catch(() => false))) return;
    // With Tempo off, nothing Tempo is read, even for rows written while it was on. The wallet check is the cron's.
    const ctx = {
      ...common(o.caps.solana ?? o.caps.tempo!),
      ...(o.solana ? { solana: o.solana } : {}),
      ...(tempo ? { tempo } : {}),
      deadline: Date.now() + 20_000,
      limit: 5,
      maxTxReads: 200,
      walletCheck: false,
    };
    await reconcile(ctx).catch(() => []);
  }

  /** Whether the payment header can be read at all (a cheap decode, before anything reads a chain). */
  function readable(pay: { chain: "solana" | "tempo"; header: string }): boolean {
    try {
      if (pay.chain === "solana") decodePaymentSignatureHeader(pay.header);
      else Credential.deserialize(pay.header);
      return true;
    } catch {
      return false;
    }
  }

  async function paid(target: string | null, pay: { chain: "solana" | "tempo"; header: string }): Promise<Response> {
    if (pay.chain === "tempo" && !tempo) {
      return json(503, { verdict: "REFUSE", reason: "tempo_disabled", detail: "proxy buy on Tempo is switched off; nothing was charged", charged: false });
    }
    const q = await quote(target, quoteDeps);
    if ("ok" in q && q.ok === false) return refusedResponse(q);
    const qq = q as Quote;
    // The reconciler's turn comes only after the payment header is readable and the seller was priced.
    if (readable(pay)) await reconcileSome();
    if (pay.chain === "solana") {
      if (!o.solana || !o.caps.solana) return json(400, { verdict: "REFUSE", reason: "chain_not_offered", detail: "Solana is not configured", charged: false });
      if (!qq.solana.ok) return refusedResponse(qq.solana);
      return toResponse(await paySolana(solCtx(), qq.target, qq.solana, pay.header));
    }
    if (!tempo || !o.caps.tempo) return json(400, { verdict: "REFUSE", reason: "chain_not_offered", detail: "Tempo is not configured", charged: false });
    if (!qq.tempo.ok) return refusedResponse(qq.tempo);
    return toResponse(await payTempo(tempoCtx(), qq.target, qq.tempo, pay.header));
  }

  async function record(id: string): Promise<Response> {
    if (!/^[0-9a-f]{32}$/.test(id)) return json(404, { error: "not_found" });
    const r = await o.store.getRecord(id);
    return r ? json(200, r, { "access-control-allow-origin": "*" }) : json(404, { error: "not_found" });
  }

  return {
    async handle(req) {
      const u = new URL(req.url);
      const path = u.pathname === "/api/buy" ? BUY_PATH : u.pathname;
      if (req.method === "GET" && path.startsWith(RECORD_PATH_PREFIX)) return record(path.slice(RECORD_PATH_PREFIX.length));
      if (req.method === "GET" && path === BUY_PATH && u.searchParams.has("record")) return record(u.searchParams.get("record") ?? "");
      if (path !== BUY_PATH) return json(404, { error: "not_found" });
      if (req.method !== "GET") return json(405, { verdict: "REFUSE", reason: "method_not_allowed", detail: "use GET", charged: false });
      if (!o.enabled) return json(503, { verdict: "REFUSE", reason: "proxy_buy_disabled", detail: "proxy buy is switched off; nothing was charged", charged: false });
      // Every request below reads the seller's 402 at least once: limit them per client.
      let ok: boolean;
      try {
        ok = await allowed(req);
      } catch {
        return json(503, { verdict: "REFUSE", reason: "busy", detail: "try again shortly; nothing was charged", charged: false });
      }
      if (!ok) return json(429, { verdict: "REFUSE", reason: "rate_limited", detail: `at most ${o.quotesPerMinute ?? QUOTES_PER_MINUTE} requests per minute`, charged: false });
      const target = u.searchParams.get("url");
      const x402 = req.headers.get("payment-signature") ?? req.headers.get("x-payment");
      if (x402) return paid(target, { chain: "solana", header: x402 });
      const auth = req.headers.get("authorization");
      if (auth && /^Payment\s/i.test(auth)) return paid(target, { chain: "tempo", header: auth });
      return unpaid(req, target);
    },
  };
}
