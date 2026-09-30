/**
 * Client for the observation-roots Solana program (solana-program/programs/observation-roots).
 * Builds its instructions and decodes its accounts and return data. Signs and sends nothing.
 *
 * The program keeps one PDA per UTC day with that day's Merkle root, and checks a record against it
 * with the same hashing as eip712.ts and merkle.ts. Another program reads the verdict with one CPI.
 */
import { createHash } from "node:crypto";
import { AccountRole, address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, type Address, type Instruction } from "@solana/kit";
import { hexToBytes, keccak256, stringToBytes, type Hex } from "viem";
import { observationMessage } from "./eip712.js";
import { VERDICTS, type Observation, type VerdictCode } from "./types.js";

/** Devnet deployment. Mainnet has no deployment yet. */
export const ROOTS_PROGRAM_DEVNET = "58HtYvvBLCQisVNQyiSgFi9go6JY7CGpbiqhzqJDtknf";
export const GATE_EXAMPLE_PROGRAM_DEVNET = "BTVeASLyz5HvRz1eKChUgBj6hFbn89orEyGuTUW2yrUH";
export const BPF_LOADER_UPGRADEABLE = "BPFLoaderUpgradeab1e11111111111111111111111";
export const SYSTEM_PROGRAM = "11111111111111111111111111111111";

/** Bytes of a DayRoot account (8 discriminator + 101 data). */
export const DAY_ROOT_ACCOUNT_BYTES = 8 + 4 + 32 + 4 + 8 + 8 + 20 + 8 + 8 + 1;

const sha256 = (s: string) => createHash("sha256").update(s).digest();
/** Anchor instruction discriminator: sha256("global:<name>")[0..8]. */
export const ixDiscriminator = (name: string): Uint8Array => Uint8Array.from(sha256(`global:${name}`).subarray(0, 8));
/** Anchor account discriminator: sha256("account:<Name>")[0..8]. */
export const accountDiscriminator = (name: string): Uint8Array => Uint8Array.from(sha256(`account:${name}`).subarray(0, 8));

/** "2026-09-28" -> 20260928 */
export function dayNumber(day: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`day ${day} is not YYYY-MM-DD`);
  return Number(day.replaceAll("-", ""));
}

