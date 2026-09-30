/**
 * The secret gate in front of every public data commit (scripts/daily/secret-gate.ts).
 *
 * Two steps:
 *  - redactKnown: a local result file becomes its public copy. Only the known shapes are changed, with the
 *    wording already used in data/ (b673edd, 1f2e295, 1e6e4db): a token a seller put in its response body
 *    (a JWT in `detail` or `first300`) and local runner paths (/Users/<name>/ -> ~/).
 *  - scan: every file that would be public is read again. One finding the allow list does not name stops the
 *    commit (fail closed).
 *
 * Each string is looked at as written and as it reads after undoing what hides a value: JSON escapes
 * (\" \u0020), percent-encoding, base64 of text, and JSON inside the string. In each reading:
 *  - any value under a secret-like name (key, token, secret, password, session, auth, cookie, credential,
 *    signature, bearer, jwt, mnemonic..., any case or separator) is a finding, whatever it looks like; the
 *    only exceptions are fields of vet402's own record format checked against their exact format (OWN_FIELDS)
 *  - JWTs (even a piece of one), Bearer values, local paths, private key blocks, vendor key prefixes, 64-byte
 *    key arrays, and the runner's own keys in any common encoding
 *  - any random-looking run of 24 characters or more, unless it is a public id in its exact format (a 32-byte
 *    base58 address, a 64-byte base58 signature, hex of a hash or address, an Algorand address with a valid
 *    checksum or transaction id, an IPFS id, a payment challenge id) or the same value is an address or
 *    transaction elsewhere in the same file. Words, slugs and UUID-like ids are not random-looking.
 * Anything else that is public by design is allowed by exact sha256 only, each with a reason, in
 * scripts/daily/secret-allow.json.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** The replacement text for a token a seller returned to vet402 (same wording as data/ since 2026-09-28). */
export const SELLER_TOKEN_REDACTION = "[redacted: token the seller issued to vet402]";
/** Response-body fields where a seller's own token can appear. A JWT anywhere else is not a known shape. */
export const SELLER_BODY_FIELDS: readonly string[] = ["detail", "first300"];

export type FindingKind =
  | "jwt"
  | "bearer"
  | "secret-field"
  | "url-query-secret"
  | "local-path"
  | "private-key-block"
  | "vendor-key"
  | "key-array"
  | "own-key"
  | "opaque-40";

export interface Finding {
  file: string;
  /** JSON path (e.g. rows[4].detail) for JSON files, "lineN..." for JSON lines, "" for other text. */
  path: string;
  kind: FindingKind;
  /** A shape redactKnown replaces (a seller's JWT in a response body, a local /Users/ path). */
  known: boolean;
  /** sha256 of the matched value, never the value itself. */
  sha256: string;
  length: number;
  /** The value with letters and digits masked: enough to tell what it is, not enough to use it. */
  shape: string;
}

export interface AllowEntry {
  sha256: string;
  kind: FindingKind;
  reason: string;
}

export interface Redaction {
  path: string;
  what: "seller-token" | "local-path";
}

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");
export const maskShape = (s: string) => s.replace(/[A-Z]/g, "A").replace(/[a-z]/g, "a").replace(/[0-9]/g, "9").slice(0, 48);

// ---------- known shapes: redacted in the copy ----------

/** A JWT, including one cut short (response bodies are kept to 300 characters). */
const JWT_FULL_SRC = String.raw`eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]*){0,2}`;
const LOCAL_PATH_SRC = String.raw`\/Users\/[^/\s"'\\]+\/`;

function redactString(s: string, key: string | null, path: string, out: Redaction[]): string {
  let v = s;
  if (key !== null && SELLER_BODY_FIELDS.includes(key) && new RegExp(JWT_FULL_SRC).test(v)) {
    v = v.replace(new RegExp(JWT_FULL_SRC, "g"), SELLER_TOKEN_REDACTION);
    out.push({ path, what: "seller-token" });
  }
  if (new RegExp(LOCAL_PATH_SRC).test(v)) {
    v = v.replace(new RegExp(LOCAL_PATH_SRC, "g"), "~/");
    out.push({ path, what: "local-path" });
  }
  return v;
}

