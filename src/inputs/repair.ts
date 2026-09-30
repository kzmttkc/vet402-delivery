/**
 * Build the request vet402 sends from the seller's spec and src/inputs/values.ts, before anything is paid.
 * Pure: no network, no files. Money is not touched here: the repaired request goes into the same payment
 * functions (src/pay.ts payOne, src/tempo/pay.ts payOne), which read the live 402 for it as before.
 *
 *   repairTempoRequest   a Tempo planned request (query or JSON body)
 *   repairSolanaUrl      a Solana GET request URL (query only)
 *   repairTargets        remeasure targets, with the input book (src/inputs/book.ts)
 */
import type { PlannedRequest } from "../tempo/mercator.js";
import type { Target } from "../remeasure/targets.js";
import { fillParams, type FillFailure, type FilledParam } from "./fill.js";
import type { EndpointSpec } from "./spec.js";
import { bookKey, type InputBook } from "./book.js";

export type Repair<T> = { ok: true; changed: boolean; value: T; filled: FilledParam[] } | { ok: false; reason: FillFailure; param: string | null };

/** A path segment the catalog left as a pattern or a note ("/v2/*", "/<id>", "/{id}"). */
function pathPlaceholder(pathname: string): boolean {
  return pathname.split("/").some((s) => {
    let d = s;
    try {
      d = decodeURIComponent(s);
    } catch {
      /* keep raw */
    }
    return d.includes("*") || /^<[^<>]+>$/.test(d) || /^\{[^{}]+\}$/.test(d);
  });
}

