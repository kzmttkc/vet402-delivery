/**
 * What vet402 sent and what came back on a Tempo purchase, recorded as shape only. Pure: no network, no I/O.
 *
 * Input: the request comes from the catalog's input example (src/tempo/mercator.ts buildRequest). Checked on
 * 2026-09-30: Mercator's `inputExample` is often not an example. For the Orthogonal services it holds the
 * schema's type name (`{"ip":"string"}`), for some Locus services a note (`"<from clado/bulk-contacts>"`), or
 * `[null]`. Sending that is vet402's mistake, not the seller's: `placeholders` names each such parameter.
 *
 * Answer: the body itself is never kept (as the secret gate: shape only). `nonEmpty` is the delivery test the
 * other chains use (text.trim() not empty); `fields` lists the top-level JSON names that are safe to publish
 * (identifier-like, not secret-like, not random-looking); `inputError` lists words from a fixed list that a
 * 4xx answer used to say the input was wrong. Mercator and mpp.dev declare no output for any Tempo endpoint
 * vet402 bought (read 2026-09-30), so `declared` is null unless a caller passes declared names.
 */
import type { PlannedRequest } from "./mercator.js";

/** Values a catalog uses in place of an example: JSON schema type names. */
const TYPE_WORDS = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);
/** A value that is a note to the reader, e.g. "<from clado/bulk-contacts>" or "<png data url: supply valid media bytes>". */
const ANGLE_NOTE = /^<[^<>]+>$/;

export interface InputCheck {
  /** "mercator_example" when the request was built from the catalog's input example, else "none". */
  source: PlannedRequest["inputSource"];
  /** Parameters (query, JSON body, or the path) whose value is a placeholder, not an input. */
  placeholders: string[];
  /** Parameters the catalog marks required that the request does not carry; null = the required list was not known. */
  missingRequired: string[] | null;
}

function isPlaceholder(v: unknown): boolean {
  if (v === null) return true;
  if (typeof v !== "string") return false;
  const t = v.trim();
  return TYPE_WORDS.has(t.toLowerCase()) || ANGLE_NOTE.test(t);
}

function walk(v: unknown, path: string, out: string[]): void {
  if (isPlaceholder(v)) {
    out.push(path);
    return;
  }
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k, out);
}

