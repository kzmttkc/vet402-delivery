/**
 * The request an EVM lane sends, filled the way the Solana and Tempo purchases are (src/inputs/, 2026-09-30),
 * and the reading of a paid answer that says vet402's request was wrong. Pure: no network, no files.
 *
 * Filling, before anything is paid (the payTo and the price lock never change; the live 402 is read again for
 * the filled request):
 *   path    a segment the catalog left as a slot (":username", "{id}", "<id>") takes the concrete value the
 *           listing gives for it: the query value of the same name, else the listing's own pathParams example
 *   query / body  src/inputs/fill.ts fillParams against the listing's declared input (src/inputs/spec.ts
 *           fromBazaar): placeholders, required parameters left out, and, when nothing is sent, the seller's
 *           own documented defaults
 * A listing whose path slot cannot be filled is not bought. A listing whose earlier paid answer was 400, 404 or
 * 422 is not bought again unless the fill changed the request (vet402 has nothing better to send).
 *
 * Why: on 2026-09-30 the Arbitrum and Robinhood lanes sent "/v1/user/:username" (404), ":netuid" (422), a GET
 * without the required `query` (400) and an empty JSON object to an endpoint that needs a token (400, after the
 * payment settled). Those answers are vet402's request, not the seller.
 */
import type { Listing } from "../discovery.js";
import { fillParams, isPlaceholder, type FilledParam } from "../inputs/fill.js";
import { fromBazaar } from "../inputs/spec.js";
import { laneRequestKey, type ChainBuyRecord } from "./evm-buy.js";

export interface LaneRequest {
  resource: string;
  method: "GET" | "POST";
  query: Record<string, string> | null;
  body: unknown;
}

export type LaneRepair =
  | { ok: true; changed: boolean; request: LaneRequest; filled: FilledParam[]; declaredParams: string[]; datedParams: string[]; requestKey: string }
  | { ok: false; reason: string; param: string | null };

/** HTTP statuses of a paid answer that point at the request rather than the seller. */
export const INPUT_STATUSES: ReadonlySet<number> = new Set([400, 404, 422]);

/** A path segment that is a slot, and the parameter name in it. */
export function pathSlot(segment: string): string | null {
  let d = segment;
  try {
    d = decodeURIComponent(segment);
  } catch {
    /* keep raw */
  }
  const m = /^:([A-Za-z_][A-Za-z0-9_-]*)$/.exec(d) ?? /^\{([A-Za-z_][A-Za-z0-9_-]*)\}$/.exec(d) ?? /^<([^<>]+)>$/.exec(d);
  if (m) return m[1]!;
  return d === "*" ? "*" : null;
}

/** The first path slot in a URL, or null. */
export function pathPlaceholderIn(url: string): string | null {
  let p: string;
  try {
    p = new URL(url).pathname;
  } catch {
    return null;
  }
  for (const s of p.split("/")) {
    const n = pathSlot(s);
    if (n) return n;
  }
  return null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function concreteScalar(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && !isPlaceholder(v) && !pathSlot(v) && v.length <= 200) return v;
  return null;
}

/** vet402's last paid answer to one listing (looked up by the catalog URL): its status and the request it sent. */
export interface LastPaid {
  status: number | null;
  /** laneRequestKey of the request sent; null on records from before 2026-10-01 (they sent the catalog's request unfilled). */
  requestKey: string | null;
  /** When it was bought (ISO). */
  at: string | null;
  /** The 4xx was read as vet402's own wrong request (laneInputProblem). Otherwise it is the seller's answer. */
  inputError: boolean;
}

/**
 * Pure. vet402's newest paid answer per listing, by the catalog's URL (listingResource; older records sent the
 * catalog URL itself), across every lane file given: the newest `at` wins whatever file it came from (arbitrum and
 * base-compare buy the same listing). inputError is read the same way the pages read it (laneInputProblem).
 */
