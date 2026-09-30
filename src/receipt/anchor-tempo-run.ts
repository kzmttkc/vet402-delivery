/**
 * The day's root on Tempo, as functions over an RPC and a folder (scripts/anchor-receipts-tempo.ts is the
 * command line). The same gates as the Solana anchor (src/receipt/anchor-run.ts):
 *
 *  plan    recompute the day's root from every record on disk and check it against each record's own
 *          anchor (dayRoot), build the one transferWithMemo call, eth_call and eth_estimateGas it from
 *          the anchor key on mainnet, bound the fee. Signs nothing.
 *  send    (--send) refuse when <day>/anchor-tempo-sent.json exists, or when the anchor key's memo
 *          history on chain already holds this root; refuse a fee bound over MAX_TEMPO_ANCHOR_FEE_ATOMIC;
 *          sign; decode the signed transaction and refuse anything but the anchor; write
 *          anchor-tempo-sent.json ("sending", with the signed bytes and the nonce) before sending; send
 *          once; wait for the receipt; check it as a verifier would; set the file to "sent" with the tx,
 *          the memo and the block.
 *  resume  (--resume) for a file left at "sending": landed -> set "sent". Not landed and the nonce
 *          still unused -> with --send, rebroadcast the same signed bytes (same nonce, so at most one
 *          transaction of the day can land); without, wait. Reverted -> archive the file (with --send,
 *          send afresh; the duplicate check runs again).
 *
 * The signed records are never touched: publish-records copies tx, memo and block from the "sent" file
 * into data/records/index.json (days[].tempoAnchor).
 *
 * The anchor key is not the payer: its USDC.e never passes through the Tempo purchase ledgers. The only
 * USDC.e that leaves it per day is 1 atomic unit (to vet402's observer address) and the network fee.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, keccak256, parseAbiItem, type Hex } from "viem";
import type { Rpc } from "../chain.js";
import { TEMPO_MAINNET_CHAIN_ID, USDC_E, normAddr } from "../tempo/constants.js";
import { dayRoot, readDay, type AnchorDeps } from "./anchor-run.js";
import { VET402_TEMPO_ANCHOR_RECIPIENT, VET402_TEMPO_ANCHOR_SENDERS } from "./observers.js";
import {
  anchorCall,
  anchorTxProblem,
  checkTempoDayAnchor,
  findTempoAnchors,
  maxFeeAtomic,
  MAX_TEMPO_ANCHOR_FEE_ATOMIC,
  readTempoAnchorTx,
  TEMPO_ANCHOR_AMOUNT,
  TEMPO_ANCHOR_METHOD,
  TEMPO_ANCHOR_NETWORK,
  TEMPO_BASE_FEE_CAP,
  type TempoDayAnchor,
} from "./tempo-anchor.js";
import type { Observation } from "./types.js";

/** The unsigned Tempo transaction the anchor key signs. */
export interface AnchorTxFields {
  type: "tempo";
  chainId: number;
  calls: { to: Hex; data: Hex }[];
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  feeToken: Hex;
}

export interface TempoAnchorSigner {
  address: string;
  /** Returns the signed, serialized 0x76 transaction. */
  signTransaction: (tx: AnchorTxFields) => Promise<string>;
}

export interface TempoAnchorDeps {
  rpc: Rpc;
  dayDir: string;
  day: string;
  /** The anchor key's address; must be one of `senders`. */
  sender: string;
  loadSigner: () => Promise<TempoAnchorSigner>;
  senders?: readonly string[];
  recipient?: string;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  pollTries?: number;
  pollMs?: number;
  /** Plan only: run eth_call and eth_estimateGas from this address instead of the sender (to try the call before the anchor key is funded). send refuses it. */
  simulateFrom?: string;
}

export interface TempoSentFile {
  day: string;
  root: string;
  tx: string;
  nonce: number;
  status: "sending" | "sent";
  /** The signed transaction, so --resume can rebroadcast exactly the same bytes. */
  raw: string;
  at: string;
  anchoredAt?: string;
  /** Set with "sent": the memo read back from the chain (the root) and the block it is in. */
  memo?: string;
  block?: number;
}

export interface TempoAnchorPlan {
  day: string;
  network: string;
  method: typeof TEMPO_ANCHOR_METHOD;
  root: string;
  count: number;
  sequenceRange: [number, number];
  sender: string;
  recipient: string;
  token: string;
  amountAtomic: string;
  call: { to: string; data: string };
  nonce: number;
  simulation: { ok: boolean; from: string; gasEstimate: string | null; err: string | null };
  gasLimit: string | null;
  maxFeePerGas: string;
  feeBoundAtomic: string | null;
  maxFeeAtomic: string;
  senderBalanceAtomic: string;
  solanaAnchor: { status: string; tx: string | null };
}

