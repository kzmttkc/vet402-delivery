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
  /** How many parameters the listing declared then (a stop for good needs at least one). Absent: none. */
  declaredCount?: number;
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
    m.set(k, { status: r.response?.status ?? null, requestKey: r.requestKey ?? null, at: r.at, inputError: laneInputProblem(r) !== null, declaredCount: new Set([...(r.declaredParams ?? []), ...(r.requiredParams ?? [])]).size });
  }
  return m;
}

/** A seller-side 400/404/422 to an unchanged request is bought again once this long after it. */
export const SELLER_4XX_RETRY_MS = 7 * 86_400_000; // every 7 days: the record of that listing stays fresh

/**
 * Pure. Why the same (or an unfillable) request must not be sent again after `last`, or null. vet402's own wrong
 * request to a listing that declares at least one parameter: never again until the request changes. Every other
 * 400/404/422 (the seller's, or vet402's on a listing that declares nothing, where the reading rests on the fixed
 * word list only): bought again every 7 days (SELLER_4XX_RETRY_MS after the last answer).
 */
export function holdAfter4xx(last: LastPaid | null, nowMs: number): string | null {
  if (!last || last.status === null || !INPUT_STATUSES.has(last.status)) return null;
  if (last.inputError && (last.declaredCount ?? 0) > 0) return "input_unchanged_after_input_error";
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

// ---------- what the listing declares (rule 0) ----------

/** The inputs a listing or a 402 declares: every name, the names it marks required, and where they were read. */
export interface InputDeclaration {
  declared: string[];
  required: string[];
  from: string[];
  /** The sources (of `from`) that mark a name required. */
  requiredFrom: string[];
}

const isObjD = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Keys of an x402 Bazaar input that describe the request itself, not a parameter ("body" is read as a part only
 * where it holds the body's parameters; a parameter named body is still a name). */
const INPUT_META = new Set(["type", "method", "bodyType", "headers", "queryParams", "bodyFields", "pathParams", "discoverable"]);
/** JSON Schema keywords: never a parameter name, on any path. */
export const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "type", "properties", "additionalProperties", "patternProperties", "required", "items", "prefixItems", "contains", "description", "example", "examples",
  "enum", "const", "default", "format", "$schema", "$ref", "$id", "$defs", "definitions", "oneOf", "anyOf", "allOf", "not", "if", "then", "else", "title",
  "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems",
  "uniqueItems", "minProperties", "maxProperties", "nullable", "readOnly", "writeOnly", "deprecated", "contentMediaType", "contentEncoding", "dependentRequired",
]);
const isName = (k: string) => !SCHEMA_KEYWORDS.has(k);

/** A part that is a JSON schema (it has a type or properties), not a map of example values. */
const looksLikeSchema = (part: Record<string, unknown>) => "type" in part || isObjD(part.properties) || "additionalProperties" in part || "$ref" in part;

/** A part (queryParams, body, bodyFields, or a flat input schema): its parameter names and required names. */
function partNames(part: unknown): { declared: string[]; required: string[] } {
  if (!isObjD(part)) return { declared: [], required: [] };
  const req = (Array.isArray(part.required) ? part.required.filter((x): x is string => typeof x === "string") : []).filter(isName);
  if (looksLikeSchema(part)) return { declared: [...new Set([...(isObjD(part.properties) ? Object.keys(part.properties) : []), ...req])].filter(isName), required: req };
  // An example map ({"chain":"base"}) names parameters but marks none required.
  return { declared: Object.keys(part).filter((k) => !INPUT_META.has(k) && isName(k)), required: req };
}

/** A property of an input schema that is itself a part (holds the body's or the query's parameters). */
const isPartSchema = (v: unknown) => isObjD(v) && (isObjD(v.properties) || v.type === "object");

/**
 * Pure. What one document declares as the request's inputs. Reads, wherever they are: an x402 Bazaar extension
 * (extensions.bazaar.info.input and its JSON schema, whose input is either split into queryParams/body or flat),
 * a listing's inputSchema, accepts[].outputSchema.input, and Dexter's metadata.input. JSON Schema keywords
 * (SCHEMA_KEYWORDS) are never names, and a part shaped like a schema is never read as a map of example values.
 */
