/**
 * GET /v1/buy?url=<seller endpoint>: vet402 buys the seller's answer for the agent.
 * GET /v1/buy/records/<id>: the record of one purchase (public, no account).
 *
 * The unpaid request is free: vet402 reads the seller's 402, checks it, and answers 402 with the price
 * (seller price + fee) on every chain it can pay that seller on: an x402 PAYMENT-REQUIRED header for
 * Solana, an MPP WWW-Authenticate challenge for Tempo. The agent pays on one of them; vet402 pays the
 * seller on the same chain.
 *
 * With the flag off, nothing is quoted, verified, settled, written or paid (503).
 */
import { BUY_PATH, QUOTES_PER_MINUTE, RECORD_PATH_PREFIX } from "./constants.js";
import type { Allowlist } from "./allowlist.js";
import type { Books } from "./books.js";
import { quote, type Quote, type QuoteDeps, type Refused } from "./quote.js";
import { paySolana, paymentRequiredHeader, solanaPriceInfo, solanaRequirements, type PaidAnswer, type SolanaSide } from "./solana.js";
import { payTempo, tempoPriceInfo, tempoRoute, type TempoSide } from "./tempo.js";
import { atomicToUsdc } from "../constants.js";
import { OFFER_TTL_SECONDS } from "./constants.js";

export interface ProxyBuyOptions {
  enabled: boolean;
  /** e.g. https://buy.example.com (used in record links and the x402 resource URL). */
  publicOrigin: string;
  feeAtomic: bigint;
  allowlist: Allowlist;
  books: Books;
  quoteDeps: Omit<QuoteDeps, "allowlist">;
  solana?: SolanaSide;
  tempo?: TempoSide;
  now?: () => Date;
  quotesPerMinute?: number;
}

export interface ProxyBuy {
  handle(req: Request): Promise<Response>;
}

class Limiter {
  private readonly seen = new Map<string, { start: number; count: number }>();
  constructor(private readonly perMinute: number, private readonly now: () => number) {}
  take(key: string): boolean {
    const t = this.now();
    const w = this.seen.get(key);
    if (!w || t - w.start >= 60_000) {
      this.seen.delete(key);
      this.seen.set(key, { start: t, count: 1 });
      if (this.seen.size > 10_000) this.seen.delete(this.seen.keys().next().value!);
      return true;
    }
    w.count += 1;
    return w.count <= this.perMinute;
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

function clientIp(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
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
  const limiter = new Limiter(o.quotesPerMinute ?? QUOTES_PER_MINUTE, () => now().getTime());
  const recordUrl = (id: string) => `${o.publicOrigin}${RECORD_PATH_PREFIX}${id}`;
  const quoteDeps: QuoteDeps = {
    ...o.quoteDeps,
    allowlist: o.allowlist,
    solanaPayer: o.solana ? o.quoteDeps.solanaPayer : null,
    tempoPayer: o.tempo ? o.quoteDeps.tempoPayer : null,
    now,
  };

  async function unpaid(req: Request, target: string | null): Promise<Response> {
    const q = await quote(target, quoteDeps);
    if ("ok" in q && q.ok === false) return refusedResponse(q);
    const qq = q as Quote;
    const headers: Record<string, string> = { "cache-control": "no-store" };
    const offers: Record<string, unknown> = {};
    if (qq.solana.ok && o.solana) {
      try {
        const reqs = await solanaRequirements(solCtx(), qq.solana, qq.target);
        headers["PAYMENT-REQUIRED"] = await paymentRequiredHeader(solCtx(), reqs, description(qq.target));
        offers.solana = solanaPriceInfo(qq.solana, o.feeAtomic);
      } catch (e) {
        offers.solana = { refused: "facilitator_unavailable", detail: String((e as Error).message ?? e).slice(0, 200) };
      }
    } else {
      offers.solana = qq.solana.ok ? { refused: "chain_not_offered" } : { refused: qq.solana.reason, detail: qq.solana.detail };
    }
    if (qq.tempo.ok && o.tempo) {
      const route = tempoRoute(qq.tempo, o.feeAtomic, qq.target);
      const expires = new Date(now().getTime() + OFFER_TTL_SECONDS * 1000).toISOString();
      const ch = await o.tempo.mpp.challenge(req, { ...route, expires });
      const www = ch.headers.get("www-authenticate");
      if (ch.status === 402 && www) {
        headers["www-authenticate"] = www;
        offers.tempo = tempoPriceInfo(qq.tempo, o.feeAtomic);
      } else {
        offers.tempo = { refused: "challenge_unavailable", detail: `mppx answered ${ch.status}` };
      }
    } else {
      offers.tempo = qq.tempo.ok ? { refused: "chain_not_offered" } : { refused: qq.tempo.reason, detail: qq.tempo.detail };
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
          refund: "none",
          stops: "vet402 does not pay the seller (and you are not charged) when the seller's price or payTo changes before your payment settles, or when vet402's daily cap or balance would be passed",
        },
      },
      headers,
    );
  }

