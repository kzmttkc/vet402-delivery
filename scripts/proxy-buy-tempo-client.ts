/**
 * Buy one seller answer through vet402's proxy buy on Tempo, as an agent would (src/proxy-buy/tempo-client.ts).
 *
 *   npx tsx scripts/proxy-buy-tempo-client.ts --url <seller endpoint>            # dry run: read the 402, sign, check, send nothing
 *   npx tsx scripts/proxy-buy-tempo-client.ts --url <seller endpoint> --send     # pay and print the answer's headers
 *
 * Options:
 *   --origin <url>     vet402 (default https://vet402-delivery.vercel.app)
 *   --max <usdc>       the most this run may pay, seller price + fee (default 0.01)
 *   --key <path>       the agent's key file, {"privateKey":"0x..."} (default .keys/proxy/tempo-test-agent.json)
 *   --out <path>       with --send: write the answer's body there (default: print its first 300 bytes)
 * Environment: VET402_PROXY_TEMPO_RECEIVE (the recipient the 402 must name; default vet402's), VET402_PROXY_TEMPO_PAYER
 * (vet402's proxy payer, never the agent; default vet402's), TEMPO_RPC_URL.
 *
 * Nothing is signed unless the 402 names that recipient, chain 4217, USDC.e and a total within --max. The key and
 * the signed transaction are never printed; a dry run prints only the transaction's hash.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { atomicToUnits, TEMPO_RPC_URL } from "../src/tempo/constants.js";
import { signerFor } from "../src/tempo/chain.js";
import { buyOnTempo, DEFAULT_CLIENT_MAX_ATOMIC, DEFAULT_TEMPO_PAYER, DEFAULT_TEMPO_RECEIVE } from "../src/proxy-buy/tempo-client.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function usdcToAtomic(v: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(v)) throw new Error("--max: expected a USDC amount like 0.01");
  const [w, f = ""] = v.split(".");
  return BigInt(w!) * 1_000_000n + BigInt(f.padEnd(6, "0"));
}

async function main(): Promise<void> {
  const target = arg("--url");
  if (!target || !/^https:\/\//.test(target)) throw new Error("--url <https seller endpoint> is required");
  const origin = arg("--origin") ?? "https://vet402-delivery.vercel.app";
  const maxAtomic = arg("--max") ? usdcToAtomic(arg("--max")!) : DEFAULT_CLIENT_MAX_ATOMIC;
  const keyPath = arg("--key") ?? join(import.meta.dirname, "..", ".keys", "proxy", "tempo-test-agent.json");
  let account;
  try {
    const k = JSON.parse(readFileSync(keyPath, "utf8")) as { privateKey?: unknown };
    if (typeof k.privateKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(k.privateKey)) throw new Error();
    account = privateKeyToAccount(k.privateKey as `0x${string}`);
  } catch {
    throw new Error(`the key file ${keyPath} is missing or not {"privateKey":"0x<32 bytes>"}`); // never echo the content
  }
  const send = process.argv.includes("--send");
  const expectedReceive = process.env.VET402_PROXY_TEMPO_RECEIVE ?? DEFAULT_TEMPO_RECEIVE;
  console.log(JSON.stringify({ mode: send ? "send" : "dry-run", agent: account.address, origin, target, expectedReceive, max: atomicToUnits(maxAtomic) }));
  const r = await buyOnTempo(
    // The agent is never one of vet402's own wallets: the receive wallet and the census payer are refused by the
    // client itself, and the proxy payer here (VET402_PROXY_TEMPO_PAYER, default the deployment's).
    { origin, target, expectedReceive, maxAtomic, send, notAgent: [process.env.VET402_PROXY_TEMPO_PAYER ?? DEFAULT_TEMPO_PAYER] },
    { fetchImpl: (u, init) => fetch(u, init), signer: signerFor(account, http(process.env.TEMPO_RPC_URL ?? TEMPO_RPC_URL, { timeout: 15_000, retryCount: 1 })) },
  );
  if (!r.ok) {
    console.log(JSON.stringify(r));
    process.exitCode = 1;
    return;
  }
  if (!r.sent) {
    console.log(JSON.stringify({ ...r, amount: atomicToUnits(r.amountAtomic), note: "signed and checked; nothing sent" }));
    return;
  }
  const out = arg("--out");
  if (out) writeFileSync(out, r.body);
  const { body, ...rest } = r;
  console.log(JSON.stringify({ ...rest, amount: atomicToUnits(r.amountAtomic), bodyBytes: body.byteLength, ...(out ? { wrote: out } : { bodyHead: Buffer.from(body.subarray(0, 300)).toString("utf8") }) }, null, 2));
  if (r.status !== 200) process.exitCode = 1;
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
