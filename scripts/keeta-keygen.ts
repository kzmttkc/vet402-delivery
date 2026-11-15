/**
 * Create ~/.vet402/keeta-payer.json and keeta-payer.pub once, after tests and a dry run.
 * Run at most once on a machine that will pay on Keeta: npm run keeta-keygen (or tsx this file).
 */
import KeetaNet from "@keetanetwork/keetanet-client";
import { KEETA_KEY_DIR } from "../src/keeta/constants.js";
import { writeKeetaKey } from "../src/keeta/keygen.js";

try {
  const address = writeKeetaKey({
    dir: KEETA_KEY_DIR,
    generateSeed: () => Buffer.from(KeetaNet.lib.Account.generateRandomSeed()).toString("hex"),
    addressOf: (seed) => KeetaNet.lib.Account.fromSeed(seed, 0).publicKeyString.toString(),
  });
  console.log(address);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}