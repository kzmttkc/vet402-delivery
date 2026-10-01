/**
 * The hook at the payment: wrap the fetch an x402 or MPP client pays through, so every 402 is looked up
 * in vet402's public record before the client signs anything.
 *
 *     const fetchWithPay = wrapFetchWithPayment(wrapFetchWithCheck(fetch, { onCheck }), client);
 *
 * It goes under the payment wrapper: `@x402/fetch` calls the fetch it was given, and only when that
 * returns 402 does it create the payment. So the 402 reaches this code first. The hook reads the
 * challenge through a clone (the client still reads the body itself), runs check_before_paying for the
 * URL, each chain and payTo the 402 offers, hands the result to `onCheck`, and returns the 402 as it
 * came. It never sees a key or a signer and adds, removes or changes no header.
 *
 * Whether to go on is the caller's: to stop, throw from `onCheck` (the error reaches the caller of the
 * wrapped fetch and the payment is never created). Returning goes on.
 *
 * Or let the hook stop it: `{ block: "avoid" }` throws a CheckBlockedError, after `onCheck` (when given)
 * has seen the event, whenever any check for the 402 has the verdict "avoid" (verdict.ts, the same
 * function the CLI, the MCP tool and /v1/check read). Any, because the hook cannot know which of the
 * offered chains the client will pay on. "unknown", and a record that cannot be read, go on.
 *
 * A request that already carries a payment (X-PAYMENT, PAYMENT-SIGNATURE, or Authorization: Payment)
 * is the client's own retry and passes straight through, so one payment is looked up once.
 */
import { Challenge } from "mppx";
import { checkBeforePaying, normalizeChain, type CheckResult } from "./check.js";
import { PublicData } from "./sources.js";

export type WrappedFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** One way to pay that the 402 offers. */
export interface Offer {
  protocol: "x402" | "mpp";
  /** CAIP-2 network as the 402 writes it (x402), or the MPP method (tempo, ...). */
  network: string | null;
  /** rank.json's chain name, when the network is one vet402 buys on. */
  chain: string | null;
  payTo: string | null;
  amount: string | null;
  asset: string | null;
}

export interface CheckEvent {
  url: string;
  offers: Offer[];
  /** One check per distinct (chain, payTo) the 402 offers, or one for the URL alone when it offers none. */
  checks: CheckResult[];
  /** Set when vet402's record could not be read. */
  error: string | null;
}

export interface CheckHookOptions {
  /** Called with the facts before the client signs. Throw to stop the payment. */
  onCheck?: (event: CheckEvent) => void | Promise<void>;
  /** "avoid": stop before the client signs when the verdict for the seller is "avoid". */
  block?: "avoid";
  /** The public data to read (shared, cached). Default: a new PublicData over the public sources. */
  data?: PublicData;
}

const PAYMENT_HEADERS = ["x-payment", "payment-signature"];

function requestHeaders(input: RequestInfo | URL, init?: RequestInit): Headers | null {
  if (init?.headers !== undefined) return new Headers(init.headers);
  if (typeof input === "object" && input !== null && "headers" in input && input.headers instanceof Headers) return input.headers;
  return null;
}

/** Is this the client's retry, carrying a payment it has already made? */
export function carriesPayment(input: RequestInfo | URL, init?: RequestInit): boolean {
  if (init !== undefined && (init as Record<string, unknown>)["__is402Retry"] === true) return true;
  const h = requestHeaders(input, init);
  if (!h) return false;
  if (PAYMENT_HEADERS.some((n) => h.has(n))) return true;
  return /^\s*payment\s/i.test(h.get("authorization") ?? "");
}

function urlOf(input: RequestInfo | URL, response: Response): string {
  if (response.url) return response.url;
  if (typeof input === "object" && input !== null && "url" in input && typeof input.url === "string") return input.url;
  return String(input);
}

function chainOf(network: string | null): string | null {
  if (!network) return null;
  try {
    return normalizeChain(network);
  } catch {
    return null;
  }
}

