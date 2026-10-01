/**
 * EVM purchases on any chain in chains.ts (x402 v2 `exact`, EIP-3009 TransferWithAuthorization only).
 * Extracted from base-buy.ts with the chain as an argument; base-buy.ts now calls this with Base.
 *
 * Money guards, all before any signature:
 *   per-purchase cap (lane), total and count caps (the lane's own persistent ledger, fail-closed), one
 *   purchase per ledger key (by default the payTo), payTo locked at plan time, price may drop but never
 *   rise, only the chain's one token, assetTransferMethod must be EIP-3009 (Permit2 / approve paths are
 *   refused: they can move funds on-chain from the wallet itself), maxTimeoutSeconds <= 3600.
 * Optional binding checks: payTo == ERC-8004 agentWallet (Base lane), payTo == the payTo of the same
 * 402's accept on another chain (Arbitrum lane: the same seller, only the chain differs).
 * The signer handed to the x402 client can only sign that one TransferWithAuthorization (fencedChainSigner).
 * It has no transaction-sending capability at all.
 */
import { createHash } from "node:crypto";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { getAddress, isAddress, isAddressEqual, verifyTypedData, type Address, type Hex } from "viem";
import { MAX_PER_PURCHASE_ATOMIC, atomicToUsdc } from "../constants.js";
import { normalizeAccept, type Budget, type SolAccept } from "../guard.js";
import type { EvmChainSpec } from "./chains.js";

export const MAX_TIMEOUT_SECONDS = 3600;

export type EvmAccept = SolAccept;

export interface EvmRefusal {
  refused:
    | `no_${string}_accept`
    | "scheme_mismatch"
    | "network_mismatch"
    | "asset_mismatch"
    | "bad_amount"
    | "price_over_cap"
    | "price_raised"
    | "payto_mismatch"
    | "payto_not_agent_wallet"
    | "payto_differs_across_chains"
    | "payto_invalid"
    | "self_dealing"
    | "not_eip3009"
    | "domain_mismatch"
    | "timeout_invalid"
    | "total_cap_reached"
    | "purchase_count_reached"
    | "already_bought"
    | "payload_check_failed"
    | "ledger_unreadable"
    | "insufficient_balance";
  detail: string;
}

export function eqAddr(a: string, b: string): boolean {
  return isAddress(a) && isAddress(b) && isAddressEqual(a, b);
}

/** Among a live 402's accepts, the chain's exact accept in its token to the locked payTo (else the first one on the chain, so the check says why). */
export function pickChainAccept(spec: EvmChainSpec, accepts: EvmAccept[], lockedPayTo: string): EvmAccept | null {
  const on = accepts.filter((a) => a.network === spec.caip2);
  if (on.length === 0) return null;
  const good = on.filter((a) => a.scheme === "exact" && eqAddr(a.asset, spec.asset) && eqAddr(a.payTo, lockedPayTo));
  return good[0] ?? on[0]!;
}

export interface ChainAcceptContext {
  payer: string;
  /** payTo recorded at plan time from the unpaid 402. */
  lockedPayTo: string;
  lockedAmount?: string;
  /** When set: getAgentWallet(agentId) read on chain; payTo must equal it. */
  agentWallet?: string;
  /** When set: the payTo of this 402's accept on another chain; payTo must equal it. */
  crossChainPayTo?: { network: string; payTo: string | null };
  /** Per-purchase cap of the lane (atomic). */
  maxPerAtomic?: bigint;
}

