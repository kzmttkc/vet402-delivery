/**
 * The daily anchor run, as functions over an RPC and a folder so every branch can be tested without a
 * network or a key. scripts/anchor-receipts.ts is the command line around it.
 *
 *  plan    recompute the day's root from every record on disk, build the memo-only transaction,
 *          simulate it on mainnet, quote the fee. Signs nothing.
 *  send    (--send) refuse when <day>/anchor-sent.json exists or when the anchor wallet's history on
 *          chain already has a memo for this day; otherwise sign, write anchor-sent.json ("sending",
 *          with the signed transaction and its lastValidBlockHeight) before sending, send once, wait.
 *  resume  (--resume) for an anchor-sent.json left at "sending": read the chain. Landed -> mark the
 *          records and set "sent". Failed on chain, or expired with no memo for the day on chain ->
 *          archive the file; with --send as well, send afresh (the duplicate check runs again).
 *          Still within its blockhash window -> with --send, rebroadcast the same signed bytes (same
 *          signature, so it cannot land twice); without, wait.
 */
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getBase64EncodedWireTransaction, getSignatureFromTransaction, signTransaction, type KeyPairSigner } from "@solana/kit";
import type { Hex } from "viem";
import type { Rpc } from "../chain.js";
import { MEMO_PROGRAM, SOLANA_MAINNET } from "../constants.js";
import { compileMemoTx, MAX_MEMO_BYTES } from "./anchor.js";
import { checkAnchorOnChain, findDayAnchors, memoMatches } from "./chain.js";
import { observationDigest } from "./eip712.js";
import { anchorMemo, buildTree } from "./merkle.js";
import { VET402_ANCHOR_SIGNERS } from "./observers.js";
import type { Observation } from "./types.js";

/** 5,000 lamports per signature is the base fee; the memo transaction has one signature and no priority fee. */
export const MAX_FEE_LAMPORTS = 10_000;
/** mainnet-beta; CAIP-2 keeps its first 32 characters. */
export const SOLANA_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

export interface AnchorDeps {
  rpc: Rpc;
  /** <receipts>/<day>: the day's records, and anchor-sent.json. */
  dayDir: string;
  day: string;
  /** Must be one of `anchorSigners`. */
  feePayer: string;
  /** Loads the fee payer's key; called only on a path that signs. */
  loadSigner: () => Promise<KeyPairSigner>;
  anchorSigners?: readonly string[];
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Confirmation polling: tries x interval. */
  pollTries?: number;
  pollMs?: number;
}

export interface SentFile {
  day: string;
  root: string;
  memo: string;
  signature: string;
  status: "sending" | "sent";
  lastValidBlockHeight: number;
  /** The signed transaction (base64), so --resume can rebroadcast exactly the same bytes. */
  wire: string;
  at: string;
  anchoredAt?: string;
}

export interface AnchorPlan {
  day: string;
  network: string;
  memo: string;
  memoBytes: number;
  maxMemoBytes: number;
  root: string;
  count: number;
  sequenceRange: [number, number];
  feePayer: string;
  program: string;
  simulation: { ok: boolean; err: unknown; unitsConsumed: number | null; logs: string[] };
  feeLamports: number | null;
  feePayerBalanceLamports: number;
}

const sentPath = (d: AnchorDeps) => join(d.dayDir, "anchor-sent.json");
const signersOf = (d: AnchorDeps) => d.anchorSigners ?? VET402_ANCHOR_SIGNERS;

export function readDay(d: AnchorDeps): Observation[] {
  const files = readdirSync(d.dayDir).filter((f) => /^obs_\d{4}-\d{2}-\d{2}_\d{6}\.json$/.test(f));
  return files.map((f) => JSON.parse(readFileSync(join(d.dayDir, f), "utf8")) as Observation).sort((a, b) => a.observer.sequence - b.observer.sequence);
}