function queryParams(u: URL): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of u.searchParams) {
    let val: unknown = v;
    if (/^[[{]/.test(v)) {
      try {
        val = JSON.parse(v);
      } catch {
        val = v;
      }
    }
    out[k] = val;
  }
  return out;
}

const asQuery = (v: unknown) => (typeof v === "object" && v !== null ? JSON.stringify(v) : String(v));

/** A Tempo request, query or JSON body. A body that is not a JSON object is left as it is. */
export function repairTempoRequest(req: PlannedRequest, spec: EndpointSpec | null, today: string): Repair<PlannedRequest> {
  const u = new URL(req.url);
  if (pathPlaceholder(u.pathname)) return { ok: false, reason: "path_placeholder", param: "(path)" };
  let body: Record<string, unknown> | null = null;
  if (req.body !== null && req.body !== "") {
    try {
      const b = JSON.parse(req.body) as unknown;
      if (b && typeof b === "object" && !Array.isArray(b)) body = b as Record<string, unknown>;
    } catch {
      body = null;
    }
    if (body === null) return { ok: true, changed: false, value: req, filled: [] };
  }
  const q = queryParams(u);
  const inBody = req.body !== null;
  const r = fillParams(inBody ? { ...q, ...body } : q, spec, today, u.pathname);
  if (!r.ok) return r;
  if (r.filled.length === 0) return { ok: true, changed: false, value: req, filled: [] };
  const next = new URL(u.toString());
  let nextBody = req.body;
  const setQuery = (u2: URL, name: string) => (name in r.params ? u2.searchParams.set(name, asQuery(r.params[name])) : u2.searchParams.delete(name));
  if (inBody) {
    const b: Record<string, unknown> = { ...body };
    for (const f of r.filled) {
      if (f.param in q) setQuery(next, f.param);
      else if (f.param in r.params) b[f.param] = r.params[f.param];
      else delete b[f.param];
    }
    nextBody = JSON.stringify(b);
  } else {
    for (const f of r.filled) setQuery(next, f.param);
  }
  return {
    ok: true,
    changed: true,
    value: { ...req, url: next.toString(), body: nextBody, contentType: nextBody === null ? req.contentType : "application/json", inputSource: "vet402_filled" },
    filled: r.filled,
  };
}

/** A Solana GET request URL (query only; the census never sends a body on Solana). */
export function repairSolanaUrl(url: string, spec: EndpointSpec | null, today: string): Repair<string> {
  const u = new URL(url);
  if (pathPlaceholder(u.pathname)) return { ok: false, reason: "path_placeholder", param: "(path)" };
  if (spec && spec.method !== "GET") return { ok: true, changed: false, value: url, filled: [] };
  const querySpec = spec ? { ...spec, params: spec.params.filter((p) => p.in === "query") } : null;
  const r = fillParams(queryParams(u), querySpec, today, u.pathname);
  if (!r.ok) return r;
  if (r.filled.length === 0) return { ok: true, changed: false, value: url, filled: [] };
  for (const f of r.filled) {
    if (f.param in r.params) u.searchParams.set(f.param, asQuery(r.params[f.param]));
    else u.searchParams.delete(f.param);
  }
  return { ok: true, changed: true, value: u.toString(), filled: r.filled };
}

/** The HTTP statuses of an earlier paid answer that point at the request: vet402 does not send that request again. */
const INPUT_STATUSES = new Set([400, 404, 422]);

export interface RepairLine {
  chain: Target["chain"];
  url: string;
  service: string | null;
  /** changed: the request was filled; unchanged: nothing to fill; skipped: cannot be filled and not bought; kept: cannot be filled, bought as before. */
  result: "changed" | "unchanged" | "skipped" | "kept";
  from: string | null;
  to: string | null;
  filled: FilledParam[];
  reason: FillFailure | null;
  param: string | null;
  /** The book's source of the spec, or null when the book has no entry for this target. */
  specSource: string | null;
}

/**
 * Apply the book to remeasure targets. A target the book does not list is not touched. A target that cannot be
 * filled is dropped (not bought) when it sends a message to someone or commits to a purchase, or when its earlier
 * paid answer was 400, 404 or 422; otherwise it is bought as before (the seller answered that request once). The
 * payTo, the price lock and the catalog URL (`url`) never change; `requestUrl` and the Tempo request follow the
 * repaired request.
 */
export function repairTargets(targets: readonly Target[], book: InputBook, today: string): { targets: Target[]; lines: RepairLine[] } {
  const out: Target[] = [];
  const lines: RepairLine[] = [];
  for (const t of targets) {
    const entry = book.entries.find((e) => bookKey(e) === bookKey({ chain: t.chain, service: t.service, url: t.url }));
    if (!entry) {
      out.push(t);
      continue;
    }
    const base = { chain: t.chain, url: t.url, service: t.service, specSource: entry.spec?.source ?? null };
    if (t.chain === "tempo" && t.tempo) {
      const req = t.tempo.plan.request;
      const r = repairTempoRequest(req, entry.spec, today);
      if (!r.ok) {
        const skip = r.reason === "sends_message" || r.reason === "commits_to_purchase" || (entry.lastStatus !== null && INPUT_STATUSES.has(entry.lastStatus));
        lines.push({ ...base, result: skip ? "skipped" : "kept", from: req.url, to: null, filled: [], reason: r.reason, param: r.param });
        if (!skip) out.push(t);
        continue;
      }
      lines.push({ ...base, result: r.changed ? "changed" : "unchanged", from: req.url + (req.body ? ` ${req.body}` : ""), to: r.changed ? r.value.url + (r.value.body ? ` ${r.value.body}` : "") : null, filled: r.filled, reason: null, param: null });
      out.push(r.changed ? { ...t, requestUrl: r.value.url, tempo: { ...t.tempo, plan: { ...t.tempo.plan, request: r.value } } } : t);
      continue;
    }
    const r = repairSolanaUrl(t.requestUrl, entry.spec, today);
    if (!r.ok) {
      const skip = r.reason === "sends_message" || r.reason === "commits_to_purchase" || (entry.lastStatus !== null && INPUT_STATUSES.has(entry.lastStatus));
      lines.push({ ...base, result: skip ? "skipped" : "kept", from: t.requestUrl, to: null, filled: [], reason: r.reason, param: r.param });
      if (!skip) out.push(t);
      continue;
    }
    lines.push({ ...base, result: r.changed ? "changed" : "unchanged", from: t.requestUrl, to: r.changed ? r.value : null, filled: r.filled, reason: null, param: null });
    out.push(r.changed ? { ...t, requestUrl: r.value } : t);
  }
  return { targets: out, lines };
}
