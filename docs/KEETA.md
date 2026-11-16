# Keeta remeasure lane

Keeta sellers are listed in `src/keeta/constants.ts` (`KEETA_SELLERS`). The daily runner invokes `npm run keeta -- --dry-run` when `~/.config/vet402-daily/keeta-enabled` exists.

## Sellers (2026-11-16)

| Host | payTo (pinned) | Per run |
|------|----------------|---------|
| `keespecs.xyz` | catalog payTo | up to 12 payable routes |
| `kta-oracle.top` | `keeta_aab4y4nd5ug4nnzjtp5fslfsrdv7pnxfbeexafwolqs4mgxrb2ppontfqb64tzi` | up to 3 payable routes (`freeTrial: true`) |

Run-wide caps are unchanged: 15 purchases, 0.25 USDC per run, 6 USDC / month, 20_000 atomic per purchase.

### kta-oracle.top (`freeTrial`)

The oracle catalog lists both Keeta USDC and KTA accepts; vet402 pays only the USDC accept (`pickKeetaAccept`). Unpaid GETs often return 200 during the advertised sandbox trial, so the lane builds `PaymentRequired` from the catalog accept and sends a paid GET first. If the unpaid GET returns 402, the usual 402 path is used. After a signature is sent, ledger `notFound` stops with `keeta_tx_not_found` and the budget commit stays (same as the 402 path). `free_response` is only for an unpaid GET 200 with an empty body (no signature). Paid GET 402 is `refused` / `paid_get_402` with commit kept.