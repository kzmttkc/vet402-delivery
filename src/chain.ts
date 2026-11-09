/**
 * Solana JSON-RPC reads: balances, and confirming that a payment settled on chain
 * with the expected USDC movement. Read-only.
 */
import { MEMO_PROGRAM, USDC_MINT } from "./constants.js";

export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

/**
 * Four tries, 1.5 s more wait before each next one. Retried: 429, a 502/503/504, and a request that never got an
 * answer (a timeout or a dropped connection: 2026-11-09, one anchor read timed out and the records run halted).
 * Not retried: an answer with a JSON-RPC error, which says what the node decided. A send that is tried again
 * carries the same signed bytes, so the chain takes it at most once.
 */
export function jsonRpc(url: string, fetchImpl: typeof fetch = fetch, waitMs = 1500): Rpc {
  let id = 0;
  return async (method, params) => {
    let last = `rpc ${method}: rate limited`;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, waitMs * attempt));
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (e) {
        last = `rpc ${method}: ${e instanceof Error ? e.message : String(e)}`;
        continue;
      }
      if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
        last = res.status === 429 ? `rpc ${method}: rate limited` : `rpc ${method}: HTTP ${res.status}`;
        continue;
      }
      const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (body.error) throw new Error(`rpc ${method}: ${body.error.message ?? "error"}`);
      return body.result;
    }
    throw new Error(last);
  };
}

export interface Balances {
  lamports: bigint;
  usdcAtomic: bigint;
}

export async function readBalances(rpc: Rpc, owner: string): Promise<Balances> {
  const bal = (await rpc("getBalance", [owner, { commitment: "confirmed" }])) as { value: number };
  const toks = (await rpc("getTokenAccountsByOwner", [owner, { mint: USDC_MINT }, { encoding: "jsonParsed", commitment: "confirmed" }])) as {
    value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[];
  };
  let usdc = 0n;
  for (const t of toks.value) usdc += BigInt(t.account.data.parsed.info.tokenAmount.amount);
  return { lamports: BigInt(bal.value), usdcAtomic: usdc };
}

export interface OnChain {
  signature: string;
  found: boolean;
  confirmed: boolean;
  err: unknown;
  memo: string | null;
  payToDeltaAtomic: string | null;
  payerDeltaAtomic: string | null;
  payerLamportsDelta: string | null;
  feePayer: string | null;
}

interface ParsedTx {
  meta: {
    err: unknown;
    preBalances: number[];
    postBalances: number[];
    preTokenBalances?: { owner?: string; mint: string; uiTokenAmount: { amount: string } }[];
    postTokenBalances?: { owner?: string; mint: string; uiTokenAmount: { amount: string } }[];
  } | null;
  transaction: {
    message: {
      accountKeys: { pubkey: string; signer: boolean; writable: boolean }[];
      instructions: { programId: string; parsed?: unknown }[];
    };
  };
}

function tokenDelta(tx: ParsedTx, owner: string): bigint {
  const sum = (arr?: { owner?: string; mint: string; uiTokenAmount: { amount: string } }[]) =>
    (arr ?? []).filter((b) => b.owner === owner && b.mint === USDC_MINT).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(tx.meta?.postTokenBalances) - sum(tx.meta?.preTokenBalances);
}

export async function readTransaction(rpc: Rpc, signature: string, payer: string, payTo: string): Promise<OnChain> {
  const tx = (await rpc("getTransaction", [signature, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }])) as ParsedTx | null;
  if (!tx) {
    return { signature, found: false, confirmed: false, err: null, memo: null, payToDeltaAtomic: null, payerDeltaAtomic: null, payerLamportsDelta: null, feePayer: null };
  }
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
  const pi = keys.indexOf(payer);
  const memoIx = tx.transaction.message.instructions.find((i) => i.programId === MEMO_PROGRAM);
  return {
    signature,
    found: true,
    confirmed: true,
    err: tx.meta?.err ?? null,
    memo: typeof memoIx?.parsed === "string" ? memoIx.parsed : null,
    payToDeltaAtomic: tokenDelta(tx, payTo).toString(),
    payerDeltaAtomic: tokenDelta(tx, payer).toString(),
    payerLamportsDelta: pi >= 0 && tx.meta ? String(tx.meta.postBalances[pi]! - tx.meta.preBalances[pi]!) : null,
    feePayer: keys[0] ?? null,
  };
}

/** Find our payment by its memo among the payer USDC account's recent signatures. */
export async function findByMemo(rpc: Rpc, payerUsdcAta: string, memo: string, payer: string, payTo: string): Promise<OnChain | null> {
  const sigs = (await rpc("getSignaturesForAddress", [payerUsdcAta, { limit: 15, commitment: "confirmed" }])) as { signature: string; memo: string | null }[];
  for (const s of sigs) {
    // getSignaturesForAddress returns memos as "[len] text"
    if (s.memo && s.memo.includes(memo)) return readTransaction(rpc, s.signature, payer, payTo);
  }
  return null;
}

/** Poll until the payment is visible on chain (by signature if known, otherwise by memo). */
export async function waitForSettlement(args: {
  rpc: Rpc;
  signature: string | null;
  memo: string | null;
  payer: string;
  payerUsdcAta: string;
  payTo: string;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<OnChain | null> {
  const deadline = Date.now() + (args.timeoutMs ?? 90_000);
  while (Date.now() < deadline) {
    try {
      if (args.signature) {
        const r = await readTransaction(args.rpc, args.signature, args.payer, args.payTo);
        if (r.found) return r;
      } else if (args.memo) {
        const r = await findByMemo(args.rpc, args.payerUsdcAta, args.memo, args.payer, args.payTo);
        if (r) return r;
      } else return null;
    } catch {
      /* transient RPC error: keep polling */
    }
    await new Promise((r) => setTimeout(r, args.intervalMs ?? 3000));
  }
  return null;
}
