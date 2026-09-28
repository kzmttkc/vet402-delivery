/**
 * After mppx signs, before the credential leaves this process: decode the signed Tempo
 * transaction and check that it moves exactly what the guard approved and nothing else.
 */
import { decodeFunctionData } from "viem";
import { Abis, Transaction } from "viem/tempo";
import { TEMPO_MAINNET_CHAIN_ID, USDC_E, normAddr } from "./constants.js";

export interface TxExpectation {
  payer: string;
  recipient: string;
  amount: bigint;
  /** true when the challenge said the server pays the fee. */
  sponsored: boolean;
}

/** null = the transaction is exactly the approved transfer. Otherwise why not. */
export function checkSignedTransfer(serialized: string, exp: TxExpectation): string | null {
  // 0x76 = Tempo tx the sender pays for; 0x78 = the same, signed by the sender and awaiting the
  // server's fee-payer signature (what mppx emits for feePayer challenges).
  const kind = serialized.slice(0, 4);
  if (!/^0x7[68][0-9a-fA-F]+$/.test(serialized)) return "not a Tempo (0x76/0x78) transaction";
  if (kind === "0x78" && !exp.sponsored) return "fee-payer envelope for an unsponsored charge";
  if (kind === "0x76" && exp.sponsored) return "self-paid envelope for a sponsored charge";
  let tx: Record<string, unknown>;
  try {
    tx = Transaction.deserialize(serialized as `0x76${string}`) as Record<string, unknown>;
  } catch (e) {
    return `undecodable: ${e instanceof Error ? e.message : String(e)}`;
  }
  if (tx.chainId !== TEMPO_MAINNET_CHAIN_ID) return `chainId ${String(tx.chainId)} is not 4217`;
  if (normAddr(tx.from) !== normAddr(exp.payer)) return `signer ${String(tx.from)} is not the payer`;
  const calls = tx.calls as { to?: string; data?: `0x${string}`; value?: bigint }[] | undefined;
  if (!Array.isArray(calls) || calls.length !== 1) return `expected 1 call, got ${Array.isArray(calls) ? calls.length : "none"}`;
  const call = calls[0]!;
  if (normAddr(call.to) !== USDC_E) return `call target ${String(call.to)} is not USDC.e`;
  if (call.value !== undefined && call.value !== 0n) return "call carries value";
  if (!call.data) return "call has no data";
  let decoded: { functionName: string; args?: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: Abis.tip20, data: call.data }) as { functionName: string; args?: readonly unknown[] };
  } catch {
    return "call data is not a TIP-20 function";
  }
  if (decoded.functionName !== "transfer" && decoded.functionName !== "transferWithMemo")
    return `function ${decoded.functionName} is not transfer/transferWithMemo`;
  const [to, amount] = decoded.args ?? [];
  if (normAddr(to) !== normAddr(exp.recipient)) return `transfer to ${String(to)} is not the recipient`;
  if (amount !== exp.amount) return `transfer amount ${String(amount)} != ${exp.amount}`;
  const feeToken = tx.feeToken;
  if (!exp.sponsored && feeToken !== undefined && normAddr(feeToken) !== USDC_E)
    return `self-paid fee in ${String(feeToken)}, not USDC.e`;
  if (tx.authorizationList !== undefined && Array.isArray(tx.authorizationList) && tx.authorizationList.length > 0)
    return "carries an authorization list";
  if (tx.keyAuthorization !== undefined && tx.keyAuthorization !== null) return "carries a key authorization";
  return null;
}
