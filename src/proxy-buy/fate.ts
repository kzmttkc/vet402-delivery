/**
 * Whether a transaction vet402 handed over (the agent's payment, vet402's payment to a seller, a refund)
 * landed, failed, can never land, or cannot be told yet. A refund is only ever made on "dead" or "failed"
 * (proof that the money did not move), never on "cannot tell".
 *
 * Solana: the transaction is found by its signature when vet402 paid its fee, else by the sha256 of its message
 * bytes among the signatures of an account it touches, inside the slots it could have landed in; it is dead once
 * the finalized block height is past its lastValidBlockHeight and a later look still does not find it there.
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
 * `expiredSlot`, `cursor` (Solana): where the window ends and how far the walk above it got; the caller keeps them.
 */
export type Fate =
  | { fate: "landed"; tx: string }
  | { fate: "failed"; tx: string }
  | { fate: "dead" }
  | { fate: "pending"; capped?: string; expiredSlot?: number; cursor?: string };

// ---------------- Solana ----------------

export interface SolanaTxFacts {
  /** sha256 hex of the message bytes: the same for every signature set of this transaction. */
  messageHash: string;
  blockhash: string;
  feePayer: string;
  /** The TransferChecked authority (the account whose tokens moved) and amount, when there is exactly one. */
  authority: string | null;
  amount: string | null;
  /** It advances a durable nonce (System AdvanceNonceAccount): it has no blockhash expiry at all. */
  durableNonce: boolean;
}

const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/**
 * sha256 hex of a wire transaction's message bytes, read without decoding the message, so a transaction of a
 * version the decoder does not know is still told apart from vet402's own:
 *   legacy and v0: signatures first (a short-vector count, then 64 bytes each), the message after them;
 *   v1 and later (first byte 0x80 or above): the message first (its second byte is the number of required
 *   signatures), the signatures after it, 64 bytes each.
 */
export function rawMessageHash(txBase64: string): string | null {
  try {
    const b = Buffer.from(txBase64, "base64");
    if (b.length > 0 && b[0]! >= 0x80) {
      const sigs = b[1];
      if (sigs === undefined || sigs === 0) return null;
      const end = b.length - 64 * sigs;
      if (end <= 2) return null;
      return createHash("sha256").update(b.subarray(0, end)).digest("hex");
    }
    let n = 0;
    let shift = 0;
    let i = 0;
    for (;;) {
      const byte = b[i++];
      if (byte === undefined || i > 3) return null;
      n |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
    }
    const start = i + 64 * n;
    if (start >= b.length) return null;
    return createHash("sha256").update(b.subarray(start)).digest("hex");
  } catch {
    return null;
  }
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
    let durableNonce = false;
    for (const ix of msg.instructions) {
      const d0 = ix.data ?? new Uint8Array();
      if (keys[ix.programAddressIndex] === SYSTEM_PROGRAM && d0.length >= 4 && d0[0] === 4 && d0[1] === 0 && d0[2] === 0 && d0[3] === 0) durableNonce = true;
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
      durableNonce,
    };
  } catch {
    return null;
  }
}

/** Most getTransaction reads one Solana fate call makes; past it the answer is "pending" with `capped`. */
export const SOLANA_FATE_MAX_TX_READS = 200;

/**
 * Blocks past the recorded last valid block height before a transaction counts as expired. The recorded height can
 * be a few blocks below the real one (a bound read on another RPC node, and inclusion one block past the height
 * getLatestBlockhash names), so the margin is wide: about two minutes of blocks. Waiting costs little.
 */
export const EXPIRY_MARGIN_BLOCKS = 300;

/**
 * How far back the agent's payment is searched from the moment vet402 took it: a transaction with a blockhash vet402's
 * node knew as valid then cannot have landed much more than 151 blocks (about a minute) earlier. Ten minutes.
 */
export const AGENT_LOOKBACK_SECONDS = 600;
/** The same reach in slots, for the history check (about 20 minutes of slots). */
export const AGENT_LOOKBACK_SLOTS = 3_000;

/** The newest transaction version getTransaction is asked to return (a lower one makes the RPC refuse newer ones). */
export const MAX_TX_VERSION = 1;

