/**
 * Tempo mainnet reads (balance, outflow, settlement) and the signer. Network only; no policy.
 */
import { readFileSync } from "node:fs";
import { createClient, createPublicClient, http, parseAbiItem, type Hex, type LocalAccount, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { tempo as tempoChain } from "viem/chains";
import { Challenge, Credential } from "mppx";
import { tempo } from "mppx/client";
import { PAYER_ADDRESS, TEMPO_MAINNET_CHAIN_ID, TEMPO_RPC_URL, USDC_E, normAddr } from "./constants.js";

/** First block of the census (2026-09-28). Every USDC.e outflow of the payer after it is counted. */
export const CENSUS_START_BLOCK = 41_600_000n;
const LOG_RANGE = 99_999n;
const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 amount)");

export function publicClient(rpc = TEMPO_RPC_URL) {
  return createPublicClient({ chain: tempoChain, transport: http(rpc, { timeout: 15_000, retryCount: 1 }) });
}

export async function assertMainnet(rpc = TEMPO_RPC_URL): Promise<void> {
  const id = await publicClient(rpc).getChainId();
  if (id !== TEMPO_MAINNET_CHAIN_ID) throw new Error(`RPC ${rpc} is chain ${id}, not Tempo mainnet 4217`);
}

export async function usdcBalance(owner: string, rpc = TEMPO_RPC_URL): Promise<bigint> {
  const c = publicClient(rpc);
  return c.readContract({
    address: USDC_E as Hex,
    abi: [parseAbiItem("function balanceOf(address) view returns (uint256)")],
    functionName: "balanceOf",
    args: [owner as Hex],
  });
}

/** Sum of USDC.e the owner sent since CENSUS_START_BLOCK, read from Transfer logs. */
export async function usdcOutflowSinceStart(owner: string, rpc = TEMPO_RPC_URL): Promise<bigint> {
  const c = publicClient(rpc);
  const head = await c.getBlockNumber();
  let sum = 0n;
  for (let from = CENSUS_START_BLOCK; from <= head; from += LOG_RANGE + 1n) {
    const to = from + LOG_RANGE > head ? head : from + LOG_RANGE;
    const logs = await c.getLogs({ address: USDC_E as Hex, event: TRANSFER, args: { from: owner as Hex }, fromBlock: from, toBlock: to });
    for (const l of logs) sum += l.args.amount ?? 0n;
  }
  return sum;
}

/** One USDC.e Transfer out of the owner. */
export interface PayerTransfer {
  tx: string;
  block: bigint;
  to: string;
  amount: bigint;
}

/** Every USDC.e Transfer from `owner` in blocks [fromBlock, toBlock], read from the logs. */
export async function payerTransfers(owner: string, fromBlock: bigint, toBlock: bigint, rpc = TEMPO_RPC_URL): Promise<PayerTransfer[]> {
  const c = publicClient(rpc);
  const out: PayerTransfer[] = [];
  for (let from = fromBlock; from <= toBlock; from += LOG_RANGE + 1n) {
    const to = from + LOG_RANGE > toBlock ? toBlock : from + LOG_RANGE;
    const logs = await c.getLogs({ address: USDC_E as Hex, event: TRANSFER, args: { from: owner as Hex }, fromBlock: from, toBlock: to });
    for (const l of logs) out.push({ tx: l.transactionHash, block: l.blockNumber, to: normAddr(l.args.to), amount: l.args.amount ?? 0n });
  }
  return out;
}

export async function headBlock(rpc = TEMPO_RPC_URL): Promise<bigint> {
  return publicClient(rpc).getBlockNumber();
}

/**
 * Tx hashes, from `fromBlock` to the head, with a USDC.e Transfer payer -> recipient of exactly `amount`.
 * payOne reads this when the paid response gave no hash it could find on chain (a sponsored fee changes
 * the envelope, so the signed tx's hash is not the one broadcast).
 */
export async function findPayerTransfers(exp: { payer: string; recipient: string; amount: bigint }, fromBlock: bigint, rpc = TEMPO_RPC_URL): Promise<string[]> {
  const head = await headBlock(rpc);
  const all = await payerTransfers(exp.payer, fromBlock, head, rpc);
  return [...new Set(all.filter((t) => t.to === normAddr(exp.recipient) && t.amount === exp.amount).map((t) => t.tx.toLowerCase()))];
}