export function lastPaidByListing(rows: readonly ChainBuyRecord[]): Map<string, LastPaid> {
  const m = new Map<string, LastPaid>();
  for (const r of rows) {
    if (r.outcome !== "sent") continue;
    const k = r.listingResource ?? r.resource;
    const prev = m.get(k);
    if (prev?.at && Date.parse(prev.at) >= Date.parse(r.at)) continue;
    m.set(k, { status: r.response?.status ?? null, requestKey: r.requestKey ?? null, at: r.at, inputError: laneInputProblem(r) !== null });
  }
  return m;
}

/** A seller-side 400/404/422 to an unchanged request is bought again once this long after it. */
export const SELLER_4XX_RETRY_MS = 7 * 86_400_000; // every 7 days: the record of that listing stays fresh

/**
 * Pure. Why the same (or an unfillable) request must not be sent again after `last`, or null. vet402's own wrong
 * request: never again until the request changes. A seller-side 400/404/422: bought again every 7 days
 * (SELLER_4XX_RETRY_MS after the last answer), so the record of that listing stays fresh.
 */
export function holdAfter4xx(last: LastPaid | null, nowMs: number): string | null {
  if (!last || last.status === null || !INPUT_STATUSES.has(last.status)) return null;
  if (last.inputError) return "input_unchanged_after_input_error";
  const at = last.at ? Date.parse(last.at) : NaN;
  if (Number.isFinite(at) && nowMs - at >= SELLER_4XX_RETRY_MS) return null;
  return "unchanged_after_seller_4xx_within_7_days";
}

/**
 * Pure. Fill one lane request from its listing. `last` is vet402's earlier paid answer to this listing (null when
 * none). A request identical to the one that last got 400, 404 or 422 is not sent again.
 */
export function repairLaneRequest(l: Listing, req: LaneRequest, today: string, last: LastPaid | null = null, nowMs: number = Date.now()): LaneRepair {
  const hold = holdAfter4xx(last, nowMs);
  const input = (l.extensions?.bazaar?.info?.input ?? {}) as Obj;
  const pathParams = isObj(input.pathParams) ? input.pathParams : {};
  const filled: FilledParam[] = [];
  let resource = req.resource;
  const query: Record<string, string> = { ...(req.query ?? {}) };

  // 1. Path slots.
  let u: URL;
  try {
    u = new URL(req.resource);
  } catch {
    return { ok: false, reason: "bad_url", param: null };
  }
  const segs = u.pathname.split("/");
  for (let i = 0; i < segs.length; i++) {
    const name = pathSlot(segs[i]!);
    if (!name) continue;
    const fromQuery = concreteScalar(query[name]);
    const fromPath = concreteScalar(pathParams[name]);
    const v = fromQuery ?? fromPath;
    if (v === null) return { ok: false, reason: "path_placeholder", param: name };
    segs[i] = encodeURIComponent(v);
    filled.push({ param: `path:${name}`, rule: fromQuery !== null ? "same_name_query" : "seller_path_example" });
  }
  if (filled.length) {
    u.pathname = segs.join("/");
    resource = u.toString();
  }

  // 2. Query or body against the listing's declared input.
  const spec = fromBazaar(l as unknown as Obj, "lane-listing");
  const isPost = req.method === "POST";
  const bodyObj = isPost && isObj(req.body) ? (req.body as Obj) : isPost && (req.body === null || req.body === undefined) ? {} : null;
  let body = req.body;
  if (!isPost || bodyObj !== null) {
    const sentQuery: Obj = Object.fromEntries(Object.entries(query).map(([k, v]) => [k, v]));
    const sent: Obj = isPost ? { ...sentQuery, ...bodyObj } : sentQuery;
    const spec2 = spec ? { ...spec, params: spec.params.filter((p) => (isPost ? true : p.in === "query")) } : null;
    const r = fillParams(sent, spec2, today, u.pathname);
    if (!r.ok) {
      if (hold) return { ok: false, reason: `input_unfillable:${r.reason}`, param: r.param };
    } else {
      for (const f of r.filled) {
        const where = f.param in sentQuery || !isPost ? "query" : spec2?.params.find((p) => p.name === f.param)?.in === "query" ? "query" : "body";
        if (where === "query") {
          if (f.param in r.params) query[f.param] = typeof r.params[f.param] === "string" ? (r.params[f.param] as string) : JSON.stringify(r.params[f.param]);
          else delete query[f.param];
        } else {
          const b: Obj = { ...(isObj(body) ? (body as Obj) : {}) };
          if (f.param in r.params) b[f.param] = r.params[f.param];
          else delete b[f.param];
          body = b;
        }
        filled.push(f);
      }
    }
  }
  const changed = filled.length > 0;
  const request: LaneRequest = { resource, method: req.method, query: Object.keys(query).length ? query : null, body: isPost ? body : null };
  // Compare with what was actually sent last time (old records: the catalog's request, unfilled), not with the
  // catalog: a filled request that got 400/404/422 is filled the same way again and must not be bought again.
  // The date vet402 filled in is not a change of request (only those parameters; a catalog date stays a value).
  const datedParams = filled.filter((f) => f.rule === "table:date").map((f) => f.param);
  const requestKey = laneRequestKey(request, { date: today, params: datedParams });
  if (hold) {
    const before = last?.requestKey ?? laneRequestKey(req);
    if (requestKey === before) return { ok: false, reason: hold, param: null };
  }
  return { ok: true, changed, request, filled, declaredParams: (spec?.params ?? []).map((p) => p.name), datedParams, requestKey };
}

