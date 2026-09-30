/**
 * Authorize the Tempo purchase access key in the AccountKeychain precompile (src/tempo/access-key.ts).
 *
 *   npx tsx scripts/tempo-access-key.ts --keygen     # create .keys/tempo-access.json (prints the key id only)
 *   npx tsx scripts/tempo-access-key.ts              # plan: eth_call + eth_estimateGas of authorizeKey from the payer. Signs nothing.
 *   npx tsx scripts/tempo-access-key.ts --status     # the key's state on chain (getKey, remaining limit)
 *   npx tsx scripts/tempo-access-key.ts --send       # the payer's root key signs authorizeKey once; the Tempo anchor key pays the fee
 *
 * The fee is paid by the Tempo anchor key (.keys/tempo-anchor.json), not by the payer: every USDC.e that
 * leaves the payer must be in a purchase ledger (src/tempo/key-ledgers.ts), and a fee the ledgers do not
 * know would stop every Tempo purchase run with chain_spend_exceeds_ledger. --send checks the payer's
 * USDC.e balance before and after and fails loudly if it moved.
 *
 * Do not run --send while a Tempo purchase run is in progress: both use the payer's nonce.
 *
 * After it lands, purchases switch to the access key by pointing VET402_EVM_KEY_FILE (or --key) at
 * .keys/tempo-access.json; src/tempo/chain.ts loadSigner reads either file kind. RPC: TEMPO_RPC_URL.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, keccak256, parseAbiItem, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { tempo as tempoChain } from "viem/chains";
import { Account, Transaction } from "viem/tempo";
import {
  ACCESS_KEY_EXPIRY,
  ACCESS_KEY_FILE_KIND,
  ACCESS_KEY_LIMIT_ATOMIC,
  ACCESS_KEY_PERIOD_S,
  ACCOUNT_KEYCHAIN,
  accessKeyConfig,
  accessKeyIdOf,
  authorizeKeyData,
  authorizeTxProblem,
  MAX_AUTHORIZE_FEE_ATOMIC,
  readAccessKeyFile,
  readKeyState,
  TEMPO_ACCESS_KEY_ID,
} from "../src/tempo/access-key.js";
import { PAYER_ADDRESS, TEMPO_MAINNET_CHAIN_ID, TEMPO_RPC_URL, USDC_E, normAddr } from "../src/tempo/constants.js";
import { maxFeeAtomic, TEMPO_BASE_FEE_CAP } from "../src/receipt/tempo-anchor.js";
import { VET402_TEMPO_ANCHOR_SENDERS } from "../src/receipt/observers.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`);
  return v;
};
const keysDir = resolve(argValue("--keys-dir") ?? join(ROOT, ".keys"));
const accessFile = join(keysDir, "tempo-access.json");
const rpc = process.env.TEMPO_RPC_URL ?? TEMPO_RPC_URL;
const client = createPublicClient({ chain: tempoChain, transport: http(rpc, { timeout: 20_000, retryCount: 1 }) });
const BALANCE_OF = parseAbiItem("function balanceOf(address) view returns (uint256)");
const usdc = (a: string) => client.readContract({ address: USDC_E as Hex, abi: [BALANCE_OF], functionName: "balanceOf", args: [a as Hex] });
const iso = (s: bigint) => new Date(Number(s) * 1000).toISOString();

if (args.includes("--keygen")) {
  const pk = generatePrivateKey();
  const f = { kind: ACCESS_KEY_FILE_KIND, accessKey: pk, account: PAYER_ADDRESS };
  writeFileSync(accessFile, `${JSON.stringify(f)}\n`, { flag: "wx", mode: 0o600 });
  console.log(`wrote ${accessFile} (mode 600). Access key id: ${accessKeyIdOf(f as never)} (account ${PAYER_ADDRESS})`);
  process.exit(0);
}

const keyId = argValue("--key-id") ?? TEMPO_ACCESS_KEY_ID;
if (normAddr(keyId) !== normAddr(TEMPO_ACCESS_KEY_ID) && args.includes("--send")) {
  console.error(`--send only authorizes the registered key ${TEMPO_ACCESS_KEY_ID}`);
  process.exit(2);
}
const chainId = await client.getChainId();
if (chainId !== TEMPO_MAINNET_CHAIN_ID) {
  console.error(`RPC ${rpc} is chain ${chainId}, not Tempo mainnet`);
  process.exit(2);
}

if (args.includes("--status")) {
  const s = await readKeyState(client as never, PAYER_ADDRESS, keyId);
  console.log(JSON.stringify({ ...s, account: PAYER_ADDRESS, keyId, expiry: s.expiry.toString(), expiresAt: s.registered ? iso(s.expiry) : null, remaining: s.remaining.toString(), periodEnd: s.periodEnd.toString(), periodEndsAt: s.periodEnd > 0n ? iso(s.periodEnd) : null }, null, 2));
  process.exit(0);
}

// ---------- plan: nothing is signed ----------
const data = authorizeKeyData(keyId);
const state = await readKeyState(client as never, PAYER_ADDRESS, keyId);
let gas: bigint | null = null;
let err: string | null = null;
try {
  await client.call({ account: PAYER_ADDRESS as Hex, to: ACCOUNT_KEYCHAIN, data });
  gas = await client.estimateGas({ account: PAYER_ADDRESS as Hex, to: ACCOUNT_KEYCHAIN, data });
} catch (e) {
  const x = e as { shortMessage?: string; message?: string };
  err = String(x.shortMessage ?? x.message).split("\n")[0]!;
}
const gasLimit = gas === null ? null : (gas * 5n + 3n) / 4n;
const feeBound = gasLimit === null ? null : maxFeeAtomic(gasLimit, TEMPO_BASE_FEE_CAP);
const feePayer = VET402_TEMPO_ANCHOR_SENDERS[0]!;
const [payerBal, feePayerBal] = await Promise.all([usdc(PAYER_ADDRESS), usdc(feePayer)]);
const cfg = accessKeyConfig();
const plan = {
  account: PAYER_ADDRESS,
  keychain: ACCOUNT_KEYCHAIN,
  keyId,
  selector: data.slice(0, 10),
  config: {
    expiry: cfg.expiry.toString(),
    expiresAt: iso(ACCESS_KEY_EXPIRY),
    limit: { token: USDC_E, amountAtomic: ACCESS_KEY_LIMIT_ATOMIC.toString(), periodSeconds: ACCESS_KEY_PERIOD_S.toString() },
    allowedCalls: cfg.allowedCalls.map((c) => ({ target: c.target, selectors: c.selectorRules.map((r) => r.selector), recipients: "any" })),
  },
  alreadyOnChain: state.registered,
  simulation: { ok: err === null, gasEstimate: gas?.toString() ?? null, err },
  gasLimit: gasLimit?.toString() ?? null,
  feeBoundAtomic: feeBound?.toString() ?? null,
  maxFeeAtomic: MAX_AUTHORIZE_FEE_ATOMIC.toString(),
  feePayer,
  feePayerBalanceAtomic: feePayerBal.toString(),
  payerBalanceAtomic: payerBal.toString(),
};
console.log(JSON.stringify(plan, null, 2));
if (!args.includes("--send")) {
  console.log("simulate only: nothing was signed or sent");
  process.exit(err === null ? 0 : 1);
}

// ---------- send ----------
const refuse = (why: string): never => {
  console.error(`not sending: ${why}`);
  process.exit(1);
};
if (state.registered) refuse(`${keyId} is already authorized`);
if (err !== null || gasLimit === null || feeBound === null) refuse(`simulation failed: ${err}`);
if (feeBound! > MAX_AUTHORIZE_FEE_ATOMIC) refuse(`fee bound ${feeBound} > ${MAX_AUTHORIZE_FEE_ATOMIC}`);
if (feePayerBal < feeBound!) refuse(`the fee payer ${feePayer} holds ${feePayerBal}, needs ${feeBound}`);
const ak = readAccessKeyFile(accessFile);
if (normAddr(accessKeyIdOf(ak)) !== normAddr(keyId)) refuse(`${accessFile} holds another key than ${keyId}`);

function loadKey(file: string, want: string) {
  if ((statSync(file).mode & 0o077) !== 0) refuse(`${file} must be mode 600`);
  let pk: string | undefined;
  try {
    pk = (JSON.parse(readFileSync(file, "utf8")) as { privateKey?: string }).privateKey;
  } catch {
    refuse(`${file}: unreadable key file`);
  }
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) refuse(`${file}: no privateKey`);
  const a = privateKeyToAccount(pk as Hex);
  if (normAddr(a.address) !== normAddr(want)) refuse(`${file} is not ${want}`);
  return pk as Hex;
}
const root = Account.fromSecp256k1(loadKey(join(keysDir, "evm.json"), PAYER_ADDRESS));
const payer = Account.fromSecp256k1(loadKey(join(keysDir, "tempo-anchor.json"), feePayer));
const nonce = await client.getTransactionCount({ address: PAYER_ADDRESS as Hex, blockTag: "pending" });
const latest = await client.getTransactionCount({ address: PAYER_ADDRESS as Hex, blockTag: "latest" });
if (nonce !== latest) refuse(`the payer has ${nonce - latest} transaction(s) in flight (a purchase run?); try again when none is`);
const raw = await root.signTransaction(
  {
    type: "tempo",
    chainId: TEMPO_MAINNET_CHAIN_ID,
    calls: [{ to: ACCOUNT_KEYCHAIN, data }],
    nonce,
    gas: gasLimit!,
    maxFeePerGas: TEMPO_BASE_FEE_CAP,
    maxPriorityFeePerGas: 0n,
    feeToken: USDC_E as Hex,
    feePayer: payer,
  } as never,
  { serializer: Transaction.serialize as never },
);
const bad = authorizeTxProblem(raw, { account: PAYER_ADDRESS, keyId, feePayer, nonce });
if (bad) refuse(`signed transaction refused, never sent: ${bad}`);
const hash = keccak256(raw as Hex);
const before = await usdc(PAYER_ADDRESS);
const sent = await client.request({ method: "eth_sendRawTransaction" as never, params: [raw] as never });
console.log(`sent ${String(sent)} (computed ${hash})`);
const receipt = await client.waitForTransactionReceipt({ hash: String(sent) as Hex, timeout: 120_000 });
const after = await usdc(PAYER_ADDRESS);
const s = await readKeyState(client as never, PAYER_ADDRESS, keyId);
console.log(JSON.stringify({ tx: receipt.transactionHash, status: receipt.status, registered: s.registered, expiresAt: iso(s.expiry), remaining: s.remaining.toString(), periodEndsAt: iso(s.periodEnd), payerBalanceBefore: before.toString(), payerBalanceAfter: after.toString() }, null, 2));
if (after !== before) {
  console.error(`the payer's USDC.e moved (${before} -> ${after}): the Tempo purchase ledgers do not account for it; purchases will stop until a person looks`);
  process.exit(1);
}
process.exit(receipt.status === "success" && s.registered ? 0 : 1);
