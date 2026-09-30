//! Example caller of observation-roots. An escrow, an insurance pool or any other
//! program can gate an action on "this seller's purchase was DELIVERED" with one CPI.
//! This one only checks and logs; it holds no funds.

use anchor_lang::prelude::*;
use observation_roots::cpi::accounts::Verify;
use observation_roots::program::ObservationRoots;
use observation_roots::{ObservationFields, Verdict};

declare_id!("BTVeASLyz5HvRz1eKChUgBj6hFbn89orEyGuTUW2yrUH");

#[program]
pub mod delivery_gate_example {
    use super::*;

    /// Proceeds only when the record for (`pay_to`, `transaction`) is in the day's root
    /// and its verdict is DELIVERED.
    pub fn require_delivered(
        ctx: Context<RequireDelivered>,
        pay_to: String,
        transaction: String,
        day: u32,
        fields: ObservationFields,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        // The record must be about the purchase this program cares about.
        require!(fields.pay_to.is(&pay_to) && fields.transaction.is(&transaction), GateError::OtherPurchase);

        let cpi = CpiContext::new(
            ctx.accounts.observation_roots.to_account_info(),
            Verify { day_root: ctx.accounts.day_root.to_account_info() },
        );
        // The condition, in one line:
        require!(observation_roots::verify_cpi(cpi, day, fields, proof)?.verdict == Verdict::Delivered, GateError::NotDelivered);

        msg!("condition met: {} delivered for {}", pay_to, transaction);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct RequireDelivered<'info> {
    /// CHECK: checked by observation-roots (seeds and owner) inside the CPI.
    pub day_root: UncheckedAccount<'info>,
    pub observation_roots: Program<'info, ObservationRoots>,
}

#[error_code]
pub enum GateError {
    #[msg("the record is about another purchase")]
    OtherPurchase,
    #[msg("the purchase was not DELIVERED")]
    NotDelivered,
}
