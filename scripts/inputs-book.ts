/**
 * Write src/inputs/book.json: for each remeasure target whose request needs a look, what the seller says the
 * endpoint takes. Read-only: GET requests to public catalogs (Mercator, CDP Bazaar, PayAI) and to the seller's own
 * /openapi.json. No wallet, no signing, no paid request.
 *
 *   npx tsx scripts/inputs-book.ts                 # writes src/inputs/book.json
 *   npx tsx scripts/inputs-book.ts --out <file>
 *
 * A target needs a look when its request carries a placeholder, or when its latest paid answer (census, gate1,
 * Tempo ledger, or the newest remeasure row in data/remeasure/) was 400, 404 or 422.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CDP_DISCOVERY, PAYAI_DISCOVERY } from "../src/constants.js";
import { fetchCatalog, normUrl, type Listing } from "../src/discovery.js";
import { MERCATOR_ORIGIN, USER_AGENT } from "../src/tempo/constants.js";
import { solanaFromCensus, solanaFromGate1, tempoFromLedger, type Target } from "../src/remeasure/targets.js";
import { containsPlaceholder } from "../src/inputs/fill.js";
import { fromBazaar, fromMercator, fromOpenApi, type EndpointSpec } from "../src/inputs/spec.js";
import { bookKey, type BookEntry, type InputBook } from "../src/inputs/book.js";

const ROOT = resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = outIdx >= 0 ? resolve(args[outIdx + 1]!) : join(ROOT, "src", "inputs", "book.json");
const DATA = join(ROOT, "data");
const INPUT_STATUSES = new Set([400, 404, 422]);

type Obj = Record<string, unknown>;
const manifest = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8")) as { files: { label: string; path: string; sha256: string }[] };
function read(label: string): unknown {
  const e = manifest.files.find((f) => f.label === label);
  if (!e) throw new Error(`data/manifest.json has no ${label}`);
  const text = readFileSync(join(DATA, e.path), "utf8");
  if (createHash("sha256").update(text).digest("hex") !== e.sha256) throw new Error(`${e.path}: sha256 differs from the manifest`);
  return JSON.parse(text);
}
const labels = (re: RegExp) => manifest.files.map((f) => f.label).filter((l) => re.test(l)).sort();

// ---------- targets and the status of their latest paid answer ----------

const targets: Target[] = [];
const lastStatus = new Map<string, number | null>();
const setStatus = (k: string, s: unknown) => lastStatus.set(k, typeof s === "number" ? s : null);

for (const l of labels(/^solana\/census-\d{4}-\d{2}-\d{2}$/)) {
  const j = read(l) as { rows: Obj[] };
  const ts = solanaFromCensus(j, l);
  targets.push(...ts);
  for (const r of j.rows) if (r.settled === true) setStatus(bookKey({ chain: "solana", service: null, url: String(r.url) }), r.httpStatus);
}
for (const l of labels(/^solana\/gate1-\d{4}-\d{2}-\d{2}$/)) {
  const j = read(l) as { records: Obj[] };
  targets.push(...solanaFromGate1(j, l));
  for (const r of j.records) if (r.settled === true) setStatus(bookKey({ chain: "solana", service: null, url: String(r.requestUrl) }), (r.response as Obj | undefined)?.status);
}
const ledger = read("tempo/ledger") as { entries: Obj[] };
const plans = labels(/^tempo\/census-plan-\d{4}-\d{2}-\d{2}$/).flatMap((l) => (read(l) as { plan: unknown[] }).plan);
targets.push(...tempoFromLedger(ledger, { plan: plans }, "tempo/ledger"));
for (const e of ledger.entries) if (e.settled === true) setStatus(bookKey({ chain: "tempo", service: String(e.key), url: String(e.url) }), e.httpStatus);
// The newest remeasure row of a target, when there is one, is its latest paid answer.
for (const l of labels(/^remeasure\/(solana|tempo)-\d{4}-\d{2}-\d{2}$/)) {
  for (const r of (read(l) as { rows: Obj[] }).rows) {
    if (r.outcome !== "sent") continue;
    setStatus(bookKey({ chain: String(r.chain), service: (r.service as string | null) ?? null, url: String(r.url) }), r.httpStatus);
  }
}

function requestParams(t: Target): Obj {
  const out: Obj = {};
  const u = new URL(t.chain === "tempo" ? t.tempo!.plan.request.url : t.requestUrl);
  for (const [k, v] of u.searchParams) out[k] = v;
  const body = t.tempo?.plan.request.body;
  if (body) {
    try {
      const b = JSON.parse(body) as unknown;
      if (b && typeof b === "object" && !Array.isArray(b)) Object.assign(out, b);
    } catch {
      /* not JSON */
    }
  }
  return out;
}