/** The public copy of a parsed result: known shapes replaced, everything else as it was. */
export function redactKnown(value: unknown): { value: unknown; redactions: Redaction[] } {
  const redactions: Redaction[] = [];
  const walk = (x: unknown, key: string | null, path: string): unknown => {
    if (typeof x === "string") return redactString(x, key, path, redactions);
    if (Array.isArray(x)) return x.map((v, i) => walk(v, null, `${path}[${i}]`));
    if (x && typeof x === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(x)) o[k] = walk(v, k, path ? `${path}.${k}` : k);
      return o;
    }
    return x;
  };
  return { value: walk(value, null, ""), redactions };
}

/** The exact text data/ files are written in. */
export const publicJson = (v: unknown) => JSON.stringify(v, null, 2) + "\n";

// ---------- names ----------

const SECRET_EXACT = new Set(["key", "sid", "pass", "pwd"]);
const SECRET_SUFFIX = [
  "apikey", "accesskey", "secretkey", "privatekey", "authkey", "clientkey", "signingkey", "sessionkey", "encryptionkey",
  "secret", "password", "passwd", "passphrase", "token", "session", "sessionid", "auth", "authorization", "cookie",
  "credential", "credentials", "signature", "sig", "bearer", "jwt", "mnemonic", "seedphrase",
];

/** A name whose value is a secret whatever it looks like: any case, any separator (api_key, X-Api-Key, apiKey). */
export function isSecretName(name: string): boolean {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!n) return false;
  return SECRET_EXACT.has(n) || SECRET_SUFFIX.some((s) => n.endsWith(s));
}

/**
 * Fields of vet402's own record format that carry secret-like names but hold public values vet402 wrote,
 * each checked against its exact format. A seller's text never reaches these checks: names found inside a
 * string (a response body, a URL) are always secret-field findings.
 */
const OWN_FIELDS: { path: RegExp; key: string; ok: (v: string) => boolean }[] = [
  // remeasure budget / ledger key, wherever vet402's own records carry it: <UTC day>|<payTo>|<slot>
  { path: /(?:^|\.|\])key$/, key: "key", ok: (v) => /^\d{4}-\d{2}-\d{2}\|(?:[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})\|\d+$/.test(v) },
  // Tempo census ledger key: the service slug
  { path: /^entries\[\d+\]\.key$/, key: "key", ok: (v) => /^[a-z0-9][a-z0-9-]{0,40}$/.test(v) },
  // the ranking's seller key: host, or host#service
  { path: /^groups\[\d+\]\.(?:ranking|comparisons\[\d+\]\.[A-Za-z]+)\[\d+\]\.key$/, key: "key", ok: (v) => /^[a-z0-9.-]+(?::\d+)?(?:#[A-Za-z0-9._/-]{1,80})?$/.test(v) },
  // a Solana transaction signature vet402 sent or read back
  { path: /(?:^|\.)(?:rows|records|attempts)\[\d+\](?:\.[A-Za-z]+)*\.signature$/, key: "signature", ok: (v) => base58Len(v) === 64 },
  // vet402's EIP-712 signature on its own observation record
  { path: /^signature\.signature$/, key: "signature", ok: (v) => /^0x[0-9a-f]{130}$/.test(v) },
  // the x402 memo vet402 put on its own payment (16 random bytes, hex), as sent and as read back
  { path: /^records\[\d+\](?:\.onChain)?\.memo$/, key: "memo", ok: (v) => /^[0-9a-f]{32}$/.test(v) },
  // the token symbol a Tempo 402 challenge names (USDC.e)
  { path: /^rows\[\d+\]\.live\.token$/, key: "token", ok: (v) => /^[A-Za-z0-9.]{1,12}$/.test(v) },
];

function ownField(path: string, key: string, v: string): boolean {
  return OWN_FIELDS.some((f) => f.key === key && f.path.test(path) && f.ok(v));
}

// ---------- public ids in their exact formats ----------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** Decoded byte length of a base58 string, or -1. */
export function base58Len(s: string): number {
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(s) || s.length > 100) return -1;
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(B58.indexOf(c));
  let bytes = 0;
  while (n > 0n) {
    n >>= 8n;
    bytes++;
  }
  for (const c of s) {
    if (c !== "1") break;
    bytes++;
  }
  return bytes;
}

