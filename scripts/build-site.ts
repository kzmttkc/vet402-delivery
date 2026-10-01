/**
 * Build the public site (site/ by default) from a rank report JSON:
 *   index.html (Solana, Tempo, Base), algorand.html, method.html, seller/<slug>.html and rank.json
 *   (the report itself, byte for byte). Each page is graded from its own chains only (method v3).
 * and, from data/records/ (or --records <dir>), the signed delivery records:
 *   records/index.html, records/<id>.html and records/<id>.json (the record itself, byte for byte).
 * The build stops if data/records/ holds a record the policy does not allow, a record that does not
 * verify, or a file its index.json does not list (src/receipt/publish.ts).
 * Static: no scripts, no external requests, styles inline. Reads files, writes one folder.
 *
 *   npm run rank -- --data data --offline --out /tmp/rank
 *   npx tsx scripts/build-site.ts --report /tmp/rank/rank-2026-09-28.json --out site
 *
 * Without --report it reads results/rank-<date>.json, where <date> comes from data/manifest.json.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicPage, renderPublicSite, siteSlugs } from "../src/rank/html.js";
import { loadPublishedRecords } from "../src/receipt/publish.js";
import { loadLanePublic } from "../src/evm/site.js";
import { recordsBySeller, renderRecordsSite } from "../src/receipt/site.js";
import type { RankReport } from "../src/rank/report.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`);
  return v;
};

function defaultReport(): string {
  const manifest = JSON.parse(readFileSync(join(ROOT, "data", "manifest.json"), "utf8")) as { date: string };
  return join(ROOT, "results", `rank-${manifest.date}.json`);
}

const reportPath = resolve(argValue("--report") ?? defaultReport());
const outDir = resolve(argValue("--out") ?? join(ROOT, "site"));
if (outDir === ROOT || outDir === "/" || !outDir.startsWith("/")) throw new Error(`refusing to write into ${outDir}`);

const text = readFileSync(reportPath, "utf8");
const report = JSON.parse(text) as RankReport;
if (report.kind !== "vet402-seller-rank") throw new Error(`${reportPath}: not a vet402 rank report`);

const recordsDir = resolve(argValue("--records") ?? join(ROOT, "data", "records"));
const records = existsSync(join(recordsDir, "index.json")) ? await loadPublishedRecords(recordsDir) : null;
const slugs = siteSlugs(report);
const lanes = loadLanePublic(join(ROOT, "data"));
const recordsIndex = existsSync(join(recordsDir, "index.json")) ? (JSON.parse(readFileSync(join(recordsDir, "index.json"), "utf8")) as unknown) : undefined;
const pages = renderPublicSite(report, { records: records ? recordsBySeller(records) : undefined, lanes, recordsIndex });
const jsonFiles = new Map<string, string>();
if (records) {
  for (const [rel, html] of renderRecordsSite(records, { sellerSlug: (k) => slugs.get(k) ?? null, page: publicPage })) pages.set(rel, html);
  for (const r of records.records) jsonFiles.set(`records/${r.entry.id}.json`, r.text);
}
rmSync(outDir, { recursive: true, force: true });
for (const [rel, body] of [...pages, ...jsonFiles]) {
  const p = join(outDir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}
writeFileSync(join(outDir, "rank.json"), text);
console.log(`read ${reportPath}${records ? ` and ${records.records.length} records in ${recordsDir}` : ""}\nwrote ${pages.size} pages, ${jsonFiles.size} record JSON files and rank.json in ${outDir}`);
