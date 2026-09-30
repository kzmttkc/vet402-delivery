/**
 * Refunds: when the agent's payment settled but vet402 did not pay the seller (proven: payOne refused before
 * sending, or vet402's payment to the seller is dead on chain), the agent's full payment (seller price + fee)
 * goes back from vet402's proxy payer wallet to the account whose balance paid, on the same chain, in the
 * same token.
 *
 * Order for one attempt: take the refund (one per purchase: Store.refundClaim) -> build and
 * sign -> read the signed transaction back -> write its signature/hash and expiry to the database -> send ->
 * confirm. A later attempt is made only after the previous one is proven dead on chain (reconcile.ts).
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
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Blockhash,
  type KeyPairSigner,
} from "@solana/kit";
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import { encodeFunctionData, keccak256, type Client, type Hex, type LocalAccount } from "viem";
import { call, estimateGas, getBlock, getTransactionCount, sendRawTransactionSync } from "viem/actions";
import { Abis, Transaction } from "viem/tempo";
import { readTransaction, type Rpc } from "../chain.js";
import { COMPUTE_BUDGET_PROGRAM, TOKEN_PROGRAM, USDC_DECIMALS, USDC_MINT } from "../constants.js";
import { maxFeeAtomic, TEMPO_BASE_FEE_CAP } from "../receipt/tempo-anchor.js";
import { usdcAta } from "../txcheck.js";
import type { SettlementCheck } from "../tempo/chain.js";
import { FEE_RESERVE_ATOMIC, TEMPO_MAINNET_CHAIN_ID, USDC_E } from "../tempo/constants.js";
import { checkSignedTransfer } from "../tempo/txcheck.js";
import type { ProxyChain } from "./allowlist.js";
import { REFUND_ACCOUNT_CREATIONS_PER_DAY } from "./constants.js";
import { decodeSolanaTx } from "./fate.js";
import { MAX_REFUND_ATTEMPTS, type RefundRecord, type Store } from "./store.js";

export type RefundOutcome =
  | { status: "sent"; tx: string; feePaid?: string | null }
  /** Nothing left vet402 (proven): safe to say no refund was made. `permanent`: trying again cannot help. */
  | { status: "failed"; reason: string; tx: null; permanent?: boolean }
  /** A signed refund may have left vet402 and is not confirmed yet: the reconciler decides, never a blind retry. */
  | { status: "unknown"; reason: string; tx: string | null };

/**
 * The refund needs the agent's USDC account created and the day's creations are used up: not a failure, it is
 * tried again on the next UTC day.
 */
export const ACCOUNT_CREATION_WAIT = "refund_account_missing_creation_limit";

/** Facts written to the database before a refund is sent (so a stopped process can find it). */
export type BeforeSend = (facts: { tx: string; facts: Record<string, unknown> }) => Promise<boolean>;

function readU64LE(b: ArrayLike<number>, off: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]!);
  return v;
}

/**
 * null = the transaction is exactly one USDC TransferChecked of `amount` from ATA(payer) to ATA(to), paid for and
 * signed by `payer`, with nothing else but ComputeBudget and at most one idempotent creation of ATA(to) (so a
 * refund reaches an agent whose USDC account was closed; the payer funds its rent). Otherwise why not.
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
  let creates = 0;
  for (const ix of msg.instructions) {
    const program = keys[ix.programAddressIndex];
    const accts = (ix.accountIndices ?? []).map((i) => keys[i]);
    const data = ix.data ?? new Uint8Array();
    if (program === COMPUTE_BUDGET_PROGRAM) {
      if (accts.length !== 0 || (data[0] !== 2 && data[0] !== 3)) return "unexpected ComputeBudget instruction";
      continue;
    }
    if (program === ASSOCIATED_TOKEN_PROGRAM_ADDRESS) {
      // CreateIdempotent: [1]; accounts [payer (funds rent), ata, owner, mint, system program, token program]
      if (data.length !== 1 || data[0] !== 1 || accts.length !== 6) return "unexpected associated token instruction";
      if (accts[0] !== exp.payer || accts[1] !== dst || accts[2] !== exp.to || accts[3] !== USDC_MINT || accts[5] !== TOKEN_PROGRAM) return "associated token account is not ATA(to, USDC)";
      if (transfers > 0) return "account creation after the transfer";
      creates++;
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
  if (creates > 1) return "more than one account creation";
  return transfers === 1 ? null : `${transfers} transfers (expected 1)`;
}

export interface SolanaRefundDeps {
  rpc: Rpc;
  signer: KeyPairSigner;
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The owner may be any address, a program-derived one (a multisig vault) included: its associated USDC account is
 * derived the same way and the associated token program creates it for an off-curve owner too.
 * The USDC account is created by the refund only when it does not exist, and only while the day's count of such
 * creations (their rent is paid in SOL by the payer) is below REFUND_ACCOUNT_CREATIONS_PER_DAY; otherwise nothing
 * is sent and the reconciler tries again on the next UTC day (not counted as a failure).
 */
