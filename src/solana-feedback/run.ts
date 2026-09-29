/**
 * Plan, simulate and (only with --send) write vet402's 8004-solana feedback. Everything outside the
 * process comes in through FeedbackDeps, so the tests run it against a fake chain and a fake site.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { getBase64EncodedWireTransaction, getSignatureFromTransaction, signTransaction, type KeyPairSigner } from "@solana/kit";
import type { Rpc } from "../chain.js";
import type { LoadedRecords } from "../receipt/publish.js";
import type { Observation } from "../receipt/types.js";
import { balanceLamports, findExistingFeedback, readAgent, readPurchase, simulateFeedback, type AgentRead, type PurchaseRead, type SimulateRead } from "./chain.js";
import {
  chooseAgent,
  feedbackValues,
  groupByPayTo,
  MAX_FEE_LAMPORTS,
  MAX_WRITES_PER_RUN,
  outcomeOf,
  refusals,
  type GateChecks,
  type OutcomeSummary,
  type Purchase,
} from "./plan.js";
import { fetchRecord, localRecordFor, publishedRecordFor, recordVerifies, type Fetched, type RecordFound } from "./records.js";
import { compileGiveFeedbackTx, unsignedWire, type FeedbackAccounts, type GiveFeedbackArgs } from "./registry.js";

export interface FeedbackDeps {
  rpc: Rpc;
  fetchImpl?: typeof fetch;
  /** vet402's Solana payer: the wallet that paid and the only wallet that may write. */
  client: string;
  purchases: Purchase[];
  /** data/records/, already checked by loadPublishedRecords. */
  published: LoadedRecords;
  /** A local receipts build, to name records that are not published yet. */
  receiptsDir: string | null;
  /** payTo -> agents whose registry account caches that owner (from agentsByOwner). */
  agentsOwnedBy: Map<string, { asset: string; pda: string }[]>;
  /** host -> asset chosen by the operator when a payTo owns several agents. */
  pins: Map<string, string>;
  ledgerPath: string;
  /** Offline check of a record (schema, vet402 signature, verdict, Merkle proof). Default: recordVerifies. */
  verifyRecord?: (o: Observation) => Promise<boolean>;
  loadSigner?: () => Promise<KeyPairSigner>;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  pollTries?: number;
}

export interface LedgerEntry {
  status: "sending" | "confirmed" | "failed" | "expired" | "pending";
  signature: string;
  asset: string;
  payTo: string;
  hosts: string[];
  purchaseTx: string;
  recordId: string;
  feedbackUri: string;
  feedbackFileHash: string;
  lastValidBlockHeight: string;
  at: string;
}
export type Ledger = Record<string, LedgerEntry>;

export function readLedger(path: string): Ledger {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Ledger) : {};
}

export interface PlanItem {
  hosts: string[];
  payTo: string;
  purchases: { day: string; tx: string; httpStatus: number | null; settled: boolean; delivered: boolean; source: string }[];
  outcome: OutcomeSummary;
  agent: {
    candidates: string[];
    asset: string | null;
    detail: string;
    pda: string | null;
    cachedOwner: string | null;
    coreOwner: string | null;
    collection: string | null;
    atomEnabled: boolean | null;
    agentWallet: string | null;
    feedbackCount: string | null;
  };
  purchaseProof: (Omit<PurchaseRead, "clientDeltaAtomic" | "payToDeltaAtomic"> & { clientDeltaAtomic: string | null; payToDeltaAtomic: string | null }) | null;
  record: { id: string; day: string; published: boolean; uri: string; uriBytes: number; sha256: string; indexSha256: string | null; fetched: Fetched | null; verifiesOffline: boolean } | null;
  args: { value: string; valueDecimals: number; score: number | null; tag1: string; tag2: string; endpoint: string; feedbackUri: string; feedbackFileHash: string } | null;
  existingOnChain: { count: number | null; signatures: string[] } | null;
  inLedger: boolean;
  refusals: string[];
  status: "writable" | "refused";
  /** Set when the item cannot be written because its record is not public yet. */
  note: string | null;
}

interface Internal {
  item: PlanItem;
  accounts: FeedbackAccounts | null;
  gfArgs: GiveFeedbackArgs | null;
  record: RecordFound | null;
}

const hex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const endpointOf = (u: string) => {
  const x = new URL(u);
  return `${x.origin}${x.pathname}`;
};

