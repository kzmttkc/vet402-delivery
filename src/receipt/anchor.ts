/**
 * The daily anchor: one Solana Memo instruction carrying the day's root. This module only builds the
 * unsigned transaction and asks an RPC to simulate it (sigVerify: false). It never signs and never
 * sends. Writing the root for real is a separate, owner-approved step.
 */
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
} from "@solana/kit";
import type { Rpc } from "../chain.js";
import { MEMO_PROGRAM } from "../constants.js";

/** Solana memo limit is ~566 bytes; the anchor memo is far below it. */
export const MAX_MEMO_BYTES = 566;

export function buildUnsignedMemoTx(feePayer: string, memo: string, blockhash = "11111111111111111111111111111111"): string {
  const data = new TextEncoder().encode(memo);
  if (data.length > MAX_MEMO_BYTES) throw new Error(`memo ${data.length} bytes > ${MAX_MEMO_BYTES}`);
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(feePayer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash as Blockhash, lastValidBlockHeight: 0n }, m),
    (m) => appendTransactionMessageInstructions([{ programAddress: address(MEMO_PROGRAM), data }], m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(msg));
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
