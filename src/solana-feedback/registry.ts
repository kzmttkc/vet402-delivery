/**
 * The 8004-solana reputation registry (the Solana port of ERC-8004), as far as vet402 needs it:
 * the give_feedback instruction, the AgentAccount and Metaplex Core asset layouts, and a check that a
 * compiled transaction holds nothing but one give_feedback. Pure: no RPC, no key.
 *
 * Source: github.com/QuantuLabs/8004-solana @ 6b344c9 (programs/agent-registry-8004, idl/agent_registry_8004.json).
 * The layout was checked against give_feedback transactions on mainnet (2026-09-28): same discriminator,
 * same nine accounts in the same order, same argument encoding.
 */
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Blockhash,
} from "@solana/kit";

/** agent-registry-8004 on mainnet (README of the source repo; executable on chain). */
export const REGISTRY_PROGRAM = "8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ";
/** Metaplex Core: the program that owns every agent asset. */
export const MPL_CORE_PROGRAM = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/** sha256("global:give_feedback")[0..8], also in the IDL. */
export const GIVE_FEEDBACK_DISCRIMINATOR = new Uint8Array([145, 136, 123, 3, 215, 165, 98, 41]);
/** sha256("account:AgentAccount")[0..8]. */
export const AGENT_ACCOUNT_DISCRIMINATOR = new Uint8Array([241, 119, 69, 140, 233, 9, 112, 50]);

/** Program limits (reputation/state.rs). */
export const MAX_URI_BYTES = 250;
export const MAX_ENDPOINT_BYTES = 250;
export const MAX_TAG_BYTES = 32;

/** AgentAccount field offsets (identity/state.rs: fixed-size fields first). */
export const AGENT_OFFSETS = { collection: 8, creator: 40, owner: 72, asset: 104, bump: 136, atomEnabled: 137, agentWallet: 138 } as const;

export interface GiveFeedbackArgs {
  /** i128 in the program. */
  value: bigint;
  valueDecimals: number;
  /** 0..100, or null for none. */
  score: number | null;
  /** 32 bytes, or null for none. */
  feedbackFileHash: Uint8Array | null;
  tag1: string;
  tag2: string;
  endpoint: string;
  feedbackUri: string;
}

const utf8 = new TextEncoder();

export function argProblems(a: GiveFeedbackArgs): string[] {
  const p: string[] = [];
  if (a.value < -(1n << 127n) || a.value >= 1n << 127n) p.push("value out of i128 range");
  if (!Number.isInteger(a.valueDecimals) || a.valueDecimals < 0 || a.valueDecimals > 18) p.push("valueDecimals must be 0..18");
  if (a.score !== null && (!Number.isInteger(a.score) || a.score < 0 || a.score > 100)) p.push("score must be 0..100");
  if (a.feedbackFileHash !== null && a.feedbackFileHash.length !== 32) p.push("feedbackFileHash must be 32 bytes");
  if (utf8.encode(a.tag1).length > MAX_TAG_BYTES) p.push(`tag1 over ${MAX_TAG_BYTES} bytes`);
  if (utf8.encode(a.tag2).length > MAX_TAG_BYTES) p.push(`tag2 over ${MAX_TAG_BYTES} bytes`);
  if (utf8.encode(a.endpoint).length > MAX_ENDPOINT_BYTES) p.push(`endpoint over ${MAX_ENDPOINT_BYTES} bytes`);
  if (utf8.encode(a.feedbackUri).length > MAX_URI_BYTES) p.push(`feedbackUri over ${MAX_URI_BYTES} bytes`);
  return p;
}