const s = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);

function x402Offers(body: unknown): Offer[] {
  if (typeof body !== "object" || body === null) return [];
  const accepts = (body as { accepts?: unknown }).accepts;
  if (!Array.isArray(accepts)) return [];
  return accepts
    .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null)
    .map((a) => {
      const network = s(a.network);
      return { protocol: "x402" as const, network, chain: chainOf(network), payTo: s(a.payTo), amount: s(a.amount) ?? s(a.maxAmountRequired), asset: s(a.asset) };
    });
}

/** The ways to pay a 402 offers: x402 (PAYMENT-REQUIRED header or JSON body) and MPP (WWW-Authenticate: Payment). */
export async function readOffers(response: Response): Promise<Offer[]> {
  const offers: Offer[] = [];
  const header = response.headers.get("payment-required");
  if (header) {
    try {
      offers.push(...x402Offers(JSON.parse(Buffer.from(header, "base64").toString("utf8"))));
    } catch {
      // not a readable x402 header
    }
  }
  if (!offers.length) {
    try {
      const text = await response.clone().text();
      if (text.trim()) offers.push(...x402Offers(JSON.parse(text)));
    } catch {
      // not JSON
    }
  }
  if (response.headers.get("www-authenticate")) {
    try {
      const c = Challenge.fromHeaders(response.headers) as { method?: string; request?: Record<string, unknown> };
      const req = c.request ?? {};
      const method = s(c.method);
      offers.push({ protocol: "mpp", network: method, chain: chainOf(method), payTo: s(req.recipient), amount: s(req.amount), asset: s(req.currency) });
    } catch {
      // no Payment challenge
    }
  }
  return offers;
}

/** Thrown by the hook with `block: "avoid"`: the payment was never created. */
export class CheckBlockedError extends Error {
  readonly url: string;
  readonly check: CheckResult;
  constructor(url: string, check: CheckResult) {
    const page = check.sellers.find((f) => f.key === check.basis?.seller)?.sellerPage;
    super(`Stopped before paying: vet402's verdict for this seller is "avoid". ${check.why}${page ? ` Details: ${page}` : ""}`);
    this.name = "CheckBlockedError";
    this.url = url;
    this.check = check;
  }
}

/** Wrap a fetch so each 402 is looked up in vet402's public record before the payment is created. */
export function wrapFetchWithCheck(innerFetch: WrappedFetch, options: CheckHookOptions): WrappedFetch {
  if (!options.onCheck && !options.block) throw new Error("wrapFetchWithCheck: give onCheck, block: \"avoid\", or both");
  if (options.block !== undefined && options.block !== "avoid") throw new Error(`wrapFetchWithCheck: block must be "avoid", not ${JSON.stringify(options.block)}`);
  const data = options.data ?? new PublicData();
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const response = await innerFetch(input, init);
    if (response.status !== 402 || carriesPayment(input, init)) return response;
    const url = urlOf(input, response);
    const offers = await readOffers(response);
    const asks = new Map<string, { chain?: string; payTo?: string }>();
    for (const o of offers) if (o.chain || o.payTo) asks.set(`${o.chain ?? ""}|${o.payTo ?? ""}`, { ...(o.chain ? { chain: o.chain } : {}), ...(o.payTo ? { payTo: o.payTo } : {}) });
    if (!asks.size) asks.set("", {});
    const event: CheckEvent = { url, offers, checks: [], error: null };
    try {
      for (const a of asks.values()) event.checks.push(await checkBeforePaying({ url, ...a }, data));
    } catch (e) {
      event.error = e instanceof Error ? e.message : String(e);
    }
    if (options.onCheck) await options.onCheck(event);
    if (options.block === "avoid") {
      const hit = event.checks.find((c) => c.verdict === "avoid");
      if (hit) throw new CheckBlockedError(url, hit);
    }
    return response;
  };
}