function base32Decode(s: string): Buffer | null {
  if (!/^[A-Z2-7]+$/.test(s)) return null;
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, val = 0;
  const out: number[] = [];
  for (const c of s) {
    val = (val << 5) | A.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function algorandAddress(s: string): boolean {
  if (s.length !== 58) return false;
  const b = base32Decode(s);
  if (!b || b.length !== 36) return false;
  const sum = createHash("sha512-256").update(b.subarray(0, 32)).digest().subarray(28);
  return sum.equals(b.subarray(32));
}

const ALGO_TX = /^[A-Z2-7]{52}$/;
const HEX_ID = /^(?:0x)?(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64}|[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/;
const IPFS_CID = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z2-7]{50,})$/;

/** A public id in its exact format: 32-byte address, 64-byte signature, hash/address hex, Algorand, IPFS. */
export function isExactPublicId(t: string): boolean {
  const b = base58Len(t);
  if (b === 32 || b === 64) return true;
  return HEX_ID.test(t) || algorandAddress(t) || ALGO_TX.test(t) || IPFS_CID.test(t);
}

/**
 * Words, the way people name things: lowercase, Capitalized or camelCase words that each hold a vowel, short
 * acronyms (USDC, API) and numbers. Random letters rarely read as words: a run without a vowel, or case that
 * flips every letter or two, is not one.
 */
export function isWords(t: string): boolean {
  const toks = t.match(/[A-Z]{2,5}(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? [];
  if (toks.join("") !== t || toks.length === 0) return false;
  for (const [i, x] of toks.entries()) {
    if (/^\d+$/.test(x) || /^[A-Z]{2,5}$/.test(x)) continue;
    if (/^[A-Z][a-z]$/.test(x) || (i === 0 && /^[a-z]$/.test(x))) continue; // Tx, Id; x in x402
    const lower = x.replace(/^[A-Z]/, "");
    if (lower.length < 2 || (x.length >= 5 && !/[aeiouy]/.test(lower))) return false;
  }
  return t.length / toks.length >= 3;
}

/** A part of a joined string: words, a number, hex, or in an all-lowercase slug any short code. */
function isPlainPart(p: string, lowerSlug: boolean): boolean {
  if (p.length >= 20) return false;
  if (lowerSlug) return /^[a-z0-9]+$/.test(p);
  return /^(?:\d+|[0-9a-f]+|0x[0-9a-fA-F]+)$/.test(p) || isWords(p);
}

/**
 * Public shapes among long runs: an exact public id, or ids and words joined by separators (eth_0x..., a
 * UUID, x402-weather-v2beta). A random token that happens to hold a - or _ is not split into harmless parts.
 */
export function isPublicLongToken(t: string): boolean {
  if (isExactPublicId(t)) return true;
  const parts = t.split(/[-_:=+]/).filter(Boolean);
  const lower = !/[A-Z]/.test(t);
  return parts.length > 1 && parts.every((p) => isPlainPart(p, lower) || isExactPublicId(p));
}

/** Chain ids in CAIP-2 form: public constants. */
const NETWORK_IDS = new Set([
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", // Solana mainnet
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1", // Solana devnet
  "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z", // Solana testnet
  "wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=", // Algorand mainnet genesis hash
  "wGHE2Pwdvd7S12BL5FaOP20EGYesN73k", // the same, as CAIP-2 cuts it
  "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=", // Algorand testnet genesis hash
  "SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe",
]);

/**
 * Random-looking: at least 12 distinct characters from at least two of lower, upper, digit. A field name made
 * of words (payableTotalWithFeeReserve) is not; in a value only the field names the scanned files use are.
 */
function looksRandom(t: string, allowWords: boolean): boolean {
  if (NETWORK_IDS.has(t) || (allowWords && isWords(t))) return false;
  return new Set(t).size >= 12 && [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(t)).length >= 2;
}

// ---------- readings of a string ----------

function jsonUnescape(s: string): string {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\(["\\/])/g, "$1")
    .replace(/\\[nrt]/g, " ");
}

function percentDecode(s: string): string {
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (m) => {
    try {
      return decodeURIComponent(m);
    } catch {
      return m.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    }
  });
}

/** Text hidden as base64 (standard or url-safe): decoded when it reads as text. */
function base64Texts(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/[A-Za-z0-9+/_-]{24,}={0,2}/g)) {
    const b = Buffer.from(m[0].replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (b.length < 16) continue;
    let printable = 0;
    for (const x of b) if ((x >= 0x20 && x < 0x7f) || x === 0x0a || x === 0x0d || x === 0x09) printable++;
    if (printable / b.length >= 0.95) out.push(b.toString("latin1"));
  }
  return out;
}

/** The string and every reading of it after undoing escapes, percent-encoding and base64, up to 4 rounds. */
export function readings(s: string): string[] {
  const seen = new Set<string>([s]);
  let frontier = [s];
  for (let round = 0; round < 4 && frontier.length; round++) {
    const next: string[] = [];
    for (const v of frontier) {
      for (const w of [jsonUnescape(v), percentDecode(v), ...base64Texts(v)]) {
        if (!seen.has(w) && seen.size < 64) {
          seen.add(w);
          next.push(w);
        }
      }
    }
    frontier = next;
  }
  return [...seen];
}

// ---------- detection ----------

const NAME = String.raw`[A-Za-z][A-Za-z0-9_.-]{0,48}`;
/** "name": "value" (value may be cut off at the end of a 300-character body). */
const QUOTED_PAIR = new RegExp(`["'](${NAME})["']\\s*:\\s*["']([^"']*)["']?`, "g");
/** name=value in a query, a form or a cookie. */
const FORM_PAIR = new RegExp(`(?:^|[?&;,\\s{(])(${NAME})=([^&;#\\s"'<>]+)`, "g");
/** name: value as in a header line. */
const HEADER_PAIR = new RegExp(`(?:^|[\\s{,;(])(${NAME})\\s*:\\s*([^\\s"',;{}<>\\[\\]]+)`, "g");
const JWT_PIECE = /eyJ[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*){0,2}/g;
const BEARER = /\bbearer\s+([A-Za-z0-9_.~+/=-]{8,})/gi;
const LOCAL_PATH = /(?:\/Users\/|\/home\/)[^\s"'<>\\]*/g;
const OPAQUE = /[A-Za-z0-9_+=-]{24,}/g;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const VENDOR_KEY =
  /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{8,}|rk_live_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|re_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,})/g;
const KEY_ARRAY = /\[\s*(?:\d{1,3}\s*,\s*){31,63}\d{1,3}\s*\]/g;
/** A 402 payment challenge id is handed to anyone who asks for the resource. */
const PUBLIC_ID_NAMES = /^(?:challengeId|challenge_id)$/;
const ADDRESS_FIELDS = /^(?:tx|txHash|txid|signature|payTo|expectedPayTo|payer|feePayer|address|mint|asset|recipient|from|to|wallet|owner)$/;

const ownMarker = (v: string) => v === SELLER_TOKEN_REDACTION || v.startsWith(SELLER_TOKEN_REDACTION);

/** The runner's own key material in the encodings it could leak in. */
export function ownKeyNeedles(keysDir: string): string[] {
  const out: string[] = [];
  if (!existsSync(keysDir)) return out;
  for (const f of readdirSync(keysDir).filter((x) => x.endsWith(".json"))) {
    let j: unknown;
    try {
      j = JSON.parse(readFileSync(join(keysDir, f), "utf8"));
    } catch {
      continue;
    }
    const bytes: Buffer[] = [];
    if (Array.isArray(j) && j.every((n) => Number.isInteger(n))) bytes.push(Buffer.from(j as number[]));
    for (const v of j && typeof j === "object" && !Array.isArray(j) ? Object.values(j as Record<string, unknown>) : []) {
      if (typeof v === "string" && /^(?:0x)?[0-9a-fA-F]{64}$/.test(v)) bytes.push(Buffer.from(v.replace(/^0x/, ""), "hex"));
      if (Array.isArray(v) && v.every((n) => Number.isInteger(n))) bytes.push(Buffer.from(v as number[]));
    }
    for (const b of bytes) {
      const secret = b.length === 64 ? b.subarray(0, 32) : b;
      out.push(secret.toString("hex"), secret.toString("base64").replace(/=+$/, ""), secret.toString("base64url"), base58(b));
      if (b.length === 64) out.push(base58(secret));
    }
  }
  return out.filter((n) => n.length >= 32);
}

function base58(b: Buffer): string {
  let n = BigInt("0x" + (b.toString("hex") || "0"));
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)]! + s;
    n /= 58n;
  }
  for (const x of b) {
    if (x !== 0) break;
    s = "1" + s;
  }
  return s;
}

