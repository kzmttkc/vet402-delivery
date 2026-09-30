/**
 * Shared fakes for the proxy buy tests: generated keys, mock sellers, a fake x402 facilitator, a fake Solana
 * chain, a fake Tempo RPC that "mines" transactions, and a real Postgres (PGlite, in process) for the books.
 * No network, no mainnet, no real keys.
 */
import assert from "node:assert/strict";
import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
  type KeyPairSigner,
} from "@solana/kit";
import { getTransferCheckedInstruction } from "@solana-program/token";
import { PGlite } from "@electric-sql/pglite";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { Credential } from "mppx";
import { Mppx, tempo as mppTempo } from "mppx/server";
import { createClient, custom, decodeFunctionData, encodeAbiParameters, encodeEventTopics, keccak256, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { tempo as tempoChain } from "viem/chains";
import { Abis, Transaction } from "viem/tempo";
import { MEMO_PROGRAM, SOLANA_MAINNET, USDC_MINT } from "../src/constants.js";
import { checkPaymentTransaction, usdcAta } from "../src/txcheck.js";
import type { OnChain } from "../src/chain.js";
import { signerFor } from "../src/tempo/chain.js";
import { TEMPO_MAINNET_CHAIN_ID, USDC_E } from "../src/tempo/constants.js";
import { makeAllowlist } from "../src/proxy-buy/allowlist.js";
import { BUY_FEE_ATOMIC } from "../src/proxy-buy/constants.js";
import { migrate, type Sql } from "../src/proxy-buy/db.js";
import { decodeSolanaTx, type Fate, type TempoReads } from "../src/proxy-buy/fate.js";
import { createProxyBuy, type ProxyBuy } from "../src/proxy-buy/handler.js";
import { reconcile, type ReconcileAction } from "../src/proxy-buy/reconcile.js";
import { sendTempoRefund, type RefundOutcome, type RefundSender } from "../src/proxy-buy/refund.js";
import { resetInit, type SolanaSide } from "../src/proxy-buy/solana.js";
import { Store, type DayCaps } from "../src/proxy-buy/store.js";
import type { TempoSide } from "../src/proxy-buy/tempo.js";
import { mppAdapter, type MppxLike } from "../src/proxy-buy/wire.js";

// ---------- wallets (all generated here) ----------
export const agent = await generateKeyPairSigner(); // the customer agent (Solana)
export const proxyPayer = await generateKeyPairSigner(); // vet402's proxy payer (Solana)
export const RECEIVE = (await generateKeyPairSigner()).address; // vet402's proxy receive wallet (Solana)
export const SELLER = (await generateKeyPairSigner()).address;
export const SELLER2 = (await generateKeyPairSigner()).address;
export const SELLER_FAC = (await generateKeyPairSigner()).address; // the seller's facilitator fee payer
export const VET_FAC = (await generateKeyPairSigner()).address; // the facilitator vet402 receives through
export const RECEIVE_ATA = await usdcAta(RECEIVE);
export const PAYER_ATA = await usdcAta(proxyPayer.address);

export const tAgent = privateKeyToAccount(generatePrivateKey());
export const tProxy = privateKeyToAccount(generatePrivateKey());
export const T_RECEIVE = privateKeyToAccount(generatePrivateKey()).address;
export const T_SELLER = privateKeyToAccount(generatePrivateKey()).address;
export const T_OTHER = privateKeyToAccount(generatePrivateKey()).address;

export const S_HOST = "seller.test";
export const S_URL = `https://${S_HOST}/api/quote?sym=SOL`;
export const T_HOST = "tseller.test";
export const T_URL = `https://${T_HOST}/v1/weather`;
export const ORIGIN = "https://buy.test";

export const allowlist = makeAllowlist([
  { chain: "solana", host: S_HOST, payTo: SELLER, settled: true, delivered: true, at: "2026-09-29T00:00:00Z" },
  { chain: "tempo", host: T_HOST, payTo: T_SELLER, settled: true, delivered: true, at: "2026-09-29T00:00:00Z" },
]);

export const CAPS: DayCaps = { cap: 2_000_000n, maxCount: 100, refundCap: 2_000_000n };

// ---------- the database: a real Postgres in process ----------

/**
 * PGlite has one connection: statements and transactions are serialised here, the way row locks would
 * serialise them on a real server. Statements inside a transaction use the transaction's handle.
 */
export async function testSql(): Promise<Sql> {
  const db = new PGlite();
  let tail: Promise<unknown> = Promise.resolve();
  const lock = <T>(f: () => Promise<T>): Promise<T> => {
    const next = tail.then(f, f);
    tail = next.catch(() => undefined);
    return next;
  };
  type Q = { query: (t: string, p?: unknown[]) => Promise<{ rows: unknown[] }> };
  const inner = (h: Q): Sql => ({
    query: async <T>(t: string, p: unknown[] = []) => ({ rows: (await h.query(t, p)).rows as T[] }),
    tx: (fn) => fn(inner(h)),
  });
  const sql: Sql = {
    query: <T>(t: string, p: unknown[] = []) => lock(async () => ({ rows: (await db.query(t, p)).rows as T[] })),
    tx: (fn) => lock(() => db.transaction((tx) => fn(inner(tx as unknown as Q)))),
  };
  await migrate(sql);
  return sql;
}

// ---------- Solana transactions (real encoding, like the census tests) ----------
export async function transferTx(from: KeyPairSigner, feePayer: string, payTo: string, amount: bigint, memo = "00112233445566778899aabbccddeeff"): Promise<string> {
  const src = await usdcAta(from.address);
  const dst = await usdcAta(payTo);
  const tx = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(feePayer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 0n }, m),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getTransferCheckedInstruction({ source: address(src), mint: address(USDC_MINT), destination: address(dst), authority: from, amount, decimals: 6 }),
          { programAddress: address(MEMO_PROGRAM), data: new TextEncoder().encode(memo) },
        ],
        m,
      ),
  );
  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(tx));
}

