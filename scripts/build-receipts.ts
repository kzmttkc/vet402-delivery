/**
 * Build, sign and root x402-observation/v0 records from purchase runs vet402 already made.
 * Reads result files, writes JSON + HTML per record. No payment, no sending. The daily anchor is
 * only simulated (--simulate-anchor): an unsigned memo transaction, sigVerify off.
 *
 *   npx tsx scripts/build-receipts.ts --key <attest.json> \
 *     --solana <census.json> --tempo <tempo-ledger.json> --base <base-purchases.jsonl> \
 *     --out results/receipts [--simulate-anchor]
 *
 * Output (results/ is local; negative records name sellers and are not published before the seller
 * is told, so this directory is git-ignored; scripts/publish-records.ts copies the publishable ones to
 * data/records/, and scripts/anchor-receipts.ts writes a day's root on Solana):
 *   <out>/<day>/<id>.json, <id>.html, index.json, anchor-plan.json
 *   <out>/private/salts.json (mode 600): the params_hash salts, disclosed only to parties in a dispute
 *   <out>/did.json: the did:web document to publish at https://vet402.com/.well-known/did.json
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import { jsonRpc } from "../src/chain.js";
import { PAYER_ADDRESS, SOLANA_MAINNET } from "../src/constants.js";
import { simulateMemoAnchor } from "../src/receipt/anchor.js";
import {
  assemble,
  factsFromBasePurchases,
  factsFromSolanaCensus,
  factsFromTempoLedger,
  type BasePurchase,
  type Facts,
  type Skip,
  type SolanaCensus,
  type TempoLedger,
} from "../src/receipt/build.js";
import { observationDigest, signObservation } from "../src/receipt/eip712.js";
import { renderObservationPage } from "../src/receipt/html.js";
import { anchorMemo, buildTree } from "../src/receipt/merkle.js";
import { validateObservation } from "../src/receipt/schema.js";
import type { Observation } from "../src/receipt/types.js";
import { verifyOffline } from "../src/receipt/verify.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const keyPath = arg("--key");
const outDir = arg("--out") ?? "results/receipts";
if (!keyPath) {
  console.error("--key <attest.json> is required");
  process.exit(2);
}
const account = privateKeyToAccount((JSON.parse(readFileSync(keyPath, "utf8")) as { privateKey: Hex }).privateKey);
const OBSERVER_ID = "did:web:vet402.com#obs-key-2026-09";
const observer = { id: OBSERVER_ID, address: account.address };

// ---------- facts ----------
const facts: Facts[] = [];
const skips: Skip[] = [];
const byChain: Record<string, { facts: number; skipped: number }> = {};
function take(chain: string, r: { facts: Facts[]; skips: Skip[] }) {
  facts.push(...r.facts);
  skips.push(...r.skips);
  byChain[chain] = { facts: r.facts.length, skipped: r.skips.length };
}
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

// Stable order: time, then dataset/row. Sequence numbers follow this order.
facts.sort((a, b) => (a.observedAt === b.observedAt ? `${a.dataset}#${a.row}`.localeCompare(`${b.dataset}#${b.row}`) : a.observedAt < b.observedAt ? -1 : 1));

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
  const o = assemble(f, i + 1, observer, salts[`${f.dataset}#${f.row}`]!, issuedAt);
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
for (const [day, obs] of days) {
  const tree = buildTree(obs.map((o) => observationDigest(o)));
  const seq: [number, number] = [obs[0]!.observer.sequence, obs[obs.length - 1]!.observer.sequence];
  const memo = anchorMemo({ day, root: tree.root, count: obs.length, sequenceRange: seq, observerAddress: account.address });
  const dir = join(outDir, day);
  mkdirSync(dir, { recursive: true });
  const counts: Record<string, Record<string, number>> = {};
  for (const [i, o] of obs.entries()) {
    o.anchor = {
      status: "pending",
      day,
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
    writeFileSync(join(dir, `${o.id}.json`), `${JSON.stringify(o, null, 2)}\n`);
    writeFileSync(join(dir, `${o.id}.html`), renderObservationPage(o, { jsonHref: `${o.id}.json`, verifyCommand: `npx tsx scripts/verify-receipt.ts ${o.id}.json --signer ${o.observer.address}` }));
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
  const plan = { day, network: SOLANA_MAINNET, memo, memoBytes: new TextEncoder().encode(memo).length, root: tree.root, count: obs.length, sequenceRange: seq, simulation };
  writeFileSync(join(dir, "anchor-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  writeFileSync(
    join(dir, "index.json"),
    `${JSON.stringify({ day, root: tree.root, count: obs.length, countsByNetwork: counts, records: obs.map((o) => ({ id: o.id, network: o.payment.network, verdict: o.verdict.code, resourceUrl: o.resourceUrl })) }, null, 2)}\n`,
  );
  summary[day] = { count: obs.length, countsByNetwork: counts, root: tree.root, simulation };
}

writeFileSync(
  join(outDir, "did.json"),
  `${JSON.stringify(
    {
      "@context": ["https://www.w3.org/ns/did/v1"],
      id: "did:web:vet402.com",
      verificationMethod: [{ id: OBSERVER_ID, type: "EcdsaSecp256k1RecoveryMethod2020", controller: "did:web:vet402.com", blockchainAccountId: `eip155:1:${account.address}` }],
      assertionMethod: [OBSERVER_ID],
    },
    null,
    2,
  )}\n`,
);
writeFileSync(join(outDir, "skipped.json"), `${JSON.stringify(skips, null, 2)}\n`);
console.log(JSON.stringify({ observer: account.address, byChain, records: signed.length, skipped: skips.length, days: summary }, null, 2));
