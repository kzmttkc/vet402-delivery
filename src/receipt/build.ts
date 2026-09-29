/**
 * Build x402-observation/v0 records from purchase results vet402 already ran.
 * Only facts that the run recorded go in. Anything it did not record is null and listed in
 * `notRecorded`; nothing is reconstructed or guessed.
 *
 * No record is made when no payment transaction was recorded: without a transaction there is no
 * money movement to point at (Stripe likewise only issues receipts for successful payments).
 */
import { concatHex, sha256, stringToBytes, toHex, type Hex } from "viem";
import { OBSERVATION_TYPE, OBSERVATION_VERSION, type Checks, type Observation, type Scope, type Verdict } from "./types.js";

export const HASH_NOT_RECORDED = "hash not recorded (this purchase predates receipts)";
export const CONTACT = "https://vet402.com/";

export const SCOPE_PROVES = [
  "observer-signed-at-time",
  "payment-on-chain",
  "response-status-at-time",
  "existed-by-anchor-time",
] as const;
export const SCOPE_DOES_NOT_PROVE = [
  "content-correctness",
  "seller-trustworthiness",
  "seller-availability-now",
  "refund-entitlement",
] as const;

export function scopeFor(hasResponseHash: boolean): Scope {
  return {
    proves: hasResponseHash ? [...SCOPE_PROVES, "response-bytes-hash-at-time"] : [...SCOPE_PROVES],
    doesNotProve: [...SCOPE_DOES_NOT_PROVE],
    vantage: "Seen from vet402's network only.",
    text: hasResponseHash
      ? "Proves vet402 paid and received these bytes at this time. Does not prove the content is correct."
      : "Proves vet402 paid and what HTTP status came back at this time. Does not prove the content is correct.",
  };
}

// ---------- verdict ----------

export interface VerdictInput {
  paymentSettled: boolean;
  httpStatus: number | null;
  bodyNonEmpty: boolean | null;
  declaredFormatMatched: boolean | null;
  /** Which declared thing did not match, for the reason line. */
  formatMismatchDetail?: string | null;
  sellerReceiptValid?: boolean | null;
  responseHashMatchesSeller?: boolean | null;
  /** Seconds vet402 waited, for the "no response" line. */
  timeoutSec?: number;
}

/**
 * The four words, decided only by recorded facts:
 *  - NOT_DELIVERED: paid, then no response / 5xx / 402 again / 2xx with an empty body.
 *    These do not depend on anything vet402 sent, so they stand on vet402's observation alone.
 *  - MISMATCH: paid, a 2xx came back, and a declared or signed value disagrees (named in the reason).
 *  - UNCLEAR: paid, then another 4xx. vet402 built that request from the seller's listing, so a
 *    fault on vet402's side is not ruled out, and it is not called NOT_DELIVERED.
 *  - DELIVERED: paid, 2xx, body not empty (or not recorded), nothing declared or signed disagrees.
 * Callers must not build a record for an unsettled payment; this throws to make that loud.
 */
export function decideVerdict(v: VerdictInput): Verdict {
  if (!v.paymentSettled) throw new Error("no observation for a payment that did not settle");
  const checks: Checks = {
    paymentSettled: true,
    httpStatus: v.httpStatus,
    bodyNonEmpty: v.bodyNonEmpty,
    declaredFormatMatched: v.declaredFormatMatched,
    sellerReceiptValid: v.sellerReceiptValid ?? null,
    responseHashMatchesSeller: v.responseHashMatchesSeller ?? null,
  };
  const s = v.httpStatus;
  const mk = (code: Verdict["code"], reason: string, recheck: string | null = null): Verdict => ({ code, reason, recheck, checks });
  if (s === null) return mk("NOT_DELIVERED", `Payment settled; no response within ${v.timeoutSec ?? 30}s.`);
  if (s === 402) return mk("NOT_DELIVERED", "Payment settled; the seller answered HTTP 402 (payment required) again.");
  if (s >= 500) return mk("NOT_DELIVERED", `Payment settled; the seller answered HTTP ${s}.`);
  if (s >= 200 && s <= 299) {
    if (v.bodyNonEmpty === false) return mk("NOT_DELIVERED", `Payment settled; HTTP ${s} with an empty body.`);
    if (v.sellerReceiptValid === false) return mk("MISMATCH", `HTTP ${s}; the seller's receipt did not verify.`);
    if (v.responseHashMatchesSeller === false) return mk("MISMATCH", `HTTP ${s}; the seller's signed responseHash differs from the hash vet402 computed.`);
    if (v.declaredFormatMatched === false)
      return mk("MISMATCH", `HTTP ${s}; the response did not match the seller's declared format${v.formatMismatchDetail ? ` (${v.formatMismatchDetail})` : ""}.`);
    const body = v.bodyNonEmpty === null ? "body size not recorded" : "non-empty body";
    const fmt = v.declaredFormatMatched === true ? ", matched the declared format" : "";
    return mk("DELIVERED", `Payment settled; HTTP ${s}, ${body}${fmt}.`);
  }
  if (s >= 400)
    return mk(
      "UNCLEAR",
      `Payment settled; the seller answered HTTP ${s}. vet402 built this request from the seller's listing, so a fault on vet402's side is not ruled out.`,
      "On the seller's request, or in vet402's next purchase of this resource.",
    );
  return mk("UNCLEAR", `Payment settled; unexpected HTTP ${s}.`, "In vet402's next purchase of this resource.");
}

