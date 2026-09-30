# vet402 seller ranking

A ranking of paid-API sellers (x402 / MPP) built only from what happened when vet402, an independent
buyer, paid them with its own money. Call counts, payer counts and anything a seller says about itself
are not inputs, so a seller cannot buy a better rank by paying itself from many wallets (wash trading).

```
npm run rank -- --data data --offline --out /tmp/rank   # only the published inputs in data/, no network
npm run rank -- --date 2026-09-28            # the runners' own files; fetches what is not cached (.cache/rank/)
npm run rank -- --date 2026-09-28 --offline  # cache only
```

Output: `results/rank-<date>.json` and, in `results/rank-<date>/`, the same pages as the public site
below (without the delivery records).
The run is read-only: GET requests to public JSON and local result files. Nothing is signed or sent.

## Public site

`scripts/build-site.ts` turns one report JSON into the site that GitHub Pages serves
(`.github/workflows/pages.yml`, on every push to main, no secrets):

```
npm run rank -- --data data --offline --out /tmp/rank
npx tsx scripts/build-site.ts --report /tmp/rank/rank-2026-09-28.json --out site
```

| page | what it shows |
|---|---|
| `index.html` | Solana, Tempo and Base: what vet402 bought and what came back (tried, settled, came back with an answer, settled with nothing usable back), then one table per chain with every seller by name and that chain's numbers, shown in full even before any seller has a grade. A grade and a rank number appear only with 10 counted purchases on 2+ days, graded from these three chains only. The number of failed purchases that were not counted (vet402 or facilitator side, can't tell) is always shown. |
| `algorand.html` | Algorand, from vet402-algorand (a separate entry): the same four numbers, then graded, undecided and measuring sellers, none folded, graded from Algorand purchases only |
| `seller/<id>.html` | one part per page the seller is on, each from that page's purchases only: how many times vet402 paid and what came back, grade, came back n/N, 95% interval, chains, not-counted failures by rule, failures counted against the seller, recent purchases with each tx linked to an explorer (Solana: solscan.io, Algorand: allo.info, Tempo: explore.tempo.xyz, Base: basescan.org); then a prefilled GitHub issue link |
| `method.html` | version and change log, how vet402 pays for this, counted and not counted, fault rules, grade thresholds, limits, the reproduce commands, every input with its sha256, and vet402's own record (failures on its side) |
| `rank.json` | the report itself, byte for byte: the same numbers as the pages |

`site/` in the repo is a built copy for review; the workflow builds its own from `data/`.
Every string a seller controls is escaped, pages carry a CSP with `script-src 'none'`, and tx links are
built only from ids that match the chain's format.

## Published inputs (`data/`)

`data/manifest.json` lists every input with its sha256; `--data` refuses a file whose sha256 differs.

| path | copy of |
|---|---|
| `algorand/census-2026-09-27.json`, `census-2026-09-28.json` | `kzmttkc/vet402-algorand` `board/` at main 20857e6 (includes the 6-row correction of 127addc) |
| `solana/census-2026-09-28.json`, `gate1-2026-09-29.json` | the Solana census and gate1 result files |
| `tempo/ledger.json`, `run-log.txt`, `census-plan-2026-09-28.json` | the Tempo ledger, run log and census plan; the manifest keeps the log's write time (`loggedAt`) because its refusal lines carry no time |
| `base/purchases.jsonl`, `feedback-ledger.json` | the Base purchases and ERC-8004 feedback ledger |
| `remeasure/solana-YYYY-MM-DD.json`, `remeasure/tempo-YYYY-MM-DD.json` | the daily re-purchases from Solana and Tempo sellers vet402 already paid (`~/vet402-solana/results/remeasure`); each is read as purchases on its day |
| `cdp/discovery-2026-09-28.json` | CDP Bazaar discovery, reduced to `resource` and three `quality` fields per item (the only fields the comparison reads), with the sha256 of each of the 18 raw pages |

Payer addresses, payTo addresses and tx ids are public on-chain and stay in. The files hold no keys.
`vet402-algorand` commit 127addc records 6 rows of gateway-x402.vercel.app ("already in ledger") as paid
(`paid: true` with `payment_failed`, see Corrections in the vet402-algorand README). They are read as
settled with a 402 answer and count on the seller side (rule `settled_not_delivered`).

## Inputs

