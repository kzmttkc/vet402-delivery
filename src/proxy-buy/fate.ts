/**
 * Whether a transaction vet402 handed over (the agent's payment, vet402's payment to a seller, a refund)
 * landed, failed, can never land, or cannot be told yet. A refund is only ever made on "dead" or "failed"
 * (proof that the money did not move), never on "cannot tell".
 *
 * Solana: the transaction is found by the sha256 of its message bytes among the recent signatures of an
 * account it touches; it is dead once its blockhash is no longer valid and it still is not there.
 * Tempo: by its hash (or, for a fee-sponsored envelope whose hash changes, the one matching transfer since a
 * block); it is dead once the chain's time is past its validBefore, or (protocol nonce) the sender's nonce
 * moved past it, and it still is not there.
 * Errors are swallowed into "pending": an RPC error message can carry the RPC URL.
 */
import { createHash } from "node:crypto";
import { getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { keccak256, type Hex } from "viem";
import { Transaction } from "viem/tempo";
import type { Rpc } from "../chain.js";
import { TOKEN_PROGRAM } from "../constants.js";

export type Fate = { fate: "landed"; tx: string } | { fate: "failed"; tx: string } | { fate: "dead" } | { fate: "pending" };

// ---------------- Solana ----------------

export interface SolanaTxFacts {
  /** sha256 hex of the message bytes: the same for every signature set of this transaction. */
  messageHash: string;
  blockhash: string;
  feePayer: string;
  /** The TransferChecked authority (the account whose tokens moved) and amount, when there is exactly one. */
  authority: string | null;
  amount: string | null;
}

export function decodeSolanaTx(txBase64: string): SolanaTxFacts | null {
  try {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(txBase64));
    const bytes = Uint8Array.from(tx.messageBytes);
    const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const keys = msg.staticAccounts.map(String);
    let authority: string | null = null;
    let amount: string | null = null;
    let transfers = 0;
    for (const ix of msg.instructions) {
      if (keys[ix.programAddressIndex] !== TOKEN_PROGRAM) continue;
      const data = ix.data ?? new Uint8Array();
      const accts = (ix.accountIndices ?? []).map((i) => keys[i]);
      if (data[0] === 12 && data.length === 10 && accts.length === 4) {
        transfers++;
        authority = accts[3] ?? null;
        let v = 0n;
        for (let i = 8; i >= 1; i--) v = (v << 8n) | BigInt(data[i]!);
        amount = v.toString();
      }
    }
    const lifetime = (msg as { lifetimeToken?: string }).lifetimeToken ?? "";
    return {
      messageHash: createHash("sha256").update(bytes).digest("hex"),
      blockhash: String(lifetime),
      feePayer: keys[0] ?? "",
      authority: transfers === 1 ? authority : null,
      amount: transfers === 1 ? amount : null,
    };
  } catch {
    return null;
  }
}

/**
 * Find the transaction with `messageHash` among `account`'s signatures, paging back (`before`) until the history
 * is older than `since` (unix seconds, the purchase's start) or ends; then, if absent, whether it can still land.
 * "dead" needs the whole window read: a listed signature whose transaction the RPC does not serve yet, a history
 * longer than `maxPages`, or any read error leaves the answer at "pending" (no refund on a guess).
 */
export async function solanaTxFate(
  rpc: Rpc,
  f: { messageHash: string; blockhash: string; account: string; since?: number; pageSize?: number; maxPages?: number },
): Promise<Fate> {
  const pageSize = f.pageSize ?? 100;
  const maxPages = f.maxPages ?? 10;
  let complete = false;
  const find = async (): Promise<Fate | null> => {
    complete = false;
    let unreadable = false;
    let before: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const sigs = (await rpc("getSignaturesForAddress", [f.account, { limit: pageSize, commitment: "confirmed", ...(before ? { before } : {}) }])) as { signature: string; blockTime?: number | null }[];
      for (const s of sigs) {
        if (f.since !== undefined && typeof s.blockTime === "number" && s.blockTime < f.since) {
          complete = !unreadable;
          return null;
        }
        const t = (await rpc("getTransaction", [s.signature, { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 0 }])) as {
          meta: { err: unknown } | null;
          transaction: [string, string];
        } | null;
        if (!t) {
          unreadable = true; // listed but not served: it may be the one
          continue;
        }
        const d = decodeSolanaTx(t.transaction[0]);
        if (d && d.messageHash === f.messageHash) return t.meta?.err ? { fate: "failed", tx: s.signature } : { fate: "landed", tx: s.signature };
      }
      if (sigs.length < pageSize) {
        complete = !unreadable;
        return null;
      }
      before = sigs[sigs.length - 1]!.signature;
    }
    return null; // more history than maxPages: not complete
  };
  try {
    const hit = await find();
    if (hit) return hit;
    const valid = (await rpc("isBlockhashValid", [f.blockhash, { commitment: "confirmed" }])) as { value: boolean } | null;
    if (!valid || valid.value !== false) return { fate: "pending" };
    // expired: one last full look, in case it landed between the two reads
    const last = await find();
    if (last) return last;
    return complete ? { fate: "dead" } : { fate: "pending" };
  } catch {
    return { fate: "pending" };
  }
}

