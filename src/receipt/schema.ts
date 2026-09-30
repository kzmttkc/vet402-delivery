/**
 * Validate an observation against observation.schema.json.
 * A small checker for exactly the keywords that schema uses (type, const, enum, pattern, minLength,
 * minimum, required, properties, additionalProperties:false, items, minItems, maxItems, $ref to
 * #/$defs). It throws on any other keyword so the schema cannot silently outgrow it.
 */
import { readFileSync } from "node:fs";

type Schema = Record<string, unknown>;

export const OBSERVATION_SCHEMA: Schema = JSON.parse(readFileSync(new URL("./observation.schema.json", import.meta.url), "utf8")) as Schema;

const KNOWN = new Set([
  "$schema", "$id", "title", "description", "$defs", "$ref",
  "type", "const", "enum", "pattern", "minLength", "minimum", "required", "properties", "additionalProperties", "items", "minItems", "maxItems",
]);

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function check(v: unknown, s: Schema, root: Schema, path: string, errs: string[]): void {
  for (const k of Object.keys(s)) if (!KNOWN.has(k)) throw new Error(`schema keyword not supported: ${k}`);
  if (typeof s.$ref === "string") {
    const m = /^#\/\$defs\/(.+)$/.exec(s.$ref);
    const target = m ? (root.$defs as Record<string, Schema> | undefined)?.[m[1]!] : undefined;
    if (!target) throw new Error(`unresolved $ref ${s.$ref}`);
    return check(v, target, root, path, errs);
  }
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
    const t = typeOf(v);
    if (!types.includes(t) && !(t === "integer" && types.includes("number"))) {
      errs.push(`${path}: expected ${types.join("|")}, got ${t}`);
      return;
    }
  }
  if ("const" in s && v !== s.const) errs.push(`${path}: must be ${JSON.stringify(s.const)}`);
  if (Array.isArray(s.enum) && !s.enum.includes(v as never)) errs.push(`${path}: not one of ${JSON.stringify(s.enum)}`);
  if (typeof v === "string") {
    if (typeof s.pattern === "string" && !new RegExp(s.pattern).test(v)) errs.push(`${path}: does not match ${s.pattern}`);
    if (typeof s.minLength === "number" && v.length < s.minLength) errs.push(`${path}: shorter than ${s.minLength}`);
  }
  if (typeof v === "number" && typeof s.minimum === "number" && v < s.minimum) errs.push(`${path}: below ${s.minimum}`);
  if (Array.isArray(v)) {
    if (typeof s.minItems === "number" && v.length < s.minItems) errs.push(`${path}: fewer than ${s.minItems} items`);
    if (typeof s.maxItems === "number" && v.length > s.maxItems) errs.push(`${path}: more than ${s.maxItems} items`);
    if (s.items) v.forEach((x, i) => check(x, s.items as Schema, root, `${path}[${i}]`, errs));
  }
  if (v !== null && typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const props = (s.properties ?? {}) as Record<string, Schema>;
    for (const r of (s.required ?? []) as string[]) if (!(r in o)) errs.push(`${path}.${r}: required`);
    for (const [k, val] of Object.entries(o)) {
      if (props[k]) check(val, props[k]!, root, `${path}.${k}`, errs);
      else if (s.additionalProperties === false) errs.push(`${path}.${k}: not allowed`);
    }
  }
}

/** Validate against another copy of the schema (tests: a published older version). Same checker, same keywords. */
export function validateAgainst(schema: Schema, v: unknown): string[] {
  const errs: string[] = [];
  check(v, schema, schema, "$", errs);
  return errs;
}

export function validateObservation(v: unknown): string[] {
  const errs: string[] = [];
  check(v, OBSERVATION_SCHEMA, OBSERVATION_SCHEMA, "$", errs);
  return errs;
}
