/**
 * Whether a transaction vet402 handed over (the agent's payment, vet402's payment to a seller, a refund)
 * landed, failed, can never land, or cannot be told yet. A refund is only ever made on "dead" or "failed"
 * (proof that the money did not move), never on "cannot tell".
 *
 * Solana: the transaction is found by its signature when vet402 paid its fee, else by the sha256 of its message
 * bytes among the signatures of an account it touches, inside the slots it could have landed in; it is dead once
 * its blockhash is no longer valid and a second look, some slots later, still does not find it in that window.
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

/**
 * `capped`: the search stopped before it could read everything it needed (see solanaTxFate); a human looks.
 * `expiredSlot` (Solana): the slot of the first answer that said the blockhash expired; the caller keeps it.
 */
export type Fate = { fate: "landed"; tx: string } | { fate: "failed"; tx: string } | { fate: "dead" } | { fate: "pending"; capped?: string; expiredSlot?: number };

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

/**
 * Slots between the first answer that said the blockhash expired and the look that may call the transaction
 * "dead": a node that indexes signatures a little behind the one that answered has caught up by then.
 */
export const DEAD_CONFIRM_SLOTS = 32;

export interface SolanaFateQuery {
  messageHash: string;
  blockhash: string;
  account: string;
  /** Unix seconds before which the transaction cannot have landed. */
  since?: number;
  /** The confirmed slot read before the transaction was handed over: it cannot have landed below it. */
  minSlot?: number;
  /**
   * The slot of the first answer that said the blockhash is no longer valid (returned in a "pending" answer as
   * `expiredSlot`; the caller keeps it with the facts). The transaction, if it ever landed, is at or below it.
   */
  expiredSlot?: number;
  /** The transaction's own signature, when vet402 paid its fee (a refund): looked up directly, no search. */
  signature?: string;
  pageSize?: number;
  maxPages?: number;
  maxTxReads?: number;
  /** Epoch ms: stop reading then ("pending", capped "deadline"). */
  deadline?: number;
  /** Shared by every look in one reconcile run: transaction reads left for the whole run. */
  budget?: { reads: number };
}

type Ctx<T> = { context?: { slot?: number }; value: T } | null;
const ctxSlot = (r: Ctx<unknown>): number | undefined => (typeof r?.context?.slot === "number" ? r.context.slot : undefined);

/**
 * The fate of a Solana transaction vet402 handed over, decided in this order:
 *   1. The confirmed slot is read first; the reads below ask for an answer at least that recent (minContextSlot),
 *      so a node behind the others cannot answer for a time it has not reached.
 *   2. A transaction whose signature vet402 knows (it paid the fee: a refund) is looked up directly
 *      (getSignatureStatuses over the whole history). Otherwise it is searched by its message hash among
 *      `account`'s signatures, paging back.
 *   3. Blockhash still valid: "landed"/"failed" if found, else "pending".
 *   4. Blockhash expired: the slot of the first answer that said so bounds the window (kept by the caller, so a
 *      later look reads the same window however much traffic came after). Signatures above it are skipped unread;
 *      the search stops below `minSlot` or `since`. Not found in a window read completely, on a look made at least
 *      DEAD_CONFIRM_SLOTS after that first answer: "dead". Before that: "pending" with `expiredSlot`.
 * Anything left unread (a listed transaction the RPC does not serve yet, more history than `maxPages`, more than
 * `maxTxReads` reads, the run's read budget, the deadline, a read error) leaves the answer at "pending" (no refund
 * on a guess); `capped` says why, and the reconciler reports it (ALERT).
 */
export async function solanaTxFate(rpc: Rpc, f: SolanaFateQuery): Promise<Fate> {
  const pageSize = f.pageSize ?? 1000;
  const maxPages = f.maxPages ?? 10;
  const maxReads = f.maxTxReads ?? SOLANA_FATE_MAX_TX_READS;
  let reads = 0;
  let capped: string | null = null;
  let expiredSlot: number | undefined = f.expiredSlot;
  const late = () => f.deadline !== undefined && Date.now() >= f.deadline;
  const pending = (): Fate => ({ fate: "pending", ...(capped ? { capped } : {}), ...(expiredSlot !== undefined ? { expiredSlot } : {}) });
  /** hit null + complete: not in the window; hit null + !complete: the window was not read to its end. */
  const find = async (maxSlot: number | null, minContextSlot: number): Promise<{ hit: Fate | null; complete: boolean }> => {
    let unreadable = false;
    let before: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      if (late()) {
        capped = "deadline";
        return { hit: null, complete: false };
      }
      const sigs = (await rpc("getSignaturesForAddress", [f.account, { limit: pageSize, commitment: "confirmed", minContextSlot, ...(before ? { before } : {}) }])) as {
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
        if (f.budget && f.budget.reads <= 0) {
          capped = "run_budget";
          return { hit: null, complete: false };
        }
        if (late()) {
          capped = "deadline";
          return { hit: null, complete: false };
        }
        reads++;
        if (f.budget) f.budget.reads--;
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
  try {
    const now = Number(await rpc("getSlot", [{ commitment: "confirmed" }]));
    if (!Number.isSafeInteger(now)) return pending();
    let statusSlot: number | undefined;
    if (f.signature) {
      const st = (await rpc("getSignatureStatuses", [[f.signature], { searchTransactionHistory: true }])) as Ctx<({ err: unknown; confirmationStatus?: string | null } | null)[]>;
      const v = st?.value?.[0] ?? null;
      if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) return v.err ? { fate: "failed", tx: f.signature } : { fate: "landed", tx: f.signature };
      if (v) return pending(); // processed only: not settled either way yet
      statusSlot = ctxSlot(st);
    }
    const valid = (await rpc("isBlockhashValid", [f.blockhash, { commitment: "confirmed", minContextSlot: now }])) as Ctx<boolean>;
    if (!valid || valid.value !== false) {
      if (f.signature) return pending();
      const r = await find(null, now);
      return r.hit ?? pending();
    }
    // Expired. The first answer that said so bounds the window for good.
    if (expiredSlot === undefined) {
      expiredSlot = ctxSlot(valid);
      if (expiredSlot === undefined) {
        capped = "no_context_slot";
        return pending();
      }
    }
    const settledLook = now >= expiredSlot + DEAD_CONFIRM_SLOTS;
    if (f.signature) {
      // Not in the whole history, asked of a node past the window by the margin: it never landed.
      return settledLook && statusSlot !== undefined && statusSlot >= expiredSlot + DEAD_CONFIRM_SLOTS ? { fate: "dead" } : pending();
    }
    const r = await find(expiredSlot, now);
    if (r.hit) return r.hit;
    return r.complete && settledLook && f.expiredSlot !== undefined ? { fate: "dead" } : pending();
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
