/**
 * Base purchases from 0x9B59 (x402 v2 `exact`, EIP-3009 TransferWithAuthorization only).
 *
 * Who is bought from: sellers that (1) vet402 has already bought from and got a delivery, and
 * (2) are registered in ERC-8004 on Base with agentWallet == the payTo vet402 paid. One purchase per agent.
 *
 * Money guards, all before any signature:
 *   0.10 USDC per purchase, 1.00 USDC total, 10 purchases, one per agent (persistent ledger, fail-closed),
 *   payTo locked to the on-chain agentWallet, price may drop but never rise, USDC on Base only,
 *   assetTransferMethod must be EIP-3009 (Permit2 / approve paths are refused: they can move funds on-chain
 *   from the wallet itself), maxTimeoutSeconds <= 3600.
 * The signer handed to the x402 client can only sign that one TransferWithAuthorization (see fencedSigner).
 * It has no transaction-sending capability at all.
 */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { getAddress, isAddress, isAddressEqual, verifyTypedData, type Address, type Hex } from "viem";
import { MAX_PER_PURCHASE_ATOMIC, atomicToUsdc } from "../constants.js";
import { normalizeAccept, type Budget, type SolAccept } from "../guard.js";
import { BASE_USDC } from "./erc8004.js";

export const BASE_CAIP2 = "eip155:8453";
export const BASE_CHAIN_ID = 8453;
/** Circle USDC on Base, EIP-712 domain (read from the token: name() = "USD Coin", version "2"). */
export const USDC_DOMAIN = { name: "USD Coin", version: "2" } as const;
export const MAX_TIMEOUT_SECONDS = 3600;

export type EvmAccept = SolAccept;

export interface EvmRefusal {
  refused:
    | "no_base_accept"
    | "scheme_mismatch"
    | "network_mismatch"
    | "asset_mismatch"
    | "bad_amount"
    | "price_over_cap"
    | "price_raised"
    | "payto_mismatch"
    | "payto_not_agent_wallet"
    | "payto_invalid"
    | "self_dealing"
    | "not_eip3009"
    | "domain_mismatch"
    | "timeout_invalid"
    | "total_cap_reached"
    | "purchase_count_reached"
    | "already_bought"
    | "payload_check_failed"
    | "ledger_unreadable";
  detail: string;
}

/** Among a live 402's accepts, the Base USDC exact accept to the locked payTo (else the first Base one, so the check says why). */
export function pickBaseAccept(accepts: EvmAccept[], lockedPayTo: string): EvmAccept | null {
  const base = accepts.filter((a) => a.network === BASE_CAIP2);
  if (base.length === 0) return null;
  const good = base.filter((a) => a.scheme === "exact" && eq(a.asset, BASE_USDC) && eq(a.payTo, lockedPayTo));
  return good[0] ?? base[0]!;
}

function eq(a: string, b: string): boolean {
  return isAddress(a) && isAddress(b) && isAddressEqual(a, b);
}

export interface BaseAcceptContext {
  payer: string;
  /** payTo recorded at plan time from the unpaid 402. */
  lockedPayTo: string;
  lockedAmount?: string;
  /** getAgentWallet(agentId) read on Base. */
  agentWallet: string;
}