// ---------- request hashes ----------

/** resourceUrl = scheme://host/path, no query, no fragment. */
export function resourceUrlOf(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}${u.pathname}`;
}

export function urlHash(resourceUrl: string): Hex {
  return sha256(stringToBytes(resourceUrl));
}

/** Canonical params: the query string with keys sorted, then the body (if any), newline separated. */
export function canonicalParams(requestUrl: string, body: string | null): string {
  const u = new URL(requestUrl);
  const q = [...u.searchParams.entries()].sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1));
  const qs = q.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return `${qs}\n${body ?? ""}`;
}

export function paramsHash(salt: Hex, canonical: string): Hex {
  return sha256(concatHex([salt, toHex(stringToBytes(canonical))]));
}

// ---------- shared assembly ----------

export interface Facts {
  dataset: string;
  row: string;
  observedAt: string;
  requestUrl: string;
  method: string | null;
  /** Request body as sent, if the run recorded it (undefined = not recorded). */
  requestBody?: string | null;
  requestTs: string | null;
  payment: Omit<Observation["payment"], "settledAt"> & { settledAt?: string | null };
  paymentSettled: boolean;
  httpStatus: number | null;
  contentType: string | null;
  bytes: number | null;
  bodyNonEmpty: boolean | null;
  receivedAt: string | null;
  declaredFormatMatched: boolean | null;
  formatMismatchDetail?: string | null;
  notRecorded: string[];
  /** Why the response was not hashed; HASH_NOT_RECORDED when absent. */
  responseHashNote?: string;
}

export interface ObserverIdentity {
  id: string;
  address: string;
}

export function assemble(f: Facts, seq: number, observer: ObserverIdentity, salt: Hex, issuedAt: number): Observation {
  const verdict = decideVerdict({
    paymentSettled: f.paymentSettled,
    httpStatus: f.httpStatus,
    bodyNonEmpty: f.bodyNonEmpty,
    declaredFormatMatched: f.declaredFormatMatched,
    formatMismatchDetail: f.formatMismatchDetail ?? null,
  });
  const resourceUrl = resourceUrlOf(f.requestUrl);
  // Params are only hashable when both the query and the body are known.
  const bodyKnown = f.requestBody !== undefined || f.method === "GET" || f.method === "HEAD";
  const params = bodyKnown ? paramsHash(salt, canonicalParams(f.requestUrl, f.requestBody ?? null)) : null;
  const notRecorded = [...f.notRecorded];
  if (!bodyKnown) notRecorded.push("request.params_hash: request body not recorded");
  const hashNote = f.responseHashNote ?? HASH_NOT_RECORDED;
  notRecorded.push(`response.responseHash: ${hashNote}`);
  const day = f.observedAt.slice(0, 10);
  return {
    type: OBSERVATION_TYPE,
    version: OBSERVATION_VERSION,
    id: `obs_${day}_${String(seq).padStart(6, "0")}`,
    observer: { id: observer.id, address: observer.address, sequence: seq },
    issuedAt,
    verdict,
    resourceUrl,
    payment: { ...f.payment, settledAt: f.payment.settledAt ?? null },
    request: { method: f.method, url_hash: urlHash(resourceUrl), params_hash: params, params_salted: params !== null, ts: f.requestTs },
    response: {
      status: f.httpStatus,
      responseHash: null,
      responseHashAlg: null,
      responseHashEncoding: null,
      responseHashNote: hashNote,
      contentType: f.contentType,
      bytes: f.bytes,
      receivedAt: f.receivedAt,
      latencyMs: null,
    },
    offer: null,
    sellerReceipt: null,
    scope: scopeFor(false),
    notRecorded,
    source: { dataset: f.dataset, row: f.row },
    contact: CONTACT,
    anchor: null,
    corrections: [],
    signature: null,
  };
}

// ---------- adapters for the three runs ----------

export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const BASE_MAINNET = "eip155:8453";
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const TEMPO_MAINNET = "eip155:4217";
export const TEMPO_USDC_E = "0x20c000000000000000000000b9537d11c60e8b50";

export interface Skip {
  dataset: string;
  row: string;
  reason: string;
}

interface CensusRow {
  requestUrl: string;
  settled: boolean;
  signature: string | null;
  httpStatus: number | null;
  first300: string | null;
  payTo: string;
  at: string;
  declared?: { mimeType: string | null; outputSchema: unknown; outputExample: unknown };
}
interface CensusRecord {
  requestUrl: string;
  outcome: string;
  probe?: { payTo?: string; amount?: string; asset?: string };
  response?: { status: number; contentType: string | null; first300: string | null };
  judgement?: { expectedKeys: string[]; missingKeys: string[]; exampleKeys: string[] };
  onChain?: { signature: string; found: boolean; confirmed: boolean; err: unknown; payToDeltaAtomic: string | null; payerDeltaAtomic: string | null } | null;
}
export interface SolanaCensus {
  kind: string;
  ranAt: string;
  payer: string;
  rows: CensusRow[];
  records: CensusRecord[];
}

export function factsFromSolanaCensus(d: SolanaCensus, dataset: string): { facts: Facts[]; skips: Skip[] } {
  const facts: Facts[] = [];
  const skips: Skip[] = [];
  d.rows.forEach((row, i) => {
    const rec = d.records[i];
    const rowId = `rows[${i}]`;
    if (!rec || rec.requestUrl !== row.requestUrl) throw new Error(`${dataset} ${rowId}: rows and records out of step`);
    const oc = rec.onChain;
    const tx = oc?.signature ?? row.signature;
    if (!tx) return skips.push({ dataset, row: rowId, reason: `no payment transaction recorded (${rec.outcome})` });
    const amount = rec.probe?.amount;
    const settled = !!(oc && oc.found && oc.confirmed && oc.err === null && oc.payToDeltaAtomic === amount && oc.payerDeltaAtomic === `-${amount}`);
    if (!settled) return skips.push({ dataset, row: rowId, reason: "payment transaction recorded but not confirmed with the expected transfer" });
    if (!amount || rec.probe?.asset !== SOLANA_USDC) throw new Error(`${dataset} ${rowId}: unexpected asset/amount`);
    const j = rec.judgement;
    const declaredKeys = j ? [...new Set([...j.expectedKeys, ...j.exampleKeys])] : [];
    const declaredFormatMatched = declaredKeys.length === 0 || !j ? null : j.missingKeys.length === 0;
    const status = rec.response?.status ?? row.httpStatus ?? null;
    const first = rec.response?.first300 ?? row.first300;
    facts.push({
      dataset,
      row: rowId,
      observedAt: row.at,
      requestUrl: row.requestUrl,
      method: "GET",
      requestTs: null,
      payment: {
        network: SOLANA_MAINNET,
        scheme: "x402-exact",
        transaction: tx,
        payer: d.payer,
        payTo: rec.probe?.payTo ?? row.payTo,
        asset: SOLANA_USDC,
        amount,
        decimals: 6,
        assetSymbol: "USDC",
      },
      paymentSettled: true,
      httpStatus: status,
      contentType: rec.response?.contentType ?? null,
      bytes: null,
      bodyNonEmpty: first === null || first === undefined ? null : first.length > 0,
      receivedAt: row.at,
      declaredFormatMatched,
      formatMismatchDetail: j && j.missingKeys.length ? `missing keys shown in the seller's outputExample: ${j.missingKeys.join(", ")}` : null,
      notRecorded: ["request.ts: only the time after the response was recorded", "response.bytes", "response.latencyMs", "payment.settledAt"],
    });
  });
  return { facts, skips };
}

