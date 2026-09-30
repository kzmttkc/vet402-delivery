//! observation-roots: one PDA per UTC day holding the Merkle root of that day's
//! x402-observation records, and a `verify` instruction that checks one record
//! against it. Other programs call `verify` through CPI and read the verdict
//! from the return data.
//!
//! The hashing matches src/receipt/eip712.ts and src/receipt/merkle.ts exactly:
//!  - digest = EIP-712 hashTypedData(domain { name: "x402 observation", version: "1", chainId: 1 },
//!    Observation { ... 17 fields ... })
//!  - leaf   = keccak256(0x00 || digest)
//!  - node   = keccak256(0x01 || min(a, b) || max(a, b))  (sorted pair; an odd node is carried up)
//!
//! Holds no funds. The only lamports it touches are the rent of its own accounts,
//! paid by the signer that creates them.

use anchor_lang::prelude::*;
use solana_keccak_hasher::hashv;

pub mod hashing;

pub use hashing::{leaf_hash, node_hash, observation_digest, root_from_proof, ObservationFields, StrField, Verdict};

declare_id!("58HtYvvBLCQisVNQyiSgFi9go6JY7CGpbiqhzqJDtknf");

/// A day's tree depth is ceil(log2(n)); 32 covers any realistic count.
pub const MAX_PROOF_LEN: usize = 32;
pub const SECONDS_PER_DAY: i64 = 86_400;

#[program]
pub mod observation_roots {
    use super::*;

    /// Creates the config and sets the key allowed to post roots.
    /// Only the program's upgrade authority can call it, so nobody can claim the
    /// config between deployment and initialization.
    pub fn initialize(ctx: Context<Initialize>, authority: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.authority = authority;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Writes one day's root. The day PDA is created with `init`, so a second
    /// post for the same day fails: a root once written cannot be replaced.
    pub fn post_root(ctx: Context<PostRoot>, args: PostRootArgs) -> Result<()> {
        let start = day_start_unix(args.day).ok_or(error!(RootsError::InvalidDay))?;
        let clock = Clock::get()?;
        require!(clock.unix_timestamp >= start + SECONDS_PER_DAY, RootsError::DayStillOpen);
        require!(args.count > 0, RootsError::EmptyRoot);
        require!(args.seq_end >= args.seq_start, RootsError::SequenceRangeMismatch);
        require!(args.seq_end - args.seq_start + 1 == args.count as u64, RootsError::SequenceRangeMismatch);
        require!(args.observer != [0u8; 20], RootsError::InvalidObserver);

        let r = &mut ctx.accounts.day_root;
        r.day = args.day;
        r.root = args.root;
        r.count = args.count;
        r.seq_start = args.seq_start;
        r.seq_end = args.seq_end;
        r.observer = args.observer;
        r.posted_slot = clock.slot;
        r.posted_at = clock.unix_timestamp;
        r.bump = ctx.bumps.day_root;
        Ok(())
    }

    /// Checks that `fields` describe a record inside the day's root. On success the
    /// result (verdict, sequence, digest) is returned through set_return_data, so a
    /// calling program reads it with `observation_roots::cpi::verify(...)?.get()`.
    /// A record that is not in the root fails the instruction.
    pub fn verify(ctx: Context<Verify>, day: u32, fields: ObservationFields, proof: Vec<[u8; 32]>) -> Result<VerifyResult> {
        require!(proof.len() <= MAX_PROOF_LEN, RootsError::ProofTooLong);
        let r = &ctx.accounts.day_root;
        require!(fields.sequence >= r.seq_start && fields.sequence <= r.seq_end, RootsError::SequenceOutsideRoot);
        let digest = observation_digest(&fields);
        require!(root_from_proof(&digest, &proof) == r.root, RootsError::NotInRoot);
        Ok(VerifyResult { day, verdict: fields.verdict, sequence: fields.sequence, digest })
    }
}

/// For calling programs: CPI into `verify` and read its result, checking that the program
/// called is this one and that the return data came from it.
///
/// ```ignore
/// require!(observation_roots::verify_cpi(cpi_ctx, day, fields, proof)?.verdict == Verdict::Delivered, MyError::NotDelivered);
/// ```
#[cfg(feature = "cpi")]
pub fn verify_cpi<'a, 'b, 'c, 'info>(
    ctx: CpiContext<'a, 'b, 'c, 'info, cpi::accounts::Verify<'info>>,
    day: u32,
    fields: ObservationFields,
    proof: Vec<[u8; 32]>,
) -> Result<VerifyResult> {
    require_keys_eq!(*ctx.program.key, crate::ID, RootsError::WrongProgram);
    cpi::verify(ctx, day, fields, proof)?;
    let (from, data) = anchor_lang::solana_program::program::get_return_data().ok_or(error!(RootsError::NoReturnData))?;
    require_keys_eq!(from, crate::ID, RootsError::NoReturnData);
    VerifyResult::try_from_slice(&data).map_err(|_| error!(RootsError::NoReturnData))
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct PostRootArgs {
    /// UTC day as yyyymmdd, e.g. 20260928.
    pub day: u32,
    pub root: [u8; 32],
    /// Number of leaves.
    pub count: u32,
    /// Observer sequence range the root covers (inclusive).
    pub seq_start: u64,
    pub seq_end: u64,
    /// EVM address of the observation signing key in force for this root.
    pub observer: [u8; 20],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct VerifyResult {
    pub day: u32,
    pub verdict: Verdict,
    pub sequence: u64,
    /// The record's EIP-712 digest (the Merkle leaf input).
    pub digest: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct DayRoot {
    pub day: u32,
    pub root: [u8; 32],
    pub count: u32,
    pub seq_start: u64,
    pub seq_end: u64,
    pub observer: [u8; 20],
    pub posted_slot: u64,
    pub posted_at: i64,
    pub bump: u8,
}

pub const CONFIG_SEED: &[u8] = b"config";
pub const ROOT_SEED: &[u8] = b"root";

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = payer, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()) @ RootsError::NotUpgradeAuthority)]
    pub program: Program<'info, crate::program::ObservationRoots>,
    #[account(constraint = program_data.upgrade_authority_address == Some(payer.key()) @ RootsError::NotUpgradeAuthority)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: PostRootArgs)]
pub struct PostRoot<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ RootsError::NotAuthority)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = authority,
        space = 8 + DayRoot::INIT_SPACE,
        seeds = [ROOT_SEED, &args.day.to_le_bytes()],
        bump
    )]
    pub day_root: Account<'info, DayRoot>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(day: u32)]
