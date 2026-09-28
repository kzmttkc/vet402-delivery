/**
 * Has anyone outside vet402 ever paid this payTo in USDC on Solana? Read-only RPC.
 *
 * Reads every USDC token account the payTo owns (plus its associated token account, even when
 * closed), their signatures, and parses transactions until one outside receipt is found.
 * A receipt is a transaction in which the payTo's USDC balance went up; it is "own" when every
 * owner whose USDC went down in that transaction is a vet402 address, otherwise "outside".
 * Anything that cannot be read to the end is "unverified", and an unverified payTo is not bought.
 * A payTo that already received USDC from vet402 ("only_own") is not bought either (chainFence).
 *
 * It also reports whether the payTo's USDC associated token account exists. The x402 transfer goes
 * to that account and nothing in the payment creates it, so without it the payment cannot settle
 * (simulated on mainnet 2026-09-28: TransferChecked to a missing account fails with InvalidAccountData).
 */
import { USDC_MINT } from "../constants.js";
import type { Rpc } from "../chain.js";
import { usdcAta } from "../txcheck.js";
import { FB_RECEIPT_SIG_LIMIT, FB_RECEIPT_TX_LIMIT } from "./constants.js";

export type ReceiptVerdict = "none" | "only_own" | "outside" | "unverified";

export interface ReceiptCheck {
  payTo: string;
  verdict: ReceiptVerdict;
  /** The USDC associated token account the payment would go to exists now. */
  ataExists: boolean;
  accounts: string[];
  signatures: number;
  parsed: number;
  ownReceipts: number;
  /** First outside receipt found (the check stops there). */
  outside: { tx: string; fromOwners: string[]; amountAtomic: string } | null;
  detail: string;
}

interface TokenBal {
  owner?: string;
  mint: string;
  uiTokenAmount: { amount: string };
}

interface ParsedTx {
  meta: { err: unknown; preTokenBalances?: TokenBal[]; postTokenBalances?: TokenBal[] } | null;
}

function usdcByOwner(arr: TokenBal[] | undefined): Map<string, bigint> {
  const m = new Map<string, bigint>();
  for (const b of arr ?? []) {
    if (b.mint !== USDC_MINT || !b.owner) continue;
    m.set(b.owner, (m.get(b.owner) ?? 0n) + BigInt(b.uiTokenAmount.amount));
  }
  return m;
}

/** One transaction: did `payTo` receive USDC, and from whom. Pure. */
export function receiptOf(tx: ParsedTx, payTo: string): { amount: bigint; fromOwners: string[] } | null {
  if (!tx.meta || tx.meta.err !== null) return null;
  const pre = usdcByOwner(tx.meta.preTokenBalances);
  const post = usdcByOwner(tx.meta.postTokenBalances);
  const delta = (o: string) => (post.get(o) ?? 0n) - (pre.get(o) ?? 0n);
  const amount = delta(payTo);
  if (amount <= 0n) return null;
  const owners = new Set([...pre.keys(), ...post.keys()]);
  const fromOwners = [...owners].filter((o) => o !== payTo && delta(o) < 0n).sort();
  return { amount, fromOwners };
}

export async function checkOutsideReceipts(
  rpc: Rpc,
  payTo: string,
  own: ReadonlySet<string>,
  opts: { sigLimit?: number; txLimit?: number } = {},
): Promise<ReceiptCheck> {
  const sigLimit = opts.sigLimit ?? FB_RECEIPT_SIG_LIMIT;
  const txLimit = opts.txLimit ?? FB_RECEIPT_TX_LIMIT;
  const out: ReceiptCheck = { payTo, verdict: "unverified", ataExists: false, accounts: [], signatures: 0, parsed: 0, ownReceipts: 0, outside: null, detail: "" };
  try {
    const ata = await usdcAta(payTo);
    const toks = (await rpc("getTokenAccountsByOwner", [payTo, { mint: USDC_MINT }, { encoding: "jsonParsed", commitment: "confirmed" }])) as { value: { pubkey: string }[] };
    out.ataExists = toks.value.some((t) => t.pubkey === ata);
    out.accounts = [...new Set([ata, ...toks.value.map((t) => t.pubkey)])];
    const sigs: string[] = [];
    let overflow = false;
    for (const acct of out.accounts) {
      const s = (await rpc("getSignaturesForAddress", [acct, { limit: sigLimit, commitment: "confirmed" }])) as { signature: string; err: unknown }[];
      if (s.length >= sigLimit) overflow = true;
      for (const x of s) if (x.err === null && !sigs.includes(x.signature)) sigs.push(x.signature);
    }
    out.signatures = sigs.length;
    for (const sig of sigs) {
      if (out.parsed >= txLimit) break;
      const tx = (await rpc("getTransaction", [sig, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }])) as ParsedTx | null;
      out.parsed++;
      if (!tx) {
        out.detail = `transaction ${sig} not returned`;
        return out; // unverified
      }
      const r = receiptOf(tx, payTo);
      if (!r) continue;
      if (r.fromOwners.length > 0 && r.fromOwners.every((o) => own.has(o))) {
        out.ownReceipts++;
        continue;
      }
      out.outside = { tx: sig, fromOwners: r.fromOwners, amountAtomic: r.amount.toString() };
      out.verdict = "outside";
      out.detail = `USDC ${r.amount} received in ${sig}`;
      return out;
    }
    if (overflow || out.parsed < sigs.length) {
      out.detail = `${sigs.length}${overflow ? "+" : ""} signatures, ${out.parsed} parsed, no outside receipt among them`;
      return out; // unverified
    }
    out.verdict = out.ownReceipts > 0 ? "only_own" : "none";
    out.detail = `${sigs.length} signatures, ${out.ownReceipts} receipts from vet402`;
    return out;
  } catch (e) {
    out.detail = `rpc: ${(e as Error).message}`.slice(0, 200);
    return out; // unverified
  }
}

/**
 * The chain-side fence, checked right before an attempt is recorded and signed, whatever the local
 * ledger says (a missing or reset ledger cannot cause a second payment): the payTo may be paid only
 * when its USDC accounts were read to the end and never received USDC from anyone, vet402 included,
 * and its USDC associated token account exists. Anything unreadable refuses. null = allowed.
 */
export function chainFence(c: ReceiptCheck): { reason: string; detail: string } | null {
  if (c.verdict === "outside") return { reason: "outside_receipts", detail: c.detail };
  if (c.verdict === "only_own") return { reason: "paid_by_vet402_before", detail: `vet402 already paid this payTo on chain (${c.ownReceipts} receipts)` };
  if (c.verdict !== "none") return { reason: "chain_unreadable", detail: c.detail || "the payTo's USDC history could not be read to the end" };
  if (!c.ataExists) return { reason: "payto_no_usdc_account", detail: "the payTo has no USDC associated token account; a transfer to it cannot settle until the seller creates it" };
  return null;
}
