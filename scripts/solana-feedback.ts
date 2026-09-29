/**
 * 8004-solana feedback (the Solana port of ERC-8004) for sellers vet402 paid on Solana, written from the
 * wallet that paid (src/solana-feedback/).
 *
 *   npx tsx scripts/solana-feedback.ts                     # --dry-run (default): targets, values, gates; reads only
 *   npx tsx scripts/solana-feedback.ts --simulate          # also simulateTransaction on mainnet, unsigned
 *   VET402_SOLANA_FEEDBACK_WRITE=yes npx tsx scripts/solana-feedback.ts --send   # sign and send (max 2)
 *
 * Options: --pin <host>=<asset>   choose the agent when the payTo owns several; only one the seller named
 *          --receipts <dir>       local receipts build, to name records not published yet
 *                                 (default ~/vet402-solana-receipt/results/receipts)
 *
 * Targets: a seller whose 8004-solana agent is owned (Core asset owner) by the payTo vet402 paid.
 * Values: value 0 / no score / tags x402-delivery, paid-not-delivered when every settled purchase on at
 * least two days came back undelivered (value 1 / no score / delivered for the opposite); mixed results
 * are not written. feedback_uri is the published vet402 record of the purchase, feedback_file_hash its sha256.
 * --send refuses unless every gate passes: the purchase is a finalized USDC transfer from this wallet to
 * the payTo, the record is public with the same sha256, the Core asset owner is the payTo, this wallet has
 * no feedback for the agent on chain or in results/solana-feedback-ledger.json, a fresh simulate passes
 * and the fee is at most 10,000 lamports. The transaction holds one give_feedback and nothing else.
 * RPC: SOLANA_RPC_URL (default api.mainnet-beta.solana.com).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { jsonRpc } from "../src/chain.js";
import { loadPayer } from "../src/client.js";
import { PAYER_ADDRESS } from "../src/constants.js";
import { loadPublishedRecords } from "../src/receipt/publish.js";
import { agentsByOwner } from "../src/solana-feedback/chain.js";
import { MAX_FEE_LAMPORTS, MAX_WRITES_PER_RUN, normalizePurchases, type Purchase } from "../src/solana-feedback/plan.js";
import { plan, send, simulate } from "../src/solana-feedback/run.js";
import { REGISTRY_PROGRAM } from "../src/solana-feedback/registry.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const values = (name: string): string[] => args.flatMap((a, i) => (a === name ? [args[i + 1] ?? ""] : []));
const modes = ["--dry-run", "--simulate", "--send"].filter(has);
if (modes.length > 1) throw new Error("choose one of --dry-run / --simulate / --send");
const mode = (modes[0] ?? "--dry-run").slice(2) as "dry-run" | "simulate" | "send";
if (mode === "send" && process.env.VET402_SOLANA_FEEDBACK_WRITE !== "yes") throw new Error("--send also needs VET402_SOLANA_FEEDBACK_WRITE=yes (set only after the owner approved the text and the independent review)");

const pins = new Map<string, string>();
for (const p of values("--pin")) {
  const m = /^([a-z0-9.-]+)=([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(p);
  if (!m) throw new Error(`--pin wants host=asset, got "${p}"`);
  pins.set(m[1]!, m[2]!);
}
const receiptsDir = resolve(values("--receipts")[0] ?? join(homedir(), "vet402-solana-receipt", "results", "receipts"));

// ---------- inputs: vet402's Solana purchases, each file checked against data/manifest.json ----------
const DATA = join(ROOT, "data");
const manifest = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8")) as { files: { label: string; path: string; sha256: string }[] };
const purchases: Purchase[] = [];
const sources: string[] = [];
for (const f of manifest.files.filter((x) => /^(solana\/census-|solana\/gate1-|remeasure\/solana-)/.test(x.label))) {
  const text = readFileSync(join(DATA, f.path), "utf8");
  if (createHash("sha256").update(text).digest("hex") !== f.sha256) throw new Error(`data/${f.path}: sha256 differs from the manifest`);
  purchases.push(...normalizePurchases(JSON.parse(text), f.label, PAYER_ADDRESS));
  sources.push(f.label);
}

const rpc = jsonRpc(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com");
const deps = {
  rpc,
  client: PAYER_ADDRESS,
  purchases,
  published: await loadPublishedRecords(join(DATA, "records")),
  receiptsDir,
  agentsOwnedBy: await agentsByOwner(rpc),
  pins,
  ledgerPath: join(ROOT, "results", "solana-feedback-ledger.json"),
  loadSigner: () => loadPayer(join(ROOT, ".keys", "payer.json")), // mode 600, address must be PAYER_ADDRESS
  log: (l: string) => console.error(l),
};

const items = await plan(deps);
const doc: Record<string, unknown> = {
  generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
  mode,
  registry: REGISTRY_PROGRAM,
  writer: PAYER_ADDRESS,
  inputs: sources,
  limits: { maxWritesPerRun: MAX_WRITES_PER_RUN, maxFeeLamports: MAX_FEE_LAMPORTS },
  pins: Object.fromEntries(pins),
  items: items.map((x) => x.item),
};
if (mode === "simulate") doc.simulation = await simulate(deps, items);
if (mode === "send") doc.sent = await send(deps, items);
mkdirSync(join(ROOT, "results"), { recursive: true });
if (mode !== "send") writeFileSync(join(ROOT, "results", `solana-feedback-${mode}.json`), `${JSON.stringify(doc, null, 2)}\n`);
console.log(JSON.stringify(doc, null, 2));
if (mode !== "send") console.error(`${mode}: nothing was signed or sent`);
