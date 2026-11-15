/**
 * Keeta payment build and key load. The only place a Keeta block is signed.
 */
import { readFileSync, statSync } from "node:fs";
import KeetaNet from "@keetanetwork/keetanet-client";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { ExactKeetaScheme, toClientKeetaSigner } from "@x402/keeta";
import type { ClientKeetaSigner } from "@x402/keeta";
import { PayloadNotCreatedError } from "../guard.js";
import { normalizeKeetaAccept, type KeetaAccept } from "./challenge.js";
import { KEETA_CAIP2, KEETA_MAX_PER_PURCHASE_ATOMIC, KEETA_RPC_TIMEOUT_MS, KEETA_USDC } from "./constants.js";
import { withKeetaTimeout } from "./ledger.js";

const KEETA_MAINNET_NETWORK = 21378n;

export class KeetaSignTimeoutError extends Error {
  override name = "KeetaSignTimeoutError";
  constructor(what: string, ms: number) {
    super(`keeta_sign_timeout: ${what} after ${ms}ms`);
  }
}

function keetaPkTimeout(e: unknown, what: string, ms: number): never {
  if (e instanceof Error && e.message.startsWith("keeta_rpc_timeout:")) {
    throw new KeetaSignTimeoutError(what, ms);
  }
  throw e;
}

function keetaPkString(v: unknown): string {
  if (typeof v === "object" && v && "publicKeyString" in v) {
    const pk = (v as { publicKeyString: { toString(): string } }).publicKeyString;
    return pk.toString();
  }
  return String(v ?? "");
}

function sameKeetaAccept(raw: Record<string, unknown>, a: KeetaAccept): boolean {
  const n = normalizeKeetaAccept(raw);
  return n.scheme === a.scheme && n.network === a.network && n.asset === a.asset && n.payTo === a.payTo && n.amount === a.amount &&
    n.extra?.external === a.extra?.external;
}

export function fenceKeetaSigner(
  inner: ClientKeetaSigner,
  lock: { payTo: string; amount: string; asset: string; network: string; maxAtomic: bigint },
  signTimeoutMs: number = KEETA_RPC_TIMEOUT_MS,
): ClientKeetaSigner {
  return {
    async computePaymentBlock(network, recipient, amount, token, external) {
      const recipientStr = keetaPkString(recipient);
      const tokenStr = keetaPkString(token);
      if (network !== lock.network) throw new Error(`network ${network} != locked ${lock.network}`);
      if (recipientStr !== lock.payTo) throw new Error(`recipient ${recipientStr} != locked ${lock.payTo}`);
      if (tokenStr !== lock.asset) throw new Error(`token ${tokenStr} != locked ${lock.asset}`);
      const want = BigInt(lock.amount);
      if (amount !== want) throw new Error(`amount ${amount} != locked ${want}`);
      if (amount > lock.maxAtomic) throw new Error(`amount ${amount} > cap ${lock.maxAtomic}`);
      try {
        return await withKeetaTimeout(
          inner.computePaymentBlock(network, recipient, amount, token, external),
          signTimeoutMs,
          "computePaymentBlock",
        );
      } catch (e) {
        keetaPkTimeout(e, "computePaymentBlock", signTimeoutMs);
      }
    },
    destroy: () => inner.destroy(),
    [Symbol.asyncDispose]: () => inner[Symbol.asyncDispose](),
  };
}

export async function loadKeetaAccount(file: string, expectedAddress: string): Promise<InstanceType<typeof KeetaNet.lib.Account>> {
  const mode = statSync(file).mode & 0o777;
  if ((mode & 0o777) !== 0o600) throw new Error(`key file must be mode 600 (is ${mode.toString(8)})`);
  let parsed: { seed?: string; index?: number };
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as { seed?: string; index?: number };
  } catch {
    throw new Error("key file is not valid JSON");
  }
  if (typeof parsed.seed !== "string" || !/^[0-9a-fA-F]+$/.test(parsed.seed)) throw new Error("key file has no hex seed");
  const index = parsed.index ?? 0;
  if (!Number.isInteger(index) || index < 0) throw new Error("key file has bad index");
  const account = KeetaNet.lib.Account.fromSeed(parsed.seed, index);
  if (account.publicKeyString.toString() !== expectedAddress) {
    throw new Error(`key address does not match keeta-payer.pub`);
  }
  return account;
}

