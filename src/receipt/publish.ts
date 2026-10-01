/**
 * Which x402-observation records go public, and the checks every published record passes.
 *
 * Policy:
 *  - DELIVERED records are published.
 *  - NOT_DELIVERED, MISMATCH and UNCLEAR name a seller next to a failure, so they are published only
 *    for sellers listed in data/records/notified.json (the seller was told first). That list starts empty.
 *  - A seller is the ranking's seller: the host, or host#service when one host fronts several services
 *    that each pay their own recipient. An entry matches only the exact seller key, so listing a bare
 *    host never publishes the failures of another service behind the same host.
 *
 * data/records/ layout:
 *   index.json            the list of published records, each with its sha256, and one line per daily root
 *                         (with days[].programRoot when the root is also in the observation-roots
 *                         program on Solana, and days[].tempoAnchor when it is also written on Tempo;
 *                         the records themselves are never rewritten for either)
 *   notified.json         sellers told about their records, so their negative records may be published
 *   <day>/<id>.json       the signed record, byte for byte as vet402 wrote it
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { VET402_OBSERVER_KEYS } from "./observers.js";
import { programRootShape, type ProgramRootEntry } from "./roots-index.js";
import { tempoDayAnchorShape, type TempoDayAnchor } from "./tempo-anchor.js";
import { verifyOffline } from "./verify.js";
import { UNSIGNED_FIELDS, VERDICTS, type Observation, type VerdictCode } from "./types.js";

export const PUBLISH_POLICY =
  "DELIVERED records are published. NOT_DELIVERED, MISMATCH and UNCLEAR records name a seller next to a failure, so they are published only after vet402 has told that seller, for the sellers listed in data/records/notified.json (host, or host#service for one service behind a shared host).";

export interface NotifiedSeller {
  /** Ranking seller key: "host", or "host#service" for one service behind a shared host. */
  seller: string;
  /** YYYY-MM-DD, the day the seller was told. */
  notifiedAt: string;
}

export interface NotifiedFile {
  note: string;
  sellers: NotifiedSeller[];
}

export interface RecordEntry {
  id: string;
  day: string;
  /** Path inside data/records/. */
  file: string;
  sha256: string;
  network: string;
  verdict: VerdictCode;
  resourceUrl: string;
  host: string;
  /** Seller key in the delivery ranking (host, or host#service for a proxy). */
  seller: string;
  sequence: number;
}

export interface DayEntry {
  day: string;
  root: string;
  /** Records in the root (published or not). */
  inRoot: number;
  published: number;
  sequenceRange: [number, number];
  observerAddress: string;
  anchor: { status: "pending" | "anchored"; network: string; tx: string | null };
  /** The same root in the observation-roots program's day account (src/receipt/roots-index.ts). Absent = memo only. */
  programRoot?: ProgramRootEntry;
  /** The same root in a Tempo TIP-20 memo (src/receipt/tempo-anchor.ts). Absent = Solana only. */
  tempoAnchor?: TempoDayAnchor;
}

export interface RecordIndex {
  kind: "vet402-observation-records";
  version: 0;
  policy: string;
  notifiedSellers: number;
  days: DayEntry[];
  records: RecordEntry[];
}

