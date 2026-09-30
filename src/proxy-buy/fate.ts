/**
 * Whether a transaction vet402 handed over (the agent's payment, vet402's payment to a seller, a refund)
 * landed, failed, can never land, or cannot be told yet. A refund is only ever made on "dead" or "failed"
 * (proof that the money did not move), never on "cannot tell".
 *
 * Solana: the transaction is found by the sha256 of its message bytes among the signatures of an account it
 * touches, inside the slots it could have landed in; it is dead once its blockhash is no longer valid and it is
 * not in that window.
 * Tempo: by its own hash. Only a fee-sponsored envelope (whose hash the sponsor changes) is looked for another
 * way: the one transfer carrying its challenge-bound memo. It is dead once the chain's time is past its
 * validBefore, or (protocol nonce) the sender's nonce moved past it, and it still is not there.
 * Errors are swallowed into "pending": an RPC error message can carry the RPC URL.
 */
import { createHash } from "node:crypto";
import { getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from "@solana/kit";
import { decodeFunctionData, keccak256, type Hex } from "viem";
import { Abis, Transaction } from "viem/tempo";
import type { Rpc } from "../chain.js";
import { TOKEN_PROGRAM } from "../constants.js";

/** `capped`: the search stopped before it could read everything it needed (see solanaTxFate); a human looks. */
export type Fate = { fate: "landed"; tx: string } | { fate: "failed"; tx: string } | { fate: "dead" } | { fate: "pending"; capped?: string };

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

/** Most getTransaction reads one Solana fate call makes; past it the answer is "pending" with `capped`. */
export const SOLANA_FATE_MAX_TX_READS = 200;

export interface SolanaFateQuery {
  messageHash: string;
  blockhash: string;
  account: string;
  /** Unix seconds before which the transaction cannot have landed. */
  since?: number;
  /** The confirmed slot read before the transaction was handed over: it cannot have landed below it. */
  minSlot?: number;
  pageSize?: number;
  maxPages?: number;
  maxTxReads?: number;
  /** Epoch ms: stop reading then ("pending", capped "deadline"). */
  deadline?: number;
}

/**
 * Find the transaction with `messageHash` among `account`'s signatures, paging back (`before`), and decide:
 *   - its blockhash still valid: "landed"/"failed" if found, else "pending" (it can still land);
 *   - its blockhash expired: the confirmed slot is read after that, so the transaction, if it ever landed, is in
 *     the slots from `minSlot` to that slot. Signatures above the window are skipped without reading their
 *     transaction; the search stops below `minSlot` or below `since`. Not found in a window read completely: "dead".
 * Anything that leaves the window unread (a listed transaction the RPC does not serve yet, more history than
 * `maxPages`, more than `maxTxReads` transactions to read, the deadline, a read error) leaves the answer at
 * "pending" (no refund on a guess); `capped` then says why, and the reconciler reports it (ALERT).
 */
export async function solanaTxFate(rpc: Rpc, f: SolanaFateQuery): Promise<Fate> {
  const pageSize = f.pageSize ?? 1000;
  const maxPages = f.maxPages ?? 10;
  const maxReads = f.maxTxReads ?? SOLANA_FATE_MAX_TX_READS;
  let reads = 0;
  let capped: string | null = null;
  const late = () => f.deadline !== undefined && Date.now() >= f.deadline;
  /** hit null + complete: not in the window; hit null + !complete: the window was not read to its end. */
  const find = async (maxSlot: number | null): Promise<{ hit: Fate | null; complete: boolean }> => {
    let unreadable = false;
    let before: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      if (late()) {
        capped = "deadline";
        return { hit: null, complete: false };
      }
      const sigs = (await rpc("getSignaturesForAddress", [f.account, { limit: pageSize, commitment: "confirmed", ...(before ? { before } : {}) }])) as {
        signature: string;
        slot?: number | null;
        blockTime?: number | null;
      }[];
      for (const s of sigs) {
        const slot = typeof s.slot === "number" ? s.slot : null;
        if (f.minSlot !== undefined && slot !== null && slot < f.minSlot) return { hit: null, complete: !unreadable };
        if (f.since !== undefined && typeof s.blockTime === "number" && s.blockTime < f.since) return { hit: null, complete: !unreadable };
        if (maxSlot !== null && slot !== null && slot > maxSlot) continue; // after the blockhash expired: not it
        if (reads >= maxReads) {
          capped = "tx_reads";
          return { hit: null, complete: false };
        }
        if (late()) {
          capped = "deadline";
          return { hit: null, complete: false };
        }
        reads++;
        const t = (await rpc("getTransaction", [s.signature, { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: 0 }])) as {
          meta: { err: unknown } | null;
          transaction: [string, string];
        } | null;
        if (!t) {
          unreadable = true; // listed but not served: it may be the one
          continue;
        }
        const d = decodeSolanaTx(t.transaction[0]);
        if (d && d.messageHash === f.messageHash) return { hit: t.meta?.err ? { fate: "failed", tx: s.signature } : { fate: "landed", tx: s.signature }, complete: true };
      }
      if (sigs.length < pageSize) return { hit: null, complete: !unreadable };
      before = sigs[sigs.length - 1]!.signature;
    }
    capped = capped ?? "pages";
    return { hit: null, complete: false };
  };
  const pending = (): Fate => (capped ? { fate: "pending", capped } : { fate: "pending" });
  try {
    const valid = (await rpc("isBlockhashValid", [f.blockhash, { commitment: "confirmed" }])) as { value: boolean } | null;
    if (!valid || valid.value !== false) {
      const r = await find(null);
      return r.hit ?? pending();
    }
    // Expired at the confirmed slot: every slot it could have landed in is at or below the slot read now.
    const maxSlot = Number(await rpc("getSlot", [{ commitment: "confirmed" }]));
    if (!Number.isSafeInteger(maxSlot)) return pending();
    const r = await find(maxSlot);
    if (r.hit) return r.hit;
    return r.complete ? { fate: "dead" } : pending();
  } catch {
    return pending();
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
  /** The bytes32 memo of its one transferWithMemo call (mppx binds it to the challenge), else null. */
  memo: string | null;
}

export function decodeTempoTx(serialized: string): TempoTxFacts | null {
  try {
    const t = Transaction.deserialize(serialized as `0x76${string}`) as unknown as {
      from?: string;
      nonce?: unknown;
      nonceKey?: unknown;
      validBefore?: unknown;
      calls?: readonly { data?: Hex }[];
    };
    let memo: string | null = null;
    const calls = t.calls ?? [];
    if (calls.length === 1 && calls[0]!.data) {
      try {
        const d = decodeFunctionData({ abi: Abis.tip20, data: calls[0]!.data });
        if (d.functionName === "transferWithMemo") memo = String((d.args as unknown as unknown[])[2]).toLowerCase();
      } catch {
        memo = null;
      }
    }
    return {
      hash: keccak256(serialized as Hex).toLowerCase(),
      from: String(t.from ?? "").toLowerCase(),
      nonce: String(t.nonce ?? 0),
      nonceKey: String(t.nonceKey ?? 0),
      validBefore: t.validBefore === undefined || t.validBefore === null ? null : String(t.validBefore),
      sponsored: serialized.slice(0, 4).toLowerCase() === "0x78",
      memo,
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
  /** Tx hashes from `fromBlock` on with a USDC.e TransferWithMemo payer -> recipient of exactly `amount` and this memo. */
  memoTransfers(exp: { payer: string; recipient: string; amount: bigint; memo: string }, fromBlock: bigint): Promise<string[]>;
}

export type TempoFateFacts = TempoTxFacts & { search?: { recipient: string; amount: string; fromBlock: string }; known?: string[] };

/**
 * A self-paid transaction (every agent payment and refund, and a seller payment the seller does not sponsor) is
 * found by its own hash only: a transfer of the same amount from the same wallet may be another purchase's.
 * A sponsored seller payment is found by its memo (bound to that seller's challenge); a hash in `known` (recorded
 * for another purchase) is never taken, and more than one match is left to a human ("pending").
 */
export async function tempoTxFate(r: TempoReads, f: TempoFateFacts): Promise<Fate> {
  try {
    const rc = await r.receipt(f.hash);
    if (rc) return rc.status === "success" ? { fate: "landed", tx: f.hash } : { fate: "failed", tx: f.hash };
    const look = async (): Promise<Fate | null> => {
      if (!f.sponsored || !f.memo || !f.search) return null;
      const known = new Set((f.known ?? []).map((h) => h.toLowerCase()));
      const found = await r.memoTransfers({ payer: f.from, recipient: f.search.recipient, amount: BigInt(f.search.amount), memo: f.memo }, BigInt(f.search.fromBlock));
      const hits = [...new Set(found.map((h) => h.toLowerCase()))].filter((h) => !known.has(h));
      if (hits.length === 1) return { fate: "landed", tx: hits[0]! };
      if (hits.length > 1) return { fate: "pending", capped: "ambiguous_transfer" }; // more than one fits: a human decides
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