// ---------- reading a paid answer ----------

export type LaneInputProblem = "path_placeholder" | "missing_input";

/**
 * The seller's error names an input that is required or empty. The answer is read one piece at a time: each string
 * value of a JSON answer (also of a cut-off one), or each sentence of a plain one. A piece counts as vet402's
 * request only on its own words, so another key of the same JSON ("url", "query", "payment") never decides it:
 *   - MISSING_TEXT ("is required", "field required", "cannot be empty", ...), or
 *   - "missing" with an input word (INPUT_WORD), or with a parameter the listing declares after it, or
 *   - "missing" followed by a quoted identifier that is a declared parameter or an input word, or that is not
 *     written like an environment variable (ALL_CAPS),
 * and never when the same piece speaks of the seller's own side (SELLER_SIDE: env, config, upstream, server,
 * response, an API key) or of payment or authentication (NOT_INPUT).
 */
const MISSING_TEXT = /\b(is required|are required|(field|url|value|param|parameter|query|body|input|argument)s? required|required (field|param|parameter|query|argument)|cannot be empty|must not be empty|must be provided|empty (json )?body|no (query|input|body) (given|provided|sent))\b/i;
const MISSING_WORD = /\bmissing\b/i;
const INPUT_WORD = /\b(quer(y|ies)|bod(y|ies)|param\w*|fields?|inputs?|arguments?|args?|url|required|values?)\b/i;
/** "missing" followed by a quoted identifier: Missing "address", missing: 'wallet'. */
const MISSING_QUOTED = /\bmissing\s*:?\s*\\?["'`]([A-Za-z_]\w*)\\?["'`]/i;
/** The seller's own side: its environment, configuration, upstream, server or response, or its API key. */
const SELLER_SIDE = /(\b(env|environment|config\w*|upstream|server|response|misconfigur\w*)\b|api[ _-]?key)/i;
const NOT_INPUT = /\b(payment|x-payment|authori[sz]ation|authenticat\w*|auth token|bearer|signature|header|login|subscription)\b/i;
/** A seller's validation error that quotes a path slot vet402 sent as the value. */
const SLOT_ECHO = /"input"\s*:\s*":[A-Za-z_]/;

/** Pure. The pieces of an answer: every string value of JSON (or of cut-off JSON), else each sentence. */
export function answerPieces(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const out: string[] = [];
      const walk = (v: unknown, depth: number): void => {
        if (depth > 8) return;
        if (typeof v === "string") out.push(v);
        else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
        else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1);
      };
      walk(JSON.parse(t), 0);
      return out.flatMap(sentences);
    } catch {
      // Cut off at 300 characters, or not JSON after all: the quoted strings, without their keys.
      return [...t.matchAll(/"((?:[^"\\]|\\.)*)"(?!\s*:)/g)].map((m) => m[1]!.replace(/\\"/g, '"')).flatMap(sentences);
    }
  }
  return sentences(t);
}

