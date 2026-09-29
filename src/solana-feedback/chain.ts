/**
 * Chain reads for the feedback writer. Read-only: getProgramAccounts, getAccountInfo, getTransaction,
 * getSignaturesForAddress, simulateTransaction (unsigned, sigVerify off), getFeeForMessage.
 */
import { getBase58Decoder, getBase58Encoder, getCompiledTransactionMessageDecoder } from "@solana/kit";
import type { Rpc } from "../chain.js";
import { USDC_MINT } from "../constants.js";
import {
  AGENT_ACCOUNT_DISCRIMINATOR,
  AGENT_OFFSETS,
  GIVE_FEEDBACK_DISCRIMINATOR,
  REGISTRY_PROGRAM,
  agentPda,
  parseAgentAccount,
  parseCoreAssetOwner,
  type AgentAccount,
} from "./registry.js";

const b58dec = getBase58Decoder();
const b58enc = getBase58Encoder();

interface AccountInfo {
  owner: string;
  data: [string, string];
}

/** Every AgentAccount's cached owner and asset, in one call (dataSlice keeps it small). */
export async function agentsByOwner(rpc: Rpc): Promise<Map<string, { asset: string; pda: string }[]>> {
  const res = (await rpc("getProgramAccounts", [
    REGISTRY_PROGRAM,
    {
      encoding: "base64",
      commitment: "confirmed",
      dataSlice: { offset: AGENT_OFFSETS.owner, length: 64 },
      filters: [{ memcmp: { offset: 0, bytes: b58dec.decode(AGENT_ACCOUNT_DISCRIMINATOR) } }],
    },
  ])) as { pubkey: string; account: AccountInfo }[];
  if (!Array.isArray(res) || res.length === 0) throw new Error("getProgramAccounts returned no agents");
  const m = new Map<string, { asset: string; pda: string }[]>();
  for (const x of res) {
    const d = Buffer.from(x.account.data[0], "base64");
    if (d.length !== 64) continue;
    const owner = b58dec.decode(d.subarray(0, 32));
    const asset = b58dec.decode(d.subarray(32, 64));
    m.set(owner, [...(m.get(owner) ?? []), { asset, pda: x.pubkey }]);
  }
  return m;
}

async function account(rpc: Rpc, key: string): Promise<AccountInfo | null> {
  const r = (await rpc("getAccountInfo", [key, { encoding: "base64", commitment: "finalized" }])) as { value: AccountInfo | null };
  return r.value;
}

export interface AgentRead {
  pda: string;
  pdaMatches: boolean;
  agent: AgentAccount | null;
  coreOwner: string | null;
  detail: string;
}

/** The agent's registry account (at the PDA of the asset) and the live owner of its Core asset. */
export async function readAgent(rpc: Rpc, asset: string): Promise<AgentRead> {
  const pda = await agentPda(asset);
  const acc = await account(rpc, pda);
  if (!acc || acc.owner !== REGISTRY_PROGRAM) return { pda, pdaMatches: false, agent: null, coreOwner: null, detail: "no AgentAccount at the PDA" };
  const agent = parseAgentAccount(new Uint8Array(Buffer.from(acc.data[0], "base64")));
  const a = await account(rpc, asset);
  if (!a) return { pda, pdaMatches: agent.asset === asset, agent, coreOwner: null, detail: "asset account not found" };
  const core = parseCoreAssetOwner(a.owner, new Uint8Array(Buffer.from(a.data[0], "base64")));
  return { pda, pdaMatches: agent.asset === asset, agent, coreOwner: core.owner, detail: core.detail };
}

export interface PurchaseRead {
  tx: string;
  finalized: boolean;
  err: unknown;
  clientSigned: boolean;
  clientDeltaAtomic: bigint | null;
  payToDeltaAtomic: bigint | null;
  blockTime: number | null;
}

type TokenBal = { owner?: string; mint: string; uiTokenAmount: { amount: string } };

/** The purchase at finalized commitment: who signed, and how much USDC left the client and reached the payTo. */
export async function readPurchase(rpc: Rpc, tx: string, client: string, payTo: string): Promise<PurchaseRead> {
  const t = (await rpc("getTransaction", [tx, { encoding: "jsonParsed", commitment: "finalized", maxSupportedTransactionVersion: 0 }])) as {
    blockTime: number | null;
    meta: { err: unknown; preTokenBalances?: TokenBal[]; postTokenBalances?: TokenBal[] } | null;
    transaction: { message: { accountKeys: { pubkey: string; signer: boolean }[] } };
  } | null;
  if (!t || !t.meta) return { tx, finalized: false, err: null, clientSigned: false, clientDeltaAtomic: null, payToDeltaAtomic: null, blockTime: null };
  const delta = (owner: string) => {
    const sum = (arr?: TokenBal[]) => (arr ?? []).filter((b) => b.owner === owner && b.mint === USDC_MINT).reduce((s, b) => s + BigInt(b.uiTokenAmount.amount), 0n);
    return sum(t.meta!.postTokenBalances) - sum(t.meta!.preTokenBalances);
  };
  return {
    tx,
    finalized: true,
    err: t.meta.err ?? null,
    clientSigned: t.transaction.message.accountKeys.some((k) => k.pubkey === client && k.signer),
    clientDeltaAtomic: delta(client),
    payToDeltaAtomic: delta(payTo),
    blockTime: t.blockTime,
  };
}