function blockNetworkId(block: InstanceType<typeof KeetaNet.lib.Block>): bigint {
  const j = block.toJSON() as { network?: string | number | bigint };
  const n = j.network;
  if (n === undefined) return 0n;
  if (typeof n === "bigint") return n;
  if (typeof n === "string" && n.startsWith("0x")) return BigInt(n);
  return BigInt(n);
}

export function makeKeetaCreatePayment(
  signer: ClientKeetaSigner,
  payerAddress: string,
  maxAtomic: bigint = KEETA_MAX_PER_PURCHASE_ATOMIC,
  signTimeoutMs: number = KEETA_RPC_TIMEOUT_MS,
): (pr: PaymentRequired, accept: KeetaAccept) => Promise<{ headers: Record<string, string>; blockHash: string; blockBase64: string }> {
  return async (pr, accept) => {
    const lock = {
      payTo: accept.payTo,
      amount: accept.amount,
      asset: accept.asset,
      network: accept.network,
      maxAtomic,
    };
    const wrapped = fenceKeetaSigner(signer, lock, signTimeoutMs);
    const client = new x402Client((_v, reqs) => {
      const hit = (reqs as unknown as Record<string, unknown>[]).find((r) => sameKeetaAccept(r, accept));
      if (!hit) throw new Error("locked accept not offered to the selector");
      return hit as never;
    });
    client.setSpendControls({
      allowedAssets: [{ network: KEETA_CAIP2, asset: KEETA_USDC, maxAmountPerPayment: maxAtomic.toString() }],
    });
    client.register(KEETA_CAIP2 as never, new ExactKeetaScheme(wrapped));
    const http = new x402HTTPClient(client);
    let payload: Awaited<ReturnType<typeof http.createPaymentPayload>>;
    try {
      payload = await withKeetaTimeout(http.createPaymentPayload(pr), signTimeoutMs, "sign payment block");
    } catch (e) {
      if (e instanceof KeetaSignTimeoutError) throw e;
      if (e instanceof Error && e.message.startsWith("keeta_rpc_timeout:")) {
        throw new KeetaSignTimeoutError("sign payment block", signTimeoutMs);
      }
      throw new PayloadNotCreatedError((e as Error).message);
    }
    const blockB64 = (payload.payload as { block?: string }).block;
    if (typeof blockB64 !== "string") throw new Error("payload has no block");
    const accepted = (payload as { accepted?: Record<string, unknown> }).accepted;
    if (accepted && !sameKeetaAccept(accepted, accept)) throw new Error("payload.accepted differs from the locked accept");
    const block = new KeetaNet.lib.Block(Buffer.from(blockB64, "base64"));
    if (blockNetworkId(block) !== KEETA_MAINNET_NETWORK) {
      throw new Error(`block network is not mainnet (${KEETA_MAINNET_NETWORK})`);
    }
    const acct = block.account ? keetaPkString(block.account) : "";
    if (acct !== payerAddress) throw new Error(`block account ${acct || "?"} != payer ${payerAddress}`);
    const ops = block.toJSON().operations as { type: number | string; to?: string | { publicKeyString?: string }; amount?: string | bigint; token?: string | { publicKeyString?: string } }[];
    if (ops.length !== 1) throw new Error(`block has ${ops.length} operations (expected 1)`);
    const op = ops[0]!;
    const send = op.type === 0 || op.type === "SEND";
    if (!send) throw new Error(`operation type ${op.type} (expected SEND)`);
    const to =
      typeof op.to === "object" && op.to && "publicKeyString" in op.to ? keetaPkString(op.to) : String(op.to ?? "");
    const token =
      typeof op.token === "object" && op.token && "publicKeyString" in op.token
        ? keetaPkString(op.token)
        : String(op.token ?? "");
    const amt = BigInt(op.amount ?? 0);
    if (to !== accept.payTo || token !== accept.asset || amt !== BigInt(accept.amount)) {
      throw new Error("block SEND does not match the locked accept");
    }
    const wantExt = typeof accept.extra?.external === "string" ? accept.extra.external : undefined;
    const gotExt = typeof (op as { external?: string }).external === "string" ? (op as { external?: string }).external : undefined;
    if (wantExt !== gotExt) throw new Error("block SEND external does not match the locked accept");
    const blockHash = block.hash.toString();
    return { headers: http.encodePaymentSignatureHeader(payload), blockHash, blockBase64: blockB64 };
  };
}

export function accountToSigner(account: InstanceType<typeof KeetaNet.lib.Account>): ClientKeetaSigner {
  return toClientKeetaSigner(account);
}