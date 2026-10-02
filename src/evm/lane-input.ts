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
 * A listing whose request cannot be filled is not bought, whatever came before: a path slot without a value, and
 * every failure of fillParams (a required input with no value, a placeholder nothing names, and above all an
 * endpoint that sends a message or commits to a purchase, sends_message / commits_to_purchase). It is planned as an
 * input skip with the reason, never sent unfilled. After a paid 400, 404 or 422 the same request is held
 * (holdAfter4xx: 30 days when the answer reads as vet402's own wrong request, 7 days otherwise).
 *
 * The hold is not what limits money. A paying lane run (scripts/evm-lane.ts --pay) buys each seller once in its
 * life: the lane's ledger (src/guard.ts Budget) refuses a second purchase as already_bought, before any signature.
 * Its key is <chain>-payto:<payTo>; the stock-price seller on Robinhood Chain is keyed per ticker
 * (robinhood-stock:<host>:<ticker>), so it is bought once per ticker. The ledger is <lane>-ledger.json in the
 * results directory beside the key (src/evm/run-dir.ts: ~/vet402-solana/results/evm unless VET402_EVM_RESULTS_DIR
 * is set), whatever directory --pay is started from. So when a hold ends, nothing is bought again; a real
 * second purchase happens only when the ledger is changed (a new ledger, or the entry removed), which is not done
 * by any script. A misread 4xx therefore changes a page's label, never the money spent.
 *
 * Why: on 2026-09-30 the Arbitrum and Robinhood lanes sent "/v1/user/:username" (404), ":netuid" (422), a GET
 * without the required `query` (400) and an empty JSON object to an endpoint that needs a token (400, after the
 * payment settled). Those answers are vet402's request, not the seller.
 */
import type { Listing } from "../discovery.js";
import { commitsToPurchase, fillParams, isPlaceholder, sendsMessage, type FilledParam } from "../inputs/fill.js";
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

/**
 * How long vet402's own wrong request (read as such, on a listing that declares parameters) is held before the
 * same request may be planned again. With --pay the lane's ledger still allows each seller once only (see the top
 * of this file), so the end of a hold buys nothing unless the ledger has been changed.
 */
export const INPUT_4XX_RETRY_MS = 30 * 86_400_000;

/** How long a seller-side 400/404/422 to an unchanged request is held (the ledger still allows one purchase per seller). */
export const SELLER_4XX_RETRY_MS = 7 * 86_400_000;

/**
 * Pure. Why the same (or an unfillable) request must not be planned again after `last`, or null. vet402's own wrong
 * request to a listing that declares parameters: held 30 days (INPUT_4XX_RETRY_MS). Every other 400/404/422 (the
 * seller's, or vet402's on a listing that declares nothing): held 7 days (SELLER_4XX_RETRY_MS). A record whose time
 * cannot be read is not held (and said on stderr). A hold that ends does not by itself buy again: with --pay the
 * lane's ledger allows each seller once (already_bought), so a second purchase needs the ledger changed.
 */
export function holdAfter4xx(last: LastPaid | null, nowMs: number, warn: (s: string) => void = (s) => console.error(s)): string | null {
  if (!last || last.status === null || !INPUT_STATUSES.has(last.status)) return null;
  const at = last.at ? Date.parse(last.at) : NaN;
  // A record whose time cannot be read is never a hold without end: not held, and said.
  if (!Number.isFinite(at)) {
    warn(`ALERT holdAfter4xx: the last answer (${last.status}) has no readable time (${JSON.stringify(last.at)}); not held`);
    return null;
  }
  if (last.inputError && (last.declaredCount ?? 0) > 0) return Number.isFinite(at) && nowMs - at >= INPUT_4XX_RETRY_MS ? null : "input_unchanged_after_input_error";
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
  // An endpoint that sends a message or commits to a purchase is never bought, whatever its body looks like (a body
  // that is not a JSON object is not given to fillParams below, so the check is made here as well).
  if (spec && sendsMessage(spec, u.pathname)) return { ok: false, reason: "input_unfillable:sends_message", param: null };
  if (spec && commitsToPurchase(spec)) return { ok: false, reason: "input_unfillable:commits_to_purchase", param: null };
  const isPost = req.method === "POST";
  const bodyObj = isPost && isObj(req.body) ? (req.body as Obj) : isPost && (req.body === null || req.body === undefined) ? {} : null;
  let body = req.body;
  if (!isPost || bodyObj !== null) {
    const sentQuery: Obj = Object.fromEntries(Object.entries(query).map(([k, v]) => [k, v]));
    const sent: Obj = isPost ? { ...sentQuery, ...bodyObj } : sentQuery;
    const spec2 = spec ? { ...spec, params: spec.params.filter((p) => (isPost ? true : p.in === "query")) } : null;
    const r = fillParams(sent, spec2, today, u.pathname);
    // A request that cannot be filled is not bought, whether or not an earlier answer was a 4xx: sending it unfilled
    // pays for an answer to a request vet402 knows is wrong (and, for sends_message / commits_to_purchase, could make
    // the seller act on vet402's empty request).
    if (!r.ok) return { ok: false, reason: `input_unfillable:${r.reason}`, param: r.param };
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
/**
 * JSON Schema keywords. They are left out only where they sit in a schema's own structure (the keys of a schema
 * object: type, properties, required, items, ...). A key inside `properties`, an element of `required` and a key of
 * an example map are parameter names whatever they are called (a parameter may be named type, title or format).
 * In a seller's answer, such a word is a missing name only when the listing declares it.
 */
export const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "type", "properties", "additionalProperties", "patternProperties", "required", "items", "prefixItems", "contains", "description", "example", "examples",
  "enum", "const", "default", "format", "$schema", "$ref", "$id", "$defs", "definitions", "oneOf", "anyOf", "allOf", "not", "if", "then", "else", "title",
  "pattern", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "minItems", "maxItems",
  "uniqueItems", "minProperties", "maxProperties", "nullable", "readOnly", "writeOnly", "deprecated", "contentMediaType", "contentEncoding", "dependentRequired",
]);
/** The values JSON Schema's `type` takes. */
const JSON_TYPES = new Set(["object", "string", "number", "integer", "boolean", "array", "null"]);
const isJsonType = (t: unknown) => (typeof t === "string" && JSON_TYPES.has(t)) || (Array.isArray(t) && t.length > 0 && t.every((x) => typeof x === "string" && JSON_TYPES.has(x)));

/**
 * A part that is a JSON schema, not a map of example values: its `type` is a JSON Schema type ("object", "string",
 * ...). Without a `type`, only a part whose `properties` holds schemas (objects), or that is a bare `$ref`, is one.
 * {"query":"...","numResults":10,"type":"auto"} is an example map: type "auto" is a value, and a parameter name.
 */
const looksLikeSchema = (part: Record<string, unknown>) => {
  if ("type" in part) return isJsonType(part.type);
  if (isObjD(part.properties) && Object.values(part.properties).every(isObjD)) return true;
  return typeof part.$ref === "string" && Object.keys(part).every((k) => k.startsWith("$"));
};

/** A part (queryParams, body, bodyFields, or a flat input schema): its parameter names and required names. */
function partNames(part: unknown): { declared: string[]; required: string[] } {
  if (!isObjD(part)) return { declared: [], required: [] };
  if (looksLikeSchema(part)) {
    // The schema's own keys (type, properties, required, items, ...) are structure; its properties and required are names.
    const req = Array.isArray(part.required) ? part.required.filter((x): x is string => typeof x === "string") : [];
    return { declared: [...new Set([...(isObjD(part.properties) ? Object.keys(part.properties) : []), ...req])], required: req };
  }
  // An example map ({"chain":"base"}, {"query":"...","type":"auto"}): every key is a parameter; none is marked required.
  return { declared: Object.keys(part), required: [] };
}

/** An input description (http or MCP), not parameters: type "http" or "mcp" with a request or tool key. */
const isDescriptor = (v: unknown): boolean =>
  isObjD(v) && (v.type === "http" || v.type === "mcp") && ["inputSchema", "toolName", "method", "queryParams", "bodyFields"].some((k) => k in v);

/**
 * A JSON schema of an input description (x402 Bazaar's extensions.bazaar.schema.properties.input, or such a schema
 * nested in a part): its `type` property is fixed to "http" or "mcp" (const or enum). Its own properties and
 * required (type, method, toolName, inputSchema, transport, description, example, mcpServerUrl, ...) describe the
 * request; only what is inside its queryParams, body, bodyFields and inputSchema are parameters.
 */
const isDescriptorSchema = (v: unknown): boolean => {
  if (!isObjD(v) || !isObjD(v.properties) || !isObjD(v.properties.type)) return false;
  const t = v.properties.type;
  return t.const === "http" || t.const === "mcp" || (Array.isArray(t.enum) && t.enum.some((x) => x === "http" || x === "mcp"));
};

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
  const input = (x: unknown, where: string, depth = 0): void => {
    if (!isObjD(x) || depth > 3) return;
    // An MCP tool description: its parameters are its inputSchema's (type, toolName, description, example and
    // transport describe the tool, they are not parameters).
    if (x.type === "mcp") {
      if (isObjD(x.inputSchema)) take(x.inputSchema, `${where}.inputSchema`);
      return;
    }
    // A part that is itself an input description ({"type":"http","method":"GET",...}, or the schema of one): read as
    // one, not as a map.
    const part = (v: unknown, w: string) => (isDescriptor(v) || isDescriptorSchema(v) ? input(v, w, depth + 1) : take(v, w));
    if (isDescriptorSchema(x)) {
      const props = x.properties as Record<string, unknown>;
      part(props.queryParams, `${where}.properties.queryParams`);
      if (isPartSchema(props.body) || isDescriptorSchema(props.body)) part(props.body, `${where}.properties.body`);
      part(props.bodyFields, `${where}.properties.bodyFields`);
      if (isObjD(props.inputSchema) && isObjD(props.inputSchema.properties)) take(props.inputSchema, `${where}.properties.inputSchema`);
      return;
    }
    part(x.queryParams, `${where}.queryParams`);
    if (isObjD(x.body)) part(x.body, `${where}.body`);
    part(x.bodyFields, `${where}.bodyFields`);
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
      // An input-level descriptor ({"type":"http","method":"GET",...} or an MCP tool) is read like info.input; else a part.
      if (isDescriptor(is) || is.type === "http" || "method" in is || "queryParams" in is || "bodyFields" in is || ("body" in is && isObjD(is.body))) input(is, "inputSchema");
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
  /**
   * The unquoted subject of "x is required to ...": often a pronoun or a general word ("It", "Each", "Account",
   * "Request"), not a parameter. Counted only when the listing declares it or it is an allowed word. A seller
   * setting name (sellerSettingName) is never soft.
   */
  soft?: boolean;
  /** Which sentence of the answer it came from (text names only). */
  piece?: number;
  /** The answer wrote it in quotes. */
  quoted?: boolean;
  /** Named as a header in prose ("checked headers 'x'", "'x' header"): S only when vet402 does not send it. */
  proseHeader?: boolean;
  /** Right before "environment variable" / "env var": S only when vet402 does not send it. */
  envVar?: boolean;
  /** Found only where no missing name stands (outOfPlace): never S. */
  outOfPlace?: boolean;
}

/**
 * Pure. Whose is one missing name: "input" only per (a) or (b) above; otherwise "seller".
 */
/** A setting written as one capitalised word: a known prefix followed by a setting word, nothing else. */
const JOINED_SETTING = /^(?:ACCESS|RPC|DATABASE|SECRET|AUTH|DB|API)(?:TOKEN|URL|KEY|PASSWORD|SECRET)$/;
/** In a sentence all in capitals, a name with an underscore keeps its spelling only when it looks like a setting. */
const CAPS_SETTING_WORD = /(?:TOKEN|URL|SECRET|KEY|PASSWORD|DSN|JWT)/;
const ENV_PREFIX = /^(?:NODE|AWS|GCP|AZURE|INFURA|ALCHEMY|STRIPE|PG|DB|REDIS|SUPABASE|VERCEL|NEXT_PUBLIC|OPENAI|ANTHROPIC)_/;

/** Words that make a name one of the seller's own settings (split from camelCase and snake_case first). */
const SETTING_WORDS = new Set(["secret", "secrets", "token", "tokens", "password", "passwords", "passwd", "pwd", "url", "uri", "host", "hostname", "key", "keys", "dsn", "mnemonic", "jwt", "credential", "credentials"]);

/**
 * Pure. A name that is one of the seller's own settings: written like an environment variable with an underscore
 * (DATABASE_URL, DB_HOST), a known setting run together in capitals (JOINED_SETTING: ACCESSTOKEN, RPCURL), or made of a
 * setting word (secret_token, db_password, rpcUrl, apiKey). An allowed word (token_address) and an abbreviation
 * without an underscore (NFT, ID, ETH, USDC, API, JSON) are not. A name the listing declares is checked against the
 * declaration first (missingNameSide), so a declared ETH_ADDRESS or TOKEN_ID is vet402's.
 */
export function sellerSettingName(name: string): boolean {
  const c = canon(name);
  if (ALLOWED.has(c) || ALLOWED.has(singular(c))) return false;
  // An environment-variable name has an underscore (DATABASE_URL, DB_HOST); NFT, ID, ETH, USDC, API, JSON are not.
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(name)) return true;
  // A setting run together in capitals, as a whole word only: a known prefix and a setting word (ACCESSTOKEN, RPCURL,
  // DATABASEURL, SECRETKEY, AUTHTOKEN, DBPASSWORD, APITOKEN). MONKEY, KEYWORD, TOKENID, CURL, URLS are not.
  if (JOINED_SETTING.test(name)) return true;
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  return words.some((w) => SETTING_WORDS.has(w));
}

