/**
 * Build results/rank-<date>.json and the pages in results/rank-<date>/ from vet402's own purchase results
 * on Algorand, Solana, Tempo and Base, and compare with catalog order (CDP Bazaar, Mercator).
 *
 * Read-only: GET requests to public JSON (vet402-algorand board on GitHub, CDP discovery) and local
 * result files. No wallet, no signing, no sending.
 *
 *   npm run rank                 # today (UTC), fetch what is not cached yet
 *   npm run rank -- --date 2026-09-28 --offline
 *   npm run rank -- --data data --offline   # only the published copies in data/ (data/manifest.json), no network
 *
 * --out <dir> writes rank-<date>.json and rank-<date>/ there instead of results/.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OWN_HOSTS } from "../src/constants.js";
import { cdpByHost } from "../src/rank/compare.js";
import { renderSite } from "../src/rank/html.js";
import {
  mercatorBestRanks,
  normalizeAlgorand,
  normalizeBase,
  normalizeSolanaCensus,
  normalizeSolanaGate1,
  normalizeTempoLedger,
  parseTempoRunLog,
  tempoPlanUrls,
} from "../src/rank/normalize.js";
import { buildReport, type InputRecord } from "../src/rank/report.js";
import type { Attempt } from "../src/rank/types.js";
import { normalizeRemeasure } from "../src/remeasure/normalize.js";
import { resultFilesUpTo } from "../src/remeasure/results.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOME = process.env.HOME ?? "";
const CACHE = join(ROOT, ".cache", "rank");

const INPUTS = {
  algorand: ["2026-09-27", "2026-09-28"].map((d) => ({
    label: `algorand/census-${d}`,
    url: `https://raw.githubusercontent.com/kzmttkc/vet402-algorand/main/board/census-${d}.json`,
  })),
  solanaCensus: join(HOME, "vet402-solana-census/results/census-2026-09-28.json"),
  solanaGate1: join(HOME, "vet402-solana/results/gate1-2026-09-29.json"),
  tempoLedger: join(HOME, "vet402-solana-tempo/results/tempo-ledger.json"),
  tempoLog: join(HOME, "vet402-solana-tempo/results/tempo-run.log"),
  tempoPlan: join(HOME, "vet402-solana-tempo/results/tempo-census-2026-09-28.dry-run.json"),
  basePurchases: join(HOME, "vet402-solana-base/results/base-purchases.jsonl"),
  baseFeedback: join(HOME, "vet402-solana-base/results/base-feedback-ledger.json"),
  cdp: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources",
  /** scripts/remeasure.ts output: <chain>-YYYY-MM-DD.json, one per chain and UTC day. */
  remeasureDir: join(ROOT, "results", "remeasure"),
};

