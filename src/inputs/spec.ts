/**
 * What a seller says one endpoint takes, in one shape whatever the catalog: Mercator (inputSchema and
 * inputExample), an x402 Bazaar listing (extensions.bazaar.info.input and .schema), or the seller's own OpenAPI
 * document. Pure: parsing only.
 */

export interface ParamSpec {
  name: string;
  in: "query" | "body";
  type: string | null;
  required: boolean;
  description: string;
  enum: unknown[];
  /** The seller's own example or default for this parameter, as the catalog gives it (may be a placeholder). */
  example: unknown;
}

export interface EndpointSpec {
  method: string;
  /** Endpoint description: used only to recognise an endpoint that sends a message to someone. */
  description: string;
  params: ParamSpec[];
  /** The seller's example answer, when a catalog has one (a value for a parameter may be found in it). */
  outputExample: unknown;
  /** Where this came from, e.g. "mercator:/v1/services/orth-peopledatalabs". */
  source: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const DESC_MAX = 400;

function fromProps(schema: unknown, where: ParamSpec["in"], example: Obj): ParamSpec[] {
  if (!isObj(schema)) return [];
  const props = isObj(schema.properties) ? schema.properties : {};
  const req = Array.isArray(schema.required) ? schema.required.map(String) : [];
  const out: ParamSpec[] = [];
  const names = new Set([...Object.keys(props), ...req]);
  for (const name of names) {
    const p = isObj(props[name]) ? (props[name] as Obj) : {};
    const ex = p.example ?? p.default ?? (Array.isArray(p.examples) ? p.examples[0] : undefined) ?? example[name];
    out.push({
      name,
      in: where,
      type: typeof p.type === "string" ? p.type : null,
      required: req.includes(name) || p.required === true,
      description: str(p.description).slice(0, DESC_MAX),
      enum: Array.isArray(p.enum) ? p.enum : [],
      example: ex,
    });
  }
  return out;
}

/** Where an x402 listing keeps its declared input: the v2 Bazaar extension, `inputSchema`, or v1 `outputSchema.input`. */
function listingInput(item: Obj): Obj | null {
  const ext = isObj(item.extensions) && isObj(item.extensions.bazaar) ? item.extensions.bazaar : null;
  const info = ext && isObj(ext.info) ? ext.info : null;
  if (info && isObj(info.input)) return info.input;
  if (isObj(item.inputSchema)) return item.inputSchema;
  for (const a of Array.isArray(item.accepts) ? item.accepts : []) {
    const os = isObj(a) && isObj(a.outputSchema) ? a.outputSchema : null;
    if (os && isObj(os.input)) return os.input;
  }
  return null;
}

/** A Mercator endpoint (GET /v1/services/{id}, `service.endpoints[]`). */
export function fromMercator(ep: { method: string; description?: string; requestFormat?: string; inputSchema?: unknown; inputExample?: unknown }, source: string): EndpointSpec {
  const method = ep.method.toUpperCase();
  const asQuery = method === "GET" || method === "DELETE" || ep.requestFormat === "query";
  const example = isObj(ep.inputExample) ? ep.inputExample : {};
  return { method, description: str(ep.description).slice(0, DESC_MAX), params: fromProps(ep.inputSchema, asQuery ? "query" : "body", example), outputExample: null, source };
}

/** An x402 Bazaar listing (CDP discovery item or PayAI): the declared input and, when present, its JSON schema. */
export function fromBazaar(item: Obj, source: string): EndpointSpec | null {
  const ext = isObj(item.extensions) && isObj(item.extensions.bazaar) ? item.extensions.bazaar : null;
  const info = ext && isObj(ext.info) ? ext.info : null;
  const input = listingInput(item);
  if (!input) return null;
  const method = str(input.method || item.method || "GET").toUpperCase();
  const schemaInput = ext && isObj(ext.schema) && isObj(ext.schema.properties) && isObj(ext.schema.properties.input) ? ext.schema.properties.input : null;
  const sp = schemaInput && isObj(schemaInput.properties) ? schemaInput.properties : {};
  // The input's own map is either example values ({"vin":"example"}) or a JSON schema ({type, properties, required}).
  const part = (declared: unknown, schema: unknown, where: ParamSpec["in"]): ParamSpec[] => {
    const m = isObj(declared) ? declared : {};
    if (m.type === "object" && isObj(m.properties)) return fromProps(m, where, {});
    const values = Object.fromEntries(Object.entries(m).map(([k, v]) => [k, isObj(v) ? (v.example ?? v.default) : v]));
    return fromProps(isObj(schema) ? schema : { properties: Object.fromEntries(Object.keys(m).map((k) => [k, isObj(m[k]) ? m[k] : {}])) }, where, values);
  };
  const params = [...part(input.queryParams, sp.queryParams, "query"), ...part(input.body, sp.body, "body")];
  const output = info && isObj(info.output) ? info.output.example : null;
  return { method, description: str(item.description).slice(0, DESC_MAX), params, outputExample: output ?? null, source };
}

function deref(doc: Obj, v: unknown, depth = 0): unknown {
  if (depth > 8 || !isObj(v)) return v;
  const ref = v.$ref;
  if (typeof ref === "string" && ref.startsWith("#/")) {
    let x: unknown = doc;
    for (const k of ref.slice(2).split("/")) x = isObj(x) ? x[k] : undefined;
    return deref(doc, x, depth + 1);
  }
  return v;
}

/** One operation of the seller's own OpenAPI 3 document (query parameters and a JSON request body). */
export function fromOpenApi(doc: Obj, method: string, path: string, source: string): EndpointSpec | null {
  const paths = isObj(doc.paths) ? doc.paths : {};
  const key = Object.keys(paths).find((k) => k.replace(/\/+$/, "") === path.replace(/\/+$/, ""));
  const item = key && isObj(paths[key]) ? (paths[key] as Obj) : null;
  const op = item && isObj(item[method.toLowerCase()]) ? (item[method.toLowerCase()] as Obj) : null;
  if (!op) return null;
  const params: ParamSpec[] = [];
  const all = [...(Array.isArray(item!.parameters) ? item!.parameters : []), ...(Array.isArray(op.parameters) ? op.parameters : [])];
  for (const raw of all) {
    const p = deref(doc, raw);
    if (!isObj(p) || p.in !== "query" || typeof p.name !== "string") continue;
    const s = isObj(deref(doc, p.schema)) ? (deref(doc, p.schema) as Obj) : {};
    params.push({
      name: p.name,
      in: "query",
      type: typeof s.type === "string" ? s.type : null,
      required: p.required === true,
      description: str(p.description).slice(0, DESC_MAX),
      enum: Array.isArray(s.enum) ? s.enum : [],
      example: p.example ?? s.example ?? s.default,
    });
  }
  const rb = deref(doc, op.requestBody);
  const content = isObj(rb) && isObj(rb.content) ? rb.content : {};
  const json = isObj(content["application/json"]) ? (content["application/json"] as Obj) : null;
  if (json) {
    const schema = deref(doc, json.schema);
    const ex = isObj(json.example) ? json.example : {};
    params.push(...fromProps(isObj(schema) ? { ...schema, properties: Object.fromEntries(Object.entries(isObj(schema.properties) ? schema.properties : {}).map(([k, v]) => [k, deref(doc, v)])) } : {}, "body", ex));
  }
  return { method: method.toUpperCase(), description: str(op.summary ?? op.description).slice(0, DESC_MAX), params, outputExample: null, source };
}
