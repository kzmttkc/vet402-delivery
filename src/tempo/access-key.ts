/**
 * The Tempo purchase key as an AccountKeychain access key, so the chain itself holds the spending cap.
 *
 * The payer account (PAYER_ADDRESS) keeps its root key in .keys/evm.json. Tempo purchases can instead
 * sign with a separate access key (.keys/tempo-access.json) that the root key has authorized once in the
 * AccountKeychain precompile with:
 *   - one USDC.e spending limit of ACCESS_KEY_LIMIT_ATOMIC per ACCESS_KEY_PERIOD_S (rolling from the
 *     authorization time; the precompile keeps one limit per token, a second USDC.e limit reverts with
 *     InvalidSpendingLimit, read on mainnet 2026-09-30),
 *   - an expiry (ACCESS_KEY_EXPIRY), after which the chain refuses every transaction the key signs,
 *   - a call scope: only USDC.e transfer and transferWithMemo; no approve, no other contract.
 * The expiry bounds the key's lifetime spend to (days until expiry + 1) x the daily limit, which is
 * below the 30 USDC.e month cap of remeasure.
 *
 * Spec: https://tempo.xyz/developers/docs/protocol/transactions/AccountKeychain (limits, scopes, expiry),
 * https://tempo.xyz/developers/docs/protocol/tips/tip-1011 (periodic limits), T3 active on mainnet since
 * 2026-04-27 (https://tempo.xyz/developers/docs/protocol/upgrades/t3).
 *
 * The limits are a second fence. The ledger caps and the signed-transaction check still run first.
 */
import { readFileSync } from "node:fs";
import { encodeFunctionData, toFunctionSelector, type Address, type Hex, type LocalAccount, type Transport, createPublicClient } from "viem";
import { tempo as tempoChain } from "viem/chains";
import { Abis, Account, Addresses, Transaction } from "viem/tempo";
import { PAYER_ADDRESS, USDC_E, normAddr } from "./constants.js";
import { mppChallengesFromHeader, tempoChargeRequest } from "./challenge.js";
import { signerFor, type Signer } from "./chain.js";
import { RM_TEMPO_MAX_PER_RUN_ATOMIC } from "../remeasure/constants.js";

export const ACCOUNT_KEYCHAIN = Addresses.accountKeychain;
/** The access key the payer authorizes (address of .keys/tempo-access.json; the key itself is never printed). */
export const TEMPO_ACCESS_KEY_ID = "0x1e9AadDc86f9132DFBA8B4287978aDE1ceC93c4b";
/** Same as remeasure's day ledger cap: 1 USDC.e. */
export const ACCESS_KEY_LIMIT_ATOMIC = RM_TEMPO_MAX_PER_RUN_ATOMIC;
export const ACCESS_KEY_PERIOD_S = 86_400n;
/**
 * End of 2026-10-09 UTC (the registered key's expiry on chain). The rebuy has no end date since 2026-10-01: the daily
 * dry run warns three days before this and leaves Tempo out once the key cannot sign (signerPlan); README says how to
 * go on (the root key, or a new access key: an existing key's expiry cannot be changed, authorizeKey reverts
 * KeyAlreadyExists).
 */
export const ACCESS_KEY_EXPIRY = BigInt(Date.parse("2026-10-09T23:59:59Z") / 1000);
/**
 * The authorization is refused when its network fee could exceed this (atomic USDC.e, 0.08). About 3.1M gas
 * with the call scope: 0.0019 at the base-fee floor; the bound signed (estimate x 1.25 at the base-fee cap)
 * is about 0.046, so the cap leaves room for the estimate to grow.
 */
export const MAX_AUTHORIZE_FEE_ATOMIC = 80_000n;
/** An access key with less time left than this is not used to sign. */
export const MIN_TIME_LEFT_S = 600n;

export const ACCESS_KEY_FILE_KIND = "vet402-tempo-access-key";

const SEL_TRANSFER = toFunctionSelector("transfer(address,uint256)");
const SEL_TRANSFER_WITH_MEMO = toFunctionSelector("transferWithMemo(address,uint256,bytes32)");