export function declarationFrom(doc: unknown, label: string): InputDeclaration {
  const declared = new Set<string>();
  const required = new Set<string>();
  const from = new Set<string>();
  const requiredFrom = new Set<string>();
  const take = (part: unknown, where: string) => {
    const n = partNames(part);
    if (!n.declared.length && !n.required.length) return;
    n.declared.forEach((x) => declared.add(x));
    n.required.forEach((x) => {
      required.add(x);
      declared.add(x);
    });
    if (n.required.length) requiredFrom.add(`${label}:${where}`);
    from.add(`${label}:${where}`);
  };
  const input = (x: unknown, where: string) => {
    if (!isObjD(x)) return;
    take(x.queryParams, `${where}.queryParams`);
    if (isObjD(x.body)) take(x.body, `${where}.body`);
    take(x.bodyFields, `${where}.bodyFields`);
    // A flat schema: the input object itself lists the parameters. Its parts (queryParams, a body that holds
    // parameters) are read as parts; the request's own keys (type, method, ...) are never parameters.
    if (isObjD(x.properties) || Array.isArray(x.required)) {
      const props = isObjD(x.properties) ? x.properties : {};
      const part = (k: string) => k === "queryParams" || k === "bodyFields" || (k === "body" && isPartSchema(props.body));
      const params = Object.fromEntries(Object.entries(props).filter(([k]) => !INPUT_META.has(k) && !part(k)));
      const req = (Array.isArray(x.required) ? x.required : []).filter((k): k is string => typeof k === "string" && !INPUT_META.has(k) && !part(k));
      take({ type: "object", properties: params, required: req }, where);
      if (isObjD(props.queryParams)) take(props.queryParams, `${where}.properties.queryParams`);
      if (isPartSchema(props.body)) take(props.body, `${where}.properties.body`);
    }
  };
  if (isObjD(doc)) {
    const ext = isObjD(doc.extensions) && isObjD(doc.extensions.bazaar) ? doc.extensions.bazaar : null;
    if (ext) {
      if (isObjD(ext.info)) input(ext.info.input, "extensions.bazaar.info.input");
      const sp = isObjD(ext.schema) && isObjD(ext.schema.properties) ? ext.schema.properties : null;
      if (sp) input(sp.input, "extensions.bazaar.schema.input");
    }
    if (isObjD(doc.inputSchema)) {
      const is = doc.inputSchema;
      if ("queryParams" in is || "bodyFields" in is || ("body" in is && isObjD(is.body))) input(is, "inputSchema");
      else take(is, "inputSchema");
    }
    if (isObjD(doc.metadata)) input(doc.metadata.input, "metadata.input");
    for (const a of Array.isArray(doc.accepts) ? doc.accepts : []) if (isObjD(a) && isObjD(a.outputSchema)) input(a.outputSchema.input, "accepts.outputSchema.input");
  }
  return { declared: [...declared], required: [...required], from: [...from], requiredFrom: [...requiredFrom] };
}

/** Pure. Several declarations as one (a name is required when any source says so). */
export function mergeDeclarations(ds: readonly InputDeclaration[]): InputDeclaration {
  const uniq = (xs: string[]) => [...new Set(xs)];
  return { declared: uniq(ds.flatMap((d) => d.declared)), required: uniq(ds.flatMap((d) => d.required)), from: uniq(ds.flatMap((d) => d.from)), requiredFrom: uniq(ds.flatMap((d) => d.requiredFrom)) };
}

/** Pure. The parameter names a request carries (query keys, and the keys of a JSON object body). */
export function sentParamNames(e: { query: Record<string, string> | null; body: unknown; method: string }): string[] {
  const q = Object.keys(e.query ?? {});
  const b = e.method === "POST" && isObjD(e.body) ? Object.keys(e.body) : [];
  return [...new Set([...q, ...b])];
}

