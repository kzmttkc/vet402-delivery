/**
 * Turn each chain runner's result file into Attempt rows.
 *
 * Fail loud: an unknown reason string or a missing field throws, so a new failure mode in a runner
 * cannot be silently counted as "delivered" or dropped.
 */
import { TRIED_CATEGORIES, type Attempt, type Chain, type DeliveryCheck, type ReasonCategory } from "./types.js";

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function obj(v: unknown, where: string): Obj {
  if (!isObj(v)) throw new Error(`${where}: expected an object`);
  return v;
}
function arr(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${where}: expected an array`);
  return v;
}
function str(o: Obj, k: string, where: string): string {
  const v = o[k];
  if (typeof v !== "string" || v.length === 0) throw new Error(`${where}.${k}: expected a non-empty string`);
  return v;
}
function optStr(o: Obj, k: string): string | null {
  const v = o[k];
  return typeof v === "string" && v.length > 0 ? v : null;
}
function bool(o: Obj, k: string, where: string): boolean {
  const v = o[k];
  if (typeof v !== "boolean") throw new Error(`${where}.${k}: expected a boolean`);
  return v;
}
function optBool(o: Obj, k: string): boolean | null {
  const v = o[k];
  return typeof v === "boolean" ? v : null;
}
function optNum(o: Obj, k: string): number | null {
  const v = o[k];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

function is2xx(status: number | null): boolean {
  return status !== null && status >= 200 && status <= 299;
}

function cut(v: string | null): string | null {
  return v === null ? null : v.length > 200 ? `${v.slice(0, 200)}…` : v;
}

function make(
  base: Omit<Attempt, "tried" | "expectedPayTo" | "feedbackTx" | "service" | "detail"> &
    Partial<Pick<Attempt, "expectedPayTo" | "feedbackTx" | "service" | "detail">>,
): Attempt {
  return {
    service: null,
    expectedPayTo: null,
    feedbackTx: null,
    ...base,
    detail: cut(base.detail ?? null),
    tried: TRIED_CATEGORIES.has(base.category),
  };
}

// Raw "not paid" reasons shared by the runners, mapped once.
const NOT_PAYABLE = new Set([
  "not_x402",
  "no_supported_accept",
  "requirements_body_only",
  "no_solana_accept",
  "no_accept",
  "rate_limited",
  "probe_error",
]);
const VET402_SKIPPED = new Set([
  "price_over_cap",
  "placeholder_unfillable",
  "invalid_target",
  "path_params",
  "own_address",
  "bad_url",
  "method_not_probed",
  "already_bought",
  "over_budget",
]);

function unpaidCategory(raw: string, where: string): ReasonCategory {
  if (NOT_PAYABLE.has(raw)) return "not_payable";
  if (VET402_SKIPPED.has(raw)) return "vet402_skipped";
  if (raw === "recipient_mismatch" || raw === "payto_mismatch") return "payto_changed";
  throw new Error(`${where}: unknown refusal reason "${raw}"`);
}

// ---------- Algorand (vet402-algorand board/census-*.json) ----------

export function normalizeAlgorand(json: unknown, source: string): Attempt[] {
  const root = obj(json, source);
  if (root.mode !== "census") throw new Error(`${source}: expected mode "census"`);
  return arr(root.rows, `${source}.rows`).map((r, i) => {
    const where = `${source}.rows[${i}]`;
    const row = obj(r, where);
    const verdict = str(row, "verdict", where);
    const reason = str(row, "reason", where);
    const paid = bool(row, "paid", where);
    let category: ReasonCategory;
    if (verdict === "ALLOW") {
      if (!paid || reason !== "delivered") throw new Error(`${where}: ALLOW without a paid delivery`);
      category = "delivered";
    } else if (verdict === "REFUSE" && paid) {
      if (reason === "delivery_missing_keys" || reason === "not_json") category = "settled_bad_content";
      else if (reason === "http_error") category = "settled_error_status";
      else throw new Error(`${where}: unknown paid refusal "${reason}"`);
    } else if (verdict === "REFUSE" || verdict === "UNCLEAR") {
      category = reason === "payment_failed" ? "not_settled" : unpaidCategory(reason, where);
    } else {
      throw new Error(`${where}: unknown verdict "${verdict}"`);
    }
    return make({
      chain: "algorand",
      source,
      host: str(row, "host", where).toLowerCase(),
      url: str(row, "url", where),
      payTo: optStr(row, "payTo"),
      at: str(row, "at", where),
      settled: paid ? true : reason === "payment_failed" ? false : null,
      delivered: category === "delivered",
      category,
      rawReason: reason,
      detail: optStr(row, "detail") ?? optStr(row, "delivery"),
      tx: optStr(row, "tx"),
      priceUsdc: optStr(row, "priceUsdc"),
      deliveryCheck: "declared_keys",
    });
  });
}

// ---------- Solana census (vet402-solana-census results/census-*.json) ----------

export function normalizeSolanaCensus(json: unknown, source: string): Attempt[] {
  const root = obj(json, source);
  if (root.kind !== "census-live") throw new Error(`${source}: expected kind "census-live"`);
  return arr(root.rows, `${source}.rows`).map((r, i) => {
    const where = `${source}.rows[${i}]`;
    const row = obj(r, where);
    const status = str(row, "status", where);
    const cat = optStr(row, "category");
    const reason = str(row, "reason", where);
    const settled = bool(row, "settled", where);
    const delivered = bool(row, "delivered", where);
    let category: ReasonCategory;
    if (status === "delivered") {
      if (!settled || !delivered) throw new Error(`${where}: delivered without settlement`);
      category = "delivered";
    } else if (status === "not_settled") {
      if (settled) throw new Error(`${where}: not_settled but settled=true`);
      category = "not_settled";
    } else if (status === "settled_not_delivered") {
      category = cat === "missing_keys" ? "settled_bad_content" : "settled_error_status";
    } else if (status === "refused") {
      category = unpaidCategory(cat ?? reason, where);
    } else {
      throw new Error(`${where}: unknown status "${status}"`);
    }
    return make({
      chain: "solana",
      source,
      host: str(row, "host", where).toLowerCase(),
      url: str(row, "url", where),
      payTo: optStr(row, "payTo"),
      at: str(row, "at", where),
      settled: status === "refused" ? null : settled,
      delivered: category === "delivered",
      category,
      rawReason: cat ? `${reason}/${cat}` : reason,
      detail: optStr(row, "detail"),
      tx: optStr(row, "signature"),
      priceUsdc: optStr(row, "priceUsdc"),
      deliveryCheck: "declared_keys",
    });
  });
}

// ---------- Solana gate1 (vet402-solana results/gate1-*.json) ----------

export function normalizeSolanaGate1(json: unknown, source: string): Attempt[] {
  const root = obj(json, source);
  if (root.kind !== "gate1-live") throw new Error(`${source}: expected kind "gate1-live"`);
  const ranAt = str(root, "ranAt", source);
  return arr(root.records, `${source}.records`).map((r, i) => {
    const where = `${source}.records[${i}]`;
    const rec = obj(r, where);
    const outcome = str(rec, "outcome", where);
    const probe = isObj(rec.probe) ? rec.probe : {};
    const url = str(rec, "requestUrl", where);
    let category: ReasonCategory;
    let settled: boolean | null = null;
    let rawReason: string;
    let detail: string | null = null;
    if (outcome === "refused") {
      const refusal = obj(rec.refusal, `${where}.refusal`);
      rawReason = str(refusal, "refused", `${where}.refusal`);
      detail = optStr(refusal, "detail");
      category = unpaidCategory(rawReason, where);
    } else if (outcome === "sent") {
      detail = isObj(rec.response) ? optStr(rec.response, "first300") : null;
      settled = bool(rec, "settled", where);
      const delivered = bool(rec, "delivered", where);
      const status = isObj(rec.response) ? optNum(rec.response, "status") : null;
      if (settled && delivered) category = "delivered";
      else if (!settled) category = "not_settled";
      else category = is2xx(status) ? "settled_bad_content" : "settled_error_status";
      rawReason = `sent/http ${status ?? "?"}`;
    } else {
      throw new Error(`${where}: unknown outcome "${outcome}"`);
    }
    return make({
      chain: "solana",
      source,
      host: str(rec, "host", where).toLowerCase(),
      url,
      payTo: optStr(probe, "payTo"),
      at: ranAt,
      settled,
      delivered: category === "delivered",
      category,
      rawReason,
      detail,
      tx: optStr(rec, "signature"),
      priceUsdc: optStr(rec, "priceUsdc"),
      deliveryCheck: "http_2xx",
    });
  });
}

// ---------- Tempo (vet402-solana-tempo results/tempo-ledger.json + tempo-run.log) ----------

export function normalizeTempoLedger(json: unknown, source: string): Attempt[] {
  const root = obj(json, source);
  return arr(root.entries, `${source}.entries`).map((e, i) => {
    const where = `${source}.entries[${i}]`;
    const en = obj(e, where);
    const status = str(en, "status", where);
    if (status !== "sent") throw new Error(`${where}: unknown ledger status "${status}"`);
    const settled = optBool(en, "settled");
    const delivered = en.delivered === true;
    const http = optNum(en, "httpStatus");
    let category: ReasonCategory;
    if (settled === true && delivered) category = "delivered";
    else if (settled === true) category = is2xx(http) ? "settled_bad_content" : "settled_error_status";
    else if (settled === false) category = "not_settled";
    else category = "unconfirmed_server_error";
    const url = str(en, "url", where);
    return make({
      chain: "tempo",
      source,
      host: hostOf(url),
      service: str(en, "key", where),
      url,
      payTo: optStr(en, "recipient"),
      at: str(en, "reservedAt", where),
      settled,
      delivered: category === "delivered",
      category,
      rawReason: `http ${http ?? "?"}`,
      detail: optStr(en, "note"),
      tx: optStr(en, "txHash"),
      priceUsdc: atomicToUsdc(optStr(en, "amount")),
      deliveryCheck: "http_2xx",
    });
  });
}

const TEMPO_REFUSAL = /^(\S+)\s+refused\s+(\S+)(?:\s+\((.*)\))?\s*$/;
const TEMPO_MISMATCH = /recipient\s+(0x[0-9a-fA-F]{40})\s*!=\s*recorded\s+(0x[0-9a-fA-F]{40})/;

/**
 * The run log is the only place the Tempo runner records refusals (they never reach the ledger).
 * Only refusals become rows here; "sent" lines duplicate the ledger and are ignored.
 * `urlByService` comes from the census plan; `at` is when the log was written (the log has no clock).
 */
export function parseTempoRunLog(text: string, urlByService: ReadonlyMap<string, string>, at: string, source: string): Attempt[] {
  const out: Attempt[] = [];
  for (const [i, line] of text.split("\n").entries()) {
    const m = TEMPO_REFUSAL.exec(line.trim());
    if (!m) continue;
    const service = m[1]!;
    const raw = m[2]!;
    const where = `${source}:${i + 1}`;
    const category = unpaidCategory(raw, where);
    if (raw === "already_bought") continue; // the ledger already holds that purchase
    const url = urlByService.get(service);
    if (!url) throw new Error(`${where}: no URL for service "${service}" in the census plan`);
    const mm = TEMPO_MISMATCH.exec(m[3] ?? "");
    out.push(
      make({
        chain: "tempo",
        source,
        host: hostOf(url),
        service,
        url,
        payTo: mm ? mm[1]!.toLowerCase() : null,
        expectedPayTo: mm ? mm[2]!.toLowerCase() : null,
        at,
        settled: null,
        delivered: false,
        category,
        rawReason: raw,
        detail: m[3] ?? null,
        tx: null,
        priceUsdc: null,
        deliveryCheck: "http_2xx",
      }),
    );
  }
  return out;
}

/** serviceId -> request URL from the Tempo census plan (tempo-census-*.dry-run.json). */
export function tempoPlanUrls(json: unknown, source: string): Map<string, string> {
  const root = obj(json, source);
  const m = new Map<string, string>();
  for (const [i, p] of arr(root.plan, `${source}.plan`).entries()) {
    const where = `${source}.plan[${i}]`;
    const pe = obj(p, where);
    m.set(str(pe, "serviceId", where), str(obj(pe.request, `${where}.request`), "url", `${where}.request`));
  }
  return m;
}

/** serviceId -> Mercator best rank (1 = first) from the Tempo census plan. */
export function mercatorBestRanks(json: unknown, source: string): Map<string, number> {
  const root = obj(json, source);
  const m = new Map<string, number>();
  for (const [i, r] of arr(root.rows, `${source}.rows`).entries()) {
    const row = obj(r, `${source}.rows[${i}]`);
    const id = optStr(row, "serviceId");
    const rank = isObj(row.rank) ? optNum(row.rank, "bestRank") : null;
    if (id && rank !== null) m.set(id, rank);
  }
  return m;
}

// ---------- Base (vet402-solana-base results/base-purchases.jsonl + base-feedback-ledger.json) ----------

export function normalizeBase(jsonl: string, feedbackLedger: unknown, source: string): Attempt[] {
  const fb = isObj(feedbackLedger) ? feedbackLedger : {};
  const out: Attempt[] = [];
  for (const [i, line] of jsonl.split("\n").entries()) {
    if (line.trim() === "") continue;
    const where = `${source}:${i + 1}`;
    const rec = obj(JSON.parse(line), where);
    const outcome = str(rec, "outcome", where);
    const url = str(rec, "resource", where);
    let category: ReasonCategory;
    let settled: boolean | null = null;
    let rawReason: string;
    let detail: string | null = optStr(rec, "settlementCheck");
    const status = isObj(rec.response) ? optNum(rec.response, "status") : null;
    if (outcome === "sent") {
      settled = bool(rec, "settledOnChain", where);
      const delivered = bool(rec, "delivered", where);
      if (settled && delivered) category = "delivered";
      else if (!settled) category = "not_settled";
      else category = is2xx(status) ? "settled_bad_content" : "settled_error_status";
      rawReason = `sent/http ${status ?? "?"}`;
    } else if (outcome === "refused") {
      rawReason = str(rec, "reason", where);
      detail = optStr(rec, "detail");
      category = unpaidCategory(rawReason, where);
    } else {
      throw new Error(`${where}: unknown outcome "${outcome}"`);
    }
    const tx = optStr(rec, "settlementTx");
    const fbEntry = tx && isObj(fb[tx]) ? (fb[tx] as Obj) : null;
    out.push(
      make({
        chain: "base",
        source,
        host: hostOf(url),
        url,
        payTo: optStr(rec, "payTo"),
        at: str(rec, "at", where),
        settled,
        delivered: category === "delivered",
        category,
        rawReason,
        detail,
        tx,
        priceUsdc: optStr(rec, "priceUsdc"),
        deliveryCheck: "http_2xx",
        feedbackTx: fbEntry ? optStr(fbEntry, "feedbackTx") : null,
      }),
    );
  }
  return out;
}

function atomicToUsdc(atomic: string | null): string | null {
  if (atomic === null || !/^\d+$/.test(atomic)) return null;
  const s = atomic.padStart(7, "0");
  return `${s.slice(0, -6)}.${s.slice(-6)}`;
}

export const CHAINS: readonly Chain[] = ["algorand", "solana", "tempo", "base"];
export type { DeliveryCheck };
