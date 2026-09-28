/**
 * EIP-712 signing for x402-observation/v0, laid out like the x402 Receipt (offer-and-receipt §5.3):
 *  - domain { name, version: "1", chainId: 1 }: an off-chain signing format, chainId fixed at 1
 *    whatever the payment network (the spec's own reasoning, §3.2)
 *  - the canonical types are fixed here and never transmitted
 *  - optional fields are "" (strings) or 0 (integers) in the signed message
 * The facts a reader cares about sit flat in the message (so a wallet shows them), and
 * `contentHash` = keccak256(JCS(signed body)) binds every other field of the record.
 */
import { hashTypedData, keccak256, recoverTypedDataAddress, stringToBytes, type Hex } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { canonicalize } from "./jcs.js";
import { UNSIGNED_FIELDS, type Observation, type SignedBody } from "./types.js";

export const OBSERVATION_DOMAIN = { name: "x402 observation", version: "1", chainId: 1 } as const;

export const OBSERVATION_TYPES = {
  Observation: [
    { name: "version", type: "uint256" },
    { name: "id", type: "string" },
    { name: "sequence", type: "uint256" },
    { name: "verdict", type: "string" },
    { name: "network", type: "string" },
    { name: "resourceUrl", type: "string" },
    { name: "payer", type: "string" },
    { name: "payTo", type: "string" },
    { name: "asset", type: "string" },
    { name: "amount", type: "string" },
    { name: "transaction", type: "string" },
    { name: "httpStatus", type: "uint256" },
    { name: "responseHash", type: "string" },
    { name: "responseHashAlg", type: "string" },
    { name: "responseHashEncoding", type: "string" },
    { name: "issuedAt", type: "uint256" },
    { name: "contentHash", type: "bytes32" },
  ],
} as const;

export const OBSERVATION_PRIMARY_TYPE = "Observation" as const;

export function signedBody(obs: Observation | SignedBody): SignedBody {
  const copy: Record<string, unknown> = { ...obs };
  for (const k of UNSIGNED_FIELDS) delete copy[k];
  return copy as unknown as SignedBody;
}

/** keccak256 of the RFC 8785 form of everything the signature covers. */
export function contentHash(obs: Observation | SignedBody): Hex {
  return keccak256(stringToBytes(canonicalize(signedBody(obs))));
}

/** The EIP-712 message, derived from the record itself (never transmitted separately). */
export function observationMessage(obs: Observation | SignedBody) {
  return {
    version: BigInt(obs.version),
    id: obs.id,
    sequence: BigInt(obs.observer.sequence),
    verdict: obs.verdict.code,
    network: obs.payment.network,
    resourceUrl: obs.resourceUrl,
    payer: obs.payment.payer,
    payTo: obs.payment.payTo,
    asset: obs.payment.asset,
    amount: obs.payment.amount,
    transaction: obs.payment.transaction,
    httpStatus: BigInt(obs.response.status ?? 0),
    responseHash: obs.response.responseHash ?? "",
    responseHashAlg: obs.response.responseHashAlg ?? "",
    responseHashEncoding: obs.response.responseHashEncoding ?? "",
    issuedAt: BigInt(obs.issuedAt),
    contentHash: contentHash(obs),
  };
}

function typedData(obs: Observation | SignedBody) {
  return {
    domain: OBSERVATION_DOMAIN,
    types: OBSERVATION_TYPES,
    primaryType: OBSERVATION_PRIMARY_TYPE,
    message: observationMessage(obs),
  } as const;
}

/** The EIP-712 digest. Also the input of the Merkle leaf. */
export function observationDigest(obs: Observation | SignedBody): Hex {
  return hashTypedData(typedData(obs));
}

export async function signObservation(obs: Observation, account: PrivateKeyAccount): Promise<Observation> {
  if (obs.observer.address.toLowerCase() !== account.address.toLowerCase())
    throw new Error("observer.address is not the signing key's address");
  const signature = await account.signTypedData(typedData(obs));
  return { ...obs, signature: { format: "eip712", signature } };
}

/** Address that produced `obs.signature` over this exact record; throws if there is no signature. */
export async function recoverObserver(obs: Observation): Promise<string> {
  if (!obs.signature || obs.signature.format !== "eip712") throw new Error("no eip712 signature");
  return recoverTypedDataAddress({ ...typedData(obs), signature: obs.signature.signature as Hex });
}