/** Borsh: discriminator, i128 LE, u8, Option<u8>, Option<[u8;32]>, then four u32-length-prefixed strings. */
export function encodeGiveFeedbackData(a: GiveFeedbackArgs): Uint8Array {
  const bad = argProblems(a);
  if (bad.length) throw new Error(`give_feedback arguments refused: ${bad.join("; ")}`);
  const parts: Uint8Array[] = [GIVE_FEEDBACK_DISCRIMINATOR];
  const v = new Uint8Array(16);
  let x = BigInt.asUintN(128, a.value);
  for (let i = 0; i < 16; i++) {
    v[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  parts.push(v, Uint8Array.of(a.valueDecimals));
  parts.push(a.score === null ? Uint8Array.of(0) : Uint8Array.of(1, a.score));
  parts.push(a.feedbackFileHash === null ? Uint8Array.of(0) : Uint8Array.of(1, ...a.feedbackFileHash));
  for (const s of [a.tag1, a.tag2, a.endpoint, a.feedbackUri]) {
    const b = utf8.encode(s);
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, b.length, true);
    parts.push(len, b);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** The reverse, for checks and tests. Throws on anything that is not exactly one give_feedback payload. */
export function decodeGiveFeedbackData(data: Uint8Array): GiveFeedbackArgs {
  const fail = (why: string): never => {
    throw new Error(`not a give_feedback payload: ${why}`);
  };
  if (data.length < 8 || GIVE_FEEDBACK_DISCRIMINATOR.some((b, i) => data[i] !== b)) fail("discriminator");
  let o = 8;
  const need = (n: number) => {
    if (o + n > data.length) fail("truncated");
  };
  need(16);
  let v = 0n;
  for (let i = 15; i >= 0; i--) v = (v << 8n) | BigInt(data[o + i]!);
  o += 16;
  need(1);
  const valueDecimals = data[o++]!;
  need(1);
  let score: number | null = null;
  if (data[o] === 1) {
    need(2);
    score = data[o + 1]!;
    o += 2;
  } else if (data[o] === 0) o += 1;
  else fail("score option tag");
  need(1);
  let feedbackFileHash: Uint8Array | null = null;
  if (data[o] === 1) {
    need(33);
    feedbackFileHash = data.slice(o + 1, o + 33);
    o += 33;
  } else if (data[o] === 0) o += 1;
  else fail("hash option tag");
  const strs: string[] = [];
  for (let i = 0; i < 4; i++) {
    need(4);
    const len = new DataView(data.buffer, data.byteOffset + o, 4).getUint32(0, true);
    o += 4;
    need(len);
    strs.push(new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(o, o + len)));
    o += len;
  }
  if (o !== data.length) fail("trailing bytes");
  return { value: BigInt.asIntN(128, v), valueDecimals, score, feedbackFileHash, tag1: strs[0]!, tag2: strs[1]!, endpoint: strs[2]!, feedbackUri: strs[3]! };
}

export async function agentPda(asset: string): Promise<string> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(REGISTRY_PROGRAM),
    seeds: [utf8.encode("agent"), getAddressEncoder().encode(address(asset))],
  });
  return pda;
}

export interface AgentAccount {
  collection: string;
  creator: string;
  /** The owner cached at registration or last sync; the program itself reads the Core asset. */
  owner: string;
  asset: string;
  atomEnabled: boolean;
  agentWallet: string | null;
  feedbackCount: bigint;
}

export function parseAgentAccount(data: Uint8Array): AgentAccount {
  if (data.length < 139 || AGENT_ACCOUNT_DISCRIMINATOR.some((b, i) => data[i] !== b)) throw new Error("not an AgentAccount");
  const dec = getAddressDecoder();
  const pk = (o: number) => dec.decode(data.subarray(o, o + 32));
  const walletTag = data[AGENT_OFFSETS.agentWallet];
  if (walletTag !== 0 && walletTag !== 1) throw new Error("AgentAccount: bad agent_wallet option tag");
  const after = AGENT_OFFSETS.agentWallet + (walletTag === 1 ? 33 : 1);
  if (data.length < after + 40) throw new Error("AgentAccount: truncated");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    collection: pk(AGENT_OFFSETS.collection),
    creator: pk(AGENT_OFFSETS.creator),
    owner: pk(AGENT_OFFSETS.owner),
    asset: pk(AGENT_OFFSETS.asset),
    atomEnabled: data[AGENT_OFFSETS.atomEnabled] === 1,
    agentWallet: walletTag === 1 ? pk(AGENT_OFFSETS.agentWallet + 1) : null,
    // feedback_digest [u8;32] comes first, then feedback_count u64
    feedbackCount: view.getBigUint64(after + 32, true),
  };
}

/** Metaplex Core BaseAssetV1: key (1 = AssetV1), then the owner. What get_core_owner reads. */
export function parseCoreAssetOwner(programOwner: string, data: Uint8Array): { ok: boolean; owner: string | null; detail: string } {
  if (programOwner !== MPL_CORE_PROGRAM) return { ok: false, owner: null, detail: `asset account is owned by ${programOwner}, not Metaplex Core` };
  if (data.length < 33 || data[0] !== 1) return { ok: false, owner: null, detail: "asset account is not a Core AssetV1" };
  return { ok: true, owner: getAddressDecoder().decode(data.subarray(1, 33)), detail: "Core AssetV1" };
}