  function solCtx() {
    return { side: o.solana!, books: o.books, feeAtomic: o.feeAtomic, now, recordUrl, resourceUrl: `${o.publicOrigin}${BUY_PATH}` };
  }
  function tempoCtx() {
    return { side: o.tempo!, books: o.books, feeAtomic: o.feeAtomic, now, recordUrl };
  }

  async function paid(target: string | null, pay: { chain: "solana"; header: string } | { chain: "tempo"; header: string }): Promise<Response> {
    const q = await quote(target, quoteDeps);
    if ("ok" in q && q.ok === false) return refusedResponse(q);
    const qq = q as Quote;
    if (pay.chain === "solana") {
      if (!o.solana) return json(400, { verdict: "REFUSE", reason: "chain_not_offered", detail: "Solana is not configured", charged: false });
      if (!qq.solana.ok) return refusedResponse(qq.solana);
      return toResponse(await paySolana(solCtx(), qq.target, qq.solana, pay.header));
    }
    if (!o.tempo) return json(400, { verdict: "REFUSE", reason: "chain_not_offered", detail: "Tempo is not configured", charged: false });
    if (!qq.tempo.ok) return refusedResponse(qq.tempo);
    return toResponse(await payTempo(tempoCtx(), qq.target, qq.tempo, pay.header));
  }

  return {
    async handle(req) {
      const u = new URL(req.url);
      if (u.pathname.startsWith(RECORD_PATH_PREFIX) && req.method === "GET") {
        const id = u.pathname.slice(RECORD_PATH_PREFIX.length);
        if (!/^[0-9a-f]{32}$/.test(id)) return json(404, { error: "not_found" });
        const r = o.books.getRecord(id);
        return r ? json(200, r, { "access-control-allow-origin": "*" }) : json(404, { error: "not_found" });
      }
      if (u.pathname !== BUY_PATH) return json(404, { error: "not_found" });
      if (req.method !== "GET") return json(405, { verdict: "REFUSE", reason: "method_not_allowed", detail: "use GET", charged: false });
      if (!o.enabled) return json(503, { verdict: "REFUSE", reason: "proxy_buy_disabled", detail: "proxy buy is switched off; nothing was charged", charged: false });
      // Every request below reads the seller's 402 at least once: limit them per client.
      if (!limiter.take(clientIp(req))) return json(429, { verdict: "REFUSE", reason: "rate_limited", detail: `at most ${o.quotesPerMinute ?? QUOTES_PER_MINUTE} requests per minute`, charged: false });
      const target = u.searchParams.get("url");
      const x402 = req.headers.get("payment-signature") ?? req.headers.get("x-payment");
      if (x402) return paid(target, { chain: "solana", header: x402 });
      const auth = req.headers.get("authorization");
      if (auth && /^Payment\s/i.test(auth)) return paid(target, { chain: "tempo", header: auth });
      return unpaid(req, target);
    },
  };
}

function description(target: string): string {
  return `vet402 buys ${target} for you: seller price + fee, answer returned as-is, no refund`;
}