export interface ScanOptions {
  /** The runner's key encodings (ownKeyNeedles): any of them in a public file is a finding. */
  ownKeys?: readonly string[];
  /** Values under address or transaction fields of the same file: public by the file's own account. */
  publicIds?: ReadonlySet<string>;
  /** Field names (made of words) the scanned JSON files use: the site prints them as text. */
  fieldNames?: ReadonlySet<string>;
}

/** Scan one string value. `key`/`path`: its JSON field, or null/"" for plain text. */
export function scanText(text: string, file: string, path: string, key: string | null, out: Finding[], opts: ScanOptions = {}): void {
  const found = new Map<string, Finding>();
  const add = (kind: FindingKind, v: string, known = false) => {
    const h = sha256Hex(v);
    const k = `${kind}:${h}`;
    const prev = found.get(k);
    if (prev) {
      prev.known = prev.known || known;
      return;
    }
    found.set(k, { file, path, kind, known, sha256: h, length: v.length, shape: maskShape(v) });
  };
  const publicIds = opts.publicIds ?? new Set<string>();
  const bodyField = key !== null && SELLER_BODY_FIELDS.includes(key);

  for (const needle of opts.ownKeys ?? []) if (text.includes(needle)) add("own-key", needle);
  // vet402's own field in its exact format: nothing else to look at.
  if (key !== null && ownField(path, key, text)) {
    out.push(...found.values());
    return;
  }
  // A structured field under a secret-like name: always.
  if (key !== null && isSecretName(key) && text !== "" && !ownMarker(text)) add("secret-field", text);
  const challengeField = key !== null && PUBLIC_ID_NAMES.test(key);

  const all = readings(text);
  all.forEach((v, i) => {
    const original = i === 0;
    for (const m of v.matchAll(PRIVATE_KEY_BLOCK)) add("private-key-block", m[0]);
    for (const m of v.matchAll(KEY_ARRAY)) add("key-array", m[0]);
    for (const m of v.matchAll(VENDOR_KEY)) {
      if (m[0].startsWith("sk-") && !looksOpaque(m[0].replace(/^sk-(?:proj-|ant-)?/, ""))) continue; // a URL path like /sk-soil-fragments
      add("vendor-key", m[0]);
    }
    for (const m of v.matchAll(JWT_PIECE)) {
      if (m.index! > 0 && /[A-Za-z0-9]/.test(v[m.index! - 1]!)) continue; // "eyJ" inside a longer run: left to the random-run check
      add("jwt", m[0], original && bodyField && new RegExp(`^${JWT_FULL_SRC}$`).test(m[0]));
    }
    for (const m of v.matchAll(BEARER)) if (!ownMarker(m[1]!)) add("bearer", m[1]!);
    for (const m of v.matchAll(LOCAL_PATH)) add("local-path", m[0], original && m[0].startsWith("/Users/"));
    for (const re of [QUOTED_PAIR, FORM_PAIR, HEADER_PAIR]) {
      for (const m of v.matchAll(re)) {
        const [name, value] = [m[1]!, m[2]!];
        if (!isSecretName(name) || value === "" || ownMarker(value)) continue;
        // name: value in prose ("the seller key: the host") is a sentence; as a header it holds a token-like value.
        if (re === HEADER_PAIR && (value.length < 8 || /^[a-z]+$/.test(value) || /^(?:bearer|basic)$/i.test(value))) continue;
        add(re === FORM_PAIR ? "url-query-secret" : "secret-field", value);
      }
    }
    // Random-looking runs. Percent-encoded bytes are separators in the text as written.
    const plain = v.replace(/%[0-9A-Fa-f]{2}/g, "   ");
    for (const m of plain.matchAll(OPAQUE)) {
      const t = m[0].replace(/^[-_=+]+|[-_=+]+$/g, "");
      if (t.length < 24 || !looksRandom(t, path.endsWith("(name)"))) continue;
      if (opts.fieldNames?.has(t)) continue;
      if (publicIds.has(t)) continue;
      if (isPublicLongToken(t)) continue;
      const before = plain.slice(Math.max(0, m.index! - 24), m.index!);
      if (/\/ipfs\/$/.test(before)) continue;
      if (/challengeId\\?["']?\s*[:=]\s*\\?["']?$/i.test(before)) continue;
      if (challengeField && m[0].length === v.length && original) continue; // the whole value of a payment challenge id field
      add("opaque-40", t);
    }
  });
  out.push(...found.values());
}

/** Opaque = random-looking: 16+ characters mixing cases or letters and digits without word breaks. */
function looksOpaque(v: string): boolean {
  if (v.length < 16) return false;
  if (/^[a-z]+(?:[-_.][a-z]+)*$/i.test(v)) return false;
  if (/^\d+$/.test(v)) return false;
  return [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(v)).length >= 2;
}

/** Object keys made of words, anywhere in a parsed file. */
function collectNames(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) value.forEach((v) => collectNames(v, into));
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      if (k.length >= 24 && isWords(k)) into.add(k);
      collectNames(v, into);
    }
}

