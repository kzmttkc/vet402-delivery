/**
 * The secret gate in front of every public data commit (scripts/daily/secret-gate.ts).
 *
 * Two steps:
 *  - redactKnown: a local result file becomes its public copy. Only the known shapes are changed, with the
 *    wording already used in data/ (b673edd, 1f2e295, 1e6e4db): a token a seller put in its response body
 *    (a JWT in `detail` or `first300`) and local runner paths (/Users/<name>/ -> ~/).
 *  - scan: every file that would be public is read again. Anything that still looks like a credential or a
 *    local path is a finding, and one finding not on the allow list stops the commit (fail closed).
 *
 * Detected: JWTs (eyJ...), Bearer values, api key / token / secret / password style fields with an opaque
 * value (JSON keys, `name=value`, `"name":"value"` inside text), URL query values under such names, local
 * paths, private key blocks, vendor key prefixes, 64-byte key arrays, the runner's own keys in any common
 * encoding (when given the key folder), and opaque strings of 40 characters or more. Public shapes are not
 * findings: base58 addresses and signatures, hex, Algorand addresses and transaction ids, IPFS ids, payment
 * challenge ids, percent-encoded bytes, and hyphenated words or UUID-like ids.
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
  /** A shape redactKnown replaces (a seller's JWT in a response body, a local path). */
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
const JWT_SRC = String.raw`eyJ[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]*){0,2}`;
const LOCAL_PATH_SRC = String.raw`\/Users\/[^/\s"'\\]+\/`;

function redactString(s: string, key: string | null, path: string, out: Redaction[]): string {
  let v = s;
  if (key !== null && SELLER_BODY_FIELDS.includes(key) && new RegExp(JWT_SRC).test(v)) {
    v = v.replace(new RegExp(JWT_SRC, "g"), SELLER_TOKEN_REDACTION);
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

// ---------- detection ----------

const SECRET_NAME = String.raw`(?:x[-_]?)?(?:api[-_]?key|apikey|access[-_]?key|secret(?:[-_]?key)?|client[-_]?secret|password|passwd|private[-_]?key|(?:access|refresh|id|auth|session|bearer)[-_]?token|token|session(?:[-_]?id)?|auth(?:orization)?|cookie|jwt)`;
const SECRET_KEY_RE = new RegExp(`^${SECRET_NAME}$`, "i");
/** `"name":"value"`, `name=value` or `name: value` inside text (a response body, a log line). */
const SECRET_PAIR_SRC = `(?:^|[^A-Za-z0-9_-])["']?(${SECRET_NAME})["']?\\s*[:=]\\s*["']?([A-Za-z0-9_.~+/=-]{8,})`;
const URL_SRC = String.raw`https?:\/\/[^\s"'<>\\]+`;
const BEARER_SRC = String.raw`\bbearer\s+([A-Za-z0-9_.~+/=-]{8,})`;
const PATH_SRC = String.raw`(?:\/Users\/|\/home\/)[^\s"'<>\\]*`;
const OPAQUE_SRC = String.raw`[A-Za-z0-9_+=-]{40,}`;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const VENDOR_KEY =
  /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|sk_live_[A-Za-z0-9]{8,}|rk_live_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|re_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,})/g;
const KEY_ARRAY = /\[\s*(?:\d{1,3}\s*,\s*){31,63}\d{1,3}\s*\]/g;

const BASE58_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const BASE58_ANY = /^[1-9A-HJ-NP-Za-km-z]+$/;
const HEX = /^(?:0x)?[0-9a-fA-F]{40,}$/;
/** Algorand: addresses are 58 base32 characters, transaction ids 52. */
const ALGO_ADDR = /^[A-Z2-7]{58}$/;
const ALGO_TX = /^[A-Z2-7]{52}$/;
/** IPFS: CIDv0 (Qm + base58) and CIDv1 in base32 (baf...). */
const IPFS_CID = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{20,}|baf[a-z2-7]{20,})$/;
/** Field names whose values are public by design: a 402 payment challenge id is handed to anyone who asks. */
const PUBLIC_ID_KEYS = /^(?:challengeId|challenge_id)$/;

/** A value that stands for itself (redacted, a placeholder), not a credential. */
function isPlaceholder(v: string): boolean {
  return v.startsWith("[redacted") || /^(?:x+|\*+|\.+|<[^>]*>|null|undefined|true|false|none|your[-_].*|example.*|test|demo|string)$/i.test(v);
}

/**
 * A value under a secret-like name that counts: for password, passwd and secret any value of 8 or more
 * characters that is not a placeholder; for keys, tokens, sessions and cookies an opaque one (looksOpaque).
 */
function secretValue(name: string, v: string): boolean {
  if (/pass(?:word|wd)|^(?:x[-_]?)?(?:client[-_]?)?secret$/i.test(name)) return v.length >= 8 && !isPlaceholder(v);
  return looksOpaque(v);
}