export function missingNameSide(m: MissingName, declared: readonly string[] = []): "input" | "seller" {
  const n = m.name;
  // Where the name sits first: a header vet402 does not send, or the seller's own configuration.
  if (m.header) return "seller";
  if (m.path.some((x) => SELLER_PATH.test(x))) return "seller";
  // Then the listing's own declaration, whatever case the answer writes it in (ETH_ADDRESS for eth_address, "WALLET").
  const c = canon(n);
  if (declared.some((d) => canon(d) === c)) return "input";
  // A listing that declares nothing: an allowed word is vet402's in any case (WALLET, ADDRESS, SYMBOL, VALUE).
  if (declared.length === 0 && (ALLOWED.has(c) || ALLOWED.has(singular(c)))) return "input";
  // Only a name the listing does not declare is read for the seller's signs: ALL_CAPS, a setting name, auth words.
  if (/^[A-Z][A-Z0-9_]*$/.test(n) && /[A-Z]{2}/.test(n)) return "seller";
  if (sellerSettingName(n)) return "seller";
  if (SELLER_SIDE.test(n) || NOT_INPUT.test(n)) return "seller";
  if (declared.length) return "seller";
  if (ALLOWED.has(c) || ALLOWED.has(singular(c))) return "input";
  return "seller";
}

