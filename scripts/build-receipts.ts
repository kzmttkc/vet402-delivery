/**
 * Build, sign and root x402-observation/v0 records from purchase runs vet402 already made.
 * Reads result files, writes JSON + HTML per record. No payment, no sending. The daily anchor is
 * only simulated (--simulate-anchor): an unsigned memo transaction, sigVerify off.
 *
 * One day of remeasure purchases (the daily run, scripts/remeasure.ts):
 *
 *   npx tsx scripts/build-receipts.ts --key <attest.json> --out <receipts> --day YYYY-MM-DD [--simulate-anchor]
 *       [--remeasure-dir <dir>] [--chains solana,tempo] [--allow-open-day]
 *
 *   Reads <dir>/<chain>-<day>.json and the spend ledgers next to it (budget-solana-YYYY-MM.json,
 *   tempo-ledger-<day>.json); <dir> defaults to the one production folder (src/remeasure/constants.ts).
 *   Sequence numbers continue from the records already in <receipts>. A day that is already built, or
 *   earlier than a day that is, is refused: a built day is never signed again. The current UTC day is
 *   refused unless --allow-open-day, because a later run that day would add purchases the root leaves out;
 *   a day built that way is marked openDay in sources.json, and publish-records and anchor-receipts refuse it.
 *   sources.json also keeps the hash of each input, which those two check again before they touch the day.
 *
 * The first build (the 2026-09-28 purchases, sequence from 1):
 *
 *   npx tsx scripts/build-receipts.ts --key <attest.json> \
 *     --solana <census.json> --tempo <tempo-ledger.json> --base <base-purchases.jsonl> \
 *     --out results/receipts [--simulate-anchor]
 *
 * Output (results/ is local; negative records name sellers and are not published before the seller
 * is told, so this directory is git-ignored; scripts/publish-records.ts copies the publishable ones to
 * data/records/, and scripts/anchor-receipts.ts writes a day's root on Solana):
 *   <out>/<day>/<id>.json, <id>.html, index.json, anchor-plan.json (--day also: skipped.json, sources.json)
 *   <out>/private/salts.json (mode 600): the params_hash salts, disclosed only to parties in a dispute
 *   <out>/did.json: the did:web document to publish at https://vet402.com/.well-known/did.json
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { jsonRpc } from "../src/chain.js";
import { PAYER_ADDRESS, SOLANA_MAINNET } from "../src/constants.js";
import { RM_PROD_DIR } from "../src/remeasure/constants.js";
import { simulateMemoAnchor } from "../src/receipt/anchor.js";
import {
  assemble,
  factsFromBasePurchases,
  factsFromRemeasure,
  factsFromSolanaCensus,
  factsFromTempoLedger,
  nextSequence,
  type BasePurchase,
  type BuiltDay,
  type Facts,
  type RemeasureFile,
  type RemeasureSpend,
  type Skip,
  type SolanaCensus,
  type TempoLedger,
} from "../src/receipt/build.js";
import { observationDigest, signObservation } from "../src/receipt/eip712.js";
import { renderObservationPage } from "../src/receipt/html.js";
import { anchorMemo, buildTree } from "../src/receipt/merkle.js";
import { validateObservation } from "../src/receipt/schema.js";
import type { Observation } from "../src/receipt/types.js";
import { SOURCES_KIND, sourceDigest, type DaySources, type SourceEntry } from "../src/receipt/sources.js";
import { verifyOffline } from "../src/receipt/verify.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}
const keyPath = arg("--key");
const outDir = arg("--out") ?? "results/receipts";
if (!keyPath) fail("--key <attest.json> is required");
const account = privateKeyToAccount((JSON.parse(readFileSync(keyPath, "utf8")) as { privateKey: Hex }).privateKey);
const OBSERVER_ID = "did:web:vet402.com#obs-key-2026-09";
const observer = { id: OBSERVER_ID, address: account.address };
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- what is already built ----------
const built: BuiltDay[] = existsSync(outDir)
  ? readdirSync(outDir)
      .filter((d) => DAY_RE.test(d))
      .map((day) => ({
        day,
        records: readdirSync(join(outDir, day))
          .filter((f) => /^obs_\d{4}-\d{2}-\d{2}_\d{6}\.json$/.test(f))
          .map((f) => {
            const o = JSON.parse(readFileSync(join(outDir, day, f), "utf8")) as Observation;
            return { address: o.observer.address, sequence: o.observer.sequence };
          }),
      }))
  : [];

// ---------- facts ----------
const facts: Facts[] = [];
const skips: Skip[] = [];
const sources: SourceEntry[] = [];
const byChain: Record<string, { facts: number; skipped: number }> = {};
function take(chain: string, r: { facts: Facts[]; skips: Skip[] }) {
  facts.push(...r.facts);
  skips.push(...r.skips);
  byChain[chain] = { facts: r.facts.length, skipped: r.skips.length };
}
/** Read an input and note its hash in sources.json; publish and anchor check it again (src/receipt/sources.ts). */
function readSource(dataset: string, path: string, scope: SourceEntry["scope"] = "file"): string {
  if (!existsSync(path)) fail(`${dataset}: ${basename(path)} not found in the remeasure folder`);
  const text = readFileSync(path, "utf8");
  sources.push({ dataset, file: basename(path), scope, sha256: sourceDigest(scope, text, day!) });
  return text;
}