/** Every per-accept check. null = may go on to the budget. Pure. */
export function checkChainAccept(spec: EvmChainSpec, a: EvmAccept | null, ctx: ChainAcceptContext): EvmRefusal | null {
  const maxPer = ctx.maxPerAtomic ?? MAX_PER_PURCHASE_ATOMIC;
  if (!a) return { refused: `no_${spec.key}_accept`, detail: `the 402 has no ${spec.label} mainnet accept` };
  if (a.scheme !== "exact") return { refused: "scheme_mismatch", detail: `scheme ${a.scheme} (only exact)` };
  if (a.network !== spec.caip2) return { refused: "network_mismatch", detail: `network ${a.network}` };
  if (!eqAddr(a.asset, spec.asset)) return { refused: "asset_mismatch", detail: `asset ${a.asset} is not ${spec.label} ${spec.assetSymbol}` };
  if (!/^\d{1,18}$/.test(a.amount) || BigInt(a.amount) <= 0n) return { refused: "bad_amount", detail: `amount ${JSON.stringify(a.amount)}` };
  const amount = BigInt(a.amount);
  if (amount > maxPer) return { refused: "price_over_cap", detail: `amount ${amount} > per-purchase cap ${maxPer}` };
  if (ctx.lockedAmount !== undefined && amount > BigInt(ctx.lockedAmount)) return { refused: "price_raised", detail: `amount ${amount} > recorded ${ctx.lockedAmount}` };
  if (!isAddress(a.payTo)) return { refused: "payto_invalid", detail: `payTo ${a.payTo}` };
  if (!eqAddr(a.payTo, ctx.lockedPayTo)) return { refused: "payto_mismatch", detail: `payTo ${a.payTo} != recorded ${ctx.lockedPayTo}` };
  if (ctx.agentWallet !== undefined && !eqAddr(a.payTo, ctx.agentWallet)) return { refused: "payto_not_agent_wallet", detail: `payTo ${a.payTo} != agentWallet ${ctx.agentWallet}` };
  if (ctx.crossChainPayTo !== undefined && (ctx.crossChainPayTo.payTo === null || !eqAddr(a.payTo, ctx.crossChainPayTo.payTo))) {
    return { refused: "payto_differs_across_chains", detail: `payTo ${a.payTo} != ${ctx.crossChainPayTo.network} payTo ${ctx.crossChainPayTo.payTo ?? "(none)"}` };
  }
  if (eqAddr(a.payTo, ctx.payer)) return { refused: "self_dealing", detail: "payTo is the payer" };
  const method = a.extra?.assetTransferMethod;
  if (method !== undefined && method !== "eip3009") return { refused: "not_eip3009", detail: `assetTransferMethod ${String(method)}` };
  if (a.extra?.name !== spec.domain.name || a.extra?.version !== spec.domain.version) {
    return { refused: "domain_mismatch", detail: `EIP-712 domain ${String(a.extra?.name)} / ${String(a.extra?.version)}` };
  }
  const t = a.maxTimeoutSeconds;
  if (typeof t !== "number" || t <= 0 || t > MAX_TIMEOUT_SECONDS) return { refused: "timeout_invalid", detail: `maxTimeoutSeconds ${String(t)}` };
  return null;
}

// ---------- the only thing the key may sign ----------

export interface TypedDataSigner {
  address: Address;
  signTypedData(m: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }): Promise<Hex>;
}

export interface SignLock {
  payTo: string;
  amount: string;
  nowSec?: () => number;
  /** Per-purchase cap (atomic). Defaults to 0.10. */
  maxPerAtomic?: bigint;
}

/**
 * Wrap a signer so it signs exactly one EIP-3009 TransferWithAuthorization: the chain's token domain, from the
 * signer, to the locked payTo, for the locked amount (<= the cap), valid for at most MAX_TIMEOUT_SECONDS.
 * Anything else throws. No readContract / sendTransaction is exposed, so the x402 library cannot take the
 * approve or Permit2 paths.
 */
export function fencedChainSigner(spec: EvmChainSpec, inner: TypedDataSigner, lock: SignLock): TypedDataSigner & { signed: number } {
  const now = lock.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const maxPer = lock.maxPerAtomic ?? MAX_PER_PURCHASE_ATOMIC;
  const out = {
    address: inner.address,
    signed: 0,
    async signTypedData(m: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> }): Promise<Hex> {
      const d = m.domain;
      const msg = m.message;
      const fail = (why: string): never => {
        throw new Error(`fenced signer refused: ${why}`);
      };
      if (out.signed > 0) fail("already signed once");
      if (m.primaryType !== "TransferWithAuthorization") fail(`primaryType ${m.primaryType}`);
      if (d.name !== spec.domain.name || d.version !== spec.domain.version) fail("domain name/version");
      if (Number(d.chainId) !== spec.chainId) fail(`chainId ${String(d.chainId)}`);
      if (!eqAddr(String(d.verifyingContract), spec.asset)) fail(`verifyingContract ${String(d.verifyingContract)}`);
      if (!eqAddr(String(msg.from), inner.address)) fail("from is not the signer");
      if (!eqAddr(String(msg.to), lock.payTo)) fail(`to ${String(msg.to)} != locked payTo`);
      const value = BigInt(String(msg.value));
      if (value !== BigInt(lock.amount) || value > maxPer || value <= 0n) fail(`value ${value}`);
      const vb = BigInt(String(msg.validBefore));
      if (vb > BigInt(now() + MAX_TIMEOUT_SECONDS + 5)) fail("validBefore too far");
      out.signed++;
      return inner.signTypedData(m);
    },
  };
  return out;
}

