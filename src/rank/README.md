# vet402 seller ranking

A ranking of paid-API sellers (x402 / MPP) built only from what happened when vet402, an independent
buyer, paid them with its own money. Call counts, payer counts and anything a seller says about itself
are not inputs, so a seller cannot buy a better rank by paying itself from many wallets (wash trading).

```
npm run rank -- --date 2026-09-28            # fetches what is not cached (.cache/rank/)
npm run rank -- --date 2026-09-28 --offline  # cache only
```

Output: `results/rank-<date>.json` and the pages in `results/rank-<date>/` (static, no scripts, phone width):
`index.html` (one row per seller: grade, arrived n/N, last purchase date), `method.html` (independence,
fault rules, grades, change log, how to reproduce) and `s/<seller>.html` (failures by who was at fault,
recent tx, how to ask for a correction).
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
| `delivered` | settled, then a 2xx answer with a non-empty body (same test on every chain) |
| `not_settled` | vet402 sent a payment; the seller did not settle it and did not deliver |
| `settled_error_status` | settled, then a non-2xx answer |
| `settled_empty_body` | settled, 2xx, but the body was empty |
| `unconfirmed_server_error` | 5xx and settlement could not be confirmed either way |
| `not_payable` | listed but not buyable (no 402, no usable accept, unreachable) — not tried |
| `payto_changed` | vet402 refused because the recipient differed from the recorded one — not tried, flagged |
| `vet402_skipped` | vet402's own policy (price cap, input it will not make up, duplicate) — not tried |

An unknown raw reason throws: a new failure mode cannot be silently counted or dropped.

`declaredMatch` is a separate column: whether the answer's keys or shape matched what the seller
declared. Only the Algorand census and the Solana census compare them, and only when the seller declared
something. It never changes `delivered` or the grade.

## Method v2

### 1. Who was at fault (`src/rank/classify.ts`)

Every tried purchase that did not arrive gets exactly one rule, the first that matches from the top.
Only **seller** failures count toward the grade. **vet402_or_facilitator** and **unknown** failures are
shown as counts (per seller, per rule, and in the report totals) and never lower a grade.

| rule | fault | when |
|---|---|---|
| `paid_not_delivered` | seller | vet402's payment settled, then non-2xx or an empty body |
| `rate_limited_429` | vet402_or_facilitator | HTTP 429 during vet402's burst buying (hundreds of one seller's items within minutes) |
| `subcent_quota` | vet402_or_facilitator | `subcent_quota_exceeded`: vet402's many sub-cent purchases used up the per-payer quota |
| `payment_tx_rejected` | vet402_or_facilitator | the payment tx vet402 built was rejected before settling: simulation failed, `BlockhashNotFound`, already in ledger, `txn dead` (validity window passed), facilitator unavailable, `invalid_exact_svm*` |
| `server_error_5xx` | seller | the seller's server answered 5xx and no settlement happened |
| `timeout` | unknown | vet402's request timed out; a slow seller and a short timeout look the same |
| `request_rejected_4xx` | unknown | 4xx other than 402 (400, 401, 404, 422 …) before settlement; vet402 made the input |
| `payment_not_accepted_402` | unknown | 402 again after paying, with no reason that points to either side |
| `answer_without_settlement` | unknown | 2xx but no settlement of vet402's payment found |
| `unclassified` | unknown | none of the above (kept visible; never lowers a grade) |

A test checks that this table lists every rule in `FAULT_RULES`, with the same fault, in the same order.

Why 429 and `subcent_quota_exceeded` are vet402's side: on 2026-09-27 and 09-28 the Algorand census bought
~500 endpoints of one seller (agent402.tools) within 30–47 minutes, and all 968 of these failures came
from that seller in those windows. Checked on the data: the 429s begin after ~20 quick purchases, but
`subcent_quota_exceeded` already came back on the first sub-cent purchase of each day (other sellers
delivered 128+ sub-cent purchases in the same runs), so it may be a per-payer quota that outlasts one
run. If purchases paced as in section 2 still get either reply, both rules move to the seller side.

