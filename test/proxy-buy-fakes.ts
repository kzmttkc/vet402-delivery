/**
 * Shared fakes for the proxy buy tests: generated keys, mock sellers, a fake x402 facilitator and a
 * fake Tempo RPC. No network, no mainnet, no real keys.
 */
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairSignerFromBytes,
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
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactSvmScheme } from "@x402/svm/exact/server";
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
import { makeAllowlist, loadAllowlist } from "../src/proxy-buy/allowlist.js";
import { Books } from "../src/proxy-buy/books.js";
import { BUY_FEE_ATOMIC } from "../src/proxy-buy/constants.js";
import { createProxyBuy, type ProxyBuy } from "../src/proxy-buy/handler.js";
import { resetInit, type SolanaSide } from "../src/proxy-buy/solana.js";
import type { TempoSide } from "../src/proxy-buy/tempo.js";
import { confirmSolanaTransfer, mppAdapter, type MppxLike } from "../src/proxy-buy/wire.js";
import { configFromEnv, describeConfig } from "../src/proxy-buy/config.js";

import assert from "node:assert/strict";

// ---------- wallets (all generated here) ----------
export const agent = await generateKeyPairSigner(); // the customer agent (Solana)
export const proxyPayer = await generateKeyPairSigner(); // vet402's proxy payer (Solana)
export const RECEIVE = (await generateKeyPairSigner()).address; // vet402's proxy receive wallet (Solana)
export const SELLER = (await generateKeyPairSigner()).address;
export const SELLER2 = (await generateKeyPairSigner()).address;
export const SELLER_FAC = (await generateKeyPairSigner()).address; // the seller's facilitator fee payer
export const VET_FAC = (await generateKeyPairSigner()).address; // the facilitator vet402 receives through

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

// ---------- a mock x402 seller on Solana ----------
export interface SolSeller {
  price: bigint;
  payTo: string;
  paidStatus: number;
  paidBody: string;
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
      return new Response(s.paidBody, { status: s.paidStatus, headers: { "content-type": "application/json" } });
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
  fail: "none" | "settle_false" | "settle_throw" = "none";
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
    if (this.fail === "settle_throw") throw new Error("facilitator timeout");
    if (this.fail === "settle_false") return { success: false, errorReason: "blockhash expired", transaction: "", network: r.network } as never;
    const tx = (p.payload as { transaction: string }).transaction;
    return { success: true, transaction: `cust${keccak256(`0x${Buffer.from(tx, "base64").toString("hex")}` as Hex).slice(2, 60)}`, network: r.network, payer: agent.address } as never;
  }
}

export interface SolRig {
  buy: ProxyBuy;
  fac: FakeFacilitator;
  seller: SolSeller;
  fetched: string[];
  sellerPays: { amount: bigint; payTo: string }[];
  books: Books;
  dir: string;
  state: { balance: bigint; confirm: boolean };
}