export interface SettlementCheck {
  settled: boolean;
  detail: string;
  /** USDC.e (atomic) the payer paid as fee, when it paid one. */
  feePaid: string | null;
}

/** Re-read the transaction: success, and a USDC.e Transfer payer -> recipient of exactly `amount`. */
export async function verifySettlement(
  txHash: string,
  exp: { payer: string; recipient: string; amount: bigint },
  rpc = TEMPO_RPC_URL,
): Promise<SettlementCheck> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { settled: false, detail: "no tx hash", feePaid: null };
  const c = publicClient(rpc);
  const r = await c.getTransactionReceipt({ hash: txHash as Hex }).catch(() => null);
  if (!r) return { settled: false, detail: "receipt not found", feePaid: null };
  if (r.status !== "success") return { settled: false, detail: `status ${r.status}`, feePaid: null };
  let paid = false;
  let fee = 0n;
  for (const l of r.logs) {
    if (normAddr(l.address) !== USDC_E || l.topics[0] !== "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef") continue;
    const from = normAddr(`0x${(l.topics[1] ?? "").slice(26)}`);
    const to = normAddr(`0x${(l.topics[2] ?? "").slice(26)}`);
    const amt = BigInt(l.data);
    if (from === normAddr(exp.payer) && to === normAddr(exp.recipient) && amt === exp.amount) paid = true;
    else if (from === normAddr(exp.payer)) fee += amt; // fee transfer to the fee manager
  }
  return { settled: paid, detail: paid ? "transfer found" : "no matching transfer", feePaid: fee > 0n ? fee.toString() : null };
}

export interface Signer {
  address: string;
  /**
   * Build a pull-mode credential for the challenge with id `challengeId` in `res`.
   * Returns the credential header value and the signed transaction inside it.
   */
  credentialFor(res: Response, challengeId: string, recipient: string): Promise<{ credential: string; serializedTx: string }>;
}

/** Load the payer key from a JSON file `{ "privateKey": "0x..." }`. The key is never printed. */
export function loadSigner(keyFile: string, rpc = TEMPO_RPC_URL): Signer {
  let raw: { privateKey?: string };
  try {
    raw = JSON.parse(readFileSync(keyFile, "utf8")) as { privateKey?: string };
  } catch {
    // Fixed message: a JSON.parse error can quote the file's contents, i.e. the key.
    throw new Error(`${keyFile}: unreadable key file (expected JSON {"privateKey":"0x..."})`);
  }
  if (!raw.privateKey || !/^0x[0-9a-fA-F]{64}$/.test(raw.privateKey)) throw new Error(`${keyFile}: no privateKey`);
  const account = privateKeyToAccount(raw.privateKey as Hex);
  if (normAddr(account.address) !== normAddr(PAYER_ADDRESS)) throw new Error("key does not belong to the census payer");
  return signerFor(account, http(rpc, { timeout: 15_000, retryCount: 1 }));
}

/** The mppx pull-mode signer for an account over a transport (tests pass a fake transport). */
export function signerFor(account: LocalAccount, transport: Transport): Signer {
  return {
    address: account.address,
    async credentialFor(res, challengeId, recipient) {
      const all = Challenge.fromResponseList(res);
      const challenge = all.find((c) => c.id === challengeId);
      if (!challenge) throw new Error("challenge id not found by mppx");
      const method = tempo.charge({
        account,
        mode: "pull",
        expectedChainId: TEMPO_MAINNET_CHAIN_ID,
        allowedChainIds: [TEMPO_MAINNET_CHAIN_ID],
        expectedRecipients: [recipient as Hex],
        getClient: () => createClient({ chain: tempoChain, transport }),
      });
      const credential = await method.createCredential({ challenge: challenge as never, context: {} } as never);
      const parsed = Credential.deserialize<{ type?: string; signature?: string }>(credential);
      if (parsed.payload?.type !== "transaction" || typeof parsed.payload.signature !== "string")
        throw new Error("credential is not a pull-mode signed transaction");
      return { credential, serializedTx: parsed.payload.signature };
    },
  };
}