/** Build the plan: targets, the values to write, and every gate, read from the chain and the site now. */
export async function plan(d: FeedbackDeps): Promise<Internal[]> {
  const ledger = readLedger(d.ledgerPath);
  const out: Internal[] = [];
  for (const [payTo, ps] of groupByPayTo(d.purchases)) {
    const owned = d.agentsOwnedBy.get(payTo);
    if (!owned || owned.length === 0) continue; // not a registered seller: not a target
    const hosts = [...new Set(ps.map((p) => p.host))].sort();
    const pinned = hosts.map((h) => d.pins.get(h)).filter((x): x is string => !!x);
    if (pinned.length > 1 && new Set(pinned).size > 1) throw new Error(`conflicting pins for ${hosts.join(", ")}`);
    const choice = chooseAgent(owned.map((o) => o.asset), pinned[0]);
    const oc = outcomeOf(ps);
    const settledTxs = ps.filter((p) => p.settled).map((p) => p.tx);

    // The proof: the latest published record of one of these purchases; else name the local one.
    const pub = publishedRecordFor(d.published, settledTxs);
    const local = pub ? null : d.receiptsDir ? localRecordFor(d.receiptsDir, settledTxs) : null;
    const rec = pub ?? local;
    const evidence = rec ? ps.find((p) => p.tx === rec.obs.payment.transaction)! : ps.filter((p) => p.settled).at(-1) ?? null;

    let ar: AgentRead | null = null;
    if (choice.asset) ar = await readAgent(d.rpc, choice.asset);
    const pr = evidence ? await readPurchase(d.rpc, evidence.tx, d.client, payTo) : null;
    const fetched = pub ? await fetchRecord(pub.uri, d.fetchImpl) : null;
    const verifies = rec ? await (d.verifyRecord ?? recordVerifies)(rec.obs) : false;
    const existing = ar && choice.asset ? await findExistingFeedback(d.rpc, d.client, ar.pda, choice.asset) : null;

    const values = oc.outcome ? feedbackValues(oc.outcome) : null;
    const endpoint = rec ? endpointOf(rec.obs.resourceUrl) : evidence ? endpointOf(evidence.url) : "";
    const gfArgs: GiveFeedbackArgs | null = values && rec ? { ...values, endpoint, feedbackUri: rec.uri, feedbackFileHash: hex(rec.sha256) } : null;

    const checks: GateChecks = {
      client: d.client,
      payTo,
      outcome: oc.outcome,
      agent: choice.asset ? { asset: choice.asset, pdaMatches: ar?.pdaMatches ?? null, cachedOwner: ar?.agent?.owner ?? null, coreOwner: ar?.coreOwner ?? null } : null,
      purchase: pr,
      record: rec
        ? {
            id: rec.id,
            published: rec.published,
            fetchedOk: fetched ? fetched.ok : null,
            fetchedSha256: fetched?.sha256 ?? null,
            indexSha256: rec.indexSha256,
            hashToWrite: rec.sha256,
            paymentTx: rec.obs.payment.transaction,
            payer: rec.obs.payment.payer,
            payTo: rec.obs.payment.payTo,
            verdict: rec.obs.verdict.code,
            verifiesOffline: verifies,
          }
        : null,
      args: gfArgs ? { uri: gfArgs.feedbackUri, endpoint: gfArgs.endpoint, tag1: gfArgs.tag1, tag2: gfArgs.tag2 } : null,
      existingOnChain: existing ? existing.count : null,
      inLedger: !!(choice.asset && ledger[choice.asset]),
    };
    const why = refusals(checks);
    const item: PlanItem = {
      hosts,
      payTo,
      purchases: ps.map((p) => ({ day: p.day, tx: p.tx, httpStatus: p.httpStatus, settled: p.settled, delivered: p.delivered, source: p.source })),
      outcome: oc,
      agent: {
        candidates: choice.candidates,
        asset: choice.asset,
        detail: choice.detail,
        pda: ar?.pda ?? null,
        cachedOwner: ar?.agent?.owner ?? null,
        coreOwner: ar?.coreOwner ?? null,
        collection: ar?.agent?.collection ?? null,
        atomEnabled: ar?.agent?.atomEnabled ?? null,
        agentWallet: ar?.agent?.agentWallet ?? null,
        feedbackCount: ar?.agent ? ar.agent.feedbackCount.toString() : null,
      },
      purchaseProof: pr ? { ...pr, clientDeltaAtomic: pr.clientDeltaAtomic?.toString() ?? null, payToDeltaAtomic: pr.payToDeltaAtomic?.toString() ?? null } : null,
      record: rec
        ? { id: rec.id, day: rec.day, published: rec.published, uri: rec.uri, uriBytes: new TextEncoder().encode(rec.uri).length, sha256: rec.sha256, indexSha256: rec.indexSha256, fetched, verifiesOffline: verifies }
        : null,
      args: gfArgs
        ? { value: gfArgs.value.toString(), valueDecimals: gfArgs.valueDecimals, score: gfArgs.score, tag1: gfArgs.tag1, tag2: gfArgs.tag2, endpoint: gfArgs.endpoint, feedbackUri: gfArgs.feedbackUri, feedbackFileHash: rec!.sha256 }
        : null,
      existingOnChain: existing ? { count: existing.count, signatures: existing.signatures } : null,
      inLedger: checks.inLedger,
      refusals: why,
      status: why.length === 0 ? "writable" : "refused",
      note: rec && !rec.published ? `record not published: ${rec.id} exists in the local build but data/records/ does not publish it (a NOT_DELIVERED record is published only after the seller is in data/records/notified.json); cannot be written` : null,
    };
    const accounts = ar?.agent && choice.asset ? { client: d.client, agentPda: ar.pda, asset: choice.asset, collection: ar.agent.collection } : null;
    out.push({ item, accounts, gfArgs, record: rec });
  }
  return out;
}