interface TempoEntry {
  key: string;
  url: string;
  recipient: string;
  amount: string;
  status: string;
  reservedAt: string;
  httpStatus: number | null;
  txHash: string | null;
  settled: boolean | null;
  note?: string;
}
export interface TempoLedger {
  payer: string;
  entries: TempoEntry[];
}

export function factsFromTempoLedger(d: TempoLedger, dataset: string): { facts: Facts[]; skips: Skip[] } {
  const facts: Facts[] = [];
  const skips: Skip[] = [];
  d.entries.forEach((e, i) => {
    const rowId = `entries[${i}] ${e.key}`;
    if (e.status !== "sent") return skips.push({ dataset, row: rowId, reason: `not paid (${e.status})` });
    if (!e.txHash) return skips.push({ dataset, row: rowId, reason: `no payment transaction recorded (${e.note || "no note"})` });
    if (e.settled !== true) return skips.push({ dataset, row: rowId, reason: `payment transaction recorded but not confirmed (${e.note || "no note"})` });
    facts.push({
      dataset,
      row: rowId,
      observedAt: e.reservedAt,
      requestUrl: e.url,
      method: null,
      requestTs: e.reservedAt,
      payment: {
        network: TEMPO_MAINNET,
        scheme: "mpp-charge",
        transaction: e.txHash,
        payer: d.payer,
        payTo: e.recipient,
        asset: TEMPO_USDC_E,
        amount: e.amount,
        decimals: 6,
        assetSymbol: "USDC.e",
      },
      paymentSettled: true,
      httpStatus: e.httpStatus,
      contentType: null,
      bytes: null,
      bodyNonEmpty: null,
      receivedAt: null,
      declaredFormatMatched: null,
      notRecorded: [
        "request.method",
        "request.ts: the time recorded is when the spend was reserved, just before the request",
        "response.contentType",
        "response.bytes (so an empty body cannot be ruled out)",
        "response.receivedAt",
        "response.latencyMs",
        "payment.settledAt",
      ],
    });
  });
  return { facts, skips };
}