class Writer {
  private parts: number[] = [];
  u8(v: number) {
    this.parts.push(v & 0xff);
    return this;
  }
  u32(v: number) {
    if (!Number.isInteger(v) || v < 0 || v > 0xffffffff) throw new Error(`u32 out of range: ${v}`);
    for (let i = 0; i < 4; i++) this.parts.push((v >>> (8 * i)) & 0xff);
    return this;
  }
  u64(v: bigint | number) {
    let b = BigInt(v);
    if (b < 0n || b > 0xffffffffffffffffn) throw new Error(`u64 out of range: ${v}`);
    for (let i = 0; i < 8; i++) {
      this.parts.push(Number(b & 0xffn));
      b >>= 8n;
    }
    return this;
  }
  fixed(bytes: Uint8Array, len: number) {
    if (bytes.length !== len) throw new Error(`expected ${len} bytes, got ${bytes.length}`);
    for (const x of bytes) this.parts.push(x);
    return this;
  }
  string(s: string) {
    const b = new TextEncoder().encode(s);
    this.u32(b.length);
    for (const x of b) this.parts.push(x);
    return this;
  }
  bytes(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

/** A string field: the string itself, or its keccak256 (the EIP-712 encoded word) to save space. */
export type StrField = { raw: string } | { hashed: Hex };

export interface ObservationFields {
  version: bigint;
  id: StrField;
  sequence: bigint;
  verdict: VerdictCode;
  network: StrField;
  resourceUrl: StrField;
  payer: StrField;
  payTo: StrField;
  asset: StrField;
  amount: StrField;
  transaction: StrField;
  httpStatus: bigint;
  responseHash: StrField;
  responseHashAlg: StrField;
  responseHashEncoding: StrField;
  issuedAt: bigint;
  contentHash: Hex;
}

const STRING_FIELDS = ["id", "network", "resourceUrl", "payer", "payTo", "asset", "amount", "transaction", "responseHash", "responseHashAlg", "responseHashEncoding"] as const;
export type StringFieldName = (typeof STRING_FIELDS)[number];

/**
 * The program's view of a record, taken from the same EIP-712 message the observer signed.
 * Fields named in `hashed` are sent as keccak256 of the string (same digest, fewer bytes).
 */
export function fieldsFromObservation(obs: Observation, hashed: readonly StringFieldName[] = []): ObservationFields {
  const m = observationMessage(obs);
  const f = (name: StringFieldName): StrField => {
    const s = m[name] as string;
    return hashed.includes(name) ? { hashed: keccak256(stringToBytes(s)) } : { raw: s };
  };
  return {
    version: m.version,
    id: f("id"),
    sequence: m.sequence,
    verdict: m.verdict as VerdictCode,
    network: f("network"),
    resourceUrl: f("resourceUrl"),
    payer: f("payer"),
    payTo: f("payTo"),
    asset: f("asset"),
    amount: f("amount"),
    transaction: f("transaction"),
    httpStatus: m.httpStatus,
    responseHash: f("responseHash"),
    responseHashAlg: f("responseHashAlg"),
    responseHashEncoding: f("responseHashEncoding"),
    issuedAt: m.issuedAt,
    contentHash: m.contentHash,
  };
}

/**
 * The smallest encoding: every string longer than 32 bytes travels as its hash, except the fields in
 * `keepRaw` (the ones the calling program compares). Same digest either way.
 */
export function compactFields(obs: Observation, keepRaw: readonly StringFieldName[] = ["payTo", "transaction"]): ObservationFields {
  const m = observationMessage(obs);
  const long = STRING_FIELDS.filter((k) => !keepRaw.includes(k) && Buffer.byteLength(m[k] as string) > 32);
  return fieldsFromObservation(obs, long);
}

function writeStr(w: Writer, v: StrField) {
  if ("raw" in v) w.u8(0).string(v.raw);
  else w.u8(1).fixed(hexToBytes(v.hashed), 32);
}

export function verdictIndex(v: VerdictCode): number {
  const i = VERDICTS.indexOf(v);
  if (i < 0) throw new Error(`unknown verdict ${v}`);
  return i; // DELIVERED, MISMATCH, NOT_DELIVERED, UNCLEAR: the order of the Rust enum
}

function encodeFields(w: Writer, f: ObservationFields) {
  w.u64(f.version);
  writeStr(w, f.id);
  w.u64(f.sequence).u8(verdictIndex(f.verdict));
  writeStr(w, f.network);
  writeStr(w, f.resourceUrl);
  writeStr(w, f.payer);
  writeStr(w, f.payTo);
  writeStr(w, f.asset);
  writeStr(w, f.amount);
  writeStr(w, f.transaction);
  w.u64(f.httpStatus);
  writeStr(w, f.responseHash);
  writeStr(w, f.responseHashAlg);
  writeStr(w, f.responseHashEncoding);
  w.u64(f.issuedAt).fixed(hexToBytes(f.contentHash), 32);
}

function writeProof(w: Writer, proof: readonly string[]) {
  w.u32(proof.length);
  for (const p of proof) w.fixed(hexToBytes(p as Hex), 32);
}

export async function configPda(program: string): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: address(program), seeds: [new TextEncoder().encode("config")] });
  return pda;
}

export async function dayRootPda(program: string, day: string | number): Promise<Address> {
  const n = typeof day === "number" ? day : dayNumber(day);
  const [pda] = await getProgramDerivedAddress({ programAddress: address(program), seeds: [new TextEncoder().encode("root"), new Writer().u32(n).bytes()] });
  return pda;
}

export async function programDataAddress(program: string): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: address(BPF_LOADER_UPGRADEABLE), seeds: [getAddressEncoder().encode(address(program))] });
  return pda;
}

export async function initializeIx(a: { program: string; payer: string; authority: string }): Promise<Instruction> {
  const data = new Writer().fixed(ixDiscriminator("initialize"), 8).fixed(Uint8Array.from(getAddressEncoder().encode(address(a.authority))), 32).bytes();
  return {
    programAddress: address(a.program),
    accounts: [
      { address: await configPda(a.program), role: AccountRole.WRITABLE },
      { address: address(a.payer), role: AccountRole.WRITABLE_SIGNER },
      { address: address(a.program), role: AccountRole.READONLY },
      { address: await programDataAddress(a.program), role: AccountRole.READONLY },
      { address: address(SYSTEM_PROGRAM), role: AccountRole.READONLY },
    ],
    data,
  };
}

export interface PostRootArgs {
  day: string;
  root: Hex;
  count: number;
  seqStart: number;
  seqEnd: number;
  /** EVM address of the observation signing key. */
  observer: Hex;
}

export function encodePostRootArgs(a: PostRootArgs): Uint8Array {
  return new Writer()
    .fixed(ixDiscriminator("post_root"), 8)
    .u32(dayNumber(a.day))
    .fixed(hexToBytes(a.root), 32)
    .u32(a.count)
    .u64(a.seqStart)
    .u64(a.seqEnd)
    .fixed(hexToBytes(a.observer), 20)
    .bytes();
}