// ---------- payment payload ----------

export interface CreatedEvmPayment {
  headers: Record<string, string>;
  authorization: { from: Address; to: Address; value: string; validAfter: string; validBefore: string; nonce: Hex };
  signature: Hex;
}

function sameAccept(raw: Record<string, unknown>, a: EvmAccept): boolean {
  const n = normalizeAccept(raw);
  return n.scheme === a.scheme && n.network === a.network && eqAddr(n.asset, a.asset) && eqAddr(n.payTo, a.payTo) && n.amount === a.amount;
}

export const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** "$0.10" for 100000 atomic: the library's USD cap, used only where it knows the asset. */
function usdCap(atomic: bigint): string {
  return `$${atomicToUsdc(atomic).replace(/0+$/, "").replace(/\.$/, "")}`;
}

/** Build the x402 payment for exactly `accept`, then read it back and verify the signature against the payer. */
export async function createChainPayment(spec: EvmChainSpec, signer: TypedDataSigner, pr: PaymentRequired, accept: EvmAccept, maxPerAtomic: bigint = MAX_PER_PURCHASE_ATOMIC): Promise<CreatedEvmPayment> {
  const fenced = fencedChainSigner(spec, signer, { payTo: accept.payTo, amount: accept.amount, maxPerAtomic });
  const client = new x402Client((_v, reqs) => {
    const hit = (reqs as unknown as Record<string, unknown>[]).find((r) => sameAccept(r, accept));
    if (!hit) throw new Error("locked accept not offered to the selector");
    return hit as never;
  });
  // The library's own cap: a USD cap where it knows the token, else an atomic cap on exactly this token.
  client.setSpendControls(
    spec.libraryDefaultAsset
      ? { maxAmountPerPayment: usdCap(maxPerAtomic) }
      : { allowedAssets: [{ network: spec.caip2, asset: spec.asset, maxAmountPerPayment: maxPerAtomic.toString() }] } as never,
  );
  client.register(spec.caip2 as never, new ExactEvmScheme(fenced));
  const http = new x402HTTPClient(client);
  const payload = await http.createPaymentPayload(pr);
  const accepted = (payload as { accepted?: Record<string, unknown> }).accepted;
  if (accepted && !sameAccept(accepted, accept)) throw new Error("payload.accepted differs from the locked accept");
  const inner = payload.payload as { authorization?: CreatedEvmPayment["authorization"]; signature?: Hex };
  const auth = inner.authorization;
  const sig = inner.signature;
  if (!auth || !sig) throw new Error("payload is not an EIP-3009 authorization");
  if (!eqAddr(auth.from, signer.address) || !eqAddr(auth.to, accept.payTo) || auth.value !== accept.amount) throw new Error("authorization fields differ from the lock");
  const ok = await verifyTypedData({
    address: signer.address,
    domain: { name: spec.domain.name, version: spec.domain.version, chainId: spec.chainId, verifyingContract: spec.asset },
    types: AUTH_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: getAddress(auth.from),
      to: getAddress(auth.to),
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
    signature: sig,
  });
  if (!ok) throw new Error("signature does not verify for the payer");
  return { headers: http.encodePaymentSignatureHeader(payload), authorization: auth, signature: sig };
}

// ---------- one purchase ----------

