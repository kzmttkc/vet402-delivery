/**
 * vet402's observation signing keys. verify-receipt checks every record against this list unless
 * --signer or --did names the key, so a record re-signed with any other key fails by default.
 * The key is separate from every payment key.
 */
export const VET402_OBSERVER_KEYS: readonly string[] = ["0x6232335B5264f7aa62a51f8ACc4676D22511Ff3C"];
/**
 * The Solana wallet that writes vet402's daily anchor memos (vet402's Solana payer). verify-receipt
 * accepts an anchor only when this wallet paid for and signed the memo transaction; a memo from any
 * other wallet is not an anchor, whatever root it names.
 */
export const VET402_ANCHOR_SIGNERS: readonly string[] = ["9VaAPD1CPE4i8pquaRwE7LvZXMmvGdgffD4Q8xJgaQRu"];