| chain | file | what a row is |
|---|---|---|
| Algorand | `kzmttkc/vet402-algorand` `board/census-2026-09-27.json`, `census-2026-09-28.json` | one listed endpoint per day |
| Solana | `~/vet402-solana-census/results/census-2026-09-28.json`, `~/vet402-solana/results/gate1-2026-09-29.json` | one endpoint per host |
| Tempo | `~/vet402-solana-tempo/results/tempo-ledger.json` (purchases), `tempo-run.log` (refusals, which never reach the ledger), `tempo-census-2026-09-28.dry-run.json` (URLs and Mercator ranks) | one service |
| Base | `~/vet402-solana-base/results/base-purchases.jsonl`, `base-feedback-ledger.json` | one purchase |
| Solana, Tempo | `~/vet402-solana/results/remeasure/<chain>-YYYY-MM-DD.json` (remeasure, every day up to the report date) | one re-purchase |

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
| `not_payable` | listed but not buyable (no 402, no usable accept, unreachable); not tried |
| `payto_changed` | vet402 refused because the recipient differed from the recorded one; not tried, flagged |
| `vet402_skipped` | vet402's own policy (price cap, input it will not make up, duplicate); not tried |

An unknown raw reason throws: a new failure mode cannot be silently counted or dropped.

`declaredMatch` is a separate column: whether the answer's keys or shape matched what the seller
declared. Only the Algorand census and the Solana census compare them, and only when the seller declared
something. It never changes `delivered` or the grade.

## Method v3

v3 grades each page from its own chains only (section 4); everything else is as in v2.

### 1. Who was at fault (`src/rank/classify.ts`)

Every tried purchase that did not arrive gets exactly one rule, the first that matches from the top.
Only **seller** failures count toward the grade. **vet402_or_facilitator** and **unknown** failures are
shown as counts (per seller, per rule, and in the report totals) and never lower a grade.

| rule | fault | when |
|---|---|---|
| `settled_not_delivered` | seller | paid on chain, answered 402, delivered nothing: vet402's payment settled on chain (a facilitator error such as "already in ledger" included), then the seller answered 402. The buyer paid and received nothing, and the seller chose the facilitator |
| `paid_then_4xx` | unknown | vet402's payment settled, then 4xx other than 402 (400, 401, 404, 422, 429 …). vet402 built the request from the seller's listing, so a fault on its side is not ruled out; the signed records call the same case UNCLEAR (`src/receipt/build.ts`). Shown as a count (v3) |
| `paid_not_delivered` | seller | vet402's payment settled, then 5xx, no answer, another non-2xx that is not a 4xx, or 2xx with an empty body |
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
- Remeasure window (the plan): 2026-09-29 to 2026-10-08 (UTC days), twice a day on Solana and once on Tempo.
  Remeasure (`scripts/remeasure.ts`, see the top-level README) buys again from the Solana and Tempo sellers whose
  earlier payment settled. The ledger allows one purchase per recipient per slot per UTC day, so where several sellers
  share one payTo, one of them is bought; payTo and price are locked to the earlier payment. Which sellers were
  bought again is decided by the rows in `data/remeasure/`, and a correction can change them. The days it ran are
  the files in `data/remeasure/`. Base sellers have been bought once.

### 3. Delivery test, the same on every chain

Delivered ("came back with an answer" on the pages) = settled, then 2xx with a non-empty body
(`text.trim()` not empty, as the Solana gate1 and Base runners already test). vet402 does not check
that the answer is what the listing promised; whether its keys matched what the seller declared is the
separate `declaredMatch` column. Algorand and Solana census rows that failed only the stricter declared-keys
check are re-judged with this test; the Algorand runner's delivery line
(`<status> <content-type> <summary>`) and the Solana census `httpStatus` / `first300` carry what is needed.
The Tempo census runner kept no body, so for the Tempo ledger purchases delivered = settled + 2xx
(`bodyChecked: false`). The Tempo re-purchases (remeasure) record `bodyBytes` and are tested for an
empty body like every other chain.

Settled: on Solana, Tempo and Base the runner checked vet402's payment on chain before recording it as
settled. On Algorand, settled is the facilitator's successful settlement receipt with a tx id (the
`paid` field of the vet402-algorand census); vet402 has not read those payments back on chain. The
Algorand page and the method table say "with a settlement receipt" instead of "settled on chain".

### 4. Grades and rank numbers (`src/rank/score.ts`)

- **Per page (v3, `GROUPS` in `src/rank/report.ts`).** The first page (`index.html`) is graded from
  Solana, Tempo and Base purchases only; the Algorand page (`algorand.html`) from Algorand purchases only.
  A seller bought on both sides has two separate figures, grades and rank numbers, one per page, and its
  seller page shows both parts apart. `rank.json` keeps them apart under `groups`.
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
- **Money:** Grades come only from vet402's own purchases. vet402 also sells paid checks (paid in USDC on Algorand or Base); a paid check is a separate report and never moves a grade.
  No listing fee, no paid placement, no referral cut. The paid checks are `/v1/check` and `/v1/audit` in
  vet402-algorand. The ranking reads only the purchase files listed in `data/manifest.json`; on Algorand
  those census purchases were paid from the board wallet (`HVRJUK…`), not from the payer wallet that the
  paid checks use (`OZ3KML…`).

