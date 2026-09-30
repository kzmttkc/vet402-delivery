/**
 * Builds the production sides from a ProxyConfig: the x402 resource server (facilitator, exact SVM),
 * the mppx server (tempo/charge), the proxy payers' signers, and the chain reads. Nothing here runs at
 * import time; nothing is signed or sent until a paid request reaches src/proxy-buy/solana.ts or tempo.ts.
 */
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { Mppx, tempo as mppTempo } from "mppx/server";
import { createClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempo as tempoChain } from "viem/chains";
import { jsonRpc, readBalances, readTransaction, waitForSettlement, type Rpc } from "../chain.js";
import { makeCreatePayment } from "../client.js";
import { PAYER_ADDRESS as SOLANA_CENSUS_PAYER, SOLANA_MAINNET } from "../constants.js";
import { checkPaymentTransaction, usdcAta } from "../txcheck.js";
import { findPayerTransfers, headBlock, payerTransfers, signerFor, usdcBalance, verifySettlement } from "../tempo/chain.js";
import { PAYER_ADDRESS as TEMPO_CENSUS_PAYER, USDC_E } from "../tempo/constants.js";
import type { SolanaConfig, TempoConfig } from "./config.js";
import { CUSTOMER_CONFIRM_TIMEOUT_MS } from "./constants.js";
import type { SolanaSide } from "./solana.js";
import type { MppServer, TempoSide } from "./tempo.js";

/** Every address proxy buy must never pay: its own wallets and the census payers. */
export function ownAddresses(sol: SolanaConfig | null, tem: TempoConfig | null): string[] {
  return [SOLANA_CENSUS_PAYER, TEMPO_CENSUS_PAYER, ...(sol ? [sol.receive, sol.payer] : []), ...(tem ? [tem.receive, tem.payer] : [])];
}

/** Poll the agent's Solana transfer until it is confirmed with exactly `amount` into `receive`, or time out. */
export async function confirmSolanaTransfer(
  rpc: Rpc,
  tx: string,
  payer: string | null,
  receive: string,
  amount: bigint,
  o: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ ok: true } | { ok: false; detail: string }> {
  if (!payer) return { ok: false, detail: "the facilitator did not name the payer" };
  const deadline = Date.now() + (o.timeoutMs ?? CUSTOMER_CONFIRM_TIMEOUT_MS);
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let last = "not found";
  for (;;) {
    try {
      const r = await readTransaction(rpc, tx, payer, receive);
      if (r.found) {
        if (r.err !== null) return { ok: false, detail: `the agent's transaction failed on chain: ${JSON.stringify(r.err)}`.slice(0, 200) };
        if (r.payToDeltaAtomic !== amount.toString()) return { ok: false, detail: `receive wallet got ${r.payToDeltaAtomic}, expected ${amount}` };
        return { ok: true };
      }
    } catch (e) {
      last = (e as Error).message;
    }
    if (Date.now() >= deadline) return { ok: false, detail: `not confirmed on chain in time (${last})`.slice(0, 200) };
    await sleep(o.intervalMs ?? 2_000);
  }
}

export async function solanaSide(c: SolanaConfig, own: string[]): Promise<SolanaSide> {
  const signer = await createKeyPairSignerFromBytes(c.payerKey);
  if (signer.address !== c.payer) throw new Error("VET402_PROXY_SOLANA_PAYER_KEY does not belong to VET402_PROXY_SOLANA_PAYER");
  const rpc = jsonRpc(c.rpcUrl);
  const payerAta = await usdcAta(c.payer);
  const rs = new x402ResourceServer(new HTTPFacilitatorClient({ url: c.facilitatorUrl }));
  rs.register(SOLANA_MAINNET as `${string}:${string}`, new ExactSvmScheme());
  return {
    receive: c.receive,
    payer: c.payer,
    resourceServer: rs,
    pay: {
      fetch,
      createPayment: makeCreatePayment(signer, c.rpcUrl),
      checkTx: checkPaymentTransaction,
      readBalances: () => readBalances(rpc, c.payer),
      waitForSettlement: (sig, memo, payTo) => waitForSettlement({ rpc, signature: sig, memo, payer: c.payer, payerUsdcAta: payerAta, payTo }),
      ownAddresses: own,
    },
    confirmCustomer: (tx, payer, amount) => confirmSolanaTransfer(rpc, tx, payer, c.receive, amount),
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

export function tempoSide(c: TempoConfig, realm: string): TempoSide {
  const account = privateKeyToAccount(c.payerKey);
  if (account.address.toLowerCase() !== c.payer.toLowerCase()) throw new Error("VET402_PROXY_TEMPO_PAYER_KEY does not belong to VET402_PROXY_TEMPO_PAYER");
  const transport = http(c.rpcUrl, { timeout: 15_000, retryCount: 1 });
  const outflowSince = async (from: bigint) => {
    const head = await headBlock(c.rpcUrl);
    if (head < from) return 0n;
    return (await payerTransfers(c.payer, from, head, c.rpcUrl)).reduce((s, t) => s + t.amount, 0n);
  };
  return {
    receive: c.receive,
    payer: c.payer,
    mpp: mppServer(c, realm),
    pay: {
      fetchImpl: fetch,
      signer: signerFor(account, transport),
      balance: () => usdcBalance(c.payer, c.rpcUrl),
      verify: (tx, exp) => verifySettlement(tx, exp, c.rpcUrl),
      findTx: { head: () => headBlock(c.rpcUrl), search: (exp, from) => findPayerTransfers(exp, from, c.rpcUrl) },
    },
    outflowSince,
    head: () => headBlock(c.rpcUrl),
    confirmCustomer: async (tx, payer, amount) => {
      if (!payer) return { ok: false, detail: "mppx did not name the sender" };
      const s = await verifySettlement(tx, { payer, recipient: c.receive, amount }, c.rpcUrl);
      return s.settled ? { ok: true } : { ok: false, detail: s.detail };
    },
  };
}
