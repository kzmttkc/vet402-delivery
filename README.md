# vet402-delivery

Before an AI agent pays for an API, vet402 has already bought it with its own money and shows what came back, with the payment on chain.

On Solana, Tempo and Base since 2026-09-28 (UTC). The current counts (purchases, sellers, payments settled, answers that came back, and payments that settled with nothing usable back) are at the top of the site's first page and in `site/rank.json`: the `groups[]` entry with `id` `main`, its `totals` (the top-level `totals` include Algorand).

- **See the results:** https://kzmttkc.github.io/vet402-delivery/ (Solana, Tempo and Base first; Algorand on its own page)
- **Check one record yourself, no account and no payment:** from a clone of this repository, `npx tsx scripts/verify-receipt.ts https://kzmttkc.github.io/vet402-delivery/records/obs_2026-09-28_000001.json`
- **Look a seller up before paying, in one line (CLI, MCP server, x402 fetch hook):** see [Try it in 60 seconds](#try-it-in-60-seconds) and `packages/check/`
- **Use it in an agent, between "search" and "pay":** `skills/vet402-check/`

Who it is for:
- People who build agents that pay: look a seller up before your agent pays it.
- Sellers: see whether a real outside payment to your API settled and what your API answered. It costs you nothing, and there is nothing to sign up for.

"Came back with an answer" means the payment settled and the seller answered 2xx with a non-empty body (for the Tempo census purchases, whose runner kept no body: 2xx; the Tempo re-purchases are tested for an empty body). On Solana, Tempo and Base the runner checked each payment on chain before calling it settled. vet402 did not check that the answer is what the listing promised; whether its keys matched what the seller declared is a separate column.

How vet402 pays for this: Grades come only from vet402's own purchases. vet402 also sells paid checks (paid in USDC on Algorand or Base); a paid check is a separate report and never moves a grade.

Where Solana comes in: vet402 pays Solana sellers in USDC on Solana, and writes the Merkle root of each day's signed delivery records into one Solana memo, so a record of that day cannot be added or dropped later without the root changing.

This README carries no counts: the daily publish commits only `data/` and `site/`, so counts written here would fall behind. The site is rebuilt from `data/` on every push to main, so it shows the purchases whose results have been committed to `data/`, not ones still waiting to be copied there.

This repository is the multi-chain part of vet402. It buys the sellers it can on **Solana** (from the PayAI, CDP Bazaar and Pay.sh catalogs) and **Tempo** (from Tempo's Mercator directory), and on **Base** the sellers registered in ERC-8004 (8 purchases from 8 sellers on 2026-09-28, each bought once). Rebuy plan from UTC day 2026-09-29, with no end date: every day, twice on Solana and once on Tempo, one purchase per payTo per slot per UTC day among the Solana and Tempo sellers whose earlier payment settled (which ones: the rows in `data/remeasure/`), within a cap of 30 USDC per calendar month on Solana and 30 USDC.e on Tempo. It keeps every result with its payment, and grades sellers by what was actually delivered, not by how popular a listing is.

## Try it in 60 seconds

Node 22 or newer. Nothing to sign up for, no key, no payment: the check reads `rank.json`, the signed records and the records index, and nothing else.

```sh
npx -y @vet402/check https://api.xona-agent.com/token/pumpfun-trending
```

It prints what vet402's record holds about that seller: purchases tried, settled and answered, the failures counted against the seller and the ones that are not, the grade (`measuring` while there are too few purchases), the newest purchase with its tx, and the signed records. For a seller vet402 never bought from, it prints "vet402 has no record of this seller". The first run installs from GitHub (about 30 seconds on an empty npm cache).

Add `--verify` to re-check the newest signed record (signature, Merkle proof, payment on chain, root in vet402's Solana memo). As an MCP server (tools `check_before_paying` and `verify_record`):

```sh
claude mcp add vet402-check -- npx -y @vet402/check --mcp
```

The x402 fetch hook, the output fields and the options: `packages/check/README.md`.

## What is here

| Part | What it does | Code |
|---|---|---|
| Solana census | Joins the PayAI, CDP Bazaar and Pay.sh catalogs and buys each seller once (one purchase per payTo), then records settled / delivered with the tx signature | `scripts/census.ts`, `src/census.ts` |
| Tempo census | Buys the MPP services listed in Tempo's Mercator directory on Tempo mainnet (USDC.e) and records the result | `scripts/tempo-census.ts`, `src/tempo/` |
| Base | Buys ERC-8004-registered sellers and writes the delivered result to the ERC-8004 ReputationRegistry with `proofOfPayment`, from the same address that paid | `scripts/base-buy.ts`, `scripts/base-feedback.ts`, `src/evm/` |
| Check before paying | Read-only lookup of one seller in `rank.json` and the signed records, with optional verification of a record down to the Solana memo anchor: a CLI (`npx`), an MCP server and a hook for the fetch an x402 client pays through | `packages/check/` |
| Check skill | A check to run between "search" and "pay" in an agent's x402 flow | `skills/vet402-check/` |
| Delivery ranking | Grades sellers by independent purchases, per page: Solana, Tempo and Base together, Algorand on its own (method v3); failures caused by vet402 or the facilitator are not counted against the seller | `src/rank/` (method: `src/rank/README.md`) |
| Public site | Static pages (Solana, Tempo and Base results first, an Algorand page, one page per seller, the method) and `rank.json`, built from the inputs in `data/` and served by GitHub Pages | `scripts/build-site.ts`, `site/`, `data/` |
| First-buyer mode | Buys once, for life, from each Solana seller (payTo) that no one has paid yet, and publishes whether it settled and delivered, or why it cannot be paid | `scripts/first-buyer.ts`, `src/first-buyer/` |
| Delivery records | One signed record per purchase (x402-observation/v0): what vet402 paid, on which chain, and what came back, with a Merkle proof into a daily root that is written into a Solana memo | `src/receipt/`, `scripts/build-receipts.ts`, `scripts/publish-records.ts`, `scripts/anchor-receipts.ts`, `data/records/`, `site/records/` |
| Remeasure | Buys again from sellers vet402 already paid (payment settled), one purchase per payTo per slot per UTC day, so the ranking gets purchases on more than one day. From UTC day 2026-09-29, with no end date: every day, twice on Solana and once on Tempo, within the month caps | `scripts/remeasure.ts`, `src/remeasure/` |
| Solana feedback | Writes the outcome of a paid Solana purchase to the 8004-solana reputation registry (the Solana port of ERC-8004), from the wallet that paid, with the published delivery record as the feedback file | `scripts/solana-feedback.ts`, `src/solana-feedback/` |
| Robinhood Chain | Buys, in USDG, every seller whose live 402 lists Robinhood Chain (one purchase per payTo), and checks stock prices sold over x402 against the Chainlink feed of the Stock Token: age against the heartbeat, `oraclePaused()`, and the ERC-8056 multiplier between share price and token price | `scripts/evm-lane.ts`, `src/robinhood/`, `src/evm/`, `site/robinhood.html` |
| Arbitrum One | Buys each seller that lists Arbitrum One with the same payTo as its Base accept, once on Arbitrum and once on Base, and shows per seller whether each chain settled and came back, and why not | `scripts/evm-lane.ts`, `src/evm/`, `site/arbitrum.html` |
| Daily root on EVM chains | After each UTC day with purchases on the Robinhood Chain or Arbitrum lane, that day's Merkle root goes into `contracts/DeliveryRoots.sol` on that chain: written once per day, never changed, only by its own key (not the payer wallet). Each leaf is a public record of one purchase (no seller answer, only its sha256), published in `data/evm/roots/<lane>.json` with its proof, so anyone, or another contract, can call `verify(day, digest, proof)`. Once deployed, the contract is at `0x84DB4733f8F9e6803Af811fD9E438aEBc0b90145` on both chains (the key's first transaction); the days written so far are the ones in `data/evm/roots/` | `scripts/evm-roots-deploy.ts`, `scripts/evm-anchor.ts`, `scripts/evm-roots-publish.ts`, `src/evm/roots.ts`, `contracts/` |
| Proxy buy | An agent pays vet402 the seller's price + 0.005 (x402 on Solana, MPP on Tempo); after that payment settles, vet402 pays a seller it already paid before and returns the answer with both transactions and a record, or refunds the agent when it did not pay the seller. State in Postgres; runs on Vercel Functions. Running since 2026-10-01 at https://vet402-delivery.vercel.app/v1/buy, Solana only | `src/proxy-buy/`, `api/`, `scripts/proxy-buy-serve.ts` |

## Money safety

Every paying script signs exactly one transfer per purchase, to the payTo locked from the seller's own 402, within a per-purchase cap and a persistent total cap, and refuses anything else before signing. Keys live in `.keys/` (git-ignored) and never appear in logs or results. The Tempo, Base, delivery-record and first-buyer paths were reviewed independently (the fixes are in the commit log). The first Solana runs (gate 1 and the census) ran before an independent review; they stayed within the caps above. Proxy buy (below) reads its keys from environment variables instead, uses wallets of its own, and went through several rounds of independent review before it was switched on (each round's fixes are in the commit log).

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
- NOT_DELIVERED, MISMATCH and UNCLEAR records name a seller next to a failure. They are published only after vet402 has told that seller, and only for the sellers listed in `data/records/notified.json`. A seller is the ranking's seller: the host, or `host#service` when one host fronts several services that each pay their own recipient. An entry matches only that exact seller, so listing a bare host never publishes the failures of another service behind the same host. On 2026-09-30 it listed one seller, `api.xona-agent.com`, told in issue xona-labs/creative-ai-agent#1, and that seller's 3 NOT_DELIVERED records of 2026-09-28 and 2026-09-29 were published the same day. On 2026-10-01 `api.syraa.fun` was told by email (to the developer contact in its docs), and its 5 NOT_DELIVERED records of 2026-09-28 to 2026-09-30 were published the same day. The counts per day are in `data/records/index.json`. The daily root still covers them, so no record can be added or dropped later without changing the root.
- `scripts/build-site.ts` stops if `data/records/` holds a record this policy does not allow, a record that does not verify, or a file that `data/records/index.json` does not list.

Check a published record, with no account and no payment:

```bash
npx tsx scripts/verify-receipt.ts https://kzmttkc.github.io/vet402-delivery/records/obs_2026-09-28_000001.json
```

It checks the signer against vet402's key, the signature, that the verdict follows from the recorded checks, the Merkle proof and the payment on chain. Change any signed field, even by one character, and it fails.

When the records index (`--index`, else `data/records/index.json` next to a local record, else the published one) names the day's account in the observation-roots program (`days[].programRoot`), it also asks the program itself: a simulated `verify` of the record on Solana mainnet (`simulateTransaction` with signature checks off and the blockhash replaced; nothing is signed or sent). The line `program  verify: DELIVERED (2026-09-30, sequence 599); digest 0x… is the record's` appears only when the simulation succeeds and the program's return data names the record's day, verdict, sequence and digest. A changed record makes the program refuse it, and the run fails.

The anchor counts only when vet402's anchor wallet (`VET402_ANCHOR_SIGNERS` in `src/receipt/observers.ts`) paid for and signed the memo; a memo from any other wallet is ignored, whatever root it names. Until the day's root is on chain the result reads `RESULT: OK (not yet anchored)`, and the script says what that leaves unproven: the Merkle line then only shows that the proof and the root inside the record agree, not that the record belongs to the day vet402 committed to.

```bash
npm run records:publish -- --from results/receipts   # copy the publishable records into data/records/
npm run receipts:anchor -- --day 2026-09-28           # simulate the day's memo on mainnet; signs and sends nothing
```

Daily records: from 2026-09-29 on, each day's remeasure purchases (Solana and Tempo) become that day's records and root.

```bash
npm run receipts:build -- --key .keys/attest.json --out ~/vet402-solana-receipt/results/receipts --day 2026-09-29 --simulate-anchor
npm run records:publish -- --from ~/vet402-solana-receipt/results/receipts --day 2026-09-29
```

- A purchase becomes a record only when its transfer was read back on chain and the spend ledger, written before signing, agrees on the amount (on Tempo also on the recipient and the tx). What the seller sent back is never read into a record.
- Sequence numbers continue from the last record. A day already built is never signed again, a day earlier than a built one is refused, and so is the current UTC day unless `--allow-open-day` is given.
- A day built with `--allow-open-day` is for a local look only: `records:publish` and `receipts:anchor` refuse it. Both also hash again each input the day was signed from (listed in its local `sources.json`) and stop if one changed, for example when a second run the same day added purchases. The day is then built again from the current files.
- `records:publish --day` adds that day only; the days already in `data/records/` stay byte for byte.

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

The ranking gives a rank number only after 10 counted purchases on 2 or more UTC days. Remeasure buys again only from sellers vet402 already paid, so each seller's record grows day by day. It never buys from a new seller.

Rebuy plan from UTC day 2026-09-29, with no end date: every day, twice on Solana and once on Tempo. Spending is capped per calendar month (30 USDC on Solana, 30 USDC.e on Tempo, `src/remeasure/constants.ts`); a chain that reaches its cap buys nothing more until the next month. The ledger allows one purchase per recipient per slot per UTC day, so where several sellers share one payTo (on Tempo many services do), one of them is bought. Which sellers were bought again is decided by the rows in data/remeasure/, and a correction can change them; a seller page says what those rows hold for that seller (UTC days and purchases per chain), counting only rows whose payment settled on chain (settled true, with a tx); a seller with no such row (refused, not settled, or an outcome not on record) gets no such line. The runs of 2026-09-29 were started by hand; from 2026-09-30 the daily runner below starts them. The days it ran are the files in data/remeasure/.

- Who: the settled purchases in `data/` (Solana census and gate1 results, the Tempo ledger). The payTo is locked to that earlier payment and the price can be no higher. A live 402 that names another payTo is not paid and is recorded as `pay_to_changed`; a higher price is not paid either.
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

## Proxy buy (Solana, Tempo)

An agent asks vet402 to buy a seller's answer for it. vet402 pays the seller from its own wallet only after the agent's payment has settled, and returns the seller's answer together with both transactions and a public record of the purchase.

Status on 2026-10-01: it runs at https://vet402-delivery.vercel.app/v1/buy, for Solana only (Tempo is switched off on that deployment, so no Tempo price is offered and a Tempo payment is refused). It went through several rounds of independent review before it was switched on; each round's fixes are in the commit log. The first purchase through it settled on 2026-10-01 at 04:50 UTC. Purchases per UTC day stay within the cap the deployment is configured with.

Use:

```bash
curl -i 'https://vet402-delivery.vercel.app/v1/buy?url=<seller endpoint>'   # free: shows the price, charges nothing
```

The answer is a 402 with the price on every chain vet402 can pay that seller on:
- Solana: an x402 `PAYMENT-REQUIRED` header (scheme `exact`, USDC). Pay it with any x402 v2 client and send the same GET with `PAYMENT-SIGNATURE`.
- Tempo: an MPP `WWW-Authenticate: Payment` challenge (`tempo/charge`, USDC.e on chain 4217). Send the same GET with `Authorization: Payment ...` carrying a signed transaction for vet402 to broadcast (pull mode). A transaction already broadcast (push mode) is refused.

vet402 pays the seller on the chain the agent paid on.

Price: the seller's price plus 0.005 (USDC on Solana, USDC.e on Tempo). The 402 body shows the seller's price, the fee, the total, the seller's payTo, the refund rule below, the rule for large answers (an answer above 1,000,000 bytes is not forwarded, and since the seller was paid there is no refund), and how many earlier vet402 purchases from that seller settled and delivered. On Tempo the agent pays its own network fee.

Refunds:
- If the agent's payment settles and vet402 then does not pay the seller, vet402 refunds the full payment (seller price + fee) to the owner of the account whose balance paid (not a delegate that only signed), on the same chain in the same token. The owner may be a program-derived address (a multisig vault, for example); the refund goes to its associated USDC account. On Solana, when that account does not exist, the refund creates it (the payer funds the rent, about 0.002 SOL), at most 10 such creations per UTC day; past that nothing is sent and the refund is tried again on the next UTC day (a wait, not counted as a failed attempt). "Does not pay" is decided on proof only: vet402 stopped before sending (the seller's price or payTo moved at the last read, the seller stopped answering, a chain read failed, the payment could not be built or failed its read-back), or vet402's payment to the seller is dead on chain (Solana: the finalized block height is well past its recorded last valid block height and a later look still does not find it; Tempo: past its `validBefore` with no receipt for its own hash, or, for a payment the seller sponsors, no transfer carrying its challenge-bound memo). The refund transaction is in the answer (`x-vet402-refund-tx`) and in the record.
- If vet402 paid the seller (its payment to the seller settled) and the seller did not deliver, there is no refund. The purchase is recorded against the seller, with vet402's payment to it. One exception, switched on on the live deployment on 2026-10-02 at 12:58 UTC (the free 402's `buy.refund` says which rule applies): the refund for an undelivered answer (Solana), when switched on, refunds the full payment for a seller-side failure (402 again, 5xx, a 1xx or 3xx status, a 2xx with an empty body, or a connection the seller refused or closed), at most once per paying address per UTC day and only while a cap per UTC day and per UTC month, shared by all agents, has room; a refund refused by these limits is not tried again. Whether the seller was paid is read from vet402's own signed payment on chain (Solana: by its message; Tempo: by its hash, or its memo when sponsored), never from the transaction the seller names in its answer, and one on-chain transaction counts for one purchase only (a database key).
- If it cannot be told yet whether vet402's payment to the seller will land, the answer is `seller_payment_pending` and the reconciler (below) refunds once that payment is proven dead. If it lands, the reconciler closes the purchase with no refund, or, with the refund for an undelivered answer on, decides that refund as described below.
- A refund goes through its own checks: one refund per purchase (a database key), at most one purchase's total (0.105) each, and the refund transaction is read back before it is sent. These refunds (for a seller vet402 did not pay) are not capped per day: each is at most one purchase's total, and the number of purchases per day is capped. The refund for an undelivered answer is capped (below). What the refund cap limits is the refund room: each admitted purchase holds its total until it closes, and a new purchase is refused before any charge when the room held for the day's open purchases would pass the cap. So a refund owed after the agent paid is never refused for lack of room. Its signature and slot (Solana) or hash and `validBefore` (Tempo) are written to the database before it is sent; another attempt is made only after the previous one is proven dead on chain, at most three sent attempts, and at most six attempts that fail before sending (a read error). A refund that cannot be made (after those attempts, or at once when no transfer can reach the address) is "stuck": it stays open and owed, and the reconciler reports it (`ALERT`) for a human; it is never closed as done.
- If the agent's payment settles through someone other than vet402 (the agent sends the same signed payment to the facilitator first), vet402 finds it on chain by its message, never pays the seller for it, and refunds it like any purchase whose seller vet402 did not pay.
- The refund for an undelivered answer (Solana; off unless `VET402_PROXY_SOLANA_NOT_DELIVERED_REFUND_DAILY_CAP` and `VET402_PROXY_SOLANA_NOT_DELIVERED_REFUND_MONTHLY_CAP` are both set; one without the other stops the service from starting). When vet402's own payment to the seller is found landed on chain (by its message, as above) and the seller then answered 402 again, 5xx, a 1xx or 3xx status, a 2xx with an empty body, or refused or closed the connection with no answer (`ECONNREFUSED`, `ECONNRESET`, `EPIPE`, a socket closed by the other side; not a client vet402 itself closed), the agent's full payment (seller price + fee) is refunded from the payer wallet, to the same address and in the same way as above, unless one of the checks below refuses it. These are the ranking's seller-side failures (`settled_not_delivered` and `paid_not_delivered` in `src/rank/classify.ts`, the NOT_DELIVERED line of the delivery records), less what cannot be told apart from a slow seller or vet402's own side. Not refunded: any other 4xx (vet402 or the agent built the request), no answer within the wait (a timeout of any kind), any other connection error (a name that did not resolve, for example), a 2xx whose body could not be read, an answer above 1,000,000 bytes, and a payment to the seller not found on chain yet (the reconciler decides that one the same way once it is found landed; proven dead, it is the refund above). The decision is made once per purchase, in one database transaction under one lock (`pb_nd_refund`, one row per purchase), so two requests or a request and the reconciler never both decide it:
  - Caps: the most refunded this way per UTC day and per UTC month across all agents, from the two variables, at most 2.00 and 20.00 (USDC; a higher value stops the service from starting). A refund that would pass either is not made, and the answer and the record say so: `refund.status` is `refused` and `refund.reason` starts with `cap_daily` or `cap_monthly`, with the amounts. A refusal by a cap or by a check below is final for that purchase: it is not tried again on a later day.
  - One per paying address per UTC day: a second refund of this kind to the same refund address, or for the same signing authority, on the same UTC day is not made (`buyer_daily_limit`).
  - Never to the seller: when the seller's payTo is the refund address or the signing authority, nothing is refunded (`payto_is_buyer`).
  - A seller held: after one refund of this kind, that seller (the same host or the same payTo) is not bought from again (403 `seller_on_hold`, nothing charged) and gets no second refund of this kind (`seller_on_hold`) until a vet402 purchase from it that delivered is in `data/` with a later time than the refund (the next daily run that delivers, once it is deployed), or until 7 days after the refund, whichever comes first, so a seller the daily runs do not buy again is not held for good.
  - The free 402 says `seller_on_hold` for the Solana offer, before the agent signs, when the instance answering it knows of the hold. It reads the holds after each paid request and, for a quote, only in the minutes after a cron run, when the database is awake anyway, so a quote never wakes the database. A hold the quote did not show is still refused by the paid request, before any charge.
  - If the decision cannot be written (a database error), the answer and whose failure it is are kept with the purchase first, and the purchase waits for the reconciler (`seller_unsettled`), which makes the decision the same way at its next run. The answer is then the 502 `not_delivered` with `refund` `pending_reconcile` (`unknown` when nothing could be written).
  - A granted refund is sent like the refunds above: its refund row is taken in the same transaction as the decision, a send that fails or is not confirmed leaves the purchase open (`refund_pending`, outcome `not_delivered`) for the reconciler, which tries again and reports (`ALERT`) until it is sent or a person settles it, and a purchase is refunded at most once (a database key).
  - The answer is the 502 `not_delivered` with `refund`: its `status`, `amountAtomic`, `to`, `tx`, `basis` (what it is for, such as `not_delivered: http_500`) and, when it was not sent, `reason`; `x-vet402-refund-tx` when sent. The record says the same.
  - With it on, each Solana purchase holds the seller's price on top of its total in the payer wallet until it closes (it may pay the seller and then refund the total), and the free 402 shows this rule in place of the one above.
- If vet402 paid the seller and the answer did not reach the agent (the seller answered but the function stopped before handing the answer on, or the connection dropped), there is no refund: the seller was paid for an answer vet402 does not keep. The record shows vet402's payment to the seller, the seller's HTTP status and the sha256 and size of the answer when it was read.
- "Proven" means the whole window was read. On Solana:
  - Before a transaction is handed over (the agent's payment before it is settled, vet402's payment to a seller before it is sent), vet402's RPC node must know its blockhash (`isBlockhashValid`, processed); otherwise the agent's payment is refused before any charge (`blockhash_not_known`, sign again) and a seller payment is not handed over (the agent is refunded). Its last valid block height is then recorded as the newest blockhash's, read from a state at least as recent as the one that knew it (`getLatestBlockhash` with `minContextSlot`): never below the real one by more than the block a transaction can still be included in. A refund records its own blockhash's.
  - The newest signature on the account the transaction is searched on is also recorded before the hand-over (the anchor).
  - Expired means the finalized block height is more than 300 blocks (about two minutes) past the recorded height (`getEpochInfo`, finalized: height and slot of one bank). `isBlockhashValid` is not used for this: it also answers false for a blockhash the node does not know yet.
  - A payment signed with a durable nonce (a System AdvanceNonceAccount instruction) has no expiry at all: the agent's is refused before any charge, and vet402 never sends one (its seller payments are checked, its refunds allow no System instruction).
  - A refund (vet402 pays its fee, so its signature is known) is first looked up by that signature over the whole history (`getSignatureStatuses` with `searchTransactionHistory`): found decides; not found proves nothing (a node answers null when its long-term storage fails), so the search below decides. Any other transaction is searched by its message hash among the signatures of the account. Transactions of every version are read (`maxSupportedTransactionVersion` 1) and compared by the hash of their raw message bytes (legacy and v0: the bytes after the signatures; v1: the message comes first, its second byte is the number of signatures, and the signatures follow it); one that cannot be read is never taken for someone else's: the answer stays "cannot tell yet" and the reason is reported.
  - Before expiry, the search reads confirmed signatures at least as recent as the slot read first (`minContextSlot`). After expiry, the window ends at the finalized slot of the first answer past the margin; the transaction, if it ever landed, is in a block below it. The search reads finalized signatures down from that slot; those above it are skipped unread, and how far the walk above it got is kept, so the next look starts there however much traffic came after. The walk ends at the anchor (or, with no anchor on record, at the slot read before the hand-over). For the agent's payment it always reaches the anchor, then goes on past it, reading it too, down to ten minutes before vet402 took the payment (on a quiet account, where the anchor is older than that, the walk ends at the anchor): the agent may have sent the same signed payment to the facilitator itself before vet402 read the anchor, and a transaction with a blockhash vet402's node knew then cannot be older than that.
  - "Dead" is only said by a look after the one that recorded that slot, when the walk reached the anchor with every listed transaction read, and when the node's history reaches the slot read before the hand-over (`getFirstAvailableBlock`); otherwise the answer stays "cannot tell yet" and is reported. Reaching the anchor shows that the listing reached back to before the hand-over; it cannot show that nothing between the anchor and the window's end was left out by the node that listed it. To keep that small, every page of one walk asks for the same `minContextSlot`, the anchor is read with `minContextSlot` at the slot read just before it, and all reads go to the one endpoint in `SOLANA_RPC_URL` (use a provider that serves full history from one consistent source).
  - One look reads at most 200 transactions and stops at the request's deadline; one reconcile run reads at most 1,000 in all.
  - A transaction the RPC lists but does not serve, one it cannot read, an RPC error (a 429 is `rpc_rate_limited`), no recorded last valid height or anchor, a history that does not reach back far enough, or a look cut short leaves the answer at "cannot tell yet", never "dead", with the reason. The reconciler reports it (`ALERT`) and looks at that purchase again after 15 minutes, at its next run after that (the cron every 30 minutes, or a reconcile turn a paid request starts).

Who vet402 buys from: only a seller host and payTo pair that vet402 already paid with a settled payment and that delivered at least once, read from `data/` (`npm run proxy-buy -- --check` prints how many pairs there are). Any other host is refused without being contacted; a seller whose payTo moved, or whose every settled purchase came back empty, is refused. So is a seller whose 402 names the blockhash to sign with (`extra.recentBlockhash` or `recentSlot`): the x402 SVM client would sign vet402's payment with it, and the seller would choose when that payment expires. The same check runs again just before vet402 signs its payment to the seller; a seller that starts naming one after the agent paid gets nothing signed, and the agent is refunded.

What comes back after a paid request:
- 200: the seller's answer byte for byte (content type kept), with `x-vet402-customer-tx`, `x-vet402-seller-status`, `x-vet402-record` and `x-vet402-seller-settled` (`true`, `false` or `unknown`: whether vet402's own payment to the seller was found on chain when the answer was handed over). `x-vet402-seller-tx` is present only when it was found; the transaction a seller names in its own answer is never used. A purchase closed with `unknown` is settled later by the reconciler.
- 502 with JSON when the agent's payment settled but no answer is handed over: `seller_not_paid` (with the refund), `not_delivered` (vet402's payment to the seller settled; no refund, unless the refund for an undelivered answer is on and applies, and then the `refund` field has it) or `answer_too_large` (vet402's payment to the seller settled; no refund), `seller_payment_pending` or `customer_payment_unconfirmed` (not known yet; the reconciler decides, and the `refund` field says `pending_reconcile`). Reasons are fixed codes; error messages from RPCs, facilitators and the database are never shown.
- 409: the same signed payment (in any encoding) was already used, or the on-chain payment already paid for another purchase.
- `GET /v1/buy/records/<id>` returns the record: the seller endpoint without its query string, seller payTo and price, fee, total, both transactions, the seller's HTTP status, the sha256 and size of the answer, the outcome and the refund. The record exists from the moment the agent's payment is confirmed (outcome `in_progress`).

Order of a paid request, and where it stops. Every stop before the agent's payment settles charges nothing (`"charged": false`):
1. Once the seller is priced and the payment header can be read, purchases of the same chain that stopped half way earlier (a function killed at its time limit, an outcome not known) get a short reconcile turn, at most one every 30 seconds per chain across all instances (a Solana request never waits on Tempo's chain reads; the other chain's purchases are the cron's). A purchase that is still open (money may have moved, outcome not settled) and has not changed for 330 seconds (longer than a function runs) holds up new paid requests signed by the same account (Solana: the transfer's authority; Tempo: the sender) or to the same seller host: 503 `reconcile_pending`, nothing charged. Everyone else is served.
2. Tempo only: the signed transaction must carry a `validBefore` at most 600 seconds ahead (mppx signs 25 seconds ahead), so that one never mined can be shown dead; otherwise 400 `valid_before_required`.
3. Read the seller's 402 again and price it again. The agent's payment must be for exactly that price and that seller: x402 v2 matches the signed `accepted` field (the target, the seller's price and payTo are in `extra`); MPP matches the challenge's HMAC, amount and `externalId` (a hash of the target).
4. Take the payment key in the database: a hash of the signed transaction itself (on Solana its message, on Tempo its signature), so the same transaction in another encoding is the same payment.
5. Reserve in the database, in one transaction: the day's cap and count, the day's refund room, and the payer wallet. The wallet check refuses when the payer's balance is below what proxy buy's own spending explains (money left it some other way) or would not cover this purchase's worst case (a refund of the total, and its fee). A balance above that (a top-up) raises the bar only while no purchase is in flight, and never past what the balance read may not show yet: the spending of purchases closed in the last 180 seconds, and of delivered purchases whose payment to the seller has not been seen on chain (the reconciler clears those once it is seen landed or dead). On Solana the payer's SOL must also cover a refund's fee and account rent (0.0021 SOL) for every open purchase plus this one.
6. Settle the agent's payment (Solana: through the facilitator; Tempo: vet402 broadcasts and waits for the receipt). A facilitator failure counts as "not charged" only when the facilitator names a verification failure with no transaction and the chain then shows the agent's transaction dead; anything else goes to the reconciler. The agent is charged when the settled transaction is the one the agent signed (Solana: the same message hash; a different transaction named by the facilitator is not taken), it succeeded, and the receive wallet went up by exactly the total; the refund address is the owner of the account that went down by it.
7. Record the agent's on-chain payment as used (one purchase per settled payment) and the purchase as in progress, before anyone is paid.
8. Pay the seller through the same payment code as the census (`src/pay.ts`, `src/tempo/pay.ts`): the seller's 402 is read once more and a raised price or a changed payTo is refused before signing; the signed transaction is read back and written to the database before it is sent.

State and hosting: all state is in Postgres (tables `pb_purchase`, `pb_customer_tx`, `pb_chain_tx`, `pb_day`, `pb_wallet`, `pb_refund`, `pb_nd_refund`, `pb_counter`, `pb_alert`, `pb_state`, created on first use). The per-client request limit (30 a minute) for requests that carry a payment is counted there too, under a hash of the client address; for free quotes it is counted in each function instance's memory (at most 50,000 clients a minute per instance; past that a new client's quote is refused), so a quote never writes to the database. Everything that must not happen twice is a unique key or a conditional update in the database, so any number of serverless instances (Vercel Functions, `api/buy.ts`) can serve at once. Tables are created once, under a Postgres advisory lock, by whichever instance starts first. `api/reconcile.ts` runs the reconciler from Vercel Cron every 30 minutes (at :00 and :30), least recently looked-at purchase first, so purchases that cannot be decided yet never hide one that can (it logs `ALERT` lines for a human, including every purchase still open two hours after it started). Each cron run also reads the payer wallets and reports, as `ALERT`, anything that refuses every new purchase: a balance below the floor the books explain (`chain_spend_exceeds_ledger`, with both numbers), a floor below one purchase's worst case (`insufficient_balance`), or too little SOL for the refund fees and account rent of the open purchases and one more (`refund_fee_unavailable`, with what is held and what is needed); `npm run proxy-buy:reconcile` runs it by hand (`-- --list` only lists).

Before deploying (none of this is done yet):
- `SOLANA_RPC_URL` must be a paid RPC endpoint whose history reaches back at least as far as the oldest purchase still open (days, not hours): refunds depend on `getSignatureStatuses` with `searchTransactionHistory`, `getSignaturesForAddress` at finalized commitment, `getFirstAvailableBlock` and `getTransaction` for version 1 transactions. The public endpoint (`api.mainnet-beta.solana.com`) is rate-limited and not meant for production traffic: under its limits reads answer 429, the answers stay "cannot tell yet" (`rpc_rate_limited`) and the reconciler reports them. With too little history nothing is called dead either, and that is reported too.
- Vercel Pro: the reconciler cron runs every 30 minutes (`*/30` in `vercel.json`), and Hobby runs a cron at most daily; Hobby is also for non-commercial use only.
- A Postgres database (`DATABASE_URL`), for example Neon through the Vercel Marketplace.
- Neon's free plan: 100 CU-hours a month, and the database stops after 5 minutes without a query. The cron runs every 30 minutes, not every 5 (at every 5 minutes the database never stopped and used the month's hours in about 17 days, stopping proxy buy until the next month), and the operator's `proxy-alerts` read comes 2 minutes after each run, so both share one wake-up of about 7 minutes per half hour: about 170 hours awake a month, about 42 CU-hours at the smallest size (0.25 CU). A free quote (`GET /v1/buy` with no payment) does not wake the database: its rate limit is kept in memory, and with the refund for an undelivered answer on it reads the held sellers only in the minutes after a cron run, when the database is awake anyway. Usage counting (`pc_usage`, for `/v1/check` and free quotes) keeps its counts in memory and writes them only while the database is awake anyway (up to 6 minutes after a cron run; never because of its own earlier write, which would keep the database awake by itself), one write at a time, so it never wakes it; counts of an instance that stops before then are lost, so the table can only undercount. What still wakes the database between cron runs: a paid request, a record read (`/v1/buy/records/<id>`), and the first request of a new function instance (it checks the tables once). Each such wake-up costs about 5 minutes, about 0.02 CU-hours. These are estimates at 0.25 CU. Neon's own count (compute time per project, from the Neon API with a key the operator issues) would also see the short wake-ups; it is not read yet.

Wallets and caps:
- Two wallets per chain: a receive wallet (its key is not on the server) and a payer wallet that only pays sellers and refunds. Neither may be a census or remeasure wallet. On Solana the payer also holds SOL for refunds (a fee, and the rent of a USDC account a refund may have to create: 0.0021 SOL for each open purchase); a seller payment's fee is paid by the seller's facilitator. On Tempo the payer holds USDC.e only: it pays its own network fees in USDC.e (unless the seller sponsors them). A Tempo refund may pay at most 0.01 in fees, bounded at the base-fee cap: Tempo charges about 250k more gas for an account's first transaction and about 250k more for a transfer to an address holding no USDC.e (read on mainnet 2026-10-01), and a refund can be both. So every Tempo purchase holds its total plus 0.01 in the payer wallet until it closes, and the payer needs at least 0.115 to take one purchase of 0.10. Every network fee a Tempo purchase causes leaves that same wallet and is counted in what the purchase spent, so the floor follows the balance: its refund's fee (read back from the chain; the 0.01 bound when it cannot be read), and the fee of a seller payment or refund attempt that was mined reverted (it moves nothing and still pays its fee; a seller-sponsored payment's fee is the seller's). A seller payment's fee is counted at its real amount too (until it is seen on chain, the 0.002 fee reserve stands in for it, and what it really took beyond that comes off the floor once it is seen). The reconciler says `ALERT tempo_base_fee_high` when Tempo's base fee passes 3 gwei (0.6 gwei on 2026-10-01): refunds are signed and bounded at a 12 gwei cap, and the 0.002 seller-payment reserve covers a payer's first transaction up to about 7 gwei. A Tempo payment from one of vet402's own wallets (the receive wallet, the proxy payer, the census payer) is refused before any charge (`payer_is_vet402`).
- 0.10 per purchase (seller price), 100 purchases per UTC day, a daily cap (default 2.00, at most 5.00) and a refund room cap (default: the daily cap) per chain.
- The refund for an undelivered answer (Solana): its own caps per UTC day and per UTC month (at most 2.00 and 20.00), off unless both are set. With it on, the floor needed for one purchase is its total plus the seller's price (0.205 at most), and the reconciler's `insufficient_balance` says that figure.
- Nothing is quoted, settled, paid or refunded unless `VET402_PROXY_BUY_ENABLED=1`. Tempo is off unless `VET402_PROXY_TEMPO_ENABLED=1` as well: without it no Tempo price is offered and a Tempo payment gets 503 `tempo_disabled` (Solana first).

Run locally:

```bash
npm run proxy-buy -- --check   # prints the configuration (addresses and caps; never keys or the database URL) and the allowlist size
npm run proxy-buy              # serves on PORT (default 8402), 127.0.0.1 unless HOST is set
```

| Variable | What |
|---|---|
| `VET402_PROXY_BUY_ENABLED` | `1` to buy; anything else answers 503 and does nothing |
| `VET402_PROXY_PUBLIC_ORIGIN` | public origin, for record links |
| `DATABASE_URL` | Postgres connection string (set by the Neon integration on Vercel; `POSTGRES_URL` is also read) |
| `VET402_PROXY_SOLANA_RECEIVE`, `VET402_PROXY_SOLANA_PAYER`, `VET402_PROXY_SOLANA_PAYER_KEY` | Solana receive address, payer address, payer key (64-byte JSON array) |
| `SOLANA_RPC_URL`, `VET402_PROXY_FACILITATOR_URL` | Solana RPC; facilitator for the agent's payment (default PayAI) |
| `VET402_PROXY_TEMPO_RECEIVE`, `VET402_PROXY_TEMPO_PAYER`, `VET402_PROXY_TEMPO_PAYER_KEY` | Tempo receive address, payer address, payer key (0x, 32 bytes) |
| `VET402_PROXY_MPP_SECRET`, `TEMPO_RPC_URL` | secret that binds MPP challenges (32+ characters); Tempo RPC |
| `VET402_PROXY_SOLANA_DAILY_CAP`, `VET402_PROXY_TEMPO_DAILY_CAP` | daily caps, e.g. `2.00` |
| `VET402_PROXY_SOLANA_REFUND_DAILY_CAP`, `VET402_PROXY_TEMPO_REFUND_DAILY_CAP` | refund room caps: the most the day's open purchases may hold for refunds at once (default: the daily cap) |
| `VET402_PROXY_TEMPO_ENABLED` | `1` to take Tempo payments; default off |
| `VET402_PROXY_SOLANA_NOT_DELIVERED_REFUND_DAILY_CAP`, `VET402_PROXY_SOLANA_NOT_DELIVERED_REFUND_MONTHLY_CAP` | the refund for an undelivered answer on Solana: most refunded this way per UTC day and per UTC month, e.g. `2.00` and `20.00` (at most those). Both unset: off (the default). One without the other: refused at start |
| `CRON_SECRET` | Vercel Cron's bearer secret for `api/reconcile.ts`, 16+ characters: a shorter one is refused, every cron call gets 403, the reconciler does not run and the Mac's runner reports it late |
| `VET402_PROXY_ALERTS_SECRET` | a separate, read-only bearer secret for `api/alerts.ts` (16+ characters); the Mac's runner holds this one, never the cron's. The same value as `CRON_SECRET` is refused (503) |
| `VET402_PROXY_TRUST_PROXY` | local server (`npm run proxy-buy`) only, default off: the client address is then the socket's. Set `1` only behind a reverse proxy that sets `x-real-ip`. Not read on Vercel, where the platform sets `x-real-ip` itself |

Keys are read from the environment only and never printed; an error about a key never quotes it.

ALERTs and clearing them up:
- Every `ALERT` the reconciler says is also kept in Postgres (`pb_alert`: one row per purchase and kind, with the reason, when it was first and last seen and how often); one that no longer holds on the next full look is resolved (a look cut short by a run's own read budget leaves it open). `GET /api/alerts` with `Authorization: Bearer $VET402_PROXY_ALERTS_SECRET` (compared in constant time) returns the open ones and when the reconciler last ran in full (`reconcilerLastRunAt`, from `pb_state`), with no keys and no RPC URLs.
- On the operator's Mac, the daily runner's `proxy-alerts` job (below) reads them at :02 and :32 every hour, two minutes after each cron run, and writes each new one, and each one still open a day later, as one line to the alert file with a macOS notification. It also says so, once and then daily, when this month's database time, projected to the month's end, passes 80 CU-hours (each read records when the database last woke up, `pg_postmaster_start_time()` from `api/alerts`; a wake-up that starts and ends between two reads is not seen, so the estimate can only undercount, but a database that never stops is seen at once), when the database does not say when it woke up, when the reconciler has not run in full for 95 minutes (three cron intervals and one run's time, so two missed runs in a row do not raise it; the cron stopped) and when the read fails (no answer, not 200, not JSON, no alerts list); and once when its settings are missing, when its script is missing, when a previous run still holds its lock, and when it reaches its end day. It never stops quietly.
- `npm run proxy-buy:resolve -- list` shows the open alerts and the purchases behind them. Then, with a reason every time:
  - `recheck <id>`: look again now (one reconcile run), for example after the RPC came back;
  - `reopen-refund <id> --reason "..." [--to <address>]`: a refund that is stuck (every sent attempt proven dead, or it could never be sent) may be sent again, to another address if the first cannot receive it;
  - `settle <id> --reason "..." --spent <atomic> [--refund-tx <signature>]`: close it with what a person found out (for example a refund sent by hand), giving back what the purchase reserved minus `--spent` and minus the Tempo network fees already recorded with it (`facts.fees`, shown by `list`: leave them out of `--spent`); for a delivered purchase whose seller payment stays unseen, it marks that payment as seen. Refused while a sent refund can still land (`sending`, `unknown`: recheck until the reconciler decides it), when the refund was sent (the reconciler closes it), and when the purchase or its refund changed in the last ten minutes. The purchase (locked first) and the refund row change in one transaction and only as they were read; with no refund row yet, settle takes the purchase's single refund row itself, and the reconciler claims a refund only after reading the purchase again under its lock. A reconciler that starts a refund meanwhile wins, or finds the purchase closed; nothing is sent twice. A look by the reconciler that changes nothing (a refund still refused or still failing) does not move the purchase's last-change time, so the ten minutes can pass. Without `--refund-tx` the refund row is closed with the purchase (`closed`), not left open;
  - `note <id> --reason "..."`: only a note on its alerts.

Code: `src/proxy-buy/`, `api/`, `scripts/proxy-buy-serve.ts`, `scripts/proxy-buy-reconcile.ts`, `scripts/proxy-buy-resolve.ts`, `scripts/daily/proxy-alerts.ts`. Tests: `test/proxy-buy.test.ts` (mock sellers, a fake facilitator, fake chains, the real mppx server and client, and an in-process Postgres: success, no delivery, a seller that never settles vet402's payment, price raised, payTo moved, the same payment ten times at once or re-encoded or on another instance, a reused settlement, caps, balance and a wallet drained from outside, a process stopped half way and while refunding, refunds and their caps, error text kept out of answers), `test/proxy-buy-review2.test.ts` to `test/proxy-buy-review10.test.ts` (what reviews found: a flood of signatures, a seller naming an earlier settlement, concurrent purchases at one price, a transaction with no expiry, undecidable rows, an off-curve refund owner, an RPC node behind the others, a seller payment landing after its purchase closed, a blockhash the node does not know yet, a seller naming the blockhash, a last valid height a few blocks off, version 1 transactions including a real mainnet one, a pruned history, durable nonces, a listing that skips the window, the ALERT flow and the runner, settling by hand, an agent that settles its own payment first), `test/proxy-buy-not-delivered.test.ts` (the refund for an undelivered answer: which answers are refunded and which are not, the amount, the caps per day and month, one per paying address per day, the seller held until it delivers again, never to the seller's own payTo, one refund per purchase under concurrency, a refund that fails to send staying owed for the reconciler, the wallet books, and nothing changed with the caps unset), `test/proxy-buy-pg.test.ts` (a real Postgres server with concurrent connections, when `PROXY_BUY_TEST_PG_URL` is set) and `test/proxy-buy-e2e.test.ts` (the same over real sockets on 127.0.0.1).

## Daily runner (launchd)

`scripts/daily/run.sh` runs the remeasure purchases, the daily records and their publishing in one fixed order, from launchd on the machine that holds the keys. Every step that can stop does stop: the run pays nothing more, writes one line to the alert file and shows a notification. A stop after money could have moved also leaves `HALT-<lane>` in the state folder, and that lane does nothing until a person has looked and removed it.

| Job | Time (JST) | What |
|---|---|---|
| `am` | 10:17 | Solana, then Tempo: dry run, pay only within the run cap, the month and the balance (slots already in the spend ledger left out), then publish |
| `pm` | 22:17 | Solana, the second purchase per payTo, then publish |
| `records` | 09:05 | every closed UTC day with purchases whose root is not anchored or not published, oldest first, at most 3: build, verify each record, publish-records, anchor (once), publish. A dry run until `~/.config/vet402-daily/records-enabled` exists |
| `board` | 19:05 | kzmttkc/vet402-algorand: when today's `board/<UTC day>.json` on main has no `completedAt` and no board run is queued or running, starts `board.yml` (`mode=daily`) once |
| `proxy-alerts` | :02 and :32 every hour | reads the deployed proxy buy's open ALERTs (`VET402_PROXY_ALERTS_URL` and `VET402_PROXY_ALERTS_SECRET` in the env file; unset: says so once) and writes each new one, or one still open a day later, to the alert file with a notification. Its own lock: it never waits on or blocks a paying run. Pays nothing |
| `publish` | by hand | publishes today's results again without paying, after a stop that a person resolved |

Both purchase times are inside one UTC day (01:17 and 13:17 UTC). The jobs have no end date: `am`, `pm` and `publish` go on until `VET402_DAILY_END=YYYY-MM-DD` is set in `~/.config/vet402-daily/env` (nothing runs from that JST day); set `VET402_RECORDS_END` to the day after it, so the last purchase day is still recorded, published and anchored the next morning; `VET402_BOARD_END` stops `board`; `proxy-alerts` stops from 2026-12-31 (`VET402_PROXY_ALERTS_END`). An end that is not a date stops the job with an alert line. What bounds the money is the caps, not a date: per run, per day and per calendar month (`src/remeasure/constants.ts`). A run that reaches the month cap buys what fits, publishes it, and writes one notice line (not a stop, no HALT); after that the dry runs find nothing that fits and nothing is bought until the first of the next month (UTC). If a records run fails, nothing retries that day on its own: run `~/vet402-solana/scripts/daily/run.sh records` once by hand after fixing the cause.

Publishing: each result file is copied into `data/` through the secret gate (`scripts/daily/secret-gate.ts`), `data/manifest.json` is updated, rank and site are rebuilt, the tree is scanned again, typecheck and `npm test` run, and one commit with `data/` and `site/` only is checked against the pre-push review gate and pushed. A dry run (`--dry-run`) does the same with a made-up copy of the newest day dated today, and never pushes.

### Setting it up

After the runner is on main:

```bash
git -C ~/vet402-solana pull --ff-only origin main
mkdir -p ~/.config/vet402-daily
printf 'VET402_ALERTS_FILE=%s\n' /path/to/ALERTS.md > ~/.config/vet402-daily/env   # required: without it nothing runs
cp ~/vet402-solana/scripts/daily/launchd/launch.sh ~/.config/vet402-daily/launch.sh
env -i HOME="$HOME" PATH=/usr/bin:/bin ~/vet402-solana/scripts/daily/run.sh am --dry-run   # read the log in ~/Library/Logs/vet402-daily/
cp ~/vet402-solana/scripts/daily/launchd/com.vet402.daily.*.plist ~/Library/LaunchAgents/
for j in am pm records board proxy-alerts; do launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.vet402.daily.$j.plist; done
launchctl list | grep com.vet402.daily
```

The plists start `~/.config/vet402-daily/launch.sh`, which lives outside the checkout: if `run.sh` is missing it still writes the alert line and the notification. The records job sends anchors only after `touch ~/.config/vet402-daily/records-enabled`, once a person has run `run.sh records` by hand and read its log.

### Tempo anchor and the Tempo access key (off by default)

- After the memo (and Tempo), the records job puts each day's root into the observation-roots program on Solana (`anchor-receipts --day <day> --post-root --send`, signed and paid by the posting key `.keys/mainnet/roots-poster.json`, never by the purchase wallet; see `solana-program/README.md`). A day already posted is not sent again. The posting key's balance is read first: below one day's rent and fee plus the empty account's rent-exempt minimum, nothing is signed and the alert file gets one line. Any failure is one alert line starting `records: post_root failed, publish continues:` (a failed Tempo anchor likewise starts `records: Tempo anchor failed, publish continues:`), and the records are published without it. Once the account reads back with the memo's root, count, sequence range and observer, `<day>/anchor-program-sent.json` names the day, the root, the program, the account, the transaction and its slot, and `records:publish` copies them (only for that root) into `data/records/index.json` (`days[].programRoot`). Each record page then shows the account next to the memo. Days posted before that file existed are filled in with `npx tsx scripts/backfill-program-roots.ts --write`, which reads the chain only and refuses any account that differs from the index; `--check` reads again every entry the index already names and writes nothing.
- The records job also writes each day's root on Tempo only after `touch ~/.config/vet402-daily/tempo-anchor-enabled`: one TIP-20 `transferWithMemo` of 0.000001 USDC.e from the Tempo anchor key (`VET402_TEMPO_ANCHOR_SENDERS` in `src/receipt/observers.ts`) to the observation key's address, with the root as the memo (`scripts/anchor-receipts-tempo.ts`). The signed records are not changed: `records:publish` puts the tx, the memo and the block in `data/records/index.json` (`days[].tempoAnchor`), and `verify-receipt` checks the Tempo memo when the index names one.
- **Fund the Tempo anchor key from any address except the Tempo payer (`PAYER_ADDRESS` in `src/tempo/constants.ts`).** USDC.e that leaves the payer outside a purchase ledger stops every Tempo purchase run (`chain_spend_exceeds_ledger`, `src/tempo/key-ledgers.ts`). One anchor costs about 0.00032 USDC.e (533,091 gas at 0.6 gwei, 2026-09-30); 0.30 USDC.e covers years of daily anchors.
- Tempo purchases can sign with an AccountKeychain access key instead of the payer's root key (`src/tempo/access-key.ts`): 1.00 USDC.e per 24 hours on chain, calls only to USDC.e `transfer` and `transferWithMemo`, and an expiry. The keys are listed in `TEMPO_ACCESS_KEYS` (id, expiry, file in `.keys/`): `0x1e9AadDc86f9132DFBA8B4287978aDE1ceC93c4b` (`tempo-access.json`, registered 2026-09-30, expiry 2026-10-09 23:59:59 UTC) and `0xf480276572D3f8b1c67Cb2469c7bF1a83c3b464d` (`tempo-access-2026-12.json`, made 2026-10-01, expiry 2026-12-31 23:59:59 UTC). Purchases may sign with any listed key: before each signature its state and allowed calls are read from the chain, and a key that is not registered, expired, revoked or scoped otherwise is not used. `scripts/tempo-access-key.ts` works on the newest one (`TEMPO_ACCESS_KEY_ID`): with no flag it simulates the registration (eth_call and eth_estimateGas, signs nothing), `--status` reads it back (limit, expiry, allowed calls), `--send` registers it, signed by the payer's root key with the anchor key paying the fee. `VET402_EVM_KEY_FILE` in `~/.config/vet402-daily/env` names the file purchases sign with.
- **The access key's expiry.** After a key's expiry the chain refuses everything it signs. The daily Tempo dry run reads the key `VET402_EVM_KEY_FILE` names and puts it in the plan (`signer`): from three days before the expiry the `am` run writes one notice line a day, and once the key cannot sign the next run (expired, or less than six hours left, revoked, not registered) Tempo is left out that day with one alert line (`am: remeasure tempo failed, publish continues: tempo: not buying today, the purchase key cannot sign: ...`), while Solana buys and publishes as usual and the lane is not halted. An expiry cannot be moved: `authorizeKey` for a key that exists reverts with `KeyAlreadyExists` (simulated on mainnet 2026-10-01). A later end is a new key:
  1. `npx tsx scripts/tempo-access-key.ts --keygen --file tempo-access-<name>.json --keys-dir ~/vet402-solana/.keys` (mode 600, never overwrites; prints the key id only).
  2. In one reviewed commit, append `{ id, expiry, file }` to `TEMPO_ACCESS_KEYS` and update `test/tempo-plus.test.ts`. Older keys stay listed until their expiry, so purchases go on with the file the env names.
  3. On main, with that commit: `npx tsx scripts/tempo-access-key.ts` (simulation: `simulation.ok` true, `alreadyOnChain` false, `feeBoundAtomic` at most 80000, the anchor key's balance above it). Then `npx tsx scripts/tempo-access-key.ts --send`, not while a Tempo purchase run is in progress (both use the payer's nonce; it refuses when a payer transaction is in flight, and when the payer's USDC.e moved). Then `--status`: `registered` true, the new `expiresAt`, `allowedCallsCheck` ok.
  4. Only after `--status` says so: point `VET402_EVM_KEY_FILE` in `~/.config/vet402-daily/env` at the new file. A file whose key is not registered yet is not used: Tempo is left out that day (one alert line), nothing is halted.

  Without an access key at all, point `VET402_EVM_KEY_FILE` at `~/vet402-solana/.keys/evm.json` (or remove the line): purchases sign with the payer's root key; the run, day and month caps and the signed-transaction checks still apply, only the on-chain second fence is gone.

### What the secret gate stops, and what it cannot

It reads each string as written and after undoing JSON escapes (`\u0074`, `\x74`), HTML character references (`&#116;`), percent-encoding (twice), base64 and hex of text, zero-width characters, and JSON inside strings.

It stops on:
- any value (text of any length or case, a number, a list or an object) under a secret-like name, wherever the name stands: JSON, queries, fragments, forms, `name = value`, headers and YAML lines, HTML attributes, XML tags, backtick quotes. Names are compared after folding case, separators, fullwidth forms and lookalike letters from other scripts (`token` spelled with a Cyrillic o, U+043E). Secret-like: any name containing `token`, `secret`, `key`, `passw`, `session`, `cookie`, `credential`, `jwt`, `mnemonic` (so also `keyword`, `tokenAddress`); the names `pk`, `priv`, `private`, `seed`, `wif`, `xprv`, `wallet`, `otp`; names ending in `auth` or `signature`;
- a JWT or a piece of one; Bearer and Basic credentials; `user:password@` in a URL; vendor key prefixes (`sk-`, `sk_live_`, `pk_test_`, `ghp_`, `glpat-`, `npm_`, `AKIA`, ...); private key blocks; 64-byte key arrays; the runner's own keys in any common encoding; twelve or more BIP-39 words in a row;
- random-looking runs of 16 characters or more with two kinds of characters (letters and digits, or both cases); 20 or more letters of one case that do not read as English (judged by common letter pairs); 24 or more digits; base64 runs judged whole; lowercase slugs whose parts do not read as words.

`token` also names a crypto asset. A field such as `token_amount`, `base_token_price_usd`, `token_name`, `token_symbol`, `token_mint`, `tokenAddress` or a bare `token` passes only when its value has the public shape its name implies: a number for amounts and prices, a short name for names and symbols, an address for mints and addresses, an upper-case ticker or an address for a bare `token`. Lists and objects under `tokens`, `fromToken`, `base_token` and the like are read inside rather than stopped whole, and a bare `token` over an object passes only when every field describes the asset. `wallet` passes with an address and stops with anything else (a 64-byte key). Credential tokens (`access_token`, `id_token`, `auth_token`, `refresh_token`, `api_token` and similar) stop whatever their value.

A 32-byte base58 value, 64 hex characters or a 64-byte base58 value passes only under a field that says what it is (`tx`, `payTo`, `address`, `signature`, `hash`, `mint`, names ending in `tx`, `hash`, `address` and similar), or when the same value stands under such a field elsewhere in the file (on the site: anywhere in `data/`). An EVM address (`0x` and 40 hex), an Algorand address with a valid checksum and an IPFS id pass anywhere. Whole files copied from other public sources are allowed by their exact sha256; any other value is allowed only by its exact sha256 with a reason that says what it is and where it first stands (`scripts/daily/secret-allow.json`).

Limits (a secret in these shapes gets through; none is expected in a seller's response, and a person reads new sellers' bodies whenever the gate stops on them):
- under a neutral name: a random value shorter than 16 characters (20 for letters of one case, 24 for digits), or a secret split into such pieces;
- under a neutral name: a secret that has the exact format of a public id and also stands under a public-id field in the same file, or any EVM address, checksummed Algorand address or IPFS id;
- a lowercase label of a host name (`abc.example.com`, `//abc.example.com`), or a lowercase slug whose long parts read as English;
- letters of one case that happen to read as English; a recovery phrase shorter than twelve words or in another language;
- a secret shaped like a number, a short name, an address or an upper-case ticker under an asset field (`token_amount`, `token_name`, `token_mint`, `token`), or an address under `wallet`;
- an encoding the gate does not undo (encrypted, compressed, reversed short pieces, or nested more than five times).

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

ERC-8004 feedback on Base, Tempo, Robinhood Chain and Arbitrum (`scripts/erc8004-feedback.ts`) is sent from one place only, `~/vet402-solana`: its ledger `results/erc8004-feedback-ledger.json` is not in git, and the chain's `getLastIndex` is read again before every send.

## Corrections

Published data is corrected only toward what the chain shows, and every correction is listed here. The previous values stay in git history.

- **2026-09-30**: `data/tempo/ledger.json` (the 2026-09-28 Tempo census): the entries `goflightlabs` (HTTP 502) and `modal` (HTTP 500) were recorded as settled null, with no tx. Both payments settled on chain, to the mpp.tempo.xyz recipient `0xca4e835f803cb0b7c428222b3a3b98518d4779fe`: goflightlabs 0.005 USDC.e in `0x34fbc6dc957f6edd19c4e8402323b0447f9b8ebc3322c27036b4a9b9dcf965ec` (2026-09-28 08:04:39 UTC), modal 0.0001 USDC.e in `0x3439e09ee264bbc67cb1ebf45e808f4f2756a8e90925d5fcae94085be8c8643c` (08:05:17 UTC). Why they were missed: the fee was sponsored, so the transaction on chain is not the one vet402 signed, and an error answer carries no Payment-Receipt, so the runner had no tx hash to read back. Found and written by `npx tsx scripts/chain-check.ts --census --write`, which checks every USDC.e transfer out of the payer during the run against the ledger (72 transactions, 70 already recorded) and writes a transfer onto an entry only when exactly one entry fits it. Both purchases now count as paid with nothing usable back (`paid_not_delivered`) instead of a 5xx without settlement. The 2026-09-28 signed records were anchored on Solana before this correction (tx `JqhzBqMSuL9ZrZz511fCgqcvU7Sjzhs7ccdbpqtdgUUUV7G1iBAuc4my5hReEkbyr6qk9vB3uMqB13cbpVzNeb2`) and do not include these two purchases; they stay as they are.
- **2026-09-30**: `data/remeasure/tempo-2026-09-29.json` rows[30] (kicksdb, HTTP 500) was recorded as settled null, with no tx. It settled on chain: 0.0005 USDC.e to the same recipient in `0xd25f701b7d771a4715f4e01540bd4669a1e9e6c6a20f7e2dfa8e1680542417f8` (2026-09-29 08:28:46 UTC), for the same reason. Written by `npx tsx scripts/chain-check.ts --chain tempo --date 2026-09-29 --write` (35 transactions in the run, 34 already on rows). The 2026-09-29 records include it: its record (obs_2026-09-29_000288, NOT_DELIVERED, with this tx) was signed and is in the day's root, anchored on Solana on 2026-09-30 (tx `67ZnFvRzuCz2kDu8GLHyeQhsS3zJUybrCvoaCnfrBeN1MBjhXRJaZXX3DWpVpvCej7rqu2TjJ3erg8YJaEsdztb2`, see `data/records/index.json`). It is not published until that seller is told.

## Robinhood Chain and Arbitrum

```bash
npx tsx scripts/evm-lane.ts --lane robinhood --dry-run   # catalogs, unpaid 402s, Chainlink reads; signs with a throwaway key
npx tsx scripts/evm-lane.ts --lane arbitrum --dry-run    # the same listings on Arbitrum One and on Base
npx tsx scripts/evm-roots-deploy.ts --chain robinhood     # simulate deploying DeliveryRoots (eth_call, eth_estimateGas); --send deploys
npx tsx scripts/evm-chaincheck.ts --lane robinhood        # settled is read from the chain; a day's root waits for this
npx tsx scripts/evm-anchor.ts --lane robinhood --day 2026-09-30   # plan the day's root: public leaves, record() and its gas; --send writes it
npx tsx scripts/evm-roots-publish.ts --data data          # data/evm/roots/<lane>.json from the days written
npx tsx scripts/evm-publish.ts --lane robinhood && npx tsx scripts/build-site.ts --out site
cd contracts && forge test                                # DeliveryRoots against Merkle vectors from src/receipt/merkle.ts
```

Every morning the records run (`scripts/daily/run.sh records`, 09:05 JST) reads each lane's purchases against its chain before it makes the lane pages: `scripts/evm-chaincheck.ts` for Robinhood Chain, Arbitrum One and Arbitrum's Base side, read-only (`eth_getLogs` and `eth_getBlockByNumber`, nothing signed), around each run of purchases and in block chunks a public RPC answers (10,000 blocks on Arbitrum and Robinhood Chain, 2,000 on Base; `EVM_LOG_CHUNK` overrides). Its files, `results/evm/<lane>-chaincheck.jsonl`, stay in the checkout and are ignored by git. This runs with or without `evm-roots-enabled`; a failure is alerted and the rest is published, and an unchanged page publishes nothing. Exit 3 means a transfer out of the payer with no purchase, or a purchase ambiguous or still pending: the file is written, and a person looks.

Purchases made before the daily chain check (the lanes' runs up to 2026-09-30), once, by hand, in the runner's checkout (`~/vet402-solana` on main):

```bash
npx tsx scripts/evm-chaincheck.ts --lane robinhood      # each prints its tally; exit 3: look before going on
npx tsx scripts/evm-chaincheck.ts --lane arbitrum
npx tsx scripts/evm-chaincheck.ts --lane base-compare   # the Arbitrum page needs its Base side too
git status --porcelain --untracked-files=no             # nothing: the chain check only wrote ignored results/
```

The next records run makes the pages from them (and, with `evm-roots-enabled` and DeliveryRoots deployed, writes each closed day's root, 2026-09-30 included). Running them again is harmless: every run reads the same windows again and replaces the file.

The daily root holds facts, not verdicts: each leaf is one purchase's payment, the settlement the chain check read, the HTTP status, and the size and sha256 of the answer. Whether it counts as delivered, and whose side a failure is on, is decided again with the current rules each time `data/evm/roots/<lane>.json` is written (run `scripts/evm-roots-publish.ts` after every `scripts/evm-publish.ts`), so a rule change never leaves an old verdict on chain.

Rebuilding a leaf in another language: digest = keccak256 of the UTF-8 bytes of the record's canonical JSON, which is what `JSON.stringify` gives after the object keys are sorted (JavaScript's default sort, by UTF-16 code unit) and with no whitespace. Strings must be escaped exactly as `JSON.stringify` escapes them: only `"`, `\` and control characters (`\b \f \n \r \t`, the rest as `\u00xx` in lowercase hex). A lone UTF-16 surrogate (half of a pair, which UTF-8 cannot carry) is written as `\udxxx` in lowercase hex, as `JSON.stringify` does since ES2019; a language that keeps it raw or replaces it with U+FFFD gives another digest. Non-ASCII characters and `/` are written as they are, so a library that escapes them (Python's `json.dumps` without `ensure_ascii=False`, PHP's `json_encode` without `JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE`) gives another digest. `null` fields are kept; numbers are integers in plain decimal. `src/evm/evm-anchor.ts` `canonicalJson` is the reference.

One wallet (0x9B59…4E51) pays on Base, Arbitrum One and Robinhood Chain, so the same buyer is compared across chains. Each lane has its own ledger and caps (`src/evm/chains.ts`). Payment is x402 exact with EIP-3009 only; a 402 that asks for Permit2 is refused. When a paid purchase does not come back, `src/evm/settle-cause.ts` assigns one cause (facilitator, seller setup, vet402, unknown) from the seller's response and the chain, and a fix the seller can apply; a cause that rests only on a facilitator's `/supported` page is marked as a lead.

## Scope and prior work

I (Sen) started vet402 on 2026-07-13. Before this repository, vet402 already had:
- the main product at https://vet402.com (purchase lanes on Base, Solana, Tempo, Arc and XRPL);
- an Algorand version for Algorand's Global x402 Challenge: https://github.com/kzmttkc/vet402-algorand (its census data is read here as input to the ranking);
- entries at ETHGlobal ETHOnline 2026 and ETHGlobal Tokyo 2026 (their submitted code is not part of this repository).

The code in this repository was written from 2026-09-28 onward, with one exception: the delivery verdict rules in `src/verdict.ts` and the failure groups in `src/classify.ts` are ported from vet402-algorand (each file says so in its header), so that the chains are judged the same way. Those two files are prior work, not part of this entry. Data from earlier purchases is used as input and is labelled with its date.

Proxy buy (`src/proxy-buy/`) was written in this repository on 2026-09-30. Its flow (settle the agent's payment first, then pay the seller, then hand over the answer) is ported from vet402-algorand's `/v1/buy` (`src/buy.ts` and `src/settle-first.ts` there). That Algorand code is prior work and not part of this entry; the Solana and Tempo code here was written anew on top of this repository's own payment code.

## Run

```bash
npm ci
npm test
```

Paying runs need keys in `.keys/` and are gated by explicit flags (`--pay`, `--write`, `--send`) and, for Base and the EVM lanes, an environment variable as well (`VET402_BASE_PAY`, `VET402_EVM_PAY=<lane>`, `VET402_ANCHOR_SEND=<lane>`).

## License

MIT