export interface BasePurchase {
  resource: string;
  method: string;
  at: string;
  outcome: string;
  payer: string;
  payTo: string;
  amountAtomic: string;
  response?: { status: number; contentType: string | null; bytes: number | null; first300: string | null };
  settlementTx: string | null;
  settledOnChain: boolean;
}

export function factsFromBasePurchases(rows: BasePurchase[], dataset: string): { facts: Facts[]; skips: Skip[] } {
  const facts: Facts[] = [];
  const skips: Skip[] = [];
  rows.forEach((r, i) => {
    const rowId = `line ${i + 1}`;
    if (r.outcome !== "sent") return skips.push({ dataset, row: rowId, reason: `not paid (${r.outcome})` });
    if (!r.settlementTx) return skips.push({ dataset, row: rowId, reason: "no payment transaction recorded (the seller's response carried no settlement tx)" });
    if (!r.settledOnChain) return skips.push({ dataset, row: rowId, reason: "payment transaction recorded but not confirmed on chain" });
    const bytes = r.response?.bytes ?? null;
    facts.push({
      dataset,
      row: rowId,
      observedAt: r.at,
      requestUrl: r.resource,
      method: r.method,
      requestTs: r.at,
      payment: {
        network: BASE_MAINNET,
        scheme: "x402-exact",
        transaction: r.settlementTx,
        payer: r.payer,
        payTo: r.payTo,
        asset: BASE_USDC,
        amount: r.amountAtomic,
        decimals: 6,
        assetSymbol: "USDC",
      },
      paymentSettled: true,
      httpStatus: r.response?.status ?? null,
      contentType: r.response?.contentType ?? null,
      bytes,
      bodyNonEmpty: bytes === null ? null : bytes > 0,
      receivedAt: null,
      declaredFormatMatched: null,
      notRecorded: ["response.receivedAt", "response.latencyMs", "payment.settledAt", "declared output format (not checked in this run)"],
    });
  });
  return { facts, skips };
}

// ---------- sequence across days ----------

export interface BuiltDay {
  day: string;
  /** observer.address and observer.sequence of every record already in that day's folder. */
  records: { address: string; sequence: number }[];
}