export function hostOfUrl(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** "host" or "host#service" (the ranking's seller key). */
export const SELLER_KEY = /^[a-z0-9.-]+(?:#[A-Za-z0-9._:-]+)?$/;

export function notifiedSellers(file: NotifiedFile): Set<string> {
  if ("hosts" in (file as object)) throw new Error('notified.json: "hosts" is replaced by "sellers" ({ seller, notifiedAt }; seller = host or host#service)');
  const out = new Set<string>();
  for (const h of file.sellers) {
    if (typeof h.seller !== "string" || !SELLER_KEY.test(h.seller) || !/^\d{4}-\d{2}-\d{2}$/.test(h.notifiedAt)) throw new Error(`notified.json: bad entry ${JSON.stringify(h)}`);
    out.add(h.seller);
  }
  return out;
}

/** The seller key belongs to the record's host: the host itself, or host#service. */
export function sellerOfHost(seller: string, host: string): boolean {
  return seller === host || seller.startsWith(`${host}#`);
}

/**
 * DELIVERED: always. Otherwise only when this exact seller key was told. A bare host entry matches only
 * a seller whose key is the bare host, which the ranking uses only when the host has at most one service.
 */
export function isPublishable(o: Pick<Observation, "verdict" | "resourceUrl">, seller: string, notified: ReadonlySet<string>): boolean {
  if (!sellerOfHost(seller, hostOfUrl(o.resourceUrl))) return false;
  if (o.verdict.code === "DELIVERED") return true;
  return sellerWasTold(seller, notified);
}

/**
 * Has vet402 told this seller (its exact ranking key, host or host#service) about its results? The one
 * test for every negative result vet402 publishes: signed records here, and the "avoid" verdict of
 * packages/check (verdict.ts).
 */
export function sellerWasTold(seller: string, notified: ReadonlySet<string>): boolean {
  return notified.has(seller);
}

/** Credential and local-machine shapes that must never appear in a published record. */
const FORBIDDEN: [string, RegExp][] = [
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["API key", /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_]{20,}|sk_live_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})/],
  ["JWT", /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ["credential field", /"(?:private_?key|secret_?key|secret|mnemonic|seed_?phrase|api_?key|apikey|password|passphrase|access_?token|auth_?token|client_?secret|authorization|cookie|body)"\s*:/i],
  ["bearer token", /\bbearer\s+[A-Za-z0-9._~+/-]{8,}/i],
  ["64-byte key array", /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/],
  ["local path", /(?:\/Users\/|\/home\/|~\/|[A-Za-z]:\\\\|file:\/\/)/],
];

/**
 * Problems that keep a record out of the public set. Empty = publishable as far as content goes.
 * The schema (additionalProperties: false) already keeps a response body out; this checks the text.
 */
export function publicRecordProblems(text: string, o: Observation): string[] {
  const out: string[] = [];
  for (const [what, re] of FORBIDDEN) if (re.test(text)) out.push(what);
  const u = new URL(o.resourceUrl);
  if (u.search || u.hash || u.username || u.password) out.push("resourceUrl carries a query, fragment or credentials");
  if (u.protocol !== "https:" && u.protocol !== "http:") out.push("resourceUrl is not http(s)");
  if (o.request.params_hash !== null && !o.request.params_salted) out.push("params_hash is not salted");
  for (const k of UNSIGNED_FIELDS) if (!(k in o)) out.push(`missing ${k}`);
  if (!o.signature) out.push("unsigned");
  if (!o.anchor) out.push("not in a daily root");
  return out;
}

/** The signer must be one of vet402's published observation keys. */
export function publishedObserverKey(address: string): string | null {
  return VET402_OBSERVER_KEYS.find((k) => k.toLowerCase() === address.toLowerCase()) ?? null;
}

export interface LoadedRecord {
  entry: RecordEntry;
  obs: Observation;
  /** The exact bytes of the published file. */
  text: string;
}

export interface LoadedRecords {
  index: RecordIndex;
  notified: NotifiedFile;
  records: LoadedRecord[];
}

/**
 * Read data/records/ and refuse it unless every published record is exactly as listed, signed by a
 * vet402 key, in its daily root, allowed by the policy, and free of forbidden content; and no file
 * sits there that the index does not list.
 */
export async function loadPublishedRecords(dir: string): Promise<LoadedRecords> {
  const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as RecordIndex;
  const notified = JSON.parse(readFileSync(join(dir, "notified.json"), "utf8")) as NotifiedFile;
  if (index.kind !== "vet402-observation-records" || index.version !== 0) throw new Error(`${dir}/index.json: not a records index`);
  const told = notifiedSellers(notified);
  const problems: string[] = [];
  const records: LoadedRecord[] = [];
  const listed = new Set<string>(["index.json", "notified.json"]);
  const days = new Map(index.days.map((d) => [d.day, d]));
  for (const e of index.records) {
    listed.add(e.file);
    if (!/^\d{4}-\d{2}-\d{2}\/obs_\d{4}-\d{2}-\d{2}_\d{6}\.json$/.test(e.file) || !e.file.endsWith(`/${e.id}.json`)) {
      problems.push(`${e.id}: bad file name ${e.file}`);
      continue;
    }
    const p = join(dir, e.file);
    if (!existsSync(p)) {
      problems.push(`${e.file}: missing`);
      continue;
    }
    const text = readFileSync(p, "utf8");
    if (sha256Hex(text) !== e.sha256) problems.push(`${e.file}: sha256 differs from index.json`);
    const o = JSON.parse(text) as Observation;
    if (o.id !== e.id || o.verdict.code !== e.verdict || o.resourceUrl !== e.resourceUrl || o.payment.network !== e.network || hostOfUrl(o.resourceUrl) !== e.host)
      problems.push(`${e.id}: index.json does not describe the file`);
    if (!VERDICTS.includes(o.verdict.code)) problems.push(`${e.id}: unknown verdict`);
    if (!sellerOfHost(e.seller, hostOfUrl(o.resourceUrl))) problems.push(`${e.id}: seller ${e.seller} is not the record's host ${hostOfUrl(o.resourceUrl)}`);
    else if (!isPublishable(o, e.seller, told)) problems.push(`${e.id}: ${o.verdict.code} for seller ${e.seller}, which is not in notified.json`);
    for (const x of publicRecordProblems(text, o)) problems.push(`${e.id}: ${x}`);
    const key = publishedObserverKey(o.observer.address);
    if (!key) problems.push(`${e.id}: signed by ${o.observer.address}, not a vet402 observation key`);
    const v = await verifyOffline(o, key ? { expectedSigner: key } : {});
    if (!v.schema.ok || !v.signature.ok || !v.verdict.ok || v.merkle.ok !== true) problems.push(`${e.id}: does not verify (${[v.schema.errors.join("; "), v.signature.detail, v.verdict.detail, v.merkle.detail].filter(Boolean).join(" | ")})`);
    const d = days.get(e.day);
    if (!d || !o.anchor || o.anchor.root !== d.root || o.anchor.day !== d.day) problems.push(`${e.id}: root differs from index.json day ${e.day}`);
    records.push({ entry: e, obs: o, text });
  }
  for (const d of index.days) {
    const n = index.records.filter((r) => r.day === d.day).length;
    if (n !== d.published) problems.push(`day ${d.day}: published ${d.published}, index lists ${n}`);
    if (d.programRoot !== undefined) {
      if (d.anchor.status !== "anchored") problems.push(`day ${d.day}: programRoot on a day whose memo anchor is not written`);
      for (const x of await programRootShape(d.programRoot, d.day)) problems.push(`day ${d.day}: ${x}`);
    }
    if (d.tempoAnchor !== undefined) for (const x of tempoDayAnchorShape(d.tempoAnchor, d.root)) problems.push(`day ${d.day}: ${x}`);
  }
  for (const f of walk(dir)) if (!listed.has(f)) problems.push(`${f}: not listed in index.json`);
  if (problems.length) throw new Error(`data/records refused:\n  ${problems.join("\n  ")}`);
  return { index, notified, records };
}

function walk(dir: string, prefix = ""): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((d) => {
    const rel = prefix ? `${prefix}/${d.name}` : d.name;
    return d.isDirectory() ? walk(dir, rel) : [rel];
  });
}

