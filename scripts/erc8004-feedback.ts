/**
 * ERC-8004 feedback for sellers vet402 paid on an EVM chain, written from the address that paid
 * (src/evm/rep-plan.ts, src/evm/rep-run.ts).
 *
 *   npx tsx scripts/erc8004-feedback.ts --chain tempo                  # --dry-run (default): targets, values, gates; reads only
 *   npx tsx scripts/erc8004-feedback.ts --chain tempo --simulate       # also eth_call + eth_estimateGas, nothing signed
 *   npx tsx scripts/erc8004-feedback.ts --chain tempo --simulate --measure 1   # gas and fee against agent 1 (never a target)
 *   VET402_ERC8004_FEEDBACK_WRITE=yes npx tsx scripts/erc8004-feedback.ts --chain tempo --send   # sign and send (max 2)
 *
 * --chain base | tempo | robinhood | arbitrum | all
 * --pin <payTo>=<agentId>  for a payTo that serves several hosts (a marketplace or proxy): confirms which
 *                         agent is the seller. It must be the agent whose agentWallet is that payTo.
 * Inputs (each checked against data/manifest.json): base/purchases, tempo/ledger, remeasure/<chain>-*.
 * A chain with no input has no target and reads nothing.
 * RPC: BASE_RPC_URL, TEMPO_RPC_URL, ROBINHOOD_RPC_URL, ARBITRUM_RPC_URL.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPublishedRecords } from "../src/receipt/publish.js";
import { EXPECTED_ADDRESS, loadEvmAccount, readPublicAddress } from "../src/evm/key.js";
import { MAX_WRITES_PER_RUN, normalizeEvmPurchases, REP_CHAIN_KEYS, type EvmPurchase, type RepChainKey } from "../src/evm/rep-plan.js";
import { chainReader, chainSender, measure, plan, repChain, send, simulate, type RepDeps } from "../src/evm/rep-run.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const valueOf = (name: string): string | undefined => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const modes = ["--dry-run", "--simulate", "--send"].filter(has);
if (modes.length > 1) throw new Error("choose one of --dry-run / --simulate / --send");
const mode = (modes[0] ?? "--dry-run").slice(2) as "dry-run" | "simulate" | "send";
if (mode === "send" && process.env.VET402_ERC8004_FEEDBACK_WRITE !== "yes") throw new Error("--send also needs VET402_ERC8004_FEEDBACK_WRITE=yes (set only after the owner's approval and the independent review)");
const chainArg = valueOf("--chain");
if (!chainArg) throw new Error("--chain base|tempo|robinhood|arbitrum|all");
const chains: RepChainKey[] = chainArg === "all" ? [...REP_CHAIN_KEYS] : [chainArg as RepChainKey];
if (!chains.every((c) => REP_CHAIN_KEYS.includes(c))) throw new Error(`unknown chain ${chainArg}`);
const measureArg = valueOf("--measure");
if (measureArg !== undefined && (mode !== "simulate" || !/^\d+$/.test(measureArg))) throw new Error("--measure <agentId> goes with --simulate");
if (mode === "send" && chains.length !== 1) throw new Error("--send takes one chain");
const pins = new Map<string, string>();
args.forEach((a, i) => {
  if (a !== "--pin") return;
  const m = /^(0x[0-9a-fA-F]{40})=(\d+)$/.exec(args[i + 1] ?? "");
  if (!m) throw new Error(`--pin wants <payTo>=<agentId>, got "${args[i + 1]}"`);
  pins.set(m[1]!.toLowerCase(), m[2]!);
});

// ---------- inputs ----------
const DATA = join(ROOT, "data");
const manifest = JSON.parse(readFileSync(join(DATA, "manifest.json"), "utf8")) as { files: { label: string; path: string; sha256: string }[] };
const writer = mode === "send" ? readPublicAddress() : EXPECTED_ADDRESS; // the payer; dry runs read no key directory

function inputsFor(chain: RepChainKey): { purchases: EvmPurchase[]; sources: string[] } {
  const want = chain === "base" ? /^base\/purchases$/ : chain === "tempo" ? /^(tempo\/ledger|remeasure\/tempo-.+)$/ : new RegExp(`^(${chain}\\/.+|remeasure\\/${chain}-.+)$`);
  const purchases: EvmPurchase[] = [];
  const sources: string[] = [];
  for (const f of manifest.files.filter((x) => want.test(x.label))) {
    const text = readFileSync(join(DATA, f.path), "utf8");
    if (createHash("sha256").update(text).digest("hex") !== f.sha256) throw new Error(`data/${f.path}: sha256 differs from the manifest`);
    const parsed = f.path.endsWith(".jsonl") ? text.split("\n").filter(Boolean).map((l) => JSON.parse(l)) : JSON.parse(text);
    purchases.push(...normalizeEvmPurchases(parsed, f.label, writer));
    sources.push(f.label);
  }
  return { purchases, sources };
}

/** agentIds the first Base writer (scripts/base-feedback.ts) already wrote. */
function priorFor(chain: RepChainKey): Set<string> {
  if (chain !== "base") return new Set();
  const l = JSON.parse(readFileSync(join(DATA, "base", "feedback-ledger.json"), "utf8")) as Record<string, { agentId: string }>;
  return new Set(Object.values(l).map((x) => x.agentId));
}

const published = await loadPublishedRecords(join(DATA, "records"));
mkdirSync(join(ROOT, "results"), { recursive: true });
const docs: Record<string, unknown>[] = [];
for (const chain of chains) {
  const cfg = repChain(chain);
  const { purchases, sources } = inputsFor(chain);
  const deps: RepDeps = {
    chain: cfg,
    reader: chainReader(cfg),
    writer,
    purchases,
    published,
    ledgerPath: join(ROOT, "results", "erc8004-feedback-ledger.json"),
    priorAgentIds: priorFor(chain),
    pins,
    sender: mode === "send" ? chainSender(cfg, () => loadEvmAccount()) : undefined,
    log: (l) => console.error(l),
  };
  const items = await plan(deps);
  const doc: Record<string, unknown> = {
    generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    mode,
    chain,
    chainId: cfg.chainId,
    writer,
    pins: Object.fromEntries(pins),
    inputs: sources,
    purchases: purchases.length,
    sellers: new Set(purchases.map((p) => p.payTo)).size,
    limits: { maxWritesPerRun: MAX_WRITES_PER_RUN, feeCap: cfg.fee.cap.toString(), feeUnit: cfg.fee.kind === "tip20" ? `${cfg.fee.symbol} atomic` : "wei" },
    targets: items.filter((x) => x.item.status === "writable").length,
    withAgent: items.filter((x) => x.item.agent.agentId !== null).length,
    items: items.map((x) => x.item),
  };
  if (mode === "simulate") doc.simulation = await simulate(deps, items);
  if (mode === "simulate" && measureArg !== undefined) doc.measurement = await measure(deps, BigInt(measureArg));
  if (mode === "send") doc.sent = await send(deps, items);
  if (mode !== "send") writeFileSync(join(ROOT, "results", `erc8004-feedback-${chain}-${mode}.json`), `${JSON.stringify(doc, null, 2)}\n`);
  docs.push(doc);
}
console.log(JSON.stringify(docs.length === 1 ? docs[0] : docs, null, 2));
if (mode !== "send") console.error(`${mode}: nothing was signed or sent`);