/** An environment variable's form: capitals with an underscore (DATABASE_URL, DB_HOST, NODE_ENV). */
const ENV_FORM = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
/** Words of a capitalised name that make it a setting (review of 49e90ad). */
const CAPS_SETTING_WORDS = new Set(["KEY", "SECRET", "TOKEN", "PASSWORD", "PASSWD", "PWD", "URL", "URI", "HOST", "DSN", "JWT", "MNEMONIC", "CREDENTIAL", "CREDENTIALS", "DATABASE", "DB"]);
/** Prefixes of environment variables. */
const CAPS_ENV_PREFIX = /^(?:NODE|AWS|GCP|AZURE|INFURA|ALCHEMY|STRIPE|PG|REDIS|SUPABASE|VERCEL|NEXT_PUBLIC|OPENAI|ANTHROPIC|QUICKNODE|HELIUS)_/;

/**
 * Pure. A capitalised name with an underscore that means a setting: it holds a setting word (KEY, SECRET, TOKEN,
 * PASSWORD, URL, HOST, DSN, DB, SEED_PHRASE, PRIVATE_KEY, ...) or starts with an environment prefix (NODE_, AWS_,
 * ALCHEMY_, ...). The shape alone is not: an error code (INVALID_INPUT), an enum value (ONE_HOUR, BASE_MAINNET), a
 * type (HEX_STRING), an example (MY_WALLET_ADDRESS) or an id (TRACE_ID_9) is not a setting.
 */
export function settingCaps(name: string): boolean {
  if (!ENV_FORM.test(name)) return false;
  if (CAPS_ENV_PREFIX.test(name)) return true;
  const words = name.split("_");
  return words.some((w, i) => CAPS_SETTING_WORDS.has(w) || (w === "SEED" && words[i + 1] === "PHRASE"));
}
/** Words that make a quoted name a secret or a connection setting (rule 5 of nameClass). */
const SECRET_WORDS = new Set(["secret", "secrets", "password", "passwords", "passwd", "mnemonic", "jwt", "dsn", "privatekey", "apikey", "rpcurl"]);
/** The same, written as two words (private_key, seed_phrase, api_key, access_token, rpc_url, database_url). */
const SECRET_PAIRS = new Set(["privatekey", "seedphrase", "apikey", "accesstoken", "rpcurl", "databaseurl"]);

/** Pure. A name that holds one of SECRET_WORDS or SECRET_PAIRS as words (split at camelCase, _ and -). */
export function secretWordName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (SECRET_PAIRS.has(canon(name))) return true;
  return words.some((w, i) => SECRET_WORDS.has(w) || (i + 1 < words.length && SECRET_PAIRS.has(w + words[i + 1])));
}

/**
 * Pure. The kind of one missing name (reviews of 8a4a23f and 82606e3: S only on strong evidence):
 *   "S" the seller's own setting, only when one of these holds:
 *       1. capitals with an underscore that mean a setting (settingCaps: DATABASE_URL, DB_HOST, NODE_ENV), quoted or not
 *       2. a known setting run together (JOINED_SETTING: ACCESSTOKEN, RPCURL, ...), exactly
 *       3. a structural place under config, env, settings or secrets (JSON key path, Zod path, pydantic loc)
 *       4. a structural header (Fastify headers, pydantic loc header, Zod path headers, "(in: header)",
 *          "(location: header)", "Missing required header: 'x'"); a header named in prose ("checked headers 'x'")
 *          only when quoted and not vet402's input
 *       5. a name written as a name (quoted, or an identifier with _ or camelCase: secret_token, dbPassword) that
 *          holds a secret word (SECRET_WORDS, SECRET_PAIRS)
 *       6. the name right before "environment variable" / "env var", when not vet402's input
 *   "A" vet402's input: declared by the listing (any case, snake or camel), or an allowed word when it declares nothing
 *   "U" anything else (an ordinary word, the first word of an explanation: "token", "host", "public")
 * A declared name is S only by rule 3 or 4 (structural).
 */
export function nameClass(m: MissingName, declared: readonly string[] = []): "A" | "S" | "U" {
  const c0 = classOf(m, declared);
  // A name found only where no missing name stands (in brackets, after "e.g.", "code", "default:", "of type", in a
  // URL...) is never the seller's setting.
  return c0 === "S" && m.outOfPlace ? "U" : c0;
}

function classOf(m: MissingName, declared: readonly string[]): "A" | "S" | "U" {
  if (m.header) return "S";
  if (m.path.some((x) => SELLER_PATH.test(x))) return "S";
  const c = canon(m.name);
  const input = declared.some((d) => canon(d) === c) || (declared.length === 0 && (ALLOWED.has(c) || ALLOWED.has(singular(c))));
  if (input) return "A";
  if ((m.proseHeader && m.quoted) || m.envVar) return "S";
  if (settingCaps(m.name) || JOINED_SETTING.test(m.name)) return "S";
  // Rule 5 needs the name written as a name: quoted, or as an identifier (secret_token, dbPassword), never a prose word.
  if ((m.quoted || /_|[a-z][A-Z]/.test(m.name)) && secretWordName(m.name)) return "S";
  return "U";
}

/**
 * Pure. The JSON of an answer, also after a prefix ("400 Bad Request: {...}", "Error 400: {...}"): the text before it
 * and the parsed JSON, or null.
 */
export function jsonPart(text: string): { prefix: string; json: unknown } | null {
  const t = text.trim();
  for (let i = 0; i < t.length && i < 200; i++) {
    // After a prefix only an object ("Missing required parameters: ['wallet']" is a list in a sentence, not JSON).
    if (t[i] !== "{" && (i > 0 || t[i] !== "[")) continue;
    try {
      return { prefix: t.slice(0, i), json: JSON.parse(t.slice(i)) };
    } catch {
      if (i === 0) continue;
    }
  }
  return null;
}

/** Pure. The pieces of an answer: every string value of JSON (or of cut-off JSON), else each sentence. */
export function answerPieces(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const jp = !t.startsWith("{") && !t.startsWith("[") ? jsonPart(t) : null;
  if (jp) return [...sentences(jp.prefix), ...answerPieces(JSON.stringify(jp.json))];
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
      // Not JSON ("[VALIDATION_ERROR] Missing required parameter: wallet", "[400] wallet is required"): prose.
      if (!/"\s*:/.test(t)) return sentences(t);
      // Cut off at 300 characters: the quoted strings, without their keys.
      return [...t.matchAll(/"((?:[^"\\]|\\.)*)"(?!\s*:)/g)].map((m) => m[1]!.replace(/\\"/g, '"')).flatMap(sentences);
    }
  }
  return sentences(t);
}

/** A line (or a piece after ";") that holds only list items: 'a', "b", `c`, a, - a, [a, b]. */
const BARE_ITEMS = new RegExp(
  String.raw`^\[?\s*(?:[-*\u2022]\s+)?(?:\\?["'\x60][A-Za-z_$][\w$.-]*\\?["'\x60]|[A-Za-z_$][\w$.-]*)(?:\s*[,;]\s*(?:[-*\u2022]\s+)?(?:\\?["'\x60][A-Za-z_$][\w$.-]*\\?["'\x60]|[A-Za-z_$][\w$.-]*))*\s*\]?\s*[,;]?$`,
);