const SENT = "anchor-tempo-sent.json";
const sentPath = (d: TempoAnchorDeps) => join(d.dayDir, SENT);
const sendersOf = (d: TempoAnchorDeps) => d.senders ?? VET402_TEMPO_ANCHOR_SENDERS;
const recipientOf = (d: TempoAnchorDeps) => d.recipient ?? VET402_TEMPO_ANCHOR_RECIPIENT;
const asAnchorDeps = (d: TempoAnchorDeps) => ({ dayDir: d.dayDir, day: d.day }) as AnchorDeps;
const BALANCE_OF = parseAbiItem("function balanceOf(address) view returns (uint256)");

function errText(e: unknown): string {
  const x = e as { shortMessage?: string; message?: string };
  return String(x?.shortMessage ?? x?.message ?? e).split("\n")[0]!.slice(0, 300);
}

/** The root recomputed from the records on disk and checked against each record's own anchor (dayRoot). */
export function tempoDayRoot(d: TempoAnchorDeps): { obs: Observation[]; root: string; seq: [number, number] } {
  const obs = readDay(asAnchorDeps(d));
  const r = dayRoot(asAnchorDeps(d), obs, { allowAnchored: true });
  return { obs, root: r.root.toLowerCase(), seq: r.seq };
}

export async function plan(d: TempoAnchorDeps): Promise<{ plan: TempoAnchorPlan; tx: AnchorTxFields | null }> {
  if (!sendersOf(d).some((s) => normAddr(s) === normAddr(d.sender))) throw new Error(`${d.sender} is not vet402's Tempo anchor key`);
  const { obs, root, seq } = tempoDayRoot(d);
  const chainId = Number(BigInt((await d.rpc("eth_chainId", [])) as string));
  if (chainId !== TEMPO_MAINNET_CHAIN_ID) throw new Error(`RPC is chain ${chainId}, not Tempo mainnet ${TEMPO_MAINNET_CHAIN_ID}`);
  const call = anchorCall(root, recipientOf(d));
  const latest = Number(BigInt((await d.rpc("eth_getTransactionCount", [d.sender, "latest"])) as string));
  const pending = Number(BigInt((await d.rpc("eth_getTransactionCount", [d.sender, "pending"])) as string));
  if (pending !== latest) throw new Error(`the anchor key has ${pending - latest} transaction(s) in flight; not planning over them`);
  const balance = BigInt(
    (await d.rpc("eth_call", [{ to: USDC_E, data: encodeFunctionData({ abi: [BALANCE_OF], functionName: "balanceOf", args: [d.sender as Hex] }) }, "latest"])) as string,
  );
  const simFrom = d.simulateFrom ?? d.sender;
  let gasEstimate: bigint | null = null;
  let err: string | null = null;
  try {
    await d.rpc("eth_call", [{ from: simFrom, to: call.to, data: call.data }, "latest"]);
    gasEstimate = BigInt((await d.rpc("eth_estimateGas", [{ from: simFrom, to: call.to, data: call.data }])) as string);
  } catch (e) {
    err = errText(e);
  }
  const gasLimit = gasEstimate === null ? null : (gasEstimate * 5n + 3n) / 4n;
  const feeBound = gasLimit === null ? null : maxFeeAtomic(gasLimit, TEMPO_BASE_FEE_CAP);
  const a = obs[0]!.anchor!;
  const p: TempoAnchorPlan = {
    day: d.day,
    network: TEMPO_ANCHOR_NETWORK,
    method: TEMPO_ANCHOR_METHOD,
    root,
    count: obs.length,
    sequenceRange: seq,
    sender: d.sender,
    recipient: recipientOf(d),
    token: USDC_E,
    amountAtomic: TEMPO_ANCHOR_AMOUNT.toString(),
    call,
    nonce: latest,
    simulation: { ok: err === null, from: simFrom, gasEstimate: gasEstimate?.toString() ?? null, err },
    gasLimit: gasLimit?.toString() ?? null,
    maxFeePerGas: TEMPO_BASE_FEE_CAP.toString(),
    feeBoundAtomic: feeBound?.toString() ?? null,
    maxFeeAtomic: MAX_TEMPO_ANCHOR_FEE_ATOMIC.toString(),
    senderBalanceAtomic: balance.toString(),
    solanaAnchor: { status: a.status, tx: a.tx },
  };
  const tx: AnchorTxFields | null =
    gasLimit === null
      ? null
      : { type: "tempo", chainId, calls: [call], nonce: latest, gas: gasLimit, maxFeePerGas: TEMPO_BASE_FEE_CAP, maxPriorityFeePerGas: 0n, feeToken: USDC_E as Hex };
  return { plan: p, tx };
}

