# observation-roots (Solana program)

vet402 writes the Merkle root of each UTC day's signed delivery records (x402-observation/v0) into a Solana memo. A memo can be read by people, but not by other programs. observation-roots keeps the same root in an account that programs can read, and checks one record against it on chain, so an escrow, an insurance pool or any other program can ask "was this seller's purchase DELIVERED?" with one CPI.

It holds no funds. The only lamports it touches are the rent of its own accounts, paid by whoever creates them.

Status on 2026-10-01: not deployed yet. Program id (mainnet): `EvDMa6KWbFGT48L9oce8U9SwxCWaAKR2aZEJNX8JeZC3`. Tested on a local validator started with a copy of mainnet's feature set.

## What it does

| Instruction | Who | What |
|---|---|---|
| `initialize(authority)` | the program's upgrade authority only | creates the config and sets the key allowed to post roots. On mainnet that is a posting key of its own, `Ew2RYGSWQygVoPTgp1kQzQUcyAfsQ6n5RPZYr2B7CsxW`, separate from the wallet that pays for purchases and writes the memo |
| `propose_authority(new)` | the program's upgrade authority only | names the next posting key. Nothing changes yet; proposing again replaces it |
| `accept_authority()` | the proposed key | takes over as the posting authority. A key that cannot sign never becomes the authority |
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

`verify_cpi` checks that the program called is observation-roots and that the return data came from it. The full example is `programs/delivery-gate-example`: it first checks that the record is about the purchase it cares about (`fields.network.is(..)`, `fields.pay_to.is(..)`, `fields.transaction.is(..)`), then the line above. A real caller should also compare `amount` and `asset` if they matter to it. The program does not guarantee one record per transaction; in the 520 published records of 2026-09-28 to 2026-09-30 no transaction appears twice. Anchor's own `cpi::verify(..)?.get()` does not check where the return data came from, so use `verify_cpi`.

String fields travel as `Raw(string)` or `Hashed(keccak256(string))` (the EIP-712 word, same digest). Keep raw what the caller compares and hash the long rest: `compactFields()` in `src/receipt/roots-program.ts` does this. With the 2026-09-28 to 2026-09-30 records (proofs of 8 siblings), the example's transaction is 1,186 bytes with every field raw and 1,096 bytes compacted (limit 1,232), which leaves room for about 4 more tree levels (days of up to about 4,000 records).

What a DELIVERED answer means is what the record says, no more: see "Delivery records" in the top-level README. A record's later corrections are not signed and are not in the root, so `verify` does not see them.

## Build and test

```bash
npm run program:build                    # cargo-build-sbf --arch v3 (SBPF v3; Agave 4.3.0, platform-tools v1.57), Anchor 0.32.2
npm run program:test                     # starts solana-test-validator (SOLANA_BIN or PATH) and runs solana-program/tests
npm run program:test:mainnet-features    # the same, with the validator's feature set copied from mainnet
```

The tests use the real published records of 2026-09-28 to 2026-09-30 (`data/records/`, 520 records) and their proofs: every record verifies with its own verdict (at most 17,898 compute units), a tampered verdict, seller, amount, transaction or proof fails, a record fails against the other day's root, `initialize` and `post_root` are refused for the wrong signer, a posted day cannot be posted again (also after someone sends lamports to its address first), and the example passes DELIVERED records and refuses NOT_DELIVERED ones, another network, seller or transaction, through CPI. The posting key changes only by propose then accept. The built `.so` deploys with the solana CLI under mainnet's feature set, and the on-chain program bytes read back equal the local file.

## Size and cost

`observation_roots.so` (SBPF v3) is 247,448 bytes. Rent from mainnet `getMinimumBalanceForRentExemption` on 2026-10-01:

| Account | Bytes | SOL |
|---|---|---|
| ProgramData (stays while the program exists) | 247,493 | 1.257914680 |
| Program | 36 | 0.000833120 |
| Deploy buffer (returned when the deploy completes) | 247,485 | 1.257874040 |
| Config | 74 | 0.001026160 |
| One day's root (paid by the posting key each day) | 117 | 0.001244600 |

