/**
 * Read back the transaction the x402 SVM client built and signed, before it is sent.
 * Nothing leaves the process unless all of these hold:
 *  - no address lookup tables (every account is visible here)
 *  - fee payer (account 0) is the 402's extra.feePayer, and is not vet402
 *  - vet402's payer is a read-only signer (its SOL cannot move)
 *  - exactly one SPL Token TransferChecked: USDC mint, amount = accept.amount,
 *    destination = ATA(payTo, USDC), authority = payer, decimals 6
 *  - the only other instructions are ComputeBudget (limit/price) and Memo (no accounts)
 */
import {
  address,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address,
} from "@solana/kit";
import { findAssociatedTokenPda } from "@solana-program/token";
import { COMPUTE_BUDGET_PROGRAM, MEMO_PROGRAM, TOKEN_PROGRAM, USDC_DECIMALS, USDC_MINT } from "./constants.js";
import type { SolAccept } from "./guard.js";

export interface TxFacts {
  feePayer: string;
  destinationAta: string;
  amount: string;
  memo: string | null;
}

export type TxCheck = { ok: true; facts: TxFacts } | { ok: false; detail: string };

export async function usdcAta(owner: string): Promise<string> {
  const [ata] = await findAssociatedTokenPda({
    mint: address(USDC_MINT),
    owner: address(owner),
    tokenProgram: address(TOKEN_PROGRAM),
  });
  return ata;
}

function readU64LE(b: ArrayLike<number>, off: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]!);
  return v;
}

export async function checkPaymentTransaction(txBase64: string, accept: SolAccept, payer: string): Promise<TxCheck> {
  let msg;
  try {
    const bytes = getBase64Encoder().encode(txBase64);
    const tx = getTransactionDecoder().decode(bytes);
    msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  } catch (e) {
    return { ok: false, detail: `cannot decode transaction: ${(e as Error).message}` };
  }
  const keys = msg.staticAccounts.map(String);
  const lookups = (msg as { addressTableLookups?: unknown[] }).addressTableLookups ?? [];
  if (lookups.length > 0) return { ok: false, detail: "transaction uses address lookup tables" };

  const feePayer = keys[0];
  const expectedFeePayer = accept.extra?.feePayer;
  if (!feePayer || feePayer !== expectedFeePayer) return { ok: false, detail: `fee payer ${feePayer} != extra.feePayer ${String(expectedFeePayer)}` };
  if (feePayer === payer) return { ok: false, detail: "fee payer is vet402's payer" };

  const h = msg.header;
  const payerIdx = keys.indexOf(payer);
  if (payerIdx < 0) return { ok: false, detail: "payer is not in the transaction" };
  const isSigner = payerIdx < h.numSignerAccounts;
  const isReadonlySigner = isSigner && payerIdx >= h.numSignerAccounts - h.numReadonlySignerAccounts;
  if (!isReadonlySigner) return { ok: false, detail: "payer is not a read-only signer (its SOL could move)" };

  const destinationAta = await usdcAta(accept.payTo);
  let transfers = 0;
  let memo: string | null = null;
  let amountSeen = "";
  for (const ix of msg.instructions) {
    const program = keys[ix.programAddressIndex];
    const accts = (ix.accountIndices ?? []).map((i) => keys[i]);
    const data = ix.data ?? new Uint8Array();
    if (program === COMPUTE_BUDGET_PROGRAM) {
      if (accts.length !== 0 || (data[0] !== 2 && data[0] !== 3)) return { ok: false, detail: "unexpected ComputeBudget instruction" };
      continue;
    }
    if (program === MEMO_PROGRAM) {
      if (accts.length !== 0) return { ok: false, detail: "memo instruction with accounts" };
      memo = new TextDecoder().decode(data);
      continue;
    }
    if (program === TOKEN_PROGRAM) {
      // TransferChecked: [12, amount u64 LE, decimals u8]; accounts [source, mint, destination, authority]
      if (data.length !== 10 || data[0] !== 12) return { ok: false, detail: "token instruction is not TransferChecked" };
      if (accts.length !== 4) return { ok: false, detail: `TransferChecked with ${accts.length} accounts` };
      const [source, mint, dest, authority] = accts;
      if (source !== (await usdcAta(payer))) return { ok: false, detail: "transfer source is not the payer's USDC account" };
      const amount = readU64LE(data, 1);
      if (mint !== USDC_MINT) return { ok: false, detail: `transfer mint ${mint} is not USDC` };
      if (dest !== destinationAta) return { ok: false, detail: `transfer destination ${dest} != ATA(payTo) ${destinationAta}` };
      if (authority !== payer) return { ok: false, detail: "transfer authority is not the payer" };
      if (data[9] !== USDC_DECIMALS) return { ok: false, detail: "decimals != 6" };
      if (amount !== BigInt(accept.amount)) return { ok: false, detail: `transfer amount ${amount} != accept.amount ${accept.amount}` };
      amountSeen = amount.toString();
      transfers++;
      continue;
    }
    return { ok: false, detail: `unexpected program ${program}` };
  }
  if (transfers !== 1) return { ok: false, detail: `${transfers} token transfers (expected exactly 1)` };
  return { ok: true, facts: { feePayer, destinationAta: destinationAta as Address, amount: amountSeen, memo } };
}
