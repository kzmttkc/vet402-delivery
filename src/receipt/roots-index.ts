/**
 * A day's root in the observation-roots program, as the records index names it
 * (data/records/index.json, days[].programRoot): the program, the day's account, the post_root
 * transaction and its slot. The signed records are never rewritten for it.
 *
 * Written only after the account was read back from chain and holds exactly the day's root, count,
 * sequence range and observer (dayRootOnChain): by scripts/anchor-receipts.ts --post-root --send into
 * <receipts>/<day>/anchor-program-sent.json, and by scripts/backfill-program-roots.ts for the days
 * posted before that file existed. publish-records copies it into the index.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Instruction } from "@solana/kit";
import type { Rpc } from "../chain.js";
import { observationDigest } from "./eip712.js";
import { compactFields, dayNumber, dayRootPda, decodeDayRoot, decodeVerifyResult, MAINNET_GENESIS, ROOTS_PROGRAM, verifyIx, type PostRootArgs } from "./roots-program.js";
import { simulateIxs, type SimResult } from "./roots-tx.js";
import type { Observation } from "./types.js";

/** CAIP-2 of Solana mainnet, the one cluster a published programRoot may name. */
export const ROOTS_INDEX_NETWORK = `solana:${MAINNET_GENESIS.slice(0, 32)}`;
export const PROGRAM_ROOT_FILE = "anchor-program-sent.json";