/** Values under address and transaction fields anywhere in a parsed file. */
function collectPublicIds(value: unknown, into: Set<string>): void {
  const walk = (x: unknown, key: string | null) => {
    if (typeof x === "string") {
      if (key !== null && ADDRESS_FIELDS.test(key) && isExactPublicId(x)) into.add(x);
    } else if (Array.isArray(x)) x.forEach((v) => walk(v, null));
    else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) walk(v, k);
  };
  walk(value, null);
}

/** Scan a parsed JSON value: keys give each string its path and field name. Object keys are scanned too. */
export function scanJson(value: unknown, file: string, out: Finding[], opts: ScanOptions = {}): void {
  const ids = new Set<string>(opts.publicIds ?? []);
  collectPublicIds(value, ids);
  const o = { ...opts, publicIds: ids };
  const walk = (x: unknown, key: string | null, path: string) => {
    if (typeof x === "string") scanText(x, file, path, key, out, o);
    else if (Array.isArray(x)) x.forEach((v, i) => walk(v, null, `${path}[${i}]`));
    else if (x && typeof x === "object")
      for (const [k, v] of Object.entries(x)) {
        const p = path ? `${path}.${k}` : k;
        scanText(k, file, `${p}(name)`, null, out, o);
        walk(v, k, p);
      }
  };
  walk(value, null, "");
}