export interface ChainBuyEntry {
  /** Who this purchase is for: an ERC-8004 agent id on Base, else a label such as the payTo. */
  agentId: string;
  resource: string;
  method: "GET" | "POST";
  /** Declared example input from the seller's own listing. */
  query: Record<string, string> | null;
  body: unknown;
  /** When set, re-read on chain right before paying and required to equal the payTo. */
  agentWallet?: Address;
  /** When set, the same 402 must carry an exact accept on this network with the same payTo. */
  sameSellerOn?: string;
  /** Ledger identity. Default: `<chain>-payto:<payTo lowercase>` (one purchase per seller). */
  ledgerKey?: string;
  /** From the unpaid 402 at plan time. */
  lock: { payTo: string; amount: string };
  /** The catalog's URL of the listing, when vet402 filled the request (src/evm/lane-input.ts). Default: resource. */
  listingResource?: string;
  /** Parameter names the listing declares (they make a seller's "missing" an input error; src/evm/lane-input.ts). */
  declaredParams?: string[];
  /** The UTC date vet402 used when it filled the request. */
  inputDate?: string;
  /** Parameters vet402 filled with that date (rule table:date); only these are written as <today> in requestKey. */
  datedParams?: string[];
}

export interface ChainBuyDeps {
  fetch: typeof fetch;
  payer: Address;
  signer: TypedDataSigner;
  budget: Budget;
  /** The payer's balance of the chain's token. */
  readAssetBalance: () => Promise<bigint>;
  readAgentWallet?: (agentId: string) => Promise<Address>;
  /** Base lane: an entry without agentWallet is refused (fail-closed), never bought unbound. */
  requireAgentWallet?: boolean;
  /** tx -> token Transfer check (payer -> payTo, amount). */
  verifySettlement: (tx: Hex, payTo: string, amount: string) => Promise<{ ok: boolean; from?: string; reason?: string; blockNumber?: string }>;
  dryRun: boolean;
  maxPerAtomic?: bigint;
}

export interface SettleResponse {
  success?: boolean;
  transaction?: string;
  network?: string;
  errorReason?: string;
  payer?: string;
}

export interface ChainBuyRecord {
  agentId: string;
  resource: string;
  method: string;
  at: string;
  outcome: "refused" | "not_sent" | "would_pay" | "sent";
  refusal?: EvmRefusal;
  priceUsdc?: string;
  amountAtomic?: string;
  payTo?: string;
  payToIsAgentWallet?: boolean;
  payer?: string;
  settlementTx?: string | null;
  settledOnChain?: boolean;
  settlementCheck?: string;
  response?: { status: number | null; contentType: string | null; bytes: number; first300: string | null; error?: string };
  delivered?: boolean;
  /** Present only on non-Base lanes: what the seller's PAYMENT-RESPONSE header said, decoded. */
  settleResponse?: SettleResponse | null;
  /** Present only when asked for (opts.keepBodyBytes): the answer body, cut at that many characters. */
  body?: string;
  /** Present only on non-Base lanes: milliseconds from sending the paid request to its response. */
  paidRequestMs?: number;
  /** Dry run only: the wallet's balance is below the price, so a paying run would refuse this purchase. */
  balanceShort?: boolean;
  /**
   * The EIP-3009 authorization vet402 signed, without the signature: its nonce is what the token's
   * AuthorizationUsed(payer, nonce) event carries when it settles, so the chain check finds this purchase's
   * transfer exactly. Public once settled; the signature is never recorded.
   */
  authorization?: { nonce: string; validAfter: string; validBefore: string };
  /**
   * What the paid response carried as a settlement header, read raw (no secret in it): which header was there,
   * whether the x402 library decoded it, and whether it named a transaction. settlementTx and settledOnChain are
   * decided by the chain (src/evm/chaincheck.ts), never by the presence of this header.
   */
  paymentResponseHeader?: PaymentResponseHeaderNote;
  /** The chain check's reading of this purchase (src/evm/chaincheck.ts). */
  chainCheck?: ChainCheckNote;
  /** The catalog's URL of the listing bought (the request may differ: vet402 fills slots and inputs). */
  listingResource?: string;
  /** sha256 of the request vet402 sent (method, URL with query, JSON body): the next run does not send the same one after a 400/404/422. */
  requestKey?: string;
  /** Parameter names the listing declares. */
  declaredParams?: string[];
  /** The UTC date vet402 used when it filled the request, and the parameters it filled with that date. */
  inputDate?: string;
  datedParams?: string[];
}

