/**
 * Delivery vs. the listing's declaration. Pure: no network, no I/O.
 *
 * Ported from vet402-algorand src/verdict.ts (judgeDelivery) and src/declaration.ts
 * (outputSchemaFrom) so that the Solana census uses the same judgement and the same
 * reason words. Only the listing side differs: here the declaration is read from the
 * catalog listing (PayAI / CDP Bazaar), because Pay.sh and many 402s carry none.
 */
import type { Listing } from "./discovery.js";
import { normalizeAccept } from "./guard.js";
import { SOLANA_MAINNET } from "./constants.js";

/** Reason words (same strings as vet402-algorand's REASONS, plus the Solana guard words below). */
export type DeliveryReason = "delivered" | "http_error" | "not_json" | "empty_body" | "delivery_missing_keys";

export interface Declaration {
  description?: string;
  mimeType?: string;
  /** Declared example output (Bazaar `info.output.example`, PayAI `outputSchema.example`, v1 `outputSchema.output`). */
  outputExample?: unknown;
  /** Declared output JSON schema (only the `required` list is a promise). */
  outputSchema?: Record<string, unknown>;
}

export interface Delivery {
  status: number;
  contentType: string | null;
  bodyText: string;
}

export interface DeliveryJudgement {
  verdict: "ALLOW" | "REFUSE";
  reason: DeliveryReason;
  delivered: boolean;
  expectedKeys: string[];
  missingKeys: string[];
  exampleKeys: string[];
  unseenExampleKeys: string[];
  note?: string;
  summary: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, max = 2000): string | undefined => (typeof v === "string" && v.trim() ? v.slice(0, max) : undefined);

/** vet402-algorand declaration.ts: the output schema inside a Bazaar extension. */
export function outputSchemaFrom(bazaar: unknown): Obj | undefined {
  if (!isObj(bazaar)) return undefined;
  const info = isObj(bazaar.info) ? bazaar.info : undefined;
  const infoOutput = info && isObj(info.output) ? info.output : undefined;
  if (infoOutput && isObj(infoOutput.schema)) return infoOutput.schema;
  const schema = isObj(bazaar.schema) ? bazaar.schema : undefined;
  const props = schema && isObj(schema.properties) ? schema.properties : undefined;
  const output = props && isObj(props.output) ? props.output : undefined;
  const outProps = output && isObj(output.properties) ? output.properties : undefined;
  const example = outProps && isObj(outProps.example) ? outProps.example : undefined;
  return example;
}

/** A JSON-schema-looking object (as opposed to an example value). */
function schemaLike(v: unknown): v is Obj {
  return isObj(v) && (Array.isArray(v.required) || isObj(v.properties));
}

/** The seller's promise, from a PayAI or CDP Bazaar listing (v1 and v2 layouts). */
export function declarationFromListing(l: Listing): Declaration {
  const raw = l as unknown as Obj;
  const bazaar = isObj(raw.extensions) ? (raw.extensions as Obj).bazaar : undefined;
  const info = isObj(bazaar) && isObj(bazaar.info) ? bazaar.info : undefined;
  const infoOutput = info && isObj(info.output) ? info.output : undefined;
  const top = isObj(raw.outputSchema) ? raw.outputSchema : undefined; // PayAI: { type, example, schema? }
  const solAcc = (l.accepts ?? []).find((a) => normalizeAccept(a).network === SOLANA_MAINNET) as Obj | undefined;
  const v1 = solAcc && isObj(solAcc.outputSchema) ? solAcc.outputSchema : undefined;
  const v1Out = v1?.output;

  let outputSchema = outputSchemaFrom(bazaar);
  if (!outputSchema && top) {
    if (isObj(top.schema)) outputSchema = top.schema;
    else if (isObj(top.outputSchema)) outputSchema = top.outputSchema;
    else if (schemaLike(top)) outputSchema = top;
  }
  if (!outputSchema && schemaLike(v1Out)) outputSchema = v1Out;

  let outputExample: unknown = infoOutput?.example;
  if (outputExample === undefined && top && top.example !== undefined) outputExample = top.example;
  if (outputExample === undefined && v1Out !== undefined && !schemaLike(v1Out)) outputExample = v1Out;

  const description = str(l.description) ?? str(info?.description) ?? str(solAcc?.description);
  const mimeType = str(raw.mimeType, 200) ?? str(solAcc?.mimeType, 200);
  return {
    ...(description ? { description } : {}),
    ...(mimeType ? { mimeType } : {}),
    ...(outputExample !== undefined ? { outputExample } : {}),
    ...(outputSchema ? { outputSchema } : {}),
  };
}