export async function sendSolanaRefund(d: SolanaRefundDeps, to: string, amount: bigint, beforeSend: BeforeSend, opts: SendOptions = {}): Promise<RefundOutcome> {
  const payer = d.signer.address;
  if (!isAddress(to) || to === payer) return { status: "failed", reason: "refund_to_invalid", tx: null, permanent: true };
  if (amount <= 0n) return { status: "failed", reason: "refund_amount_invalid", tx: null, permanent: true };
  const src = await usdcAta(payer);
  const dst = await usdcAta(to);
  let lifetime: { blockhash: Blockhash; lastValidBlockHeight: bigint };
  let minSlot: number | undefined;
  let create: boolean;
  try {
    const r = (await d.rpc("getLatestBlockhash", [{ commitment: "confirmed" }])) as { context?: { slot?: number }; value: { blockhash: string; lastValidBlockHeight: number | string } };
    lifetime = { blockhash: r.value.blockhash as Blockhash, lastValidBlockHeight: BigInt(r.value.lastValidBlockHeight) };
    minSlot = typeof r.context?.slot === "number" ? r.context.slot : undefined;
    const acct = (await d.rpc("getAccountInfo", [dst, { encoding: "base64", commitment: "confirmed" }])) as { value: unknown } | null;
    if (!acct || !("value" in acct)) throw new Error("no answer");
    create = acct.value === null;
  } catch {
    return { status: "failed", reason: "rpc_error", tx: null };
  }
  if (create && !(opts.mayCreateAccount && (await opts.mayCreateAccount().catch(() => false)))) {
    return { status: "failed", reason: ACCOUNT_CREATION_WAIT, tx: null };
  }
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(d.signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) =>
      appendTransactionMessageInstructions(
        [
          ...(create ? [getCreateAssociatedTokenIdempotentInstruction({ payer: d.signer, ata: address(dst), owner: address(to), mint: address(USDC_MINT), tokenProgram: address(TOKEN_PROGRAM) })] : []),
          getTransferCheckedInstruction({ source: address(src), mint: address(USDC_MINT), destination: address(dst), authority: d.signer, amount, decimals: USDC_DECIMALS }),
        ],
        m,
      ),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const b64 = getBase64EncodedWireTransaction(signed);
  const sig = getSignatureFromTransaction(signed);
  if (await checkSolanaRefundTx(b64, { payer, to, amount })) return { status: "failed", reason: "refund_tx_check_failed", tx: null, permanent: true };
  const facts = decodeSolanaTx(b64);
  const since = Math.floor(Date.now() / 1000) - 120;
  if (!(await beforeSend({ tx: sig, facts: { chain: "solana", signature: sig, messageHash: facts?.messageHash, blockhash: lifetime.blockhash, account: src, since, ...(minSlot !== undefined ? { minSlot } : {}) } }))) {
    return { status: "failed", reason: "refund_taken_by_another_attempt", tx: null };
  }

  // ---- from here the refund may have left vet402 ----
  try {
    await d.rpc("sendTransaction", [b64, { encoding: "base64", preflightCommitment: "confirmed" }]);
  } catch {
    // A preflight rejection means nothing was sent; a timeout may not. Only the chain can tell.
  }
  const deadline = Date.now() + (d.timeoutMs ?? 30_000);
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (;;) {
    try {
      const r = await readTransaction(d.rpc, sig, payer, to);
      if (r.found) {
        if (r.err !== null) return { status: "unknown", reason: "refund_tx_failed_on_chain", tx: sig }; // the reconciler proves it and tries again
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
  /** Seconds the refund stays valid after the head block's time. */
  validForSeconds?: number;
}

/**
 * The Tempo refund, the way the Tempo anchor sends (src/receipt/anchor-tempo-run.ts): eth_call it first,
 * eth_estimateGas x 1.25 as the gas limit, the base-fee cap as maxFeePerGas, the fee in USDC.e and its bound
 * within the fee reserve, plus a validBefore so a transaction that never lands is provably dead.
 */
export async function sendTempoRefund(d: TempoRefundDeps, to: string, amount: bigint, beforeSend: BeforeSend): Promise<RefundOutcome> {
  const payer = d.account.address;
  if (!/^0x[0-9a-fA-F]{40}$/.test(to) || to.toLowerCase() === payer.toLowerCase()) return { status: "failed", reason: "refund_to_invalid", tx: null, permanent: true };
  if (amount <= 0n) return { status: "failed", reason: "refund_amount_invalid", tx: null };
  const data = encodeFunctionData({ abi: Abis.tip20, functionName: "transfer", args: [to as Hex, amount] });
  let serialized: Hex;
  let validBefore: bigint;
  let fromBlock: bigint;
  try {
    await call(d.client, { account: payer, to: USDC_E as Hex, data });
    const estimate = await estimateGas(d.client, { account: payer, to: USDC_E as Hex, data });
    const gas = (estimate * 5n + 3n) / 4n;
    if (maxFeeAtomic(gas, TEMPO_BASE_FEE_CAP) > FEE_RESERVE_ATOMIC) return { status: "failed", reason: "refund_fee_over_reserve", tx: null };
    const block = await getBlock(d.client);
    validBefore = block.timestamp + BigInt(d.validForSeconds ?? 120);
    fromBlock = block.number ?? 0n;
    const nonce = await getTransactionCount(d.client, { address: payer, blockTag: "latest" });
    const tx = {
      type: "tempo" as const,
      chainId: TEMPO_MAINNET_CHAIN_ID,
      calls: [{ to: USDC_E as Hex, data }],
      nonce,
      gas,
      maxFeePerGas: TEMPO_BASE_FEE_CAP,
      maxPriorityFeePerGas: 0n,
      feeToken: USDC_E as Hex,
      validBefore: Number(validBefore),
    };
    serialized = (await d.account.signTransaction!(tx as never, { serializer: Transaction.serialize as never })) as Hex;
  } catch {
    return { status: "failed", reason: "rpc_error_or_simulation_failed", tx: null };
  }
  if (checkSignedTransfer(serialized, { payer, recipient: to, amount, sponsored: false })) return { status: "failed", reason: "refund_tx_check_failed", tx: null };
  const hash = keccak256(serialized);
  const decoded = Transaction.deserialize(serialized as never) as { nonce?: unknown; validBefore?: unknown };
  if (String(decoded.validBefore ?? "") !== validBefore.toString()) return { status: "failed", reason: "refund_tx_check_failed", tx: null };
  if (!(await beforeSend({ tx: hash, facts: {
        chain: "tempo",
        hash,
        from: payer.toLowerCase(),
        nonce: String(decoded.nonce ?? 0),
        nonceKey: "0",
        validBefore: validBefore.toString(),
        sponsored: false,
        search: { recipient: to.toLowerCase(), amount: amount.toString(), fromBlock: fromBlock.toString() },
      },
    }))) {
    return { status: "failed", reason: "refund_taken_by_another_attempt", tx: null };
  }

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

/** Options a sender may use: `mayCreateAccount` takes one of the day's refund account creations (Solana rent). */
export interface SendOptions {
  mayCreateAccount?: () => Promise<boolean>;
}

export type RefundSender = (to: string, amount: bigint, beforeSend: BeforeSend, opts?: SendOptions) => Promise<RefundOutcome>;

/**
 * Refund one purchase whose seller vet402 did not pay. First attempt: take the refund (one per purchase ever).
 * Later attempts (the reconciler): only from a state where no earlier refund transaction can still land, at most
 * MAX_REFUND_ATTEMPTS sent transactions and MAX_REFUND_FAILURES_BEFORE_SEND failures before sending; then the refund
 * is "stuck" and needs a human (the reconciler reports it). A failure that cannot change by itself (an address no
 * transfer can reach) is "stuck" at once. Never throws.
 */
export async function refundAgent(
  store: Store,
  send: RefundSender,
  o: { id: string; chain: ProxyChain; day: string; to: string | null; amount: bigint; maxRefund: bigint; now: () => Date; retry?: boolean },
): Promise<RefundRecord> {
  const amountAtomic = o.amount.toString();
  if (!o.to) return { status: "refused", to: null, amountAtomic, tx: null, reason: "payer_unknown" };
  if (!o.retry) {
    const c = await store.refundClaim(o.id, { chain: o.chain, day: o.day, to: o.to, amount: o.amount, maxRefund: o.maxRefund, now: o.now() });
    if (!c.ok) return { status: "refused", to: o.to, amountAtomic, tx: null, reason: c.reason };
  } else {
    const rf = await store.getRefund(o.id);
    if (rf && rf.status === "stuck") return { status: "stuck", to: o.to, amountAtomic, tx: rf.tx, reason: rf.reason ?? "stuck" };
    // Waiting for the next UTC day's account creations: nothing to try before then.
    if (rf && rf.status === "failed" && rf.reason === ACCOUNT_CREATION_WAIT && rf.updated_day === o.now().toISOString().slice(0, 10)) {
      return { status: "failed", to: o.to, amountAtomic, tx: null, reason: ACCOUNT_CREATION_WAIT };
    }
    if (rf && rf.status === "dead" && rf.attempt >= MAX_REFUND_ATTEMPTS) {
      await store.refundSet(o.id, ["dead"], "stuck", { reason: "too_many_attempts", now: o.now() });
      return { status: "stuck", to: o.to, amountAtomic, tx: rf.tx, reason: "too_many_attempts" };
    }
  }
  const from: ("pending" | "dead" | "failed")[] = o.retry ? ["pending", "dead", "failed"] : ["pending"];
  let taken = false;
  let out: RefundOutcome;
  const opts: SendOptions = {
    mayCreateAccount: () => store.bump(`refund-account:${o.chain}:${o.now().toISOString().slice(0, 10)}`, REFUND_ACCOUNT_CREATIONS_PER_DAY, o.now()),
  };
  try {
    out = await send(o.to, o.amount, async (f) => (taken = await store.refundSending(o.id, from, { tx: f.tx, facts: f.facts, now: o.now() })), opts);
  } catch {
    out = { status: "unknown", reason: "refund_error", tx: null };
  }
  if (out.status === "sent") {
    // One refund transaction pays back one purchase.
    if (await store.bindTx(o.chain, out.tx, o.id, "refund", o.now())) await store.refundSet(o.id, ["sending"], "sent", { feePaid: out.feePaid ?? null, tx: out.tx, now: o.now() });
    else out = { status: "unknown", reason: "refund_tx_bound_to_another_purchase", tx: out.tx };
  }
  if (out.status === "unknown") {
    if (taken) await store.refundSet(o.id, ["sending"], "unknown", { reason: out.reason, tx: out.tx, now: o.now() });
  } else if (out.status === "failed" && !taken && out.reason !== "refund_taken_by_another_attempt") {
    // Failed before anything was sent (a read or build error): counted; "stuck" when it cannot change or repeats.
    const st = await store.refundFailed(o.id, from, { reason: out.reason, permanent: out.permanent === true, counted: out.reason !== ACCOUNT_CREATION_WAIT, now: o.now() });
    if (st === "stuck") return { status: "stuck", to: o.to, amountAtomic, tx: null, reason: out.reason };
  }
  return { status: out.status, to: o.to, amountAtomic, tx: out.tx, reason: out.status === "sent" ? null : out.reason };
}