export interface PaymentResponseHeaderNote {
  /** The header that was present: PAYMENT-RESPONSE (x402 v2), X-PAYMENT-RESPONSE (v1), both, or none; "not_recorded" on rows from before 2026-10-01. */
  present: "PAYMENT-RESPONSE" | "X-PAYMENT-RESPONSE" | "both" | "none" | "not_recorded";
  /** The x402 library decoded it into a settle response. On old rows: whether settleResponse was kept. */
  decoded: boolean;
  /** The decoded response named a 0x + 64 hex transaction. */
  namedTx: boolean;
  /** Why decoding failed, cut short. */
  error?: string;
}

export interface ChainCheckNote {
  checkedAt: string;
  /**
   * transfer_found  a transfer of the price from the payer to the payTo was read on chain inside the authorization's
   *                 validity window and belongs to this purchase
   * no_transfer     no transfer from the payer to the payTo for the price is on chain inside that window
   * ambiguous       a transfer fits, but more than one purchase could own it (left for a human)
   * pending         nothing found yet and the window has not closed when the chain was read: read again later
   */
  result: "transfer_found" | "no_transfer" | "ambiguous" | "pending";
  /** How the transfer was tied to this purchase: the EIP-3009 nonce, the tx the seller named, payTo + price + window, or the receipt read at purchase time. */
  by: "nonce" | "named_tx" | "payto_amount_window" | "receipt" | null;
  tx: string | null;
  windowFrom: string;
  windowTo: string;
}

const parser = new x402HTTPClient(new x402Client());

/**
 * sha256 of the request as sent: method, URL with query, and the JSON body of a POST. Only the parameters vet402
 * itself filled with the run's date (`dated.params`, rule table:date in src/inputs/values.ts) are written as
 * <today>, so a request that differs only by the day vet402 filled it is the same request. A date the catalog
 * gave is kept as it is, even when it is today.
 */
export function laneRequestKey(e: Pick<ChainBuyEntry, "resource" | "query" | "method" | "body">, dated?: { date: string; params: readonly string[] } | null): string {
  let query = e.query;
  let b = e.body;
  if (dated && /^\d{4}-\d{2}-\d{2}$/.test(dated.date) && dated.params.length) {
    const swap = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, dated.params.includes(k) && v === dated.date ? "<today>" : v]));
    if (query) query = swap(query) as Record<string, string>;
    if (b && typeof b === "object" && !Array.isArray(b)) b = swap(b as Record<string, unknown>);
  }
  const body = e.method === "POST" ? JSON.stringify(b ?? {}) : "";
  return createHash("sha256").update(`${e.method}\n${requestUrl({ resource: e.resource, query })}\n${body}`).digest("hex");
}

export function requestUrl(e: Pick<ChainBuyEntry, "resource" | "query">): string {
  if (!e.query || Object.keys(e.query).length === 0) return e.resource;
  const u = new URL(e.resource);
  for (const [k, v] of Object.entries(e.query)) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
  return u.toString();
}

function requestInit(e: Pick<ChainBuyEntry, "method" | "body">, extra: Record<string, string> = {}): RequestInit {
  const headers: Record<string, string> = { accept: "application/json", ...extra };
  const init: RequestInit = { method: e.method, headers, redirect: "manual" };
  if (e.method === "POST") {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(e.body ?? {});
  }
  return init;
}