/** Pure. Required inputs the request did not carry (rule 0), or [] when the record does not say what was sent. */
export function missingRequired(r: Pick<ChainBuyRecord, "requiredParams" | "sentParams">): string[] {
  if (!r.requiredParams?.length || !r.sentParams) return [];
  const sent = new Set(r.sentParams.map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, "")));
  return r.requiredParams.filter((x) => !sent.has(x.toLowerCase().replace(/[^a-z0-9]/g, "")));
}

/**
 * Reading a 4xx answer. Rule 0 first: when the request vet402 sent lacks an input the listing declares required
 * (the record's requiredParams and sentParams, see missingRequired), the 4xx is vet402's whatever the answer says.
 * Then (review of a70363c: the rule turned around) an answer is vet402's own wrong request only
 * when every name it says is missing is one vet402 should have sent:
 *   (a) a parameter the listing declares (case, snake_case and camelCase are the same name), or
 *   (b) when the listing declares nothing, a word of ALLOWED_NAMES.
 * Everything else is the seller's: an answer with no name, any name outside (a) or (b), any name of the seller's
 * own (ALL_CAPS, SELLER_SIDE or NOT_INPUT words, a header), a path through config, env, settings
 * or secrets, a missing header (vet402 does not send headers), or a sentence that names a missing thing next to
 * the seller's own side. The names come from every shape the same way: a quoted name after "missing", Fastify
 * ("<part> must have required property 'x'"), Zod (issue path, .flatten() fieldErrors keys), pydantic/FastAPI
 * (loc), Joi ('"x" is required'), Yup ("x is a required field"), and plain sentences ("Missing required fields: a,
 * b", "x is required", "x cannot be empty", "missing value for x").
 */
export const ALLOWED_NAMES: readonly string[] = ["address", "wallet", "symbol", "ticker", "query", "q", "input", "parameter", "argument", "value", "mint", "token_address", "chain", "network", "date"];

const SELLER_SIDE = /(\b(env|environment|config\w*|upstream|server|response|misconfigur\w*|secrets?|passwords?|passwd|mnemonic|jwt|facilitator\w*|pay_?to|database)\b|api[ _-]?key|private[ _-]?key)/i;
const NOT_INPUT = /\b(payment|x-payment|authori[sz]ation|authenticat\w*|auth token|bearer|signature|header|login|subscription)\b/i;
/** Path parts that put a name in the seller's own configuration. */
const SELLER_PATH = /^(config\w*|env|environment|settings?|secrets?)$/i;
/** A seller's validation error that quotes a path slot vet402 sent as the value. */
const SLOT_ECHO = /"input"\s*:\s*":[A-Za-z_]/;

const canon = (n: string) => n.toLowerCase().replace(/[^a-z0-9]/g, "");
const singular = (c: string) => (c.endsWith("ies") ? `${c.slice(0, -3)}y` : c.endsWith("s") && !c.endsWith("ss") ? c.slice(0, -1) : c);
const ALLOWED = new Set(ALLOWED_NAMES.map(canon));

/** One missing name an answer gives: where it was found (header, path) and the sentence it came from. */
export interface MissingName {
  name: string;
  header: boolean;
  path: string[];
  source: string;
}

/**
 * Pure. Whose is one missing name: "input" only per (a) or (b) above; otherwise "seller".
 */
export function missingNameSide(m: MissingName, declared: readonly string[] = []): "input" | "seller" {
  const n = m.name;
  if (m.header) return "seller";
  if (m.path.some((x) => SELLER_PATH.test(x))) return "seller";
  if (/^[A-Z][A-Z0-9_]*$/.test(n) && /[A-Z]{2}/.test(n)) return "seller";
  if (SELLER_SIDE.test(n) || NOT_INPUT.test(n)) return "seller";
  const c = canon(n);
  if (declared.length) {
    if (declared.some((d) => canon(d) === c)) return "input";
    return "seller";
  }
  if (ALLOWED.has(c) || ALLOWED.has(singular(c))) return "input";
  return "seller";
}

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

