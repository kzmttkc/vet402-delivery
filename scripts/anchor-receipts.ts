/**
 * Write one day's Merkle root of x402-observation records into a Solana memo.
 *
 *   npx tsx scripts/anchor-receipts.ts --day 2026-09-28 [--from results/receipts] [--send]
 *
 * Without --send (the default) nothing is signed and nothing is sent: the script recomputes the root
 * from every record of the day, builds the memo transaction, checks it holds nothing but that memo,
 * and asks mainnet to simulate it and to quote its fee.
 *
 * With --send it signs with the Solana payer key (.keys/payer.json, mode 600, must be PAYER_ADDRESS)
 * and sends once. Before sending it writes <from>/<day>/anchor-sent.json; while that file exists the
 * day is never sent again (one root per day). After confirmation it marks every record of the day as
 * anchored (the anchor field is outside the signature) and says to run publish-records again.
 * The fee is the only thing that leaves the wallet; above MAX_FEE_LAMPORTS nothing is signed.
 *
 * RPC: SOLANA_RPC_URL (default: the public mainnet endpoint).
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getBase64EncodedWireTransaction, getSignatureFromTransaction, signTransaction } from "@solana/kit";
import type { Hex } from "viem";
import { loadPayer } from "../src/client.js";
import { jsonRpc } from "../src/chain.js";
import { MEMO_PROGRAM, PAYER_ADDRESS, SOLANA_MAINNET } from "../src/constants.js";
import { compileMemoTx, MAX_MEMO_BYTES } from "../src/receipt/anchor.js";
import { checkAnchorOnChain } from "../src/receipt/chain.js";
import { observationDigest } from "../src/receipt/eip712.js";
import { anchorMemo, buildTree } from "../src/receipt/merkle.js";
import { withAnchorTx } from "../src/receipt/publish.js";
import type { Observation } from "../src/receipt/types.js";

/** 5,000 lamports per signature is the base fee; the memo transaction has one signature and no priority fee. */
const MAX_FEE_LAMPORTS = 10_000;
const SOLANA_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"; // mainnet-beta; CAIP-2 keeps its first 32 characters

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argValue = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) throw new Error(`${name} needs a value`);
  return v;
};
const day = argValue("--day");
if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
  console.error("usage: anchor-receipts.ts --day YYYY-MM-DD [--from results/receipts] [--send]");
  process.exit(2);
}
const send = args.includes("--send");
const dayDir = join(resolve(argValue("--from") ?? join(ROOT, "results", "receipts")), day);
const sentPath = join(dayDir, "anchor-sent.json");
const rpc = jsonRpc(process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com");

// ---------- the day's root, from every record of the day ----------
const files = readdirSync(dayDir).filter((f) => /^obs_\d{4}-\d{2}-\d{2}_\d{6}\.json$/.test(f)).sort();
const obs = files.map((f) => JSON.parse(readFileSync(join(dayDir, f), "utf8")) as Observation).sort((a, b) => a.observer.sequence - b.observer.sequence);
if (obs.length === 0) throw new Error(`${dayDir}: no records`);
const tree = buildTree(obs.map((o) => observationDigest(o)));
const observer = obs[0]!.observer.address;
const seq: [number, number] = [obs[0]!.observer.sequence, obs[obs.length - 1]!.observer.sequence];
for (const [i, o] of obs.entries()) {
  const a = o.anchor;
  if (!a || a.root !== tree.root || a.leafIndex !== i || a.count !== obs.length || a.day !== day || o.observer.address !== observer)
    throw new Error(`${o.id}: its anchor does not match the root recomputed from the ${obs.length} records on disk`);
  if (a.status === "anchored") throw new Error(`${o.id}: ${day} is already anchored in ${a.tx}`);
}
if (seq[1] - seq[0] + 1 !== obs.length) throw new Error(`${day}: sequence ${seq[0]}-${seq[1]} has gaps (${obs.length} records)`);
const memo = anchorMemo({ day, root: tree.root as Hex, count: obs.length, sequenceRange: seq, observerAddress: observer });

// ---------- build, check, simulate, quote ----------
const genesis = (await rpc("getGenesisHash", [])) as string;
if (genesis !== SOLANA_GENESIS) throw new Error(`RPC is not Solana mainnet (genesis ${genesis})`);
const { value: bh } = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])) as { value: { blockhash: string; lastValidBlockHeight: number } };
const tx = compileMemoTx(PAYER_ADDRESS, memo, bh.blockhash, BigInt(bh.lastValidBlockHeight)); // throws unless memo-only
const unsignedWire = getBase64EncodedWireTransaction(tx);
const sim = (await rpc("simulateTransaction", [unsignedWire, { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" }])) as {
  value: { err: unknown; logs: string[] | null; unitsConsumed?: number };
};
const messageB64 = Buffer.from(tx.messageBytes).toString("base64");
const fee = (await rpc("getFeeForMessage", [messageB64, { commitment: "confirmed" }])) as { value: number | null };
const balance = (await rpc("getBalance", [PAYER_ADDRESS, { commitment: "confirmed" }])) as { value: number };
const plan = {
  day,
  network: SOLANA_MAINNET,
  memo,
  memoBytes: new TextEncoder().encode(memo).length,
  maxMemoBytes: MAX_MEMO_BYTES,
  root: tree.root,
  count: obs.length,
  sequenceRange: seq,
  feePayer: PAYER_ADDRESS,
  program: MEMO_PROGRAM,
  simulation: { ok: sim.value.err === null, err: sim.value.err, unitsConsumed: sim.value.unitsConsumed ?? null, logs: sim.value.logs ?? [] },
  feeLamports: fee.value,
  feePayerBalanceLamports: balance.value,
};
console.log(JSON.stringify(plan, null, 2));

if (!send) {
  console.log("simulate only: nothing was signed or sent (pass --send to write the root on chain)");
  process.exit(plan.simulation.ok ? 0 : 1);
}

// ---------- --send: sign and send once ----------
if (!plan.simulation.ok) throw new Error("simulation failed; not sending");
if (fee.value === null || fee.value > MAX_FEE_LAMPORTS) throw new Error(`fee ${fee.value} lamports is over ${MAX_FEE_LAMPORTS}; not sending`);
if (balance.value < fee.value) throw new Error(`fee payer has ${balance.value} lamports; not sending`);
if (existsSync(sentPath)) throw new Error(`${sentPath} exists: ${day} was already sent (or a send was interrupted). Check the chain before anything else.`);
const signer = await loadPayer(join(ROOT, ".keys", "payer.json")); // mode 600, address must be PAYER_ADDRESS
const signed = await signTransaction([signer.keyPair], tx);
const signature = getSignatureFromTransaction(signed);
writeFileSync(sentPath, `${JSON.stringify({ day, root: tree.root, memo, signature, status: "sending", at: new Date().toISOString() }, null, 2)}\n`, { flag: "wx" });
await rpc("sendTransaction", [getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5 }]);

let confirmed = false;
for (let i = 0; i < 60 && !confirmed; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const st = (await rpc("getSignatureStatuses", [[signature]])) as { value: ({ err: unknown; confirmationStatus: string | null } | null)[] };
  const s = st.value[0];
  if (s?.err) throw new Error(`anchor transaction ${signature} failed: ${JSON.stringify(s.err)}`);
  if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) confirmed = true;
  else {
    const height = (await rpc("getBlockHeight", [{ commitment: "confirmed" }])) as number;
    if (height > bh.lastValidBlockHeight && !s) break;
  }
}
if (!confirmed) throw new Error(`anchor transaction ${signature} not confirmed; ${sentPath} stays, so nothing is sent again until the chain is checked`);

const got = (await rpc("getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }])) as { blockTime: number | null } | null;
const anchoredAt = new Date((got?.blockTime ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();
const marked = obs.map((o) => withAnchorTx(o, signature, anchoredAt));
const check = await checkAnchorOnChain(marked[0]!);
if (!check?.ok) throw new Error(`anchor transaction ${signature} confirmed but its memo does not check: ${check?.detail}`);
for (const o of marked) writeFileSync(join(dayDir, `${o.id}.json`), `${JSON.stringify(o, null, 2)}\n`);
writeFileSync(sentPath, `${JSON.stringify({ day, root: tree.root, memo, signature, status: "confirmed", anchoredAt }, null, 2)}\n`);
console.log(`anchored ${day} in ${signature} (${check.detail}); ${marked.length} records marked. Next: npx tsx scripts/publish-records.ts`);