/** The parameters a planned request carries: query values (JSON in a query value read as JSON) and the JSON body. */
export function requestParams(req: Pick<PlannedRequest, "url" | "body">): Record<string, unknown> {
  const u = new URL(req.url);
  const params: Record<string, unknown> = {};
  for (const [k, v] of u.searchParams) {
    let val: unknown = v;
    if (/^[[{]/.test(v)) {
      try {
        val = JSON.parse(v);
      } catch {
        val = v;
      }
    }
    params[k] = val;
  }
  if (req.body !== null && req.body !== "") {
    try {
      const b = JSON.parse(req.body) as unknown;
      if (b && typeof b === "object" && !Array.isArray(b)) Object.assign(params, b);
    } catch {
      // not JSON: nothing to check inside
    }
  }
  return params;
}

/** Judge the request vet402 sends. `required` is the catalog's required list (path parameters left out), when the caller has it. */
export function checkInput(req: Pick<PlannedRequest, "url" | "body" | "inputSource">, required: readonly string[] | null = null): InputCheck {
  const placeholders: string[] = [];
  const u = new URL(req.url);
  // A path the catalog left as a pattern ("/v2/*") or a note ("/<id>").
  const segs = u.pathname.split("/").map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
  if (segs.some((s) => s.includes("*") || ANGLE_NOTE.test(s) || /^\{[^{}]+\}$/.test(s))) placeholders.push("(path)");
  const params = requestParams(req);
  walk(params, "", placeholders);
  // The caller leaves path parameters out of `required`: buildRequest puts their values in the path.
  const missingRequired = required === null ? null : required.filter((k) => !(k in params));
  return { source: req.inputSource, placeholders, missingRequired };
}

export interface BodyShape {
  bytes: number;
  /** text.trim() is not empty: the delivery test of the other chains. */
  nonEmpty: boolean;
  /** "object" / "array" / "scalar" when the body is JSON, null when it is not. */
  json: "object" | "array" | "scalar" | null;
  /** Top-level JSON names of an object body that are safe to publish (at most FIELDS_MAX), sorted. */
  fields: string[];
  /** Top-level names not listed: secret-like, random-looking, too long, or over FIELDS_MAX. */
  fieldsWithheld: number;
  /** Array body: number of items. */
  items: number | null;
  /** 4xx only: words from INPUT_ERROR_WORDS the answer used. Empty for any other status. */
  inputError: string[];
  /** Output names the seller declared, when a catalog declared any; null = nothing declared. */
  declared: string[] | null;
  /** Every declared name is a top-level name of the answer; null = nothing declared or not a JSON object. */
  declaredMatch: boolean | null;
}

export const FIELDS_MAX = 30;

/** The fixed words that mark "your input was wrong" in a 4xx answer. Only the word is recorded, never the text. */
export const INPUT_ERROR_WORDS: readonly [string, RegExp][] = [
  ["invalid", /\binvalid\b/i],
  ["required", /\brequired\b/i],
  ["missing", /\bmissing\b/i],
  ["validation", /\bvalidat(?:e|ed|es|ion|ing)\b/i],
  ["malformed", /\bmalformed\b/i],
  ["must_be", /\bmust be\b/i],
  ["expected", /\bexpected\b/i],
  ["unprocessable", /\bunprocessable\b/i],
];

/** Same word list as the secret gate's name test (src/daily/secret-gate.ts isSecretName), kept local so this stays pure. */
const SECRET_PARTS = /token|secret|key|passw|credential|cookie|session|bearer|jwt|mnemonic|xprv|seed|priv|auth|sig/;

/** A JSON name that says what the field is, not a value: identifier-shaped, short, not secret-like, not random-looking. */
export function publishableField(name: string): boolean {
  // Lower-case letters, digits and _ only, 1 to 32 characters: no dots, @, slashes or upper case, so a name
  // that is itself a value (a domain such as "acme.com", an email, a path, a mixed-case id) is only counted.
  if (!/^[a-z0-9_]{1,32}$/.test(name)) return false;
  if (SECRET_PARTS.test(name.replace(/_/g, ""))) return false;
  // hex runs, long digit runs, or mixed-case runs without separators read as ids, not names
  if (/[0-9a-f]{12,}/i.test(name) && /\d/.test(name)) return false;
  if (/\d{6,}/.test(name)) return false;
  return true;
}

const TEXT_MAX = 64 * 1024;

export function bodyShape(buf: Uint8Array | null, status: number | null, declared: readonly string[] | null = null): BodyShape {
  const bytes = buf ? buf.length : 0;
  const text = buf ? Buffer.from(buf.subarray(0, TEXT_MAX)).toString("utf8") : "";
  let parsed: unknown;
  let json: BodyShape["json"] = null;
  try {
    parsed = JSON.parse(text);
    json = Array.isArray(parsed) ? "array" : parsed !== null && typeof parsed === "object" ? "object" : "scalar";
  } catch {
    json = null;
  }
  const names = json === "object" ? Object.keys(parsed as Record<string, unknown>) : [];
  const ok = names.filter(publishableField).sort();
  const fields = ok.slice(0, FIELDS_MAX);
  const is4xx = status !== null && status >= 400 && status <= 499;
  const inputError = is4xx ? INPUT_ERROR_WORDS.filter(([, re]) => re.test(text)).map(([w]) => w) : [];
  const decl = declared && declared.length > 0 ? [...new Set(declared)] : null;
  return {
    bytes,
    nonEmpty: text.trim().length > 0 || bytes > TEXT_MAX,
    json,
    fields,
    fieldsWithheld: names.length - fields.length,
    items: json === "array" ? (parsed as unknown[]).length : null,
    inputError,
    declared: decl,
    declaredMatch: decl && json === "object" ? decl.every((k) => names.includes(k)) : null,
  };
}

/**
 * Why a paid 4xx is vet402's input, or null when that cannot be told:
 *   placeholder_input   the request carried a placeholder the catalog wrote in place of an example
 *   missing_required    the request lacked a parameter the catalog marks required
 *   no_input_sent       vet402 sent no cataloged input and the seller's 4xx answer says the input was wrong
 * A 4xx that says "invalid" to the catalog's own example stays "can't tell": the example may be the catalog's error.
 */
/**
 * The paid 4xx answers that can be the request's fault: 400, 404, 422. Not 401, 403, 407 (auth, which may be the
 * seller's own setup), 429 (rate) or 402 (payment). Only these move a paid failure to vet402's side, and only
 * these in the census stop remeasure from buying a placeholder request again.
 */
export const INPUT_REJECT_STATUSES: ReadonlySet<number> = new Set([400, 404, 422]);

export type InputProblem = "placeholder_input" | "missing_required" | "no_input_sent";

export function inputProblem(input: InputCheck | null | undefined, body: Pick<BodyShape, "inputError"> | null | undefined): InputProblem | null {
  if (!input) return null;
  if (input.placeholders.length > 0) return "placeholder_input";
  if (input.missingRequired && input.missingRequired.length > 0) return "missing_required";
  if (input.source === "none" && body && body.inputError.length > 0) return "no_input_sent";
  return null;
}
