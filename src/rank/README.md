# vet402 seller ranking

A ranking of paid-API sellers (x402 / MPP) built only from what happened when vet402, an independent
buyer, paid them with its own money. Call counts, payer counts and anything a seller says about itself
are not inputs, so a seller cannot buy a better rank by paying itself from many wallets (wash trading).

```
npm run rank -- --date 2026-09-28            # fetches what is not cached (.cache/rank/)
npm run rank -- --date 2026-09-28 --offline  # cache only
```

Output: `results/rank-<date>.json` and `results/rank-<date>.html` (static, no scripts, phone width).
The run is read-only: GET requests to public JSON and local result files. Nothing is signed or sent.

## Inputs

| chain | file | what a row is |
|---|---|---|
| Algorand | `kzmttkc/vet402-algorand` `board/census-2026-09-27.json`, `census-2026-09-28.json` | one listed endpoint per day |
| Solana | `~/vet402-solana-census/results/census-2026-09-28.json`, `~/vet402-solana/results/gate1-2026-09-29.json` | one endpoint per host |
| Tempo | `~/vet402-solana-tempo/results/tempo-ledger.json` (purchases), `tempo-run.log` (refusals, which never reach the ledger), `tempo-census-2026-09-28.dry-run.json` (URLs and Mercator ranks) | one service |
| Base | `~/vet402-solana-base/results/base-purchases.jsonl`, `base-feedback-ledger.json` | one purchase |

Each input's sha256 (and fetch time for remote ones) is recorded in the JSON under `inputs`.

## Common schema (`src/rank/types.ts`)

seller host, service id (Tempo), URL, payTo, chain, time, tried, settled, delivered, reason category,
the runner's raw reason and detail, tx, price, delivery check.

Reason categories. The first five count as **tried** (vet402 committed to pay):

| category | meaning |
|---|---|
| `delivered` | settled, and the answer passed the runner's delivery check |
| `not_settled` | vet402 sent a payment; the seller did not settle it and did not deliver |
| `settled_error_status` | settled, then a non-2xx answer |
| `settled_bad_content` | settled, 2xx, but the answer did not match what the seller declared |
| `unconfirmed_server_error` | 5xx and settlement could not be confirmed either way |
| `not_payable` | listed but not buyable (no 402, no usable accept, unreachable) — not counted |
| `payto_changed` | vet402 refused because the recipient differed from the recorded one — not counted, flagged |
| `vet402_skipped` | vet402's own policy (price cap, input it will not make up, duplicate) — not counted |

An unknown raw reason throws: a new failure mode cannot be silently counted or dropped.

## Ranking method

- **Score = Wilson score lower bound of delivered / tried, 95% (z = 1.96).**
  One lucky try scores 0.21; 18 of 20 scores 0.70. The score only rises with more evidence.
- Order: score desc, then delivered rate desc, then tries desc, then seller key. Equal score, rate and
  tries share a rank.
- Ranked = sellers with at least one tried purchase. Sellers seen only as not buyable / skipped are
  listed in the JSON counts but not ranked.
- Seller = hostname. When one host fronts several catalog services that each pay their own recipient
  (a proxy such as `mpp.orthogonal.com`), each service is its own seller: `host#service`.
- payTo changed = the same chain and URL asked for a different recipient in a later run, or vet402
  refused to pay because the recipient differed from the one recorded. A seller that accepts several
  chains has one recipient per chain; that is not a change. Shown as a flag, no effect on the score.
- **Money: vet402 buys with its own funds and takes no money from sellers** — no listing fee, no paid
  placement, no referral cut.

## Comparison with catalog order

| catalog | order used | note |
|---|---|---|
| CDP Bazaar | `quality.l30DaysTotalCalls`, summed per host | public discovery API; both calls and unique payers can be raised by a seller paying itself |
| Mercator | best search rank across the Tempo census query sweep (1 = first) | `relevance-price-v1`; no reliability number |
| PayAI discovery | — | no catalog-level usage or quality field |
| mpp.dev/api/services | — | no usage, quality or rank field |

Among ranked sellers the catalog lists, "high" = top half by the catalog's order (rounded up).
- high but never delivered = high, and 0 delivered out of every vet402 try
  (the count "after a settled payment" narrows it to sellers where vet402's payment settled on-chain and still nothing arrived)
- low but always delivered = not high, and every vet402 try delivered
- misaligned = the sum of the two. Spearman correlation between catalog order and score is also reported.

## Limits

- Delivery was judged by each chain runner and is not re-judged here. Algorand and the Solana census
  compare the answer's keys with what the seller declared; Tempo, Base and Solana gate1 accept any 2xx
  after settlement. The same seller behaviour is more likely to fail on the stricter check.
- `not_settled` includes cases where the cause may sit with the facilitator or vet402's transaction
  (e.g. a Solana `BlockhashNotFound` simulation failure), not only with the seller. The raw reason is
  kept on every row so a reader can check.
- A seller that recognises vet402's payer addresses (they are public) could treat vet402 better than
  other buyers.
- Sellers with many endpoints get many tries and a tight bound, so they fill the top.