/** One file. JSON is walked by key; JSON lines line by line; anything else as text. */
export function scanFileText(text: string, rel: string, opts: ScanOptions = {}): Finding[] {
  const out: Finding[] = [];
  if (rel.endsWith(".json")) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      scanText(text, rel, "", null, out, opts);
      return out;
    }
    for (const m of text.matchAll(KEY_ARRAY)) out.push({ file: rel, path: "", kind: "key-array", known: false, sha256: sha256Hex(m[0]), length: m[0].length, shape: maskShape(m[0]) });
    scanJson(v, rel, out, opts);
  } else if (rel.endsWith(".jsonl")) {
    const lines = text.split("\n");
    const parsed: unknown[] = [];
    const ids = new Set<string>();
    for (const line of lines) {
      try {
        const p = line.trim() ? JSON.parse(line) : undefined;
        parsed.push(p);
        if (p !== undefined) collectPublicIds(p, ids);
      } catch {
        parsed.push(null);
      }
    }
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      const found: Finding[] = [];
      if (parsed[i] === null) scanText(line, rel, "", null, found, { ...opts, publicIds: ids });
      else scanJson(parsed[i], rel, found, { ...opts, publicIds: ids });
      for (const f of found) out.push({ ...f, path: `line${i + 1}${f.path ? "." + f.path : ""}` });
    });
  } else {
    scanText(text, rel, "", null, out, opts);
  }
  return out;
}

function walkFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    return d.isDirectory() ? walkFiles(p) : d.isFile() ? [p] : [];
  });
}

