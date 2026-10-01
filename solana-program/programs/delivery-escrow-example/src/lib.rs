//! Example escrow on top of observation-roots. The buyer deposits tokens for one purchase. The seller is
//! paid only when the signed record of that purchase is in a posted day root with the verdict DELIVERED;
//! with NOT_DELIVERED the tokens go back to the buyer. Anyone can send the settling transaction, because the
//! outcome is decided by the record, not by who sends it.
//!
//! MISMATCH and UNCLEAR settle nothing. After the deadline set at deposit, the buyer can take the tokens
//! back (`reclaim`), so a purchase with no usable record never locks the tokens for good.
//!
//! The purchase is named by the record's `network`, `payTo` and `transaction`, and the record's `amount`
//! must equal the deposit. `payTo` must be a Solana address: it is the only key a release can pay.
//! The example does not compare the record's `asset` with the deposited mint; a real caller should.
//! Only the classic SPL Token program is accepted.
//!
//! There is no lowest deadline. A seller should check it before serving: it must fall after the end of the
//! purchase's UTC day plus the time it takes to post that day's root (during the next UTC day), or the buyer
//! can reclaim before the record can be checked.
//!
//! Not audited. An example for devnet and local tests: not for real funds, not to be deployed on mainnet.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::{invoke, invoke_signed};
use anchor_lang::system_program;
use observation_roots::cpi::accounts::Verify;
use observation_roots::program::ObservationRoots;
use observation_roots::{ObservationFields, Verdict};
use solana_keccak_hasher::hashv;
use std::str::FromStr;

declare_id!("p7HTembyKn78rT4doqVneMw9qfck7yY3Zf3QRLCxMBA");

pub const TOKEN_PROGRAM_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const TOKEN_ACCOUNT_LEN: usize = 165;
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const VAULT_SEED: &[u8] = b"vault";

/// keccak256 of a string: the EIP-712 word of a string field, as `StrField::word` returns it.
pub fn keccak(s: &str) -> [u8; 32] {
    hashv(&[s.as_bytes()]).to_bytes()
}

#[program]
pub mod delivery_escrow_example {
    use super::*;

    /// The buyer locks `amount` tokens for the purchase (`network`, `pay_to`, `transaction`) until `deadline`
    /// (unix seconds). One escrow per buyer and transaction.
    pub fn deposit(ctx: Context<Deposit>, network: String, pay_to: String, transaction: String, amount: u64, deadline: i64) -> Result<()> {
        require!(amount > 0, EscrowError::ZeroAmount);
        require!(Clock::get()?.unix_timestamp < deadline, EscrowError::DeadlinePassed);
        let seller = Pubkey::from_str(&pay_to).map_err(|_| error!(EscrowError::PayToNotSeller))?;
        require_keys_eq!(seller, ctx.accounts.seller.key(), EscrowError::PayToNotSeller);
        require_keys_eq!(*ctx.accounts.mint.owner, TOKEN_PROGRAM_ID, EscrowError::NotTokenAccount);

        let escrow_key = ctx.accounts.escrow.key();
        let e = &mut ctx.accounts.escrow;
        e.buyer = ctx.accounts.buyer.key();
        e.seller = seller;
        e.mint = ctx.accounts.mint.key();
        e.amount = amount;
        e.deadline = deadline;
        e.network_hash = keccak(&network);
        e.pay_to_hash = keccak(&pay_to);
        e.transaction_hash = keccak(&transaction);
        e.bump = ctx.bumps.escrow;
        e.vault_bump = ctx.bumps.vault;

        // The vault: a token account at a PDA, owned by the escrow PDA.
        let vault_seeds: &[&[u8]] = &[VAULT_SEED, escrow_key.as_ref(), &[ctx.bumps.vault]];
        create_pda_account(&ctx.accounts.buyer, &ctx.accounts.vault, &ctx.accounts.system_program, vault_seeds)?;
        let mut data = vec![18u8]; // InitializeAccount3 { owner }
        data.extend_from_slice(escrow_key.as_ref());
        invoke(
            &Instruction {
                program_id: TOKEN_PROGRAM_ID,
                accounts: vec![AccountMeta::new(ctx.accounts.vault.key(), false), AccountMeta::new_readonly(ctx.accounts.mint.key(), false)],
                data,
            },
            &[ctx.accounts.vault.to_account_info(), ctx.accounts.mint.to_account_info()],
        )?;
        invoke(
            &transfer_ix(&ctx.accounts.buyer_tokens.key(), &ctx.accounts.vault.key(), &ctx.accounts.buyer.key(), amount),
            &[ctx.accounts.buyer_tokens.to_account_info(), ctx.accounts.vault.to_account_info(), ctx.accounts.buyer.to_account_info()],
        )?;
        msg!("deposited {} for {} until {}", amount, pay_to, deadline);
        Ok(())
    }

