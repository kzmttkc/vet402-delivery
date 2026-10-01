/**
 * Client for the example escrow (solana-program/programs/delivery-escrow-example). Builds its instructions and
 * decodes its account. Signs and sends nothing.
 *
 * The escrow pays the seller only when observation-roots says the purchase's signed record is DELIVERED, and
 * returns the tokens to the buyer on NOT_DELIVERED. After the deadline the buyer can reclaim.
 */
import { AccountRole, address, getAddressDecoder, getAddressEncoder, getProgramDerivedAddress, type Address, type Instruction } from "@solana/kit";
import { keccak256, stringToBytes, type Hex } from "viem";
import type { Observation } from "../receipt/types.js";
import { dayRootPda, fieldsFromObservation, ixDiscriminator, SYSTEM_PROGRAM, verifyIx, type ObservationFields, type StringFieldName } from "../receipt/roots-program.js";

/** The example escrow's program id (devnet and local tests only; never deployed on mainnet). */
export const ESCROW_EXAMPLE_PROGRAM = "p7HTembyKn78rT4doqVneMw9qfck7yY3Zf3QRLCxMBA";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** Escrow account bytes: 8 discriminator + 3 keys + amount + deadline + 3 hashes + 2 bumps. */
export const ESCROW_ACCOUNT_BYTES = 8 + 32 * 3 + 8 + 8 + 32 * 3 + 2;

/** Every string field, sent as its keccak256: the escrow compares words, so nothing needs to travel raw. */
export const ALL_STRING_FIELDS: readonly StringFieldName[] = ["id", "network", "resourceUrl", "payer", "payTo", "asset", "amount", "transaction", "responseHash", "responseHashAlg", "responseHashEncoding"];

const enc = new TextEncoder();
const keccakBytes = (s: string): Uint8Array => Buffer.from(keccak256(stringToBytes(s)).slice(2), "hex");

function borshString(s: string): number[] {
  const b = enc.encode(s);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return [...len, ...b];
}
const u64le = (v: bigint): number[] => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return [...b];
};
const i64le = (v: bigint): number[] => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(v);
  return [...b];
};

export async function escrowPda(program: string, buyer: string, transaction: string): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(program),
    seeds: [enc.encode("escrow"), getAddressEncoder().encode(address(buyer)), keccakBytes(transaction)],
  });
  return pda;
}

export async function vaultPda(program: string, escrow: string): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: address(program), seeds: [enc.encode("vault"), getAddressEncoder().encode(address(escrow))] });
  return pda;
}

/** The purchase an escrow is for: the three fields of the record it will be settled with, and the amount. */
export interface Purchase {
  network: string;
  payTo: string;
  transaction: string;
  /** Atomic units; must equal the record's `amount`. */
  amount: bigint;
}

export function purchaseOf(o: Observation): Purchase {
  return { network: o.payment.network, payTo: o.payment.payTo, transaction: o.payment.transaction, amount: BigInt(o.payment.amount) };
}

export async function depositIx(a: { program: string; buyer: string; buyerTokens: string; mint: string; purchase: Purchase; deadline: bigint }): Promise<Instruction> {
  const escrow = await escrowPda(a.program, a.buyer, a.purchase.transaction);
  const data = Uint8Array.from([
    ...ixDiscriminator("deposit"),
    ...borshString(a.purchase.network),
    ...borshString(a.purchase.payTo),
    ...borshString(a.purchase.transaction),
    ...u64le(a.purchase.amount),
    ...i64le(a.deadline),
  ]);
  return {
    programAddress: address(a.program),
    accounts: [
      { address: escrow, role: AccountRole.WRITABLE },
      { address: await vaultPda(a.program, escrow), role: AccountRole.WRITABLE },
      { address: address(a.mint), role: AccountRole.READONLY },
      { address: address(a.purchase.payTo), role: AccountRole.READONLY },
      { address: address(a.buyerTokens), role: AccountRole.WRITABLE },
      { address: address(a.buyer), role: AccountRole.WRITABLE_SIGNER },
      { address: address(TOKEN_PROGRAM), role: AccountRole.READONLY },
      { address: address(SYSTEM_PROGRAM), role: AccountRole.READONLY },
    ],
    data,
  };
}