const ID = String.raw`[A-Za-z_$][\w$.-]*`;
const Q = String.raw`\\?["'\x60]?`;
/** A sentence that says something is missing or required. */
const CUE = /\b(missing|required|cannot be empty|must not be empty|must be provided)\b/i;
const GENERIC = /^(fields?|params?|parameters?|arguments?|args?|propert(y|ies)|keys?|values?|inputs?)$/i;
const STOP = new Set(["for", "in", "from", "of", "to", "the", "a", "an", "this", "that", "data", "when", "with", "or", "and", "is", "are", "was", "be", "at", "on"]);

/** Pure. The missing names one sentence gives (empty when it names nothing). */
export function namesInSentence(piece: string): string[] {
  const out: string[] = [];
  const push = (n: string | undefined) => {
    const x = (n ?? "").replace(/^[.\-]+|[.\-]+$/g, "");
    if (x && !STOP.has(x.toLowerCase()) && isName(x)) out.push(x);
  };
  let m: RegExpExecArray | null;
  // Fastify: "querystring must have required property 'x'" (the part is read by namesInAnswer).
  if ((m = new RegExp(String.raw`\bmust have required property\s+${Q}(${ID})`, "i").exec(piece))) push(m[1]);
  // missing "x", missing: 'x'
  for (const q of piece.matchAll(new RegExp(String.raw`\bmissing\s*:?\s*\\?["'\x60](${ID})\\?["'\x60]`, "gi"))) push(q[1]);
  // Missing [required] [fields|params|...][:] a, b and c  |  missing <generic>  |  missing x
  for (const q of piece.matchAll(new RegExp(String.raw`\bmissing\s*:?\s*(?:required\s+)?(?:(${ID})\s*:\s*|(${ID})\s+)?(${ID}(?:\s*(?:,|\band\b)\s*${ID})*)?`, "gi"))) {
    const head = q[1] ?? q[2];
    const list = (q[3] ?? "").split(/\s*(?:,|\band\b)\s*/).filter(Boolean);
    if (head && GENERIC.test(head)) {
      if (list.length && !STOP.has(list[0]!.toLowerCase())) list.forEach(push);
      else push(head);
    } else if (head) push(head);
    else list.slice(0, 1).forEach(push);
  }
  // "... for x" after a missing value/parameter
  if ((m = new RegExp(String.raw`\bmissing\b[^.]*?\bfor\s+(?:the\s+)?${Q}(${ID})`, "i").exec(piece))) push(m[1]);
  // Joi / plain: '"x" is required', "x is required", "The 'x' parameter is required", Yup "x is a required field"
  for (const q of piece.matchAll(new RegExp(String.raw`${Q}(${ID})${Q}\s+(?:(?:parameter|param|field|property|argument|value)\s+)?(?:is|are)\s+(?:a\s+)?required\b`, "gi"))) push(q[1]);
  // "required field(s): x, y" / "required property 'x'"
  for (const q of piece.matchAll(new RegExp(String.raw`\brequired\s+(?:field|param|parameter|property|argument|key)s?\s*:?\s*${Q}(${ID}(?:\s*,\s*${ID})*)`, "gi"))) q[1]!.split(/\s*,\s*/).forEach(push);
  // "x cannot be empty", "x must not be empty", "x must be provided"
  for (const q of piece.matchAll(new RegExp(String.raw`${Q}(${ID})${Q}\s+(?:cannot be empty|must not be empty|must be provided)`, "gi"))) push(q[1]);
  return [...new Set(out)];
}

/**
 * Pure. Every missing name in an answer, from structured JSON (Zod issues and fieldErrors, pydantic loc, Fastify
 * part) and from each sentence. `tainted`: a sentence that says something is missing also speaks of the seller's
 * own side (SELLER_SIDE) or of payment or authentication (NOT_INPUT).
 */
