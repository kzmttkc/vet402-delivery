# vet402-delivery

Before an AI agent pays for an API, vet402 has already bought it with its own money and shows what came back, with the payment on chain.

On Solana, Tempo and Base, from 2026-09-28 to 2026-09-29 (UTC): 443 purchases from 220 sellers. 391 payments settled; 334 came back with an answer. In 57 cases the payment settled and nothing usable came back.

- **See the results:** https://kzmttkc.github.io/vet402-delivery/ (Solana, Tempo and Base first; Algorand on its own page)
- **Check one record yourself, no account and no payment:** from a clone of this repository, `npx tsx scripts/verify-receipt.ts https://kzmttkc.github.io/vet402-delivery/records/obs_2026-09-28_000001.json`
- **Use it in an agent, between "search" and "pay":** `skills/vet402-check/`

Who it is for:
- People who build agents that pay: look a seller up before your agent pays it.
- Sellers: see whether a real outside payment to your API settled and what your API answered. It costs you nothing, and there is nothing to sign up for.

"Came back with an answer" means the payment settled and the seller answered 2xx with a non-empty body (for the Tempo census purchases, whose runner kept no body: 2xx; the Tempo re-purchases are tested for an empty body). On Solana, Tempo and Base the runner checked each payment on chain before calling it settled. vet402 did not check that the answer is what the listing promised; whether its keys matched what the seller declared is a separate column.

How vet402 pays for this: Grades come only from vet402's own purchases. vet402 also sells paid checks (paid in USDC on Algorand or Base); a paid check is a separate report and never moves a grade.

Where Solana comes in: vet402 pays Solana sellers in USDC on Solana, and writes the Merkle root of each day's signed delivery records into one Solana memo, so a record of that day cannot be added or dropped later without the root changing.

The numbers above are from the report of 2026-09-29 (`site/rank.json`). The site is rebuilt from `data/` on every push to main, so it shows the purchases whose results have been committed to `data/`, not ones still waiting to be copied there.

