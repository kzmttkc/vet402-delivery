/**
 * GET /v1/check?url=<seller URL>[&chain=<name|CAIP-2>][&payTo=<address>][&format=json|html]
 *
 * The free check over HTTP, for any language and for the site's form. No key, no payment, no write. It
 * reads only the data the caller hands it (api/check.ts: site/rank.json and data/records/index.json
 * bundled with the function), never the network.
 *
 * The answer starts with `verdict` (pay, avoid or unknown) and `why` (one English sentence), both from
 * verdict.ts, the function the CLI, the MCP tool and the fetch hook read. The numbers in `why` are the
 * fields right after it (`tried`, `settled`, `counted`, `answered`, `days`, `notCounted`).
 */
import { CHECK_ENDPOINT, checkForm, escapeHtml, publicPage } from "../../../src/rank/html.js";
import { checkBody } from "./body.js";
import { lookup, normalizeChain } from "./check.js";
import { PUBLIC_SITE_URL } from "./sources.js";
import { VERDICTS } from "./verdict.js";

export { checkBody };

export interface CheckData {
  rank: unknown;
  recordsIndex: unknown;
  /** data/evm/arbitrum.json and robinhood.json. */
  lanes?: unknown[];
}

/**
 * Called once per answered GET, before the answer is returned. It must not hold the answer up or break it:
 * handleCheck waits for it at most USE_WAIT_MS and ignores its errors (the count is lost, the answer is not).
 */
export type OnUse = (request: Request) => Promise<void> | void;
export const USE_WAIT_MS = 150;

async function countUse(onUse: OnUse | undefined, request: Request): Promise<void> {
  if (!onUse) return;
  try {
    const p = Promise.resolve(onUse(request)).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([p, new Promise<void>((resolve) => (timer = setTimeout(resolve, USE_WAIT_MS)))]);
    if (timer) clearTimeout(timer);
  } catch {
    // fail open: a broken counter never changes the answer
  }
}

export const MAX_URL_LENGTH = 2048;
export const MAX_PAYTO_LENGTH = 128;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};
/** The data changes only with a deploy (a push to main); a few minutes of caching is safe. */
const CACHE = "public, max-age=60, s-maxage=300";
const HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; script-src 'none'; base-uri 'none'; form-action 'self' https://vet402-delivery.vercel.app; frame-ancestors 'none'";

export class BadRequest extends Error {}

export interface CheckQuery {
  url: string;
  chain: string | null;
  payTo: string | null;
  format: "json" | "html";
}

/** Read and check the query: https only, length caps, a chain vet402 knows, a payTo of plain characters. */
export function parseQuery(params: URLSearchParams): CheckQuery {
  const format = params.get("format") ?? "json";
  if (format !== "json" && format !== "html") throw new BadRequest('format must be "json" or "html".');
  const raw = (params.get("url") ?? "").trim();
  if (!raw) throw new BadRequest("Add the seller URL: /v1/check?url=https://api.example.com/paid/endpoint");
  if (raw.length > MAX_URL_LENGTH) throw new BadRequest(`The URL is longer than ${MAX_URL_LENGTH} characters.`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new BadRequest("That is not a URL. Paste the full address, starting with https://");
  }
  if (u.protocol !== "https:") throw new BadRequest("Only https URLs can be checked.");
  if (u.username || u.password) throw new BadRequest("Remove the user name or password from the URL.");
  if (!u.hostname) throw new BadRequest("The URL has no host.");
  const chainRaw = params.get("chain")?.trim() || null;
  let chain: string | null = null;
  if (chainRaw) {
    if (chainRaw.length > 80) throw new BadRequest("chain is too long.");
    try {
      chain = normalizeChain(chainRaw);
    } catch {
      throw new BadRequest("chain must be solana, tempo, base, algorand, arbitrum, robinhood or a CAIP-2 id such as eip155:8453.");
    }
  }
  const payTo = params.get("payTo")?.trim() || params.get("pay_to")?.trim() || null;
  if (payTo && (payTo.length > MAX_PAYTO_LENGTH || !/^[A-Za-z0-9]+$/.test(payTo))) throw new BadRequest("payTo must be an address of letters and digits.");
  return { url: u.href, chain, payTo, format };
}

function json(status: number, body: unknown, cache = CACHE): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache, "x-content-type-options": "nosniff", ...CORS },
  });
}

function html(status: number, page: string, cache = CACHE): Response {
  return new Response(page, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": cache, "x-content-type-options": "nosniff", "content-security-policy": HTML_CSP, ...CORS },
  });
}

const VERDICT_TEXT: Record<(typeof VERDICTS)[number], string> = {
  pay: "pay: most of vet402's paid purchases from this seller came back with an answer",
  avoid: "avoid: vet402 paid this seller, and most of those payments got no usable answer",
  unknown: "unknown: not enough to tell",
};