/** A fake Solana chain: which messages landed, and whether blockhashes are still valid. */
export class FakeSolChain {
  landed = new Map<string, { sig: string; ok: boolean }>();
  /** false: every blockhash is expired (an unseen transaction is dead). */
  blockhashValid = false;
  mine(txBase64: string, sig: string, ok = true): void {
    const d = decodeSolanaTx(txBase64);
    if (d) this.landed.set(d.messageHash, { sig, ok });
  }
  fate(messageHash: string): Fate {
    const hit = this.landed.get(messageHash);
    if (hit) return hit.ok ? { fate: "landed", tx: hit.sig } : { fate: "failed", tx: hit.sig };
    return this.blockhashValid ? { fate: "pending" } : { fate: "dead" };
  }
}

// ---------- a mock x402 seller on Solana ----------
export interface SolSeller {
  price: bigint;
  payTo: string;
  paidStatus: number;
  paidBody: string | Uint8Array;
  paidType?: string;
  unpaidReads: number;
  paidRequests: number;
  /** Called before each unpaid read with its 1-based index: lets a test move the price or payTo. */
  onRead?: (n: number, s: SolSeller) => void;
}
export function solSeller(over: Partial<SolSeller> = {}): SolSeller {
  return { price: 10_000n, payTo: SELLER, paidStatus: 200, paidBody: JSON.stringify({ sym: "SOL", px: 151.2 }), unpaidReads: 0, paidRequests: 0, ...over };
}
export function solSellerFetch(s: SolSeller, fetched: string[]) {
  return (async (url: string | URL, init?: RequestInit) => {
    fetched.push(String(url));
    const h = new Headers(init?.headers);
    if (h.has("PAYMENT-SIGNATURE")) {
      s.paidRequests++;
      return new Response(typeof s.paidBody === "string" ? s.paidBody : new Uint8Array(s.paidBody), { status: s.paidStatus, headers: { "content-type": s.paidType ?? "application/json" } });
    }
    s.unpaidReads++;
    s.onRead?.(s.unpaidReads, s);
    const pr = {
      x402Version: 2,
      resource: { url: String(url) },
      accepts: [{ scheme: "exact", network: SOLANA_MAINNET, amount: s.price.toString(), asset: USDC_MINT, payTo: s.payTo, maxTimeoutSeconds: 60, extra: { feePayer: SELLER_FAC } }],
    };
    return new Response("{}", { status: 402, headers: { "content-type": "application/json", "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(pr)).toString("base64") } });
  }) as unknown as typeof fetch;
}

// ---------- a fake facilitator for vet402's receive side ----------
export class FakeFacilitator implements FacilitatorClient {
  verifies = 0;
  settles = 0;
  fail: "none" | "settle_false_verify" | "settle_false_after_send" | "settle_throw" = "none";
  /** When set, every settle answers with this transaction (a facilitator that answers a replay with an earlier settlement). */
  fixedTx: string | null = null;
  constructor(private readonly chain: FakeSolChain) {}
  async getSupported() {
    return { kinds: [{ x402Version: 2, scheme: "exact", network: SOLANA_MAINNET, extra: { feePayer: VET_FAC } }], extensions: [], signers: {} } as never;
  }
  async verify(p: PaymentPayload, r: PaymentRequirements) {
    this.verifies++;
    const tx = (p.payload as { transaction?: string }).transaction ?? "";
    const c = await checkPaymentTransaction(tx, { scheme: r.scheme, network: r.network, amount: r.amount, asset: r.asset, payTo: r.payTo, extra: r.extra }, agent.address);
    return c.ok ? { isValid: true, payer: agent.address } : { isValid: false, invalidReason: c.detail };
  }
  async settle(p: PaymentPayload, r: PaymentRequirements) {
    this.settles++;
    await new Promise((res) => setTimeout(res, 5));
    const tx = (p.payload as { transaction: string }).transaction;
    const sig = `cust${keccak256(`0x${Buffer.from(tx, "base64").toString("hex")}` as Hex).slice(2, 60)}`;
    if (this.fail === "settle_throw") {
      this.chain.mine(tx, sig); // it went out before the facilitator's answer was lost
      throw new Error("request to https://rpc.example.test/?api-key=SECRET123 timed out");
    }
    if (this.fail === "settle_false_verify") return { success: false, errorReason: "invalid_exact_svm_payload_amount_mismatch", transaction: "", network: r.network } as never;
    if (this.fail === "settle_false_after_send") return { success: false, errorReason: "invalid_exact_svm_transaction_failed", transaction: "", network: r.network } as never;
    if (this.fixedTx) return { success: true, transaction: this.fixedTx, network: r.network, payer: agent.address } as never;
    this.chain.mine(tx, sig);
    return { success: true, transaction: sig, network: r.network, payer: agent.address } as never;
  }
}

export interface SolRig {
  buy: ProxyBuy;
  fac: FakeFacilitator;
  seller: SolSeller;
  fetched: string[];
  sellerPays: { amount: bigint; payTo: string }[];
  store: Store;
  sql: Sql;
  chain: FakeSolChain;
  side: SolanaSide;
  state: { balance: bigint; lamports: bigint; confirm: "ok" | "timeout" | "failed"; balanceError: string | null; refund: "sent" | "failed" | "unknown" | "hang" };
  refunds: { to: string; amount: bigint }[];
  reconcile: (o?: { staleMs?: number; now?: Date; walletCheck?: boolean }) => Promise<ReconcileAction[]>;
}

export async function solRig(
  o: {
    seller?: Partial<SolSeller>;
    enabled?: boolean;
    caps?: Partial<DayCaps>;
    balance?: bigint;
    wrapSeller?: (f: typeof fetch) => typeof fetch;
    /** false: the seller takes vet402's signed payment and never settles it. */
    sellerSettles?: boolean;
    sql?: Sql;
    now?: () => Date;
    budgetMs?: number;
    staleMs?: number;
    /** The spacing of request-triggered reconcile turns (default 0: every paid request). */
    reconcileGateMs?: number;
  } = {},
): Promise<SolRig> {
  const wrap = o.wrapSeller ?? ((f: typeof fetch) => f);
  resetInit();
  const sql = o.sql ?? (await testSql());
  const store = new Store(sql);
  const seller = solSeller(o.seller);
  const fetched: string[] = [];
  const chain = new FakeSolChain();
  const fac = new FakeFacilitator(chain);
  const rs = new x402ResourceServer(fac);
  rs.register(SOLANA_MAINNET as `${string}:${string}`, new ExactSvmScheme());
  const sellerPays: { amount: bigint; payTo: string }[] = [];
  const state: SolRig["state"] = { balance: o.balance ?? 5_000_000n, lamports: 10_000_000n, confirm: "ok", balanceError: null, refund: "sent" };
  const refunds: { to: string; amount: bigint }[] = [];
  let lastPay: { amount: bigint; payTo: string; tx: string } | null = null;
  let attempts = 0;
  const refund: RefundSender = async (to, amount, beforeSend): Promise<RefundOutcome> => {
    const n = ++attempts;
    if (state.refund === "failed") return { status: "failed", reason: "rpc_error", tx: null };
    if (!(await beforeSend({ tx: `refundtx${n}`, facts: { chain: "solana", messageHash: `refund-message-${n}`, blockhash: "b", account: PAYER_ATA } }))) {
      return { status: "failed", reason: "refund_taken_by_another_attempt", tx: null };
    }
    if (state.refund === "hang") return new Promise(() => undefined);
    // "unknown": signed and handed to the RPC, never landed (the chain says dead once its blockhash expires)
    if (state.refund === "unknown") return { status: "unknown", reason: "refund_not_confirmed_in_time", tx: `refundtx${n}` };
    refunds.push({ to, amount });
    state.balance -= amount;
    chain.landed.set(`refund-message-${n}`, { sig: `refundtx${n}`, ok: true });
    return { status: "sent", tx: `refundtx${n}` };
  };
  const side: SolanaSide = {
    receive: RECEIVE,
    receiveAta: RECEIVE_ATA,
    payer: proxyPayer.address,
    payerAta: PAYER_ATA,
    resourceServer: rs,
    pay: {
      fetch: wrap(solSellerFetch(seller, fetched)),
      createPayment: async (_pr, accept) => {
        const tx = await transferTx(proxyPayer, String(accept.extra?.feePayer), accept.payTo, BigInt(accept.amount));
        lastPay = { amount: BigInt(accept.amount), payTo: accept.payTo, tx };
        return { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ x402Version: 2, payload: { transaction: tx } })).toString("base64") }, txBase64: tx };
      },
      checkTx: checkPaymentTransaction,
      readBalances: async () => {
        if (state.balanceError) throw new Error(state.balanceError);
        return { lamports: state.lamports, usdcAtomic: state.balance };
      },
      waitForSettlement: async (): Promise<OnChain | null> => {
        const p = lastPay!;
        if (o.sellerSettles === false) return null;
        sellerPays.push({ amount: p.amount, payTo: p.payTo });
        state.balance -= p.amount;
        const sig = `sellertx${sellerPays.length}`;
        chain.mine(p.tx, sig);
        return { signature: sig, found: true, confirmed: true, err: null, memo: null, payToDeltaAtomic: p.amount.toString(), payerDeltaAtomic: `-${p.amount}`, payerLamportsDelta: "0", feePayer: SELLER_FAC };
      },
      ownAddresses: [RECEIVE, proxyPayer.address],
    },
    confirmCustomer: async (tx, authority, amount, messageHash) => {
      if (state.confirm === "timeout") return { ok: false, detail: "customer_tx_not_confirmed_in_time", definite: false };
      if (state.confirm === "failed") return { ok: false, detail: "customer_tx_failed_on_chain", definite: true };
      // like the production read: the named transaction must be the one the agent signed
      if (chain.landed.get(messageHash)?.sig !== tx) return { ok: false, detail: "customer_tx_not_the_signed_payment", definite: false };
      return authority === agent.address && amount > 0n ? { ok: true, payer: agent.address } : { ok: false, detail: "customer_amount_mismatch", definite: true };
    },
    fate: async (f) => chain.fate(f.messageHash),
    refund,
  };
  const now = o.now ?? (() => new Date());
  const buy = createProxyBuy({
    enabled: o.enabled ?? true,
    publicOrigin: ORIGIN,
    feeAtomic: BUY_FEE_ATOMIC,
    allowlist,
    store,
    caps: { solana: { ...CAPS, ...o.caps } },
    maxRefund: 105_000n,
    quoteDeps: { fetchImpl: wrap(solSellerFetch(seller, fetched)), ownAddresses: [RECEIVE, proxyPayer.address], solanaPayer: proxyPayer.address, tempoPayer: null },
    solana: side,
    now,
    quotesPerMinute: 1000,
    requestBudgetMs: o.budgetMs ?? 2_000,
    pollMs: 20,
    reconcileGateMs: o.reconcileGateMs ?? 0,
    ...(o.staleMs !== undefined ? { staleMs: o.staleMs } : {}),
  });
  const rec = (x: { staleMs?: number; now?: Date; walletCheck?: boolean } = {}) =>
    reconcile({
      walletCheck: x.walletCheck ?? false,
      store,
      feeAtomic: BUY_FEE_ATOMIC,
      now: () => x.now ?? new Date(Date.now() + 3_600_000),
      recordUrl: (id) => `${ORIGIN}/v1/buy/records/${id}`,
      caps: { ...CAPS, ...o.caps },
      maxRefund: 105_000n,
      deadline: Date.now() + 5_000,
      pollMs: 20,
      staleMs: x.staleMs ?? 0,
      solana: side,
    });
  return { buy, fac, seller, fetched, sellerPays, store, sql, chain, side, state, refunds, reconcile: rec };
}