export async function postRootIx(a: PostRootArgs & { program: string; authority: string }): Promise<Instruction> {
  return {
    programAddress: address(a.program),
    accounts: [
      { address: await configPda(a.program), role: AccountRole.READONLY },
      { address: await dayRootPda(a.program, a.day), role: AccountRole.WRITABLE },
      { address: address(a.authority), role: AccountRole.WRITABLE_SIGNER },
      { address: address(SYSTEM_PROGRAM), role: AccountRole.READONLY },
    ],
    data: encodePostRootArgs(a),
  };
}

export async function verifyIx(a: { program: string; day: string; fields: ObservationFields; proof: readonly string[] }): Promise<Instruction> {
  const w = new Writer().fixed(ixDiscriminator("verify"), 8).u32(dayNumber(a.day));
  encodeFields(w, a.fields);
  writeProof(w, a.proof);
  return {
    programAddress: address(a.program),
    accounts: [{ address: await dayRootPda(a.program, a.day), role: AccountRole.READONLY }],
    data: w.bytes(),
  };
}

/** The example caller: passes only when the record for (payTo, transaction) is DELIVERED. */
export async function requireDeliveredIx(a: {
  gate: string;
  program: string;
  payTo: string;
  transaction: string;
  day: string;
  fields: ObservationFields;
  proof: readonly string[];
}): Promise<Instruction> {
  const w = new Writer().fixed(ixDiscriminator("require_delivered"), 8).string(a.payTo).string(a.transaction).u32(dayNumber(a.day));
  encodeFields(w, a.fields);
  writeProof(w, a.proof);
  return {
    programAddress: address(a.gate),
    accounts: [
      { address: await dayRootPda(a.program, a.day), role: AccountRole.READONLY },
      { address: address(a.program), role: AccountRole.READONLY },
    ],
    data: w.bytes(),
  };
}

export interface VerifyResult {
  day: number;
  verdict: VerdictCode;
  sequence: bigint;
  digest: Hex;
}

const hex = (b: Uint8Array): Hex => `0x${Buffer.from(b).toString("hex")}`;
const u32At = (b: Uint8Array, o: number) => Buffer.from(b).readUInt32LE(o);
const u64At = (b: Uint8Array, o: number) => Buffer.from(b).readBigUInt64LE(o);

/** The return data of `verify` (borsh VerifyResult). */
export function decodeVerifyResult(b: Uint8Array): VerifyResult {
  if (b.length !== 4 + 1 + 8 + 32) throw new Error(`verify return data is ${b.length} bytes`);
  const v = VERDICTS[b[4]!];
  if (!v) throw new Error(`verdict index ${b[4]}`);
  return { day: u32At(b, 0), verdict: v, sequence: u64At(b, 5), digest: hex(b.subarray(13, 45)) };
}

export interface DayRootAccount {
  day: number;
  root: Hex;
  count: number;
  seqStart: bigint;
  seqEnd: bigint;
  observer: Hex;
  postedSlot: bigint;
  postedAt: bigint;
  bump: number;
}

export function decodeDayRoot(b: Uint8Array): DayRootAccount {
  if (b.length !== DAY_ROOT_ACCOUNT_BYTES) throw new Error(`DayRoot account is ${b.length} bytes`);
  const disc = accountDiscriminator("DayRoot");
  if (disc.some((x, i) => b[i] !== x)) throw new Error("not a DayRoot account");
  let o = 8;
  const day = u32At(b, o);
  o += 4;
  const root = hex(b.subarray(o, o + 32));
  o += 32;
  const count = u32At(b, o);
  o += 4;
  const seqStart = u64At(b, o);
  o += 8;
  const seqEnd = u64At(b, o);
  o += 8;
  const observer = hex(b.subarray(o, o + 20));
  o += 20;
  const postedSlot = u64At(b, o);
  o += 8;
  const postedAt = Buffer.from(b).readBigInt64LE(o);
  o += 8;
  return { day, root, count, seqStart, seqEnd, observer, postedSlot, postedAt, bump: b[o]! };
}

export function decodeConfig(b: Uint8Array): { authority: string; bump: number } {
  if (b.length !== 8 + 32 + 1) throw new Error(`Config account is ${b.length} bytes`);
  const disc = accountDiscriminator("Config");
  if (disc.some((x, i) => b[i] !== x)) throw new Error("not a Config account");
  return { authority: getAddressDecoder().decode(b.subarray(8, 40)) as string, bump: b[40]! };
}
