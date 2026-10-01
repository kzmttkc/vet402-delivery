/**
 * Run the example escrow on Solana devnet against observation-roots deployed there under a devnet program id,
 * with the real roots of 2026-09-28 to 2026-09-30 and two real published records: one DELIVERED (the seller is
 * paid) and one NOT_DELIVERED (the buyer gets the deposit back). Devnet only: no mainnet key, no mainnet RPC.
 *
 *   npx tsx scripts/escrow-devnet.ts build     # build observation-roots under the devnet id, and the escrow
 *   npx tsx scripts/escrow-devnet.ts deploy    # solana program deploy, both programs (devnet SOL from the faucet)
 *   npx tsx scripts/escrow-devnet.ts init      # initialize observation-roots, fund the poster, post the three roots
 *   npx tsx scripts/escrow-devnet.ts demo      # test mint, then deposit + settle for one DELIVERED and one NOT_DELIVERED record
 *   npx tsx scripts/escrow-devnet.ts all
 *
 * Keys (git-ignored, mode 600, never printed): .keys/devnet-escrow/deployer.json (pays, upgrade authority, mint
 * authority), poster.json (posting authority), buyer.json, roots-program.json (observation-roots devnet id),
 * escrow-program.json (must hold ESCROW_EXAMPLE_PROGRAM), mint.json (the test token).
 *
 * --rpc <url> another RPC. Only devnet's genesis is accepted, or a validator on 127.0.0.1 with --local (a dry run;
 * its output goes to results/, not data/). The devnet run writes solana-program/escrow-devnet.json (read by scripts/build-site.ts for escrow.html).
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createKeyPairSignerFromBytes, type KeyPairSigner } from "@solana/kit";
import { jsonRpc } from "../src/chain.js";
import { DEVNET_GENESIS, initializeIx, configPda } from "../src/receipt/roots-program.js";
import { postRootArgsFromRecord, sendPostRoot } from "../src/receipt/roots-post.js";
import { sendIxs } from "../src/receipt/roots-tx.js";
import type { Observation } from "../src/receipt/types.js";
import { decodeTokenAccount, depositIx, ESCROW_EXAMPLE_PROGRAM, escrowPda, purchaseOf, settleWithRecordIx } from "../src/escrow/escrow-program.js";
import { ata, createAtaIx, createMintIxs, mintToIx, transferLamportsIx } from "../src/escrow/test-token.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KEYS = join(ROOT, ".keys/devnet-escrow");
const SP = join(ROOT, "solana-program");
const BUILD = join(SP, "target/devnet-src");
const OUT = join(SP, "target/deploy-devnet");
const MAINNET_ROOTS_ID = "EvDMa6KWbFGT48L9oce8U9SwxCWaAKR2aZEJNX8JeZC3";
const DAYS = ["2026-09-28", "2026-09-29", "2026-09-30"];
const SOLANA_BIN = process.env.SOLANA_BIN ?? join(process.env.HOME ?? "", ".local/share/solana-v4.3.0/solana-release/bin");
const CARGO_BIN = process.env.CARGO_BIN ?? "/opt/homebrew/opt/rustup/bin";

const args = process.argv.slice(2);
const step = args.find((a) => !a.startsWith("--")) ?? "all";
const argValue = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const local = args.includes("--local");
const rpcUrl = argValue("--rpc") ?? "https://api.devnet.solana.com";
if (local && !/^http:\/\/127\.0\.0\.1:\d+$/.test(rpcUrl)) throw new Error("--local needs --rpc http://127.0.0.1:<port>");
const rpc = jsonRpc(rpcUrl);
const cluster = local ? "local" : "devnet";
const resultFile = local ? join(ROOT, "results/escrow-devnet-local.json") : join(ROOT, "solana-program/escrow-devnet.json");

function keyFile(name: string): string {
  const f = join(KEYS, name);
  if (statSync(f).mode & 0o077) throw new Error(`${f} must be mode 600`);
  return f;
}
async function loadKey(name: string): Promise<KeyPairSigner> {
  let arr: number[];
  try {
    arr = JSON.parse(readFileSync(keyFile(name), "utf8")) as number[];
  } catch {
    throw new Error(`${name} is not a solana-keygen file`); // never echo the file
  }
  return createKeyPairSignerFromBytes(Uint8Array.from(arr));
}
const sh = (cmd: string, a: string[], opts: { cwd?: string } = {}) =>
  execFileSync(cmd, a, { cwd: opts.cwd ?? ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PATH: `${SOLANA_BIN}:${CARGO_BIN}:${process.env.PATH}` } }).toString();

function readDay(day: string): Observation[] {
  const dir = join(ROOT, "data/records", day);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Observation)
    .sort((a, b) => a.observer.sequence - b.observer.sequence);
}

const state: Record<string, unknown> = existsSync(resultFile) ? (JSON.parse(readFileSync(resultFile, "utf8")) as Record<string, unknown>) : {};
const save = () => {
  mkdirSync(dirname(resultFile), { recursive: true });
  writeFileSync(resultFile, JSON.stringify(state, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
};

const genesis = (await rpc("getGenesisHash", [])) as string;
if (!local && genesis !== DEVNET_GENESIS) throw new Error("RPC is not Solana devnet; refusing");

const deployer = await loadKey("deployer.json");
const poster = await loadKey("poster.json");
const buyer = await loadKey("buyer.json");
const mintKey = await loadKey("mint.json");
const rootsProgram = (await loadKey("roots-program.json")).address;
const escrowKey = (await loadKey("escrow-program.json")).address;
if (escrowKey !== ESCROW_EXAMPLE_PROGRAM) throw new Error(`escrow-program.json holds ${escrowKey}, not ${ESCROW_EXAMPLE_PROGRAM}`);
if (rootsProgram === MAINNET_ROOTS_ID) throw new Error("the devnet observation-roots id must differ from mainnet's");
const explorer = (sig: string) => (local ? null : `https://explorer.solana.com/tx/${sig}?cluster=devnet`);
Object.assign(state, { kind: "vet402-escrow-devnet", cluster, rootsProgram, escrowProgram: ESCROW_EXAMPLE_PROGRAM, mint: mintKey.address, buyer: buyer.address, poster: poster.address, deployer: deployer.address });

if (step === "build" || step === "all") {
  // observation-roots as it is, except its declare_id: the devnet program id. The escrow links against that copy.
  rmSync(BUILD, { recursive: true, force: true });
  mkdirSync(BUILD, { recursive: true });
  for (const f of ["Cargo.toml", "Cargo.lock"]) cpSync(join(SP, f), join(BUILD, f));
  cpSync(join(SP, "programs"), join(BUILD, "programs"), { recursive: true });
  const lib = join(BUILD, "programs/observation-roots/src/lib.rs");
  const src = readFileSync(lib, "utf8");
  const decl = `declare_id!("${MAINNET_ROOTS_ID}");`;
  if (src.split(decl).length !== 2) throw new Error("observation-roots lib.rs: declare_id not found exactly once");
  writeFileSync(lib, src.replace(decl, `declare_id!("${rootsProgram}");`));
  for (const p of ["observation-roots", "delivery-escrow-example"]) sh("cargo-build-sbf", ["--arch", "v3", "--manifest-path", join(BUILD, "programs", p, "Cargo.toml"), "--sbf-out-dir", OUT]);
  state.build = { observation_roots: sh("shasum", ["-a", "256", join(OUT, "observation_roots.so")]).split(" ")[0], delivery_escrow_example: sh("shasum", ["-a", "256", join(OUT, "delivery_escrow_example.so")]).split(" ")[0] };
  console.log(`built in ${OUT}`);
}

if (step === "deploy" || step === "all") {
  const bal = ((await rpc("getBalance", [deployer.address, { commitment: "confirmed" }])) as { value: number }).value;
  console.log(`deployer balance ${bal / 1e9} SOL`);
  const deployed: Record<string, string> = {};
  for (const [so, key, id] of [
    ["observation_roots.so", "roots-program.json", rootsProgram],
    ["delivery_escrow_example.so", "escrow-program.json", ESCROW_EXAMPLE_PROGRAM],
  ] as const) {
    const exists = ((await rpc("getAccountInfo", [id, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" }])) as { value: unknown }).value;
    if (exists) {
      deployed[id] = "already deployed";
      continue;
    }
    const out = sh("solana", ["program", "deploy", join(OUT, so), "--program-id", keyFile(key), "--keypair", keyFile("deployer.json"), "--upgrade-authority", keyFile("deployer.json"), "--url", rpcUrl, "--commitment", "confirmed", "--output", "json"]);
    deployed[id] = (JSON.parse(out) as { signature?: string }).signature ?? "deployed";
  }
  state.deploy = deployed;
  save();
}

if (step === "init" || step === "all") {
  const cfg = ((await rpc("getAccountInfo", [await configPda(rootsProgram), { encoding: "base64", commitment: "confirmed" }])) as { value: unknown }).value;
  const init: Record<string, unknown> = {};
  if (!cfg) {
    const r = await sendIxs(rpc, deployer, [await initializeIx({ program: rootsProgram, payer: deployer.address, authority: poster.address })]);
    if (r.err) throw new Error(`initialize failed: ${JSON.stringify(r.err)} ${r.logs.join(" | ")}`);
    init.initialize = r.signature;
  }
  const pbal = ((await rpc("getBalance", [poster.address, { commitment: "confirmed" }])) as { value: number }).value;
  if (pbal < 10_000_000) {
    const r = await sendIxs(rpc, deployer, [transferLamportsIx(deployer.address, poster.address, 20_000_000n)]);
    if (r.err) throw new Error(`funding the poster failed: ${JSON.stringify(r.err)}`);
    init.fundPoster = r.signature;
  }
  const posts: Record<string, unknown> = {};
  for (const day of DAYS) {
    const a = postRootArgsFromRecord(readDay(day)[0]!);
    const sent = await sendPostRoot({ rpc, program: rootsProgram, feePayer: poster.address, loadSigner: async () => poster }, a);
    posts[day] = { root: a.root, count: a.count, state: sent.state, account: sent.pda, ...(sent.signature ? { tx: sent.signature, url: explorer(sent.signature) } : {}) };
  }
  state.init = { ...((state.init as object) ?? {}), ...init, posts };
  save();
}

if (step === "demo" || step === "all") {
  const records = DAYS.flatMap((d) => readDay(d)).filter((o) => o.payment.network.startsWith("solana:"));
  // The latest day's first DELIVERED and first NOT_DELIVERED record. NOT_DELIVERED records are published only for sellers vet402 has told.
  const pick = (code: string) => [...records].reverse().find((o) => o.verdict.code === code)!;
  const cases = [pick("DELIVERED"), pick("NOT_DELIVERED")];
  // The test token: a 6-decimal mint standing in for USDC, minted to the buyer.
  const mintInfo = ((await rpc("getAccountInfo", [mintKey.address, { encoding: "base64", commitment: "confirmed" }])) as { value: unknown }).value;
  const demo: Record<string, unknown> = {};
  if (!mintInfo) {
    const rent = BigInt((await rpc("getMinimumBalanceForRentExemption", [82])) as number);
    const r = await sendIxs(rpc, deployer, createMintIxs({ payer: deployer.address, mint: mintKey, authority: deployer.address, rentLamports: rent }), [mintKey]);
    if (r.err) throw new Error(`mint failed: ${JSON.stringify(r.err)}`);
    demo.createMint = r.signature;
  }
  const bbal = ((await rpc("getBalance", [buyer.address, { commitment: "confirmed" }])) as { value: number }).value;
  if (bbal < 20_000_000) {
    const r = await sendIxs(rpc, deployer, [transferLamportsIx(deployer.address, buyer.address, 50_000_000n)]);
    if (r.err) throw new Error(`funding the buyer failed: ${JSON.stringify(r.err)}`);
  }
  const buyerTokens = await ata(buyer.address, mintKey.address);
  const need = cases.reduce((t, o) => t + BigInt(o.payment.amount), 0n);
  const r0 = await sendIxs(rpc, deployer, [await createAtaIx(deployer, buyer.address, mintKey.address), await mintToIx({ mint: mintKey.address, to: buyerTokens, authority: deployer, amount: need })]);
  if (r0.err) throw new Error(`minting to the buyer failed: ${JSON.stringify(r0.err)}`);
  const runs: Record<string, unknown>[] = [];
  for (const o of cases) {
    const p = purchaseOf(o);
    const delivered = o.verdict.code === "DELIVERED";
    const sellerTokens = await ata(p.payTo, mintKey.address);
    if (delivered) {
      const r = await sendIxs(rpc, deployer, [await createAtaIx(deployer, p.payTo, mintKey.address)]);
      if (r.err) throw new Error(`seller token account failed: ${JSON.stringify(r.err)}`);
    }
    const destination = delivered ? sellerTokens : buyerTokens;
    const balance = async (a: string) =>
      decodeTokenAccount(Uint8Array.from(Buffer.from(((await rpc("getAccountInfo", [a, { encoding: "base64", commitment: "confirmed" }])) as { value: { data: [string, string] } }).value.data[0], "base64"))).amount;
    const slot = (await rpc("getSlot", [{ commitment: "confirmed" }])) as number;
    const now = BigInt((await rpc("getBlockTime", [slot])) as number);
    const dep = await sendIxs(rpc, buyer, [await depositIx({ program: ESCROW_EXAMPLE_PROGRAM, buyer: buyer.address, buyerTokens, mint: mintKey.address, purchase: p, deadline: now + 7n * 86_400n })]);
    if (dep.err) throw new Error(`deposit failed for ${o.id}: ${JSON.stringify(dep.err)} ${dep.logs.join(" | ")}`);
    const before = await balance(destination);
    // Settled by the deployer key, not the buyer: anyone can send it.
    const set = await sendIxs(rpc, deployer, [await settleWithRecordIx({ program: ESCROW_EXAMPLE_PROGRAM, rootsProgram, buyer: buyer.address, destination, record: o })]);
    if (set.err) throw new Error(`settle failed for ${o.id}: ${JSON.stringify(set.err)} ${set.logs.join(" | ")}`);
    const after = await balance(destination);
    if (after - before !== p.amount) throw new Error(`${o.id}: destination moved ${after - before}, expected ${p.amount}`);
    const escrowGone = ((await rpc("getAccountInfo", [await escrowPda(ESCROW_EXAMPLE_PROGRAM, buyer.address, p.transaction), { encoding: "base64", commitment: "confirmed" }])) as { value: unknown }).value === null;
    runs.push({
      record: o.id,
      recordDay: o.anchor!.day,
      verdict: o.verdict.code,
      outcome: delivered ? "released to the seller" : "returned to the buyer",
      amount: p.amount.toString(),
      decimals: o.payment.decimals,
      network: p.network,
      payTo: p.payTo,
      mainnetTransaction: p.transaction,
      deposit: { tx: dep.signature, url: explorer(dep.signature) },
      settle: { tx: set.signature, url: explorer(set.signature), bytes: set.txBytes, log: set.logs.find((l) => l.includes("released") || l.includes("refunded")) ?? null },
      destination,
      escrowClosed: escrowGone,
    });
  }
  state.demo = { ...demo, ranAt: new Date().toISOString(), runs };
  save();
}

console.log(JSON.stringify(state, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