    /// Settles with the purchase's signed record: DELIVERED pays the seller, NOT_DELIVERED returns the tokens
    /// to the buyer. `destination` is the seller's or the buyer's token account for the mint.
    pub fn settle(ctx: Context<Settle>, day: u32, fields: ObservationFields, proof: Vec<[u8; 32]>) -> Result<()> {
        let e = &ctx.accounts.escrow;
        // The record must be about this purchase, at this amount.
        require!(
            fields.network.word() == e.network_hash && fields.pay_to.word() == e.pay_to_hash && fields.transaction.word() == e.transaction_hash,
            EscrowError::OtherPurchase
        );
        require!(fields.amount.word() == keccak(&e.amount.to_string()), EscrowError::OtherAmount);

        let cpi = CpiContext::new(ctx.accounts.observation_roots.to_account_info(), Verify { day_root: ctx.accounts.day_root.to_account_info() });
        let verdict = observation_roots::verify_cpi(cpi, day, fields, proof)?.verdict;
        let to = match verdict {
            Verdict::Delivered => e.seller,
            Verdict::NotDelivered => e.buyer,
            _ => return err!(EscrowError::VerdictSettlesNothing),
        };
        let moved = pay_out(&ctx.accounts.escrow, &ctx.accounts.vault, &ctx.accounts.destination, &ctx.accounts.buyer.to_account_info(), &ctx.accounts.token_program, to)?;
        if verdict == Verdict::Delivered {
            msg!("released {} to the seller {}: the record says DELIVERED", moved, to);
        } else {
            msg!("refunded {} to the buyer {}: the record says NOT_DELIVERED", moved, to);
        }
        Ok(())
    }

    /// After the deadline, the buyer takes back whatever was not settled.
    pub fn reclaim(ctx: Context<Reclaim>) -> Result<()> {
        require!(Clock::get()?.unix_timestamp >= ctx.accounts.escrow.deadline, EscrowError::DeadlineNotReached);
        let to = ctx.accounts.escrow.buyer;
        let moved = pay_out(&ctx.accounts.escrow, &ctx.accounts.vault, &ctx.accounts.destination, &ctx.accounts.buyer.to_account_info(), &ctx.accounts.token_program, to)?;
        msg!("reclaimed {} by the buyer {} after the deadline", moved, to);
        Ok(())
    }
}

/// Creates a 165-byte account owned by the token program at a PDA, paid by `payer`. Lamports sent to the
/// address beforehand do not block it.
fn create_pda_account<'info>(payer: &Signer<'info>, target: &UncheckedAccount<'info>, system: &Program<'info, System>, seeds: &[&[u8]]) -> Result<()> {
    let rent = Rent::get()?.minimum_balance(TOKEN_ACCOUNT_LEN);
    let have = target.lamports();
    let signer: &[&[&[u8]]] = &[seeds];
    if have == 0 {
        let cpi = CpiContext::new_with_signer(system.to_account_info(), system_program::CreateAccount { from: payer.to_account_info(), to: target.to_account_info() }, signer);
        return system_program::create_account(cpi, rent, TOKEN_ACCOUNT_LEN as u64, &TOKEN_PROGRAM_ID);
    }
    if have < rent {
        let cpi = CpiContext::new(system.to_account_info(), system_program::Transfer { from: payer.to_account_info(), to: target.to_account_info() });
        system_program::transfer(cpi, rent - have)?;
    }
    system_program::allocate(CpiContext::new_with_signer(system.to_account_info(), system_program::Allocate { account_to_allocate: target.to_account_info() }, signer), TOKEN_ACCOUNT_LEN as u64)?;
    system_program::assign(CpiContext::new_with_signer(system.to_account_info(), system_program::Assign { account_to_assign: target.to_account_info() }, signer), &TOKEN_PROGRAM_ID)
}

fn transfer_ix(from: &Pubkey, to: &Pubkey, authority: &Pubkey, amount: u64) -> Instruction {
    let mut data = vec![3u8]; // Transfer { amount }
    data.extend_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: TOKEN_PROGRAM_ID,
        accounts: vec![AccountMeta::new(*from, false), AccountMeta::new(*to, false), AccountMeta::new_readonly(*authority, true)],
        data,
    }
}

/// (mint, owner, amount) of a classic SPL token account.
fn read_token_account(a: &AccountInfo) -> Result<(Pubkey, Pubkey, u64)> {
    require_keys_eq!(*a.owner, TOKEN_PROGRAM_ID, EscrowError::NotTokenAccount);
    let d = a.try_borrow_data()?;
    require!(d.len() == TOKEN_ACCOUNT_LEN && d[108] == 1, EscrowError::NotTokenAccount); // state: initialized
    let mint = Pubkey::try_from(&d[0..32]).map_err(|_| error!(EscrowError::NotTokenAccount))?;
    let owner = Pubkey::try_from(&d[32..64]).map_err(|_| error!(EscrowError::NotTokenAccount))?;
    let amount = u64::from_le_bytes(d[64..72].try_into().map_err(|_| error!(EscrowError::NotTokenAccount))?);
    Ok((mint, owner, amount))
}