export function solRig(o: { seller?: Partial<SolSeller>; enabled?: boolean; dailyCap?: bigint; balance?: bigint; wrapSeller?: (f: typeof fetch) => typeof fetch } = {}): SolRig {
  const wrap = o.wrapSeller ?? ((f: typeof fetch) => f);
  resetInit();
  const dir = mkdtempSync(join(tmpdir(), "proxy-buy-sol-"));
  const books = new Books({
    dataDir: dir,
    lock: true,
    solana: { payer: proxyPayer.address, dailyCapAtomic: o.dailyCap ?? 2_000_000n, maxPerCallAtomic: 100_000n, dailyMaxPurchases: 100 },
  });
  const seller = solSeller(o.seller);
  const fetched: string[] = [];
  const fac = new FakeFacilitator();
  const rs = new x402ResourceServer(fac);
  rs.register(SOLANA_MAINNET as `${string}:${string}`, new ExactSvmScheme());
  const sellerPays: { amount: bigint; payTo: string }[] = [];
  const state = { balance: o.balance ?? 5_000_000n, confirm: true };
  let lastPay: { amount: bigint; payTo: string } | null = null;
  const side: SolanaSide = {
    receive: RECEIVE,
    payer: proxyPayer.address,
    resourceServer: rs,
    pay: {
      fetch: wrap(solSellerFetch(seller, fetched)),
      createPayment: async (_pr, accept) => {
        const tx = await transferTx(proxyPayer, String(accept.extra?.feePayer), accept.payTo, BigInt(accept.amount));
        lastPay = { amount: BigInt(accept.amount), payTo: accept.payTo };
        return { headers: { "PAYMENT-SIGNATURE": Buffer.from(JSON.stringify({ x402Version: 2, payload: { transaction: tx } })).toString("base64") }, txBase64: tx };
      },
      checkTx: checkPaymentTransaction,
      readBalances: async () => ({ lamports: 0n, usdcAtomic: state.balance }),
      waitForSettlement: async (_sig, _memo, payTo): Promise<OnChain | null> => {
        const p = lastPay!;
        sellerPays.push(p);
        state.balance -= p.amount;
        return { signature: `sellertx${sellerPays.length}`, found: true, confirmed: true, err: null, memo: null, payToDeltaAtomic: p.amount.toString(), payerDeltaAtomic: `-${p.amount}`, payerLamportsDelta: "0", feePayer: SELLER_FAC, ...(payTo ? {} : {}) };
      },
      ownAddresses: [RECEIVE, proxyPayer.address],
    },
    confirmCustomer: async () => (state.confirm ? { ok: true } : { ok: false, detail: "not confirmed on chain in time" }),
  };
  const buy = createProxyBuy({
    enabled: o.enabled ?? true,
    publicOrigin: ORIGIN,
    feeAtomic: BUY_FEE_ATOMIC,
    allowlist,
    books,
    quoteDeps: { fetchImpl: wrap(solSellerFetch(seller, fetched)), ownAddresses: [RECEIVE, proxyPayer.address], solanaPayer: proxyPayer.address, tempoPayer: null },
    solana: side,
    quotesPerMinute: 1000,
  });
  return { buy, fac, seller, fetched, sellerPays, books, dir, state };
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


export interface FakeChain {
  broadcasts: number;
  sent: { from: string; to: string; amount: bigint }[];
}

/** A Tempo RPC that signs (fills) like the census tests and "mines" a raw tx into a receipt with TIP-20 logs. */
export function fakeTempoRpc(chain: FakeChain) {
  const blockHash = `0x${"11".repeat(32)}`;
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
          return { baseFeePerGas: "0x23c34600", number: "0x1", timestamp: "0x6a", hash: blockHash, transactions: [] };
        case "eth_call":
          return "0x";
        case "eth_sendRawTransactionSync": {
          chain.broadcasts++;
          const raw = (params as [Hex])[0];
          const tx = Transaction.deserialize(raw as never) as unknown as { from: Hex; calls: { to: Hex; data: Hex }[] };
          const hash = keccak256(raw);
          const logs = [];
          let i = 0;
          for (const c of tx.calls) {
            const d = decodeFunctionData({ abi: Abis.tip20, data: c.data });
            const [to, amount, memo] = d.args as [Hex, bigint, Hex | undefined];
            chain.sent.push({ from: tx.from.toLowerCase(), to: to.toLowerCase(), amount });
            const base = { address: c.to, blockHash, blockNumber: "0x1", transactionHash: hash, transactionIndex: "0x0", removed: false };
            logs.push({ ...base, logIndex: `0x${(i++).toString(16)}`, topics: encodeEventTopics({ abi: Abis.tip20, eventName: "Transfer", args: { from: tx.from, to } }), data: encodeAbiParameters([{ type: "uint256" }], [amount]) });
            if (memo) {
              logs.push({ ...base, logIndex: `0x${(i++).toString(16)}`, topics: encodeEventTopics({ abi: Abis.tip20, eventName: "TransferWithMemo", args: { from: tx.from, to, memo } }), data: encodeAbiParameters([{ type: "uint256" }], [amount]) });
            }
          }
          return {
            blockHash,
            blockNumber: "0x1",
            contractAddress: null,
            cumulativeGasUsed: "0xc350",
            effectiveGasPrice: "0x1",
            from: tx.from,
            gasUsed: "0xc350",
            logs,
            logsBloom: `0x${"00".repeat(256)}`,
            status: "0x1",
            to: tx.calls[0]!.to,
            transactionHash: hash,
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
  onRead?: (n: number, s: TSeller) => void;
}
export function tSellerFetch(s: TSeller, fetched: string[]) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    fetched.push(url);
    if (new Headers(init?.headers).get("authorization")) {
      s.paidRequests++;
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
  sellerVerifies: number;
  dir: string;
  state: { balance: bigint; outflow: bigint; confirm: boolean; balanceCalls: number; failBalanceAt: number };
  rpc: ReturnType<typeof fakeTempoRpc>;
}

export function tRig(o: { seller?: Partial<TSeller>; dailyCap?: bigint; enabled?: boolean; wrapSeller?: (f: typeof fetch) => typeof fetch } = {}): TRig {
  const wrap = (f: (url: string, init?: RequestInit) => Promise<Response>) => (o.wrapSeller ? (o.wrapSeller(f as unknown as typeof fetch) as unknown as typeof f) : f);
  const dir = mkdtempSync(join(tmpdir(), "proxy-buy-tempo-"));
  const books = new Books({ dataDir: dir, lock: true, tempo: { payer: tProxy.address, dailyCapAtomic: o.dailyCap ?? 2_000_000n, dailyMaxPurchases: 100 } });
  // a binary answer, to check that it is handed over byte for byte
  const seller: TSeller = { price: "8000", recipient: T_SELLER, paidStatus: 200, paidBody: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]), unpaidReads: 0, paidRequests: 0, ...o.seller };
  const chain: FakeChain = { broadcasts: 0, sent: [] };
  const rpc = fakeTempoRpc(chain);
  const fetched: string[] = [];
  const mppx = Mppx.create({
    methods: [mppTempo.charge({ currency: USDC_E, recipient: T_RECEIVE, decimals: 6, getClient: () => createClient({ chain: tempoChain, transport: rpc }), waitForConfirmation: true })],
    secretKey: "s".repeat(40),
    realm: "buy.test",
  });
  const state = { balance: 5_000_000n, outflow: 0n, confirm: true, balanceCalls: 0, failBalanceAt: 0 };
  const rig: TRig = { buy: null as unknown as ProxyBuy, seller, chain, fetched, sellerVerifies: 0, dir, state, rpc };
  const side: TempoSide = {
    receive: T_RECEIVE,
    payer: tProxy.address,
    mpp: mppAdapter(mppx as unknown as MppxLike),
    pay: {
      fetchImpl: wrap(tSellerFetch(seller, fetched)),
      signer: signerFor(tProxy, rpc),
      balance: async () => {
        state.balanceCalls++;
        if (state.balanceCalls === state.failBalanceAt) throw new Error("rpc down");
        return state.balance;
      },
      verify: async () => {
        rig.sellerVerifies++;
        return { settled: true, detail: "transfer found", feePaid: "30" };
      },
    },
    outflowSince: async () => state.outflow,
    head: async () => 1n,
    confirmCustomer: async (_tx, payer, amount) => {
      if (!state.confirm) return { ok: false, detail: "no matching transfer" };
      const hit = chain.sent.find((s) => s.from === payer?.toLowerCase() && s.to === T_RECEIVE.toLowerCase() && s.amount === amount);
      return hit ? { ok: true } : { ok: false, detail: "no matching transfer" };
    },
  };
  rig.buy = createProxyBuy({
    enabled: o.enabled ?? true,
    publicOrigin: ORIGIN,
    feeAtomic: BUY_FEE_ATOMIC,
    allowlist,
    books,
    quoteDeps: { fetchImpl: wrap(tSellerFetch(seller, fetched)), ownAddresses: [T_RECEIVE, tProxy.address], solanaPayer: null, tempoPayer: tProxy.address },
    tempo: side,
    quotesPerMinute: 1000,
  });
  return rig;
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