export const buyUrl = (target: string) => `${ORIGIN}/v1/buy?url=${encodeURIComponent(target)}`;

/** The agent: read the 402, sign exactly what it asks, return the PAYMENT-SIGNATURE header. */
export async function agentPaysSolana(buy: ProxyBuy, target = S_URL, memo?: string): Promise<{ header: string; req: PaymentRequirements; body: Record<string, unknown> }> {
  const r = await buy.handle(new Request(buyUrl(target)));
  assert.equal(r.status, 402, await r.clone().text());
  const pr = decodePaymentRequiredHeader(r.headers.get("PAYMENT-REQUIRED")!);
  const req = pr.accepts[0]!;
  const tx = await transferTx(agent, String(req.extra?.feePayer), req.payTo, BigInt(req.amount), memo);
  const payload: PaymentPayload = { x402Version: 2, resource: pr.resource, accepted: req, payload: { transaction: tx } } as PaymentPayload;
  return { header: encodePaymentSignatureHeader(payload), req, body: (await r.json()) as Record<string, unknown> };
}
export const paidReq = (header: string, target = S_URL) => new Request(buyUrl(target), { headers: { "PAYMENT-SIGNATURE": header } });

// ================= Tempo =================

export interface FakeChain {
  broadcasts: number;
  sent: { from: string; to: string; amount: bigint; hash: string; memo?: string }[];
  mined: Map<string, "success" | "reverted">;
  /** Added to the wall clock for the chain's head time (a test moves time past a validBefore). */
  timeShift: number;
}

