/**
 * Small transaction helpers for the observation-roots tests and the devnet run: send a list of
 * instructions signed by given keys, or simulate them and read the return data.
 */
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import type { Rpc } from "../chain.js";

async function compile(rpc: Rpc, feePayer: string, ixs: Instruction[]) {
  const { value: bh } = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])) as { value: { blockhash: string; lastValidBlockHeight: number } };
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(feePayer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: bh.blockhash as Blockhash, lastValidBlockHeight: BigInt(bh.lastValidBlockHeight) }, m),
  );
  return compileTransaction(appendTransactionMessageInstructions(ixs, msg));
}

export interface SimResult {
  err: unknown;
  logs: string[];
  unitsConsumed: number | null;
  returnData: Uint8Array | null;
  returnProgram: string | null;
  /** Serialized size of the transaction with its signatures. */
  txBytes: number;
}

export async function simulateIxs(rpc: Rpc, feePayer: string, ixs: Instruction[]): Promise<SimResult> {
  const tx = await compile(rpc, feePayer, ixs);
  const wire = getBase64EncodedWireTransaction(tx);
  const r = (await rpc("simulateTransaction", [wire, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }])) as {
    value: { err: unknown; logs: string[] | null; unitsConsumed?: number; returnData?: { programId: string; data: [string, string] } | null };
  };
  const rd = r.value.returnData;
  return {
    err: r.value.err,
    logs: r.value.logs ?? [],
    unitsConsumed: r.value.unitsConsumed ?? null,
    returnData: rd ? Uint8Array.from(Buffer.from(rd.data[0], "base64")) : null,
    returnProgram: rd?.programId ?? null,
    txBytes: Buffer.from(wire, "base64").length,
  };
}

export interface SendResult {
  signature: string;
  err: unknown;
  logs: string[];
  returnData: Uint8Array | null;
  txBytes: number;
}

/** Sends with preflight off (so failures land and can be checked) and waits for confirmation. */
export async function sendIxs(rpc: Rpc, feePayer: KeyPairSigner, ixs: Instruction[], extraSigners: KeyPairSigner[] = []): Promise<SendResult> {
  const tx = await compile(rpc, feePayer.address, ixs);
  const signed = await signTransaction([feePayer.keyPair, ...extraSigners.map((s) => s.keyPair)], tx);
  const signature = getSignatureFromTransaction(signed);
  const wire = getBase64EncodedWireTransaction(signed);
  for (let i = 0; i < 90; i++) {
    // Same signed bytes every few seconds until it lands: one signature, so it cannot land twice.
    if (i % 5 === 0) await rpc("sendTransaction", [wire, { encoding: "base64", skipPreflight: true, maxRetries: 0 }]);
    await new Promise((r) => setTimeout(r, 1000));
    const st = (await rpc("getSignatureStatuses", [[signature]])) as { value: ({ err: unknown; confirmationStatus: string | null } | null)[] };
    const s = st.value[0];
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
      const t = (await rpc("getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }])) as {
        meta: { err: unknown; logMessages: string[] | null; returnData?: { data: [string, string] } | null };
      };
      const rd = t.meta.returnData;
      return { signature, err: t.meta.err, logs: t.meta.logMessages ?? [], returnData: rd ? Uint8Array.from(Buffer.from(rd.data[0], "base64")) : null, txBytes: Buffer.from(wire, "base64").length };
    }
  }
  throw new Error(`${signature} not confirmed`);
}

/** The custom error code of a failed instruction, or null. */
export function customError(err: unknown): number | null {
  const e = err as { InstructionError?: [number, { Custom?: number } | string] } | null;
  const inner = e?.InstructionError?.[1];
  return typeof inner === "object" && inner && typeof inner.Custom === "number" ? inner.Custom : null;
}
