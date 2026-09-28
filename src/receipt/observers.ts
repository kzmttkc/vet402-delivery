/**
 * vet402's observation signing keys. verify-receipt checks every record against this list unless
 * --signer or --did names the key, so a record re-signed with any other key fails by default.
 * The key is separate from every payment key.
 */
export const VET402_OBSERVER_KEYS: readonly string[] = ["0x6232335B5264f7aa62a51f8ACc4676D22511Ff3C"];