/** The one authorizeKey form T3 accepts (selector 0x980a6025): keyId, signatureType, config. */
const AUTHORIZE_KEY = (Abis.accountKeychain as readonly { name?: string; type: string; inputs?: readonly { type: string }[] }[]).find(
  (f) => f.type === "function" && f.name === "authorizeKey" && f.inputs?.length === 3 && f.inputs[2]!.type === "tuple",
)!;

export interface KeyConfig {
  expiry: bigint;
  enforceLimits: true;
  limits: { token: Address; amount: bigint; period: bigint }[];
  allowAnyCalls: false;
  allowedCalls: { target: Address; selectorRules: { selector: Hex; recipients: Address[] }[] }[];
}

export function accessKeyConfig(expiry = ACCESS_KEY_EXPIRY): KeyConfig {
  return {
    expiry,
    enforceLimits: true,
    limits: [{ token: USDC_E as Address, amount: ACCESS_KEY_LIMIT_ATOMIC, period: ACCESS_KEY_PERIOD_S }],
    allowAnyCalls: false,
    allowedCalls: [
      {
        target: USDC_E as Address,
        selectorRules: [
          { selector: SEL_TRANSFER, recipients: [] },
          { selector: SEL_TRANSFER_WITH_MEMO, recipients: [] },
        ],
      },
    ],
  };
}

/** Calldata of AccountKeychain.authorizeKey(keyId, secp256k1, config). */
export function authorizeKeyData(keyId: string, config: KeyConfig = accessKeyConfig()): Hex {
  if (!/^0x[0-9a-fA-F]{40}$/.test(keyId) || /^0x0{40}$/.test(keyId)) throw new Error(`bad access key id ${keyId}`);
  if (config.limits.length !== 1) throw new Error("one USDC.e limit only (the precompile refuses a second limit for the same token)");
  return (encodeFunctionData as (p: unknown) => Hex)({ abi: [AUTHORIZE_KEY], functionName: "authorizeKey", args: [keyId, 0, config] });
}

// ---------- the key file ----------

export interface AccessKeyFile {
  kind: typeof ACCESS_KEY_FILE_KIND;
  /** The access key's secp256k1 private key. Never printed. */
  accessKey: string;
  /** The account it signs for (the root). */
  account: string;
}

/** null when the JSON is not an access key file (a root key file `{ privateKey }` is not). */
export function parseAccessKeyFile(raw: unknown): AccessKeyFile | null {
  if (typeof raw !== "object" || raw === null || (raw as { kind?: unknown }).kind !== ACCESS_KEY_FILE_KIND) return null;
  const f = raw as Partial<AccessKeyFile>;
  if (typeof f.accessKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(f.accessKey)) throw new Error("access key file: no accessKey");
  if (typeof f.account !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(f.account)) throw new Error("access key file: no account");
  return f as AccessKeyFile;
}

/** The access key account: signs through a keychain envelope for `account`. */
export function accessAccount(f: AccessKeyFile) {
  return Account.fromSecp256k1(f.accessKey as Hex, { access: f.account as Address });
}

/** The access key's own address (its keyId). */
export function accessKeyIdOf(f: AccessKeyFile): string {
  return (accessAccount(f) as unknown as { accessKeyAddress: string }).accessKeyAddress;
}

// ---------- reading the key's state on chain ----------

export interface KeyState {
  registered: boolean;
  keyId: string;
  expiry: bigint;
  enforceLimits: boolean;
  isRevoked: boolean;
  signatureType: number;
  remaining: bigint;
  periodEnd: bigint;
  /** getAllowedCalls read back: isScoped false = the key may call anything. */
  allowedCalls: { isScoped: boolean; scopes: { target: string; selectors: string[]; recipients: string[][] }[] };
}

type Reader = { readContract: (a: { address: Address; abi: unknown; functionName: string; args: unknown[] }) => Promise<unknown> };