const seen = new Set<string>();
const need = targets.filter((t) => {
  const k = bookKey(t);
  if (seen.has(k)) return false;
  seen.add(k);
  const s = lastStatus.get(k) ?? null;
  return Object.values(requestParams(t)).some(containsPlaceholder) || (s !== null && INPUT_STATUSES.has(s));
});

// ---------- specs ----------

async function getJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers: { accept: "application/json", "user-agent": USER_AGENT }, redirect: "follow", signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  }
}

const PATH_PARAM = /\{[^}]+\}|:[A-Za-z0-9_]+/g;
async function tempoSpec(t: Target, looked: string[]): Promise<EndpointSpec | null> {
  const url = `${MERCATOR_ORIGIN}/v1/services/${encodeURIComponent(t.service!)}`;
  looked.push(url);
  const d = (await getJson(url)) as { service?: { serviceUrl: string; endpoints: { method: string; path: string }[] } } | null;
  const s = d?.service;
  if (!s) return null;
  const req = t.tempo!.plan.request;
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  for (const ep of s.endpoints) {
    if (ep.method.toUpperCase() !== req.method.toUpperCase()) continue;
    const full = new URL(s.serviceUrl.replace(/\/+$/, "") + ep.path.replace(PATH_PARAM, "__P__")).pathname.replace(/\/+$/, "");
    const re = new RegExp(`^${full.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/__P__/g, "[^/]+")}$`);
    if (re.test(path)) return fromMercator(ep, `mercator:/v1/services/${t.service}`);
  }
  return null;
}

let catalogs: { name: string; byUrl: Map<string, Listing> }[] | null = null;
async function solanaSpec(t: Target, looked: string[]): Promise<EndpointSpec | null> {
  if (!catalogs) {
    catalogs = [];
    for (const [name, url] of [["cdp-bazaar", CDP_DISCOVERY], ["payai", PAYAI_DISCOVERY]] as const) {
      const c = await fetchCatalog(url, { pageLimit: 1000, sleepMs: 200 });
      const byUrl = new Map<string, Listing>();
      for (const l of c.items) byUrl.set(normUrl(String(l.resource ?? "")), l);
      catalogs.push({ name, byUrl });
      console.log(`${name}: ${c.items.length} listings${c.complete ? "" : " (incomplete)"}`);
    }
  }
  for (const c of catalogs) {
    looked.push(`${c.name}:${normUrl(t.url)}`);
    const l = c.byUrl.get(normUrl(t.url));
    const spec = l ? fromBazaar(l as unknown as Obj, `${c.name}:${normUrl(t.url)}`) : null;
    if (spec && spec.params.length > 0) return spec;
  }
  const u = new URL(t.url);
  const oa = `${u.origin}/openapi.json`;
  looked.push(oa);
  const doc = await getJson(oa);
  if (doc && typeof doc === "object") return fromOpenApi(doc as Obj, "GET", u.pathname, `seller-openapi:${oa}`);
  return null;
}

const entries: BookEntry[] = [];
for (const t of need) {
  const looked: string[] = [];
  const spec = t.chain === "tempo" ? await tempoSpec(t, looked) : await solanaSpec(t, looked);
  entries.push({ chain: t.chain, service: t.service, url: t.url, lastStatus: lastStatus.get(bookKey(t)) ?? null, spec, looked });
  console.log(`${t.chain.padEnd(6)} ${(t.service ?? t.host).padEnd(34)} last ${String(lastStatus.get(bookKey(t)) ?? "-").padEnd(4)} spec ${spec ? `${spec.source} (${spec.params.length} params)` : "none"}`);
}
entries.sort((a, b) => (bookKey(a) < bookKey(b) ? -1 : 1));
const book: InputBook = { kind: "vet402-input-book", version: 1, createdAt: new Date().toISOString(), entries };
writeFileSync(OUT, JSON.stringify(book, null, 2) + "\n");
console.log(`targets ${targets.length}, need a look ${need.length}, with a spec ${entries.filter((e) => e.spec).length}; wrote ${OUT}`);