/** Refuse unless the anchor key's memo history holds nothing for this root. */
async function assertNoTempoMemo(d: TempoAnchorDeps, root: string): Promise<void> {
  const found = await findTempoAnchors(d.rpc, root, d.sender, undefined, recipientOf(d));
  if (found.length) throw new Error(`root ${root} is already in a Tempo memo from ${d.sender}: ${found.map((f) => f.tx).join(", ")}; not sending (run --resume to record it)`);
}

export async function send(d: TempoAnchorDeps): Promise<{ status: "sent"; tx: string }> {
  if (existsSync(sentPath(d))) throw new Error(`${sentPath(d)} exists: ${d.day} was already sent to Tempo, or a send was interrupted. Run --resume.`);
  if (d.simulateFrom !== undefined) throw new Error("simulateFrom is for a plan only; not sending");
  const p = await plan(d);
  if (!p.plan.simulation.ok || !p.tx) throw new Error(`simulation failed (${p.plan.simulation.err}); not sending`);
  const bound = BigInt(p.plan.feeBoundAtomic!);
  if (bound > MAX_TEMPO_ANCHOR_FEE_ATOMIC) throw new Error(`fee bound ${bound} is over ${MAX_TEMPO_ANCHOR_FEE_ATOMIC}; not sending`);
  if (BigInt(p.plan.senderBalanceAtomic) < TEMPO_ANCHOR_AMOUNT + bound) throw new Error(`anchor key holds ${p.plan.senderBalanceAtomic} atomic USDC.e, needs ${TEMPO_ANCHOR_AMOUNT + bound}; not sending (fund it from any address but the payer)`);
  await assertNoTempoMemo(d, p.plan.root);
  const signer = await d.loadSigner();
  if (normAddr(signer.address) !== normAddr(d.sender)) throw new Error(`key ${signer.address} is not the anchor key ${d.sender}`);
  const raw = await signer.signTransaction(p.tx);
  const bad = anchorTxProblem(raw, { sender: d.sender, root: p.plan.root, recipient: recipientOf(d), nonce: p.tx.nonce });
  if (bad) throw new Error(`signed anchor transaction refused, never sent: ${bad}`);
  const tx = keccak256(raw as Hex).toLowerCase();
  const file: TempoSentFile = { day: d.day, root: p.plan.root, tx, nonce: p.tx.nonce, status: "sending", raw, at: new Date().toISOString() };
  writeFileSync(sentPath(d), `${JSON.stringify(file, null, 2)}\n`, { flag: "wx" }); // before anything leaves
  const got = String(await d.rpc("eth_sendRawTransaction", [raw])).toLowerCase();
  if (got !== tx) throw new Error(`the RPC returned ${got} for the anchor transaction, expected ${tx}; ${SENT} stays at "sending". Run --resume.`);
  const outcome = await waitFor(d, tx);
  if (outcome === "landed") return { status: "sent", tx: await finalize(d, file) };
  if (outcome === "reverted") throw new Error(`Tempo anchor transaction ${tx} reverted; run --resume`);
  throw new Error(`Tempo anchor transaction ${tx} has no receipt yet; ${SENT} stays at "sending". Run --resume.`);
}

async function receiptStatus(d: TempoAnchorDeps, tx: string): Promise<"landed" | "reverted" | null> {
  const r = (await d.rpc("eth_getTransactionReceipt", [tx])) as { status: string } | null;
  if (!r) return null;
  return r.status === "0x1" ? "landed" : "reverted";
}

async function waitFor(d: TempoAnchorDeps, tx: string): Promise<"landed" | "reverted" | "pending"> {
  const sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < (d.pollTries ?? 30); i++) {
    await sleep(d.pollMs ?? 2000);
    const s = await receiptStatus(d, tx);
    if (s) return s;
  }
  return "pending";
}

