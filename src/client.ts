/**
 * The x402 v2 SVM client, wired so it can only pay the accept vet402 already checked.
 * The key file is read here and nowhere else; its bytes are never logged.
 */
import { readFileSync, statSync } from "node:fs";
import { createKeyPairSignerFromBytes, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { ExactSvmSchemeV1 } from "@x402/svm/v1";
import { toClientSvmSigner } from "@x402/svm";
import { PAYER_ADDRESS, SOLANA_MAINNET } from "./constants.js";
import { normalizeAccept, type SolAccept } from "./guard.js";
import type { CreatedPayment } from "./pay.js";

export async function loadPayer(keyFile: string): Promise<KeyPairSigner> {
  const mode = statSync(keyFile).mode & 0o777;
  if (mode & 0o077) throw new Error(`key file must be mode 600 (is ${mode.toString(8)})`);
  let arr: number[];
  try {
    arr = JSON.parse(readFileSync(keyFile, "utf8")) as number[];
  } catch {
    throw new Error("key file is not valid JSON"); // never echo the file: a parse error quotes its contents
  }
  if (!Array.isArray(arr) || arr.length !== 64) throw new Error("key file is not a 64-byte solana-keygen array");
  const signer = await createKeyPairSignerFromBytes(Uint8Array.from(arr));
  if (signer.address !== PAYER_ADDRESS) throw new Error(`key file address ${signer.address} != expected payer ${PAYER_ADDRESS}`);
  return signer;
}

/** A throwaway signer for dry runs: the transaction is built and read back, never sent. */
export async function throwawaySigner(): Promise<KeyPairSigner> {
  return generateKeyPairSigner();
}

function sameAccept(raw: Record<string, unknown>, a: SolAccept): boolean {
  const n = normalizeAccept(raw);
  return n.scheme === a.scheme && n.network === a.network && n.asset === a.asset && n.payTo === a.payTo && n.amount === a.amount &&
    n.extra?.feePayer === a.extra?.feePayer;
}

export function makeCreatePayment(signer: KeyPairSigner, rpcUrl: string) {
  return async (pr: PaymentRequired, accept: SolAccept): Promise<CreatedPayment> => {
    // The selector can only return the accept that passed checkAccept; anything else throws.
    const client = new x402Client((_v, reqs) => {
      const hit = (reqs as unknown as Record<string, unknown>[]).find((r) => sameAccept(r, accept));
      if (!hit) throw new Error("locked accept not offered to the selector");
      return hit as never;
    });
    // Library-side cap as a second fence (per payment, USD).
    client.setSpendControls({ maxAmountPerPayment: "$0.10" });
    // Solana mainnet only, v2 and v1 (PayAI lists both), with our RPC.
    const svmSigner = toClientSvmSigner(signer);
    client.register(SOLANA_MAINNET as never, new ExactSvmScheme(svmSigner, { rpcUrl }));
    client.registerV1("solana", new ExactSvmSchemeV1(svmSigner, { rpcUrl }));
    const http = new x402HTTPClient(client);
    const payload = await http.createPaymentPayload(pr);
    const tx = (payload.payload as { transaction?: unknown }).transaction;
    if (typeof tx !== "string") throw new Error("payload has no transaction");
    const accepted = (payload as { accepted?: Record<string, unknown> }).accepted;
    if (accepted && !sameAccept(accepted, accept)) throw new Error("payload.accepted differs from the locked accept");
    return { headers: http.encodePaymentSignatureHeader(payload), txBase64: tx };
  };
}
