/**
 * Build the public site (site/ by default) from a rank report JSON:
 *   index.html, method.html, seller/<slug>.html and rank.json (the report itself, byte for byte).
 * Static: no scripts, no external requests, styles inline. Reads one file, writes one folder.
 *
 *   npm run rank -- --data data --offline --out /tmp/rank
 *   npx tsx scripts/build-site.ts --report /tmp/rank/rank-2026-09-28.json --out site
 *
 * Without --report it reads results/rank-<date>.json, where <date> comes from data/manifest.json.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPublicSite } from "../src/rank/html.js";
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

const pages = renderPublicSite(report);
rmSync(outDir, { recursive: true, force: true });
for (const [rel, html] of pages) {
  const p = join(outDir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, html);
}
writeFileSync(join(outDir, "rank.json"), text);
console.log(`read ${reportPath}\nwrote ${pages.size} pages and rank.json in ${outDir}`);