### 5. Corrections

Each seller page links to a prefilled GitHub issue in https://github.com/kzmttkc/vet402-delivery/issues
(`APPEAL_ISSUES_URL` in `src/rank/report.ts`). A wrong
row is fixed after checking the chain and the raw result, and the fix goes in the change log.

### Change log

- **v3 (2026-09-29)**: grades are computed per page. What changed: the first page (Solana, Tempo and
  Base) is graded from those three chains' purchases only, and the Algorand page from Algorand purchases
  only. Before (v2), one grade per seller mixed the purchases of every chain. Effect on the 2026-09-29
  report: no grade and no rank number changed. Five sellers were bought on both sides (agent402.tools,
  coil.trade, whaletape.xyz, api.syraa.fun, midax402.com); the three with grade A in v2 keep A and their
  rank on the Algorand page, now counted from Algorand purchases only (agent402.tools 43/43 instead of
  46/46, coil.trade 40/40 instead of 42/42, whaletape.xyz 50/50 instead of 52/52), and are measuring on
  the first page. Also in v3: the first page shows every Solana, Tempo and Base purchase per chain and per
  seller before any grade exists; the Algorand page folds nothing; comparisons with catalog order are
  made per page. Fault rule `paid_then_4xx` (can't tell): a settled payment followed by a 4xx other than
  402 is no longer counted against the seller, the same line as the signed records (UNCLEAR); 5xx, 402
  again, no answer and an empty 2xx after settlement stay on the seller's side. On the 2026-09-29 report
  40 purchases on Solana, Tempo and Base (Solana 4, Tempo 36) and 2 on Algorand move to not counted, and
  no grade or rank number changes (every seller concerned was still measuring). "Settled" on Algorand is
  named for what it is (a facilitator's settlement receipt with a tx id, not read back on chain by
  vet402), and the Tempo body note says which purchases kept no body. Inputs: the daily re-purchases (remeasure) from Solana and Tempo sellers vet402 already
  paid are read as purchases on their day; they have been read since 2026-09-29 and this entry is the
  first to say so. Wording only, no change to the test: "delivered" is shown as "came back with an
  answer", with the note that vet402 did not check the answer against the listing, and the money sentence
  now says that grades come only from vet402's own purchases and a paid check never moves a grade.
- **v2 (2026-09-28)**: fault split (seller / vet402 or facilitator / can't tell), one delivery test on
  every chain with the declared match as a separate column, rank numbers only with 10 counted purchases on
  2+ days, grades A–D with asymmetric bounds, measurement pacing 5 per seller per run, 60 s apart.
- **2026-09-28**: the 6 corrected rows of the Algorand census are in (see Corrections in the vet402-algorand
  README): paid on chain, answered 402, delivered nothing; counted on the seller side.
- **v1 (2026-09-28, 08addc8)**: Wilson lower bound of delivered / every tried purchase, each runner's own
  delivery check, every seller with one try ranked.

## Comparison with catalog order

| catalog | order used | note |
|---|---|---|
| CDP Bazaar | `quality.l30DaysTotalCalls`, summed per host | public discovery API; both calls and unique payers can be raised by a seller paying itself |
| Mercator | best search rank across the Tempo census query sweep (1 = first) | `relevance-price-v1`; no reliability number |
| PayAI discovery | none | no catalog-level usage or quality field |
| mpp.dev/api/services | none | no usage, quality or rank field |

Each page is compared on its own (v3). Among the page's sellers the catalog lists, "high" = top half by
the catalog's order (rounded up). A catalog with no seller on a page is left out for that page.
- high but never delivered = high, and 0 delivered out of every vet402 try
  (the count "after a settled payment" narrows it to sellers where vet402's payment settled on-chain and still nothing arrived)
- low but always delivered = not high, and every vet402 try delivered
- misaligned = the sum of the two. Spearman correlation between catalog order and score is also reported.

## Limits

- Purchases from one seller in one run are not independent (one outage fails many at once), so the
  interval is narrower than it should be for runs before v2 pacing.
- The fault rules read the runner's reason text. A reason that matches no rule lands in `unclassified`
  (can't tell), which is safe for sellers but hides nothing: the count is in the report.
- Every input is a copy in `data/` of a vet402 runner's result file, listed with its sha256 in
  `data/manifest.json`. The runners' wallets and full logs are not published.
- A seller that recognises vet402's payer addresses (they are public) could treat vet402 better than
  other buyers.
- Sellers with many endpoints get many tries and a tight bound, so they fill the top.