/** Opaque = random-looking: long, and mixes cases or letters and digits without word breaks. */
function looksOpaque(v: string): boolean {
  if (v.length < 16 || isPlaceholder(v)) return false;
  if (/^[a-z]+(?:[-_.][a-z]+)*$/i.test(v)) return false; // words
  if (/^\d+$/.test(v)) return false;
  return [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(v)).length >= 2;
}

/**
 * A long run that could be a key: at least 12 distinct characters from at least two of lower, upper, digit.
 * "AAAA...", "xxxx..." and base64 of zeros are not; any random 40-character token is.
 */
function looksRandom(t: string): boolean {
  return new Set(t).size >= 12 && [/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(t)).length >= 2;
}

/** Public shapes among long strings: on-chain ids, hashes, IPFS ids, hyphenated words, UUID-like ids. */
export function isPublicLongToken(t: string): boolean {
  if (BASE58_ADDR.test(t) || BASE58_SIG.test(t) || HEX.test(t) || ALGO_ADDR.test(t) || ALGO_TX.test(t) || IPFS_CID.test(t)) return true;
  // hex or on-chain ids joined by separators or with a short prefix (eth_0x..., uuid-uuid), and plain words.
  // A random token that happens to hold a - or _ is not split into harmless parts: each part must be a word,
  // a number, lowercase hex, a short lowercase code, or a public id itself.
  const parts = t.split(/[-_:=+]/).filter(Boolean);
  const lower = !/[A-Z]/.test(t); // a lowercase slug: x402-weather-v2beta-...
  return parts.length > 1 && parts.every((p) => isPlainPart(p, lower) || isPublicLongToken(p));
}

/** A part of a joined string that is a word (camelCase too), a number, hex, or in a lowercase slug any short code. */
function isPlainPart(p: string, lowerSlug: boolean): boolean {
  if (p.length >= 20) return false;
  if (lowerSlug) return /^[a-z0-9]+$/.test(p);
  return /^(?:[a-z]+(?:[A-Z][a-z]*)*|[A-Z][a-z]+(?:[A-Z][a-z]*)*|[A-Z]+|\d+|[0-9a-f]+|0x[0-9a-fA-F]+)$/.test(p);
}

/**
 * A `token`-named value that is an on-chain id: a Solana mint or an EVM address. Crypto APIs name the asset
 * `token`. `cutAtEnd`: the value runs to the end of a body kept to 300 characters, so it may be the start
 * of an address (a prefix of at least 12 base58 characters with both cases).
 */
function isOnChainId(v: string, cutAtEnd = false): boolean {
  if (isPublicLongToken(v) || /^0x[0-9a-fA-F]{40}$/.test(v)) return true;
  if (cutAtEnd && BASE58_ANY.test(v) && v.length >= 12 && v.length < 44 && /[a-z]/.test(v) && /[A-Z]/.test(v)) return true;
  return cutAtEnd && /^0x[0-9a-fA-F]{1,40}$/.test(v);
}

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
      // 64-byte Solana keypairs hold the public key in the second half: only the secret half is a needle.
      const secret = b.length === 64 ? b.subarray(0, 32) : b;
      out.push(secret.toString("hex"), secret.toString("base64").replace(/=+$/, ""), secret.toString("base64url"), base58(b));
      if (b.length === 64) out.push(base58(secret));
    }
  }
  return out.filter((n) => n.length >= 32);
}

