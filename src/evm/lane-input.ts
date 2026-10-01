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
import type { ChainBuyRecord } from "./evm-buy.js";

export interface LaneRequest {
  resource: string;
  method: "GET" | "POST";
  query: Record<string, string> | null;
  body: unknown;
}

export type LaneRepair =
  | { ok: true; changed: boolean; request: LaneRequest; filled: FilledParam[] }
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

/**
 * Pure. Fill one lane request from its listing. `lastStatus` is the status of vet402's earlier paid answer to
 * this listing (null when none).
 */
export function repairLaneRequest(l: Listing, req: LaneRequest, today: string, lastStatus: number | null = null): LaneRepair {
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
      if (lastStatus !== null && INPUT_STATUSES.has(lastStatus)) return { ok: false, reason: `input_unfillable:${r.reason}`, param: r.param };
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
  if (!changed && lastStatus !== null && INPUT_STATUSES.has(lastStatus)) return { ok: false, reason: "input_unchanged_after_input_error", param: null };
  return {
    ok: true,
    changed,
    request: { resource, method: req.method, query: Object.keys(query).length ? query : null, body: isPost ? body : null },
    filled,
  };
}

// ---------- reading a paid answer ----------

export type LaneInputProblem = "path_placeholder" | "missing_input";

/** The seller's error names an input that is missing, required or empty. Not authentication or payment. */
const MISSING_TEXT = /\b(missing|is required|are required|(field|url|value|param|parameter|query|body|input|argument)s? required|required (field|param|parameter|query|argument)|cannot be empty|must not be empty|must be provided|empty (json )?body|no (query|input|body) (given|provided|sent))\b/i;
const NOT_INPUT = /\b(payment|x-payment|api[ -]?key|authori[sz]ation|authenticat\w*|auth token|bearer|signature|header|login|subscription)\b/i;
/** A seller's validation error that quotes a path slot vet402 sent as the value. */
const SLOT_ECHO = /"input"\s*:\s*":[A-Za-z_]/;

/**
 * Pure. Was the paid answer about vet402's request? Only 400, 404 and 422 answers, and only on definite
 * evidence: a slot left in the URL vet402 requested, or the seller's error naming a missing or empty input.
 */
export function laneInputProblem(r: Pick<ChainBuyRecord, "resource" | "response" | "body">): { kind: LaneInputProblem; detail: string } | null {
  const status = r.response?.status ?? null;
  if (status === null || !INPUT_STATUSES.has(status)) return null;
  const slot = pathPlaceholderIn(r.resource);
  const text = `${r.body ?? r.response?.first300 ?? ""}`.slice(0, 4000);
  if (slot) return { kind: "path_placeholder", detail: `the URL vet402 sent still had the slot ${slot === "*" ? "*" : `:${slot}`} in its path` };
  if (status === 404) return null;
  if (SLOT_ECHO.test(text)) return { kind: "path_placeholder", detail: "the seller's error quotes a path slot vet402 sent as the value" };
  const m = MISSING_TEXT.exec(text);
  if (m && !NOT_INPUT.test(text)) return { kind: "missing_input", detail: `the seller's ${status} says an input was missing or empty ("${m[0]}")` };
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