const day = arg("--day");
let firstSeq = 1;
let openDay = false;
if (day !== undefined) {
  if (!DAY_RE.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) fail("--day needs YYYY-MM-DD");
  if (["--solana", "--tempo", "--base"].some((f) => process.argv.includes(f))) fail("--day builds from the remeasure results only; --solana/--tempo/--base belong to the first build");
  const today = new Date().toISOString().slice(0, 10);
  if (day > today) fail(`${day} is in the future (UTC today is ${today})`);
  if (day === today && !process.argv.includes("--allow-open-day"))
    fail(`${day} is still open (UTC). A later remeasure run today would add purchases this root leaves out. Build it tomorrow, or pass --allow-open-day for a local look (such a day is never published or anchored).`);
  openDay = day === today;
  try {
    firstSeq = nextSequence(built, day, account.address);
  } catch (e) {
    fail(`${e instanceof Error ? e.message : String(e)}; nothing written`);
  }
  const rmDir = arg("--remeasure-dir") ?? RM_PROD_DIR;
  const chains = (arg("--chains") ?? "solana,tempo").split(",").map((c) => c.trim());
  if (chains.length === 0 || chains.some((c) => c !== "solana" && c !== "tempo")) fail("--chains takes solana, tempo or both");
  for (const chain of chains) {
    const dataset = `remeasure-${chain}-${day}`;
    const file = JSON.parse(readSource(dataset, join(rmDir, `${chain}-${day}.json`))) as RemeasureFile;
    if (file.date !== day || file.chain !== chain) fail(`${dataset}: the file says ${file.chain} ${file.date}`);
    let spends: RemeasureSpend[];
    if (chain === "solana") {
      const b = JSON.parse(readSource(`${dataset} budget`, join(rmDir, `budget-solana-${day.slice(0, 7)}.json`), "day-purchases")) as { purchases: { key: string; amount: string; at: string }[] };
      spends = b.purchases.filter((p) => p.key.startsWith(`${day}|`)).map((p) => ({ key: p.key, amount: p.amount, at: p.at }));
    } else {
      const l = JSON.parse(readSource(`${dataset} ledger`, join(rmDir, `tempo-ledger-${day}.json`))) as {
        payer: string;
        entries: { key: string; amount: string; reservedAt: string; recipient: string; status: string; txHash: string | null; settled: boolean | null }[];
      };
      if (l.payer.toLowerCase() !== file.payer.toLowerCase()) fail(`${dataset}: ledger payer ${l.payer} is not the result's payer ${file.payer}`);
      spends = l.entries.map((e) => ({ key: e.key, amount: e.amount, at: e.reservedAt, recipient: e.recipient, status: e.status, txHash: e.txHash, settled: e.settled }));
    }
    take(chain, factsFromRemeasure(file, dataset, spends));
  }
} else {
  // The first build numbers from 1, so it only runs into an empty folder.
  if (built.length) fail(`${outDir} already holds ${built.map((b) => b.day).join(", ")}; build new days with --day. Nothing written.`);
  const sol = arg("--solana");
  if (sol) take("solana", factsFromSolanaCensus(JSON.parse(readFileSync(sol, "utf8")) as SolanaCensus, "solana-census-2026-09-28"));
  const tempo = arg("--tempo");
  if (tempo) take("tempo", factsFromTempoLedger(JSON.parse(readFileSync(tempo, "utf8")) as TempoLedger, "tempo-ledger-2026-09-28"));
  const base = arg("--base");
  if (base)
    take(
      "base",
      factsFromBasePurchases(
        readFileSync(base, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as BasePurchase),
        "base-purchases-2026-09-28",
      ),
    );
}
if (facts.length === 0) fail(`no settled purchase to record (${skips.length} skipped); nothing written`);