/** Every per-accept check. null = may go on to the budget. Pure. */
export function checkBaseAccept(a: EvmAccept | null, ctx: BaseAcceptContext): EvmRefusal | null {
  if (!a) return { refused: "no_base_accept", detail: "the 402 has no Base mainnet accept" };
  if (a.scheme !== "exact") return { refused: "scheme_mismatch", detail: `scheme ${a.scheme} (only exact)` };
  if (a.network !== BASE_CAIP2) return { refused: "network_mismatch", detail: `network ${a.network}` };
  if (!eq(a.asset, BASE_USDC)) return { refused: "asset_mismatch", detail: `asset ${a.asset} is not Base USDC` };
  if (!/^\d{1,18}$/.test(a.amount) || BigInt(a.amount) <= 0n) return { refused: "bad_amount", detail: `amount ${JSON.stringify(a.amount)}` };
  const amount = BigInt(a.amount);
  if (amount > MAX_PER_PURCHASE_ATOMIC) return { refused: "price_over_cap", detail: `amount ${amount} > per-purchase cap ${MAX_PER_PURCHASE_ATOMIC}` };
  if (ctx.lockedAmount !== undefined && amount > BigInt(ctx.lockedAmount)) return { refused: "price_raised", detail: `amount ${amount} > recorded ${ctx.lockedAmount}` };
  if (!isAddress(a.payTo)) return { refused: "payto_invalid", detail: `payTo ${a.payTo}` };
  if (!eq(a.payTo, ctx.lockedPayTo)) return { refused: "payto_mismatch", detail: `payTo ${a.payTo} != recorded ${ctx.lockedPayTo}` };
  if (!eq(a.payTo, ctx.agentWallet)) return { refused: "payto_not_agent_wallet", detail: `payTo ${a.payTo} != agentWallet ${ctx.agentWallet}` };
  if (eq(a.payTo, ctx.payer)) return { refused: "self_dealing", detail: "payTo is the payer" };
  const method = a.extra?.assetTransferMethod;
  if (method !== undefined && method !== "eip3009") return { refused: "not_eip3009", detail: `assetTransferMethod ${String(method)}` };
  if (a.extra?.name !== USDC_DOMAIN.name || a.extra?.version !== USDC_DOMAIN.version) {
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
}

/**
 * Wrap a signer so it signs exactly one EIP-3009 TransferWithAuthorization: Base USDC domain, from the signer,
 * to the locked payTo, for the locked amount (<= 0.10), valid for at most MAX_TIMEOUT_SECONDS. Anything else throws.
 * No readContract / sendTransaction is exposed, so the x402 library cannot take the approve or Permit2 paths.
 */
export function fencedSigner(inner: TypedDataSigner, lock: SignLock): TypedDataSigner & { signed: number } {
  const now = lock.nowSec ?? (() => Math.floor(Date.now() / 1000));
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
      if (d.name !== USDC_DOMAIN.name || d.version !== USDC_DOMAIN.version) fail("domain name/version");
      if (Number(d.chainId) !== BASE_CHAIN_ID) fail(`chainId ${String(d.chainId)}`);
      if (!eq(String(d.verifyingContract), BASE_USDC)) fail(`verifyingContract ${String(d.verifyingContract)}`);
      if (!eq(String(msg.from), inner.address)) fail("from is not the signer");
      if (!eq(String(msg.to), lock.payTo)) fail(`to ${String(msg.to)} != locked payTo`);
      const value = BigInt(String(msg.value));
      if (value !== BigInt(lock.amount) || value > MAX_PER_PURCHASE_ATOMIC || value <= 0n) fail(`value ${value}`);
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
  return n.scheme === a.scheme && n.network === a.network && eq(n.asset, a.asset) && eq(n.payTo, a.payTo) && n.amount === a.amount;
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

/** Build the x402 payment for exactly `accept`, then read it back and verify the signature against the payer. */
export async function createBasePayment(signer: TypedDataSigner, pr: PaymentRequired, accept: EvmAccept): Promise<CreatedEvmPayment> {
  const fenced = fencedSigner(signer, { payTo: accept.payTo, amount: accept.amount });
  const client = new x402Client((_v, reqs) => {
    const hit = (reqs as unknown as Record<string, unknown>[]).find((r) => sameAccept(r, accept));
    if (!hit) throw new Error("locked accept not offered to the selector");
    return hit as never;
  });
  client.setSpendControls({ maxAmountPerPayment: "$0.10" });
  client.register(BASE_CAIP2 as never, new ExactEvmScheme(fenced));
  const http = new x402HTTPClient(client);
  const payload = await http.createPaymentPayload(pr);
  const accepted = (payload as { accepted?: Record<string, unknown> }).accepted;
  if (accepted && !sameAccept(accepted, accept)) throw new Error("payload.accepted differs from the locked accept");
  const inner = payload.payload as { authorization?: CreatedEvmPayment["authorization"]; signature?: Hex };
  const auth = inner.authorization;
  const sig = inner.signature;
  if (!auth || !sig) throw new Error("payload is not an EIP-3009 authorization");
  if (!eq(auth.from, signer.address) || !eq(auth.to, accept.payTo) || auth.value !== accept.amount) throw new Error("authorization fields differ from the lock");
  const ok = await verifyTypedData({
    address: signer.address,
    domain: { name: USDC_DOMAIN.name, version: USDC_DOMAIN.version, chainId: BASE_CHAIN_ID, verifyingContract: BASE_USDC },
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

export interface BuyEntry {
  agentId: string;
  resource: string;
  method: "GET" | "POST";
  /** Declared example input from the seller's own Bazaar listing (what vet402 sent when it got a delivery). */
  query: Record<string, string> | null;
  body: unknown;
  agentWallet: Address;
  /** From the unpaid 402 at plan time. */
  lock: { payTo: string; amount: string };
}

export interface BuyDeps {
  fetch: typeof fetch;
  payer: Address;
  signer: TypedDataSigner;
  budget: Budget;
  readUsdcBalance: () => Promise<bigint>;
  /** Re-read agentWallet right before paying. */
  readAgentWallet: (agentId: string) => Promise<Address>;
  /** Base tx -> USDC Transfer check (payer -> payTo, amount). */
  verifySettlement: (tx: Hex, payTo: string, amount: string) => Promise<{ ok: boolean; from?: string; reason?: string; blockNumber?: string }>;
  dryRun: boolean;
}

export interface BuyRecord {
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
}

const parser = new x402HTTPClient(new x402Client());

export function requestUrl(e: Pick<BuyEntry, "resource" | "query">): string {
  if (!e.query || Object.keys(e.query).length === 0) return e.resource;
  const u = new URL(e.resource);
  for (const [k, v] of Object.entries(e.query)) if (!u.searchParams.has(k)) u.searchParams.set(k, v);
  return u.toString();
}

function requestInit(e: BuyEntry, extra: Record<string, string> = {}): RequestInit {
  const headers: Record<string, string> = { accept: "application/json", ...extra };
  const init: RequestInit = { method: e.method, headers, redirect: "manual" };
  if (e.method === "POST") {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(e.body ?? {});
  }
  return init;
}

export async function probeBase402(e: BuyEntry, f: typeof fetch): Promise<{ status: number | null; pr: PaymentRequired | null; accepts: EvmAccept[]; error?: string }> {
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

export async function buyOne(e: BuyEntry, deps: BuyDeps): Promise<BuyRecord> {
  const rec: BuyRecord = { agentId: e.agentId, resource: e.resource, method: e.method, at: new Date().toISOString(), outcome: "refused", payer: deps.payer };
  const refuse = (r: EvmRefusal): BuyRecord => ({ ...rec, outcome: "refused", refusal: r });

  // agentWallet re-read now: the lock is what the chain says at pay time, not what a file said earlier.
  let wallet: Address;
  try {
    wallet = await deps.readAgentWallet(e.agentId);
  } catch (err) {
    return refuse({ refused: "payto_not_agent_wallet", detail: `agentWallet unreadable: ${(err as Error).message}`.slice(0, 200) });
  }
  if (!eq(wallet, e.agentWallet)) return refuse({ refused: "payto_not_agent_wallet", detail: `agentWallet changed: ${wallet} (plan ${e.agentWallet})` });

  const p = await probeBase402(e, deps.fetch);
  if (p.status !== 402 || !p.pr) return refuse({ refused: "no_base_accept", detail: `unpaid request returned ${p.status ?? "no response"}${p.error ? `: ${p.error}` : ""}` });
  const a = pickBaseAccept(p.accepts, e.lock.payTo);
  rec.payTo = a?.payTo;
  rec.payToIsAgentWallet = a ? eq(a.payTo, wallet) : false;
  const r = checkBaseAccept(a, { payer: deps.payer, lockedPayTo: e.lock.payTo, lockedAmount: e.lock.amount, agentWallet: wallet });
  if (r) return refuse(r);
  const accept = a!;
  rec.priceUsdc = atomicToUsdc(accept.amount);
  rec.amountAtomic = accept.amount;

  let bal: bigint;
  try {
    bal = await deps.readUsdcBalance();
  } catch (err) {
    return refuse({ refused: "ledger_unreadable", detail: `USDC balance unreadable: ${(err as Error).message}`.slice(0, 200) });
  }
  deps.budget.setBaselineIfMissing(bal);
  // One purchase per seller: the ledger key is the payTo, so two agent ids on one wallet cannot both buy.
  const res = deps.budget.reserve(BigInt(accept.amount), `base-payto:${accept.payTo.toLowerCase()}`, bal);
  if ("refused" in res) return refuse({ refused: res.refused as EvmRefusal["refused"], detail: res.detail });

  // ---- from here a signature may exist ----
  let created: CreatedEvmPayment;
  try {
    created = await createBasePayment(deps.signer, p.pr, accept);
  } catch (err) {
    deps.budget.release(res.id);
    return { ...rec, outcome: "not_sent", refusal: { refused: "payload_check_failed", detail: (err as Error).message.slice(0, 300) } };
  }
  deps.budget.commit(res.id);
  if (deps.dryRun) return { ...rec, outcome: "would_pay" };

  rec.outcome = "sent";
  let paid: Response | null = null;
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
    try {
      const s = parser.getPaymentSettleResponse((n: string) => paid!.headers.get(n)) as { success?: boolean; transaction?: string };
      rec.settlementTx = typeof s.transaction === "string" && /^0x[0-9a-fA-F]{64}$/.test(s.transaction) ? s.transaction : null;
    } catch {
      rec.settlementTx = null;
    }
  }
  if (rec.settlementTx) {
    const v: { ok: boolean; from?: string; reason?: string } = await deps
      .verifySettlement(rec.settlementTx as Hex, accept.payTo, accept.amount)
      .catch((err) => ({ ok: false, reason: (err as Error).message.slice(0, 200) }));
    rec.settledOnChain = v.ok && !!v.from && eq(v.from, deps.payer);
    rec.settlementCheck = v.ok ? `transfer ${v.from} -> ${accept.payTo} ${accept.amount}` : `not verified: ${v.reason}`;
  } else {
    rec.settledOnChain = false;
    rec.settlementCheck = "no settlement tx in the response";
  }
  const ok2xx = !!paid && paid.status >= 200 && paid.status < 300 && text.trim().length > 0;
  rec.delivered = ok2xx && rec.settledOnChain === true;
  return rec;
}