/**
 * The first sequence number for a new day: one past the observer's last record. Refuses when the day
 * was already built, when a later day was (sequences follow time), or when the observer's numbers
 * so far are not exactly 1..n.
 */
export function nextSequence(built: readonly BuiltDay[], day: string, observerAddress: string): number {
  const seqs: number[] = [];
  for (const b of built) {
    if (b.day === day) throw new Error(`${day} is already built`);
    if (b.day > day) throw new Error(`${b.day} is already built; ${day} would come after it in the sequence but is earlier`);
    for (const r of b.records) if (r.address.toLowerCase() === observerAddress.toLowerCase()) seqs.push(r.sequence);
  }
  seqs.sort((a, b) => a - b);
  seqs.forEach((s, i) => {
    if (s !== i + 1) throw new Error(`observer ${observerAddress}: sequence numbers so far are not 1..${seqs.length} (position ${i + 1} holds ${s})`);
  });
  return seqs.length + 1;
}

// ---------- remeasure (scripts/remeasure.ts, one file per chain and UTC day) ----------

/** The fields of a remeasure result row a record is built from (src/remeasure/results.ts). */
export interface RemeasureRowIn {
  at: string;
  chain: string;
  url: string;
  requestUrl: string;
  payTo: string | null;
  expectedPayTo: string;
  outcome: string;
  reason: string;
  settled: boolean | null;
  delivered: boolean | null;
  httpStatus: number | null;
  bodyBytes: number | null;
  tx: string | null;
  priceUsdc: string | null;
  key: string;
  /** Present in the file; never read here (it can hold what the seller sent back). */
  detail?: unknown;
}
export interface RemeasureFile {
  kind: string;
  version: number;
  chain: string;
  date: string;
  payer: string;
  rows: RemeasureRowIn[];
}

/**
 * What the spend ledger holds for one purchase key, written before the payment was signed:
 *  Solana: results/remeasure/budget-solana-YYYY-MM.json purchases[] { key, amount, at }
 *  Tempo:  results/remeasure/tempo-ledger-YYYY-MM-DD.json entries[] { key, amount, recipient, reservedAt as at, status, txHash, settled }
 */
export interface RemeasureSpend {
  key: string;
  amount: string;
  at: string;
  recipient?: string;
  status?: string;
  txHash?: string | null;
  settled?: boolean | null;
}

export const HASH_NOT_RECORDED_REMEASURE = "hash not recorded (the daily remeasure run does not hash the response)";

/** The Tempo payOne reads at most 5 MiB of a paid answer; a length near that is only a lower bound. */
export const TEMPO_BODY_READ_CAP = 5 * 1024 * 1024;

function usdc6(atomic: string): string {
  const v = BigInt(atomic);
  return `${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, "0")}`;
}

/**
 * Records from one remeasure result file. A row becomes a record only when the run sent the payment,
 * read the transfer back on chain (settled = true) and recorded the tx, and the spend ledger written
 * before signing agrees on the key and amount (Tempo: also the recipient, the tx and settled). Any
 * disagreement throws.
 *
 * Verdict inputs follow the ranking's remeasure rules (src/remeasure/normalize.ts), so a record and the
 * ranking never disagree:
 *  Solana: payOne judged the body (delivered = 2xx and a body that is not blank); 2xx and not delivered
 *          is an empty body.
 *  Tempo:  the length of the answer was recorded; 0 is an empty body, null is not recorded.
 * The row's `detail` (the start of what the seller sent back) is never read.
 */
