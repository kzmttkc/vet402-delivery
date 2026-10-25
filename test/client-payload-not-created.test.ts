// 2026-10-25: 47620.xyz served a v2 402 whose accept says network "solana" (caip2 in a separate field).
// The real x402 client cannot build a payment from it; makeCreatePayment must say so with PayloadNotCreatedError
// (the run skips that seller) and not a plain Error (which would stop the run as tx_check_failed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSigner } from "@solana/kit";
import type { PaymentRequired } from "@x402/core/types";
import { makeCreatePayment } from "../src/client.js";
import { normalizeAccept, PayloadNotCreatedError } from "../src/guard.js";
import { SOLANA_MAINNET, USDC_MINT } from "../src/constants.js";

test("makeCreatePayment: a v2 accept with network \"solana\" is PayloadNotCreatedError, before any RPC call", async () => {
  const signer = await generateKeyPairSigner();
  const payTo = (await generateKeyPairSigner()).address;
  const feePayer = (await generateKeyPairSigner()).address;
  const rawAccept = { scheme: "exact", network: "solana", caip2: SOLANA_MAINNET, asset: USDC_MINT, amount: "5000", payTo, maxTimeoutSeconds: 60, extra: { feePayer } };
  const pr = { x402Version: 2, resource: { url: "https://seller.test/x" }, accepts: [rawAccept] } as unknown as PaymentRequired;
  const accept = normalizeAccept(rawAccept as unknown as Record<string, unknown>);
  assert.ok(accept, "the guard reads this accept as Solana mainnet");
  // 127.0.0.1:1 refuses connections: a build failure that needed the RPC would surface as a different message
  const create = makeCreatePayment(signer, "http://127.0.0.1:1");
  await assert.rejects(create(pr, accept!), (e: unknown) => e instanceof PayloadNotCreatedError && /No network\/scheme registered/.test((e as Error).message));
});