/**
 * The day's Tempo anchor for the records index, from <dayDir>/anchor-tempo-sent.json once it is "sent"
 * (scripts/anchor-receipts-tempo.ts). null = no Tempo anchor for the day, or not landed yet. Throws when
 * the file is "sent" but names another root or is malformed.
 */
export function tempoAnchorOfDay(dayDir: string, root: string): TempoDayAnchor | null {
  const p = join(dayDir, "anchor-tempo-sent.json");
  if (!existsSync(p)) return null;
  const f = JSON.parse(readFileSync(p, "utf8")) as { status?: unknown; tx?: unknown; memo?: unknown; block?: unknown };
  if (f.status !== "sent") return null;
  const a = { tx: String(f.tx).toLowerCase(), memo: String(f.memo).toLowerCase(), block: f.block as number };
  const bad = tempoDayAnchorShape(a, root);
  if (bad.length) throw new Error(`${p}: ${bad.join("; ")}`);
  return a;
}

/** After the memo is confirmed: the same record with its (unsigned) anchor marked as written. */
export function withAnchorTx(o: Observation, tx: string, anchoredAt: string): Observation {
  if (!o.anchor) throw new Error(`${o.id}: no anchor to mark`);
  if (o.anchor.status === "anchored") throw new Error(`${o.id}: already anchored in ${o.anchor.tx}`);
  return { ...o, anchor: { ...o.anchor, status: "anchored", tx, anchoredAt } };
}