// Stable order: time, then dataset/row. Sequence numbers follow this order.
facts.sort((a, b) => (a.observedAt === b.observedAt ? `${a.dataset}#${a.row}`.localeCompare(`${b.dataset}#${b.row}`) : a.observedAt < b.observedAt ? -1 : 1));
if (day !== undefined && facts.some((f) => f.observedAt.slice(0, 10) !== day)) fail(`a purchase in the ${day} files is dated another day; nothing written`);
for (const d of new Set(facts.map((f) => f.observedAt.slice(0, 10))))
  if (existsSync(join(outDir, d))) fail(`${join(outDir, d)} exists; a built day is never signed again. Nothing written.`);

// ---------- salts (kept, so a rebuild gives the same params_hash) ----------
const privDir = join(outDir, "private");
mkdirSync(privDir, { recursive: true, mode: 0o700 });
const saltPath = join(privDir, "salts.json");
const salts: Record<string, Hex> = existsSync(saltPath) ? (JSON.parse(readFileSync(saltPath, "utf8")) as Record<string, Hex>) : {};
for (const f of facts) salts[`${f.dataset}#${f.row}`] ??= toHex(randomBytes(32));
writeFileSync(saltPath, `${JSON.stringify(salts, null, 1)}\n`, { mode: 0o600 });
chmodSync(saltPath, 0o600);

// ---------- assemble + sign ----------
const issuedAt = Math.floor(Date.now() / 1000);
const signed: Observation[] = [];
for (const [i, f] of facts.entries()) {
  const o = assemble(f, firstSeq + i, observer, salts[`${f.dataset}#${f.row}`]!, issuedAt);
  signed.push(await signObservation(o, account));
}

// ---------- one root per UTC day ----------
const days = new Map<string, Observation[]>();
for (const o of signed) {
  const d = o.id.slice(4, 14);
  days.set(d, [...(days.get(d) ?? []), o]);
}

