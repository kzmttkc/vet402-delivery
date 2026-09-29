/**
 * The daily anchor: one Solana Memo instruction carrying the day's root. This module builds the
 * transaction, checks that it holds nothing but that memo, and asks an RPC to simulate it. It never
 * signs and never sends; scripts/anchor-receipts.ts does that, and only with --send.
 */
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
} from "@solana/kit";
import type { Rpc } from "../chain.js";
import { MEMO_PROGRAM } from "../constants.js";

/** Solana memo limit is ~566 bytes; the anchor memo is far below it. */
export const MAX_MEMO_BYTES = 566;

/** The compiled (unsigned) memo transaction: one Memo instruction, no accounts, `feePayer` pays the fee. */
export function compileMemoTx(feePayer: string, memo: string, blockhash = "11111111111111111111111111111111", lastValidBlockHeight = 0n) {
  const data = new TextEncoder().encode(memo);
  if (data.length > MAX_MEMO_BYTES) throw new Error(`memo ${data.length} bytes > ${MAX_MEMO_BYTES}`);
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(feePayer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash as Blockhash, lastValidBlockHeight }, m),
    (m) => appendTransactionMessageInstructions([{ programAddress: address(MEMO_PROGRAM), data }], m),
  );
  const tx = compileTransaction(msg);
  assertMemoOnly(tx.messageBytes, feePayer, memo);
  return tx;
}

export function buildUnsignedMemoTx(feePayer: string, memo: string, blockhash = "11111111111111111111111111111111"): string {
  return getBase64EncodedWireTransaction(compileMemoTx(feePayer, memo, blockhash));
}

/**
 * Decode a compiled message and refuse anything but the anchor: exactly two accounts (the fee payer,
 * the only signer and only writable account; the Memo program), exactly one instruction, to the Memo
 * program, with no accounts and exactly the memo bytes. Nothing else can move lamports or tokens.
 */
export function assertMemoOnly(messageBytes: Parameters<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>[0], feePayer: string, memo: string): void {
  const m = getCompiledTransactionMessageDecoder().decode(messageBytes) as unknown as {
    header: { numSignerAccounts: number; numReadonlySignerAccounts: number; numReadonlyNonSignerAccounts: number };
    staticAccounts: string[];
    instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[];
    addressTableLookups?: unknown[];
  };
  const fail = (why: string): never => {
    throw new Error(`anchor transaction refused: ${why}`);
  };
  if (m.staticAccounts.length !== 2 || m.staticAccounts[0] !== feePayer || m.staticAccounts[1] !== MEMO_PROGRAM) fail(`accounts ${m.staticAccounts.join(",")}`);
  if (m.header.numSignerAccounts !== 1 || m.header.numReadonlySignerAccounts !== 0 || m.header.numReadonlyNonSignerAccounts !== 1) fail("header");
  if ((m.addressTableLookups ?? []).length) fail("address table lookups");
  if (m.instructions.length !== 1) fail(`${m.instructions.length} instructions`);
  const ix = m.instructions[0]!;
  if (ix.programAddressIndex !== 1) fail("instruction is not to the Memo program");
  if ((ix.accountIndices ?? []).length) fail("memo instruction names accounts");
  const want = new TextEncoder().encode(memo);
  const got: ArrayLike<number> = ix.data ?? new Uint8Array();
  if (got.length !== want.length || want.some((b, i) => b !== got[i])) fail("memo bytes differ");
}

export interface SimulateResult {
  ok: boolean;
  err: unknown;
  unitsConsumed: number | null;
  logs: string[];
}

export async function simulateMemoAnchor(rpc: Rpc, feePayer: string, memo: string): Promise<SimulateResult> {
  const wire = buildUnsignedMemoTx(feePayer, memo);
  const r = (await rpc("simulateTransaction", [wire, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }])) as {
    value: { err: unknown; logs: string[] | null; unitsConsumed?: number };
  };
  return { ok: r.value.err === null, err: r.value.err, unitsConsumed: r.value.unitsConsumed ?? null, logs: r.value.logs ?? [] };
}