export interface SolanaFateQuery {
  messageHash: string;
  blockhash: string;
  account: string;
  /** Unix seconds before which the transaction cannot have landed. */
  since?: number;
  /** The confirmed slot read before the transaction was handed over: it cannot have landed below it. */
  minSlot?: number;
  /**
   * The last valid block height recorded for the transaction (its blockhash's, or a value read next to it that can
   * be a few blocks off). Without it the transaction is never called "dead".
   */
  lastValidBlockHeight?: number;
  /**
   * The finalized slot of the first answer whose finalized block height was past `lastValidBlockHeight` +
   * EXPIRY_MARGIN_BLOCKS (returned in a "pending" answer; the caller keeps it). Every block the transaction could
   * be in is below it.
   */
  expiredSlot?: number;
  /** A signature above that slot, as far as an earlier look paged: the next look starts below it. */
  cursor?: string;
  /**
   * The newest signature on `account` read before the transaction was handed over (null: the account had none).
   * The walk must reach it before "dead": a listing that skips part of the history then never proves anything.
   */
  anchor?: string | null;
  /**
   * Unix seconds: walk on past the anchor down to transactions older than this, and read the anchor too. For the
   * agent's payment, which the agent may have settled itself before vet402 read the anchor and `minSlot`: the
   * search then reaches back to before the payment's blockhash could exist (AGENT_LOOKBACK_SECONDS).
   */
  pastAnchorUntil?: number;
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

export type Ctx<T> = { context?: { slot?: number }; value: T } | null;
export const ctxSlot = (r: Ctx<unknown>): number | undefined => (typeof r?.context?.slot === "number" ? r.context.slot : undefined);

/**
 * The fate of a Solana transaction vet402 handed over, decided in this order:
 *   1. A transaction whose signature vet402 knows (it paid the fee: a refund) is looked up directly
 *      (getSignatureStatuses over the whole history); found decides, not found goes on to the search.
 *   2. Expired or not is read from the finalized chain (getEpochInfo, finalized: block height and slot of one
 *      bank): expired once the finalized block height is past `lastValidBlockHeight` + EXPIRY_MARGIN_BLOCKS.
 *      isBlockhashValid is not used: it also says false for a blockhash the node does not know yet.
 *   3. Not expired: searched by its message hash among `account`'s signatures (confirmed, at least as recent as the
 *      slot read first); "landed"/"failed" if found, else "pending".
 *   4. Expired: every block it could be in is finalized and at or below the finalized slot of the first answer that
 *      said so (kept by the caller as `expiredSlot`). The finalized signatures up to that slot are searched; those
 *      above it are skipped unread, and how far that went is kept (`cursor`), so the next look starts there.
 *      Not found in the whole window, on a look after the one that recorded `expiredSlot`, from a node whose
 *      history (getFirstAvailableBlock) reaches `minSlot`: "dead". Any transaction version is read
 *      (MAX_TX_VERSION) and compared by the hash of its raw message bytes; one that cannot be read is never taken
 *      for another's: the answer stays "pending" with the reason in `capped`.
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
  let cursor: string | undefined = f.cursor;
  const late = () => f.deadline !== undefined && Date.now() >= f.deadline;
  const pending = (): Fate => ({
    fate: "pending",
    ...(capped ? { capped } : {}),
    ...(expiredSlot !== undefined ? { expiredSlot } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
  });
  /**
   * hit null + complete: not in the window; hit null + !complete: the window was not read to its end.
   * With `maxSlot`, signatures above it are skipped, and the page walk starts below `cursor` and moves it on.
   */
  const find = async (maxSlot: number | null, opts: { commitment: string; minContextSlot: number }): Promise<{ hit: Fate | null; complete: boolean }> => {
    /**
     * The walk reached the window's end: complete unless a transaction in it could not be read. After expiry that
     * is what keeps it from "dead", so the reason goes out (capped, reported); before, it is "pending" anyway.
     */
    const done = (u: string | null, atAnchor: boolean): { hit: null; complete: boolean } => {
      if (u) {
        if (maxSlot !== null) capped = `unreadable_tx:${u}`;
        return { hit: null, complete: false };
      }
      // Stopped without meeting the anchor recorded before the hand-over: part of the history was not listed.
      if (!atAnchor && typeof f.anchor === "string") {
        if (maxSlot !== null) capped = "anchor_not_reached";
        return { hit: null, complete: false };
      }
      return { hit: null, complete: true };
    };
    let unreadable: string | null = null;
    let seenAnchor = false;
    const past = f.pastAnchorUntil;
    let before: string | undefined = maxSlot !== null ? cursor : undefined;
    let above = maxSlot !== null; // still walking the signatures above the window
    for (let page = 0; page < maxPages; page++) {
      if (late()) {
        capped = "deadline";
        return { hit: null, complete: false };
      }
      const sigs = (await rpc("getSignaturesForAddress", [f.account, { limit: pageSize, ...opts, ...(before ? { before } : {}) }])) as {
        signature: string;
        slot?: number | null;
        blockTime?: number | null;
      }[];
      for (const s of sigs) {
        const slot = typeof s.slot === "number" ? s.slot : null;
        if (maxSlot !== null && slot !== null && slot > maxSlot) {
          if (above) cursor = s.signature; // after the window: never it; the next look starts below
          continue;
        }
        above = false;
        if (past !== undefined) {
          // Past the anchor, down to the lookback time: the anchor itself may be the transaction.
          if (typeof s.blockTime === "number" && s.blockTime < past) return done(unreadable, seenAnchor || f.anchor === null);
          if (typeof f.anchor === "string" && s.signature === f.anchor) seenAnchor = true;
        } else {
          // Older than the hand-over: the walk is over. With an anchor, reaching it shows the listing reached back
          // to before the hand-over (it cannot show that nothing in between was left out).
          if (typeof f.anchor === "string" && s.signature === f.anchor) return done(unreadable, true);
          if (f.minSlot !== undefined && slot !== null && slot < f.minSlot) return done(unreadable, false);
          if (f.minSlot === undefined && f.since !== undefined && typeof s.blockTime === "number" && s.blockTime < f.since) return done(unreadable, false);
        }
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
        let t: { meta: { err: unknown } | null; transaction: [string, string] } | null;
        try {
          t = (await rpc("getTransaction", [s.signature, { encoding: "base64", commitment: opts.commitment, maxSupportedTransactionVersion: MAX_TX_VERSION }])) as typeof t;
        } catch (e) {
          // It may be the one: never taken for "not vet402's". The reason goes to the ALERT.
          unreadable = /version/i.test(String((e as Error)?.message ?? "")) ? "unsupported_version" : "read_error";
          continue;
        }
        if (!t) {
          unreadable = unreadable ?? "not_served"; // listed but not served: it may be the one
          continue;
        }
        const h = rawMessageHash(t.transaction?.[0] ?? "");
        if (h === null) {
          unreadable = "undecodable";
          continue;
        }
        if (h === f.messageHash) return { hit: t.meta?.err ? { fate: "failed", tx: s.signature } : { fate: "landed", tx: s.signature }, complete: true };
      }
      if (sigs.length < pageSize) return done(unreadable, seenAnchor);
      before = sigs[sigs.length - 1]!.signature;
    }
    capped = capped ?? "pages";
    return { hit: null, complete: false };
  };
  try {
    const now = Number(await rpc("getSlot", [{ commitment: "confirmed" }]));
    if (!Number.isSafeInteger(now)) return pending();
    if (f.signature) {
      // Found: decided. Not found proves nothing (a node answers null when its long-term storage fails): the
      // search below decides then, as for any other transaction.
      const st = (await rpc("getSignatureStatuses", [[f.signature], { searchTransactionHistory: true }])) as Ctx<({ err: unknown; confirmationStatus?: string | null } | null)[]>;
      const v = st?.value?.[0] ?? null;
      if (v && (v.confirmationStatus === "confirmed" || v.confirmationStatus === "finalized")) return v.err ? { fate: "failed", tx: f.signature } : { fate: "landed", tx: f.signature };
      if (v) return pending(); // processed only: not settled either way yet
    }
    const fin = (await rpc("getEpochInfo", [{ commitment: "finalized" }])) as { absoluteSlot?: number; blockHeight?: number } | null;
    const expired =
      f.lastValidBlockHeight !== undefined &&
      typeof fin?.blockHeight === "number" &&
      typeof fin.absoluteSlot === "number" &&
      fin.blockHeight > f.lastValidBlockHeight + EXPIRY_MARGIN_BLOCKS;
    if (!expired) {
      if (f.lastValidBlockHeight === undefined) capped = "no_last_valid_height";
      const r = await find(null, { commitment: "confirmed", minContextSlot: now });
      return r.hit ?? pending();
    }
    const recorded = expiredSlot !== undefined;
    if (expiredSlot === undefined) expiredSlot = fin!.absoluteSlot!;
    /** "Dead" also needs the node's history to reach the window's start: a pruned ledger answers "not found". */
    const historyCovers = async (): Promise<boolean> => {
      if (f.minSlot === undefined) {
        capped = "no_min_slot";
        return false;
      }
      if (f.anchor === undefined) {
        capped = "no_anchor";
        return false;
      }
      const first = Number(await rpc("getFirstAvailableBlock", []));
      const lowest = f.pastAnchorUntil !== undefined ? Math.max(0, f.minSlot - AGENT_LOOKBACK_SLOTS) : f.minSlot;
      if (!Number.isSafeInteger(first) || first > lowest) {
        capped = "history_pruned";
        return false;
      }
      return true;
    };
    const r = await find(expiredSlot, { commitment: "finalized", minContextSlot: expiredSlot });
    if (r.hit) return r.hit;
    if (!(r.complete && recorded)) return pending();
    return (await historyCovers()) ? { fate: "dead" } : pending();
  } catch (e) {
    // An RPC that fails (rate limit, outage, a wrong URL) is said, not only waited on: a fixed reason, no message.
    capped = capped ?? (/429|too many requests/i.test(String((e as Error)?.message ?? "")) ? "rpc_rate_limited" : "rpc_error");
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
