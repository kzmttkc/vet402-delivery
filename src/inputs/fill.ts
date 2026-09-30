/**
 * Turn the parameters vet402 would send into ones a seller can answer, or say why vet402 cannot. Pure.
 *
 * What is filled: a parameter whose value is a placeholder (a JSON type name such as "string", "example", a note
 * such as "<from x/y>", null), a parameter the seller marks required that is not sent, and a required field an
 * object parameter's description names ("domain (required, string)") that the object lacks. When nothing at all
 * is sent and the seller's own document gives concrete defaults, those defaults are sent. Nothing else changes:
 * a concrete value already in the request is kept as it is.
 *
 * Where a value comes from, first match wins:
 *   enum                  the seller's list of allowed values (first one)
 *   seller_example        the seller's own example or default for this parameter
 *   description_example   an "e.g." value in the seller's description of this parameter
 *   seller_output         the same field in the seller's own example answer
 *   description_models    the first model the description lists ("Available models: ...")
 *   table:<class>         src/inputs/values.ts, by what the parameter is
 *   description_list      the first item of a list in the description ("Platform: instagram, youtube, ...")
 * An endpoint that sends a message to someone (SMS, email, a verification code) is never filled.
 */
import type { EndpointSpec, ParamSpec } from "./spec.js";
import { CLASS_SHAPE, classify, tableValue, type Unfillable } from "./values.js";

export interface FilledParam {
  param: string;
  rule: string;
}

export type FillFailure = "sends_message" | "commits_to_purchase" | "path_placeholder" | Unfillable;

export type FillResult =
  | { ok: true; params: Record<string, unknown>; filled: FilledParam[] }
  | { ok: false; reason: FillFailure; param: string | null };

/** JSON schema type names and the words catalogs write where an example belongs. */
const PLACEHOLDER_WORDS = new Set(["string", "number", "integer", "boolean", "object", "array", "null", "example", "sample", "placeholder", "value", "your_value", "todo", "tbd"]);
const ANGLE_NOTE = /^<[^<>]+>$/;
/** "{id}" or "{company_domain}": a template slot. "{ __typename }" (a GraphQL query) is not one. */
const BRACE_NOTE = /^\{[A-Za-z_][A-Za-z0-9_-]*\}$/;

export function isPlaceholder(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v !== "string") return false;
  const t = v.trim();
  return t === "" || PLACEHOLDER_WORDS.has(t.toLowerCase()) || ANGLE_NOTE.test(t) || BRACE_NOTE.test(t) || /^your[_ -]/i.test(t);
}

/** A value, or anything inside it, is a placeholder. An empty object is not (it may be a valid empty input). */
export function containsPlaceholder(v: unknown): boolean {
  if (isPlaceholder(v)) return true;
  if (Array.isArray(v)) return v.length > 0 && v.some(containsPlaceholder);
  if (v && typeof v === "object") return Object.values(v).some(containsPlaceholder);
  return false;
}

/** A value the seller wrote that vet402 can send as is. */
function concrete(v: unknown): boolean {
  if (typeof v === "string") return !isPlaceholder(v) && v.length <= 200;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "boolean") return true;
  if (Array.isArray(v)) return v.length > 0 && !containsPlaceholder(v);
  if (v && typeof v === "object") return Object.keys(v).length > 0 && !containsPlaceholder(v);
  return false;
}

/**
 * An endpoint whose job is to send something to a person. Read from the seller's description only; a chat or
 * search endpoint that "sends a conversation to a model" is not one.
 */
export function sendsMessage(spec: Pick<EndpointSpec, "description" | "method">, path = ""): boolean {
  const d = spec.description.toLowerCase();
  if (/\bsend(s|ing)?\b[^.]{0,30}\b(sms|text message|e-?mail|verification code|one-time|otp|fax|letter|postcard)\b/.test(d)) return true;
  if (spec.method !== "GET" && path.split("/").some((s) => s === "send" || s === "sms")) return true;
  return false;
}

/**
 * An endpoint that commits vet402 to more than the one call it pays for: a subscription or monthly charge, or
 * buying or ordering a thing (a phone number, a domain, a gift card, a ticket, a shipment). Read from the
 * seller's description only.
 */
