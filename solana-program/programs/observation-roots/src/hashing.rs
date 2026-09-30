//! EIP-712 digest and Merkle proof of an x402-observation record, byte for byte the
//! same as src/receipt/eip712.ts (viem hashTypedData) and src/receipt/merkle.ts.

use anchor_lang::prelude::*;
use solana_keccak_hasher::hashv;

use crate::keccak;

pub const DOMAIN_TYPE: &str = "EIP712Domain(string name,string version,uint256 chainId)";
pub const DOMAIN_NAME: &str = "x402 observation";
pub const DOMAIN_VERSION: &str = "1";
/// Off-chain signing format: chainId is fixed at 1 whatever the payment network.
pub const DOMAIN_CHAIN_ID: u64 = 1;

pub const OBSERVATION_TYPE: &str = "Observation(uint256 version,string id,uint256 sequence,string verdict,string network,string resourceUrl,string payer,string payTo,string asset,string amount,string transaction,uint256 httpStatus,string responseHash,string responseHashAlg,string responseHashEncoding,uint256 issuedAt,bytes32 contentHash)";

/// The four verdict words of x402-observation/v0.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verdict {
    Delivered,
    Mismatch,
    NotDelivered,
    Unclear,
}

impl Verdict {
    pub fn as_str(&self) -> &'static str {
        match self {
            Verdict::Delivered => "DELIVERED",
            Verdict::Mismatch => "MISMATCH",
            Verdict::NotDelivered => "NOT_DELIVERED",
            Verdict::Unclear => "UNCLEAR",
        }
    }
}

/// A string field of the signed message. EIP-712 encodes a string as keccak256 of its
/// bytes, so a caller may pass that hash instead of the string to keep the transaction
/// small. Pass `Raw` for any field the calling program needs to compare.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum StrField {
    Raw(String),
    Hashed([u8; 32]),
}

impl StrField {
    /// The field's EIP-712 encoded word.
    pub fn word(&self) -> [u8; 32] {
        match self {
            StrField::Raw(s) => keccak(s.as_bytes()),
            StrField::Hashed(h) => *h,
        }
    }

    /// True when the field is the string `s` (works for either form).
    pub fn is(&self, s: &str) -> bool {
        self.word() == keccak(s.as_bytes())
    }
}

/// The EIP-712 message of one record (src/receipt/eip712.ts `observationMessage`).
/// Optional strings are "" and optional integers 0, as signed.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ObservationFields {
    pub version: u64,
    pub id: StrField,
    pub sequence: u64,
    pub verdict: Verdict,
    pub network: StrField,
    pub resource_url: StrField,
    pub payer: StrField,
    pub pay_to: StrField,
    pub asset: StrField,
    pub amount: StrField,
    pub transaction: StrField,
    pub http_status: u64,
    pub response_hash: StrField,
    pub response_hash_alg: StrField,
    pub response_hash_encoding: StrField,
    pub issued_at: u64,
    pub content_hash: [u8; 32],
}

fn uint_word(v: u64) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&v.to_be_bytes());
    w
}

pub fn domain_separator() -> [u8; 32] {
    hashv(&[
        &keccak(DOMAIN_TYPE.as_bytes()),
        &keccak(DOMAIN_NAME.as_bytes()),
        &keccak(DOMAIN_VERSION.as_bytes()),
        &uint_word(DOMAIN_CHAIN_ID),
    ])
    .to_bytes()
}

pub fn struct_hash(f: &ObservationFields) -> [u8; 32] {
    hashv(&[
        &keccak(OBSERVATION_TYPE.as_bytes()),
        &uint_word(f.version),
        &f.id.word(),
        &uint_word(f.sequence),
        &keccak(f.verdict.as_str().as_bytes()),
        &f.network.word(),
        &f.resource_url.word(),
        &f.payer.word(),
        &f.pay_to.word(),
        &f.asset.word(),
        &f.amount.word(),
        &f.transaction.word(),
        &uint_word(f.http_status),
        &f.response_hash.word(),
        &f.response_hash_alg.word(),
        &f.response_hash_encoding.word(),
        &uint_word(f.issued_at),
        &f.content_hash,
    ])
    .to_bytes()
}

/// EIP-712 digest: keccak256(0x19 0x01 || domainSeparator || structHash).
pub fn observation_digest(f: &ObservationFields) -> [u8; 32] {
    hashv(&[&[0x19u8, 0x01][..], &domain_separator()[..], &struct_hash(f)[..]]).to_bytes()
}

/// leaf = keccak256(0x00 || digest)
pub fn leaf_hash(digest: &[u8; 32]) -> [u8; 32] {
    hashv(&[&[0x00u8][..], &digest[..]]).to_bytes()
}

/// node = keccak256(0x01 || min(a, b) || max(a, b)), compared as unsigned big-endian.
pub fn node_hash(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    hashv(&[&[0x01u8][..], &lo[..], &hi[..]]).to_bytes()
}

pub fn root_from_proof(digest: &[u8; 32], proof: &[[u8; 32]]) -> [u8; 32] {
    let mut h = leaf_hash(digest);
    for sib in proof {
        h = node_hash(&h, sib);
    }
    h
}