const simulate = process.argv.includes("--simulate-anchor");
const rpc = jsonRpc(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com");
const summary: Record<string, unknown> = {};
for (const [d, obs] of days) {
  const tree = buildTree(obs.map((o) => observationDigest(o)));
  const seq: [number, number] = [obs[0]!.observer.sequence, obs[obs.length - 1]!.observer.sequence];
  const memo = anchorMemo({ day: d, root: tree.root, count: obs.length, sequenceRange: seq, observerAddress: account.address });
  // Written into a hidden folder, then renamed: a crash never leaves a half-built day that looks built.
  const dir = join(outDir, d);
  const tmp = join(outDir, `.${d}.partial`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const counts: Record<string, Record<string, number>> = {};
  for (const [i, o] of obs.entries()) {
    o.anchor = {
      status: "pending",
      day: d,
      network: SOLANA_MAINNET,
      tx: null,
      root: tree.root,
      leafIndex: i,
      proof: tree.proofs[i]!,
      count: obs.length,
      sequenceRange: seq,
      observerAddress: account.address,
      anchoredAt: null,
    };
    const errs = validateObservation(o);
    if (errs.length) throw new Error(`${o.id} fails the schema: ${errs.join("; ")}`);
    const v = await verifyOffline(o, { expectedSigner: account.address });
    if (!v.signature.ok || !v.merkle.ok || !v.verdict.ok) throw new Error(`${o.id} does not verify: ${JSON.stringify(v)}`);
    writeFileSync(join(tmp, `${o.id}.json`), `${JSON.stringify(o, null, 2)}\n`);
    writeFileSync(join(tmp, `${o.id}.html`), renderObservationPage(o, { jsonHref: `${o.id}.json`, verifyCommand: `npx tsx scripts/verify-receipt.ts ${o.id}.json --signer ${o.observer.address}` }));
    const chain = o.payment.network;
    counts[chain] ??= {};
    counts[chain]![o.verdict.code] = (counts[chain]![o.verdict.code] ?? 0) + 1;
  }
  let simulation: unknown = "not run (pass --simulate-anchor)";
  if (simulate) {
    try {
      simulation = { feePayer: PAYER_ADDRESS, note: "unsigned, sigVerify:false, replaceRecentBlockhash:true; nothing was sent", ...(await simulateMemoAnchor(rpc, PAYER_ADDRESS, memo)) };
    } catch (e) {
      simulation = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  const plan = { day: d, network: SOLANA_MAINNET, memo, memoBytes: new TextEncoder().encode(memo).length, root: tree.root, count: obs.length, sequenceRange: seq, simulation };
  writeFileSync(join(tmp, "anchor-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  writeFileSync(
    join(tmp, "index.json"),
    `${JSON.stringify({ day: d, root: tree.root, count: obs.length, countsByNetwork: counts, records: obs.map((o) => ({ id: o.id, network: o.payment.network, verdict: o.verdict.code, resourceUrl: o.resourceUrl })) }, null, 2)}\n`,
  );
  if (day !== undefined) {
    writeFileSync(join(tmp, "skipped.json"), `${JSON.stringify(skips, null, 2)}\n`);
    const ds: DaySources = { kind: SOURCES_KIND, version: 1, day: d, openDay, builtAt: new Date().toISOString(), files: sources };
    writeFileSync(join(tmp, "sources.json"), `${JSON.stringify(ds, null, 2)}\n`);
  }
  renameSync(tmp, dir);
  summary[d] = { count: obs.length, sequenceRange: seq, countsByNetwork: counts, root: tree.root, simulation };
}

const didPath = join(outDir, "did.json");
const did = `${JSON.stringify(
  {
    "@context": ["https://www.w3.org/ns/did/v1"],
    id: "did:web:vet402.com",
    verificationMethod: [{ id: OBSERVER_ID, type: "EcdsaSecp256k1RecoveryMethod2020", controller: "did:web:vet402.com", blockchainAccountId: `eip155:1:${account.address}` }],
    assertionMethod: [OBSERVER_ID],
  },
  null,
  2,
)}\n`;
if (!existsSync(didPath) || readFileSync(didPath, "utf8") !== did) writeFileSync(didPath, did);
if (day === undefined) writeFileSync(join(outDir, "skipped.json"), `${JSON.stringify(skips, null, 2)}\n`);
console.log(JSON.stringify({ observer: account.address, byChain, records: signed.length, skipped: skips.length, days: summary }, null, 2));
