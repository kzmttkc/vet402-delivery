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

This repository is the multi-chain part of vet402. It buys the sellers it can on **Solana** (from the PayAI, CDP Bazaar and Pay.sh catalogs) and **Tempo** (from Tempo's Mercator directory), and on **Base** the sellers registered in ERC-8004 (8 purchases from 8 sellers on 2026-09-28, each bought once). From 2026-09-29 to 2026-10-08 it buys again every day from the Solana and Tempo sellers whose earlier payment settled (twice on Solana, once on Tempo), keeps every result with its payment, and grades sellers by what was actually delivered, not by how popular a listing is.

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
| Remeasure | Buys again every day from 2026-09-29 to 2026-10-08, twice on Solana and once on Tempo, from sellers vet402 already paid (payment settled), so the ranking gets purchases on more than one day | `scripts/remeasure.ts`, `src/remeasure/` |
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

From 2026-09-29 to 2026-10-08, vet402 buys again every day: twice on Solana and once on Tempo (the ledger allows one purchase per recipient per slot per UTC day). The runs of 2026-09-29 were started by hand; from 2026-09-30 the daily runner below starts them. The days it ran are the files in data/remeasure/.

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

## Daily runner (launchd)

`scripts/daily/run.sh` runs the remeasure purchases, the daily records and their publishing in one fixed order, from launchd on the machine that holds the keys. Every step that can stop does stop: the run pays nothing more, writes one line to the alert file and shows a notification. A stop after money could have moved also leaves `HALT-<lane>` in the state folder, and that lane does nothing until a person has looked and removed it.

| Job | Time (JST) | What |
|---|---|---|
| `am` | 10:17 | Solana, then Tempo: dry run, pay only within the run cap, the month and the balance (slots already in the spend ledger left out), then publish |
| `pm` | 22:17 | Solana, the second purchase per payTo, then publish |
| `records` | 09:05 | every closed UTC day with purchases whose root is not anchored or not published, oldest first, at most 3: build, verify each record, publish-records, anchor (once), publish. A dry run until `~/.config/vet402-daily/records-enabled` exists |
| `board` | 19:05 | kzmttkc/vet402-algorand: when today's `board/<UTC day>.json` on main has no `completedAt` and no board run is queued or running, starts `board.yml` (`mode=daily`) once |
| `publish` | by hand | publishes today's results again without paying, after a stop that a person resolved |

Both purchase times are inside one UTC day (01:17 and 13:17 UTC). The jobs end on their own days (JST): `am`, `pm` and `publish` do nothing from 2026-10-09 (`VET402_DAILY_END`), so the last purchases are on UTC day 2026-10-08; `records` does nothing from 2026-10-10 (`VET402_RECORDS_END`), so the 2026-10-09 09:05 run still records, publishes and anchors that day; `board` does nothing from 2026-10-31 (`VET402_BOARD_END`). If the 2026-10-09 records run fails, nothing retries UTC 2026-10-08 on its own: run it once by hand after fixing the cause, with the end moved past today: `VET402_RECORDS_END=2026-10-31 ~/vet402-solana/scripts/daily/run.sh records` (the default end would refuse it from 2026-10-10).

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
for j in am pm records board; do launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.vet402.daily.$j.plist; done
launchctl list | grep com.vet402.daily
```

The plists start `~/.config/vet402-daily/launch.sh`, which lives outside the checkout: if `run.sh` is missing it still writes the alert line and the notification. The records job sends anchors only after `touch ~/.config/vet402-daily/records-enabled`, once a person has run `run.sh records` by hand and read its log.

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