/** The memo landed: check it as a verifier would and set the file to "sent" with tx, memo and block. The records are not touched. Returns the tx. */
async function finalize(d: TempoAnchorDeps, file: TempoSentFile, tx = file.tx): Promise<string> {
  const { root } = tempoDayRoot(d);
  if (root !== file.root.toLowerCase()) throw new Error(`the records' root ${root} is not the root sent (${file.root})`);
  const t = await readTempoAnchorTx(d.rpc, tx, sendersOf(d), recipientOf(d));
  if (!t.ok || t.root !== root || t.block === null) throw new Error(`Tempo transaction ${tx} is not vet402's anchor of ${root}: ${t.ok ? `memo ${t.root}` : t.detail}`);
  const entry: TempoDayAnchor = { tx: tx.toLowerCase(), memo: t.root, block: t.block };
  const check = await checkTempoDayAnchor(entry, { day: d.day, root }, d.rpc, sendersOf(d), recipientOf(d));
  if (!check.ok) throw new Error(`Tempo transaction ${tx} does not check as vet402's anchor for ${d.day}: ${check.detail}`);
  const anchoredAt = new Date((t.blockTime ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();
  writeFileSync(sentPath(d), `${JSON.stringify({ ...file, tx: entry.tx, status: "sent", anchoredAt, memo: entry.memo, block: entry.block } satisfies TempoSentFile, null, 2)}\n`);
  d.log?.(`root of ${d.day} also written on Tempo in ${tx} (${check.detail}); publish-records puts it in the records index`);
  return entry.tx;
}

function archive(d: TempoAnchorDeps, why: string): string {
  const to = join(d.dayDir, `anchor-tempo-sent.${why}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  renameSync(sentPath(d), to);
  return to;
}

export type TempoResumeResult = { status: "sent"; tx: string } | { status: "waiting"; detail: string } | { status: "cleared"; detail: string };

export async function resume(d: TempoAnchorDeps, opts: { send: boolean }): Promise<TempoResumeResult> {
  if (!existsSync(sentPath(d))) {
    // No local trace, but the memo may be on chain (the duplicate check stopped a send): record it.
    const { root } = tempoDayRoot(d);
    const found = await findTempoAnchors(d.rpc, root, d.sender, undefined, recipientOf(d));
    if (found.length !== 1) throw new Error(`${sentPath(d)} does not exist and ${found.length} vet402 Tempo memos hold ${root}; nothing to resume`);
    const file: TempoSentFile = { day: d.day, root, tx: found[0]!.tx, nonce: -1, status: "sending", raw: "", at: new Date().toISOString() };
    return { status: "sent", tx: await finalize(d, file) };
  }
  const file = JSON.parse(readFileSync(sentPath(d), "utf8")) as TempoSentFile;
  if (file.day !== d.day) throw new Error(`${sentPath(d)} is for ${file.day}`);
  if (file.status === "sent") return { status: "sent", tx: await finalize(d, file) };
  const s = await receiptStatus(d, file.tx);
  if (s === "landed") return { status: "sent", tx: await finalize(d, file) };
  if (s === null) {
    const found = await findTempoAnchors(d.rpc, file.root, d.sender, undefined, recipientOf(d));
    if (found.length === 1) return { status: "sent", tx: await finalize(d, file, found[0]!.tx) };
    if (found.length > 1) throw new Error(`${found.length} Tempo memos hold ${file.root}; stop and look`);
    const used = Number(BigInt((await d.rpc("eth_getTransactionCount", [d.sender, "latest"])) as string));
    if (used > file.nonce) throw new Error(`nonce ${file.nonce} of the anchor key is used, but not by ${file.tx} and no memo holds the root; stop and look`);
    if (!opts.send) return { status: "waiting", detail: `${file.tx} (nonce ${file.nonce}) can still land; run --resume again later, or --resume --send to rebroadcast the same signed bytes` };
    try {
      await d.rpc("eth_sendRawTransaction", [file.raw]);
    } catch (e) {
      d.log?.(`rebroadcast: ${errText(e)}`); // "already known" and the like: keep waiting on the same hash
    }
    const outcome = await waitFor(d, file.tx);
    if (outcome === "landed") return { status: "sent", tx: await finalize(d, file) };
    if (outcome === "pending") return { status: "waiting", detail: `${file.tx} rebroadcast, no receipt yet; run --resume again` };
  }
  // Reverted: it can no longer land and its nonce is spent.
  const to = archive(d, "reverted");
  if (!opts.send) return { status: "cleared", detail: `${file.tx} reverted; moved to ${to}. Run --send to write the root.` };
  return send(d);
}
