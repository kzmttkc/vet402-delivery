# observation-roots (Solana program)

vet402 writes the Merkle root of each UTC day's signed delivery records (x402-observation/v0) into a Solana memo. A memo can be read by people, but not by other programs. observation-roots keeps the same root in an account that programs can read, and checks one record against it on chain, so an escrow, an insurance pool or any other program can ask "was this seller's purchase DELIVERED?" with one CPI.

It holds no funds. The only lamports it touches are the rent of its own accounts, paid by whoever creates them.

Status on 2026-09-30: tested on a local validator; not deployed on mainnet. Devnet program id (reserved): `58HtYvvBLCQisVNQyiSgFi9go6JY7CGpbiqhzqJDtknf`.

## What it does

| Instruction | Who | What |
|---|---|---|
| `initialize(authority)` | the program's upgrade authority only | creates the config and sets the key allowed to post roots (on mainnet: vet402's anchor wallet `9VaAPD1CPE4i8pquaRwE7LvZXMmvGdgffD4Q8xJgaQRu`) |
| `post_root(day, root, count, seq_start, seq_end, observer)` | the posting authority | creates the day's PDA `["root", day as u32 LE]`. A day can be posted once: the PDA is created with `init`, so a second post fails, whoever signs it. Refused while the UTC day is still open, for an invalid date, and when the sequence range does not match the count |
| `verify(day, fields, proof)` | anyone, directly or by CPI | recomputes the record's EIP-712 digest from `fields`, walks the proof to the day's root and fails unless it matches. On success it returns `{ day, verdict, sequence, digest }` through `set_return_data` |

`day` is `yyyymmdd` (20260928). The hashing is byte for byte that of `src/receipt/eip712.ts` and `src/receipt/merkle.ts`:

- digest = EIP-712 `hashTypedData`, domain `{ name: "x402 observation", version: "1", chainId: 1 }`, type `Observation` (17 fields)
- leaf = `keccak256(0x00 || digest)`, node = `keccak256(0x01 || min(a, b) || max(a, b))`, an odd node is carried up

The program computes the digest itself from the fields, so a caller cannot hand it a bare leaf or an inner node. The 0x00 and 0x01 prefixes keep a leaf and an inner node apart as well.

### Calling it from another program

```rust
let cpi = CpiContext::new(ctx.accounts.observation_roots.to_account_info(), Verify { day_root: ctx.accounts.day_root.to_account_info() });
require!(observation_roots::verify_cpi(cpi, day, fields, proof)?.verdict == Verdict::Delivered, MyError::NotDelivered);
```

`verify_cpi` checks that the program called is observation-roots and that the return data came from it. The full example is `programs/delivery-gate-example`: it first checks that the record is about the purchase it cares about (`fields.network.is(..)`, `fields.pay_to.is(..)`, `fields.transaction.is(..)`), then the line above. A real caller should also compare `amount` and `asset` if they matter to it. The program does not guarantee one record per transaction; in the 324 published records of 2026-09-28 and 2026-09-29 no transaction appears twice. Anchor's own `cpi::verify(..)?.get()` does not check where the return data came from, so use `verify_cpi`.

String fields travel as `Raw(string)` or `Hashed(keccak256(string))` (the EIP-712 word, same digest). Keep raw what the caller compares and hash the long rest: `compactFields()` in `src/receipt/roots-program.ts` does this. With the 2026-09-28 and 2026-09-29 records (proofs of 8 siblings), the example's transaction is 1,186 bytes with every field raw and 1,096 bytes compacted (limit 1,232), which leaves room for about 4 more tree levels (days of up to about 4,000 records).

What a DELIVERED answer means is what the record says, no more: see "Delivery records" in the top-level README. A record's later corrections are not signed and are not in the root, so `verify` does not see them.

## Build and test

```bash
npm run program:build   # cargo-build-sbf (Agave 4.3.0, platform-tools v1.57), Anchor 0.32.2
npm run program:test    # starts solana-test-validator (SOLANA_BIN or PATH) and runs solana-program/tests
```

The tests use the real published records of 2026-09-28 and 2026-09-29 (`data/records/`, 324 records) and their proofs: every record verifies with its own verdict (at most 17,945 compute units), a tampered verdict, seller, amount, transaction or proof fails, a record fails against the other day's root, `initialize` and `post_root` are refused for the wrong signer, a posted day cannot be posted again (also after someone sends lamports to its address first), and the example passes DELIVERED records and refuses NOT_DELIVERED ones, another network, seller or transaction, through CPI.

## Size and cost

`observation_roots.so` is 263,032 bytes. Rent from mainnet `getMinimumBalanceForRentExemption` on 2026-09-30:

| Account | Bytes | SOL |
|---|---|---|
| ProgramData (stays while the program exists) | 263,077 | 1.337081400 |
| Program | 36 | 0.000833120 |
| Deploy buffer (returned when the deploy completes) | 263,069 | 1.337040760 |
| Config | 41 | 0.000858520 |
| One day's root (paid by the posting authority each day) | 117 | 0.001244600 |

A deploy needs about 2.677 SOL in the deployer's wallet at its peak and leaves about 1.340 SOL spent (ProgramData, program, config, and 5,000 lamports for each of the roughly 265 write transactions). Each posted day costs 0.001244600 SOL of rent plus a 5,000 lamport fee.

## Upgrade authority

Deploy with a dedicated upgrade key (not the anchor wallet), initialize, publish the build hash, and freeze with `solana program set-upgrade-authority <id> --final` on a date announced here beforehand. Until then a fix is possible; after it, nobody can change the program, and the ProgramData rent can no longer be reclaimed. The posting authority cannot be rotated in this version, so a key rotation before the freeze would need an upgrade.

## Posting from the daily anchor

`scripts/anchor-receipts.ts --day <day> --post-root [--send]` (off unless asked for) copies a day that is already anchored by memo: it checks the memo on chain first, and posts exactly its root, count, sequence range and observer. The program id is pinned per cluster by genesis hash in `src/receipt/roots-program.ts` (`ROOTS_PROGRAM_BY_GENESIS`), never read from the environment, and a cluster without an entry is refused; mainnet has none today. The transaction is refused unless it holds only `post_root` with its four accounts in order and only the wallet and the day account writable, and unless the simulation shows the wallet spending no more than the day account's rent and the fee. Lamports sent to a day's address beforehand do not block the post. The memo stays the primary record.
