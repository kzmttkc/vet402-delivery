/**
 * Mirror a day's memo anchor into the observation-roots program (post_root), so other programs can
 * read the root. The memo stays the primary record: post_root is only built from a day whose records
 * are already anchored and whose memo checks on chain, and it carries exactly the memo's root, count,
 * sequence range and observer.
 *
 *  plan  read the config and the day's PDA, build a transaction holding only post_root, simulate it
 *        and check that the fee payer spends no more than the new account's rent plus the fee.
 *  send  sign, send once, wait, read the PDA back. A second post for the same day cannot land (the
 *        program creates the PDA with `init`), so running it again after an interruption is safe.
 */
import {
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  type Blockhash,
  type KeyPairSigner,
} from "@solana/kit";
import { readFileSync, statSync } from "node:fs";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import type { Hex } from "viem";
import type { Rpc } from "../chain.js";
import {
  configPda,
  DAY_ROOT_ACCOUNT_BYTES,
  dayRootPda,
  decodeConfig,
  decodeDayRoot,
  encodePostRootArgs,
  postRootIx,
  SYSTEM_PROGRAM,
  type PostRootArgs,
} from "./roots-program.js";
import type { Observation } from "./types.js";

/** One signature, no priority fee. */
export const MAX_POST_ROOT_FEE_LAMPORTS = 10_000;

export interface PostRootDeps {
  /** RPC of the cluster the program is deployed on. */
  rpc: Rpc;
  program: string;
  /** The posting authority set in the program's config; pays the fee and the day account's rent. */
  feePayer: string;
  loadSigner: () => Promise<KeyPairSigner>;
  log?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  pollTries?: number;
  pollMs?: number;
}