/** The root recomputed from the records on disk, checked against each record's own anchor. */
export function dayRoot(d: AnchorDeps, obs: Observation[], opts: { allowAnchored?: boolean } = {}): { root: Hex; memo: string; seq: [number, number]; observer: string } {
  if (obs.length === 0) throw new Error(`${d.dayDir}: no records`);
  const tree = buildTree(obs.map((o) => observationDigest(o)));
  const observer = obs[0]!.observer.address;
  const seq: [number, number] = [obs[0]!.observer.sequence, obs[obs.length - 1]!.observer.sequence];
  for (const [i, o] of obs.entries()) {
    const a = o.anchor;
    if (!a || a.root !== tree.root || a.leafIndex !== i || a.count !== obs.length || a.day !== d.day || o.observer.address !== observer)
      throw new Error(`${o.id}: its anchor does not match the root recomputed from the ${obs.length} records on disk`);
    if (a.status === "anchored" && !opts.allowAnchored) throw new Error(`${o.id}: ${d.day} is already anchored in ${a.tx}`);
  }
  if (seq[1] - seq[0] + 1 !== obs.length) throw new Error(`${d.day}: sequence ${seq[0]}-${seq[1]} has gaps (${obs.length} records)`);
  return { root: tree.root, seq, observer, memo: anchorMemo({ day: d.day, root: tree.root, count: obs.length, sequenceRange: seq, observerAddress: observer }) };
}

export async function plan(d: AnchorDeps): Promise<{ plan: AnchorPlan; tx: ReturnType<typeof compileMemoTx>; lastValidBlockHeight: number }> {
  if (!signersOf(d).includes(d.feePayer)) throw new Error(`${d.feePayer} is not vet402's anchor wallet`);
  const obs = readDay(d);
  const r = dayRoot(d, obs);
  const genesis = (await d.rpc("getGenesisHash", [])) as string;
  if (genesis !== SOLANA_GENESIS) throw new Error(`RPC is not Solana mainnet (genesis ${genesis})`);
  const { value: bh } = (await d.rpc("getLatestBlockhash", [{ commitment: "confirmed" }])) as { value: { blockhash: string; lastValidBlockHeight: number } };
  const tx = compileMemoTx(d.feePayer, r.memo, bh.blockhash, BigInt(bh.lastValidBlockHeight)); // throws unless memo-only
  const sim = (await d.rpc("simulateTransaction", [getBase64EncodedWireTransaction(tx), { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }])) as {
    value: { err: unknown; logs: string[] | null; unitsConsumed?: number };
  };
  const fee = (await d.rpc("getFeeForMessage", [Buffer.from(tx.messageBytes).toString("base64"), { commitment: "confirmed" }])) as { value: number | null };
  const balance = (await d.rpc("getBalance", [d.feePayer, { commitment: "confirmed" }])) as { value: number };
  return {
    tx,
    lastValidBlockHeight: bh.lastValidBlockHeight,
    plan: {
      day: d.day,
      network: SOLANA_MAINNET,
      memo: r.memo,
      memoBytes: new TextEncoder().encode(r.memo).length,
      maxMemoBytes: MAX_MEMO_BYTES,
      root: r.root,
      count: obs.length,
      sequenceRange: r.seq,
      feePayer: d.feePayer,
      program: MEMO_PROGRAM,
      simulation: { ok: sim.value.err === null, err: sim.value.err, unitsConsumed: sim.value.unitsConsumed ?? null, logs: sim.value.logs ?? [] },
      feeLamports: fee.value,
      feePayerBalanceLamports: balance.value,
    },
  };
}

/** Refuse unless the anchor wallet's history is readable back to the day and holds no memo for it. */
async function assertNoMemoOnChain(d: AnchorDeps): Promise<void> {
  const look = await findDayAnchors(d.rpc, d.day, d.feePayer);
  if (!look.complete) throw new Error(`could not read the anchor wallet's history back to ${d.day} (${look.pagesRead} pages); not sending`);
  if (look.found.length)
    throw new Error(`${d.day} already has a memo on chain from ${d.feePayer}: ${look.found.map((f) => `${f.signature} root=${f.memo.root}`).join(", ")}; not sending (run --resume to record it)`);
}

