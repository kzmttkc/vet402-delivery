/**
 * Read Keeta settlement from the ledger by the buyer's block hash (not the seller's transaction field).
 */
import KeetaNet from "@keetanetwork/keetanet-client";
import { KEETA_RPC_TIMEOUT_MS } from "./constants.js";

export interface LedgerOperation {
  type: "SEND" | string;
  to?: string;
  amount?: string;
  token?: string;
}

export interface LedgerBlock {
  account: string;
  network?: string;
  hash?: string;
  operations: LedgerOperation[];
}

export interface KeetaLedgerReader {
  getBlock(hash: string): Promise<LedgerBlock | null>;
  onLedger(hash: string): Promise<boolean>;
  destroy(): Promise<void>;
}

export const KEETA_VERIFY_TRIES = 6;
export const KEETA_VERIFY_WAIT_MS = 5000;
const KEETA_MAINNET_NETWORK_HEX = "0x5382";

export function withKeetaTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`keeta_rpc_timeout: ${what} after ${ms}ms`));
    }, ms);
    // Not unref'd: a hung call must still end in this rejection, never in a silent exit with nothing written.
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

type KeetaUserClient = InstanceType<typeof KeetaNet.UserClient>;

function defaultKeetaClient(): KeetaUserClient {
  return KeetaNet.UserClient.fromNetwork("main", null);
}

function ledgerNetworkOk(network: string | undefined): boolean {
  if (network === undefined) return false;
  const n = network.startsWith("0x") || network.startsWith("0X") ? BigInt(network) : BigInt(network);
  return n === 21378n;
}

function normOp(op: { type: number | string; to?: unknown; amount?: string | bigint; token?: unknown }): LedgerOperation {
  const type = op.type === 0 ? "SEND" : String(op.type);
  const to =
    typeof op.to === "object" && op.to && "publicKeyString" in op.to
      ? String((op.to as { publicKeyString: string }).publicKeyString)
      : typeof op.to === "string"
        ? op.to
        : undefined;
  const token =
    typeof op.token === "object" && op.token && "publicKeyString" in op.token
      ? String((op.token as { publicKeyString: string }).publicKeyString)
      : typeof op.token === "string"
        ? op.token
        : undefined;
  return {
    type,
    ...(to ? { to } : {}),
    ...(op.amount !== undefined ? { amount: BigInt(op.amount).toString() } : {}),
    ...(token ? { token } : {}),
  };
}

function normBlock(raw: InstanceType<typeof KeetaNet.lib.Block> | null): LedgerBlock | null {
  if (!raw) return null;
  const j = raw.toJSON() as {
    account?: { publicKeyString?: string } | string;
    network?: string | bigint;
    operations?: { type: number | string; to?: unknown; amount?: string | bigint; token?: unknown }[];
  };
  const account =
    typeof j.account === "object" && j.account && "publicKeyString" in j.account
      ? String(j.account.publicKeyString)
      : String(j.account ?? "");
  const network = j.network !== undefined ? String(j.network) : undefined;
  const operations = (j.operations ?? []).map((o) => normOp(o as { type: number | string; to?: unknown; amount?: string | bigint; token?: unknown }));
  const hash = raw.hash ? raw.hash.toString() : undefined;
  return { account, ...(network ? { network } : {}), ...(hash ? { hash } : {}), operations };
}

export function publicKeetaReader(
  makeClient: () => KeetaUserClient = defaultKeetaClient,
  timeoutMs: number = KEETA_RPC_TIMEOUT_MS,
): KeetaLedgerReader {
  const client = makeClient();
  return {
    async getBlock(hash) {
      const b = await withKeetaTimeout(client.client.getBlock(hash), timeoutMs, "getBlock");
      return normBlock(b);
    },
    async onLedger(hash) {
      const staple = await withKeetaTimeout(client.client.getVoteStaple(hash), timeoutMs, "getVoteStaple");
      return staple !== null;
    },
    async destroy() {
      await withKeetaTimeout(client.destroy(), timeoutMs, "destroy");
    },
  };
}

export interface VerifyInput {
  blockHash: string;
  payer: string;
  payTo: string;
  amount: string;
  asset: string;
}

export type VerifyResult =
  | { settled: true }
  | { settled: false; detail: string }
  | { settled: null; notFound: true; detail: string };

export async function verifyKeetaPayment(
  reader: KeetaLedgerReader,
  input: VerifyInput,
  opts: { tries: number; waitMs: number; sleep: (ms: number) => Promise<void> },
): Promise<VerifyResult> {
  let last: LedgerBlock | null = null;
  for (let i = 0; i < opts.tries; i++) {
    last = await reader.getBlock(input.blockHash);
    if (last) {
      const on = await reader.onLedger(input.blockHash);
      if (!on) {
        if (i + 1 < opts.tries) {
          await opts.sleep(opts.waitMs);
          continue;
        }
        return { settled: null, notFound: true, detail: `block ${input.blockHash} found but not on ledger after ${opts.tries} tries` };
      }
      if (!ledgerNetworkOk(last.network)) {
        return {
          settled: false,
          detail: `network ${last.network ?? "?"} is not Keeta mainnet (${KEETA_MAINNET_NETWORK_HEX})`,
        };
      }
      if (last.account !== input.payer) return { settled: false, detail: `account ${last.account} != payer ${input.payer}` };
      if (last.hash && last.hash.toLowerCase() !== input.blockHash.toLowerCase()) {
        return { settled: false, detail: `block hash ${last.hash} != expected ${input.blockHash}` };
      }
      const sends = last.operations.filter((o) => o.type === "SEND");
      if (sends.length !== 1) return { settled: false, detail: `expected 1 SEND, found ${sends.length}` };
      const s = sends[0]!;
      if (s.to !== input.payTo || s.amount !== input.amount || s.token !== input.asset) {
        return {
          settled: false,
          detail: `SEND to=${s.to ?? "?"} amount=${s.amount ?? "?"} token=${s.token ?? "?"} (expected ${input.payTo} ${input.amount} ${input.asset})`,
        };
      }
      return { settled: true };
    }
    if (i + 1 < opts.tries) await opts.sleep(opts.waitMs);
  }
  return { settled: null, notFound: true, detail: `block ${input.blockHash} not found after ${opts.tries} tries` };
}

export async function readKeetaUsdcBalance(
  payerAddress: string,
  token: string,
  makeClient: () => KeetaUserClient = defaultKeetaClient,
  timeoutMs: number = KEETA_RPC_TIMEOUT_MS,
): Promise<bigint> {
  const client = makeClient();
  try {
    return await withKeetaTimeout(client.client.getBalance(payerAddress, token), timeoutMs, "getBalance");
  } finally {
    await withKeetaTimeout(client.destroy(), timeoutMs, "destroy");
  }
}