/// Moves the vault's whole balance to `destination` (a token account of `to` for the escrow's mint), closes
/// the vault with its rent to the buyer. The escrow account itself is closed by `close = buyer`.
fn pay_out<'info>(
    escrow: &Account<'info, Escrow>,
    vault: &UncheckedAccount<'info>,
    destination: &UncheckedAccount<'info>,
    buyer: &AccountInfo<'info>,
    token_program: &UncheckedAccount<'info>,
    to: Pubkey,
) -> Result<u64> {
    let (mint, owner, _) = read_token_account(&destination.to_account_info())?;
    require!(mint == escrow.mint && owner == to, EscrowError::WrongDestination);
    // The whole balance, so tokens someone sent to the vault cannot keep it from closing.
    let (_, _, balance) = read_token_account(&vault.to_account_info())?;
    let seeds: &[&[u8]] = &[ESCROW_SEED, escrow.buyer.as_ref(), escrow.transaction_hash.as_ref(), &[escrow.bump]];
    let infos = [vault.to_account_info(), destination.to_account_info(), escrow.to_account_info(), token_program.to_account_info()];
    invoke_signed(&transfer_ix(&vault.key(), &destination.key(), &escrow.key(), balance), &infos, &[seeds])?;
    invoke_signed(
        &Instruction {
            program_id: TOKEN_PROGRAM_ID,
            accounts: vec![AccountMeta::new(vault.key(), false), AccountMeta::new(buyer.key(), false), AccountMeta::new_readonly(escrow.key(), true)],
            data: vec![9u8], // CloseAccount
        },
        &[vault.to_account_info(), buyer.clone(), escrow.to_account_info(), token_program.to_account_info()],
        &[seeds],
    )?;
    Ok(balance)
}

#[account]
#[derive(InitSpace)]
pub struct Escrow {
    pub buyer: Pubkey,
    /// The record's payTo, as a Solana address.
    pub seller: Pubkey,
    pub mint: Pubkey,
    /// Must equal the record's `amount` (atomic units).
    pub amount: u64,
    /// Unix seconds after which the buyer may reclaim.
    pub deadline: i64,
    /// keccak256 of the record's `network`, `payTo` and `transaction` strings.
    pub network_hash: [u8; 32],
    pub pay_to_hash: [u8; 32],
    pub transaction_hash: [u8; 32],
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(Accounts)]
#[instruction(network: String, pay_to: String, transaction: String)]
pub struct Deposit<'info> {
    #[account(init, payer = buyer, space = 8 + Escrow::INIT_SPACE, seeds = [ESCROW_SEED, buyer.key().as_ref(), &keccak(&transaction)], bump)]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: created here as a token account (seeds checked).
    #[account(mut, seeds = [VAULT_SEED, escrow.key().as_ref()], bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: owner checked in the instruction; InitializeAccount3 checks it is a mint.
    pub mint: UncheckedAccount<'info>,
    /// CHECK: only its address is used; it must be the record's payTo.
    pub seller: UncheckedAccount<'info>,
    /// CHECK: the token program checks the mint and that the buyer owns it.
    #[account(mut)]
    pub buyer_tokens: UncheckedAccount<'info>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: address pinned.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut, close = buyer, seeds = [ESCROW_SEED, escrow.buyer.as_ref(), escrow.transaction_hash.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: seeds checked; read as a token account.
    #[account(mut, seeds = [VAULT_SEED, escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: mint and owner checked against the verdict in the instruction.
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: the escrow's buyer; receives the rent of the vault and the escrow.
    #[account(mut, address = escrow.buyer)]
    pub buyer: UncheckedAccount<'info>,
    /// CHECK: checked by observation-roots (seeds and owner) inside the CPI.
    pub day_root: UncheckedAccount<'info>,
    pub observation_roots: Program<'info, ObservationRoots>,
    /// CHECK: address pinned.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Reclaim<'info> {
    #[account(mut, close = buyer, has_one = buyer, seeds = [ESCROW_SEED, escrow.buyer.as_ref(), escrow.transaction_hash.as_ref()], bump = escrow.bump)]
    pub escrow: Account<'info, Escrow>,
    /// CHECK: seeds checked; read as a token account.
    #[account(mut, seeds = [VAULT_SEED, escrow.key().as_ref()], bump = escrow.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: must be the buyer's token account for the mint (checked in the instruction).
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: address pinned.
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: UncheckedAccount<'info>,
}

#[error_code]
pub enum EscrowError {
    #[msg("amount must be more than zero")]
    ZeroAmount,
    #[msg("the deadline has passed")]
    DeadlinePassed,
    #[msg("payTo is not the seller's Solana address")]
    PayToNotSeller,
    #[msg("not a classic SPL token account or mint")]
    NotTokenAccount,
    #[msg("the record is about another purchase")]
    OtherPurchase,
    #[msg("the record's amount differs from the deposit")]
    OtherAmount,
    #[msg("the verdict is MISMATCH or UNCLEAR: nothing settles before the deadline")]
    VerdictSettlesNothing,
    #[msg("the destination is not the token account the verdict pays")]
    WrongDestination,
    #[msg("the deadline has not passed")]
    DeadlineNotReached,
}