A deploy needs about 2.519 SOL in the deployer's wallet at its peak (the two large accounts, the program, the config, and 5,000 lamports for each of roughly 250 write transactions) and leaves about 1.261 SOL spent. Each posted day costs 0.001244600 SOL of rent plus a 5,000 lamport fee, paid by the posting key, which must also keep 0.000650240 SOL (the rent-exempt minimum of an empty account).

## Deploying on mainnet

Keys live in `.keys/mainnet/` (git-ignored, mode 600) of the checkout that deploys:

| File | Address | Role |
|---|---|---|
| `deployer.json` | `DNkH3i35X29YjALuK7ay2qB95fmduHxfQJkCKqA6Jakh` | pays the deploy, upgrade authority, signs `initialize` and `propose_authority` |
| `observation_roots-program.json` | `EvDMa6KWbFGT48L9oce8U9SwxCWaAKR2aZEJNX8JeZC3` | the program id (used once, at deploy) |
| `roots-poster.json` | `Ew2RYGSWQygVoPTgp1kQzQUcyAfsQ6n5RPZYr2B7CsxW` | posting authority: signs `post_root`, pays its fee and the day's rent |

1. Build and record the hash: `npm run program:build && shasum -a 256 solana-program/target/deploy/observation_roots.so`.
2. Deploy, with the program id and the deploy key named explicitly:
   ```bash
   solana program deploy solana-program/target/deploy/observation_roots.so \
     --program-id .keys/mainnet/observation_roots-program.json \
     --keypair .keys/mainnet/deployer.json \
     --upgrade-authority .keys/mainnet/deployer.json \
     --url mainnet-beta --commitment finalized
   ```
3. Check what landed: `npx tsx scripts/roots-mainnet.ts check` reads the ProgramData account and compares its program bytes with the local `.so` (same sha256, the rest zero padding) and its upgrade authority with the deploy key. By hand: `solana program dump EvDMa6KWbFGT48L9oce8U9SwxCWaAKR2aZEJNX8JeZC3 onchain.so -um && head -c 247448 onchain.so | shasum -a 256`.
4. Initialize: `npx tsx scripts/roots-mainnet.ts init` (simulates), then `init --send`. It refuses unless step 3 checks, and sets the posting authority to the pinned posting key.
5. Fund the posting key: about 0.012 SOL covers nine days (9 x (0.001244600 + 0.000005) + 0.000650240 = 0.011896640 SOL).
6. Post a day already anchored by memo: `npx tsx scripts/anchor-receipts.ts --day <day> --post-root` (simulates), then add `--send`.

## Upgrade authority

For now the deploy key `DNkH3i35X29YjALuK7ay2qB95fmduHxfQJkCKqA6Jakh` keeps it, so a fix stays possible. It is also the only key that can propose a new posting key. Freezing (`solana program set-upgrade-authority EvDMa6KWbFGT48L9oce8U9SwxCWaAKR2aZEJNX8JeZC3 --final`) happens only on a date announced here beforehand. After it nobody can change the program, the ProgramData rent can no longer be reclaimed, and the posting key can no longer be replaced.

## Posting from the daily anchor

`scripts/anchor-receipts.ts --day <day> --post-root [--send]` (off unless asked for) copies a day that is already anchored by memo: it checks the memo on chain first, and posts exactly its root, count, sequence range and observer. The program and the posting key are pinned per cluster by genesis hash in `src/receipt/roots-program.ts` (`ROOTS_DEPLOYMENTS_BY_GENESIS`), never read from the environment, and any other cluster is refused. `post_root` is signed and paid by the posting key (`.keys/mainnet/roots-poster.json`), never by the wallet that pays for purchases. The transaction is refused unless it holds only `post_root` with its four accounts in order and only the posting key and the day account writable, and unless the simulation shows the posting key spending no more than the day account's rent and the fee. Lamports sent to a day's address beforehand do not block the post. The memo stays the primary record.

The CPI example (`programs/delivery-gate-example`) is for local tests and devnet only; it is not deployed on mainnet.