function htmlPage(q: CheckQuery | null, body: ReturnType<typeof checkBody> | null, error: string | null): string {
  const back = `<p class="meta"><a href="${escapeHtml(PUBLIC_SITE_URL)}/">All sellers vet402 bought from</a> · <a href="${escapeHtml(PUBLIC_SITE_URL)}/method.html">How vet402 measures</a></p>`;
  const form = checkForm(CHECK_ENDPOINT, q?.url ?? "", body ? "Check another seller" : "Try again");
  if (!body) {
    return publicPage("vet402: check a seller", "Check an API seller in vet402's record before paying it.", `<h1>Check a seller before you pay</h1>\n<p class="warn">${escapeHtml(error ?? "Something went wrong.")}</p>\n${form}\n${back}\n`);
  }
  const row = (k: string, v: string) => `<tr><td>${escapeHtml(k)}</td><td>${v}</td></tr>`;
  const rows = [
    row("Seller", body.seller ? `<span class="mono">${escapeHtml(body.seller)}</span>` : "none in the record"),
    row("Chains", escapeHtml(body.chains.join(", ") || "none")),
    ...(body.held && body.tried === 0
      ? [row("Held", `${body.held} purchase${body.held === 1 ? "" : "s"}, shown after the seller is told`)]
      : [
          row("Tried / settled", `${body.tried} / ${body.settled}`),
          row("Came back with an answer / paid calls that count", `${body.answered} / ${body.counted}`),
          row("Not counted against the seller", String(body.notCounted)),
          row("Days with paid calls that count", String(body.days)),
          ...(body.held ? [row("Held", `${body.held} more, shown after the seller is told`)] : []),
        ]),
    body.newest
      ? row(
          "Newest purchase",
          `${escapeHtml(body.newest.at)} · ${escapeHtml(body.newest.chain)} · <span class="mono">${escapeHtml(body.newest.result)}</span>${body.newest.httpStatus !== null ? ` · HTTP ${body.newest.httpStatus}` : ""}${body.newest.explorer ? ` · <a href="${escapeHtml(body.newest.explorer)}" rel="noopener noreferrer nofollow">tx</a>` : ""}`,
        )
      : "",
    body.records.newest[0] ? row("Newest signed record", `<a href="${escapeHtml(body.records.newest[0].page)}">${escapeHtml(body.records.newest[0].id)}</a> (${escapeHtml(body.records.newest[0].verdict)}, ${body.records.published} published)`) : "",
    row("As of", `rank.json ${escapeHtml(body.asOf.rankDate ?? "?")}, ${body.asOf.recordsPublished} signed records`),
  ].filter(Boolean);
  const content = `<h1>Check a seller before you pay</h1>
<p class="mono">${escapeHtml(body.url)}</p>
<p class="big">${escapeHtml(VERDICT_TEXT[body.verdict])}</p>
<p class="lead">${escapeHtml(body.why)}</p>
<table>${rows.join("")}</table>
${body.sellerPage ? `<p><a href="${escapeHtml(body.sellerPage)}">Every purchase vet402 made from this seller</a></p>` : ""}
<p class="meta">${escapeHtml(body.rule)}</p>
${form}
${back}
`;
  return publicPage(`vet402 check: ${body.verdict}`, "Check an API seller in vet402's record before paying it.", content);
}

/**
 * Answer one request. `load` returns the bundled data (cached by the caller); it may throw. `onUse` counts
 * the call (api/check.ts: src/usage/); it never changes the answer.
 */
export async function handleCheck(request: Request, load: () => CheckData, onUse?: OnUse): Promise<Response> {
  const res = answerCheck(request, load);
  if (request.method === "GET" || request.method === "HEAD") await countUse(onUse, request);
  return res;
}

function answerCheck(request: Request, load: () => CheckData): Response {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, "cache-control": "public, max-age=86400" } });
  if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "method_not_allowed", message: "Use GET." }, "no-store");
  const params = new URL(request.url).searchParams;
  const wantsHtml = params.get("format") === "html";
  let q: CheckQuery;
  try {
    q = parseQuery(params);
  } catch (e) {
    const message = e instanceof BadRequest ? e.message : "The request could not be read.";
    return wantsHtml ? html(400, htmlPage(null, null, message), "no-store") : json(400, { error: "bad_request", message }, "no-store");
  }
  let data: CheckData;
  try {
    data = load();
  } catch {
    const message = "vet402's record could not be read right now. Try again in a minute.";
    return q.format === "html" ? html(503, htmlPage(q, null, message), "no-store") : json(503, { error: "data_unavailable", message }, "no-store");
  }
  const r = lookup(data.rank, data.recordsIndex, { url: q.url, ...(q.chain ? { chain: q.chain } : {}), ...(q.payTo ? { payTo: q.payTo } : {}) }, [], data.lanes ?? []);
  const body = checkBody(r);
  const res = q.format === "html" ? html(200, htmlPage(q, body, null)) : json(200, body);
  return request.method === "HEAD" ? new Response(null, { status: res.status, headers: res.headers }) : res;
}