### 2. How vet402 buys (`src/constants.ts`)

- `MEASURE_MAX_PER_SELLER = 5`: at most 5 purchases from one seller in one measurement run.
- `MEASURE_SPACING_MS = 60000`: at least 60 s between two purchases from the same seller.
- Enforced by `SellerPacer` (`src/measure.ts`) in `scripts/gate1.ts`, the buying script in this repo.
  The Algorand and Solana census runners live in their own repos and should take the same two numbers.
- Only the count and the spacing. Amounts, payTo checks and the money caps are unchanged.
- Applies from method v2 on; the 2026-09-27/28 inputs predate it.

### 3. Delivery test, the same on every chain

Delivered = settled, then 2xx with a non-empty body (`text.trim()` not empty, as the Solana gate1 and
Base runners already test). Algorand and Solana census rows that failed only the stricter declared-keys
check are re-judged with this test; the Algorand runner's delivery line
(`<status> <content-type> <summary>`) and the Solana census `httpStatus` / `first300` carry what is needed.
The Tempo runner kept no body, so on Tempo delivered = settled + 2xx (`bodyChecked: false`).

### 4. Grades and rank numbers (`src/rank/score.ts`)

- Counted = delivered + seller-side failures. Interval = 95% Wilson score interval (z = 1.96) of
  delivered / counted.
- **Rank number only with `MIN_COUNTED = 10` counted purchases on `MIN_DAYS = 2` different UTC days.**
  Everyone else is listed as **measuring**: no grade, no number, sorted by name.
- Grades, asymmetric on purpose:
  - A: lower bound ≥ 0.90
  - B: lower bound ≥ 0.75
  - C: lower bound ≥ 0.50
  - D: **upper** bound < 0.50 (bad only when the evidence says so)
  - undecided: none of the above
- 10 out of 10 has a lower bound of 0.72 (grade C); an A needs about 35 out of 35.
- Order among ranked sellers: lower bound desc, then delivered rate desc, then counted desc, then seller
  key. Equal lower bound, rate and count share a number.
- Seller = hostname. When one host fronts several catalog services that each pay their own recipient
  (a proxy such as `mpp.orthogonal.com`), each service is its own seller: `host#service`.
- payTo changed = the same chain and URL asked for a different recipient in a later run, or vet402
  refused to pay because the recipient differed from the one recorded. A seller that accepts several
  chains has one recipient per chain; that is not a change. Shown as a flag, no effect on the grade.
- **Money: vet402 buys with its own funds and takes no money from sellers** — no listing fee, no paid
  placement, no referral cut.

### 5. Corrections

Each seller page links to a prefilled GitHub issue (`APPEAL_ISSUES_URL` in `src/rank/report.ts`). A wrong
row is fixed after checking the chain and the raw result, and the fix goes in the change log.

### Change log

- **v2 (2026-09-28)**: fault split (seller / vet402 or facilitator / can't tell), one delivery test on
  every chain with the declared match as a separate column, rank numbers only with 10 counted purchases on
  2+ days, grades A–D with asymmetric bounds, measurement pacing 5 per seller per run, 60 s apart.
- **v1 (2026-09-28, 08addc8)**: Wilson lower bound of delivered / every tried purchase, each runner's own
  delivery check, every seller with one try ranked.

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

- Purchases from one seller in one run are not independent (one outage fails many at once), so the
  interval is narrower than it should be for runs before v2 pacing.
- The fault rules read the runner's reason text. A reason that matches no rule lands in `unclassified`
  (can't tell), which is safe for sellers but hides nothing: the count is in the report.
- Some inputs are local files of vet402's runners; their sha256 is recorded but they are not yet public.
- A seller that recognises vet402's payer addresses (they are public) could treat vet402 better than
  other buyers.
- Sellers with many endpoints get many tries and a tight bound, so they fill the top.
