/**
 * Builds the production pieces from a ProxyConfig: the x402 resource server (facilitator, exact SVM), the mppx
 * server (tempo/charge), the proxy payers' signers, the chain reads, the refund senders, and the database.
 * Nothing here runs at import time; nothing is signed or sent until a paid request reaches solana.ts / tempo.ts.
 */
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { Mppx, tempo as mppTempo } from "mppx/server";
import pg from "pg";
import { createClient, createPublicClient, http, parseAbiItem, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempo as tempoChain } from "viem/chains";
import { jsonRpc, readBalances, waitForSettlement, type Rpc } from "../chain.js";
import { makeCreatePayment } from "../client.js";
import { PAYER_ADDRESS as SOLANA_CENSUS_PAYER, SOLANA_MAINNET, USDC_MINT } from "../constants.js";
import { checkPaymentTransaction, usdcAta } from "../txcheck.js";
import { headBlock, signerFor, usdcBalance, verifySettlement } from "../tempo/chain.js";
import { PAYER_ADDRESS as TEMPO_CENSUS_PAYER, USDC_E } from "../tempo/constants.js";
import { loadAllowlist, type Allowlist } from "./allowlist.js";
import type { ProxyConfig, SolanaConfig, TempoConfig } from "./config.js";
import { CUSTOMER_CONFIRM_TIMEOUT_MS } from "./constants.js";
import { migrate, pgSql, type Sql } from "./db.js";
import { MAX_TX_VERSION, rawMessageHash, solanaTxFate, type TempoReads } from "./fate.js";
import { createProxyBuy, type ProxyBuy } from "./handler.js";
import { sendSolanaRefund, sendTempoRefund } from "./refund.js";
import type { SolanaSide } from "./solana.js";
import { Store, type DayCaps } from "./store.js";
import type { MppServer, TempoSide } from "./tempo.js";

/** Every address proxy buy must never pay: its own wallets and the census payers. */
export function ownAddresses(sol: SolanaConfig | null, tem: TempoConfig | null): string[] {
  return [SOLANA_CENSUS_PAYER, TEMPO_CENSUS_PAYER, ...(sol ? [sol.receive, sol.payer] : []), ...(tem ? [tem.receive, tem.payer] : [])];
}

/**
 * The agent's Solana transfer, read on chain until it is confirmed or time runs out. It must be the transaction the
 * agent signed (`messageHash`, the sha256 of its message): another one named by the facilitator is not taken (not
 * definite: the agent's own transaction is then found by its message). The agent is charged when
 * the transaction succeeded and vet402's receive wallet went up by exactly `amount`. The refund address is the
 * owner of the account that went down by exactly `amount` (the source account's owner: with a delegate as the
 * signing authority, the delegate's balance does not move, the owner's does); when no single owner went down by
 * exactly that, the signing authority.
 * Fixed reason codes only: an RPC error message can carry the RPC URL.
 */