export interface FeedbackAccounts {
  client: string;
  agentPda: string;
  asset: string;
  collection: string;
}

/**
 * One give_feedback instruction, nothing else. The four optional ATOM accounts are passed as "none"
 * (the program id, Anchor's marker for an absent optional account): the program then records the
 * feedback without calling the ATOM engine, and no account but the fee payer and the agent PDA is writable.
 */
export function compileGiveFeedbackTx(acc: FeedbackAccounts, a: GiveFeedbackArgs, blockhash = "11111111111111111111111111111111", lastValidBlockHeight = 0n) {
  const data = encodeGiveFeedbackData(a);
  const none = { address: address(REGISTRY_PROGRAM), role: AccountRole.READONLY };
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(acc.client), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: blockhash as Blockhash, lastValidBlockHeight }, m),
    (m) =>
      appendTransactionMessageInstructions(
        [
          {
            programAddress: address(REGISTRY_PROGRAM),
            accounts: [
              { address: address(acc.client), role: AccountRole.WRITABLE_SIGNER },
              { address: address(acc.agentPda), role: AccountRole.WRITABLE },
              { address: address(acc.asset), role: AccountRole.READONLY },
              { address: address(acc.collection), role: AccountRole.READONLY },
              { address: address(SYSTEM_PROGRAM), role: AccountRole.READONLY },
              none,
              none,
              none,
              none,
            ],
            data,
          },
        ],
        m,
      ),
  );
  const tx = compileTransaction(msg);
  assertGiveFeedbackOnly(tx.messageBytes, acc, a);
  return tx;
}

/** Unsigned wire bytes. Pass a recent blockhash when the network fee is to be quoted for it. */
export function unsignedWire(acc: FeedbackAccounts, a: GiveFeedbackArgs, blockhash?: string, lastValidBlockHeight?: bigint): string {
  return getBase64EncodedWireTransaction(compileGiveFeedbackTx(acc, a, blockhash, lastValidBlockHeight));
}

/**
 * Decode a compiled message and refuse anything but the one give_feedback: exactly six accounts
 * (fee payer = client, the only signer; agent PDA, the only other writable account; asset, collection,
 * System program, registry program, all read-only), one instruction, to the registry, with exactly the
 * expected accounts and bytes. No token program and no transfer can be in it, so only the network fee
 * leaves the wallet.
 */
export function assertGiveFeedbackOnly(messageBytes: Parameters<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>[0], acc: FeedbackAccounts, a: GiveFeedbackArgs): void {
  const m = getCompiledTransactionMessageDecoder().decode(messageBytes) as unknown as {
    header: { numSignerAccounts: number; numReadonlySignerAccounts: number; numReadonlyNonSignerAccounts: number };
    staticAccounts: string[];
    instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[];
    addressTableLookups?: unknown[];
  };
  const fail = (why: string): never => {
    throw new Error(`feedback transaction refused: ${why}`);
  };
  const s = m.staticAccounts;
  if (s.length !== 6) fail(`${s.length} accounts`);
  if (s[0] !== acc.client || s[1] !== acc.agentPda) fail("fee payer / writable account");
  const ro = new Set(s.slice(2));
  for (const k of [acc.asset, acc.collection, SYSTEM_PROGRAM, REGISTRY_PROGRAM]) if (!ro.has(k)) fail(`missing read-only ${k}`);
  if (m.header.numSignerAccounts !== 1 || m.header.numReadonlySignerAccounts !== 0 || m.header.numReadonlyNonSignerAccounts !== 4) fail("header");
  if ((m.addressTableLookups ?? []).length) fail("address table lookups");
  if (m.instructions.length !== 1) fail(`${m.instructions.length} instructions`);
  const ix = m.instructions[0]!;
  if (s[ix.programAddressIndex] !== REGISTRY_PROGRAM) fail("instruction is not to the registry");
  const want = [acc.client, acc.agentPda, acc.asset, acc.collection, SYSTEM_PROGRAM, REGISTRY_PROGRAM, REGISTRY_PROGRAM, REGISTRY_PROGRAM, REGISTRY_PROGRAM];
  const got = (ix.accountIndices ?? []).map((i) => s[i]);
  if (got.length !== want.length || want.some((k, i) => got[i] !== k)) fail("instruction accounts");
  const bytes = encodeGiveFeedbackData(a);
  const d: ArrayLike<number> = ix.data ?? new Uint8Array();
  if (d.length !== bytes.length || bytes.some((b, i) => b !== d[i])) fail("instruction data differs");
}