export async function readKeyState(client: Reader, account: string, keyId: string): Promise<KeyState> {
  const k = (await client.readContract({ address: ACCOUNT_KEYCHAIN, abi: Abis.accountKeychain, functionName: "getKey", args: [account, keyId] })) as {
    signatureType: number;
    keyId: string;
    expiry: bigint;
    enforceLimits: boolean;
    isRevoked: boolean;
  };
  const [remaining, periodEnd] = (await client.readContract({
    address: ACCOUNT_KEYCHAIN,
    abi: Abis.accountKeychain,
    functionName: "getRemainingLimitWithPeriod",
    args: [account, keyId, USDC_E],
  })) as [bigint, bigint];
  const [isScoped, scopes] = (await client.readContract({ address: ACCOUNT_KEYCHAIN, abi: Abis.accountKeychain, functionName: "getAllowedCalls", args: [account, keyId] })) as [
    boolean,
    readonly { target: string; selectorRules: readonly { selector: string; recipients: readonly string[] }[] }[],
  ];
  const allowedCalls = {
    isScoped,
    scopes: scopes.map((c) => ({ target: c.target, selectors: c.selectorRules.map((r) => r.selector.toLowerCase()), recipients: c.selectorRules.map((r) => [...r.recipients]) })),
  };
  return { registered: k.expiry > 0n, keyId: k.keyId, expiry: k.expiry, enforceLimits: k.enforceLimits, isRevoked: k.isRevoked, signatureType: k.signatureType, remaining, periodEnd, allowedCalls };
}

/** The selectors the access key may call on USDC.e. Anything else read back from the chain is refused. */
export const ALLOWED_SELECTORS: readonly string[] = [SEL_TRANSFER, SEL_TRANSFER_WITH_MEMO];

/** null = the key can call USDC.e transfer and transferWithMemo and nothing else. Otherwise why not. */
export function scopeProblem(a: KeyState["allowedCalls"]): string | null {
  if (!a.isScoped) return "the key may call any contract (not scoped)";
  if (a.scopes.length === 0) return "the key may call nothing (scoped deny-all: missing, revoked or expired)";
  for (const c of a.scopes) {
    if (normAddr(c.target) !== USDC_E) return `the key may call ${c.target}, not only USDC.e`;
    if (c.selectors.length === 0) return "the USDC.e scope names no function";
    const other = c.selectors.find((x) => !ALLOWED_SELECTORS.includes(x));
    if (other) return `the key may call ${other} on USDC.e, not only transfer and transferWithMemo`;
  }
  return null;
}

/** null = the key may sign a payment of `amount` now. Otherwise why not. */
export function keyProblem(s: KeyState, keyId: string, amount: bigint, nowS: bigint): string | null {
  if (!s.registered) return `access key ${keyId} is not authorized on chain`;
  if (normAddr(s.keyId) !== normAddr(keyId)) return `getKey returned ${s.keyId}, not ${keyId}`;
  if (s.isRevoked) return "access key is revoked";
  if (s.signatureType !== 0) return `access key signature type ${s.signatureType}, not secp256k1`;
  if (!s.enforceLimits) return "access key has no spending limit on chain";
  if (s.expiry <= nowS + MIN_TIME_LEFT_S) return `access key expires at ${s.expiry} (now ${nowS})`;
  if (s.remaining < amount) return `on-chain limit left ${s.remaining} < ${amount} until ${s.periodEnd}`;
  return scopeProblem(s.allowedCalls);
}

/**
 * The signed authorization, before it is sent: Tempo mainnet, signed by the root key of `account`, one
 * call to the AccountKeychain with exactly authorizeKeyData(keyId), no value, a fee payer signature (so
 * the fee does not leave the payer), no key authorization, no authorization list, a fee bound within the
 * cap. `feePayer` is the account that was handed the fee-payer role when signing.
 */