/** Every file under the given folders (relative to root). A file that is not UTF-8 text is a finding of its own. */
export function scanTree(root: string, dirs: readonly string[], opts: ScanOptions = {}): { files: number; findings: Finding[] } {
  let files = 0;
  const findings: Finding[] = [];
  const names = new Set<string>(opts.fieldNames ?? []);
  for (const d of dirs) {
    const abs = join(root, d);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
    for (const f of walkFiles(abs).filter((x) => x.endsWith(".json"))) {
      try {
        collectNames(JSON.parse(readFileSync(f, "utf8")), names);
      } catch {
        /* not JSON: nothing to learn */
      }
    }
  }
  opts = { ...opts, fieldNames: names };
  for (const d of dirs) {
    const abs = join(root, d);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
    for (const f of walkFiles(abs)) {
      const rel = relative(root, f);
      files++;
      const buf = readFileSync(f);
      const text = buf.toString("utf8");
      if (Buffer.from(text, "utf8").length !== buf.length) {
        findings.push({ file: rel, path: "", kind: "opaque-40", known: false, sha256: sha256Hex(text), length: buf.length, shape: "binary file" });
        continue;
      }
      findings.push(...scanFileText(text, rel, opts));
    }
  }
  return { files, findings };
}

export const ALLOW_KIND = "vet402-secret-gate-allow";

/** A whole file allowed by its exact sha256: a byte-for-byte copy of another public source, with the reason. */
export interface AllowFile {
  path: string;
  sha256: string;
  reason: string;
}

export interface AllowList {
  allow: AllowEntry[];
  files: AllowFile[];
}

export function loadAllowList(file: string): AllowList {
  const j = JSON.parse(readFileSync(file, "utf8")) as { kind: string; allow?: AllowEntry[]; files?: AllowFile[] };
  if (j.kind !== ALLOW_KIND) throw new Error(`${file}: not a secret-gate allow list`);
  const allow = j.allow ?? [];
  const files = j.files ?? [];
  for (const a of allow) {
    if (!/^[0-9a-f]{64}$/.test(a.sha256) || !a.reason?.trim()) throw new Error(`${file}: each entry needs a sha256 and a reason`);
    if (a.kind === "own-key" || a.kind === "private-key-block" || a.kind === "key-array") throw new Error(`${file}: ${a.kind} can never be allowed`);
  }
  for (const f of files) {
    if (!f.path || !/^[0-9a-f]{64}$/.test(f.sha256) || !f.reason?.trim()) throw new Error(`${file}: each file entry needs a path, a sha256 and a reason`);
    if (!/^data\//.test(f.path)) throw new Error(`${file}: only data/ files can be allowed whole (${f.path})`);
  }
  return { allow, files };
}

/**
 * Findings that stop a publish. A known shape left in a file (not redacted) always stops; it is fixed by
 * redacting, never by allowing. The runner's own key always stops. Others stop unless the allow list has that
 * exact value for that kind, or the value comes from a whole file the list allows (the site repeats data/).
 */
export function blockingFindings(findings: readonly Finding[], allow: readonly AllowEntry[] | AllowList, covered: ReadonlySet<string> = new Set()): Finding[] {
  const entries = Array.isArray(allow) ? allow : (allow as AllowList).allow;
  const ok = new Set(entries.map((a) => `${a.kind}:${a.sha256}`));
  return findings.filter((f) => f.known || f.kind === "own-key" || !(ok.has(`${f.kind}:${f.sha256}`) || covered.has(`${f.kind}:${f.sha256}`)));
}

/**
 * The whole tree through the gate. Files the allow list names whole (exact sha256) do not stop, except for a
 * known shape or the runner's key; the values in them are accepted where the site repeats them.
 */
export function gateTree(root: string, dirs: readonly string[], allow: AllowList, opts: ScanOptions = {}): { files: number; findings: Finding[]; blocking: Finding[] } {
  const { files, findings } = scanTree(root, dirs, opts);
  const whole = new Map(allow.files.map((f) => [f.path, f.sha256]));
  const allowedFile = new Set<string>();
  for (const [path, sha] of whole) {
    const abs = join(root, path);
    if (existsSync(abs) && sha256Hex(readFileSync(abs, "utf8")) === sha) allowedFile.add(path);
  }
  const covered = new Set(findings.filter((f) => allowedFile.has(f.file) && !f.known && f.kind !== "own-key").map((f) => `${f.kind}:${f.sha256}`));
  const blocking = blockingFindings(findings, allow, covered);
  return { files, findings, blocking };
}

/** One line per finding, safe to log: file, path, kind, length, masked shape, hash prefix. Never the value. */
export const describe = (f: Finding) =>
  `${f.file} ${f.path || "-"} ${f.kind}${f.known ? " (known shape, not redacted)" : ""} len=${f.length} shape=${f.shape} sha256=${f.sha256.slice(0, 16)}`;
