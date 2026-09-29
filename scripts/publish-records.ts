/**
 * Copy the x402-observation records that may be public into data/records/, byte for byte.
 * Reads the local build (results/receipts/, git-ignored) and the ranking inputs in data/. Signs
 * nothing, sends nothing, reads no key.
 *
 *   npx tsx scripts/publish-records.ts --from results/receipts [--data data] [--out data/records]
 *
 * A record is copied only when:
 *  - the policy allows it (src/receipt/publish.ts): DELIVERED, or the host is in notified.json
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
import type { Attempt } from "../src/rank/types.js";
import {
  hostOfUrl,
  isPublishable,
  notifiedHosts,
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
      note: "Hosts told about vet402's records of their purchases. Only for these hosts are NOT_DELIVERED, MISMATCH and UNCLEAR records published. Add { host, notifiedAt } after the seller has been told.",
      hosts: [],
    };
const told = notifiedHosts(notified);

// ---------- select ----------
const days = readdirSync(from).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
if (days.length === 0) throw new Error(`${from}: no day folders`);
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
    if (!isPublishable(o, told)) {
      held[o.verdict.code] = (held[o.verdict.code] ?? 0) + 1;
      continue;
    }
    const why: string[] = publicRecordProblems(text, o);
    const key = publishedObserverKey(o.observer.address);
    if (!key) why.push("not a vet402 observation key");
    const v = await verifyOffline(o, key ? { expectedSigner: key } : {});
    if (!v.schema.ok || !v.signature.ok || !v.verdict.ok || v.merkle.ok !== true) why.push("does not verify offline");
    const as = byTx.get(o.payment.transaction.toLowerCase()) ?? [];
    if (as.length === 0) why.push("payment tx is not a purchase in data/");
    else if (o.verdict.code === "DELIVERED" && !as.some((a) => a.delivered)) why.push(`the ranking does not count it as delivered (${as.map((a) => a.category).join(",")})`);
    const sellers = new Set(as.map((a) => keys.get(a)!));
    if (sellers.size > 1) why.push(`tx maps to ${sellers.size} sellers`);
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
      seller: [...sellers][0]!,
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
for (const d of readdirSync(outDir)) if (/^\d{4}-\d{2}-\d{2}$/.test(d)) rmSync(join(outDir, d), { recursive: true, force: true });
for (const [file, text] of copies) {
  mkdirSync(join(outDir, dirname(file)), { recursive: true });
  writeFileSync(join(outDir, file), text);
}
const index: RecordIndex = {
  kind: "vet402-observation-records",
  version: 0,
  policy: PUBLISH_POLICY,
  notifiedHosts: told.size,
  days: dayEntries,
  records: entries,
};
writeFileSync(join(outDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
writeFileSync(notifiedPath, `${JSON.stringify(notified, null, 2)}\n`);

const byNet: Record<string, number> = {};
for (const e of entries) byNet[e.network] = (byNet[e.network] ?? 0) + 1;
console.log(JSON.stringify({ out: outDir.replace(ROOT, "."), published: entries.length, byNetwork: byNet, heldUntilSellerIsTold: held, notifiedHosts: told.size, days: dayEntries.map((d) => `${d.day} ${d.published}/${d.inRoot}`) }, null, 2));