export function newFakeChain(): FakeChain {
  return { broadcasts: 0, sent: [], mined: new Map(), timeShift: 0 };
}

const nowSec = (c: FakeChain) => Math.floor(Date.now() / 1000) + c.timeShift;

/** Record a signed Tempo transaction as mined (its TIP-20 transfers), return the receipt logs. */
export function mineTempo(chain: FakeChain, raw: Hex) {
  const blockHash = `0x${"11".repeat(32)}`;
  const tx = Transaction.deserialize(raw as never) as unknown as { from: Hex; calls: { to: Hex; data: Hex }[] };
  const hash = keccak256(raw).toLowerCase();
  const logs = [];
  let i = 0;
  for (const c of tx.calls) {
    const d = decodeFunctionData({ abi: Abis.tip20, data: c.data });
    const [to, amount, memo] = d.args as [Hex, bigint, Hex | undefined];
    chain.sent.push({ from: tx.from.toLowerCase(), to: to.toLowerCase(), amount, hash, ...(memo ? { memo: memo.toLowerCase() } : {}) });
    const base = { address: c.to, blockHash, blockNumber: "0x1", transactionHash: hash, transactionIndex: "0x0", removed: false };
    logs.push({ ...base, logIndex: `0x${(i++).toString(16)}`, topics: encodeEventTopics({ abi: Abis.tip20, eventName: "Transfer", args: { from: tx.from, to } }), data: encodeAbiParameters([{ type: "uint256" }], [amount]) });
    if (memo) logs.push({ ...base, logIndex: `0x${(i++).toString(16)}`, topics: encodeEventTopics({ abi: Abis.tip20, eventName: "TransferWithMemo", args: { from: tx.from, to, memo } }), data: encodeAbiParameters([{ type: "uint256" }], [amount]) });
  }
  chain.mined.set(hash, "success");
  return { hash, from: tx.from, logs, to: tx.calls[0]!.to, blockHash };
}