This repository is the multi-chain part of vet402. It buys the sellers it can on **Solana** (from the PayAI, CDP Bazaar and Pay.sh catalogs) and **Tempo** (from Tempo's Mercator directory), and on **Base** the sellers registered in ERC-8004 (8 purchases from 8 sellers on 2026-09-28, each bought once). It buys again about once a day from the Solana and Tempo sellers whose earlier payment settled, keeps every result with its payment, and grades sellers by what was actually delivered, not by how popular a listing is.

## What is here

| Part | What it does | Code |
|---|---|---|
| Solana census | Joins the PayAI, CDP Bazaar and Pay.sh catalogs and buys each seller once (one purchase per payTo), then records settled / delivered with the tx signature | `scripts/census.ts`, `src/census.ts` |
| Tempo census | Buys the MPP services listed in Tempo's Mercator directory on Tempo mainnet (USDC.e) and records the result | `scripts/tempo-census.ts`, `src/tempo/` |
| Base | Buys ERC-8004-registered sellers and writes the delivered result to the ERC-8004 ReputationRegistry with `proofOfPayment`, from the same address that paid | `scripts/base-buy.ts`, `scripts/base-feedback.ts`, `src/evm/` |
| Check skill | A check to run between "search" and "pay" in an agent's x402 flow | `skills/vet402-check/` |
| Delivery ranking | Grades sellers by independent purchases, per page: Solana, Tempo and Base together, Algorand on its own (method v3); failures caused by vet402 or the facilitator are not counted against the seller | `src/rank/` (method: `src/rank/README.md`) |
| Public site | Static pages (Solana, Tempo and Base results first, an Algorand page, one page per seller, the method) and `rank.json`, built from the inputs in `data/` and served by GitHub Pages | `scripts/build-site.ts`, `site/`, `data/` |
| First-buyer mode | Buys once, for life, from each Solana seller (payTo) that no one has paid yet, and publishes whether it settled and delivered, or why it cannot be paid | `scripts/first-buyer.ts`, `src/first-buyer/` |
| Delivery records | One signed record per purchase (x402-observation/v0): what vet402 paid, on which chain, and what came back, with a Merkle proof into a daily root that is written into a Solana memo | `src/receipt/`, `scripts/build-receipts.ts`, `scripts/publish-records.ts`, `scripts/anchor-receipts.ts`, `data/records/`, `site/records/` |
| Remeasure | Buys again, once a day, from Solana and Tempo sellers vet402 already paid (payment settled), so the ranking gets purchases on more than one day | `scripts/remeasure.ts`, `src/remeasure/` |
| Solana feedback | Writes the outcome of a paid Solana purchase to the 8004-solana reputation registry (the Solana port of ERC-8004), from the wallet that paid, with the published delivery record as the feedback file | `scripts/solana-feedback.ts`, `src/solana-feedback/` |

## Money safety

Every paying script signs exactly one transfer per purchase, to the payTo locked from the seller's own 402, within a per-purchase cap and a persistent total cap, and refuses anything else before signing. Keys live in `.keys/` (git-ignored) and never appear in logs or results. The Tempo, Base, delivery-record and first-buyer paths were reviewed independently (the fixes are in the commit log). The first Solana runs (gate 1 and the census) ran before an independent review; they stayed within the caps above.

## First-buyer mode (Solana)

Some x402 sellers are listed but have never been paid by anyone. vet402 buys from each of them once, with its own money, so the seller learns whether a real payment settles and what comes back. Every record says: "One test purchase by vet402. Not organic demand."

Rules:
- One purchase per payTo, for life, enforced twice:
  - in the ledger `results/first-buyer-ledger.json`: the attempt is written before anything is signed; an attempt that never finished counts as paid. A failure where no signed payment left vet402 may be tried again at +7 and +30 days, then never.
  - on chain, read right before each attempt whatever the ledger says: if the payTo's USDC account ever received USDC from anyone, vet402's own wallets included, nothing is signed. If that history cannot be read to the end, nothing is signed either.
- Who: a correct 402; price at or under 0.10 USDC; listed in PayAI, the CDP Bazaar or Pay.sh; new since `--since`; no USDC ever received (read on chain); the payTo's USDC account exists; not a tunnel host (trycloudflare and similar); a usable example input; not vet402's own host or payTo.
- Caps: 0.10 USDC per purchase, 5 USDC per run, 20 USDC per calendar month (UTC), on top of the existing payTo lock, transaction read-back and Budget.
  - The month cap also counts what the chain says left the payer wallet since the month's first run. The census pays from the same wallet, so its spending counts too; this errs on the safe side, and a census run can stop first-buyer purchases for the rest of that month.
  - That chain count is a balance difference: a deposit into the payer wallet during the month offsets spending in it. The month file's own total still applies.
- Opt-out: a payTo listed in `src/first-buyer/first-buyer-optout.json` is never bought. A request to be bought does not change who is chosen.
- No notification is sent to sellers by this code.
- "New since": until a run older than `--since` exists in `results/first-buyer-seen.json`, the only date is the catalogs' `lastUpdated`, which is a last-update time, not a first-listing time. Pay.sh listings carry no date and are skipped until then.

Published: the ledger (payTo, tx, time, settled, delivered, failure reason), `results/first-buyer/purchases.json`, and the buyer wallets in `results/first-buyer/wallets.json`, so analysts can subtract these payments.

Reciprocity: each ledger entry has `reciprocal.value`, false until checked. To check it, list USDC transfers into vet402's own Solana payTo addresses within 90 days after the purchase; if one comes from the seller's payTo (or a wallet the seller names as theirs), set it to true. Such a purchase is not counted as vet402 usage.

Files (under `results/`, not committed; keep them where `--pay` runs, and back them up):
- `first-buyer-ledger.json`: the lifetime ledger. `--pay` stops when it is missing; create it once with `--init-ledger` before the very first `--pay`, never to replace a lost one.
- `first-buyer-budget-YYYY-MM.json`: the month budget. `--pay` stops when the ledger shows more spent this month than this file.
- `first-buyer.lock`: exists while a `--pay` run is going. A second run stops. A run that was killed leaves it; the next run stops and says so. Check the ledger for pending attempts, then delete it.
- `first-buyer-seen.json`: hosts seen per run, for "new since".

```bash
npm run first-buyer -- --dry-run --since 2026-09-21   # catalogs, unpaid 402s, chain reads, transaction build; pays nothing
npm run first-buyer -- --init-ledger                  # once, before the very first --pay
```

## Delivery records

Each purchase can become a record signed by vet402's observation key (listed in `src/receipt/observers.ts`; it is not a payment key and holds no funds). A record holds the payment tx, the HTTP status that came back and salted hashes of the request. It never holds the response body. All records of one UTC day form one Merkle root, and that root is written once into a Solana memo.

What is published (`data/records/`, served at https://kzmttkc.github.io/vet402-delivery/records/):
- DELIVERED records are published.
- NOT_DELIVERED, MISMATCH and UNCLEAR records name a seller next to a failure. They are published only after vet402 has told that seller, and only for the sellers listed in `data/records/notified.json`. A seller is the ranking's seller: the host, or `host#service` when one host fronts several services that each pay their own recipient. An entry matches only that exact seller, so listing a bare host never publishes the failures of another service behind the same host. That list is empty for now, so none of them are published. The daily root still covers them, so no record can be added or dropped later without changing the root.
- `scripts/build-site.ts` stops if `data/records/` holds a record this policy does not allow, a record that does not verify, or a file that `data/records/index.json` does not list.

Check a published record, with no account and no payment:

```bash
npx tsx scripts/verify-receipt.ts https://kzmttkc.github.io/vet402-delivery/records/obs_2026-09-28_000001.json
```

It checks the signer against vet402's key, the signature, that the verdict follows from the recorded checks, the Merkle proof and the payment on chain. Change any signed field, even by one character, and it fails.

The anchor counts only when vet402's anchor wallet (`VET402_ANCHOR_SIGNERS` in `src/receipt/observers.ts`) paid for and signed the memo; a memo from any other wallet is ignored, whatever root it names. Until the day's root is on chain the result reads `RESULT: OK (not yet anchored)`, and the script says what that leaves unproven: the Merkle line then only shows that the proof and the root inside the record agree, not that the record belongs to the day vet402 committed to.

```bash
npm run records:publish -- --from results/receipts   # copy the publishable records into data/records/
npm run receipts:anchor -- --day 2026-09-28           # simulate the day's memo on mainnet; signs and sends nothing
```

Writing the root on chain needs `--send` and the Solana payer key. The records are read from `~/vet402-solana-receipt/results/receipts`; `--send` and `--resume` refuse any other folder unless `--other-receipts-dir` is added. The network fee is the only thing that leaves the wallet. One root per day, checked twice before signing:
- `results/receipts/<day>/anchor-sent.json` does not exist (it is written before the transaction leaves, with the signed bytes);
- the anchor wallet's history on chain, read back to the start of that day, holds no memo for that day.

If a send was interrupted (`anchor-sent.json` says `"sending"`):

```bash
npm run receipts:anchor -- --day 2026-09-28 --resume          # reads the chain; changes nothing on chain
npm run receipts:anchor -- --day 2026-09-28 --resume --send   # only if the line above says to
```

- Landed: the records are marked anchored, the file says `"sent"`, then run `records:publish` again.
- Still inside its blockhash window: wait and run `--resume` again, or `--resume --send` to rebroadcast the same signed bytes (same signature, so it cannot land twice).
- Failed on chain, or expired with no memo for the day on chain: the file is moved to `anchor-sent.failed-*` or `anchor-sent.expired-*`, and `--resume --send` (or `--send`) writes the root afresh.
- A memo for the day with a different root is on chain: nothing is changed. Stop and look before anything else.
- A matching memo is on chain but `anchor-sent.json` is missing: `--resume` records it.

## Remeasure (Solana, Tempo)

The ranking gives a rank number only after 10 counted purchases on 2 or more UTC days. Remeasure buys again from sellers vet402 already paid, once a day, so each seller's record grows day by day. It never buys from a new seller.

- Who: the settled purchases in `data/` (Solana census and gate1 results, the Tempo ledger). The payTo and price are locked to that earlier payment. A live 402 that names another payTo is not paid and is recorded as `pay_to_changed`; a higher price is not paid either.
- How many: one purchase per payTo per run (`--per-payto` up to 5), at least 60 s apart for the same payTo. A payTo with several resources gets them in a fixed order, cheapest first, so the same resource adds up.
- Caps: 0.10 per purchase; 3 USDC (Solana) or 1 USDC.e (Tempo) per run; 30 per month on each chain. The same payTo is bought at most once per slot per UTC day, however many runs that day (ledger key `<date>|<payTo>|<slot>` on both chains).
- Money moves only through the existing payment functions (`src/pay.ts`, `src/tempo/pay.ts`), which write the ledger before anything is signed.
- Tempo shares one key with the Tempo census. Every Tempo `--pay` run (census and remeasure) checks the same thing before signing: USDC.e out of the key since the census start block must not exceed its own ledger plus what the key's other ledgers record as paid (`src/tempo/key-ledgers.ts`). A deleted or lost ledger leaves its payments unaccounted, so nothing more is signed until someone looks. Every day ledger is also listed in `tempo-ledger-index.json` before its first purchase; a listed day ledger that is missing stops every Tempo run by name. The census `--pay` accepts only the key's census ledger (`~/vet402-solana-tempo/results/tempo-ledger.json`) and exits otherwise. The Tempo month cap also counts what left the key on chain since the month's first block, census purchases included.
- A purchase that is in a ledger but has no result row (the run was killed in between) is added by the next `--pay` run as `unknown_after_sign`. It is never bought again that day, and the rank does not count it against the seller.
- **Production runs in one place only: `~/vet402-solana/results/remeasure`.** Ledgers, locks and results always go there, whichever checkout runs the script, and `--pay` refuses `--out`. `npm run rank` reads the same folder.
- Results: `<chain>-YYYY-MM-DD.json`, read by `npm run rank` as purchases on that day. Ledgers: `budget-solana-YYYY-MM.json` and `tempo-ledger-YYYY-MM-DD.json`. Back them up; never delete them.

```bash
npm run remeasure -- --chain solana               # dry run (the default): targets and estimate; pays nothing
npm run remeasure -- --chain tempo --dry-run
```

## Solana feedback (8004-solana)

The 8004-solana registry (program `8oo4dC4JvBLwy5tGgiH3WwK4B9PWxL9Z4XjA2jzkQMbQ`) lets any wallet write feedback to a registered agent. vet402 writes only what it paid for and saw itself.

- Who: a seller whose agent's Core asset is owned by the payTo vet402 paid. When that payTo owns several agents, nothing is written until an operator names one (`--pin host=asset`); I do that only when the seller has said which agent sells the endpoint.
- What: one outcome that every settled purchase agrees on, over at least 2 UTC days. Paid and not delivered: value 0, no score, tags `x402-delivery` / `paid-not-delivered`. Delivered: value 1, no score, tags `x402-delivery` / `delivered`. Mixed results are not written.
- Proof: `feedback_uri` is the published delivery record of the purchase (`https://kzmttkc.github.io/vet402-delivery/records/<id>.json`, 76 bytes, limit 250) and `feedback_file_hash` is the sha256 of its bytes, the same sha256 as in `data/records/index.json`. A record that is not published cannot be used, so a NOT_DELIVERED result is written only after its seller is in `data/records/notified.json`.
- Before a write, all of these must hold, read at that moment: the purchase tx is finalized, signed by the writing wallet and moves the same USDC amount from it to the payTo; the record is public and its bytes match the hash; the Core asset owner is the payTo; this wallet has no feedback for the agent on chain (both address histories are read to the end) or in `results/solana-feedback-ledger.json`; a fresh simulation passes; the fee is at most 10,000 lamports.
- The transaction holds one `give_feedback` instruction and nothing else (checked after compiling). The ATOM engine accounts are left out, so the program records the feedback without the ATOM score update. At most 2 writes per run; each is in the ledger before it is sent.

```bash
npx tsx scripts/solana-feedback.ts                  # dry run (the default): targets, values, gates; reads only
npx tsx scripts/solana-feedback.ts --simulate       # also simulateTransaction on mainnet, unsigned
VET402_SOLANA_FEEDBACK_WRITE=yes npx tsx scripts/solana-feedback.ts --send
```

## Corrections

Published data is corrected only toward what the chain shows, and every correction is listed here. The previous values stay in git history.

- **2026-09-30**: `data/tempo/ledger.json` (the 2026-09-28 Tempo census): the entries `goflightlabs` (HTTP 502) and `modal` (HTTP 500) were recorded as settled null, with no tx. Both payments settled on chain, to the mpp.tempo.xyz recipient `0xca4e835f803cb0b7c428222b3a3b98518d4779fe`: goflightlabs 0.005 USDC.e in `0x34fbc6dc957f6edd19c4e8402323b0447f9b8ebc3322c27036b4a9b9dcf965ec` (2026-09-28 08:04:39 UTC), modal 0.0001 USDC.e in `0x3439e09ee264bbc67cb1ebf45e808f4f2756a8e90925d5fcae94085be8c8643c` (08:05:17 UTC). Why they were missed: the fee was sponsored, so the transaction on chain is not the one vet402 signed, and an error answer carries no Payment-Receipt, so the runner had no tx hash to read back. Found and written by `npx tsx scripts/chain-check.ts --census --write`, which checks every USDC.e transfer out of the payer during the run against the ledger (72 transactions, 70 already recorded) and writes a transfer onto an entry only when exactly one entry fits it. Both purchases now count as paid with nothing usable back (`paid_not_delivered`) instead of a 5xx without settlement. The 2026-09-28 signed records were anchored on Solana before this correction (tx `JqhzBqMSuL9ZrZz511fCgqcvU7Sjzhs7ccdbpqtdgUUUV7G1iBAuc4my5hReEkbyr6qk9vB3uMqB13cbpVzNeb2`) and do not include these two purchases; they stay as they are.
- **2026-09-30**: `data/remeasure/tempo-2026-09-29.json` rows[30] (kicksdb, HTTP 500) was recorded as settled null, with no tx. It settled on chain: 0.0005 USDC.e to the same recipient in `0xd25f701b7d771a4715f4e01540bd4669a1e9e6c6a20f7e2dfa8e1680542417f8` (2026-09-29 08:28:46 UTC), for the same reason. Written by `npx tsx scripts/chain-check.ts --chain tempo --date 2026-09-29 --write` (35 transactions in the run, 34 already on rows). The 2026-09-29 signed records are not published or anchored yet and will include it.

## Scope and prior work

I (Sen) started vet402 on 2026-07-13. Before this repository, vet402 already had:
- the main product at https://vet402.com (purchase lanes on Base, Solana, Tempo, Arc and XRPL);
- an Algorand version for Algorand's Global x402 Challenge: https://github.com/kzmttkc/vet402-algorand (its census data is read here as input to the ranking);
- entries at ETHGlobal ETHOnline 2026 and ETHGlobal Tokyo 2026 (their submitted code is not part of this repository).

The code in this repository was written from 2026-09-28 onward, with one exception: the delivery verdict rules in `src/verdict.ts` and the failure groups in `src/classify.ts` are ported from vet402-algorand (each file says so in its header), so that the chains are judged the same way. Those two files are prior work, not part of this entry. Data from earlier purchases is used as input and is labelled with its date.

## Run

```bash
npm ci
npm test
```

Paying runs need keys in `.keys/` and are gated by explicit flags (`--pay`, `--write`) and, for Base, an environment variable as well.

## License

MIT