function sentences(s: string): string[] {
  return s.split(/(?<=[.!?;])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
}

function declaredAfterMissing(piece: string, declared: readonly string[]): boolean {
  const names = declared.filter((n) => /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(n));
  if (!names.length) return false;
  const i = piece.search(MISSING_WORD);
  if (i < 0) return false;
  const after = piece.slice(i);
  return new RegExp(`(^|[^A-Za-z0-9_])(${names.map((n) => n.replace(/-/g, "\\-")).join("|")})([^A-Za-z0-9_]|$)`).test(after.slice("missing".length));
}

/** Pure. What in one piece says vet402's request was wrong, or null. */
export function inputErrorIn(piece: string, declared: readonly string[] = []): string | null {
  if (SELLER_SIDE.test(piece) || NOT_INPUT.test(piece)) return null;
  const m = MISSING_TEXT.exec(piece);
  if (m) return m[0];
  if (!MISSING_WORD.test(piece)) return null;
  const q = MISSING_QUOTED.exec(piece);
  if (q) {
    const name = q[1]!;
    const known = declared.includes(name) || INPUT_WORD.test(name);
    const envLike = /^[A-Z][A-Z0-9_]*$/.test(name) && /[A-Z]{2}/.test(name);
    if (known || !envLike) return q[0];
    return null;
  }
  if (INPUT_WORD.test(piece)) return piece.match(MISSING_WORD)![0];
  if (declaredAfterMissing(piece, declared)) return piece.match(MISSING_WORD)![0];
  return null;
}

/**
 * Pure. Was the paid answer about vet402's request? Only 400, 404 and 422 answers, and only on definite
 * evidence: a slot left in the URL vet402 requested, or a piece of the seller's error naming a missing or empty input.
 */
export function laneInputProblem(r: Pick<ChainBuyRecord, "resource" | "response" | "body" | "declaredParams">): { kind: LaneInputProblem; detail: string } | null {
  const status = r.response?.status ?? null;
  if (status === null || !INPUT_STATUSES.has(status)) return null;
  const slot = pathPlaceholderIn(r.resource);
  const text = `${r.body ?? r.response?.first300 ?? ""}`.slice(0, 4000);
  if (slot) return { kind: "path_placeholder", detail: `the URL vet402 sent still had the slot ${slot === "*" ? "*" : `:${slot}`} in its path` };
  if (status === 404) return null;
  if (SLOT_ECHO.test(text)) return { kind: "path_placeholder", detail: "the seller's error quotes a path slot vet402 sent as the value" };
  for (const piece of answerPieces(text)) {
    const hit = inputErrorIn(piece, r.declaredParams ?? []);
    if (hit) return { kind: "missing_input", detail: `the seller's ${status} says an input was missing or empty ("${hit}")` };
  }
  return null;
}

// ---------- the seller said it did not charge ----------

/** Body fields with which a seller says this call was not charged. */
const FREE_FIELDS: readonly [string, unknown][] = [
  ["first_call_free", true],
  ["firstCallFree", true],
  ["freeTrialApplied", true],
  ["free_trial_applied", true],
  ["freeTrial", true],
  ["free_trial", true],
  ["charged", false],
  ["paymentCharged", false],
  ["payment_charged", false],
  ["paymentSettled", false],
  ["payment_settled", false],
];

/** Pure. The marker (`field=value`) with which the answer body says the seller did not charge, or null. */
export function sellerSaidFree(body: string | null | undefined): string | null {
  if (!body) return null;
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return null;
  }
  const walk = (v: unknown, depth: number): string | null => {
    if (depth > 4 || !isObj(v)) return null;
    for (const [k, want] of FREE_FIELDS) if (k in v && v[k] === want) return `${k}=${String(want)}`;
    for (const x of Object.values(v)) {
      const hit = walk(x, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(j, 0);
}