export async function send(d: AnchorDeps): Promise<{ status: "sent"; signature: string }> {
  if (existsSync(sentPath(d))) throw new Error(`${sentPath(d)} exists: ${d.day} was already sent, or a send was interrupted. Run --resume.`);
  const p = await plan(d);
  if (!p.plan.simulation.ok) throw new Error("simulation failed; not sending");
  if (p.plan.feeLamports === null || p.plan.feeLamports > MAX_FEE_LAMPORTS) throw new Error(`fee ${p.plan.feeLamports} lamports is over ${MAX_FEE_LAMPORTS}; not sending`);
  if (p.plan.feePayerBalanceLamports < p.plan.feeLamports) throw new Error(`fee payer has ${p.plan.feePayerBalanceLamports} lamports; not sending`);
  await assertNoMemoOnChain(d);
  const signer = await d.loadSigner();
  if (signer.address !== d.feePayer) throw new Error(`key ${signer.address} is not the fee payer ${d.feePayer}`);
  const signed = await signTransaction([signer.keyPair], p.tx);
  const signature = getSignatureFromTransaction(signed);
  const wire = getBase64EncodedWireTransaction(signed);
  const file: SentFile = { day: d.day, root: p.plan.root, memo: p.plan.memo, signature, status: "sending", lastValidBlockHeight: p.lastValidBlockHeight, wire, at: new Date().toISOString() };
  writeFileSync(sentPath(d), `${JSON.stringify(file, null, 2)}\n`, { flag: "wx" }); // before anything leaves
  await d.rpc("sendTransaction", [wire, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5 }]);
  const outcome = await waitFor(d, signature, p.lastValidBlockHeight);
  if (outcome === "landed") return { status: "sent", signature: await finalize(d, file) };
  if (outcome === "failed") throw new Error(`anchor transaction ${signature} failed on chain; run --resume`);
  throw new Error(`anchor transaction ${signature} not confirmed yet; ${sentPath(d)} stays at "sending". Run --resume.`);
}

type Outcome = "landed" | "failed" | "expired" | "pending";

async function statusOf(d: AnchorDeps, signature: string): Promise<"landed" | "failed" | null> {
  const st = (await d.rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }])) as {
    value: ({ err: unknown; confirmationStatus: string | null } | null)[];
  };
  const s = st.value[0];
  if (!s) return null;
  if (s.err) return "failed";
  return s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized" ? "landed" : null;
}

async function waitFor(d: AnchorDeps, signature: string, lastValidBlockHeight: number): Promise<Outcome> {
  const sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < (d.pollTries ?? 60); i++) {
    await sleep(d.pollMs ?? 2000);
    const s = await statusOf(d, signature);
    if (s) return s;
    const height = (await d.rpc("getBlockHeight", [{ commitment: "confirmed" }])) as number;
    if (height > lastValidBlockHeight) return (await statusOf(d, signature)) ?? "expired";
  }
  return "pending";
}