// ---------------- Tempo ----------------

export interface TempoTxFacts {
  hash: string;
  from: string;
  nonce: string;
  nonceKey: string;
  /** Unix seconds; null when the transaction has none. */
  validBefore: string | null;
  /** 0x78: a fee-payer envelope, re-signed by the server; the hash on chain differs. */
  sponsored: boolean;
}

export function decodeTempoTx(serialized: string): TempoTxFacts | null {
  try {
    const t = Transaction.deserialize(serialized as `0x76${string}`) as { from?: string; nonce?: unknown; nonceKey?: unknown; validBefore?: unknown };
    return {
      hash: keccak256(serialized as Hex).toLowerCase(),
      from: String(t.from ?? "").toLowerCase(),
      nonce: String(t.nonce ?? 0),
      nonceKey: String(t.nonceKey ?? 0),
      validBefore: t.validBefore === undefined || t.validBefore === null ? null : String(t.validBefore),
      sponsored: serialized.slice(0, 4).toLowerCase() === "0x78",
    };
  } catch {
    return null;
  }
}

export interface TempoReads {
  /** null: no receipt. */
  receipt(hash: string): Promise<{ status: "success" | "reverted" } | null>;
  /** The head block's timestamp (unix seconds). */
  headTime(): Promise<bigint>;
  /** The sender's protocol nonce (nonce key 0), as of the head. */
  nonce(address: string): Promise<bigint>;
  /** Tx hashes from `fromBlock` on with a USDC.e Transfer payer -> recipient of exactly `amount`. */
  transfers(exp: { payer: string; recipient: string; amount: bigint }, fromBlock: bigint): Promise<string[]>;
}

export async function tempoTxFate(
  r: TempoReads,
  f: TempoTxFacts & { search?: { recipient: string; amount: string; fromBlock: string; known?: string[] } },
): Promise<Fate> {
  try {
    const rc = await r.receipt(f.hash);
    if (rc) return rc.status === "success" ? { fate: "landed", tx: f.hash } : { fate: "failed", tx: f.hash };
    const look = async (): Promise<Fate | null> => {
      if (!f.search) return null;
      const known = new Set((f.search.known ?? []).map((h) => h.toLowerCase()));
      const hits = [...new Set((await r.transfers({ payer: f.from, recipient: f.search.recipient, amount: BigInt(f.search.amount) }, BigInt(f.search.fromBlock))).map((h) => h.toLowerCase()))].filter(
        (h) => !known.has(h),
      );
      if (hits.length === 1) return { fate: "landed", tx: hits[0]! };
      if (hits.length > 1) return { fate: "pending" }; // more than one fits: a human decides
      return null;
    };
    const hit = await look();
    if (hit) return hit;
    let dead = false;
    if (f.validBefore !== null && (await r.headTime()) > BigInt(f.validBefore)) dead = true;
    if (!dead && f.nonceKey === "0" && (await r.nonce(f.from)) > BigInt(f.nonce)) dead = true;
    if (!dead) return { fate: "pending" };
    const rc2 = await r.receipt(f.hash);
    if (rc2) return rc2.status === "success" ? { fate: "landed", tx: f.hash } : { fate: "failed", tx: f.hash };
    return (await look()) ?? { fate: "dead" };
  } catch {
    return { fate: "pending" };
  }
}
