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

## Money safety

Every paying script signs exactly one transfer per purchase, to the payTo locked from the seller's own 402, within a per-purchase cap and a persistent total cap, and refuses anything else before signing. Keys live in `.keys/` (git-ignored) and never appear in logs or results. Each money path was reviewed independently before it ran.

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