/** The memo landed: check it on chain as a verifier would, mark every record, set "sent". Returns the signature. */
async function finalize(d: AnchorDeps, file: SentFile, signature = file.signature): Promise<string> {
  const got = (await d.rpc("getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }])) as { blockTime: number | null } | null;
  const anchoredAt = new Date((got?.blockTime ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();
  const obs = readDay(d);
  dayRoot(d, obs, { allowAnchored: true });
  const marked = obs.map((o) => {
    const a = o.anchor!;
    if (a.status === "anchored") {
      if (a.tx !== signature) throw new Error(`${o.id}: already anchored in ${a.tx}, not ${signature}`);
      return o; // an earlier finalize got this far
    }
    return { ...o, anchor: { ...a, status: "anchored" as const, tx: signature, anchoredAt } };
  });
  const check = await checkAnchorOnChain(marked[0]!, () => d.rpc, signersOf(d));
  if (!check?.ok) throw new Error(`anchor transaction ${signature} does not check as vet402's anchor for ${d.day}: ${check?.detail}`);
  for (const o of marked) writeFileSync(join(d.dayDir, `${o.id}.json`), `${JSON.stringify(o, null, 2)}\n`);
  const done: SentFile = { ...file, signature, status: "sent", anchoredAt };
  writeFileSync(sentPath(d), `${JSON.stringify(done, null, 2)}\n`);
  d.log?.(`anchored ${d.day} in ${signature} (${check.detail}); ${marked.length} records marked. Next: npx tsx scripts/publish-records.ts`);
  return signature;
}

function archive(d: AnchorDeps, why: string): string {
  const to = join(d.dayDir, `anchor-sent.${why}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  renameSync(sentPath(d), to);
  return to;
}

export type ResumeResult =
  | { status: "sent"; signature: string }
  | { status: "waiting"; detail: string }
  | { status: "cleared"; detail: string };

export async function resume(d: AnchorDeps, opts: { send: boolean }): Promise<ResumeResult> {
  if (!existsSync(sentPath(d))) {
    // No local trace, but a memo may be on chain (the duplicate check stopped a send): record it.
    const look = await findDayAnchors(d.rpc, d.day, d.feePayer);
    const anc = readDay(d)[0]?.anchor;
    const same = anc ? look.found.find((f) => memoMatches(f.memo, anc) === null) : undefined;
    if (!same) throw new Error(`${sentPath(d)} does not exist and no matching vet402 memo for ${d.day} is on chain; nothing to resume`);
    const r = dayRoot(d, readDay(d), { allowAnchored: true });
    const file: SentFile = { day: d.day, root: r.root, memo: r.memo, signature: same.signature, status: "sending", lastValidBlockHeight: 0, wire: "", at: new Date().toISOString() };
    return { status: "sent", signature: await finalize(d, file) };
  }
  const file = JSON.parse(readFileSync(sentPath(d), "utf8")) as SentFile;
  if (file.day !== d.day) throw new Error(`${sentPath(d)} is for ${file.day}`);
  if (file.status === "sent") {
    // Make sure the records carry it too (a crash between the two writes).
    return { status: "sent", signature: await finalize(d, file) };
  }
  const s = await statusOf(d, file.signature);
  if (s === "landed") return { status: "sent", signature: await finalize(d, file) };

  // Not landed under this signature. Is some other vet402 memo for the day on chain?
  const look = await findDayAnchors(d.rpc, d.day, d.feePayer);
  if (!look.complete) throw new Error(`could not read the anchor wallet's history back to ${d.day}; nothing changed`);
  const obs = readDay(d);
  const anc = obs[0]!.anchor!;
  const same = look.found.find((f) => memoMatches(f.memo, anc) === null);
  if (same) return { status: "sent", signature: await finalize(d, file, same.signature) };
  if (look.found.length) throw new Error(`${d.day} has a memo on chain with a different root (${look.found.map((f) => f.signature).join(", ")}); stop and look`);

  let lost: "failed" | "expired" = s === "failed" ? "failed" : "expired";
  const height = (await d.rpc("getBlockHeight", [{ commitment: "confirmed" }])) as number;
  if (s !== "failed" && height <= file.lastValidBlockHeight) {
    if (!opts.send) return { status: "waiting", detail: `${file.signature} can still land until block height ${file.lastValidBlockHeight} (now ${height}); run --resume again later, or --resume --send to rebroadcast the same signed bytes` };
    await d.rpc("sendTransaction", [file.wire, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5 }]);
    const outcome = await waitFor(d, file.signature, file.lastValidBlockHeight);
    if (outcome === "landed") return { status: "sent", signature: await finalize(d, file) };
    if (outcome === "pending") return { status: "waiting", detail: `${file.signature} rebroadcast, not confirmed yet; run --resume again` };
    lost = outcome; // failed or expired: fall through to clearing
  }
  // It can no longer land (failed, or its blockhash expired) and no memo for the day is on chain.
  const to = archive(d, lost);
  if (!opts.send) return { status: "cleared", detail: `${file.signature} did not land and cannot land now; moved to ${to}. Run --send to write the root.` };
  return send(d);
}
