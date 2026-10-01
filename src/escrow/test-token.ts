/**
 * A test token for the escrow example (local validator and devnet): a 6-decimal mint standing in for USDC,
 * associated token accounts, and minting to the buyer. Builds instructions only.
 */
import { AccountRole, address, getAddressEncoder, type Instruction, type TransactionSigner } from "@solana/kit";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getInitializeMint2Instruction, getMintSize, getMintToInstruction } from "@solana-program/token";
import { SYSTEM_PROGRAM } from "../receipt/roots-program.js";
import { TOKEN_PROGRAM } from "./escrow-program.js";

export const TEST_TOKEN_DECIMALS = 6;

/** SystemProgram::CreateAccount. */
export function createAccountIx(a: { payer: string; account: string; lamports: bigint; space: number; owner: string }): Instruction {
  const data = Buffer.alloc(52);
  data.writeUInt32LE(0, 0);
  data.writeBigUInt64LE(a.lamports, 4);
  data.writeBigUInt64LE(BigInt(a.space), 12);
  data.set(getAddressEncoder().encode(address(a.owner)), 20);
  return {
    programAddress: address(SYSTEM_PROGRAM),
    accounts: [
      { address: address(a.payer), role: AccountRole.WRITABLE_SIGNER },
      { address: address(a.account), role: AccountRole.WRITABLE_SIGNER },
    ],
    data: Uint8Array.from(data),
  };
}

/** SystemProgram::Transfer. */
export function transferLamportsIx(from: string, to: string, lamports: bigint): Instruction {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);
  data.writeBigUInt64LE(lamports, 4);
  return {
    programAddress: address(SYSTEM_PROGRAM),
    accounts: [
      { address: address(from), role: AccountRole.WRITABLE_SIGNER },
      { address: address(to), role: AccountRole.WRITABLE },
    ],
    data: Uint8Array.from(data),
  };
}

/** Create and initialize a mint (decimals 6, no freeze authority). `mint` must also sign. */
export function createMintIxs(a: { payer: string; mint: TransactionSigner; authority: string; rentLamports: bigint }): Instruction[] {
  return [
    createAccountIx({ payer: a.payer, account: a.mint.address, lamports: a.rentLamports, space: getMintSize(), owner: TOKEN_PROGRAM }),
    getInitializeMint2Instruction({ mint: a.mint.address, decimals: TEST_TOKEN_DECIMALS, mintAuthority: address(a.authority), freezeAuthority: null }),
  ];
}

export async function ata(owner: string, mint: string): Promise<string> {
  const [pda] = await findAssociatedTokenPda({ owner: address(owner), mint: address(mint), tokenProgram: address(TOKEN_PROGRAM) });
  return pda;
}

/** Creates `owner`'s associated token account for `mint` if it does not exist yet; `payer` pays the rent. */
export async function createAtaIx(payer: TransactionSigner, owner: string, mint: string): Promise<Instruction> {
  return getCreateAssociatedTokenIdempotentInstruction({ payer, ata: address(await ata(owner, mint)), owner: address(owner), mint: address(mint) });
}

export async function mintToIx(a: { mint: string; to: string; authority: TransactionSigner; amount: bigint }): Promise<Instruction> {
  return getMintToInstruction({ mint: address(a.mint), token: address(a.to), mintAuthority: a.authority, amount: a.amount });
}