export async function confirmSolanaTransfer(
  rpc: Rpc,
  tx: string,
  authority: string,
  receive: string,
  amount: bigint,
  o: { messageHash?: string; timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ ok: true; payer: string } | { ok: false; detail: string; definite: boolean }> {
  const deadline = Date.now() + (o.timeoutMs ?? CUSTOMER_CONFIRM_TIMEOUT_MS);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  type Bal = { owner?: string; mint: string; uiTokenAmount: { amount: string } };
  for (;;) {
    try {
      const t = (await rpc("getTransaction", [tx, { encoding: "base64", commitment: "confirmed", maxSupportedTransactionVersion: MAX_TX_VERSION }])) as {
        meta: { err: unknown; preTokenBalances?: Bal[]; postTokenBalances?: Bal[] } | null;
        transaction?: [string, string];
      } | null;
      if (t && t.meta) {
        if (o.messageHash !== undefined) {
          const h = t.transaction ? rawMessageHash(t.transaction[0]) : null;
          if (h !== o.messageHash) return { ok: false, detail: "customer_tx_not_the_signed_payment", definite: false };
        }
        if (t.meta.err !== null && t.meta.err !== undefined) return { ok: false, detail: "customer_tx_failed_on_chain", definite: true };
        const delta = new Map<string, bigint>();
        for (const [list, sign] of [[t.meta.preTokenBalances ?? [], -1n], [t.meta.postTokenBalances ?? [], 1n]] as const) {
          for (const b of list) {
            if (b.mint !== USDC_MINT || !b.owner) continue;
            delta.set(b.owner, (delta.get(b.owner) ?? 0n) + sign * BigInt(b.uiTokenAmount.amount));
          }
        }
        const got = delta.get(receive) ?? 0n;
        if (got !== amount) return { ok: false, detail: `customer_amount_mismatch: receive wallet got ${got}, expected ${amount}`, definite: true };
        const sources = [...delta.entries()].filter(([owner, d]) => owner !== receive && d === -amount).map(([owner]) => owner);
        return { ok: true, payer: sources.length === 1 ? sources[0]! : authority };
      }
    } catch {
      /* keep polling */
    }
    if (Date.now() >= deadline) return { ok: false, detail: "customer_tx_not_confirmed_in_time", definite: false };
    await sleep(o.intervalMs ?? 2_000);
  }
}

/** One refund at a time per wallet (the Tempo nonce, the balance read). */
class Serial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(f: () => Promise<T>): Promise<T> {
    const next = this.tail.then(f, f);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export async function solanaSide(c: SolanaConfig, own: string[]): Promise<SolanaSide> {
  const signer = await createKeyPairSignerFromBytes(c.payerKey);
  if (signer.address !== c.payer) throw new Error("VET402_PROXY_SOLANA_PAYER_KEY does not belong to VET402_PROXY_SOLANA_PAYER");
  const rpc = jsonRpc(c.rpcUrl);
  const payerAta = await usdcAta(c.payer);
  const receiveAta = await usdcAta(c.receive);
  const rs = new x402ResourceServer(new HTTPFacilitatorClient({ url: c.facilitatorUrl }));
  rs.register(SOLANA_MAINNET as `${string}:${string}`, new ExactSvmScheme());
  const serial = new Serial();
  return {
    receive: c.receive,
    receiveAta,
    payer: c.payer,
    payerAta,
    resourceServer: rs,
    pay: {
      fetch,
      createPayment: makeCreatePayment(signer, c.rpcUrl),
      checkTx: checkPaymentTransaction,
      readBalances: () => readBalances(rpc, c.payer),
      // Short: an unsettled payment goes to fate.ts, which waits for proof either way.
      waitForSettlement: (sig, memo, payTo) => waitForSettlement({ rpc, signature: sig, memo, payer: c.payer, payerUsdcAta: payerAta, payTo, timeoutMs: 25_000 }),
      ownAddresses: own,
    },
    confirmCustomer: (tx, authority, amount, messageHash) => confirmSolanaTransfer(rpc, tx, authority, c.receive, amount, { messageHash }),
    fate: (f) => solanaTxFate(rpc, f),
    slot: async () => Number(await rpc("getSlot", [{ commitment: "confirmed" }])),
    heightBound: async () => {
      const r = (await rpc("getLatestBlockhash", [{ commitment: "processed" }])) as { value: { blockhash: string; lastValidBlockHeight: number | string } };
      const h = Number(r.value.lastValidBlockHeight);
      if (!Number.isSafeInteger(h)) throw new Error("no last valid block height");
      return { blockhash: r.value.blockhash, lastValidBlockHeight: h };
    },
    refund: (to, amount, beforeSend, opts) => serial.run(() => sendSolanaRefund({ rpc, signer }, to, amount, beforeSend, opts)),
  };
}

/** The mppx server behind the MppServer interface. */
export function mppServer(c: TempoConfig, realm: string): MppServer {
  const transport = http(c.rpcUrl, { timeout: 15_000, retryCount: 1 });
  const mppx = Mppx.create({
    methods: [
      mppTempo.charge({
        currency: USDC_E,
        recipient: c.receive as `0x${string}`,
        decimals: 6,
        getClient: () => createClient({ chain: tempoChain, transport }),
        waitForConfirmation: true,
      }),
    ],
    secretKey: c.mppSecret,
    realm,
  });
  return mppAdapter(mppx as unknown as MppxLike);
}

/** The part of an mppx instance used here (typed loosely: mppx's own types are generic over methods). */
export interface MppxLike {
  charge: (o: { amount: string; externalId: string; expires: string }) => (req: Request) => Promise<{ status: number; challenge?: Response }>;
  validateCredential: (c: string, o: { request: Record<string, unknown> }) => Promise<{ details?: unknown }>;
  broadcastCredential: (c: string, o: { request: Record<string, unknown> }) => Promise<{ reference: string; status: string }>;
}

export function mppAdapter(mppx: MppxLike): MppServer {
  return {
    async challenge(request, route) {
      // Only called for a request without a credential, so mppx answers with a challenge and verifies nothing.
      const r = await mppx.charge(route)(new Request(request.url, { method: "GET" }));
      if (r.status === 402 && r.challenge) return r.challenge;
      return new Response(null, { status: 500 });
    },
    validateCredential: (cred, o) => mppx.validateCredential(cred, o),
    broadcastCredential: (cred, o) => mppx.broadcastCredential(cred, o),
  };
}

const TRANSFER_WITH_MEMO = parseAbiItem("event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo)");
const MEMO_LOG_RANGE = 99_999n;

/** Tempo chain reads over viem (fate.ts TempoReads). */
export function tempoReads(rpcUrl: string, client = createPublicClient({ chain: tempoChain, transport: http(rpcUrl, { timeout: 15_000, retryCount: 1 }) })): TempoReads {
  return {
    async receipt(hash) {
      // Only "no such receipt" is an answer; any other error (a 503, a timeout) is thrown, and fate.ts reads it as pending.
      const r = await client.getTransactionReceipt({ hash: hash as Hex }).catch((e: unknown) => {
        if ((e as { name?: string })?.name === "TransactionReceiptNotFoundError") return null;
        throw e;
      });
      return r ? { status: r.status === "success" ? "success" : "reverted" } : null;
    },
    async headTime() {
      return (await client.getBlock()).timestamp;
    },
    async nonce(address) {
      return BigInt(await client.getTransactionCount({ address: address as Hex, blockTag: "latest" }));
    },
    async memoTransfers(exp, from) {
      const head = await client.getBlockNumber();
      const out: string[] = [];
      for (let a = from; a <= head; a += MEMO_LOG_RANGE + 1n) {
        const b = a + MEMO_LOG_RANGE > head ? head : a + MEMO_LOG_RANGE;
        const logs = await client.getLogs({ address: USDC_E as Hex, event: TRANSFER_WITH_MEMO, args: { from: exp.payer as Hex, to: exp.recipient as Hex, memo: exp.memo as Hex }, fromBlock: a, toBlock: b });
        for (const l of logs) if (l.args.amount === exp.amount) out.push(l.transactionHash.toLowerCase());
      }
      return out;
    },
  };
}

/** The agent's Tempo transfer: "receipt not found" can still change; a reverted or different transfer cannot. */
export async function confirmTempoTransfer(verify: typeof verifySettlement, rpcUrl: string, tx: string, sender: string, receive: string, amount: bigint) {
  const s = await verify(tx, { payer: sender, recipient: receive, amount }, rpcUrl);
  if (s.settled) return { ok: true as const };
  return { ok: false as const, detail: `customer_tx_not_confirmed: ${s.detail}`, definite: s.detail !== "receipt not found" && s.detail !== "no tx hash" };
}

export function tempoSide(c: TempoConfig, realm: string): TempoSide {
  const account = privateKeyToAccount(c.payerKey);
  if (account.address.toLowerCase() !== c.payer.toLowerCase()) throw new Error("VET402_PROXY_TEMPO_PAYER_KEY does not belong to VET402_PROXY_TEMPO_PAYER");
  const transport = http(c.rpcUrl, { timeout: 15_000, retryCount: 1 });
  const serial = new Serial();
  return {
    receive: c.receive,
    payer: c.payer,
    mpp: mppServer(c, realm),
    pay: {
      fetchImpl: fetch,
      signer: signerFor(account, transport),
      balance: () => usdcBalance(c.payer, c.rpcUrl),
      verify: (tx, exp) => verifySettlement(tx, exp, c.rpcUrl),
      // No transfer search here: whether the seller was paid is read from vet402's own payment (tempo.ts).
    },
    head: () => headBlock(c.rpcUrl),
    reads: tempoReads(c.rpcUrl),
    confirmCustomer: (tx, sender, amount) => confirmTempoTransfer(verifySettlement, c.rpcUrl, tx, sender, c.receive, amount),
    refund: (to, amount, beforeSend) =>
      serial.run(() =>
        sendTempoRefund({ account, client: createClient({ chain: tempoChain, transport }), verify: (tx, exp) => verifySettlement(tx, exp, c.rpcUrl) }, to, amount, beforeSend),
      ),
  };
}

/** Postgres over node-postgres (Neon's pooled connection string). Small pool: a serverless instance needs few. */
export function openDatabase(url: string): Sql {
  return pgSql(new pg.Pool({ connectionString: url, max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 10_000 }));
}

export function dayCaps(c: ProxyConfig, chain: "solana" | "tempo"): DayCaps | undefined {
  const x = chain === "solana" ? c.solana : c.tempo;
  return x ? { cap: x.dailyCapAtomic, maxCount: c.dailyMaxPurchases, refundCap: x.dailyRefundCapAtomic } : undefined;
}

/** Everything the HTTP entry points need, from the environment's config. Creates the tables if they are missing. */
export async function buildProxyBuy(cfg: ProxyConfig, o: { dataDir: string; sql?: Sql; allowlist?: Allowlist }): Promise<{ buy: ProxyBuy; store: Store; solana?: SolanaSide; tempo?: TempoSide }> {
  if (!cfg.databaseUrl && !o.sql) throw new Error("DATABASE_URL is not set");
  const sql = o.sql ?? openDatabase(cfg.databaseUrl!);
  await migrate(sql);
  const store = new Store(sql);
  const own = ownAddresses(cfg.solana, cfg.tempo);
  const realm = new URL(cfg.publicOrigin).host;
  const solana = cfg.solana ? await solanaSide(cfg.solana, own) : undefined;
  // Tempo off (the default): nothing Tempo is built, so neither requests nor the reconciler touch it.
  const tempo = cfg.tempo && cfg.tempoEnabled ? tempoSide(cfg.tempo, realm) : undefined;
  const sCaps = dayCaps(cfg, "solana");
  const tCaps = tempo ? dayCaps(cfg, "tempo") : undefined;
  const buy = createProxyBuy({
    enabled: cfg.enabled,
    tempoEnabled: cfg.tempoEnabled,
    publicOrigin: cfg.publicOrigin,
    feeAtomic: cfg.feeAtomic,
    allowlist: o.allowlist ?? loadAllowlist(o.dataDir),
    store,
    caps: { ...(sCaps ? { solana: sCaps } : {}), ...(tCaps ? { tempo: tCaps } : {}) },
    maxRefund: cfg.maxPerCallAtomic + cfg.feeAtomic,
    quoteDeps: { fetchImpl: fetch, ownAddresses: own, solanaPayer: cfg.solana?.payer ?? null, tempoPayer: tempo ? cfg.tempo!.payer : null },
    ...(solana ? { solana } : {}),
    ...(tempo ? { tempo } : {}),
  });
  return { buy, store, ...(solana ? { solana } : {}), ...(tempo ? { tempo } : {}) };
}