/** Loads a solana-keygen key file (mode 600) and refuses it unless it is `expected`. Never echoes the file. */
export async function loadKeyFile(file: string, expected: string): Promise<KeyPairSigner> {
  const mode = statSync(file).mode & 0o777;
  if (mode & 0o077) throw new Error(`${file} must be mode 600 (is ${mode.toString(8)})`);
  let arr: number[];
  try {
    arr = JSON.parse(readFileSync(file, "utf8")) as number[];
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  if (!Array.isArray(arr) || arr.length !== 64) throw new Error(`${file} is not a 64-byte solana-keygen array`);
  const signer = await createKeyPairSignerFromBytes(Uint8Array.from(arr));
  if (signer.address !== expected) throw new Error(`${file} holds ${signer.address}, not ${expected}`);
  return signer;
}

/** post_root arguments taken from an anchored record: the same values as the day's memo. */
export function postRootArgsFromRecord(o: Observation): PostRootArgs {
  const a = o.anchor;
  if (!a || a.status !== "anchored" || !a.tx) throw new Error(`${o.id}: not anchored; post_root only mirrors a memo that is on chain`);
  return { day: a.day, root: a.root as Hex, count: a.count, seqStart: a.sequenceRange[0], seqEnd: a.sequenceRange[1], observer: a.observerAddress as Hex };
}

type AccountInfo = { value: { data: [string, string]; owner: string; lamports: number } | null };

async function account(rpc: Rpc, addr: string): Promise<AccountInfo["value"]> {
  return ((await rpc("getAccountInfo", [addr, { encoding: "base64", commitment: "confirmed" }])) as AccountInfo).value;
}

const b64 = (s: string) => Uint8Array.from(Buffer.from(s, "base64"));

function sameRoot(onChain: ReturnType<typeof decodeDayRoot>, a: PostRootArgs): boolean {
  return (
    onChain.root.toLowerCase() === a.root.toLowerCase() &&
    onChain.count === a.count &&
    onChain.seqStart === BigInt(a.seqStart) &&
    onChain.seqEnd === BigInt(a.seqEnd) &&
    onChain.observer.toLowerCase() === a.observer.toLowerCase()
  );
}

/** Refuse anything but one post_root instruction to `program` with exactly its four accounts. */
export async function assertPostRootOnly(messageBytes: Parameters<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>[0], d: Pick<PostRootDeps, "program" | "feePayer">, a: PostRootArgs): Promise<void> {
  const m = getCompiledTransactionMessageDecoder().decode(messageBytes) as unknown as {
    header: { numSignerAccounts: number; numReadonlySignerAccounts: number; numReadonlyNonSignerAccounts: number };
    staticAccounts: string[];
    instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[];
    addressTableLookups?: unknown[];
  };
  const fail = (why: string): never => {
    throw new Error(`post_root transaction refused: ${why}`);
  };
  const want = [d.feePayer, await dayRootPda(d.program, a.day), await configPda(d.program), SYSTEM_PROGRAM, d.program];
  if (m.staticAccounts.length !== 5 || m.staticAccounts[0] !== d.feePayer) fail(`accounts ${m.staticAccounts.join(",")}`);
  if ([...want].sort().join() !== [...m.staticAccounts].sort().join()) fail(`accounts ${m.staticAccounts.join(",")}`);
  if (m.header.numSignerAccounts !== 1 || m.header.numReadonlySignerAccounts !== 0) fail("signers");
  if ((m.addressTableLookups ?? []).length) fail("address table lookups");
  if (m.instructions.length !== 1) fail(`${m.instructions.length} instructions`);
  const ix = m.instructions[0]!;
  if (m.staticAccounts[ix.programAddressIndex] !== d.program) fail("instruction is not to the roots program");
  // The instruction's accounts, in order: config, day PDA, authority, system program.
  const order = (ix.accountIndices ?? []).map((i) => m.staticAccounts[i]);
  if (order.join() !== [want[2], want[1], want[0], want[3]].join()) fail(`instruction accounts ${order.join(",")}`);
  // Writable: only the fee payer and the day PDA.
  const n = m.staticAccounts.length;
  const writable = m.staticAccounts.filter(
    (_, i) => i < m.header.numSignerAccounts - m.header.numReadonlySignerAccounts || (i >= m.header.numSignerAccounts && i < n - m.header.numReadonlyNonSignerAccounts),
  );
  if ([...writable].sort().join() !== [want[0], want[1]].sort().join()) fail(`writable accounts ${writable.join(",")}`);
  const data = encodePostRootArgs(a);
  const got: ArrayLike<number> = ix.data ?? new Uint8Array();
  if (got.length !== data.length || data.some((b, i) => b !== got[i])) fail("instruction data differs");
}

export type PostRootPlan =
  | { state: "already-posted"; pda: string }
  | {
      state: "ready";
      pda: string;
      tx: ReturnType<typeof compileTransaction>;
      lastValidBlockHeight: number;
      rentLamports: number;
      feeLamports: number;
      spendLamports: number;
      unitsConsumed: number | null;
      logs: string[];
    };

export async function planPostRoot(d: PostRootDeps, a: PostRootArgs): Promise<PostRootPlan> {
  const cfgAddr = await configPda(d.program);
  const cfg = await account(d.rpc, cfgAddr);
  if (!cfg || cfg.owner !== d.program) throw new Error(`no observation-roots config at ${cfgAddr}; initialize first`);
  const { authority } = decodeConfig(b64(cfg.data[0]));
  if (authority !== d.feePayer) throw new Error(`config authority is ${authority}, not ${d.feePayer}`);

  const pda = await dayRootPda(d.program, a.day);
  const existing = await account(d.rpc, pda);
  // Lamports sent to the PDA address before the post leave it a system-owned, empty account. The
  // program's `init` still creates the day there (it only tops the rent up), so that is "not posted".
  const prefunded = existing !== null && existing.owner === SYSTEM_PROGRAM && b64(existing.data[0]).length === 0;
  if (existing && !prefunded) {
    if (existing.owner !== d.program) throw new Error(`${pda} exists and is not owned by the program`);
    const r = decodeDayRoot(b64(existing.data[0]));
    if (!sameRoot(r, a)) throw new Error(`${a.day} already holds a different root on chain (${r.root}); stop and look`);
    return { state: "already-posted", pda };
  }

  const { value: bh } = (await d.rpc("getLatestBlockhash", [{ commitment: "confirmed" }])) as { value: { blockhash: string; lastValidBlockHeight: number } };
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(d.feePayer), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: bh.blockhash as Blockhash, lastValidBlockHeight: BigInt(bh.lastValidBlockHeight) }, m),
  );
  const tx = compileTransaction(appendTransactionMessageInstructions([await postRootIx({ ...a, program: d.program, authority: d.feePayer })], msg));
  await assertPostRootOnly(tx.messageBytes, d, a);

  const rentLamports = (await d.rpc("getMinimumBalanceForRentExemption", [DAY_ROOT_ACCOUNT_BYTES])) as number;
  const fee = (await d.rpc("getFeeForMessage", [Buffer.from(tx.messageBytes).toString("base64"), { commitment: "confirmed" }])) as { value: number | null };
  if (fee.value === null || fee.value > MAX_POST_ROOT_FEE_LAMPORTS) throw new Error(`fee ${fee.value} lamports is over ${MAX_POST_ROOT_FEE_LAMPORTS}`);
  const before = (await d.rpc("getBalance", [d.feePayer, { commitment: "confirmed" }])) as { value: number };
  const sim = (await d.rpc("simulateTransaction", [
    getBase64EncodedWireTransaction(tx),
    { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed", accounts: { encoding: "base64", addresses: [d.feePayer] } },
  ])) as { value: { err: unknown; logs: string[] | null; unitsConsumed?: number; accounts: ({ lamports: number } | null)[] | null } };
  if (sim.value.err !== null) throw new Error(`simulation failed: ${JSON.stringify(sim.value.err)} ${(sim.value.logs ?? []).join(" | ")}`);
  const after = sim.value.accounts?.[0]?.lamports;
  if (after === undefined) throw new Error("simulation did not return the fee payer's balance");
  // Nothing may leave the fee payer but the new account's rent and the fee.
  const spendLamports = before.value - after;
  if (spendLamports > rentLamports + fee.value) throw new Error(`simulation moves ${spendLamports} lamports from the fee payer, more than rent ${rentLamports} + fee ${fee.value}`);
  return {
    state: "ready",
    pda,
    tx,
    lastValidBlockHeight: bh.lastValidBlockHeight,
    rentLamports,
    feeLamports: fee.value,
    spendLamports,
    unitsConsumed: sim.value.unitsConsumed ?? null,
    logs: sim.value.logs ?? [],
  };
}

