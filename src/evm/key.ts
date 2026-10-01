/**
 * The Base key. Read only by `--pay` (scripts/base-buy.ts) and `--write` (scripts/base-feedback.ts);
 * dry runs never call this. The file must be mode 600 and its address must equal .keys/evm.pub.
 * The key bytes are never logged or returned.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAddress, isAddressEqual, type Address } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export const KEY_DIR = process.env.EVM_KEY_DIR ?? join(homedir(), "vet402-solana", ".keys");
export const EXPECTED_ADDRESS: Address = getAddress("0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51");

export function readPublicAddress(dir = KEY_DIR): Address {
  const a = getAddress(readFileSync(`${dir}/evm.pub`, "utf8").trim());
  if (!isAddressEqual(a, EXPECTED_ADDRESS)) throw new Error(`evm.pub ${a} != expected ${EXPECTED_ADDRESS}`);
  return a;
}

export function loadEvmAccount(dir = KEY_DIR): PrivateKeyAccount {
  const file = `${dir}/evm.json`;
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) throw new Error(`key file must be mode 600 (is ${mode.toString(8)})`);
  const pk = (JSON.parse(readFileSync(file, "utf8")) as { privateKey?: string }).privateKey;
  if (typeof pk !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("key file has no 32-byte privateKey");
  const account = privateKeyToAccount(pk as `0x${string}`);
  if (!isAddressEqual(account.address, readPublicAddress(dir))) throw new Error("key file address != evm.pub");
  return account;
}

/**
 * The DeliveryRoots key (contracts/src/DeliveryRoots.sol): it deploys the contract on Arbitrum One and Robinhood
 * Chain and is its only `writer`. A key of its own, never the payer wallet above: it holds only the ETH for the
 * daily root, and losing it cannot move any USDC or USDG. Read only by scripts/evm-roots-deploy.ts --send and
 * scripts/evm-anchor.ts --send. The file must be mode 600 and its address must be this one.
 */
export const ROOTS_POSTER_ADDRESS: Address = getAddress("0xd326A383a2DEAA47aE3f055a70704175Aa9FF611");

export function loadRootsPoster(dir = KEY_DIR): PrivateKeyAccount {
  const file = `${dir}/evm-roots-poster.json`;
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) throw new Error(`key file must be mode 600 (is ${mode.toString(8)})`);
  const pk = (JSON.parse(readFileSync(file, "utf8")) as { privateKey?: string }).privateKey;
  if (typeof pk !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error("key file has no 32-byte privateKey");
  const account = privateKeyToAccount(pk as `0x${string}`);
  if (!isAddressEqual(account.address, ROOTS_POSTER_ADDRESS)) throw new Error(`${file} is not the DeliveryRoots key ${ROOTS_POSTER_ADDRESS}`);
  return account;
}