export async function probe402(e: Pick<ChainBuyEntry, "resource" | "query" | "method" | "body">, f: typeof fetch): Promise<{ status: number | null; pr: PaymentRequired | null; accepts: EvmAccept[]; error?: string }> {
  let res: Response;
  try {
    res = await f(requestUrl(e), { ...requestInit(e), signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    return { status: null, pr: null, accepts: [], error: `fetch: ${(err as Error).message}`.slice(0, 200) };
  }
  if (res.status !== 402) {
    await res.body?.cancel().catch(() => {});
    return { status: res.status, pr: null, accepts: [] };
  }
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    body = undefined;
  }
  try {
    const pr = parser.getPaymentRequiredResponse((n: string) => res.headers.get(n), body);
    return { status: 402, pr, accepts: (pr.accepts as unknown as Record<string, unknown>[]).map(normalizeAccept) };
  } catch (err) {
    return { status: 402, pr: null, accepts: [], error: `unparseable 402: ${(err as Error).message}`.slice(0, 200) };
  }
}

/** The exact accept on `network` in the same 402 (for the "same seller on another chain" check). */
export function payToOn(accepts: EvmAccept[], network: string, lockedPayTo: string): string | null {
  const on = accepts.filter((a) => a.network === network && a.scheme === "exact");
  return (on.find((a) => eqAddr(a.payTo, lockedPayTo)) ?? on[0])?.payTo ?? null;
}

export async function buyOneOnChain(spec: EvmChainSpec, e: ChainBuyEntry, deps: ChainBuyDeps, opts: { keepSettleResponse?: boolean; keepBodyBytes?: number } = {}): Promise<ChainBuyRecord> {
  const rec: ChainBuyRecord = {
    agentId: e.agentId,
    resource: e.resource,
    method: e.method,
    at: new Date().toISOString(),
    outcome: "refused",
    payer: deps.payer,
    listingResource: e.listingResource ?? e.resource,
    requestKey: laneRequestKey(e, e.inputDate ? { date: e.inputDate, params: e.datedParams ?? [] } : null),
    ...(e.inputDate ? { inputDate: e.inputDate } : {}),
    ...(e.datedParams?.length ? { datedParams: e.datedParams } : {}),
    ...(e.declaredParams?.length ? { declaredParams: e.declaredParams } : {}),
  };
  const refuse = (r: EvmRefusal): ChainBuyRecord => ({ ...rec, outcome: "refused", refusal: r });
  const maxPer = deps.maxPerAtomic ?? MAX_PER_PURCHASE_ATOMIC;

  // agentWallet re-read now: the lock is what the chain says at pay time, not what a file said earlier.
  let wallet: Address | undefined;
  if (deps.requireAgentWallet && (e.agentWallet === undefined || e.agentWallet === null || !isAddress(String(e.agentWallet)))) {
    return refuse({ refused: "payto_not_agent_wallet", detail: "the entry has no agentWallet; this lane requires one" });
  }
  if (e.agentWallet !== undefined) {
    if (!deps.readAgentWallet) return refuse({ refused: "payto_not_agent_wallet", detail: "no agentWallet reader" });
    try {
      wallet = await deps.readAgentWallet(e.agentId);
    } catch (err) {
      return refuse({ refused: "payto_not_agent_wallet", detail: `agentWallet unreadable: ${(err as Error).message}`.slice(0, 200) });
    }
    if (!eqAddr(wallet, e.agentWallet)) return refuse({ refused: "payto_not_agent_wallet", detail: `agentWallet changed: ${wallet} (plan ${e.agentWallet})` });
  }

  const p = await probe402(e, deps.fetch);
  if (p.status !== 402 || !p.pr) return refuse({ refused: `no_${spec.key}_accept`, detail: `unpaid request returned ${p.status ?? "no response"}${p.error ? `: ${p.error}` : ""}` });
  const a = pickChainAccept(spec, p.accepts, e.lock.payTo);
  rec.payTo = a?.payTo;
  rec.payToIsAgentWallet = a && wallet ? eqAddr(a.payTo, wallet) : false;
  const r = checkChainAccept(spec, a, {
    payer: deps.payer,
    lockedPayTo: e.lock.payTo,
    lockedAmount: e.lock.amount,
    ...(wallet !== undefined ? { agentWallet: wallet } : {}),
    ...(e.sameSellerOn !== undefined ? { crossChainPayTo: { network: e.sameSellerOn, payTo: payToOn(p.accepts, e.sameSellerOn, e.lock.payTo) } } : {}),
    maxPerAtomic: maxPer,
  });
  if (r) return refuse(r);
  const accept = a!;
  rec.priceUsdc = atomicToUsdc(accept.amount);
  rec.amountAtomic = accept.amount;

  let bal: bigint;
  try {
    bal = await deps.readAssetBalance();
  } catch (err) {
    return refuse({ refused: "ledger_unreadable", detail: `${spec.assetSymbol} balance unreadable: ${(err as Error).message}`.slice(0, 200) });
  }
  // Never sign a payment the wallet cannot cover. A dry run notes the shortfall and goes on (its signer is a throwaway).
  if (bal < BigInt(accept.amount)) {
    if (!deps.dryRun) return refuse({ refused: "insufficient_balance", detail: `${spec.assetSymbol} balance ${bal} < price ${accept.amount}` });
    rec.balanceShort = true;
  }
  deps.budget.setBaselineIfMissing(bal);
  // One purchase per seller: the default ledger key is the payTo, so two listings on one wallet cannot both buy.
  const key = e.ledgerKey ?? `${spec.key}-payto:${accept.payTo.toLowerCase()}`;
  const res = deps.budget.reserve(BigInt(accept.amount), key, bal);
  if ("refused" in res) return refuse({ refused: res.refused as EvmRefusal["refused"], detail: res.detail });

  // ---- from here a signature may exist ----
  let created: CreatedEvmPayment;
  try {
    created = await createChainPayment(spec, deps.signer, p.pr, accept, maxPer);
  } catch (err) {
    deps.budget.release(res.id);
    return { ...rec, outcome: "not_sent", refusal: { refused: "payload_check_failed", detail: (err as Error).message.slice(0, 300) } };
  }
  deps.budget.commit(res.id);
  if (deps.dryRun) return { ...rec, outcome: "would_pay" };
  rec.authorization = { nonce: created.authorization.nonce, validAfter: String(created.authorization.validAfter), validBefore: String(created.authorization.validBefore) };

  rec.outcome = "sent";
  let paid: Response | null = null;
  const t0 = Date.now();
  try {
    paid = await deps.fetch(requestUrl(e), { ...requestInit(e, created.headers), signal: AbortSignal.timeout(90_000) });
  } catch (err) {
    rec.response = { status: null, contentType: null, bytes: 0, first300: null, error: `fetch: ${(err as Error).message}`.slice(0, 200) };
  }
  let text = "";
  if (paid) {
    try {
      text = await paid.text();
    } catch {
      /* empty */
    }
    rec.response = { status: paid.status, contentType: paid.headers.get("content-type"), bytes: text.length, first300: text.slice(0, 300) };
    if (opts.keepSettleResponse) rec.paidRequestMs = Date.now() - t0;
    if (opts.keepBodyBytes) rec.body = text.slice(0, opts.keepBodyBytes);
    const v2 = paid.headers.get("payment-response") !== null;
    const v1 = paid.headers.get("x-payment-response") !== null;
    const present: PaymentResponseHeaderNote["present"] = v2 && v1 ? "both" : v2 ? "PAYMENT-RESPONSE" : v1 ? "X-PAYMENT-RESPONSE" : "none";
    try {
      const s = parser.getPaymentSettleResponse((n: string) => paid!.headers.get(n)) as SettleResponse;
      rec.settlementTx = typeof s.transaction === "string" && /^0x[0-9a-fA-F]{64}$/.test(s.transaction) ? s.transaction : null;
      if (opts.keepSettleResponse) rec.settleResponse = { success: s.success, transaction: s.transaction, network: s.network, errorReason: s.errorReason, payer: s.payer };
      rec.paymentResponseHeader = { present, decoded: true, namedTx: rec.settlementTx !== null };
    } catch (err) {
      rec.settlementTx = null;
      if (opts.keepSettleResponse) rec.settleResponse = null;
      rec.paymentResponseHeader = { present, decoded: false, namedTx: false, ...(present !== "none" ? { error: (err as Error).message.slice(0, 160) } : {}) };
    }
  }
  if (rec.settlementTx) {
    const v: { ok: boolean; from?: string; reason?: string } = await deps
      .verifySettlement(rec.settlementTx as Hex, accept.payTo, accept.amount)
      .catch((err) => ({ ok: false, reason: (err as Error).message.slice(0, 200) }));
    rec.settledOnChain = v.ok && !!v.from && eqAddr(v.from, deps.payer);
    rec.settlementCheck = v.ok ? `transfer ${v.from} -> ${accept.payTo} ${accept.amount}` : `not verified: ${v.reason}`;
  } else {
    rec.settledOnChain = false;
    rec.settlementCheck = "no settlement tx in the response";
  }
  const ok2xx = !!paid && paid.status >= 200 && paid.status < 300 && text.trim().length > 0;
  rec.delivered = ok2xx && rec.settledOnChain === true;
  return rec;
}
