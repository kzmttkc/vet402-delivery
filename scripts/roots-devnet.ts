/**
 * Run the observation-roots program on Solana devnet with the real published records.
 *
 *   solana program deploy solana-program/target/deploy/observation_roots.so \
 *     --program-id .keys/devnet/observation_roots-program.json --keypair .keys/devnet/deployer.json -u devnet
 *   npx tsx scripts/roots-devnet.ts all        # fund the poster, initialize, post 2026-09-28 and 2026-09-29, verify
 *
 * Steps: fund | init | post | verify | all. Refuses any RPC whose genesis is not devnet.
 * Keys (never printed): .keys/devnet/deployer.json (upgrade authority), .keys/devnet/poster.json (posting authority).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountRole, address, createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { jsonRpc } from "../src/chain.js";
import {
  configPda,
  decodeVerifyResult,
  fieldsFromObservation,
  GATE_EXAMPLE_PROGRAM_DEVNET,
  initializeIx,
  requireDeliveredIx,
  ROOTS_PROGRAM_DEVNET,
  SYSTEM_PROGRAM,
  verifyIx,
} from "../src/receipt/roots-program.js";
import { postRootArgsFromRecord, sendPostRoot } from "../src/receipt/roots-post.js";
import { customError, sendIxs, simulateIxs } from "../src/receipt/roots-tx.js";
import type { Observation } from "../src/receipt/types.js";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DAYS = ["2026-09-28", "2026-09-29"];
const rpc = jsonRpc(process.env.DEVNET_RPC ?? "https://api.devnet.solana.com");
const step = process.argv[2] ?? "all";

async function loadKey(name: string): Promise<KeyPairSigner> {
  const f = join(ROOT, ".keys/devnet", name);
  if (statSync(f).mode & 0o077) throw new Error(`${f} must be mode 600`);
  let arr: number[];
  try {
    arr = JSON.parse(readFileSync(f, "utf8")) as number[];
  } catch {
    throw new Error(`${f} is not valid JSON`); // never echo the file
  }
  return createKeyPairSignerFromBytes(Uint8Array.from(arr));
}

function readDay(day: string): Observation[] {
  const dir = join(ROOT, "data/records", day);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Observation)
    .sort((a, b) => a.observer.sequence - b.observer.sequence);
}

if ((await rpc("getGenesisHash", [])) !== DEVNET_GENESIS) throw new Error("RPC is not Solana devnet; refusing");
const deployer = await loadKey("deployer.json");
const poster = await loadKey("poster.json");
const out: Record<string, unknown> = { program: ROOTS_PROGRAM_DEVNET, gate: GATE_EXAMPLE_PROGRAM_DEVNET, deployer: deployer.address, poster: poster.address };

if (step === "fund" || step === "all") {
  const bal = ((await rpc("getBalance", [poster.address, { commitment: "confirmed" }])) as { value: number }).value;
  if (bal < 20_000_000) {
    const data = new Uint8Array(12);
    const dv = new DataView(data.buffer);
    dv.setUint32(0, 2, true); // SystemProgram::Transfer
    dv.setBigUint64(4, 50_000_000n, true);
    const r = await sendIxs(rpc, deployer, [
      { programAddress: address(SYSTEM_PROGRAM), accounts: [{ address: deployer.address, role: AccountRole.WRITABLE_SIGNER }, { address: poster.address, role: AccountRole.WRITABLE }], data },
    ]);
    if (r.err) throw new Error(`fund failed: ${JSON.stringify(r.err)}`);
    out.fund = r.signature;
  }
}

if (step === "init" || step === "all") {
  const cfg = (await rpc("getAccountInfo", [await configPda(ROOTS_PROGRAM_DEVNET), { encoding: "base64", commitment: "confirmed" }])) as { value: unknown };
  if (!cfg.value) {
    const r = await sendIxs(rpc, deployer, [await initializeIx({ program: ROOTS_PROGRAM_DEVNET, payer: deployer.address, authority: poster.address })]);
    if (r.err) throw new Error(`initialize failed: ${JSON.stringify(r.err)} ${r.logs.join(" | ")}`);
    out.initialize = r.signature;
  } else out.initialize = "already initialized";
}

if (step === "post" || step === "all") {
  const posts: Record<string, unknown> = {};
  for (const day of DAYS) {
    const a = postRootArgsFromRecord(readDay(day)[0]!);
    posts[day] = { root: a.root, count: a.count, seq: [a.seqStart, a.seqEnd], ...(await sendPostRoot({ rpc, program: ROOTS_PROGRAM_DEVNET, feePayer: poster.address, loadSigner: async () => poster }, a)) };
  }
  out.post = posts;
}

if (step === "verify" || step === "all") {
  const gateDeployed = ((await rpc("getAccountInfo", [GATE_EXAMPLE_PROGRAM_DEVNET, { encoding: "base64", commitment: "confirmed" }])) as { value: unknown }).value !== null;
  const verify: Record<string, unknown> = {};
  for (const day of DAYS) {
    const recs = readDay(day);
    let ok = 0;
    for (const o of recs) {
      const s = await simulateIxs(rpc, poster.address, [await verifyIx({ program: ROOTS_PROGRAM_DEVNET, day, fields: fieldsFromObservation(o), proof: o.anchor!.proof })]);
      if (s.err === null && s.returnData && decodeVerifyResult(s.returnData).verdict === o.verdict.code) ok++;
      await new Promise((r) => setTimeout(r, 150)); // public RPC rate limit
    }
    const landed: Record<string, unknown>[] = [];
    for (const o of [recs.find((x) => x.verdict.code === "DELIVERED")!, recs.find((x) => x.verdict.code === "NOT_DELIVERED")!]) {
      const r = await sendIxs(rpc, poster, [await verifyIx({ program: ROOTS_PROGRAM_DEVNET, day, fields: fieldsFromObservation(o), proof: o.anchor!.proof })]);
      landed.push({ record: o.id, verdict: r.returnData ? decodeVerifyResult(r.returnData).verdict : null, err: r.err, tx: r.signature });
    }
    const tampered = recs.find((x) => x.verdict.code === "NOT_DELIVERED")!;
    const t = await simulateIxs(rpc, poster.address, [
      await verifyIx({ program: ROOTS_PROGRAM_DEVNET, day, fields: { ...fieldsFromObservation(tampered), verdict: "DELIVERED" }, proof: tampered.anchor!.proof }),
    ]);
    const entry: Record<string, unknown> = { simulated: `${ok}/${recs.length} records verified with their own verdict`, landed, tamperedVerdictError: customError(t.err) };
    if (gateDeployed) {
      const o = recs.find((x) => x.verdict.code === "DELIVERED")!;
      const g = await sendIxs(rpc, poster, [
        await requireDeliveredIx({ gate: GATE_EXAMPLE_PROGRAM_DEVNET, program: ROOTS_PROGRAM_DEVNET, payTo: o.payment.payTo, transaction: o.payment.transaction, day, fields: fieldsFromObservation(o), proof: o.anchor!.proof }),
      ]);
      const nd = recs.find((x) => x.verdict.code === "NOT_DELIVERED")!;
      const gn = await simulateIxs(rpc, poster.address, [
        await requireDeliveredIx({ gate: GATE_EXAMPLE_PROGRAM_DEVNET, program: ROOTS_PROGRAM_DEVNET, payTo: nd.payment.payTo, transaction: nd.payment.transaction, day, fields: fieldsFromObservation(nd), proof: nd.anchor!.proof }),
      ]);
      entry.gate = { delivered: { record: o.id, err: g.err, tx: g.signature, conditionMet: g.logs.some((l) => l.includes("condition met")) }, notDeliveredError: customError(gn.err) };
    }
    verify[day] = entry;
  }
  out.verify = verify;
}

console.log(JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