pub struct Verify<'info> {
    #[account(seeds = [ROOT_SEED, &day.to_le_bytes()], bump = day_root.bump)]
    pub day_root: Account<'info, DayRoot>,
}

#[error_code]
pub enum RootsError {
    #[msg("signer is not the program's upgrade authority")]
    NotUpgradeAuthority,
    #[msg("signer is not the posting authority")]
    NotAuthority,
    #[msg("day is not a valid yyyymmdd date")]
    InvalidDay,
    #[msg("the UTC day has not ended yet")]
    DayStillOpen,
    #[msg("a root needs at least one record")]
    EmptyRoot,
    #[msg("sequence range does not match the record count")]
    SequenceRangeMismatch,
    #[msg("observer address is zero")]
    InvalidObserver,
    #[msg("proof is longer than the maximum depth")]
    ProofTooLong,
    #[msg("record sequence is outside the day's range")]
    SequenceOutsideRoot,
    #[msg("record is not in the day's root")]
    NotInRoot,
    #[msg("the program called is not observation-roots")]
    WrongProgram,
    #[msg("no verify result from observation-roots")]
    NoReturnData,
}

/// Unix time of 00:00 UTC on `day` (yyyymmdd), or None for an invalid date.
pub fn day_start_unix(day: u32) -> Option<i64> {
    let y = (day / 10_000) as i64;
    let m = ((day / 100) % 100) as i64;
    let d = (day % 100) as i64;
    if !(2000..=2999).contains(&y) || !(1..=12).contains(&m) || d < 1 {
        return None;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let dim = match m {
        2 => {
            if leap {
                29
            } else {
                28
            }
        }
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if d > dim {
        return None;
    }
    // days_from_civil (H. Hinnant)
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) * SECONDS_PER_DAY)
}

/// keccak256 of a single byte string.
pub(crate) fn keccak(bytes: &[u8]) -> [u8; 32] {
    hashv(&[bytes]).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_start() {
        assert_eq!(day_start_unix(19700101), None); // below the accepted range
        assert_eq!(day_start_unix(20260928), Some(1_790_553_600));
        assert_eq!(day_start_unix(20240229), Some(1_709_164_800));
        assert_eq!(day_start_unix(20250229), None);
        assert_eq!(day_start_unix(20261301), None);
        assert_eq!(day_start_unix(20260931), None);
        assert_eq!(day_start_unix(20260900), None);
    }
}