/** A Tempo RPC that fills like the census tests and "mines" a raw transaction into a receipt with TIP-20 logs. */
export function fakeTempoRpc(chain: FakeChain) {
  return custom({
    async request({ method, params }: { method: string; params?: unknown[] }) {
      switch (method) {
        case "eth_chainId":
          return "0x1079";
        case "eth_getTransactionCount":
          return "0x0";
        case "eth_estimateGas":
          return "0xc350";
        case "eth_maxPriorityFeePerGas":
          return "0x0";
        case "eth_getBlockByNumber":
          return { baseFeePerGas: "0x23c34600", number: "0x1", timestamp: `0x${nowSec(chain).toString(16)}`, hash: `0x${"11".repeat(32)}`, transactions: [] };
        case "eth_call":
          return "0x";
        case "eth_sendRawTransactionSync": {
          chain.broadcasts++;
          const m = mineTempo(chain, (params as [Hex])[0]);
          return {
            blockHash: m.blockHash,
            blockNumber: "0x1",
            contractAddress: null,
            cumulativeGasUsed: "0xc350",
            effectiveGasPrice: "0x1",
            from: m.from,
            gasUsed: "0xc350",
            logs: m.logs,
            logsBloom: `0x${"00".repeat(256)}`,
            status: "0x1",
            to: m.to,
            transactionHash: m.hash,
            transactionIndex: "0x0",
            type: "0x76",
          };
        }
        default:
          throw new Error(`unhandled ${method}`);
      }
    },
  });
}