export interface SimItem {
  hosts: string[];
  asset: string | null;
  simulated: boolean;
  /** true when the URI/hash are of a record that is not public yet (the chain does not fetch it, so the simulation is unchanged). */
  provisionalRecord: boolean;
  detail: string;
  result: SimulateRead | null;
  feeCapLamports: number;
  feeWithinCap: boolean | null;
  programLog: string | null;
}

/** simulateTransaction for every item that has an agent and a record (published or, flagged, not). */
export async function simulate(d: FeedbackDeps, items: Internal[]): Promise<SimItem[]> {
  const bh = (await d.rpc("getLatestBlockhash", [{ commitment: "confirmed" }])) as { value: { blockhash: string; lastValidBlockHeight: number } };
  const out: SimItem[] = [];
  for (const x of items) {
    const base = { hosts: x.item.hosts, asset: x.item.agent.asset, feeCapLamports: MAX_FEE_LAMPORTS };
    if (!x.accounts || !x.gfArgs) {
      out.push({ ...base, simulated: false, provisionalRecord: false, detail: !x.accounts ? "no agent chosen or agent not readable" : "no record or no outcome", result: null, feeWithinCap: null, programLog: null });
      continue;
    }
    const wire = unsignedWire(x.accounts, x.gfArgs, bh.value.blockhash, BigInt(bh.value.lastValidBlockHeight));
    const r = await simulateFeedback(d.rpc, wire);
    const provisional = !x.record!.published;
    out.push({
      ...base,
      simulated: true,
      provisionalRecord: provisional,
      detail: provisional
        ? `simulated with the record that is not published yet (${x.record!.id}): its future URI and the sha256 of the local signed file. The program does not fetch the URI, so the simulation holds; a write still needs the record published.`
        : "simulated with the published record",
      result: r,
      feeWithinCap: r.feeLamports === null ? null : r.feeLamports <= MAX_FEE_LAMPORTS,
      programLog: r.logs.find((l) => l.includes("Feedback #")) ?? null,
    });
  }
  return out;
}

export interface SendResult {
  hosts: string[];
  asset: string | null;
  sent: boolean;
  signature: string | null;
  status: string;
}

/**
 * Write the items whose gates all pass, at most MAX_WRITES_PER_RUN, each only after a fresh simulate
 * within the fee cap, and each recorded in the ledger before it leaves this machine.
 */