const args = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`);
  return v;
};

/** data/manifest.json: the published copies of every input, with the sha256 each copy must have. */
interface DataEntry {
  label: string;
  path: string;
  sha256: string;
  source: string;
  note?: string;
  origin?: string;
  fetchedAt?: string;
  /** tempo/run-log only: when the runner last wrote the log (its refusal lines carry no time). */
  loggedAt?: string;
}
const dataDir = argValue("--data") ? resolve(argValue("--data")!) : null;
const manifest = dataDir ? (JSON.parse(readFileSync(join(dataDir, "manifest.json"), "utf8")) as { date: string; files: DataEntry[] }) : null;
const offline = args.includes("--offline") || dataDir !== null;
const date = argValue("--date") ?? manifest?.date ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`bad --date ${date}`);
const outDir = argValue("--out") ? resolve(argValue("--out")!) : join(ROOT, "results");

const inputs: InputRecord[] = [];
const sha = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");

function fail(msg: string): never {
  throw new Error(msg);
}

function dataEntry(label: string): DataEntry {
  const e = manifest!.files.find((f) => f.label === label);
  if (!e) throw new Error(`data/manifest.json has no input "${label}"`);
  return e;
}

/** Read one published copy; its sha256 must match the manifest. */
function readData(label: string): string {
  const e = dataEntry(label);
  const text = readFileSync(join(dataDir!, e.path), "utf8");
  const got = sha(text);
  if (got !== e.sha256) throw new Error(`data/${e.path}: sha256 ${got} != manifest ${e.sha256}`);
  const note = [e.note, e.origin ? `origin ${e.origin}` : `copied from ${e.source}`].filter(Boolean).join(" ");
  inputs.push({ label, location: `data/${e.path}`, sha256: got, ...(e.fetchedAt ? { fetchedAt: e.fetchedAt } : {}), note });
  return text;
}

function readLocal(label: string, path: string): string {
  if (dataDir) return readData(label);
  const text = readFileSync(path, "utf8");
  inputs.push({ label, location: path.replace(HOME, "~"), sha256: sha(text) });
  return text;
}

async function fetchCached(label: string, url: string, cacheName: string): Promise<string> {
  if (dataDir) return readData(label);
  mkdirSync(CACHE, { recursive: true });
  const p = join(CACHE, cacheName);
  const meta = `${p}.meta.json`;
  if (!existsSync(p)) {
    if (offline) throw new Error(`--offline and no cache for ${url}`);
    const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "vet402-rank/0.1 (+https://vet402.com)" } });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    writeFileSync(p, await res.text());
    writeFileSync(meta, JSON.stringify({ url, fetchedAt: new Date().toISOString() }));
  }
  const text = readFileSync(p, "utf8");
  const fetchedAt = existsSync(meta) ? (JSON.parse(readFileSync(meta, "utf8")) as { fetchedAt: string }).fetchedAt : undefined;
  inputs.push({ label, location: url, sha256: sha(text), ...(fetchedAt ? { fetchedAt } : {}) });
  return text;
}

async function fetchCdpItems(): Promise<unknown[]> {
  // data/ keeps only the fields cdpByHost reads, in page order (see the file's own note).
  if (dataDir) return (JSON.parse(readData(`cdp/discovery-${date}`)) as { items: unknown[] }).items;
  const items: unknown[] = [];
  const limit = 1000;
  for (let offset = 0; ; offset += limit) {
    const text = await fetchCached(`cdp/offset-${offset}`, `${INPUTS.cdp}?limit=${limit}&offset=${offset}`, `cdp-${date}-${offset}.json`);
    const page = JSON.parse(text) as { items?: unknown[]; pagination?: { total?: number } };
    const got = page.items ?? [];
    items.push(...got);
    const total = page.pagination?.total ?? 0;
    if (got.length === 0 || offset + limit >= total) break;
  }
  return items;
}

async function main(): Promise<void> {
  const attempts: Attempt[] = [];

  for (const a of INPUTS.algorand) {
    const text = await fetchCached(a.label, a.url, `${a.label.replace("/", "-")}.json`);
    attempts.push(...normalizeAlgorand(JSON.parse(text), a.label));
  }
  attempts.push(...normalizeSolanaCensus(JSON.parse(readLocal("solana/census-2026-09-28", INPUTS.solanaCensus)), "solana/census-2026-09-28"));
  attempts.push(...normalizeSolanaGate1(JSON.parse(readLocal("solana/gate1-2026-09-29", INPUTS.solanaGate1)), "solana/gate1-2026-09-29"));

  const plan = JSON.parse(readLocal("tempo/census-plan-2026-09-28", INPUTS.tempoPlan));
  attempts.push(...normalizeTempoLedger(JSON.parse(readLocal("tempo/ledger", INPUTS.tempoLedger)), "tempo/ledger"));
  const logAt = dataDir ? (dataEntry("tempo/run-log").loggedAt ?? fail("data/manifest.json: tempo/run-log has no loggedAt")) : statSync(INPUTS.tempoLog).mtime.toISOString();
  attempts.push(...parseTempoRunLog(readLocal("tempo/run-log", INPUTS.tempoLog), tempoPlanUrls(plan, "tempo/plan"), logAt, "tempo/run-log"));

  const feedback = JSON.parse(readLocal("base/feedback-ledger", INPUTS.baseFeedback));
  attempts.push(...normalizeBase(readLocal("base/purchases", INPUTS.basePurchases), feedback, "base/purchases"));

  // Remeasure files dated on or before --date: results/remeasure/, or the data/ labels remeasure/<chain>-YYYY-MM-DD.
  const remeasure = dataDir
    ? manifest!.files.map((f) => f.label).filter((l) => /^remeasure\/(solana|tempo)-\d{4}-\d{2}-\d{2}$/.test(l) && l.slice(-10) <= date).sort()
    : resultFilesUpTo(INPUTS.remeasureDir, date).map((f) => `remeasure/${f.name.replace(/\.json$/, "")}`);
  for (const label of remeasure) {
    const path = join(INPUTS.remeasureDir, `${label.slice("remeasure/".length)}.json`);
    attempts.push(...normalizeRemeasure(JSON.parse(readLocal(label, path)), label));
  }

  const cdp = cdpByHost(await fetchCdpItems());
  const mercator = mercatorBestRanks(plan, "tempo/plan");

  const report = buildReport({
    date,
    generatedAt: new Date().toISOString(),
    attempts,
    excludeHosts: OWN_HOSTS,
    cdp,
    mercator,
    inputs,
  });

  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `rank-${date}.json`);
  const siteDir = join(outDir, `rank-${date}`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + "\n");
  rmSync(siteDir, { recursive: true, force: true });
  const pages = renderSite(report);
  for (const [rel, html] of pages) {
    const p = join(siteDir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, html);
  }

  console.log(`attempts ${report.totals.attempts}, tried ${report.totals.tried}, delivered ${report.totals.delivered}`);
  const t = report.totals;
  console.log(`counted ${t.counted}, not counted: vet402/facilitator ${t.excluded.vet402_or_facilitator}, can't tell ${t.excluded.unknown}`);
  console.log(`sellers seen ${t.sellersSeen}, listed ${t.sellersListed}, ranked ${t.sellersRanked}, payTo changed ${t.payToChanged}`);
  console.log(`grades ${JSON.stringify(t.grades)}`);
  console.log(`failures by rule ${JSON.stringify(t.failuresByRule)}`);
  for (const c of report.chains) {
    console.log(`  ${c.chain.padEnd(9)} rows ${c.rows} tried ${c.tried} settled ${c.settled} delivered ${c.delivered} sellers ${c.sellersTried} notTried ${JSON.stringify(c.notTried)}`);
  }
  for (const c of report.comparisons) {
    console.log(`${c.catalog}: overlap ${c.overlap}, high-but-never-delivered ${c.highButNeverDelivered.length}, low-but-always-delivered ${c.lowButAlwaysDelivered.length}, misaligned ${c.misaligned}, spearman ${c.spearman?.toFixed(3) ?? "-"}`);
  }
  console.log(`wrote ${jsonPath}\nwrote ${pages.size} pages in ${siteDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