export function factsFromRemeasure(d: RemeasureFile, dataset: string, spends: readonly RemeasureSpend[]): { facts: Facts[]; skips: Skip[] } {
  if (d.kind !== "vet402-remeasure" || d.version !== 1 || !Array.isArray(d.rows)) throw new Error(`${dataset}: not a vet402-remeasure result file`);
  if (d.chain !== "solana" && d.chain !== "tempo") throw new Error(`${dataset}: unknown chain ${String(d.chain)}`);
  const tempo = d.chain === "tempo";
  const byKey = new Map<string, RemeasureSpend>();
  for (const s of spends) {
    if (byKey.has(s.key)) throw new Error(`${dataset}: spend ledger has key ${s.key} twice`);
    byKey.set(s.key, s);
  }
  const facts: Facts[] = [];
  const skips: Skip[] = [];
  d.rows.forEach((r, i) => {
    const rowId = `rows[${i}]`;
    const where = `${dataset} ${rowId}`;
    if (r.chain !== d.chain) throw new Error(`${where}: chain ${r.chain} in a ${d.chain} file`);
    if (typeof r.at !== "string" || r.at.slice(0, 10) !== d.date) throw new Error(`${where}: at ${r.at} is not on ${d.date}`);
    if (r.outcome !== "sent") return skips.push({ dataset, row: rowId, reason: `not paid (${r.outcome}: ${r.reason})` });
    if (r.settled !== true) return skips.push({ dataset, row: rowId, reason: `payment not confirmed on chain (settled ${String(r.settled)})` });
    if (!r.tx) return skips.push({ dataset, row: rowId, reason: "no payment transaction recorded" });
    const s = byKey.get(r.key);
    if (!s) throw new Error(`${where}: no spend ledger entry for ${r.key}`);
    if (!/^\d+$/.test(s.amount) || /^0+$/.test(s.amount)) throw new Error(`${where}: ledger amount ${s.amount}`);
    if (r.priceUsdc !== usdc6(s.amount)) throw new Error(`${where}: price ${r.priceUsdc} differs from the ledger amount ${s.amount}`);
    const norm = (a: string) => (tempo ? a.toLowerCase() : a);
    if (!r.payTo || norm(r.payTo) !== norm(r.expectedPayTo)) throw new Error(`${where}: paid ${r.payTo}, locked ${r.expectedPayTo}`);
    if (typeof s.at !== "string" || Number.isNaN(Date.parse(s.at))) throw new Error(`${where}: ledger time ${String(s.at)}`);
    if (tempo) {
      if (s.status !== "sent" || s.settled !== true || !s.txHash || s.txHash.toLowerCase() !== r.tx.toLowerCase())
        throw new Error(`${where}: the day ledger does not show this tx settled (${String(s.status)}, ${String(s.settled)}, ${String(s.txHash)})`);
      if (!s.recipient || s.recipient.toLowerCase() !== r.payTo.toLowerCase()) throw new Error(`${where}: ledger recipient ${String(s.recipient)} is not ${r.payTo}`);
    }
    const is2xx = r.httpStatus !== null && r.httpStatus >= 200 && r.httpStatus <= 299;
    let bodyNonEmpty: boolean | null;
    let bytes: number | null = null;
    if (tempo) {
      bytes = r.bodyBytes !== null && r.bodyBytes < TEMPO_BODY_READ_CAP - 65_536 ? r.bodyBytes : null;
      bodyNonEmpty = r.bodyBytes === null ? null : r.bodyBytes > 0;
    } else {
      bodyNonEmpty = r.delivered === true ? true : is2xx ? false : null;
    }
    const notRecorded = [
      ...(tempo ? ["request.method"] : []),
      "request.ts: the time recorded is when the spend was reserved, just before the paid request",
      "response.contentType",
      ...(bytes === null ? [tempo ? "response.bytes (so an empty body cannot be ruled out)" : "response.bytes"] : []),
      "response.receivedAt",
      "response.latencyMs",
      "payment.settledAt",
      "declared output format (not checked in this run)",
    ];
    facts.push({
      dataset,
      row: rowId,
      observedAt: r.at,
      requestUrl: r.requestUrl,
      method: tempo ? null : "GET",
      requestTs: s.at,
      payment: tempo
        ? { network: TEMPO_MAINNET, scheme: "mpp-charge", transaction: r.tx, payer: d.payer, payTo: s.recipient!, asset: TEMPO_USDC_E, amount: s.amount, decimals: 6, assetSymbol: "USDC.e" }
        : { network: SOLANA_MAINNET, scheme: "x402-exact", transaction: r.tx, payer: d.payer, payTo: r.payTo, asset: SOLANA_USDC, amount: s.amount, decimals: 6, assetSymbol: "USDC" },
      paymentSettled: true,
      httpStatus: r.httpStatus,
      contentType: null,
      bytes,
      bodyNonEmpty,
      receivedAt: null,
      declaredFormatMatched: null,
      notRecorded,
      responseHashNote: HASH_NOT_RECORDED_REMEASURE,
    });
  });
  return { facts, skips };
}