export async function send(d: FeedbackDeps, items: Internal[]): Promise<SendResult[]> {
  if (!d.loadSigner) throw new Error("no signer");
  const out: SendResult[] = [];
  let written = 0;
  for (const x of items) {
    const res = (status: string, extra: Partial<SendResult> = {}): SendResult => ({ hosts: x.item.hosts, asset: x.item.agent.asset, sent: false, signature: null, status, ...extra });
    if (x.item.status !== "writable" || !x.accounts || !x.gfArgs || !x.record?.published) {
      out.push(res(`refused: ${x.item.refusals.join("; ") || "no record"}`));
      continue;
    }
    if (written >= MAX_WRITES_PER_RUN) {
      out.push(res(`refused: at most ${MAX_WRITES_PER_RUN} writes per run`));
      continue;
    }
    // Re-read right before signing: the chain, the ledger and the public file may have changed.
    const again = await findExistingFeedback(d.rpc, d.client, x.accounts.agentPda, x.accounts.asset);
    if (again.count !== 0) {
      out.push(res(again.count === null ? "refused: could not read the history" : `refused: already written (${again.signatures.join(", ")})`));
      continue;
    }
    const ledger = readLedger(d.ledgerPath);
    if (ledger[x.accounts.asset]) {
      out.push(res(`refused: ledger already has ${ledger[x.accounts.asset]!.signature} (${ledger[x.accounts.asset]!.status})`));
      continue;
    }
    const f = await fetchRecord(x.record.uri, d.fetchImpl);
    if (!f.ok || f.sha256 !== x.record.sha256) {
      out.push(res(`refused: public record ${x.record.uri} ${f.ok ? "hash changed" : f.detail}`));
      continue;
    }
    const bh = (await d.rpc("getLatestBlockhash", [{ commitment: "confirmed" }])) as { value: { blockhash: string; lastValidBlockHeight: number } };
    const lvbh = BigInt(bh.value.lastValidBlockHeight);
    const tx = compileGiveFeedbackTx(x.accounts, x.gfArgs, bh.value.blockhash, lvbh); // asserts the one-instruction shape
    const sim = await simulateFeedback(d.rpc, getBase64EncodedWireTransaction(tx));
    if (!sim.ok) {
      out.push(res(`refused: simulate failed ${JSON.stringify(sim.err)}`));
      continue;
    }
    if (sim.feeLamports === null || sim.feeLamports > MAX_FEE_LAMPORTS) {
      out.push(res(`refused: fee ${sim.feeLamports} lamports over the cap ${MAX_FEE_LAMPORTS}`));
      continue;
    }
    if ((await balanceLamports(d.rpc, d.client)) < BigInt(sim.feeLamports) * 2n) {
      out.push(res("refused: SOL balance below twice the fee"));
      continue;
    }
    const signer = await d.loadSigner();
    if (signer.address !== d.client) throw new Error(`key ${signer.address} is not the paying wallet ${d.client}`);
    const signed = await signTransaction([signer.keyPair], tx);
    const signature = getSignatureFromTransaction(signed);
    const entry: LedgerEntry = {
      status: "sending",
      signature,
      asset: x.accounts.asset,
      payTo: x.item.payTo,
      hosts: x.item.hosts,
      purchaseTx: x.record.obs.payment.transaction,
      recordId: x.record.id,
      feedbackUri: x.gfArgs.feedbackUri,
      feedbackFileHash: x.record.sha256,
      lastValidBlockHeight: lvbh.toString(),
      at: new Date().toISOString(),
    };
    ledger[x.accounts.asset] = entry;
    writeFileSync(d.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`); // before anything leaves
    written++;
    await d.rpc("sendTransaction", [getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5 }]);
    const status = await waitFor(d, signature, lvbh);
    ledger[x.accounts.asset] = { ...entry, status };
    writeFileSync(d.ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`);
    out.push(res(status, { sent: true, signature }));
    d.log?.(`${x.item.hosts.join(",")}: ${signature} ${status}`);
  }
  return out;
}

async function waitFor(d: FeedbackDeps, signature: string, lastValidBlockHeight: bigint): Promise<LedgerEntry["status"]> {
  const sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < (d.pollTries ?? 60); i++) {
    await sleep(2000);
    const st = (await d.rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }])) as { value: ({ err: unknown; confirmationStatus: string | null } | null)[] };
    const s = st.value[0];
    if (s?.err) return "failed";
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) return "confirmed";
    const height = (await d.rpc("getBlockHeight", [{ commitment: "confirmed" }])) as number;
    if (BigInt(height) > lastValidBlockHeight) {
      // one last look: it may have landed just before the blockhash expired
      const last = (await d.rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }])) as { value: ({ err: unknown; confirmationStatus: string | null } | null)[] };
      const l = last.value[0];
      return l ? (l.err ? "failed" : "confirmed") : "expired";
    }
  }
  return "pending";
}

