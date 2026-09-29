/**
 * Copy the x402-observation records that may be public into data/records/, byte for byte.
 * Reads the local build (results/receipts/, git-ignored) and the ranking inputs in data/. Signs
 * nothing, sends nothing, reads no key.
 *
 *   npx tsx scripts/publish-records.ts --from results/receipts [--data data] [--out data/records] [--day YYYY-MM-DD]
 *
 * Without --day every day folder in --from is published afresh. With --day only that day is (re)published:
 * the other days already in <out> stay byte for byte as they are, after the same checks the site build
 * runs on them (loadPublishedRecords).
 *
 * A record is copied only when:
 *  - the policy allows it (src/receipt/publish.ts): DELIVERED, or the seller (host, or host#service as in
 *    the ranking) is in notified.json
 *  - it verifies offline against a vet402 observation key (schema, signature, verdict, Merkle proof)
 *  - it carries no credential or local-machine shape and no query string
 *  - its payment tx is a purchase in the ranking inputs (data/), and for DELIVERED the ranking also
 *    counts it as delivered, so the record and the ranking never disagree
 * Anything else in <out>/<day>/ is removed, so a record taken off the list leaves the site.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeBase, normalizeSolanaCensus, normalizeSolanaGate1, normalizeTempoLedger, parseTempoRunLog, tempoPlanUrls } from "../src/rank/normalize.js";
import { sellerKeys } from "../src/rank/score.js";
import { normalizeRemeasure } from "../src/remeasure/normalize.js";
import type { Attempt } from "../src/rank/types.js";
import {
  hostOfUrl,
  isPublishable,
  loadPublishedRecords,
  notifiedSellers,
  PUBLISH_POLICY,
  publicRecordProblems,
  publishedObserverKey,
  sha256Hex,
  type DayEntry,
  type NotifiedFile,
  type RecordEntry,
  type RecordIndex,
} from "../src/receipt/publish.js";
import type { Observation } from "../src/receipt/types.js";
import { verifyOffline } from "../src/receipt/verify.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`);
  return v;
};
const from = resolve(argValue("--from") ?? join(ROOT, "results", "receipts"));
const dataDir = resolve(argValue("--data") ?? join(ROOT, "data"));
const outDir = resolve(argValue("--out") ?? join(dataDir, "records"));

// ---------- ranking inputs: tx -> seller key and delivered ----------
interface DataEntry {
  label: string;
  path: string;
  sha256: string;
  loggedAt?: string;
}
const manifest = JSON.parse(readFileSync(join(dataDir, "manifest.json"), "utf8")) as { files: DataEntry[] };
function read(prefix: string): { text: string; e: DataEntry } {
  const hits = manifest.files.filter((f) => f.label.startsWith(prefix));
  if (hits.length !== 1) throw new Error(`data/manifest.json: ${hits.length} inputs start with "${prefix}"`);
  const e = hits[0]!;
  const text = readFileSync(join(dataDir, e.path), "utf8");
  if (createHash("sha256").update(text).digest("hex") !== e.sha256) throw new Error(`data/${e.path}: sha256 differs from the manifest`);
  return { text, e };
}
const attempts: Attempt[] = [];
{
  const c = read("solana/census-");
  attempts.push(...normalizeSolanaCensus(JSON.parse(c.text), c.e.label));
  const g = read("solana/gate1-");
  attempts.push(...normalizeSolanaGate1(JSON.parse(g.text), g.e.label));
  const plan = read("tempo/census-plan-");
  const l = read("tempo/ledger");
  attempts.push(...normalizeTempoLedger(JSON.parse(l.text), l.e.label));
  const log = read("tempo/run-log");
  if (!log.e.loggedAt) throw new Error("data/manifest.json: tempo/run-log has no loggedAt");
  attempts.push(...parseTempoRunLog(log.text, tempoPlanUrls(JSON.parse(plan.text), plan.e.label), log.e.loggedAt, log.e.label));
  const fb = read("base/feedback-ledger");
  const bp = read("base/purchases");
  attempts.push(...normalizeBase(bp.text, JSON.parse(fb.text), bp.e.label));
  // The daily remeasure purchases, as the ranking reads them (scripts/rank.ts): every remeasure/<chain>-<day> label.
  for (const label of manifest.files.map((f) => f.label).filter((l) => /^remeasure\/(solana|tempo)-\d{4}-\d{2}-\d{2}$/.test(l)).sort()) {
    const r = read(label);
    if (r.e.label !== label) throw new Error(`data/manifest.json: ${label} matched ${r.e.label}`);
    attempts.push(...normalizeRemeasure(JSON.parse(r.text), label));
  }
}
// Algorand attempts carry no service, so leaving them out does not change any seller key.
const keys = sellerKeys(attempts);
const byTx = new Map<string, Attempt[]>();
for (const a of attempts) if (a.tx) byTx.set(a.tx.toLowerCase(), [...(byTx.get(a.tx.toLowerCase()) ?? []), a]);

// ---------- policy ----------
const notifiedPath = join(outDir, "notified.json");
const notified: NotifiedFile = existsSync(notifiedPath)
  ? (JSON.parse(readFileSync(notifiedPath, "utf8")) as NotifiedFile)
  : {
      note: "Sellers told about vet402's records of their purchases. Only for these sellers are NOT_DELIVERED, MISMATCH and UNCLEAR records published. Add { seller, notifiedAt } after the seller has been told. seller is the ranking's seller key: the host, or host#service when one host fronts several services (a bare host then matches none of them).",
      sellers: [],
    };
const told = notifiedSellers(notified);
{
  const known = new Set(attempts.map((a) => keys.get(a)!));
  const unknown = [...told].filter((s) => !known.has(s));
  if (unknown.length) throw new Error(`notified.json names sellers the ranking does not have: ${unknown.join(", ")} (use the ranking's key: host, or host#service)`);
}

// ---------- select ----------
const onlyDay = argValue("--day");
if (onlyDay !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(onlyDay)) throw new Error("--day needs YYYY-MM-DD");
const days = readdirSync(from)
  .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && (onlyDay === undefined || d === onlyDay))
  .sort();
if (days.length === 0) throw new Error(`${from}: no day folders${onlyDay ? ` for ${onlyDay}` : ""}`);
// --day: the other days already published stay as they are, once they pass the site build's checks.
const kept = onlyDay !== undefined && existsSync(join(outDir, "index.json")) ? (await loadPublishedRecords(outDir)).index : null;
const entries: RecordEntry[] = [];
const dayEntries: DayEntry[] = [];
const refused: string[] = [];
const held: Record<string, number> = {};
const copies = new Map<string, string>();
for (const day of days) {
  const files = readdirSync(join(from, day)).filter((f) => /^obs_\d{4}-\d{2}-\d{2}_\d{6}\.json$/.test(f)).sort();
  let dayInfo: DayEntry | null = null;
  let published = 0;
  for (const f of files) {
    const text = readFileSync(join(from, day, f), "utf8");
    const o = JSON.parse(text) as Observation;
    if (!o.anchor) {
      refused.push(`${o.id}: not in a daily root`);
      continue;
    }
    if (!dayInfo) {
      dayInfo = {
        day,
        root: o.anchor.root,
        inRoot: o.anchor.count,
        published: 0,
        sequenceRange: o.anchor.sequenceRange,
        observerAddress: o.anchor.observerAddress,
        anchor: { status: o.anchor.status, network: o.anchor.network, tx: o.anchor.tx },
      };
    } else if (dayInfo.root !== o.anchor.root || dayInfo.anchor.tx !== o.anchor.tx) {
      throw new Error(`${o.id}: a different root or anchor tx than the other records of ${day}`);
    }
    // The seller is the ranking's seller for this payment tx (host, or host#service).
    const as = byTx.get(o.payment.transaction.toLowerCase()) ?? [];
    const sellers = new Set(as.map((a) => keys.get(a)!));
    const seller = sellers.size === 1 ? [...sellers][0]! : null;
    if (o.verdict.code !== "DELIVERED" && (!seller || !isPublishable(o, seller, told))) {
      held[o.verdict.code] = (held[o.verdict.code] ?? 0) + 1;
      continue;
    }
    const why: string[] = publicRecordProblems(text, o);
    const key = publishedObserverKey(o.observer.address);
    if (!key) why.push("not a vet402 observation key");
    const v = await verifyOffline(o, key ? { expectedSigner: key } : {});
    if (!v.schema.ok || !v.signature.ok || !v.verdict.ok || v.merkle.ok !== true) why.push("does not verify offline");
    if (as.length === 0) why.push("payment tx is not a purchase in data/");
    else if (o.verdict.code === "DELIVERED" && !as.some((a) => a.delivered)) why.push(`the ranking does not count it as delivered (${as.map((a) => a.category).join(",")})`);
    if (sellers.size > 1) why.push(`tx maps to ${sellers.size} sellers`);
    if (seller && !isPublishable(o, seller, told)) why.push(`seller ${seller} does not belong to the record's host`);
    if (why.length) {
      refused.push(`${o.id}: ${why.join("; ")}`);
      continue;
    }
    const file = `${day}/${o.id}.json`;
    copies.set(file, text);
    entries.push({
      id: o.id,
      day,
      file,
      sha256: sha256Hex(text),
      network: o.payment.network,
      verdict: o.verdict.code,
      resourceUrl: o.resourceUrl,
      host: hostOfUrl(o.resourceUrl),
      seller: seller!,
      sequence: o.observer.sequence,
    });
    published++;
  }
  if (dayInfo) {
    if (files.length !== dayInfo.inRoot) throw new Error(`${day}: ${files.length} records on disk, the root covers ${dayInfo.inRoot}`);
    dayInfo.published = published;
    dayEntries.push(dayInfo);
  }
}
if (refused.length) {
  console.error(`refused (nothing written):\n  ${refused.join("\n  ")}`);
  process.exit(1);
}

// ---------- write ----------
mkdirSync(outDir, { recursive: true });
for (const d of readdirSync(outDir))
  if (/^\d{4}-\d{2}-\d{2}$/.test(d) && (onlyDay === undefined || d === onlyDay)) rmSync(join(outDir, d), { recursive: true, force: true });
for (const [file, text] of copies) {
  mkdirSync(join(outDir, dirname(file)), { recursive: true });
  writeFileSync(join(outDir, file), text);
}
const allDays = [...(kept?.days.filter((d) => d.day !== onlyDay) ?? []), ...dayEntries].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
const allRecords = [...(kept?.records.filter((r) => r.day !== onlyDay) ?? []), ...entries].sort((a, b) => (a.day === b.day ? a.sequence - b.sequence : a.day < b.day ? -1 : 1));
const index: RecordIndex = {
  kind: "vet402-observation-records",
  version: 0,
  policy: PUBLISH_POLICY,
  notifiedSellers: told.size,
  days: allDays,
  records: allRecords,
};
writeFileSync(join(outDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
writeFileSync(notifiedPath, `${JSON.stringify(notified, null, 2)}\n`);
// The same check the site build runs, on what was just written.
try {
  await loadPublishedRecords(outDir);
} catch (e) {
  console.error(`${outDir} was written but does not pass the site build's check; restore it (git checkout) before building the site:\n${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const byNet: Record<string, number> = {};
for (const e of entries) byNet[e.network] = (byNet[e.network] ?? 0) + 1;
console.log(JSON.stringify({ out: outDir.replace(ROOT, "."), published: entries.length, byNetwork: byNet, heldUntilSellerIsTold: held, notifiedSellers: told.size, days: dayEntries.map((d) => `${d.day} ${d.published}/${d.inRoot}`) }, null, 2));