/**
 * Settles with a record: `destination` is the seller's token account (DELIVERED) or the buyer's (NOT_DELIVERED).
 * Anyone can send it. The instruction data is verify's (day, fields, proof) under settle's discriminator.
 */
export async function settleIx(a: {
  program: string;
  rootsProgram: string;
  buyer: string;
  transaction: string;
  destination: string;
  day: string;
  fields: ObservationFields;
  proof: readonly string[];
}): Promise<Instruction> {
  const escrow = await escrowPda(a.program, a.buyer, a.transaction);
  const v = await verifyIx({ program: a.rootsProgram, day: a.day, fields: a.fields, proof: a.proof });
  const data = Uint8Array.from([...ixDiscriminator("settle"), ...v.data!.slice(8)]);
  return {
    programAddress: address(a.program),
    accounts: [
      { address: escrow, role: AccountRole.WRITABLE },
      { address: await vaultPda(a.program, escrow), role: AccountRole.WRITABLE },
      { address: address(a.destination), role: AccountRole.WRITABLE },
      { address: address(a.buyer), role: AccountRole.WRITABLE },
      { address: await dayRootPda(a.rootsProgram, a.day), role: AccountRole.READONLY },
      { address: address(a.rootsProgram), role: AccountRole.READONLY },
      { address: address(TOKEN_PROGRAM), role: AccountRole.READONLY },
    ],
    data,
  };
}

/** settleIx for a published record, with every string field hashed (the smallest transaction). */
export async function settleWithRecordIx(a: { program: string; rootsProgram: string; buyer: string; destination: string; record: Observation; fields?: ObservationFields }): Promise<Instruction> {
  return settleIx({
    program: a.program,
    rootsProgram: a.rootsProgram,
    buyer: a.buyer,
    transaction: a.record.payment.transaction,
    destination: a.destination,
    day: a.record.anchor!.day,
    fields: a.fields ?? fieldsFromObservation(a.record, ALL_STRING_FIELDS),
    proof: a.record.anchor!.proof,
  });
}

export async function reclaimIx(a: { program: string; buyer: string; transaction: string; destination: string }): Promise<Instruction> {
  const escrow = await escrowPda(a.program, a.buyer, a.transaction);
  return {
    programAddress: address(a.program),
    accounts: [
      { address: escrow, role: AccountRole.WRITABLE },
      { address: await vaultPda(a.program, escrow), role: AccountRole.WRITABLE },
      { address: address(a.destination), role: AccountRole.WRITABLE },
      { address: address(a.buyer), role: AccountRole.WRITABLE_SIGNER },
      { address: address(TOKEN_PROGRAM), role: AccountRole.READONLY },
    ],
    data: ixDiscriminator("reclaim"),
  };
}

export interface EscrowAccount {
  buyer: string;
  seller: string;
  mint: string;
  amount: bigint;
  deadline: bigint;
  networkHash: Hex;
  payToHash: Hex;
  transactionHash: Hex;
}

export function decodeEscrow(b: Uint8Array): EscrowAccount {
  const buf = Buffer.from(b);
  if (buf.length !== ESCROW_ACCOUNT_BYTES) throw new Error(`escrow account is ${buf.length} bytes, expected ${ESCROW_ACCOUNT_BYTES}`);
  const key = (o: number) => getAddressDecoder().decode(buf.subarray(o, o + 32));
  const h = (o: number): Hex => `0x${buf.subarray(o, o + 32).toString("hex")}`;
  return {
    buyer: key(8),
    seller: key(40),
    mint: key(72),
    amount: buf.readBigUInt64LE(104),
    deadline: buf.readBigInt64LE(112),
    networkHash: h(120),
    payToHash: h(152),
    transactionHash: h(184),
  };
}

/** (mint, owner, amount) of a classic SPL token account. */
export function decodeTokenAccount(b: Uint8Array): { mint: string; owner: string; amount: bigint } {
  const buf = Buffer.from(b);
  if (buf.length !== 165) throw new Error(`token account is ${buf.length} bytes`);
  return { mint: getAddressDecoder().decode(buf.subarray(0, 32)), owner: getAddressDecoder().decode(buf.subarray(32, 64)), amount: buf.readBigUInt64LE(64) };
}
