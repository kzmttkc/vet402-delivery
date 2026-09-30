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
import { BIP39_ENGLISH } from "./bip39-english.js";

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

/** Letters from other scripts that look like Latin ones (Cyrillic, Greek), folded before names are compared. */
const LOOKALIKE: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u043a": "k",
  "\u0442": "t", "\u043c": "m", "\u043d": "h", "\u0432": "b", "\u0456": "i", "\u0458": "j", "\u0455": "s", "\u0501": "d",
  "\u0261": "g", "\u03bf": "o", "\u03b1": "a", "\u03b5": "e", "\u03ba": "k", "\u03bd": "v", "\u03c4": "t", "\u03c1": "p",
  "\u03c5": "u", "\u03b9": "i", "\u0391": "a", "\u0392": "b", "\u0395": "e", "\u0397": "h", "\u0399": "i", "\u039a": "k",
  "\u039c": "m", "\u039d": "n", "\u039f": "o", "\u03a1": "p", "\u03a4": "t", "\u03a7": "x", "\u03a5": "y", "\u0410": "a",
  "\u0412": "b", "\u0415": "e", "\u041a": "k", "\u041c": "m", "\u041d": "h", "\u041e": "o", "\u0420": "p", "\u0421": "c",
  "\u0422": "t", "\u0425": "x",
};
/** A name as compared: compatibility forms folded (fullwidth), lookalike letters mapped, case and separators dropped. */
export function foldName(name: string): string {
  return [...name.normalize("NFKC")].map((c) => LOOKALIKE[c] ?? c).join("").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Names whose value is a secret whatever it looks like, compared without case or separators. */
const SECRET_EXACT = new Set(["key", "sid", "pass", "pwd", "pk", "priv", "private", "privkey", "seed", "wif", "xprv", "wallet", "otp", "totp", "mfa"]);
/** Parts that make any name secret wherever they stand in it (token2, tokenValue, secret_value, apiKeyId). */
const SECRET_PARTS = ["token", "secret", "key", "passw", "passphrase", "credential", "cookie", "session", "bearer", "jwt", "mnemonic", "xprv", "seedphrase"];
/** Endings that make a name secret (auth, x-authorization, signature, hmac_sig). */
const SECRET_SUFFIX = ["auth", "authorization", "signature", "sig", "privatekey"];

/** A name whose value is a secret whatever it looks like: any case, any separator (api_key, X-Api-Key, apiKey, "api key"). */
export function isSecretName(name: string): boolean {
  const n = foldName(name);
  if (!n) return false;
  return SECRET_EXACT.has(n) || SECRET_PARTS.some((s) => n.includes(s)) || SECRET_SUFFIX.some((s) => n.endsWith(s));
}

/**
 * Names under which public on-chain ids stand (a transaction, a payer, an address, a hash). An id in its exact
 * format passes only under one of these, or when the same value stands under one of them elsewhere in the file.
 */
const PUBLIC_ID_FIELDS = new Set([
  "tx", "txhash", "txid", "txsig", "transaction", "transactionhash", "transactionid", "signature", "hash", "blockhash",
  "payto", "expectedpayto", "payer", "feepayer", "address", "from", "to", "recipient", "owner", "mint", "asset",
  "contract", "account", "destination", "creator", "pubkey", "programid", "settlementtxid", "memo", "root",
  // vet402's own record fields that hold hashes and ids it computed
  "sha256", "urlhash", "paramshash", "responsehash", "bodyhash", "digest", "proof", "paytos", "observeraddress", "txs",
]);
/** Endings of names that hold an on-chain id (settlementTx, feedbackTx, tokenAddress, blockHash). */
const PUBLIC_ID_SUFFIX = ["tx", "txhash", "txid", "hash", "address", "payto", "mint", "owner", "recipient"];
const isPublicIdField = (name: string | null) => {
  if (name === null) return false;
  const n = foldName(name);
  return PUBLIC_ID_FIELDS.has(n) || PUBLIC_ID_SUFFIX.some((x) => n.endsWith(x));
};

/**
 * Fields of vet402's own record format that carry secret-like names but hold public values vet402 wrote,
 * each checked against its exact format. A seller's text never reaches these checks: names found inside a
 * string (a response body, a URL) are always secret-field findings.
 */
const OWN_FIELDS: { path: RegExp; key: string; ok: (v: unknown) => boolean }[] = [
  // remeasure budget / ledger key, wherever vet402's own records carry it: <UTC day>|<payTo>|<slot>
  { path: /(?:^|\.|\])key$/, key: "key", ok: (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}\|(?:[1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})\|\d+$/.test(v) },
  // Tempo census ledger key: the service slug
  { path: /^entries\[\d+\]\.key$/, key: "key", ok: (v) => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,40}$/.test(v) },
  // the ranking's seller key: host, or host#service
  { path: /^groups\[\d+\]\.(?:ranking|comparisons\[\d+\]\.[A-Za-z]+)\[\d+\]\.key$/, key: "key", ok: (v) => typeof v === "string" && /^[a-z0-9.-]+(?::\d+)?(?:#[A-Za-z0-9._/-]{1,80})?$/.test(v) },
  // a Solana transaction signature vet402 sent or read back
  { path: /(?:^|\.)(?:rows|records|attempts)\[\d+\](?:\.[A-Za-z]+)*\.signature$/, key: "signature", ok: (v) => typeof v === "string" && base58Len(v) === 64 },
  // vet402's EIP-712 signature on its own observation record: the object and its 65-byte hex value
  { path: /^signature$/, key: "signature", ok: (v) => !!v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every((k) => ["format", "scheme", "domain", "signer", "signature", "types", "primaryType"].includes(k)) },
  { path: /^signature\.signature$/, key: "signature", ok: (v) => typeof v === "string" && /^0x[0-9a-f]{130}$/.test(v) },
  // the x402 memo vet402 put on its own payment (16 random bytes, hex), as sent and as read back
  { path: /^records\[\d+\](?:\.onChain)?\.memo$/, key: "memo", ok: (v) => typeof v === "string" && /^[0-9a-f]{32}$/.test(v) },
  // the census judgement's list of the JSON keys a seller's example promised (field names, not secrets)
  { path: /^records\[\d+\]\.judgement\.(?:exampleKeys|expectedKeys|missingKeys|unseenExampleKeys)(?:\[\d+\])?$/, key: "", ok: (v) => (Array.isArray(v) ? v : [v]).every((x) => typeof x === "string" && /^[A-Za-z0-9_.$-]{1,80}$/.test(x)) },
  // the token symbols the Tempo census saw in 402 challenges
  { path: /^tokensSeen(?:\[\d+\])?$/, key: "", ok: (v) => (Array.isArray(v) ? v : [v]).every((x) => typeof x === "string" && /^[A-Za-z0-9.]{1,12}$/.test(x)) },
  // the token symbol a Tempo 402 challenge names (USDC.e)
  { path: /^rows\[\d+\]\.live\.token$/, key: "token", ok: (v) => typeof v === "string" && /^[A-Za-z0-9.]{1,12}$/.test(v) },
];

function ownField(path: string, key: string, v: unknown): boolean {
  return OWN_FIELDS.some((f) => (f.key === key || f.key === "") && f.path.test(path) && f.ok(v));
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
 * Formats that are public ids with no other reading: an EVM address (0x + 40 hex), an Algorand address with
 * its checksum, an IPFS id. A 32-byte base58 value, 64 hex or 64 base58 bytes can also be a key, so those
 * need a known field (isPublicIdField) or the same value under one elsewhere in the file.
 */
function isUnambiguousPublicId(t: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(t) || algorandAddress(t) || IPFS_CID.test(t);
}

/**
 * Words, the way people name things: lowercase, Capitalized or camelCase words of three letters or more that
 * each hold a vowel, short acronyms (USDC, API) and numbers. Random letters rarely read as words.
 */
export function isWords(t: string): boolean {
  const toks = t.match(/[A-Z]{2,4}(?![a-z])|[A-Z]?[a-z]+|\d+/g) ?? [];
  if (toks.join("") !== t || toks.length === 0) return false;
  for (const [i, x] of toks.entries()) {
    if (/^\d+$/.test(x) || /^[A-Z]{2,4}$/.test(x)) continue;
    if (/^[A-Z][a-z]$/.test(x) || (i === 0 && /^[a-z]$/.test(x))) continue; // Tx, Id, Ms; x in x402
    const w = x.toLowerCase();
    // A word has vowels among its letters and no long consonant run ("Uxqhbv" is not one).
    if (x.length < 3 || !/[aeiouy]/.test(w) || /[^aeiouy]{5}/.test(w) || (w.match(/[aeiouy]/g) ?? []).length / w.length < 0.2) return false;
  }
  if (toks.filter((x) => /^[A-Z]{2,4}$/.test(x)).length > 2) return false;
  // Short tokens (Tx, Id, Ms) come one at a time in names, not in a row.
  if (toks.filter((x) => /^[A-Z][a-z]$/.test(x)).length > 2) return false;
  return t.length / toks.length >= 3.5;
}

/** A part of a joined string: words, a number, or in an all-lowercase slug any short code. */
function isPlainPart(p: string, lowerSlug: boolean): boolean {
  if (p.length >= 20) return false;
  // In an all-lowercase slug (a host, a deployment id) a short code is part of a name.
  if (lowerSlug) return /^[a-z0-9]+$/.test(p) && (p.length <= 12 || /[aeiouy]/.test(p) || /^\d+$/.test(p) || /^[0-9a-f]+$/.test(p));
  return /^\d+$/.test(p) || isWords(p);
}

/**
 * Public shapes among long runs: ids with no other reading, or words joined by separators (a UUID, a host
 * name, a path, x402-weather-v2beta). A random token that happens to hold - _ . / is not split into harmless parts.
 */
export function isPublicLongToken(t: string): boolean {
  if (isUnambiguousPublicId(t)) return true;
  const parts = t.split(/[-_:=+./]/).filter(Boolean);
  const lower = !/[A-Z]/.test(t);
  // A lowercase slug reads as words; random lowercase parts joined by dashes do not.
  const longParts = parts.filter((p) => /^[a-z]{5,}$/.test(p));
  if (lower && longParts.join("").length >= 16 && wordiness(longParts.join("-")) < 0.8) return false;
  if (parts.length > 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(t)) return true; // UUID
  return parts.length > 1 && parts.every((p) => isPlainPart(p, lower));
}

const BIP39 = new Set(BIP39_ENGLISH);
/** Letter pairs common in English words (seen 8 times or more across the BIP-39 list). */
const COMMON_BIGRAMS = (() => {
  const c = new Map<string, number>();
  for (const w of BIP39_ENGLISH) for (let i = 0; i + 1 < w.length; i++) c.set(w.slice(i, i + 2), (c.get(w.slice(i, i + 2)) ?? 0) + 1);
  return new Set([...c].filter(([, n]) => n >= 8).map(([b]) => b));
})();
/** Share of a lowercase string's letter pairs that are common in English: about 0.35 for random letters, 0.8+ for words. */
export function wordiness(s: string): number {
  let hit = 0, all = 0;
  for (const part of s.toLowerCase().split(/[^a-z]+/)) {
    for (let i = 0; i + 1 < part.length; i++) {
      all++;
      if (COMMON_BIGRAMS.has(part.slice(i, i + 2))) hit++;
    }
  }
  return all ? hit / all : 1;
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
 * Random-looking: enough distinct characters from at least two of lower, upper, digit. A field name made of
 * words (payableTotalWithFeeReserve) is not; in a value a run of letters is judged random unless it is one of
 * the field names the scanned files use (the site prints them).
 */
function looksRandom(t: string, allowWords = false): boolean {
  if (NETWORK_IDS.has(t) || (allowWords && isWords(t))) return false;
  // One kind of character only: a long number, or letters that do not read as words.
  const bare = t.replace(/[-_.:/=+]/g, "");
  if (/^\d+$/.test(bare)) return bare.length >= 24;
  if (/^[a-z]+$/.test(bare) || /^[A-Z]+$/.test(bare)) return bare.length >= 20 && wordiness(t) < 0.85;
  const distinct = new Set(t.replace(/[-_.:/=+]/g, "")).size;
  return distinct >= Math.min(12, Math.floor(t.length * 0.6)) && [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(t)).length >= 2;
}

// ---------- readings of a string ----------

function jsonUnescape(s: string): string {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
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

const printable = (b: Buffer) => {
  let n = 0;
  for (const x of b) if ((x >= 0x20 && x < 0x7f) || x === 0x0a || x === 0x0d || x === 0x09) n++;
  return b.length > 0 && n / b.length >= 0.95;
};

/** Text hidden as base64 (standard or url-safe) or as hex: decoded when it reads as text. */
function encodedTexts(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/[A-Za-z0-9+/_-]{16,}={0,2}/g)) {
    const b = Buffer.from(m[0].replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (b.length >= 12 && printable(b)) out.push(b.toString("latin1"));
  }
  for (const m of s.matchAll(/(?:[0-9a-fA-F]{2}){16,}/g)) {
    const b = Buffer.from(m[0], "hex");
    if (printable(b)) out.push(b.toString("latin1"));
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** HTML character references (&#101; &#x65; &quot;) decoded, and invisible characters (zero-width, soft hyphen) removed. */
function htmlUnescape(s: string): string {
  return s
    .replace(/&#(\d{1,7});/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/g, (m, n: string) => ENTITIES[n] ?? m)
    .replace(/[\u00ad\u200b-\u200f\u2060\ufeff]/g, "");
}

/** The string and every reading of it after undoing escapes, percent-encoding, base64 and hex, up to 5 rounds. */
export function readings(s: string): string[] {
  const seen = new Set<string>([s]);
  let frontier = [s];
  for (let round = 0; round < 5 && frontier.length; round++) {
    const next: string[] = [];
    for (const v of frontier) {
      for (const w of [jsonUnescape(v), htmlUnescape(v), percentDecode(v), ...encodedTexts(v)]) {
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

/** "name": "value", "name": 123, "name": [ ... or { ... (the value may be cut off at the end of a body). */
const QUOTED_PAIR = /["'`]([^"'`\n]{1,300})["'`]\s*:\s*(?:["'`]([^"'`]*)["'`]?|([[{][\s\S]{0,160})|(-?\d[\d.eE+-]*))/g;
/** name=value or name = value in a query, a fragment, a form, a cookie, code or config. */
const FORM_PAIR = /(?:^|[?&;,#\s{(])([A-Za-z0-9_.%[\]-]{1,300})[ \t]*=[ \t]*(?![="])([^&;#\s"'<>]+)/g;
/** name="value" as an HTML or XML attribute. */
const ATTR_PAIR = /([A-Za-z_:][A-Za-z0-9_:.-]{0,300})\s*=\s*(["'])([^"']*)\2/g;
/** name: value as in a header or YAML line. */
const HEADER_PAIR = /(?:^|[\s{,;(])([A-Za-z][A-Za-z0-9_ -]{0,300}?)[ \t]*:[ \t]*([^\s"',;{}<>[\]]+)/g;
/** <name>value</name> */
const XML_PAIR = /<([A-Za-z_][\w:.-]{0,300})[^>]*>([^<]{1,500})<\/\1>/g;
/** scheme://user:password@host */
const URL_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@"']+:([^/\s@"']+)@/gi;
const JWT_PIECE = /eyJ[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*){0,2}/g;
const AUTH_SCHEME = /\b(?:bearer|basic)\s+([A-Za-z0-9_.~+/=-]{8,})/gi;
/** "Authorization: token <value>" (GitHub style): the scheme word followed by a random-looking value. */
const TOKEN_SCHEME = /\btoken\s+([A-Za-z0-9_.~+/=-]{20,})/gi;
const LOCAL_PATH = /(?:\/Users\/|\/home\/)[^\s"'<>\\]*/g;
const OPAQUE = /[A-Za-z0-9_+=-]{16,}/g;
/** base64 with its own separators: padding or a plus sign, or several slashes between random parts. */
const B64_RUN = /[A-Za-z0-9+/]{20,}={0,2}/g;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const VENDOR_KEY =
  /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|[sprk]k_(?:live|test)_[A-Za-z0-9]{8,}|gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|re_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,})/g;
const KEY_ARRAY = /\[\s*(?:\d{1,3}\s*,\s*){31,63}\d{1,3}\s*\]/g;
/** A 402 payment challenge id is handed to anyone who asks for the resource. */
const PUBLIC_ID_NAMES = /^(?:challengeId|challenge_id)$/;
/** URL path steps after which an on-chain id stands (/tx/<sig>, /address/<addr>). */
const PATH_ID = /\/(?:tx|txs|transaction|transactions|address|addresses|account|accounts|token|tokens|mint|block|wallet)\/([A-Za-z0-9]{24,})/gi;

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
  /** Values under public-id fields of the same file: public by the file's own account. */
  publicIds?: ReadonlySet<string>;
  /** Field names (made of words) the scanned JSON files use: the site prints them as text. */
  fieldNames?: ReadonlySet<string>;
}

type Add = (kind: FindingKind, v: string, known?: boolean) => void;

function finder(file: string, path: string, out: Finding[]): { add: Add; flush: () => void } {
  const found = new Map<string, Finding>();
  const add: Add = (kind, v, known = false) => {
    const h = sha256Hex(v);
    const k = `${kind}:${h}`;
    const prev = found.get(k);
    if (prev) prev.known = prev.known || known;
    else found.set(k, { file, path, kind, known, sha256: h, length: v.length, shape: maskShape(v) });
  };
  return { add, flush: () => out.push(...found.values()) };
}

/** Scan one string value. `key`/`path`: its JSON field, or null/"" for plain text. */
export function scanText(text: string, file: string, path: string, key: string | null, out: Finding[], opts: ScanOptions = {}): void {
  const { add, flush } = finder(file, path, out);
  for (const needle of opts.ownKeys ?? []) if (text.includes(needle)) add("own-key", needle);
  // vet402's own field in its exact format: nothing else to look at.
  if (key !== null && ownField(path, key, text)) return flush();
  // A structured field under a secret-like name: always.
  if (key !== null && isSecretName(key) && text !== "" && !ownMarker(text)) add("secret-field", text);
  const bodyField = key !== null && SELLER_BODY_FIELDS.includes(key);
  const challengeField = key !== null && PUBLIC_ID_NAMES.test(key);
  const fileIds = opts.publicIds ?? new Set<string>();

  readings(text).forEach((v, i) => {
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
    for (const m of v.matchAll(AUTH_SCHEME)) if (!ownMarker(m[1]!)) add("bearer", m[1]!);
    for (const m of v.matchAll(TOKEN_SCHEME)) if (looksRandom(m[1]!)) add("bearer", m[1]!);
    for (const m of v.matchAll(URL_USERINFO)) add("url-query-secret", m[1]!);
    // Twelve or more BIP-39 words in a row: a wallet's recovery phrase.
    for (const m of v.matchAll(/[a-z]{3,8}(?:[ ,]+[a-z]{3,8}){11,}/g)) {
      const words = m[0].split(/[ ,]+/);
      let run = 0;
      for (const w of words) {
        run = BIP39.has(w) ? run + 1 : 0;
        if (run >= 12) {
          add("secret-field", m[0]);
          break;
        }
      }
    }
    for (const m of v.matchAll(LOCAL_PATH)) add("local-path", m[0], original && m[0].startsWith("/Users/"));

    // Values under names: secret-like names stop whatever the value; public-id names vouch for ids.
    const localIds = new Set<string>();
    const named = (name: string, value: string, kind: FindingKind) => {
      if (isSecretName(name)) {
        if (value !== "" && !ownMarker(value)) add(kind, value);
      } else if (isPublicIdField(name)) localIds.add(value);
    };
    for (const m of v.matchAll(QUOTED_PAIR)) named(m[1]!, m[2] ?? m[3] ?? m[4] ?? "", "secret-field");
    for (const m of v.matchAll(FORM_PAIR)) named(percentDecode(m[1]!), m[2]!, "url-query-secret");
    for (const m of v.matchAll(ATTR_PAIR)) named(m[1]!, m[3]!, "secret-field");
    for (const m of v.matchAll(XML_PAIR)) named(m[1]!, m[2]!.trim(), "secret-field");
    // name: value as a header or YAML line: under a secret-like name any value stops (prose included).
    for (const m of v.matchAll(HEADER_PAIR)) named(m[1]!.trim(), m[2]!, "secret-field");
    for (const m of v.matchAll(PATH_ID)) localIds.add(m[1]!);

    // base64 runs: judged whole, since their slashes and plus signs split them into short pieces below.
    for (const m of v.matchAll(B64_RUN)) {
      const t = m[0];
      // a URL authority or a path that runs into a host name (//host, /seller/host.html) is judged as a host
      if ((t.startsWith("//") && v[m.index! - 1] === ":") || (v[m.index! + t.length] === "." && /^[/a-z0-9-]+$/.test(t))) continue;
      if (!(/[+=]/.test(t) || (t.match(/\//g) ?? []).length >= 1)) continue;
      const pieces = t.replace(/=+$/, "").split(/[+/]/).filter(Boolean);
      if (pieces.every((p) => p.length < 3 || /^\d+$/.test(p) || isWords(p) || isPlainPart(p, !/[A-Z]/.test(p)) || isPublicLongToken(p) || localIds.has(p) || fileIds.has(p))) continue;
      if (!looksRandom(t.replace(/[+/=]/g, ""))) continue;
      add("opaque-40", t);
    }
    // Random-looking runs. Percent-encoded bytes are separators in the text as written.
    const plain = v.replace(/%[0-9A-Fa-f]{2}/g, "   ");
    for (const m of plain.matchAll(OPAQUE)) {
      const t = m[0].replace(/^[-_=+./]+|[-_=+./]+$/g, "");
      // A run right before a colon is a name ("ruggerHoldingsPct": ...): judged as a name.
      const asName = path.endsWith("(name)") || /^\\?["']?\s*:/.test(plain.slice(m.index! + m[0].length));
      if (t.length < 16 || !looksRandom(t, asName)) continue;
      // A lowercase label of a host name (www.x402financialdata.com, 2s-3cpr6qm6j-alleyford.vercel.app) names a seller.
      const pre = plain.slice(Math.max(0, m.index! - 3), m.index!);
      const post = plain.slice(m.index! + m[0].length, m.index! + m[0].length + 1);
      if (/^[a-z0-9-]+$/.test(t) && (pre.endsWith("://") || pre.endsWith(".") || post === ".")) continue;
      if (opts.fieldNames?.has(t)) continue;
      if (isPublicLongToken(t)) continue;
      // An id in its exact format stands for itself only where the file says what it is.
      if (isExactPublicId(t) && (fileIds.has(t) || localIds.has(t) || (original && m[0].length === v.length && isPublicIdField(key)))) continue;
      const before = plain.slice(Math.max(0, m.index! - 24), m.index!);
      if (/\/ipfs\/$/.test(before)) continue;
      if (/challengeId\\?["']?\s*[:=]\s*\\?["']?$/i.test(before)) continue;
      if (challengeField && m[0].length === v.length && original) continue; // the whole value of a payment challenge id field
      add("opaque-40", t);
    }
  });
  flush();
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
      if (k.length >= 16 && isWords(k)) into.add(k);
      collectNames(v, into);
    }
}

/** Values under public-id fields anywhere in a parsed file. */
function collectPublicIds(value: unknown, into: Set<string>): void {
  const walk = (x: unknown, key: string | null) => {
    if (typeof x === "string") {
      if (isPublicIdField(key) && isExactPublicId(x)) into.add(x);
    } else if (Array.isArray(x)) x.forEach((v) => walk(v, key));
    else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) walk(v, k);
  };
  walk(value, null);
}

/**
 * Scan a parsed JSON value: keys give each string its path and field name. Object keys are scanned too. A
 * secret-like name over an array, an object or a number is a finding as a whole (and its insides are scanned).
 */
export function scanJson(value: unknown, file: string, out: Finding[], opts: ScanOptions = {}): void {
  const ids = new Set<string>(opts.publicIds ?? []);
  collectPublicIds(value, ids);
  const o = { ...opts, publicIds: ids };
  const walk = (x: unknown, key: string | null, path: string) => {
    if (typeof x === "string") return scanText(x, file, path, key, out, o);
    if (key !== null && x !== null && typeof x !== "boolean" && isSecretName(key) && !ownField(path, key, x)) {
      const { add, flush } = finder(file, path, out);
      add("secret-field", JSON.stringify(x));
      flush();
    }
    if (Array.isArray(x)) x.forEach((v, i) => walk(v, key, `${path}[${i}]`));
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
  // The site prints ids that data/ names (a tx, a payTo, a hash): those stand for themselves on the site too.
  const ids = new Set<string>(opts.publicIds ?? []);
  const dataDir = join(root, "data");
  if (existsSync(dataDir)) {
    for (const f of walkFiles(dataDir).filter((x) => /\.jsonl?$/.test(x))) {
      const text = readFileSync(f, "utf8");
      for (const line of f.endsWith(".jsonl") ? text.split("\n") : [text]) {
        try {
          if (line.trim()) collectPublicIds(JSON.parse(line), ids);
        } catch {
          /* not JSON */
        }
      }
    }
  }
  const { files, findings } = scanTree(root, dirs, { ...opts, publicIds: ids });
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