export function namesInAnswer(text: string): { names: MissingName[]; tainted: boolean } {
  const names: MissingName[] = [];
  let tainted = false;
  let j: unknown = undefined;
  try {
    j = JSON.parse(text.trim());
  } catch {
    j = undefined;
  }
  const strs = (a: unknown[]) => a.filter((x): x is string => typeof x === "string");
  const walk = (v: unknown, keys: string[], depth: number): void => {
    if (depth > 8 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, keys, depth + 1));
    const o = v as Record<string, unknown>;
    const msg = typeof o.message === "string" ? o.message : typeof o.msg === "string" ? o.msg : "";
    // Zod issue
    if (Array.isArray(o.path) && /^required\.?$/i.test(msg.trim())) {
      const path = strs(o.path);
      const last = path.at(-1);
      if (last && isName(last)) names.push({ name: last, header: path.some((x) => /^headers?$/i.test(x)), path: [...keys, ...path], source: "zod" });
    }
    // pydantic / FastAPI
    if (Array.isArray(o.loc) && (o.type === "missing" || o.type === "value_error.missing" || /field required/i.test(msg))) {
      const loc = strs(o.loc);
      const last = loc.at(-1);
      if (last && isName(last)) names.push({ name: last, header: /^headers?$/i.test(loc[0] ?? ""), path: [...keys, ...loc], source: "pydantic" });
    }
    // Zod .flatten()
    if (o.fieldErrors && typeof o.fieldErrors === "object" && !Array.isArray(o.fieldErrors)) {
      for (const [k, msgs] of Object.entries(o.fieldErrors as Record<string, unknown>)) {
        if (isName(k) && Array.isArray(msgs) && msgs.some((x) => typeof x === "string" && CUE.test(x))) names.push({ name: k, header: false, path: [...keys, k], source: "zod.fieldErrors" });
      }
    }
    for (const [k, x] of Object.entries(o)) walk(x, [...keys, k], depth + 1);
  };
  if (j !== undefined) walk(j, [], 0);
  for (const piece of answerPieces(text)) {
    if (!CUE.test(piece)) continue;
    if (SELLER_SIDE.test(piece) || NOT_INPUT.test(piece)) tainted = true;
    const f = /\b(querystring|body|params|headers)\s+must have required property/i.exec(piece);
    for (const n of namesInSentence(piece)) names.push({ name: n, header: !!f && f[1]!.toLowerCase() === "headers", path: [], source: "text" });
  }
  return { names, tainted };
}

/**
 * Pure. Was the paid answer about vet402's request? Only 400, 404 and 422 answers: a slot left in the URL vet402
 * requested, or an answer whose every missing name is vet402's to send (missingNameSide), with none of the
 * seller's own and no sentence about the seller's side.
 */
export function laneInputProblem(r: Pick<ChainBuyRecord, "resource" | "response" | "body" | "declaredParams" | "requiredParams" | "sentParams" | "declaredFrom" | "requiredFrom">): { kind: LaneInputProblem; detail: string } | null {
  const status = r.response?.status ?? null;
  if (status === null || !INPUT_STATUSES.has(status)) return null;
  const slot = pathPlaceholderIn(r.resource);
  const text = `${r.body ?? r.response?.first300 ?? ""}`.slice(0, 4000);
  if (slot) return { kind: "path_placeholder", detail: `the URL vet402 sent still had the slot ${slot === "*" ? "*" : `:${slot}`} in its path` };
  // A 404 (no such route) stays the seller's, re-bought every 7 days, whatever was declared.
  if (status === 404) return null;
  if (SLOT_ECHO.test(text)) return { kind: "path_placeholder", detail: "the seller's error quotes a path slot vet402 sent as the value" };
  // Rule 0: a required input vet402 did not send.
  const lacking = missingRequired(r);
  if (lacking.length) return { kind: "missing_input", detail: `vet402 did not send ${lacking.join(", ")}, which the listing declares required (${(r.requiredFrom ?? r.declaredFrom ?? []).join("; ") || "declaration"})` };
  const { names, tainted } = namesInAnswer(text);
  if (tainted || names.length === 0) return null;
  const declared = r.declaredParams ?? [];
  if (!names.every((n) => missingNameSide(n, declared) === "input")) return null;
  return { kind: "missing_input", detail: `the seller's ${status} says vet402 did not send ${[...new Set(names.map((n) => n.name))].join(", ")}` };
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