export async function sendPostRoot(d: PostRootDeps, a: PostRootArgs): Promise<{ state: "already-posted" | "posted"; pda: string; signature?: string }> {
  const p = await planPostRoot(d, a);
  if (p.state === "already-posted") {
    d.log?.(`${a.day}: root already in ${p.pda}`);
    return p;
  }
  const signer = await d.loadSigner();
  if (signer.address !== d.feePayer) throw new Error(`key ${signer.address} is not the posting authority ${d.feePayer}`);
  const signed = await signTransaction([signer.keyPair], p.tx);
  const signature = getSignatureFromTransaction(signed);
  await d.rpc("sendTransaction", [getBase64EncodedWireTransaction(signed), { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5 }]);
  const sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < (d.pollTries ?? 60); i++) {
    await sleep(d.pollMs ?? 2000);
    const st = (await d.rpc("getSignatureStatuses", [[signature], { searchTransactionHistory: true }])) as { value: ({ err: unknown; confirmationStatus: string | null } | null)[] };
    const s = st.value[0];
    if (s?.err) throw new Error(`post_root ${signature} failed on chain: ${JSON.stringify(s.err)}`);
    if (s && (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized")) {
      const acc = await account(d.rpc, p.pda);
      if (!acc || acc.owner !== d.program || !sameRoot(decodeDayRoot(b64(acc.data[0])), a)) throw new Error(`post_root ${signature} landed but ${p.pda} does not hold the root`);
      d.log?.(`${a.day}: root posted to ${p.pda} in ${signature}`);
      return { state: "posted", pda: p.pda, signature };
    }
  }
  throw new Error(`post_root ${signature} not confirmed yet; run again (a landed post is detected, a second post cannot land)`);
}
