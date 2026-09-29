/**
 * Which vet402 Solana purchases may become 8004-solana feedback, what the feedback says, and the
 * checks that must all pass before anything is written. Pure: no RPC, no file, no key.
 *
 * Rule (same as the Base writer): only a purchase vet402 paid for itself and that settled on chain;
 * only a seller whose registered agent is owned by the payTo vet402 paid; written from the wallet that
 * paid; the proof is the published vet402 record at feedback_uri, pinned by feedback_file_hash.
 */
import { PUBLIC_SITE_URL } from "../receipt/site.js";
import { MAX_ENDPOINT_BYTES, MAX_TAG_BYTES, MAX_URI_BYTES, type GiveFeedbackArgs } from "./registry.js";

/** At most this many feedback writes in one run. */
export const MAX_WRITES_PER_RUN = 2;
/** Per transaction: one signature, no priority fee, is 5,000 lamports. Above this nothing is signed. */
export const MAX_FEE_LAMPORTS = 10_000;
/** A result is written only after vet402 saw the same outcome on at least this many days. */
export const MIN_DAYS = 2;

export const TAG1 = "x402-delivery";
export type Outcome = "paid-not-delivered" | "delivered";

/** One vet402 purchase on Solana, from any of the data/ inputs. */
export interface Purchase {
  source: string;
  day: string;
  at: string;
  host: string;
  url: string;
  payTo: string;
  tx: string;
  settled: boolean;
  delivered: boolean;
  httpStatus: number | null;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const hostOf = (u: string): string => new URL(u).host.toLowerCase();

/** census-live rows, remeasure rows, gate1 records: the purchases vet402's payer actually sent. */
export function normalizePurchases(file: { kind?: string; payer?: string; ranAt?: string; rows?: Row[]; records?: Row[] }, source: string, payer: string): Purchase[] {
  if (file.payer !== payer) throw new Error(`${source}: payer ${file.payer} is not ${payer}`);
  const out: Purchase[] = [];
  if (file.kind === "census-live" || file.kind === "vet402-remeasure") {
    for (const r of file.rows ?? []) {
      const tx = str(r.signature) ?? str(r.tx);
      const url = str(r.url) ?? str(r.requestUrl);
      const payTo = str(r.payTo);
      const at = str(r.at);
      if (!tx || !url || !payTo || !at) continue;
      if (file.kind === "vet402-remeasure" && r.outcome !== "sent") continue;
      out.push({ source, day: at.slice(0, 10), at, host: hostOf(url), url, payTo, tx, settled: r.settled === true, delivered: r.delivered === true, httpStatus: typeof r.httpStatus === "number" ? r.httpStatus : null });
    }
  } else if (file.kind === "gate1-live") {
    for (const r of file.records ?? []) {
      if (r.outcome !== "sent") continue;
      const tx = str(r.signature);
      const url = str(r.requestUrl);
      const payTo = str((r.probe as Row | undefined)?.payTo);
      const at = str(r.at) ?? str(file.ranAt); // gate1 records carry no time of their own: the run's start
      if (!tx || !url || !payTo || !at) continue;
      const resp = r.response as Row | undefined;
      out.push({ source, day: at.slice(0, 10), at, host: hostOf(url), url, payTo, tx, settled: r.settled === true, delivered: r.delivered === true, httpStatus: typeof resp?.status === "number" ? resp.status : null });
    }
  } else throw new Error(`${source}: unknown kind ${file.kind}`);
  return out;
}

export function groupByPayTo(ps: Purchase[]): Map<string, Purchase[]> {
  const m = new Map<string, Purchase[]>();
  const seen = new Set<string>();
  for (const p of ps) {
    if (seen.has(p.tx)) continue; // the same payment listed by two inputs
    seen.add(p.tx);
    m.set(p.payTo, [...(m.get(p.payTo) ?? []), p]);
  }
  for (const list of m.values()) list.sort((a, b) => a.at.localeCompare(b.at));
  return m;
}

export interface OutcomeSummary {
  outcome: Outcome | null;
  /** Why no outcome, when outcome is null. */
  detail: string;
  days: string[];
  settled: number;
  delivered: number;
}

/**
 * The one outcome all settled purchases agree on, over at least MIN_DAYS days. Mixed results
 * (delivered on one day, not on another) give no outcome: nothing is written for them.
 */
export function outcomeOf(ps: Purchase[]): OutcomeSummary {
  const settled = ps.filter((p) => p.settled);
  const days = [...new Set(settled.map((p) => p.day))].sort();
  const delivered = settled.filter((p) => p.delivered).length;
  const base = { days, settled: settled.length, delivered };
  if (settled.length === 0) return { ...base, outcome: null, detail: "no settled purchase" };
  if (delivered > 0 && delivered < settled.length) return { ...base, outcome: null, detail: `mixed: ${delivered} of ${settled.length} settled purchases delivered` };
  if (days.length < MIN_DAYS) return { ...base, outcome: null, detail: `seen on ${days.length} day(s); ${MIN_DAYS} needed` };
  return { ...base, outcome: delivered === 0 ? "paid-not-delivered" : "delivered", detail: `${settled.length} settled purchase(s) on ${days.length} days, ${delivered} delivered` };
}

/** The values say what happened and nothing more: 0 when paid and not delivered, 100 when delivered. */
export function feedbackValues(o: Outcome): Pick<GiveFeedbackArgs, "value" | "valueDecimals" | "score" | "tag1" | "tag2"> {
  return o === "delivered"
    ? { value: 1n, valueDecimals: 0, score: 100, tag1: TAG1, tag2: "delivered" }
    : { value: 0n, valueDecimals: 0, score: 0, tag1: TAG1, tag2: "paid-not-delivered" };
}

/** The record verdict that backs each outcome. */
export const VERDICT_FOR: Record<Outcome, string> = { "paid-not-delivered": "NOT_DELIVERED", delivered: "DELIVERED" };

export function recordUri(id: string): string {
  if (!/^obs_\d{4}-\d{2}-\d{2}_\d{6}$/.test(id)) throw new Error(`bad record id ${id}`);
  return `${PUBLIC_SITE_URL}/records/${id}.json`;
}

export interface AgentChoice {
  asset: string | null;
  candidates: string[];
  detail: string;
}

/**
 * The agent to write to. Owner = payTo must hold for exactly one agent; when the payTo owns several
 * agents that all look alike, the choice is not vet402's to guess: an operator pin (host=asset) is needed.
 */
export function chooseAgent(ownedByPayTo: string[], pin: string | undefined): AgentChoice {
  const candidates = [...ownedByPayTo].sort();
  if (pin !== undefined) {
    if (!candidates.includes(pin)) return { asset: null, candidates, detail: `pinned asset ${pin} is not owned by the payTo` };
    return { asset: pin, candidates, detail: candidates.length === 1 ? "the only agent owned by the payTo" : `pinned by the operator (one of ${candidates.length} agents owned by the payTo)` };
  }
  if (candidates.length === 0) return { asset: null, candidates, detail: "no agent owned by the payTo" };
  if (candidates.length > 1) return { asset: null, candidates, detail: `the payTo owns ${candidates.length} agents; which one sells this endpoint is not decided (pin one with --pin host=asset)` };
  return { asset: candidates[0]!, candidates, detail: "the only agent owned by the payTo" };
}

/** Everything that is checked before a write. A null means "not checked", which also refuses. */
export interface GateChecks {
  client: string;
  payTo: string;
  outcome: Outcome | null;
  agent: { asset: string | null; pdaMatches: boolean | null; cachedOwner: string | null; coreOwner: string | null } | null;
  purchase: {
    tx: string;
    finalized: boolean;
    err: unknown;
    clientSigned: boolean;
    clientDeltaAtomic: bigint | null;
    payToDeltaAtomic: bigint | null;
  } | null;
  record: {
    id: string;
    published: boolean;
    /** true only when the URI was fetched just now and returned 200. */
    fetchedOk: boolean | null;
    fetchedSha256: string | null;
    indexSha256: string | null;
    hashToWrite: string | null;
    paymentTx: string | null;
    payer: string | null;
    payTo: string | null;
    verdict: string | null;
    verifiesOffline: boolean | null;
  } | null;
  args: { uri: string; endpoint: string; tag1: string; tag2: string } | null;
  existingOnChain: number | null;
  inLedger: boolean;
}

/** Every reason not to write. Empty means all gates pass. */
export function refusals(c: GateChecks): string[] {
  const r: string[] = [];
  if (!c.outcome) r.push("no single outcome to report");
  const a = c.agent;
  if (!a || !a.asset) r.push("no agent chosen");
  else {
    if (a.pdaMatches !== true) r.push("agent account is not the registry PDA of the asset");
    if (a.coreOwner === null) r.push("Core asset owner not read");
    else if (a.coreOwner !== c.payTo) r.push(`Core asset owner ${a.coreOwner} is not the payTo ${c.payTo}`);
    if (a.cachedOwner !== null && a.cachedOwner !== c.payTo) r.push("registry's cached owner is not the payTo");
    if (a.coreOwner === c.client) r.push("the writer owns the agent");
  }
  const p = c.purchase;
  if (!p) r.push("purchase tx not read");
  else {
    if (!p.finalized) r.push(`purchase ${p.tx} is not finalized on chain`);
    if (p.err !== null) r.push(`purchase ${p.tx} failed on chain`);
    if (!p.clientSigned) r.push("the writer did not sign the purchase");
    if (p.clientDeltaAtomic === null || p.payToDeltaAtomic === null || p.clientDeltaAtomic >= 0n || p.payToDeltaAtomic <= 0n || -p.clientDeltaAtomic !== p.payToDeltaAtomic)
      r.push(`purchase ${p.tx} is not a USDC transfer from the writer to the payTo`);
  }
  const d = c.record;
  if (!d) r.push("no vet402 record of the purchase");
  else {
    if (!d.published) r.push(`record ${d.id} is not published`);
    else if (d.fetchedOk !== true) r.push(`record ${d.id} could not be fetched from its URI`);
    else if (!d.hashToWrite || d.fetchedSha256 !== d.hashToWrite || d.indexSha256 !== d.hashToWrite) r.push(`record ${d.id}: fetched bytes, index and feedback_file_hash disagree`);
    if (p && d.paymentTx !== p.tx) r.push(`record ${d.id} is not about purchase ${p.tx}`);
    if (d.payer !== c.client || d.payTo !== c.payTo) r.push(`record ${d.id}: payer or payTo differs`);
    if (!c.outcome || d.verdict !== VERDICT_FOR[c.outcome]) r.push(`record ${d.id}: verdict ${d.verdict} does not back the outcome`);
    if (d.verifiesOffline !== true) r.push(`record ${d.id} does not verify offline`);
  }
  const g = c.args;
  const len = (s: string) => new TextEncoder().encode(s).length;
  if (!g) r.push("no arguments");
  else {
    if (len(g.uri) > MAX_URI_BYTES) r.push(`feedback_uri is ${len(g.uri)} bytes (max ${MAX_URI_BYTES})`);
    if (len(g.endpoint) > MAX_ENDPOINT_BYTES) r.push(`endpoint is ${len(g.endpoint)} bytes (max ${MAX_ENDPOINT_BYTES})`);
    if (len(g.tag1) > MAX_TAG_BYTES || len(g.tag2) > MAX_TAG_BYTES) r.push("tag over 32 bytes");
  }
  if (c.existingOnChain === null) {
    if (c.agent?.asset) r.push("could not check the chain for earlier feedback from this wallet");
  } else if (c.existingOnChain > 0) r.push(`this wallet already wrote ${c.existingOnChain} feedback to the agent on chain`);
  if (c.inLedger) r.push("the local ledger already has a write for this agent");
  return r;
}