/**
 * The sentences of a text. A list the answer spreads over lines or ";" ("Missing required parameters:\nwallet\nsymbol",
 * "'wallet';  'DATABASE_URL'", "'wallet',\n  'DATABASE_URL'") stays one sentence: a piece that holds only list items
 * joins the piece before it when that piece ends with ":", "," or ";", or is itself such a list.
 */
function sentences(s: string): string[] {
  const out: string[] = [];
  let inList = false;
  for (const x of s.split(/(?<=[.!?;])\s+|\n+/).map((y) => y.trim()).filter(Boolean)) {
    const prev = out.at(-1);
    if (prev !== undefined && BARE_ITEMS.test(x) && (/[:,;]$/.test(prev) || inList)) {
      const item = x.replace(/^(\[?\s*)[-*\u2022]\s+/, "$1");
      out[out.length - 1] = /[:,;]$/.test(prev) ? `${prev} ${item}` : `${prev}, ${item}`;
      inList = true;
      continue;
    }
    inList = false;
    out.push(x);
  }
  return out;
}

const ID = String.raw`[A-Za-z_$][\w$.-]*`;
const Q = String.raw`\\?["'\x60]?`;
/**
 * Words for what an answer holds (data, history, a balance...). A sentence with one of them names the seller's
 * missing content ("Missing data for wallet", "Missing wallet history"), not an input vet402 left out.
 */
const CONTENT_WORDS = /\b(data|history|histories|support|supported|balances?|transactions?|records?|results?|info|information|prices?|quotes?|liquidity|holders?|activity|metadata|stats|statistics|coverage)\b/i;

/**
 * "x is required to <anything>" is read by x alone, never by the words after "required to": x declared by the
 * listing (or an allowed word when it declares nothing) is vet402's missing input; a name the name rules give to
 * the seller (a setting name, a header, an ALL_CAPS quoted name) is the seller's. A condition the seller states on
 * what x holds ("required to own at least one NFT") is read the same way: at worst it becomes vet402's label, which
 * never blames the seller (and the lane's ledger allows each seller once, so no money moves on it).
 */

/** A validator's fixed message for one field (marshmallow, webargs, DRF, FastAPI, Zod): the field is the JSON key. */
const VALIDATOR_FIELD_MESSAGE = /^(missing data for required field|this field is required|this field may not be (?:null|blank)|field required|required)\.?$/i;
/** Keys that hold such messages for the whole request, not for a field named by the key. */
const FIELD_MESSAGE_KEYS_NOT_NAMES = new Set(["formErrors", "fieldErrors", "errors", "non_field_errors", "detail", "message", "messages", "error", "msg"]);

/** JSON keys whose value lists the missing names. */
const MISSING_LIST_KEY = /^(?:missing|required)(?:[_-]?(?:fields?|params?|parameters?|keys?|args?|arguments?|inputs?|properties))?$/i;

/** A sentence that says something is missing or required. */
const CUE = /\b(missing|required|cannot be empty|must not be empty|must be provided)\b/i;
const GENERIC = /^(fields?|params?|parameters?|arguments?|args?|propert(y|ies)|keys?|values?|inputs?)$/i;
const STOP = new Set(["for", "in", "from", "of", "to", "the", "a", "an", "this", "that", "data", "when", "with", "or", "and", "is", "are", "was", "be", "at", "on"]);

/**
 * Names given as "<input word> for x": "missing value for x", "Missing required parameter for 'x'", "Missing a value
 * for x", "Value for 'x' is missing", and Rails' "param is missing or the value is empty: x". After a content word
 * ("Data for 'x' is missing") the name only says whose content is missing, and is not read here.
 */
/** A quoted name: 'x', "x", `x` (also with escaped quotes inside JSON). */
const QUOTED_NAME = String.raw`\\?["'\x60]${"[A-Za-z_$][\\w$.-]*"}\\?["'\x60]`;
/** A list of quoted names: 'a', 'b' | 'a' and 'b' | "a", "b" | 'a', 'b', and 'c' | 'a' or 'b'. */
const QUOTED_LIST = String.raw`${QUOTED_NAME}(?:\s*(?:,\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+)${QUOTED_NAME})*`;

/**
 * Pure. Every name of every quoted list a sentence gives as missing: after "missing", after "missing <input word>:",
 * after "required <input word>:", and before "is/are missing|required". Each name of the list, not only the first.
 */
export function quotedListNames(piece: string): string[] {
  const W = String.raw`(?:parameter|param|property|field|argument|key|value|input)s?`;
  const spans = [
    new RegExp(String.raw`\bmissing\s*:?\s*(${QUOTED_LIST})`, "gi"),
    new RegExp(String.raw`\bmissing\s+(?:required\s+)?${W}\s*:?\s*(${QUOTED_LIST})`, "gi"),
    new RegExp(String.raw`\brequired\s+${W}\b\s*:?\s*(${QUOTED_LIST})`, "gi"),
    new RegExp(String.raw`(?<!\bfor\s{1,3})(${QUOTED_LIST})\s+(?:is|are)\s+(?:missing|required)\b`, "gi"),
  ];
  const out: string[] = [];
  for (const re of spans) for (const m of piece.matchAll(re)) for (const q of m[1]!.matchAll(/\\?["'`]([A-Za-z_$][\w$.-]*)\\?["'`]/g)) out.push(q[1]!);
  return [...new Set(out)];
}

/** Words that never start a list item (articles, joining words, the cue words themselves). */
const ITEM_STOP = new Set([...STOP, "missing", "required", "not", "must", "should", "please", "see", "check"]);
const INPUT_WORDS = String.raw`(?:parameter|param|property|field|argument|arg|key|value|input)s?`;
/** List openers: after an input word ("Missing required parameters:", "Missing value for key", "required fields:"), or after "missing" alone. */
const LIST_HEADS: readonly [RegExp, boolean][] = [
  [new RegExp(String.raw`\bmissing\s+(?:required\s+)?${INPUT_WORDS}\b\s*:?\s*(?:for\s+(?:the\s+)?(?:(?:key|field|parameter|param|argument)\s+)?)?`, "gi"), true],
  [new RegExp(String.raw`\brequired\s+${INPUT_WORDS}\b\s*:?\s*`, "gi"), true],
  [/\bmissing\b\s*(:?)\s*/gi, false],
];

/**
 * Pure. Every name of every list a sentence gives as missing, quoted or not, in [ ] or not, separated by ",", ";",
 * "and", "or" or a line ("Missing required parameters: 'wallet', DB_HOST", "Missing keys: ['wallet', 'symbol']",
 * "Missing required parameters: 'wallet' and RPC url"). Each item gives its first word; an item of several words that
 * makes a setting name ("RPC url", "database url") gives the whole item too. After "missing" alone, an unquoted list is
 * read only after a colon. `strong`: read after an input word, or quoted or in [ ].
 */
export function listNames(piece: string): { name: string; strong: boolean }[] {
  const out: { name: string; strong: boolean }[] = [];
  const quotedItem = new RegExp(String.raw`^\\?["'\x60](${ID})\\?["'\x60]`);
  const word = new RegExp(String.raw`^(${ID})`);
  for (const [head, inputWord] of LIST_HEADS) {
    for (const h of piece.matchAll(head)) {
      const s = piece.slice(h.index! + h[0].length);
      let i = 0;
      const eat = (re: RegExp) => {
        const m = re.exec(s.slice(i));
        if (m) i += m[0].length;
        return m;
      };
      let marked = !!eat(/^\[\s*/);
      const got: string[] = [];
      for (;;) {
        eat(/^(?:[-*\u2022]\s+)?/);
        const q = eat(quotedItem);
        if (q) {
          got.push(q[1]!);
          marked = true;
        } else {
          eat(/^(?:(?:a|an|the)\s+)?/i);
          const w = eat(word);
          if (!w || ITEM_STOP.has(w[1]!.toLowerCase())) break;
          const words = [w[1]!];
          for (let k = 0; k < 2; k++) {
            const more = new RegExp(String.raw`^\s+(${ID})`).exec(s.slice(i));
            if (!more || ITEM_STOP.has(more[1]!.toLowerCase()) || /^(?:is|are)$/i.test(more[1]!)) break;
            words.push(more[1]!);
            i += more[0].length;
          }
          got.push(words[0]!);
          // An item of several words gives only its first word (an ordinary word unless declared), and the whole item
          // when its words run together make a known setting exactly ("RPC url" is RPCURL).
          const joined = words.join("").toUpperCase();
          if (words.length > 1 && JOINED_SETTING.test(joined)) got.push(joined);
          // A later word in an environment variable's form or a known joined setting is a name of its own ("wallet DB_HOST").
          for (const w of words.slice(1)) if (settingCaps(w) || JOINED_SETTING.test(w)) got.push(w);
        }
        const wasQuoted = !!q;
        eat(/^\s*\]/);
        if (eat(/^\s*[,;/&+|]\s*(?:(?:and|or)\s+)?\[?\s*|^\s+(?:and|or)\s+\[?\s*/i)) continue;
        // After a quoted name, a name after a space is the next item ("'wallet' DB_HOST").
        if (wasQuoted && eat(/^\s+(?=[\\"'\x60A-Za-z_$])/)) continue;
        break;
      }
      if (!got.length) continue;
      if (!inputWord && !marked && !h[1]) continue;
      for (const n of got) out.push({ name: n, strong: inputWord || marked });
    }
  }
  // One entry per name ("Missing required parameters: ..." opens the same list twice); strong when any opener says so.
  const by = new Map<string, boolean>();
  for (const n of out) by.set(n.name, (by.get(n.name) ?? false) || n.strong);
  return [...by].map(([name, strong]) => ({ name, strong }));
}

/**
 * Pure. A sentence with the words around a name taken off: an annotation after it ("'wallet' (type: 'string') is
 * required") and the part of the request before an input word ("Missing required query parameter 'wallet'"). The
 * part (query, body, path) is where the name goes, not a name.
 */
/** Words after which a value follows, not a missing name. */
const VALUE_AFTER = String.raw`(?:e\.g\.?|i\.e\.?|for\s+example|such\s+as|one\s+of|default|expected|example|code|error|status|reason|request[ _-]?id|trace(?:[ _-]?id)?)`;

/**
 * Pure. A sentence with every place where no missing name stands blanked out: brackets "( )", URLs, the value after
 * "e.g.", "for example", "one of", "default:", "expected:", "code", "error", "status", "reason", "request id",
 * "trace", and "of type 'X'", "not the / your / a / an 'X'" (with the noun after it: "environment variable"). A name read only from such a place is never the seller's setting.
 */
export function namePlaces(piece: string): string {
  const blank = (x: string) => " ".repeat(x.length);
  let t = piece.replace(/\b(?:https?|ftp):\/\/\S+/gi, blank);
  for (let k = 0; k < 3; k++) t = t.replace(/\([^()]*\)/g, blank);
  t = t.replace(new RegExp(String.raw`\b(?:${VALUE_AFTER}\s*[:=]?\s*)+(?:${QUOTED_LIST}|${ID}(?:\s*(?:,|\bor\b)\s*${ID})*)`, "gi"), blank);
  t = t.replace(new RegExp(String.raw`\bof\s+type\s+${Q}${ID}${Q}`, "gi"), blank);
  // "not the 'X' environment variable", "not your 'X'", "not a 'X'": what the name is not, with the words it names.
  t = t.replace(new RegExp(String.raw`\bnot\s+(?:the|your|an?)\s+${Q}${ID}${Q}(?:\s+(?:environment\s+variables?|env\s+vars?|headers?|config\w*|settings?|secrets?|variables?|values?|fields?|parameters?|keys?))?`, "gi"), blank);
  return t;
}

/** Pure. A sentence without its format and type notes ("(format: 'ETH_ADDRESS')", "(type: 'HEX_STRING')"). */
export function withoutTypeNotes(piece: string): string {
  return piece.replace(/\s*\(\s*(?:type|format)\s*:[^()]*\)/gi, "");
}

export function plainSentence(piece: string): string {
  return piece
    .replace(new RegExp(String.raw`\s+of\s+type\s+${Q}${ID}${Q}`, "gi"), "")
    .replace(/\s*\(\s*(?:type|format|in|location|expected)\s*:[^()]*\)/gi, "")
    .replace(new RegExp(String.raw`(\b(?:missing|required)\s+(?:required\s+)?)(?:query|querystring|body|path|form|url)\s+(?=${INPUT_WORDS}\b)`, "gi"), "$1");
}

function inputForNames(piece: string): string[] {
  const out: string[] = [];
  const W = String.raw`(?:value|parameter|param|argument|field|input)s?`;
  for (const q of piece.matchAll(new RegExp(String.raw`\bmissing\s+(?:required\s+)?(?:(?:a|an|the)\s+)?${W}\s+for\s+(?:the\s+)?(?:(?:key|field|parameter|param|argument)\s+(?=${Q}${ID}))?${Q}(${ID})`, "gi"))) out.push(q[1]!);
  for (const q of piece.matchAll(new RegExp(String.raw`\b${W}\s+for\s+(?:the\s+)?${Q}(${ID})${Q}\s+(?:is|are)\s+missing\b`, "gi"))) out.push(q[1]!);
  for (const q of piece.matchAll(new RegExp(String.raw`\bparam is missing or the value is empty:\s*${Q}(${ID})`, "gi"))) out.push(q[1]!);
  return out.filter((n) => !STOP.has(n.toLowerCase()));
}

/**
 * Pure. The names a sentence gives in a form that leaves no doubt that this input is what is missing: "required
 * property 'x'", "x is required" (and "x is required to ..."), "required field: x", and a quoted name ("missing 'x'",
 * "'x' is missing", not after "for"). "x is required to <anything>" gives x like "x is required": the words after
 * "required to" never decide the side. With one of these, the sentence's content words (data, price, history) are
 * not read as the seller's missing content.
 */
export function strongNamesInSentence(text: string): string[] {
  const piece = plainSentence(text);
  const out = new Set<string>();
  const add = (n: string | undefined) => {
    if (n && !STOP.has(n.toLowerCase())) out.add(n);
  };
  for (const q of piece.matchAll(new RegExp(String.raw`\brequired\s+property\s+${Q}(${ID})`, "gi"))) add(q[1]);
  for (const q of piece.matchAll(new RegExp(String.raw`${Q}(${ID})${Q}\s+(?:(?:parameter|param|property|field|argument|value)s?\b\s+)?(?:is|are)\s+(?:a\s+)?required\b`, "gi"))) add(q[1]);
  for (const q of piece.matchAll(new RegExp(String.raw`\brequired\s+(?:parameter|param|property|field|argument|key)s?\b\s*:?\s*${Q}(${ID}(?:\s*,\s*${ID})*)`, "gi"))) q[1]!.split(/\s*,\s*/).forEach(add);
  for (const n of inputForNames(piece)) add(n);
  for (const q of piece.matchAll(new RegExp(String.raw`\bmissing\s*:?\s*\\?["'\x60](${ID})\\?["'\x60]`, "gi"))) add(q[1]);
  for (const n of quotedListNames(piece)) add(n);
  for (const n of listNames(piece)) if (n.strong) add(n.name);
  for (const q of piece.matchAll(new RegExp(String.raw`\bmissing\s+(?:required\s+)?(?:parameter|param|property|field|argument|key|value|input)s?\s*:?\s*\\?["'\x60](${ID})\\?["'\x60]`, "gi"))) add(q[1]);
  for (const q of piece.matchAll(new RegExp(String.raw`(?<!\bfor\s{1,3})\\?["'\x60](${ID})\\?["'\x60]\s+(?:is|are)\s+missing\b`, "gi"))) add(q[1]);
  return [...out];
}

/**
 * Pure. Every missing name one sentence gives (empty when it names nothing), in any of the forms read here: the
 * strong ones (strongNamesInSentence) and the weaker ones ("Missing required fields: a, b", "missing x", "parameter x
 * is missing", "x cannot be empty"). namesInAnswer decides, with the content words, whether the sentence counts.
 */
/**
 * Pure. The unquoted subjects of "x is required to ..." in a sentence ("It is required to be a 0x address" gives It):
 * they are names only when declared or allowed (laneInputProblem), never a seller-side name by themselves.
 */
export function softNamesInSentence(piece: string): string[] {
  const out: string[] = [];
  for (const q of piece.matchAll(new RegExp(String.raw`(?<![\w"'\x60\\])(${ID})\s+(?:(?:parameter|param|property|field|argument|value)s?\b\s+)?(?:is|are)\s+(?:a\s+)?required\s+to\b`, "gi"))) out.push(q[1]!);
  return out;
}

export function namesInSentence(text: string): string[] {
  const piece = plainSentence(text);
  const out: string[] = [];
  const push = (n: string | undefined) => {
    const x = (n ?? "").replace(/^[.\-]+|[.\-]+$/g, "");
    if (x && !STOP.has(x.toLowerCase())) out.push(x);
  };
  let m: RegExpExecArray | null;
  // Fastify: "querystring must have required property 'x'" (the part is read by namesInAnswer).
  if ((m = new RegExp(String.raw`\bmust have required property\s+${Q}(${ID})`, "i").exec(piece))) push(m[1]);
  // missing "x", missing: 'x'
  for (const q of piece.matchAll(new RegExp(String.raw`\bmissing\s*:?\s*\\?["'\x60](${ID})\\?["'\x60]`, "gi"))) push(q[1]);
  // Every name of a quoted list ("Missing required parameters: 'wallet', 'DATABASE_URL'"), not only the first.
  for (const n of quotedListNames(piece)) push(n);
  // Every list, quoted or not, in [ ] or on lines: "'wallet', DB_HOST" gives both names (a list is never cut at its
  // first unquoted name).
  for (const n of listNames(piece)) push(n.name);
  // missing parameter: "x", Missing required field 'x'
  for (const q of piece.matchAll(new RegExp(String.raw`\bmissing\s+(?:required\s+)?(?:parameter|param|property|field|argument|key|value|input)s?\s*:?\s*\\?["'\x60](${ID})\\?["'\x60]`, "gi"))) push(q[1]);
  // Missing [required] [fields|params|...][:] a, b and c  |  missing <generic>  |  missing x
  for (const q of piece.matchAll(new RegExp(String.raw`\bmissing\s*:?\s*(?:required\s+)?(?:(${ID})\s*:\s*|(${ID})\s+)?(${ID}(?:\s*(?:,|\band\b)\s*${ID})*)?`, "gi"))) {
    const head = q[1] ?? q[2];
    const list = (q[3] ?? "").split(/\s*(?:,|\band\b)\s*/).filter(Boolean);
    if (head && GENERIC.test(head)) {
      if (list.length && !STOP.has(list[0]!.toLowerCase())) list.forEach(push);
      // "missing value for x": x is the name (below), not value. "Missing key: 'wallet'", "Missing keys ['a']": the
      // input word opens the list, it is no name.
      else if (list[0]?.toLowerCase() !== "for" && !/^\s*:?\s*(?:\\?["'\x60]|\[)/.test(piece.slice(q.index! + q[0].length))) push(head);
    } else if (head) push(head);
    else list.slice(0, 1).forEach(push);
  }
  // "missing value for x", "missing parameter for x": only right after an input word ("Missing data for wallet"
  // names the seller's data, and "(… for balance lookup)" is a note, not a name).
  for (const n of inputForNames(piece)) push(n);
  // Joi / plain: '"x" is required', "x is required", "The 'x' parameter is required", Yup "x is a required field"
  for (const q of piece.matchAll(new RegExp(String.raw`${Q}(${ID})${Q}\s+(?:(?:parameter|param|property|field|argument|value)s?\b\s+)?(?:is|are)\s+(?:a\s+)?required\b`, "gi"))) push(q[1]);
  // "required field(s): x, y" / "required property 'x'"
  // Longer words first and a word boundary after them: "parameter" is never read as "param" + "eter".
  for (const q of piece.matchAll(new RegExp(String.raw`\brequired\s+(?:parameter|param|property|field|argument|key)s?\b\s*:?\s*${Q}(${ID}(?:\s*,\s*${ID})*)`, "gi"))) q[1]!.split(/\s*,\s*/).forEach(push);
  // "'x' is missing", "\"x\" is missing", "parameter x is missing": a quoted name, or one right after an input word.
  // "Data for this wallet is missing" names no missing input: the seller's data is missing.
  // Not after "for": in "Data for 'wallet' is missing" the data is what is missing, 'wallet' only says whose.
  for (const q of piece.matchAll(new RegExp(String.raw`(?<!\bfor\s{1,3})\\?["'\x60](${ID})\\?["'\x60]\s+(?:is|are)\s+missing\b`, "gi"))) push(q[1]);
  for (const q of piece.matchAll(new RegExp(String.raw`\b(?:parameter|param|property|field|argument|key)\s+(${ID})\s+(?:is|are)\s+missing\b`, "gi"))) push(q[1]);
  // "the wallet parameter is missing", "wallet parameter is missing"
  for (const q of piece.matchAll(new RegExp(String.raw`(${ID})\s+(?:parameter|param|property|field|argument|key)\s+(?:is|are)\s+missing\b`, "gi"))) push(q[1]);
  // "Parameters wallet and symbol are missing", "fields a, b are missing"
  for (const q of piece.matchAll(new RegExp(String.raw`\b(?:parameters|params|properties|fields|arguments|keys)\s+(${ID}(?:\s*(?:,|\band\b)\s*${ID})*)\s+(?:is|are)\s+missing\b`, "gi"))) q[1]!.split(/\s*(?:,|\band\b)\s*/).filter(Boolean).forEach(push);
  // "x cannot be empty", "x must not be empty", "x must be provided"
  for (const q of piece.matchAll(new RegExp(String.raw`${Q}(${ID})${Q}\s+(?:cannot be empty|must not be empty|must be provided)`, "gi"))) push(q[1]);
  // A sentence that names the input in quotes ("Missing required parameter: 'wallet'") gives that name; its input
  // words (parameter, field, value...) are not names then.
  // Only when every quoted name of the sentence was read; "key" is never dropped ("... and missing key").
  const quotedAll = [...piece.matchAll(new RegExp(String.raw`\\?["'\x60](${ID})\\?["'\x60]`, "g"))].map((q) => q[1]!);
  if (quotedAll.length && quotedAll.every((q) => out.includes(q))) return [...new Set(out.filter((n) => !GENERIC.test(n) || /^keys?$/i.test(n)))];
  return [...new Set(out)];
}

/**
 * Pure. Every missing name in an answer, from structured JSON (Zod issues and fieldErrors, pydantic loc, Fastify
 * part) and from each sentence.
 *   tainted     a sentence that says something is missing speaks of the seller's missing content (a content word:
 *               data, history, price...) and names no input in a form that leaves no doubt
 *   authPieces  sentences whose only seller-side sign is a payment or authentication word (NOT_INPUT); such a
 *               sentence counts only when it names no input of vet402's (laneInputProblem)
 * A seller-side word (server, upstream, env, config, database, response...) decides nothing by itself: an answer
 * with an input of vet402's (A) and no setting of the seller's (S) is vet402's; one with no A is the seller's anyway.
 */
export function namesInAnswer(text: string): { names: MissingName[]; tainted: boolean; authPieces: number[] } {
  const names: MissingName[] = [];
  let tainted = false;
  /** Sentences whose only sign of the seller's side is a payment or authentication word (NOT_INPUT). */
  const authPieces: number[] = [];
  const j: unknown = jsonPart(text)?.json;
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
      if (last) names.push({ name: last, header: path.some((x) => /^headers?$/i.test(x)), path: [...keys, ...path], source: "zod" });
    }
    // pydantic / FastAPI
    if (Array.isArray(o.loc) && (o.type === "missing" || o.type === "value_error.missing" || /field required/i.test(msg))) {
      const loc = strs(o.loc);
      const last = loc.at(-1);
      if (last) names.push({ name: last, header: /^headers?$/i.test(loc[0] ?? ""), path: [...keys, ...loc], source: "pydantic" });
    }
    // marshmallow / webargs / DRF: {"wallet": ["Missing data for required field."]}, {"wallet": ["This field is required."]}
    for (const [k, v] of Object.entries(o)) {
      if (FIELD_MESSAGE_KEYS_NOT_NAMES.has(k) || !Array.isArray(v)) continue;
      // Under "headers": a header vet402 does not send, never its input.
      if (v.some((x) => typeof x === "string" && VALIDATOR_FIELD_MESSAGE.test(x.trim()))) names.push({ name: k, header: keys.some((x) => /^headers?$/i.test(x)), path: [...keys, k], source: "field-messages" });
    }
    // {"missing":["wallet"]}, {"required":["wallet"]}, {"missingFields":["a","b"]}: each element is a missing name. A
    // JSON schema the answer quotes (with properties or a JSON type) is a declaration, not a list of what is missing.
    if (!isObjD(o.properties) && !isJsonType(o.type)) {
      for (const [k, v] of Object.entries(o)) {
        if (!MISSING_LIST_KEY.test(k)) continue;
        const items = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
        for (const x of items) if (typeof x === "string" && new RegExp(String.raw`^${ID}$`).test(x.trim())) names.push({ name: x.trim(), header: keys.some((y) => /^headers?$/i.test(y)), path: [...keys, k], source: "json-list" });
      }
      // {"error":"Missing required fields","fields":["wallet"]}: a list under an input word, next to a message that
      // says something is missing or required.
      if (Object.values(o).some((x) => typeof x === "string" && CUE.test(x))) {
        for (const [k, v] of Object.entries(o)) {
          if (!GENERIC.test(k) || !Array.isArray(v)) continue;
          for (const x of v) if (typeof x === "string" && new RegExp(String.raw`^${ID}$`).test(x.trim())) names.push({ name: x.trim(), header: keys.some((y) => /^headers?$/i.test(y)), path: [...keys, k], source: "json-list" });
        }
      }
    }
    // Zod .flatten()
    if (o.fieldErrors && typeof o.fieldErrors === "object" && !Array.isArray(o.fieldErrors)) {
      for (const [k, msgs] of Object.entries(o.fieldErrors as Record<string, unknown>)) {
        if (Array.isArray(msgs) && msgs.some((x) => typeof x === "string" && CUE.test(x))) names.push({ name: k, header: false, path: [...keys, k], source: "zod.fieldErrors" });
      }
    }
    for (const [k, x] of Object.entries(o)) walk(x, [...keys, k], depth + 1);
  };
  if (j !== undefined) walk(j, [], 0);
  const pieces = answerPieces(text);
  for (let pi = 0; pi < pieces.length; pi++) {
    const raw = pieces[pi]!;
    const piece = plainSentence(raw);
    if (!CUE.test(piece)) continue;
    // A validator's fixed message for one field ("Missing data for required field.") is read with its key above.
    if (VALIDATOR_FIELD_MESSAGE.test(piece.trim())) continue;
    // A content word (data, history, price...) makes the sentence about the seller's missing content, unless the
    // sentence names the missing input in a form that leaves no doubt (strongNamesInSentence). A payment or
    // authentication word ("a valid signature"), where a name stands (not in a URL, brackets, an example or "not a
    // 'privateKey'"), counts only when the sentence names no input of vet402's. A seller-side word (server, env,
    // config...) is not read here (review of 60760cf: it never overrides vet402's input).
    const noUrl = namePlaces(piece);
    if (CONTENT_WORDS.test(piece) && strongNamesInSentence(piece).length === 0) tainted = true;
    else if (!SELLER_SIDE.test(noUrl) && NOT_INPUT.test(noUrl)) authPieces.push(pi);
    const places = namePlaces(raw);
    // A joined setting read from two words ("RPC url" gives RPCURL) is looked for with the space.
    const inPlace = (n: string) =>
      new RegExp(String.raw`(?<![\w$.-])${n.replace(/[$.]/g, "\\$&")}(?![\w$])`, "i").test(places) ||
      (JOINED_SETTING.test(n) && new RegExp(String.raw`(?<![\w$.-])${n.split("").join(String.raw`\s*`)}(?![\w$])`, "i").test(places));
    // Headers (rule 4 of nameClass). Structural: an annotation "(in: header)" / "(location: header)" (on the name, or
    // anywhere in the sentence), and a list the answer gives as missing headers ("Missing required header: 'x'").
    // In prose ("checked headers 'x'", "'x' header"): quoted only, and S only when vet402 does not send x.
    const headerNames = new Set<string>();
    for (const q of raw.matchAll(new RegExp(String.raw`${Q}(${ID})${Q}\s*\(\s*(?:in|location)\s*:\s*${Q}headers?${Q}\s*\)`, "gi"))) headerNames.add(q[1]!);
    const headerSentence = new RegExp(String.raw`\(\s*(?:in|location)\s*:\s*${Q}headers?${Q}\s*\)`, "i").test(raw);
    const headerList: string[] = [];
    // Only a list given as missing headers: "Missing required header(s): ...", "missing header(s): ...", "header(s)
    // missing: ...". "Required headers: Accept" says what the seller wants sent, not what is missing.
    const HEADER_LIST = String.raw`(${QUOTED_LIST}|${ID}(?:\s*,\s*${ID})*)`;
    for (const re of [
      new RegExp(String.raw`\bmissing\s+(?:required\s+)?(?:(?:request|http)\s+)?headers?\b\s*:?\s*${HEADER_LIST}`, "gi"),
      new RegExp(String.raw`\bheaders?\s+(?:is\s+|are\s+)?missing\b\s*:?\s*${HEADER_LIST}`, "gi"),
    ]) {
      for (const q of raw.matchAll(re)) {
        if (/^\s*(?:none|n\/a|empty|null|nil|no|nothing)\b/i.test(raw.slice(q.index! + q[0].length - q[1]!.length))) continue;
        for (const x of q[1]!.split(/\s*(?:,|\band\b|\bor\b)\s*/)) {
          const n = x.replace(/^\\?["'\x60]|\\?["'\x60]$/g, "").replace(/[.\-:;]+$/, "");
          if (new RegExp(String.raw`^${ID}$`).test(n) && !STOP.has(n.toLowerCase()) && !/^(?:none|empty|n|null|nil|no|nothing)$/i.test(n)) headerList.push(n);
        }
      }
    }
    headerList.forEach((n) => headerNames.add(n));
    const proseHeader = new Set<string>();
    for (const q of raw.matchAll(new RegExp(String.raw`\\?["'\x60](${ID})\\?["'\x60]\s+headers?\b`, "gi"))) proseHeader.add(q[1]!);
    for (const q of raw.matchAll(new RegExp(String.raw`\bheaders?\s*:?\s*\\?["'\x60](${ID})\\?["'\x60]`, "gi"))) proseHeader.add(q[1]!);
    // Rule 6: the name right before "environment variable" / "env var" (S only when vet402 does not send it).
    const envVar = new Set<string>();
    // Quoted ('node_url' environment variable), or without quotes only a name that means a setting (DATABASE_URL env
    // var); "the env var", "or env var", "your env vars", "this environment variable" name nothing.
    for (const q of raw.matchAll(new RegExp(String.raw`\\?["'\x60](${ID})\\?["'\x60]\s+(?:environment\s+variable|env\s+var)`, "gi"))) envVar.add(q[1]!);
    for (const q of raw.matchAll(new RegExp(String.raw`(?<![\w$.\-"'\x60\\])(${ID})\s+(?:environment\s+variable|env\s+var)`, "g"))) if (settingCaps(q[1]!)) envVar.add(q[1]!);
    const f = /\b(querystring|body|params|headers)\s+must have required property/i.exec(piece);
    // A sentence written all in capitals ("WALLET IS REQUIRED TO PROCEED") is read without case: its unquoted names
    // are not ALL_CAPS setting names. A quoted name keeps its case (\"DATABASE_URL\" is required).
    const shouting = /[A-Z]/.test(piece) && !/[a-z]/.test(piece);
    const quoted = (n: string) => new RegExp(String.raw`["'\x60]${n.replace(/[$.]/g, "\\$&")}["'\x60]`).test(piece);
    const soft = new Set(softNamesInSentence(piece).map((x) => x.toLowerCase()));
    // A name the sentence also gives in another form (quoted, "required field: x") is not soft.
    const firm = new Set(strongNamesInSentence(piece.replace(new RegExp(String.raw`(${ID})(\s+(?:(?:parameter|param|property|field|argument|value)s?\b\s+)?(?:is|are)\s+(?:a\s+)?required)\s+to\b`, "gi"), "$1$2_to")).map((x) => x.toLowerCase()));
    for (const n of namesInSentence(piece)) {
      // A setting name as the subject (secret_token, DATABASE_URL, db_password) is never soft: it is the seller's.
      // In a sentence written all in capitals the subject is read without case ("IT" is it, not a setting name).
      // In a sentence written all in capitals the subject is read without case ("IT" is it, USER_ID is user_id), except
      // a name with an underscore that looks like a setting (a setting word, or an environment prefix: NODE_ENV,
      // AWS_REGION, INFURA_PROJECT_ID), which keeps its spelling for the environment-variable form.
      const keepsSpelling = settingCaps(n);
      const settingCheck = shouting && !quoted(n) && !keepsSpelling ? n.toLowerCase() : n;
      const isSoft = soft.has(n.toLowerCase()) && !quoted(n) && !firm.has(n.toLowerCase()) && !sellerSettingName(settingCheck);
      names.push({
        name: shouting && !quoted(n) && !keepsSpelling ? n.toLowerCase() : n,
        header: (!!f && f[1]!.toLowerCase() === "headers") || headerNames.has(n) || headerSentence,
        path: [],
        source: "text",
        piece: pi,
        ...(quoted(n) ? { quoted: true } : {}),
        ...(proseHeader.has(n) ? { proseHeader: true } : {}),
        ...(envVar.has(n) ? { envVar: true } : {}),
        ...(isSoft ? { soft: true } : {}),
        ...(inPlace(n) ? {} : { outOfPlace: true }),
      });
    }
    // A name the answer gives as a header in its structure ("Missing required header: 'x'", "'x' (in: header)") counts
    // even where the sentence reading above does not give it.
    const read = new Set(names.filter((x) => x.piece === pi).map((x) => x.name));
    for (const n of headerNames) {
      if (read.has(n)) continue;
      names.push({ name: n, header: true, path: [], source: "header", piece: pi, quoted: true, ...(inPlace(n) ? {} : { outOfPlace: true }) });
      read.add(n);
    }
    // So does a name the sentence gives as an environment variable ("'node_url' environment variable is required").
    for (const n of envVar) {
      if (read.has(n)) continue;
      names.push({ name: n, header: false, path: [], source: "env-var", piece: pi, quoted: quoted(n), envVar: true, ...(inPlace(n) ? {} : { outOfPlace: true }) });
      read.add(n);
    }
  }
  return { names, tainted, authPieces };
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
  const declared = r.declaredParams ?? [];
  const declaredCanon = new Set(declared.map(canon));
  // A JSON Schema word in an answer ("type", "items") is a missing name only when the listing declares it.
  const { names: all, tainted, authPieces } = namesInAnswer(text);
  // The unquoted subject of "x is required to ..." counts only when declared, or, on a listing that declares nothing,
  // when it is an allowed word (as rule (b) of missingNameSide). "It is required to be a 0x address" gives no name.
  const allowedOrDeclared = (n: MissingName) =>
    declaredCanon.has(canon(n.name)) || (declared.length === 0 && (ALLOWED.has(canon(n.name)) || ALLOWED.has(singular(canon(n.name)))));
  const names = all.filter((n) => (!SCHEMA_KEYWORDS.has(n.name) || declaredCanon.has(canon(n.name))) && (!n.soft || allowedOrDeclared(n)));
  if (tainted || names.length === 0) return null;
  // Review of 8a4a23f: each name is S (the seller's setting), A (vet402's input) or U (an ordinary word). Any S: the
  // seller's. Else any A: vet402's, and the U are ignored (a misread word never turns an answer about a declared
  // input into the seller's failure). Only U: the seller's, as before.
  const cls = names.map((n) => nameClass(n, declared));
  if (cls.includes("S")) return null;
  const inputs = names.filter((_, i) => cls[i] === "A");
  // No input of vet402's: the seller's, with or without a seller-side word ("upstream data missing").
  if (!inputs.length) return null;
  // A sentence whose only seller-side sign is a payment or authentication word, and that names no input of vet402's.
  if (authPieces.some((pi) => !inputs.some((n) => n.piece === pi))) return null;
  return { kind: "missing_input", detail: `the seller's ${status} says vet402 did not send ${[...new Set(inputs.map((n) => n.name))].join(", ")}` };
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