export function authorizeTxProblem(serialized: string, exp: { account: string; keyId: string; feePayer: string; nonce: number; maxFeeAtomic?: bigint }): string | null {
  if (!/^0x76[0-9a-fA-F]+$/.test(serialized)) return "not a Tempo (0x76) transaction";
  if (normAddr(exp.feePayer) === normAddr(exp.account)) return "the fee payer is the payer";
  let tx: Record<string, unknown>;
  try {
    tx = Transaction.deserialize(serialized as `0x76${string}`) as Record<string, unknown>;
  } catch (e) {
    return `undecodable: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (tx.chainId !== 4217) return `chainId ${String(tx.chainId)} is not 4217`;
  if (normAddr(tx.from) !== normAddr(exp.account)) return `signer ${String(tx.from)} is not ${exp.account}`;
  if ((tx.signature as { type?: string } | undefined)?.type !== "secp256k1") return "not signed by the root key";
  if (Number(tx.nonce) !== exp.nonce) return `nonce ${String(tx.nonce)} is not ${exp.nonce}`;
  const calls = tx.calls as { to?: string; data?: string; value?: bigint }[] | undefined;
  if (!Array.isArray(calls) || calls.length !== 1) return `expected 1 call, got ${Array.isArray(calls) ? calls.length : "none"}`;
  if (normAddr(calls[0]!.to) !== normAddr(ACCOUNT_KEYCHAIN)) return `call target ${String(calls[0]!.to)} is not the AccountKeychain`;
  if (calls[0]!.value !== undefined && calls[0]!.value !== 0n) return "call carries value";
  if (String(calls[0]!.data).toLowerCase() !== authorizeKeyData(exp.keyId).toLowerCase()) return "call data is not authorizeKey for the access key with vet402's limits";
  if (!tx.feePayerSignature) return "no fee payer signature: the fee would leave the payer";
  if (tx.keyAuthorization !== undefined && tx.keyAuthorization !== null) return "carries a key authorization";
  if (Array.isArray(tx.authorizationList) && tx.authorizationList.length > 0) return "carries an authorization list";
  const bound = (BigInt(String(tx.gas ?? 0)) * BigInt(String(tx.maxFeePerGas ?? 0)) + 999_999_999_999n) / 1_000_000_000_000n;
  if (bound > (exp.maxFeeAtomic ?? MAX_AUTHORIZE_FEE_ATOMIC)) return `fee bound ${bound} is over ${exp.maxFeeAtomic ?? MAX_AUTHORIZE_FEE_ATOMIC}`;
  return null;
}

/** The signed transaction must carry a keychain signature for `account` (not a root-key signature). */
export function keychainProblem(serializedTx: string, account: string): string | null {
  let tx: { signature?: { type?: string; userAddress?: string } };
  try {
    tx = Transaction.deserialize(serializedTx as `0x76${string}`) as typeof tx;
  } catch (e) {
    return `undecodable: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (tx.signature?.type !== "keychain") return `signature type ${String(tx.signature?.type)}, not keychain`;
  if (normAddr(tx.signature.userAddress) !== normAddr(account)) return `keychain signature for ${String(tx.signature.userAddress)}, not ${account}`;
  return null;
}

/**
 * The purchase signer over an access key file. Before each signature it reads the key's state on chain
 * and refuses when the key is missing, revoked, unlimited, about to expire, has less than the amount left,
 * or may call anything but USDC.e transfer and transferWithMemo (getAllowedCalls); after, it refuses a
 * transaction without the keychain signature. Throwing here means payOne records refused_before_sign and
 * the run stops (tx_check_failed) with nothing sent.
 */
export function accessSigner(f: AccessKeyFile, transport: Transport, opts: { keyId?: string; now?: () => Date; read?: Reader } = {}): Signer {
  if (normAddr(f.account) !== normAddr(PAYER_ADDRESS)) throw new Error("access key file is for another account than the payer");
  const keyId = accessKeyIdOf(f);
  const want = opts.keyId ?? TEMPO_ACCESS_KEY_ID;
  if (normAddr(keyId) !== normAddr(want)) throw new Error(`access key ${keyId} is not the registered key ${want}`);
  const account = accessAccount(f) as unknown as LocalAccount;
  const inner = signerFor(account, transport);
  const read = opts.read ?? (createPublicClient({ chain: tempoChain, transport }) as unknown as Reader);
  return {
    address: inner.address,
    async credentialFor(res, challengeId, recipient) {
      const amount = amountOf(res, challengeId);
      const nowS = BigInt(Math.floor((opts.now?.() ?? new Date()).getTime() / 1000));
      const problem = keyProblem(await readKeyState(read, f.account, keyId), keyId, amount, nowS);
      if (problem) throw new Error(problem);
      const out = await inner.credentialFor(res, challengeId, recipient);
      const bad = keychainProblem(out.serializedTx, f.account);
      if (bad) throw new Error(bad);
      return out;
    },
  };
}

/** The charge amount of challenge `id` in a 402 (the guard has already checked it). */
function amountOf(res: Response, id: string): bigint {
  const ch = mppChallengesFromHeader(res.headers.get("www-authenticate")).find((c) => c.id === id);
  const r = ch ? tempoChargeRequest(ch) : null;
  if (!r || !/^\d{1,31}$/.test(r.amount)) throw new Error("challenge amount unreadable for the on-chain limit check");
  return BigInt(r.amount);
}

/** Read an access key file. Fixed messages: a JSON error could quote the key. */
export function readAccessKeyFile(path: string): AccessKeyFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path}: unreadable key file`);
  }
  const f = parseAccessKeyFile(raw);
  if (!f) throw new Error(`${path}: not a ${ACCESS_KEY_FILE_KIND} file`);
  return f;
}


// ---------- the daily dry run's look at the key ----------

/** The dry run warns this long before the access key's expiry (src/daily/steps.ts planVerdict, then the runner says it daily). */
export const KEY_EXPIRY_WARN_S = 3n * 86_400n;
/** The key must outlive the run that follows the dry run by this much (a run with slow sellers takes well under it). */
export const KEY_RUN_MARGIN_S = 6n * 3_600n;

export interface SignerPlan {
  kind: "root" | "access-key";
  keyId?: string;
  expiresAt?: string | null;
  /** The key cannot sign the run that would follow: Tempo is left out today (the runner says so, without halting). */
  problem: string | null;
  /** It can sign, but expires within KEY_EXPIRY_WARN_S. */
  warn: string | null;
}

/**
 * What the key that will sign Tempo purchases looks like now, for the dry run's plan (scripts/remeasure.ts writes it
 * as `signer`). A root key file needs no chain read. An access key file is read back from the AccountKeychain: the
 * same checks accessSigner makes before every signature (registered, this key, not revoked, secp256k1, limited, the
 * USDC.e transfer scope), with its expiry at least KEY_RUN_MARGIN_S ahead; the amount is left to the signature-time
 * check. Signs nothing; the key itself is never printed.
 */
export async function signerPlan(keyFile: string, read: Reader, nowS: bigint, opts: { keyId?: string } = {}): Promise<SignerPlan> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(keyFile, "utf8"));
  } catch {
    return { kind: "root", problem: `${keyFile}: unreadable key file`, warn: null };
  }
  let f: AccessKeyFile | null;
  try {
    f = parseAccessKeyFile(raw);
  } catch (e) {
    return { kind: "access-key", problem: `${keyFile}: ${(e as Error).message}`, warn: null };
  }
  if (!f) return { kind: "root", problem: null, warn: null };
  if (normAddr(f.account) !== normAddr(PAYER_ADDRESS)) return { kind: "access-key", problem: "access key file is for another account than the payer", warn: null };
  const keyId = accessKeyIdOf(f);
  const want = opts.keyId ?? TEMPO_ACCESS_KEY_ID;
  if (normAddr(keyId) !== normAddr(want)) return { kind: "access-key", keyId, problem: `access key ${keyId} is not the registered key ${want}`, warn: null };
  const s = await readKeyState(read, f.account, keyId);
  const expiresAt = s.registered ? new Date(Number(s.expiry) * 1000).toISOString() : null;
  const problem = keyProblem(s, keyId, 0n, nowS + KEY_RUN_MARGIN_S - MIN_TIME_LEFT_S);
  const warn = !problem && s.expiry <= nowS + KEY_EXPIRY_WARN_S ? `the Tempo purchase key ${keyId} expires at ${expiresAt}; renew it before then (README, Tempo access key)` : null;
  return { kind: "access-key", keyId, expiresAt, problem: problem ? `${problem}${expiresAt ? ` (expiry ${expiresAt})` : ""}` : null, warn };
}