/** 2 = required keys declared, 1 = an example or properties, 0 = nothing to compare against. */
export function declarationScore(d: Declaration): 0 | 1 | 2 {
  if (expectedKeys(d).length > 0) return 2;
  if (exampleKeys(d).length > 0 || d.outputExample !== undefined) return 1;
  return 0;
}

// ---------------- vet402-algorand verdict.ts (logic unchanged) ----------------

function requiredOf(decl: Declaration): string[] {
  const req = (decl.outputSchema as { required?: unknown } | undefined)?.required;
  if (!Array.isArray(req)) return [];
  return [...new Set(req.filter((k): k is string => typeof k === "string"))].slice(0, 50);
}

/** Keys the seller promised: the output schema's `required` list, and nothing else. */
export function expectedKeys(decl: Declaration): string[] {
  return requiredOf(decl);
}

/** Hint keys when nothing is required: schema.properties keys, then the example's top-level keys. */
export function exampleKeys(decl: Declaration): string[] {
  if (requiredOf(decl).length > 0) return [];
  const keys: string[] = [];
  const props = (decl.outputSchema as { properties?: unknown } | undefined)?.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) keys.push(...Object.keys(props));
  const ex = decl.outputExample;
  if (ex && typeof ex === "object" && !Array.isArray(ex)) keys.push(...Object.keys(ex));
  return [...new Set(keys)];
}

function hasKey(obj: Record<string, unknown>, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, k);
}

function keyList(keys: string[], max = 200): string {
  const s = keys.join(", ");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function isEmptyJson(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

export function summarize(value: unknown, max = 240): string {
  let s: string;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>).map(([k, v]) => {
      const t = Array.isArray(v) ? `array(${v.length})` : v === null ? "null" : typeof v;
      const preview = typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? `=${JSON.stringify(v).slice(0, 40)}` : "";
      return `${k}:${t}${preview}`;
    });
    s = `object{${entries.join(", ")}}`;
  } else if (Array.isArray(value)) {
    s = `array(${value.length})`;
  } else {
    s = `${typeof value}:${JSON.stringify(value)}`;
  }
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export function judgeDelivery(decl: Declaration, d: Delivery): DeliveryJudgement {
  const keys = expectedKeys(decl);
  const hints = exampleKeys(decl);
  const base = { expectedKeys: keys, missingKeys: [] as string[], exampleKeys: hints, unseenExampleKeys: [] as string[] };
  const refuse = (reason: DeliveryReason, summary: string, extra: Partial<DeliveryJudgement> = {}): DeliveryJudgement => ({
    ...base,
    ...extra,
    verdict: "REFUSE",
    reason,
    delivered: false,
    summary,
  });
  if (d.status < 200 || d.status >= 300) return refuse("http_error", `status ${d.status}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(d.bodyText);
  } catch {
    const snippet = d.bodyText.slice(0, 80).replace(/\s+/g, " ");
    return refuse("not_json", `content-type ${d.contentType ?? "none"}, ${d.bodyText.length} bytes: ${snippet}`);
  }
  if (isEmptyJson(parsed)) return refuse("empty_body", summarize(parsed));
  const obj = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  const missing = keys.filter((k) => !hasKey(obj, k));
  if (missing.length > 0) return refuse("delivery_missing_keys", summarize(parsed), { missingKeys: missing });
  const unseen = hints.filter((k) => !hasKey(obj, k));
  // No required list, but the seller showed an example: a response with none of its keys (e.g. an error object) is not the product.
  if (keys.length === 0 && hints.length > 0 && unseen.length === hints.length) {
    return refuse("delivery_missing_keys", summarize(parsed), { missingKeys: unseen.slice(0, 50) });
  }
  const note = unseen.length > 0 ? `example keys not seen: ${keyList(unseen)}` : undefined;
  return { ...base, unseenExampleKeys: unseen, ...(note ? { note } : {}), verdict: "ALLOW", reason: "delivered", delivered: true, summary: summarize(parsed) };
}