export function b64url(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface TSeller {
  price: string;
  recipient: string;
  paidStatus: number;
  paidBody: Buffer;
  unpaidReads: number;
  paidRequests: number;
  /** false: the seller takes vet402's credential and never broadcasts it. */
  broadcasts: boolean;
  onRead?: (n: number, s: TSeller) => void;
}
export function tSellerFetch(s: TSeller, fetched: string[], chain: FakeChain) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    fetched.push(url);
    const auth = new Headers(init?.headers).get("authorization");
    if (auth) {
      s.paidRequests++;
      if (s.broadcasts) {
        const c = Credential.deserialize<{ signature: string }>(auth);
        mineTempo(chain, c.payload.signature as Hex);
      }
      return new Response(new Uint8Array(s.paidBody), { status: s.paidStatus, headers: { "content-type": "image/png" } });
    }
    s.unpaidReads++;
    s.onRead?.(s.unpaidReads, s);
    const req = { amount: s.price, currency: USDC_E, recipient: s.recipient, methodDetails: { chainId: TEMPO_MAINNET_CHAIN_ID } };
    return new Response("{}", {
      status: 402,
      headers: { "www-authenticate": `Payment id="sel${s.unpaidReads}", realm="${T_HOST}", method="tempo", intent="charge", request="${b64url(req)}", expires="2099-01-01T00:00:00Z"` },
    });
  };
}

export interface TRig {
  buy: ProxyBuy;
  seller: TSeller;
  chain: FakeChain;
  fetched: string[];
  store: Store;
  sql: Sql;
  side: TempoSide;
  state: { balance: bigint; confirm: "ok" | "timeout"; balanceCalls: number; failBalanceAt: number };
  rpc: ReturnType<typeof fakeTempoRpc>;
  reconcile: (o?: { staleMs?: number }) => Promise<ReconcileAction[]>;
}