function base58(b: Buffer): string {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x" + (b.toString("hex") || "0"));
  let s = "";
  while (n > 0n) {
    s = A[Number(n % 58n)]! + s;
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
}

export function scanText(text: string, file: string, path: string, key: string | null, out: Finding[], opts: ScanOptions = {}): void {
  const add = (kind: FindingKind, v: string, known = false) =>
    out.push({ file, path, kind, known, sha256: sha256Hex(v), length: v.length, shape: maskShape(v) });
  const covered: [number, number][] = [];
  const cover = (s: number, e: number) => covered.push([s, e]);
  const isCovered = (s: number, e: number) => covered.some(([a, b]) => s < b && e > a);
  const all = (src: string, flags = "g") => text.matchAll(new RegExp(src, flags));

  for (const needle of opts.ownKeys ?? []) if (text.includes(needle)) add("own-key", needle);
  if (key !== null && PUBLIC_ID_KEYS.test(key)) return;
  if (key !== null && SECRET_KEY_RE.test(key) && secretValue(key, text) && !(/token/i.test(key) && isOnChainId(text))) {
    add("secret-field", text);
    return;
  }
  for (const m of text.matchAll(PRIVATE_KEY_BLOCK)) add("private-key-block", m[0]);
  for (const m of text.matchAll(VENDOR_KEY)) {
    // `sk-` alone is also an ordinary word start (a URL path like /sk-soil-fragments): only an opaque tail counts.
    if (m[0].startsWith("sk-") && !looksOpaque(m[0].replace(/^sk-(?:proj-|ant-)?/, ""))) continue;
    add("vendor-key", m[0]);
    cover(m.index!, m.index! + m[0].length);
  }
  for (const m of text.matchAll(KEY_ARRAY)) add("key-array", m[0]);
  const bodyField = key !== null && SELLER_BODY_FIELDS.includes(key);
  for (const m of all(JWT_SRC)) {
    add("jwt", m[0], bodyField);
    cover(m.index!, m.index! + m[0].length);
  }
  for (const m of all(BEARER_SRC, "gi")) {
    if (isCovered(m.index!, m.index! + m[0].length) || isPlaceholder(m[1]!)) continue;
    add("bearer", m[1]!);
    cover(m.index!, m.index! + m[0].length);
  }
  for (const m of all(PATH_SRC)) {
    add("local-path", m[0], m[0].startsWith("/Users/"));
    cover(m.index!, m.index! + m[0].length);
  }
  for (const m of all(URL_SRC)) {
    let u: URL;
    try {
      u = new URL(m[0].replace(/[),.;]+$/, ""));
    } catch {
      continue;
    }
    for (const [name, value] of u.searchParams) {
      if (SECRET_KEY_RE.test(name) && secretValue(name, value) && !isCovered(m.index!, m.index! + m[0].length) && !(/token/i.test(name) && isOnChainId(value))) {
        add("url-query-secret", value);
      }
    }
    if (u.password) add("url-query-secret", u.password);
  }
  for (const m of all(SECRET_PAIR_SRC, "gi")) {
    const name = m[1]!;
    const v = m[2]!;
    const start = m.index! + m[0].length - v.length;
    if (isCovered(start, start + v.length) || !secretValue(name, v) || isPublicLongToken(v)) continue;
    if (/token/i.test(name) && isOnChainId(v, start + v.length === text.length)) continue;
    add("secret-field", v);
    cover(start, start + v.length);
  }
  // Percent-encoded bytes (%22, %3A) are separators, not part of a token.
  const plain = text.replace(/%[0-9A-Fa-f]{2}/g, "   ");
  for (const m of plain.matchAll(new RegExp(OPAQUE_SRC, "g"))) {
    const t = m[0];
    const s = m.index!;
    if (isCovered(s, s + t.length) || isPublicLongToken(t) || !looksRandom(t)) continue;
    if (plain.slice(Math.max(0, s - 6), s) === "/ipfs/") continue;
    if (/challengeId\\?"?\s*[:=]\s*\\?"?$/i.test(plain.slice(Math.max(0, s - 20), s))) continue;
    add("opaque-40", t);
  }
}

/** Scan a parsed JSON value: keys give each string its path and field name. */
export function scanJson(value: unknown, file: string, out: Finding[], opts: ScanOptions = {}): void {
  const walk = (x: unknown, key: string | null, path: string) => {
    if (typeof x === "string") scanText(x, file, path, key, out, opts);
    else if (Array.isArray(x)) x.forEach((v, i) => walk(v, null, `${path}[${i}]`));
    else if (x && typeof x === "object") for (const [k, v] of Object.entries(x)) walk(v, k, path ? `${path}.${k}` : k);
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
    // Key arrays and own keys in the raw text too (a key array is numbers, not a string).
    for (const m of text.matchAll(KEY_ARRAY)) out.push({ file: rel, path: "", kind: "key-array", known: false, sha256: sha256Hex(m[0]), length: m[0].length, shape: maskShape(m[0]) });
    scanJson(v, rel, out, opts);
  } else if (rel.endsWith(".jsonl")) {
    text.split("\n").forEach((line, i) => {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        scanText(line, rel, `line${i + 1}`, null, out, opts);
        return;
      }
      const found: Finding[] = [];
      scanJson(parsed, rel, found, opts);
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

export function loadAllowList(file: string): AllowEntry[] {
  const j = JSON.parse(readFileSync(file, "utf8")) as { kind: string; allow: AllowEntry[] };
  if (j.kind !== ALLOW_KIND) throw new Error(`${file}: not a secret-gate allow list`);
  for (const a of j.allow) {
    if (!/^[0-9a-f]{64}$/.test(a.sha256) || !a.reason?.trim()) throw new Error(`${file}: each entry needs a sha256 and a reason`);
    if (a.kind === "own-key" || a.kind === "private-key-block" || a.kind === "key-array") throw new Error(`${file}: ${a.kind} can never be allowed`);
  }
  return j.allow;
}

/**
 * Findings that stop a publish. A known shape left in a file (not redacted) always stops; it is fixed by
 * redacting, never by allowing. Others stop unless the allow list has that exact value for that kind.
 */
export function blockingFindings(findings: readonly Finding[], allow: readonly AllowEntry[]): Finding[] {
  const ok = new Set(allow.map((a) => `${a.kind}:${a.sha256}`));
  return findings.filter((f) => f.known || f.kind === "own-key" || !ok.has(`${f.kind}:${f.sha256}`));
}

/** One line per finding, safe to log: file, path, kind, length, masked shape, hash prefix. Never the value. */
export const describe = (f: Finding) =>
  `${f.file} ${f.path || "-"} ${f.kind}${f.known ? " (known shape, not redacted)" : ""} len=${f.length} shape=${f.shape} sha256=${f.sha256.slice(0, 16)}`;