export interface ProgramRootEntry {
  network: string;
  program: string;
  /** The day's PDA ["root", day as u32 LE]. */
  account: string;
  /** The post_root transaction that created the account. */
  tx: string;
  /** The slot the account says it was posted in (= the transaction's slot). */
  slot: number;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const KEYS = ["network", "program", "account", "tx", "slot"];

/** Shape problems of an index entry's programRoot for `day`; empty = well formed. */
export async function programRootShape(x: unknown, day: string): Promise<string[]> {
  if (typeof x !== "object" || x === null) return ["programRoot is not an object"];
  const p = x as Record<string, unknown>;
  const out: string[] = [];
  const extra = Object.keys(p).filter((k) => !KEYS.includes(k));
  if (extra.length) out.push(`programRoot has unknown fields ${extra.join(", ")}`);
  if (p.network !== ROOTS_INDEX_NETWORK) out.push(`programRoot.network is not ${ROOTS_INDEX_NETWORK}`);
  if (p.program !== ROOTS_PROGRAM) out.push(`programRoot.program is not ${ROOTS_PROGRAM}`);
  if (typeof p.account !== "string" || p.account !== (await dayRootPda(ROOTS_PROGRAM, day))) out.push(`programRoot.account is not the ${day} account of the program`);
  if (typeof p.tx !== "string" || !BASE58.test(p.tx) || p.tx.length < 64 || p.tx.length > 88) out.push("programRoot.tx is not a Solana signature");
  if (typeof p.slot !== "number" || !Number.isSafeInteger(p.slot) || p.slot <= 0) out.push("programRoot.slot is not a slot number");
  return out;
}

/**
 * The day's programRoot from <dayDir>/anchor-program-sent.json once it is "posted"; null = none. Throws when
 * the file is "posted" but names another root than the day's `root`, or is malformed.
 */
export async function programRootOfDay(dayDir: string, day: string, root: string): Promise<ProgramRootEntry | null> {
  const p = join(dayDir, PROGRAM_ROOT_FILE);
  if (!existsSync(p)) return null;
  const f = JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
  if (f.status !== "posted") return null;
  if (typeof f.root !== "string" || f.root.toLowerCase() !== root.toLowerCase()) throw new Error(`${p}: root ${String(f.root)} is not the day's root ${root}`);
  const e = { network: f.network, program: f.program, account: f.account, tx: f.tx, slot: f.slot };
  const bad = await programRootShape(e, day);
  if (bad.length) throw new Error(`${p}: ${bad.join("; ")}`);
  return e as ProgramRootEntry;
}

/**
 * The programRoot publish-records puts on a day's index line: the one in anchor-program-sent.json (`sent`)
 * when there is one; else the one the previous index already named for the same day and the same root (a
 * backfilled day has no such file), when it is still well formed; nothing while the memo anchor is pending.
 */
export async function carryProgramRoot(
  prior: { day?: unknown; root?: unknown; programRoot?: unknown } | undefined,
  day: { day: string; root: string; anchor: { status: string } },
  sent: ProgramRootEntry | null,
): Promise<ProgramRootEntry | undefined> {
  if (day.anchor.status !== "anchored") return undefined;
  if (sent) return sent;
  if (!prior || prior.day !== day.day || typeof prior.root !== "string" || prior.root.toLowerCase() !== day.root.toLowerCase()) return undefined;
  if (prior.programRoot === undefined || (await programRootShape(prior.programRoot, day.day)).length) return undefined;
  return prior.programRoot as ProgramRootEntry;
}

/** What the day's account must hold: the values of the memo anchor (and of the index line). */
export type ExpectedDayRoot = PostRootArgs;

type AccountValue = { data: [string, string]; owner: string } | null;
type SigInfo = { signature: string; slot: number; err: unknown };
type TxInfo = {
  slot: number;
  meta: { err: unknown } | null;
  transaction: { message: { accountKeys: (string | { pubkey: string; signer?: boolean })[] } };
} | null;

/**
 * Read the day's account and its post_root transaction from chain, and refuse unless the account is
 * the program's, holds exactly `want`, and was created by one successful transaction paid by `poster`
 * in the slot the account names. Reads only.
 */
export async function dayRootOnChain(rpc: Rpc, a: { program: string; poster: string }, want: ExpectedDayRoot, commitment: "finalized" | "confirmed" = "finalized"): Promise<ProgramRootEntry> {
  const account = await dayRootPda(a.program, want.day);
  const v = ((await rpc("getAccountInfo", [account, { encoding: "base64", commitment }])) as { value: AccountValue }).value;
  if (!v) throw new Error(`${want.day}: no account at ${account}; the root is not in the program`);
  if (v.owner !== a.program) throw new Error(`${want.day}: ${account} is owned by ${v.owner}, not the program`);
  const r = decodeDayRoot(Uint8Array.from(Buffer.from(v.data[0], "base64")));
  const diff: string[] = [];
  if (String(r.day) !== want.day.replaceAll("-", "")) diff.push(`day ${r.day}`);
  if (r.root.toLowerCase() !== want.root.toLowerCase()) diff.push(`root ${r.root} (want ${want.root})`);
  if (r.count !== want.count) diff.push(`count ${r.count} (want ${want.count})`);
  if (r.seqStart !== BigInt(want.seqStart) || r.seqEnd !== BigInt(want.seqEnd)) diff.push(`sequence ${r.seqStart}-${r.seqEnd} (want ${want.seqStart}-${want.seqEnd})`);
  if (r.observer.toLowerCase() !== want.observer.toLowerCase()) diff.push(`observer ${r.observer} (want ${want.observer})`);
  if (diff.length) throw new Error(`${want.day}: ${account} on chain differs from the day's root: ${diff.join("; ")}`);

  const slot = Number(r.postedSlot);
  const sigs = (await rpc("getSignaturesForAddress", [account, { limit: 1000, commitment }])) as SigInfo[];
  const atSlot = sigs.filter((s) => s.slot === slot && s.err === null);
  if (atSlot.length !== 1) throw new Error(`${want.day}: ${atSlot.length} successful transactions touch ${account} in slot ${slot}, expected the one post_root`);
  const tx = atSlot[0]!.signature;
  const t = (await rpc("getTransaction", [tx, { encoding: "json", commitment, maxSupportedTransactionVersion: 0 }])) as TxInfo;
  if (!t || t.meta?.err !== null || t.slot !== slot) throw new Error(`${want.day}: transaction ${tx} is not a successful transaction in slot ${slot}`);
  const keys = t.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
  if (keys[0] !== a.poster) throw new Error(`${want.day}: transaction ${tx} was paid by ${keys[0]}, not the posting key ${a.poster}`);
  if (!keys.includes(a.program) || !keys.includes(account)) throw new Error(`${want.day}: transaction ${tx} does not name the program and ${account}`);
  return { network: ROOTS_INDEX_NETWORK, program: a.program, account, tx, slot };
}

export interface ProgramVerifyResult {
  ok: boolean;
  detail: string;
}

/**
 * Ask the observation-roots program itself whether `obs` is in the day's root: a simulated `verify`
 * (sigVerify off, recent blockhash replaced, nothing signed or sent) against the account the index names.
 * Passes only when the simulation succeeds, the return data comes from the program, and its day, verdict,
 * sequence and digest are the record's. `feePayer` only has to be an existing account with lamports; it
 * signs nothing.
 */
export async function programVerify(
  rpc: Rpc,
  entry: ProgramRootEntry,
  obs: Observation,
  feePayer: string,
  opts: {
    /** The cluster the index's entry is on; only mainnet is ever published. Local tests pass their validator's. */
    genesis?: string;
    simulate?: (rpc: Rpc, feePayer: string, ixs: Instruction[]) => Promise<Pick<SimResult, "err" | "logs" | "returnData" | "returnProgram">>;
  } = {},
): Promise<ProgramVerifyResult> {
  const a = obs.anchor;
  if (!a) return { ok: false, detail: "the record is not in a daily root" };
  const simulate = opts.simulate ?? simulateIxs;
  const genesis = (await rpc("getGenesisHash", [])) as string;
  if (genesis !== (opts.genesis ?? MAINNET_GENESIS)) return { ok: false, detail: `the Solana RPC is not the cluster the index names (genesis ${genesis})` };
  if (entry.program !== ROOTS_PROGRAM || entry.account !== (await dayRootPda(ROOTS_PROGRAM, a.day))) return { ok: false, detail: `the index names ${entry.account} of ${entry.program}, not the ${a.day} account of ${ROOTS_PROGRAM}` };
  const ix = await verifyIx({ program: ROOTS_PROGRAM, day: a.day, fields: compactFields(obs), proof: a.proof });
  const r = await simulate(rpc, feePayer, [ix]);
  const where = `${ROOTS_PROGRAM}, account ${entry.account}`;
  if (r.err !== null) {
    const why = r.logs.filter((l) => /Error|failed/i.test(l)).slice(-1)[0] ?? JSON.stringify(r.err);
    return { ok: false, detail: `verify refused the record (${where}): ${why}` };
  }
  if (!r.returnData || r.returnProgram !== ROOTS_PROGRAM) return { ok: false, detail: `verify returned no data from ${ROOTS_PROGRAM}` };
  const v = decodeVerifyResult(r.returnData);
  const digest = observationDigest(obs).toLowerCase();
  const diff: string[] = [];
  if (v.day !== dayNumber(a.day)) diff.push(`day ${v.day}`);
  if (v.verdict !== obs.verdict.code) diff.push(`verdict ${v.verdict}`);
  if (v.sequence !== BigInt(obs.observer.sequence)) diff.push(`sequence ${v.sequence}`);
  if (v.digest.toLowerCase() !== digest) diff.push(`digest ${v.digest}`);
  if (diff.length) return { ok: false, detail: `verify answered for another record (${diff.join(", ")}), not ${obs.verdict.code} ${a.day} sequence ${obs.observer.sequence}` };
  return { ok: true, detail: `verify: ${v.verdict} (${a.day}, sequence ${v.sequence}); digest ${v.digest} is the record's (${where}, simulated, nothing signed)` };
}

/**
 * The programRoot a records index names for the record's day. `entry` null = the index names none.
 * `problem` = the index is not a records index, names another root for the day, or a malformed entry.
 */
export async function programRootFromIndex(index: unknown, record: { anchor: { day: string; root: string } | null }): Promise<{ entry: ProgramRootEntry | null; problem: string | null }> {
  const idx = index as { kind?: unknown; days?: unknown };
  if (typeof idx !== "object" || idx === null || idx.kind !== "vet402-observation-records" || !Array.isArray(idx.days)) return { entry: null, problem: "not a vet402 records index" };
  const a = record.anchor;
  if (!a) return { entry: null, problem: null };
  const d = (idx.days as { day?: unknown; root?: unknown; programRoot?: unknown }[]).find((x) => x?.day === a.day);
  if (!d) return { entry: null, problem: null };
  if (typeof d.root !== "string" || d.root.toLowerCase() !== a.root.toLowerCase()) return { entry: null, problem: `the index names root ${String(d.root)} for ${a.day}, the record ${a.root}` };
  if (d.programRoot === undefined) return { entry: null, problem: null };
  const bad = await programRootShape(d.programRoot, a.day);
  if (bad.length) return { entry: null, problem: bad.join("; ") };
  return { entry: d.programRoot as ProgramRootEntry, problem: null };
}