export function commitsToPurchase(spec: Pick<EndpointSpec, "description">): boolean {
  const d = spec.description.toLowerCase();
  if (/\bper (month|year)\b|\/(mo|month|yr|year)\b|\bmonthly\b|\byearly\b|\bannual\b|\bsubscri(be|ption)\b|\brecurring\b/.test(d)) return true;
  return /\b(buy|buys|purchase|purchases|order|orders|provision|provisions|register|registers|rent|rents|book|books)\b (a|an|the|one)?\s*(new )?(\w+ ){0,3}(phone number|number|domain|sim|esim|gift card|card|ticket|flight|hotel|room|shipment|shipping label|label|product|item|subscription|plan)\b/.test(d);
}

/** The value in an "e.g." of the description: quoted, back-ticked or up to the next space or comma. */
export function descriptionExample(desc: string): string | null {
  const m = /\be\.g\.?,?:?\s*(?:`([^`]+)`|"([^"]+)"|“([^”]+)”|'([^']+)'|([^\s,;)]+))/i.exec(desc);
  const v = m ? (m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? "").trim() : "";
  const clean = v.replace(/[.:]+$/, "");
  return clean && !isPlaceholder(clean) && clean.length <= 100 ? clean : null;
}

/** The first model a description lists: "Available models: deepseek-ai/DeepSeek-V3-0324 (164k context), ...". */
function descriptionModel(desc: string): string | null {
  const m = /\b(?:available|supported) models?:?\s*([A-Za-z0-9][A-Za-z0-9_.:/-]*[A-Za-z0-9])/i.exec(desc);
  return m ? m[1]! : null;
}

/** The first item of a short list after a colon or inside parentheses: "Platform: instagram, youtube, tiktok". */
function descriptionList(desc: string): string | null {
  const m = /(?::|\()\s*([a-z0-9_-]+)\s*,\s*[a-z0-9_-]+\s*,/i.exec(desc);
  return m ? m[1]! : null;
}

/** Field names an object parameter's description marks required: "domain (required, string)". */
export function requiredFieldsInDescription(desc: string): { name: string; description: string }[] {
  const out: { name: string; description: string }[] = [];
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(required\b[^)]*\)\s*:?\s*([^;]*)/g;
  for (const m of desc.matchAll(re)) out.push({ name: m[1]!, description: (m[2] ?? "").trim() });
  return out;
}

function findInOutput(v: unknown, key: string, depth = 0): unknown {
  if (depth > 6 || !v || typeof v !== "object") return undefined;
  if (!Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (key in o && concrete(o[key]) && typeof o[key] !== "object") return o[key];
  }
  for (const x of Array.isArray(v) ? v : Object.values(v)) {
    const got = findInOutput(x, key, depth + 1);
    if (got !== undefined) return got;
  }
  return undefined;
}

/** Match a value to the declared type; undefined when it cannot be. */
function typed(v: unknown, type: string | null): unknown {
  if (type === "number" || type === "integer") {
    if (typeof v === "number") return v;
    if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) return Number(v);
    return undefined;
  }
  if (type === "string") return typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
  if (type === "boolean") return typeof v === "boolean" ? v : undefined;
  if (type === "array") return Array.isArray(v) ? v : undefined;
  if (type === "object") return v && typeof v === "object" && !Array.isArray(v) ? v : undefined;
  return v;
}

type Value = { value: unknown; rule: string } | { unfillable: Unfillable };

function valueFor(p: Pick<ParamSpec, "name" | "type" | "description" | "enum" | "example">, spec: EndpointSpec | null, today: string, current: unknown): Value {
  const c = classify(p.name, p.description);
  // Structured parameters first: a chat, or an object whose description names its required fields.
  if (c.cls === "chat_messages") return { value: tableValue("chat_messages", today), rule: "table:chat_messages" };
  if (p.type === "object" || (current && typeof current === "object" && !Array.isArray(current))) {
    const fields = requiredFieldsInDescription(p.description);
    if (fields.length > 0) {
      const obj: Record<string, unknown> = current && typeof current === "object" && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
      const rules: string[] = [];
      for (const f of fields) {
        if (concrete(obj[f.name])) continue;
        const v = valueFor({ name: f.name, type: null, description: f.description, enum: [], example: undefined }, spec, today, undefined);
        if ("unfillable" in v) return v;
        obj[f.name] = v.value;
        rules.push(`${f.name}=${v.rule}`);
      }
      return { value: obj, rule: `fields(${rules.join(",")})` };
    }
    if (p.type === "object") return { unfillable: c.unfillable ?? "unknown_param" };
  }
  const first = p.enum.find(concrete);
  if (first !== undefined) return { value: first, rule: "enum" };
  if (concrete(p.example) && typed(p.example, p.type) !== undefined) return { value: typed(p.example, p.type), rule: "seller_example" };
  if (c.unfillable === "personal_data" || c.unfillable === "secret") return { unfillable: c.unfillable };
  const eg = descriptionExample(p.description);
  if (eg !== null) {
    const shape = c.cls ? CLASS_SHAPE[c.cls] : undefined;
    const v = typed(eg, p.type);
    if (v !== undefined && (!shape || shape.test(eg))) return { value: v, rule: "description_example" };
  }
  const out = spec ? findInOutput(spec.outputExample, p.name) : undefined;
  if (out !== undefined && typed(out, p.type) !== undefined) return { value: typed(out, p.type), rule: "seller_output" };
  if (/^model$/i.test(p.name)) {
    const m = descriptionModel(p.description);
    return m ? { value: m, rule: "description_models" } : { unfillable: "unknown_param" };
  }
  if (c.cls) {
    const v = typed(tableValue(c.cls, today), p.type);
    if (v !== undefined) return { value: v, rule: `table:${c.cls}` };
  }
  if (p.type === "string" || p.type === null) {
    const l = descriptionList(p.description);
    if (l) return { value: l, rule: "description_list" };
  }
  return { unfillable: c.unfillable ?? "unknown_param" };
}

/**
 * Fill `sent` (the parameters of one request: query values and JSON body fields together) against the seller's
 * spec. `spec` null: only placeholders are looked at, and filled from the table by name.
 */
export function fillParams(sent: Record<string, unknown>, spec: EndpointSpec | null, today: string, path = ""): FillResult {
  if (spec && sendsMessage(spec, path)) return { ok: false, reason: "sends_message", param: null };
  if (spec && commitsToPurchase(spec)) return { ok: false, reason: "commits_to_purchase", param: null };
  const params: Record<string, unknown> = structuredClone(sent);
  const specOf = new Map((spec?.params ?? []).map((p) => [p.name, p]));
  const todo: string[] = [];
  for (const [k, v] of Object.entries(params)) if (containsPlaceholder(v)) todo.push(k);
  for (const p of spec?.params ?? []) if (p.required && !(p.name in params) && !todo.includes(p.name)) todo.push(p.name);
  // An object parameter that lacks a field its description marks required ({"input":{}} for "domain (required)").
  for (const p of spec?.params ?? []) {
    const cur = params[p.name];
    if (todo.includes(p.name) || !cur || typeof cur !== "object" || Array.isArray(cur)) continue;
    if (requiredFieldsInDescription(p.description).some((f) => !concrete((cur as Record<string, unknown>)[f.name]))) todo.push(p.name);
  }
  // Nothing sent and nothing required: send the seller's own documented defaults, if it has any.
  if (todo.length === 0 && Object.keys(sent).length === 0) {
    for (const p of spec?.params ?? []) if (concrete(p.example) && typed(p.example, p.type) !== undefined) todo.push(p.name);
  }
  const filled: FilledParam[] = [];
  for (const name of todo) {
    const known = specOf.get(name);
    const p = known ?? { name, type: null, description: "", enum: [], example: undefined };
    const v = valueFor(p, spec, today, params[name]);
    if ("unfillable" in v) {
      // A placeholder in a parameter the seller marks optional: leave the parameter out rather than send it.
      if (known && !known.required && name in params) {
        delete params[name];
        filled.push({ param: name, rule: "left_out_optional" });
        continue;
      }
      return { ok: false, reason: v.unfillable, param: name };
    }
    params[name] = v.value;
    filled.push({ param: name, rule: v.rule });
  }
  return { ok: true, params, filled };
}