async function allSignatures(rpc: Rpc, key: string, maxPages: number): Promise<{ sigs: Set<string>; complete: boolean }> {
  const sigs = new Set<string>();
  let before: string | undefined;
  for (let i = 0; i < maxPages; i++) {
    const page = (await rpc("getSignaturesForAddress", [key, { limit: 1000, commitment: "confirmed", ...(before ? { before } : {}) }])) as { signature: string }[];
    for (const s of page) sigs.add(s.signature);
    if (page.length < 1000) return { sigs, complete: true };
    before = page.at(-1)!.signature;
  }
  return { sigs, complete: false };
}

export interface ExistingFeedback {
  /** Successful give_feedback transactions from the client to this asset. null = the history could not be read to the end. */
  count: number | null;
  signatures: string[];
  checked: number;
}

/**
 * Has this wallet already written feedback to this agent? The registry keeps no per-writer account,
 * so read it from history: every give_feedback names both the writer (signer) and the agent PDA
 * (writable), so it appears in both address histories. Only the transactions in both are fetched.
 */
export async function findExistingFeedback(rpc: Rpc, client: string, pda: string, asset: string, maxPages = 20): Promise<ExistingFeedback> {
  const [a, b] = await Promise.all([allSignatures(rpc, client, maxPages), allSignatures(rpc, pda, maxPages)]);
  if (!a.complete || !b.complete) return { count: null, signatures: [], checked: 0 };
  const common = [...a.sigs].filter((s) => b.sigs.has(s));
  const found: string[] = [];
  for (const sig of common) {
    const t = (await rpc("getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }])) as {
      meta: { err: unknown; loadedAddresses?: { writable: string[]; readonly: string[] } } | null;
      transaction: { message: { accountKeys: string[]; instructions: { programIdIndex: number; accounts: number[]; data: string }[] } };
    } | null;
    if (!t) return { count: null, signatures: [], checked: common.length }; // listed but unreadable: do not guess
    if (t.meta?.err) continue;
    const keys = [...t.transaction.message.accountKeys, ...(t.meta?.loadedAddresses?.writable ?? []), ...(t.meta?.loadedAddresses?.readonly ?? [])];
    for (const ix of t.transaction.message.instructions) {
      if (keys[ix.programIdIndex] !== REGISTRY_PROGRAM) continue;
      const data = b58enc.encode(ix.data);
      if (GIVE_FEEDBACK_DISCRIMINATOR.some((x, i) => data[i] !== x)) continue;
      if (keys[ix.accounts[0]!] === client && keys[ix.accounts[2]!] === asset) found.push(sig);
    }
  }
  return { count: found.length, signatures: found, checked: common.length };
}

export interface SimulateRead {
  ok: boolean;
  err: unknown;
  unitsConsumed: number | null;
  logs: string[];
  feeLamports: number | null;
}

/** simulateTransaction on the unsigned wire bytes (sigVerify off, fresh blockhash) and the network fee. */
export async function simulateFeedback(rpc: Rpc, wireBase64: string): Promise<SimulateRead> {
  const r = (await rpc("simulateTransaction", [wireBase64, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }])) as {
    value: { err: unknown; logs: string[] | null; unitsConsumed?: number };
  };
  return { ok: r.value.err === null, err: r.value.err, unitsConsumed: r.value.unitsConsumed ?? null, logs: r.value.logs ?? [], feeLamports: await feeForWire(rpc, wireBase64) };
}

/** getFeeForMessage for the message inside a wire transaction. */
export async function feeForWire(rpc: Rpc, wireBase64: string): Promise<number | null> {
  const bytes = new Uint8Array(Buffer.from(wireBase64, "base64"));
  // wire = compact-u16 signature count, 64 bytes per signature, then the message
  let n = 0;
  let shift = 0;
  let o = 0;
  for (;;) {
    const b = bytes[o++]!;
    n |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  const message = bytes.subarray(o + 64 * n);
  getCompiledTransactionMessageDecoder().decode(message); // throws if the slice is not a message
  const r = (await rpc("getFeeForMessage", [Buffer.from(message).toString("base64"), { commitment: "confirmed" }])) as { value: number | null };
  return r.value;
}

export async function balanceLamports(rpc: Rpc, key: string): Promise<bigint> {
  const r = (await rpc("getBalance", [key, { commitment: "confirmed" }])) as { value: number };
  return BigInt(r.value);
}
