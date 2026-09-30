/**
 * Refunds: when the agent's payment settled but vet402 could not pay the seller, the agent's full payment
 * (seller price + fee) goes back from vet402's proxy payer wallet to the address that paid, on the same
 * chain, in the same token.
 *
 * The caller (solana.ts / tempo.ts) decides whether a refund is owed and takes the refund entry in the
 * books first (one refund per payment key, per-refund and daily caps). This file only builds, reads back,
 * sends and confirms one transfer. Every transaction is decoded and checked before it is sent.
 * Errors are reported as fixed codes: RPC error messages can carry the RPC URL.
 */
import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  isAddress,
  isOffCurveAddress,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Blockhash,
  type KeyPairSigner,
} from "@solana/kit";
import { getTransferCheckedInstruction } from "@solana-program/token";
import { encodeFunctionData, keccak256, type Client, type Hex, type LocalAccount } from "viem";
import { getBlock, getTransactionCount, sendRawTransactionSync } from "viem/actions";
import { Abis, Transaction } from "viem/tempo";
import { readTransaction, type Rpc } from "../chain.js";
import { COMPUTE_BUDGET_PROGRAM, TOKEN_PROGRAM, USDC_DECIMALS, USDC_MINT } from "../constants.js";
import { usdcAta } from "../txcheck.js";
import type { SettlementCheck } from "../tempo/chain.js";
import { TEMPO_MAINNET_CHAIN_ID, USDC_E } from "../tempo/constants.js";
import { checkSignedTransfer } from "../tempo/txcheck.js";
import type { ProxyChain } from "./allowlist.js";
import type { Books, RefundRecord } from "./books.js";

export type RefundOutcome =
  | { status: "sent"; tx: string; feePaid?: string | null }
  /** Nothing left vet402: safe to say no refund was made. */
  | { status: "failed"; reason: string; tx: null }
  /** A signed refund may have left vet402 (sent, not confirmed): never retried automatically. */
  | { status: "unknown"; reason: string; tx: string | null };

/** One refund at a time per wallet: the nonce (Tempo) and the balance read stay consistent. */
export class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(f: () => Promise<T>): Promise<T> {
    const next = this.tail.then(f, f);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

function readU64LE(b: ArrayLike<number>, off: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]!);
  return v;
}

/**
 * null = the transaction is exactly one USDC TransferChecked of `amount` from ATA(payer) to ATA(to),
 * paid for and signed by `payer`, with nothing else but ComputeBudget. Otherwise why not.
 */
export async function checkSolanaRefundTx(txBase64: string, exp: { payer: string; to: string; amount: bigint }): Promise<string | null> {
  let msg;
  try {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(txBase64));
    msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  } catch {
    return "undecodable";
  }
  const keys = msg.staticAccounts.map(String);
  if (((msg as { addressTableLookups?: unknown[] }).addressTableLookups ?? []).length > 0) return "address lookup tables";
  if (keys[0] !== exp.payer) return "fee payer is not the proxy payer";
  const src = await usdcAta(exp.payer);
  const dst = await usdcAta(exp.to);
  let transfers = 0;
  for (const ix of msg.instructions) {
    const program = keys[ix.programAddressIndex];
    const accts = (ix.accountIndices ?? []).map((i) => keys[i]);
    const data = ix.data ?? new Uint8Array();
    if (program === COMPUTE_BUDGET_PROGRAM) {
      if (accts.length !== 0 || (data[0] !== 2 && data[0] !== 3)) return "unexpected ComputeBudget instruction";
      continue;
    }
    if (program !== TOKEN_PROGRAM) return "unexpected program";
    if (data.length !== 10 || data[0] !== 12 || accts.length !== 4) return "token instruction is not TransferChecked";
    const [source, mint, dest, authority] = accts;
    if (source !== src) return "source is not the proxy payer's USDC account";
    if (mint !== USDC_MINT) return "mint is not USDC";
    if (dest !== dst) return "destination is not the agent's USDC account";
    if (authority !== exp.payer) return "authority is not the proxy payer";
    if (data[9] !== USDC_DECIMALS) return "decimals != 6";
    if (readU64LE(data, 1) !== exp.amount) return "amount differs";
    transfers++;
  }
  return transfers === 1 ? null : `${transfers} transfers (expected 1)`;
}

export interface SolanaRefundDeps {
  rpc: Rpc;
  signer: KeyPairSigner;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export async function sendSolanaRefund(d: SolanaRefundDeps, to: string, amount: bigint): Promise<RefundOutcome> {
  const payer = d.signer.address;
  if (!isAddress(to) || isOffCurveAddress(to) || to === payer) return { status: "failed", reason: "refund_to_invalid", tx: null };
  if (amount <= 0n) return { status: "failed", reason: "refund_amount_invalid", tx: null };
  let lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint };
  try {
    const r = (await d.rpc("getLatestBlockhash", [{ commitment: "confirmed" }])) as { value: { blockhash: string; lastValidBlockHeight: number | string } };
    lifetime = { blockhash: r.value.blockhash as Blockhash, lastValidBlockHeight: BigInt(r.value.lastValidBlockHeight) };
  } catch {
    return { status: "failed", reason: "rpc_error", tx: null };
  }
  const src = await usdcAta(payer);
  const dst = await usdcAta(to);
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(d.signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) =>
      appendTransactionMessageInstructions(
        [getTransferCheckedInstruction({ source: address(src), mint: address(USDC_MINT), destination: address(dst), authority: d.signer, amount, decimals: USDC_DECIMALS })],
        m,
      ),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const b64 = getBase64EncodedWireTransaction(signed);
  const sig = getSignatureFromTransaction(signed);
  const problem = await checkSolanaRefundTx(b64, { payer, to, amount });
  if (problem) return { status: "failed", reason: "refund_tx_check_failed", tx: null };

