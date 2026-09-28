# vet402-delivery

vet402 pays an x402 (or MPP) API with its own money before an AI agent does, and records whether what came back matches what the listing promised, with the payment tx.

This repository is the multi-chain part of vet402: it buys sellers on **Solana, Tempo and Base** once each, keeps every result with its tx, and ranks sellers by what was actually delivered, not by how popular a listing is.

## What is here

| Part | What it does | Code |
|---|---|---|
| Solana census | Joins the PayAI, CDP Bazaar and Pay.sh catalogs and buys each seller once (one purchase per payTo), then records settled / delivered with the tx signature | `scripts/census.ts`, `src/census.ts` |
| Tempo census | Buys the MPP services listed in Tempo's Mercator directory on Tempo mainnet (USDC.e) and records the result | `scripts/tempo-census.ts`, `src/tempo/` |
| Base | Buys ERC-8004-registered sellers and writes the delivered result to the ERC-8004 ReputationRegistry with `proofOfPayment`, from the same address that paid | `scripts/base-buy.ts`, `scripts/base-feedback.ts`, `src/evm/` |
| Check skill | A check to run between "search" and "pay" in an agent's x402 flow | `skills/vet402-check/` |
| Delivery ranking | Ranks sellers by independent purchases; failures caused by vet402 or the facilitator are not counted against the seller | `src/rank/` (method: `src/rank/README.md`) |
| Public ranking site | Static pages (list, one page per seller, method) and `rank.json`, built from the inputs in `data/` and served by GitHub Pages | `scripts/build-site.ts`, `site/`, `data/` |
| First-buyer mode | Buys once, for life, from each Solana seller (payTo) that no one outside vet402 has paid yet, and publishes whether it settled and delivered, or why it cannot be paid | `scripts/first-buyer.ts`, `src/first-buyer/` |

## Money safety

Every paying script signs exactly one transfer per purchase, to the payTo locked from the seller's own 402, within a per-purchase cap and a persistent total cap, and refuses anything else before signing. Keys live in `.keys/` (git-ignored) and never appear in logs or results. Each money path was reviewed independently before it ran.

## First-buyer mode (Solana)

Some x402 sellers are listed but have never been paid by anyone. vet402 buys from each of them once, with its own money, so the seller learns whether a real payment settles and what comes back. Every record says: "One test purchase by vet402. Not organic demand."

Rules:
- One purchase per payTo, for life (`results/first-buyer-ledger.json`). The attempt is written before anything is signed; an attempt that never finished counts as paid. A failure where no signed payment left vet402 may be tried again at +7 and +30 days, then never.
- Who: a correct 402; price at or under 0.10 USDC; listed in PayAI, the CDP Bazaar or Pay.sh; new since `--since`; no USDC ever received from outside vet402 (read on chain); the payTo's USDC account exists; not a tunnel host (trycloudflare and similar); a usable example input; not vet402's own host or payTo.
- Caps: 0.10 USDC per purchase, 5 USDC per run, 20 USDC per calendar month (`results/first-buyer-budget-YYYY-MM.json`), on top of the existing payTo lock, transaction read-back and Budget.
- Opt-out: a payTo listed in `src/first-buyer/first-buyer-optout.json` is never bought. A request to be bought does not change who is chosen.
- No notification is sent to sellers by this code.
- "New since": until a run older than `--since` exists in `results/first-buyer-seen.json`, the only date is the catalogs' `lastUpdated`, which is a last-update time, not a first-listing time. Pay.sh listings carry no date and are skipped until then.

Published: the ledger (payTo, tx, time, settled, delivered, failure reason), `results/first-buyer/purchases.json`, and the buyer wallets in `results/first-buyer/wallets.json`, so analysts can subtract these payments.

Reciprocity: each ledger entry has `reciprocal.value`, false until checked. To check it, list USDC transfers into vet402's own Solana payTo addresses within 90 days after the purchase; if one comes from the seller's payTo (or a wallet the seller names as theirs), set it to true. Such a purchase is not counted as vet402 usage.

```bash
npm run first-buyer -- --dry-run --since 2026-09-21   # catalogs, unpaid 402s, chain reads, transaction build; pays nothing
```

## Scope and prior work

I (Sen) started vet402 on 2026-07-13. Before this repository, vet402 already had:
- the main product at https://vet402.com (purchase lanes on Base, Solana, Tempo and Arc);
- an Algorand version for the Algorand x402 Global Challenge: https://github.com/kzmttkc/vet402-algorand (its census data is read here as input to the ranking);
- entries at ETHGlobal ETHOnline 2026 and ETHGlobal Tokyo 2026 (their submitted code is not part of this repository).

The code in this repository was written from 2026-09-28 onward. Data from earlier purchases is used as input and is labelled with its date.

## Run

```bash
npm ci
npm test
```

Paying runs need keys in `.keys/` and are gated by explicit flags (`--pay`, `--write`) and, for Base, an environment variable as well.

## License

MIT