export async function tRig(o: { seller?: Partial<TSeller>; caps?: Partial<DayCaps>; enabled?: boolean; tempoEnabled?: boolean; wrapSeller?: (f: typeof fetch) => typeof fetch; sql?: Sql; budgetMs?: number; staleMs?: number } = {}): Promise<TRig> {
  const wrap = (f: (url: string, init?: RequestInit) => Promise<Response>) => (o.wrapSeller ? (o.wrapSeller(f as unknown as typeof fetch) as unknown as typeof f) : f);
  const sql = o.sql ?? (await testSql());
  const store = new Store(sql);
  // a binary answer, to check that it is handed over byte for byte
  const seller: TSeller = { price: "8000", recipient: T_SELLER, paidStatus: 200, paidBody: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]), unpaidReads: 0, paidRequests: 0, broadcasts: true, ...o.seller };
  const chain = newFakeChain();
  const rpc = fakeTempoRpc(chain);
  const fetched: string[] = [];
  const mppx = Mppx.create({
    methods: [mppTempo.charge({ currency: USDC_E, recipient: T_RECEIVE, decimals: 6, getClient: () => createClient({ chain: tempoChain, transport: rpc }), waitForConfirmation: true })],
    secretKey: "s".repeat(40),
    realm: "buy.test",
  });
  const state: TRig["state"] = { balance: 5_000_000n, confirm: "ok", balanceCalls: 0, failBalanceAt: 0 };
  const verifyOnChain = async (tx: string, exp: { payer: string; recipient: string; amount: bigint }) => {
    const hit = chain.sent.find((s) => s.hash === tx.toLowerCase() && s.from === exp.payer.toLowerCase() && s.to === exp.recipient.toLowerCase() && s.amount === exp.amount);
    return hit ? { settled: true, detail: "transfer found", feePaid: "31" } : { settled: false, detail: "receipt not found", feePaid: null };
  };
  const reads: TempoReads = {
    receipt: async (hash) => {
      const s = chain.mined.get(hash.toLowerCase());
      return s ? { status: s } : null;
    },
    headTime: async () => BigInt(nowSec(chain)),
    nonce: async () => 0n,
    memoTransfers: async (exp) =>
      chain.sent.filter((s) => s.from === exp.payer.toLowerCase() && s.to === exp.recipient.toLowerCase() && s.amount === exp.amount && s.memo === exp.memo.toLowerCase()).map((s) => s.hash),
  };
  const side: TempoSide = {
    receive: T_RECEIVE,
    payer: tProxy.address,
    mpp: mppAdapter(mppx as unknown as MppxLike),
    pay: {
      fetchImpl: wrap(tSellerFetch(seller, fetched, chain)),
      signer: signerFor(tProxy, rpc),
      balance: async () => {
        state.balanceCalls++;
        if (state.balanceCalls === state.failBalanceAt) throw new Error("rpc down https://rpc.example.test/KEY");
        return state.balance;
      },
      // the seller payment is looked up by the hash of the credential's transaction, which the seller mined (or not)
      verify: async (tx, exp) => verifyOnChain(tx, exp),
    },
    head: async () => 1n,
    reads,
    confirmCustomer: async (tx, sender, amount) => {
      if (state.confirm === "timeout") return { ok: false, detail: "customer_tx_not_confirmed: receipt not found", definite: false };
      const s = await verifyOnChain(tx, { payer: sender, recipient: T_RECEIVE, amount });
      return s.settled ? { ok: true } : { ok: false, detail: `customer_tx_not_confirmed: ${s.detail}`, definite: false };
    },
    refund: (to, amount, beforeSend) => sendTempoRefund({ account: tProxy, client: createClient({ chain: tempoChain, transport: rpc }), verify: verifyOnChain }, to, amount, beforeSend),
  };
  const buy = createProxyBuy({
    enabled: o.enabled ?? true,
    tempoEnabled: o.tempoEnabled ?? true,
    publicOrigin: ORIGIN,
    feeAtomic: BUY_FEE_ATOMIC,
    allowlist,
    store,
    caps: { tempo: { ...CAPS, ...o.caps } },
    maxRefund: 105_000n,
    quoteDeps: { fetchImpl: wrap(tSellerFetch(seller, fetched, chain)), ownAddresses: [T_RECEIVE, tProxy.address], solanaPayer: null, tempoPayer: tProxy.address },
    tempo: side,
    quotesPerMinute: 1000,
    requestBudgetMs: o.budgetMs ?? 2_000,
    pollMs: 20,
    reconcileGateMs: 0,
    ...(o.staleMs !== undefined ? { staleMs: o.staleMs } : {}),
  });
  const rec = (x: { staleMs?: number } = {}) =>
    reconcile({
      walletCheck: false,
      store,
      feeAtomic: BUY_FEE_ATOMIC,
      now: () => new Date(Date.now() + 3_600_000),
      recordUrl: (id) => `${ORIGIN}/v1/buy/records/${id}`,
      caps: { ...CAPS, ...o.caps },
      maxRefund: 105_000n,
      deadline: Date.now() + 5_000,
      pollMs: 20,
      staleMs: x.staleMs ?? 0,
      tempo: side,
    });
  return { buy, seller, chain, fetched, store, sql, side, state, rpc, reconcile: rec };
}

/** The agent: read the 402, build a pull credential for vet402's challenge with the real mppx client. */
export async function agentPaysTempo(r: TRig, target = T_URL): Promise<string> {
  const res = await r.buy.handle(new Request(buyUrl(target)));
  assert.equal(res.status, 402, await res.clone().text());
  const www = res.headers.get("www-authenticate")!;
  const id = /id="([^"]+)"/.exec(www)![1]!;
  const { credential } = await signerFor(tAgent, r.rpc).credentialFor(res, id, T_RECEIVE);
  return credential;
}
export const tPaid = (cred: string, target = T_URL) => new Request(buyUrl(target), { headers: { authorization: cred } });