  // ---- from here the refund may have left vet402 ----
  try {
    await d.rpc("sendTransaction", [b64, { encoding: "base64", preflightCommitment: "confirmed" }]);
  } catch {
    // A preflight rejection means nothing was sent; a timeout may not. Only the chain can tell: keep polling.
  }
  const deadline = Date.now() + (d.timeoutMs ?? 60_000);
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    try {
      const r = await readTransaction(d.rpc, sig, payer, to);
      if (r.found) {
        if (r.err !== null) return { status: "failed", reason: "refund_tx_failed_on_chain", tx: null };
        if (r.payToDeltaAtomic !== amount.toString()) return { status: "unknown", reason: "refund_amount_mismatch_on_chain", tx: sig };
        return { status: "sent", tx: sig };
      }
    } catch {
      /* keep polling */
    }
    if (Date.now() >= deadline) return { status: "unknown", reason: "refund_not_confirmed_in_time", tx: sig };
    await sleep(d.intervalMs ?? 2_000);
  }
}

export interface TempoRefundDeps {
  account: LocalAccount;
  client: Client;
  /** Re-read the refund on chain (src/tempo/chain.ts verifySettlement). */
  verify: (tx: string, exp: { payer: string; recipient: string; amount: bigint }) => Promise<SettlementCheck>;
}

export async function sendTempoRefund(d: TempoRefundDeps, to: string, amount: bigint): Promise<RefundOutcome> {
  const payer = d.account.address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(to) || to.toLowerCase() === payer.toLowerCase()) return { status: "failed", reason: "refund_to_invalid", tx: null };
  if (amount <= 0n) return { status: "failed", reason: "refund_amount_invalid", tx: null };
  let serialized: Hex;
  try {
    const block = await getBlock(d.client);
    const nonce = await getTransactionCount(d.client, { address: payer, blockTag: "pending" });
    const base = block.baseFeePerGas ?? 0n;
    const tx = {
      type: "tempo" as const,
      chainId: TEMPO_MAINNET_CHAIN_ID,
      calls: [{ to: USDC_E as Hex, data: encodeFunctionData({ abi: Abis.tip20, functionName: "transfer", args: [to as Hex, amount] }) }],
      nonce,
      gas: 150_000n,
      maxFeePerGas: base * 2n + 1n,
      maxPriorityFeePerGas: 0n,
      feeToken: USDC_E as Hex,
    };
    serialized = (await d.account.signTransaction!(tx as never, { serializer: Transaction.serialize as never })) as Hex;
  } catch {
    return { status: "failed", reason: "rpc_error", tx: null };
  }
  const problem = checkSignedTransfer(serialized, { payer, recipient: to, amount, sponsored: false });
  if (problem) return { status: "failed", reason: "refund_tx_check_failed", tx: null };
  const hash = keccak256(serialized);

  // ---- from here the refund may have left vet402 ----
  try {
    await sendRawTransactionSync(d.client, { serializedTransaction: serialized as never });
  } catch {
    // may or may not have been broadcast: the chain decides below
  }
  const s = await d.verify(hash, { payer, recipient: to, amount }).catch(() => null);
  if (s?.settled) return { status: "sent", tx: hash, feePaid: s.feePaid };
  return { status: "unknown", reason: "refund_not_confirmed", tx: hash };
}

/**
 * Refund one purchase whose seller vet402 did not pay: take the refund entry in the books (one per payment
 * key ever, per-refund and daily caps), send, record the result. Never throws.
 */
export async function refundAgent(
  books: Books,
  send: (to: string, amount: bigint) => Promise<RefundOutcome>,
  o: { key: string; chain: ProxyChain; day: string; to: string | null; amount: bigint; now: () => Date },
): Promise<RefundRecord> {
  const amountAtomic = o.amount.toString();
  if (!o.to) return { status: "refused", to: null, amountAtomic, tx: null, reason: "payer_unknown" };
  const c = books.refundClaim(o.key, o.chain, o.day, o.to, o.amount, o.now());
  if (!c.ok) return { status: "refused", to: o.to, amountAtomic, tx: null, reason: c.reason };
  let out: RefundOutcome;
  try {
    out = await send(o.to, o.amount);
  } catch {
    out = { status: "unknown", reason: "refund_error", tx: null };
  }
  const reason = out.status === "sent" ? null : out.reason;
  books.refundResult(o.key, { status: out.status, tx: out.tx, feePaid: out.status === "sent" ? (out.feePaid ?? null) : null, reason }, o.now());
  return { status: out.status, to: o.to, amountAtomic, tx: out.tx, reason };
}
