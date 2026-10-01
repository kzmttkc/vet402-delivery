/**
 * Fill in, for purchases recorded before 2026-10-02, what the listing declared and which parameter names the
 * request carried, so rule 0 of src/evm/lane-input.ts (a required input vet402 did not send is vet402's 4xx) can
 * read them. Read-only: catalog GETs and unpaid requests that return 402; nothing is signed or paid.
 *
 *   npx tsx scripts/evm-declare.ts --lane arbitrum|robinhood|base-compare [--catalogs <dir>]
 *
 * Where a declaration comes from, first that exists: the purchase record itself (purchases from 2026-10-02 keep
 * it); a snapshot of the catalog at purchase time (results/evm/<lane>-catalog-snapshot.json, none exists for
 * 2026-09-30); else the catalogs and the seller's 402 read now, labelled with today's date. The names the request
 * carried: the plan's query (results/evm/<lane>-dryrun.json, or -paid-run.json) and the JSON body the lane built
 * from the catalog listing (lane-plan.ts requestOf). Writes results/evm/<lane>-declared.jsonl: one patch per 4xx
 * purchase; scripts/evm-publish.ts fills only fields the record does not have.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CDP_DISCOVERY, PAYAI_DISCOVERY } from "../src/constants.js";
import { fetchCatalog, type Listing } from "../src/discovery.js";
import { LANES, type LaneId } from "../src/evm/chains.js";
import { mergeReadings } from "../src/evm/chaincheck.js";
import type { ChainBuyRecord } from "../src/evm/evm-buy.js";
import { declarationFrom, INPUT_STATUSES, mergeDeclarations, sentParamNames, type InputDeclaration } from "../src/evm/lane-input.js";
import { DEXTER_DISCOVERY, requestOf } from "../src/evm/lane-plan.js";

const argv = process.argv.slice(2);
const laneId = argv[argv.indexOf("--lane") + 1] as LaneId;
if (!(laneId in LANES)) throw new Error(`--lane ${Object.keys(LANES).join(" | ")}`);
const catalogsDir = argv.includes("--catalogs") ? argv[argv.indexOf("--catalogs") + 1] : undefined;
const today = new Date().toISOString().slice(0, 10);
const planLane = laneId === "base-compare" ? "arbitrum" : laneId;

const rows = mergeReadings(
  [`results/evm/${laneId}-purchases.jsonl`, `results/evm/${laneId}-reverify.jsonl`, `results/evm/${laneId}-chaincheck.jsonl`].flatMap((f) =>
    existsSync(f) ? readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as ChainBuyRecord & { lane: string }) : [],
  ),
).filter((r) => r.lane === laneId && r.outcome === "sent" && INPUT_STATUSES.has(r.response?.status ?? -1));

const planFile = existsSync(`results/evm/${planLane}-paid-run.json`) ? `results/evm/${planLane}-paid-run.json` : `results/evm/${planLane}-dryrun.json`;
const plan = JSON.parse(readFileSync(planFile, "utf8")) as Record<string, { choices?: { chosen: { resource: string; query: Record<string, string> | null } | null }[] }>;
const planned = new Map((plan[planLane]?.choices ?? []).flatMap((c) => (c.chosen ? [[c.chosen.resource, c.chosen.query] as const] : [])));

const snapshotFile = `results/evm/${planLane}-catalog-snapshot.json`;
const snapshot: Listing[] | null = existsSync(snapshotFile) ? ((JSON.parse(readFileSync(snapshotFile, "utf8")) as { items: Listing[] }).items ?? null) : null;

let catalog: Listing[] = [];
async function loadCatalog(): Promise<void> {
  for (const [name, url] of [["cdp", CDP_DISCOVERY], ["dexter", DEXTER_DISCOVERY], ["payai", PAYAI_DISCOVERY]] as const) {
    const items = catalogsDir
      ? ((JSON.parse(readFileSync(join(catalogsDir, `catalog_${name}.json`), "utf8")) as { items?: Listing[] }).items ?? [])
      : (await fetchCatalog(url, { pageLimit: 1000, sleepMs: 300 })).items;
    catalog.push(...items.map((l) => ({ ...l, __source: name }) as Listing));
  }
}

async function read402(r: ChainBuyRecord, query: Record<string, string> | null, body: unknown): Promise<unknown[]> {
  const u = new URL(r.resource);
  for (const [k, v] of Object.entries(query ?? {})) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
  const init: RequestInit = { method: r.method, headers: { accept: "application/json", ...(r.method === "POST" ? { "content-type": "application/json" } : {}) }, redirect: "manual", signal: AbortSignal.timeout(20_000) };
  if (r.method === "POST") init.body = JSON.stringify(body ?? {});
  try {
    const res = await fetch(u, init);
    if (res.status !== 402) return [];
    const docs: unknown[] = [];
    const h = res.headers.get("payment-required");
    if (h) docs.push(JSON.parse(Buffer.from(h, "base64").toString("utf8")));
    try {
      docs.push(JSON.parse(await res.text()));
    } catch {
      /* not JSON */
    }
    return docs;
  } catch {
    return [];
  }
}

const out: string[] = [];
if (!snapshot) await loadCatalog();
for (const r of rows) {
  const key = r.listingResource ?? r.resource;
  const listings = (snapshot ?? catalog).filter((l) => l.resource === key);
  const query = planned.get(key) ?? null;
  // The body the lane sent: what requestOf built from the listing it planned from.
  const built = listings.length ? requestOf(listings[0]!) : { method: r.method, query, body: r.method === "POST" ? {} : null };
  const sent = r.sentParams ?? sentParamNames({ method: r.method, query, body: built.body });
  let decl: InputDeclaration;
  if (r.requiredParams || r.declaredFrom) {
    decl = { declared: r.declaredParams ?? [], required: r.requiredParams ?? [], from: r.declaredFrom ?? ["record"], requiredFrom: r.requiredFrom ?? [] };
  } else {
    const label = snapshot ? "catalog at purchase" : `catalog ${today}`;
    const docs402 = snapshot ? [] : await read402(r, query, built.body);
    decl = mergeDeclarations([
      ...listings.map((l) => declarationFrom(l, `${label} (${(l as Listing & { __source?: string }).__source ?? "?"})`)),
      ...docs402.map((d) => declarationFrom(d, `402 ${today}`)),
    ]);
  }
  out.push(JSON.stringify({ lane: laneId, agentId: r.agentId, at: r.at, resource: r.resource, declaredParams: decl.declared, requiredParams: decl.required, declaredFrom: decl.from, requiredFrom: decl.requiredFrom, sentParams: sent, sentFrom: r.sentParams ? "record" : `plan query (${planFile}) and the body requestOf built from the listing` }));
  console.log(`${r.resource}  status ${r.response?.status}  sent [${sent.join(", ")}]  required [${decl.required.join(", ")}]  required from ${decl.requiredFrom.join("; ") || "-"}`);
}
writeFileSync(`results/evm/${laneId}-declared.jsonl`, out.join("\n") + (out.length ? "\n" : ""));
