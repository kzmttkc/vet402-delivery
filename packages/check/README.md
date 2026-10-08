# @vet402/check (command: vet402-check)

Look an x402 or MPP seller up in vet402's public record before an agent pays it.

This package reads the public record of vet402's own purchases (the vet402-delivery repository). It is separate from `@vet402/mcp-server`, the MCP tools for vet402's scoring API.

vet402 buys from x402 and MPP sellers with its own money on Solana, Tempo and Base (and Algorand, on its own page), checks each payment on chain, and publishes what came back: a ranking (`rank.json`) and signed records whose daily Merkle root is written into a Solana memo. vet402-check reads that record. It returns facts: how many purchases vet402 tried from the seller, how many settled, how many came back with an answer, the newest purchase and its tx, the failures counted against the seller and the ones that are not, the grade as `rank.json` prints it (`measuring` while there are too few purchases), and the signed records for that seller. When vet402 has never bought from the seller, the answer is "vet402 has no record of this seller". What to do with the facts is up to the caller.

Reads only public files: `rank.json` and `records/<id>.json` on the public site, and `data/records/index.json` in this repository. Verifying a record also reads public RPC. No key, no wallet, no payment, no write.

## Try it in 60 seconds

Node 22 or newer. The first run downloads the package from npm (`@vet402/check`); later runs start at once.

```sh
npx -y @vet402/check https://api.xona-agent.com/token/pumpfun-trending
```

Verify the newest signed record of that seller as well (signature, Merkle proof, payment on chain, Solana memo anchor):

```sh
npx -y @vet402/check https://api.xona-agent.com/token/pumpfun-trending --verify
```

As an MCP server in Claude Code (run the line above once first, so the install is cached before the client starts the server):

```sh
claude mcp add vet402-check -- npx -y @vet402/check --mcp
```

## Without Node: Python and curl

The same lookup over HTTP, free and with no key: `GET https://vet402-delivery.vercel.app/v1/check?url=<seller URL>` (optional `chain` and `payTo`). The answer starts with `verdict` and `why` ([what the verdict means](https://kzmttkc.github.io/vet402-delivery/use.html#verdict)).

- Python, standard library only: [`examples/python/check_before_paying.py`](https://github.com/kzmttkc/vet402-delivery/blob/main/examples/python/check_before_paying.py). A command, a `pay_after_check(url, pay)` function, and a hook for the x402 Python HTTP client (`x402HTTPClientSync(client).on_payment_required(vet402_on_payment_required)`) that looks up the requested URL on every 402, before the client signs.
- curl, one line each with jq and without: [use.html#curl](https://kzmttkc.github.io/vet402-delivery/use.html#curl).

## The command line

```
vet402-check <url> [--chain solana|tempo|base|algorand|<CAIP-2>] [--pay-to <address>] [--amount <atomic units>] [--asset <address>] [--explain] [--verify] [--offline] [--json]
vet402-check verify <record id | https URL | file> [--offline] [--json]
vet402-check diagnose <tx signature or hash> --url <seller URL> [--chain solana|base] [--status <http>] [--json]
vet402-check --mcp
```

- `--chain` limits the answer to one chain (`eip155:8453` is Base, `eip155:4217` is Tempo).
- `--pay-to` compares the payTo in the 402 you hold with the payTo addresses vet402 recorded for that seller.
- `--amount` and `--asset` compare the 402's amount (atomic units, as x402 writes it) and asset with what vet402 paid that seller (see [Compare the 402 with what vet402 paid](#compare-the-402-with-what-vet402-paid)).
- `--explain` lists the purchases the answer rests on, newest first, each with its date, chain, result, HTTP status and tx, and the payments in the seller's signed records (amount, asset, payTo).
- `--json` prints the whole result: `sellers[]` (one per page the seller is on), `records`, `payTo`, `asOf`, `sources`.
- Exit 0 after a lookup, found or not; 1 when a record fails verification; 2 on bad input or unreadable data.

From a clone: `npm ci`, then `npm run check-before-paying -- <url>`.

## MCP tools

Three read-only tools (stdio, newline-delimited JSON-RPC):

| Tool | Input | Returns |
|---|---|---|
| `check_before_paying` | `url`, optional `chain`, `pay_to`, `amount`, `asset`, `explain`, `verify_newest_record` | the facts above and the named reasons, as text and as `structuredContent` |
| `verify_record` | `record` (id or https URL), optional `offline` | `OK`, `OK_NOT_ANCHORED`, `OK_OFFLINE` or `FAIL`, one line per check |
| `diagnose_failed_payment` | `tx`, `url`, optional `chain`, `status` | `seller_side`, `facilitator_side`, `buyer_side` or `undetermined`, with reasons, and an evidence pack for `seller_side` |

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "vet402-check": { "command": "npx", "args": ["-y", "@vet402/check", "--mcp"] } } }
```

## At the payment: the x402 fetch hook

Wrap the fetch an x402 client pays through. Every 402 is looked up before the client signs:

```ts
import { wrapFetchWithPayment } from "@x402/fetch";
import { wrapFetchWithCheck } from "@vet402/check"; // npm install @vet402/check

const fetchWithPay = wrapFetchWithPayment(
  wrapFetchWithCheck(fetch, {
    onCheck: (e) => {
      console.log(e.checks.map((c) => c.summary).join("\n"));
      // The rule is yours. To stop the payment, throw here:
      // if (e.checks.some((c) => c.sellers.some((s) => s.settled > 0 && s.delivered === 0))) throw new Error("not paying");
    },
  }),
  client,
);
```

The hook goes under the payment wrapper because `@x402/fetch` calls the fetch it was given and creates the payment only after that returns 402. The hook reads the 402 through a clone (x402 `accepts` from the body or the `PAYMENT-REQUIRED` header, and an MPP `WWW-Authenticate: Payment` challenge), runs `check_before_paying` for each chain and payTo it offers, passes the result to `onCheck`, and returns the 402 unchanged. It never sees a key or a signer and changes no header. A request that already carries a payment (`X-PAYMENT`, `PAYMENT-SIGNATURE`, `Authorization: Payment`) is the client's retry and passes straight through. If vet402's record cannot be read, `onCheck` gets `error` set and no checks.

`rank.json` and the records index are read once and kept in memory for 10 minutes (`new PublicData({ ttlMs })`), so a busy agent does not download them for every 402. The signed records read to compare amounts are kept the same way.

## Named reasons and a policy

Every answer carries `reasons[]`, each with one sentence and the purchases or records it rests on. They are facts next to the verdict and never change it.

| Reason | When |
|---|---|
| `paid_not_delivered` | vet402's newest paid purchase from the seller settled and came back with no answer (rank.json's seller-side rules after a settled payment). Said only for a seller vet402 has told about its results, the same condition the verdict uses. |
| `payto_differs` | The payTo in the 402 is not one vet402 paid this seller (and vet402 recorded at least one). |
| `price_jump` | The 402 asks more than 10 times the highest amount vet402 paid for the same URL in the same asset. 10 times exactly is not a price_jump. |
| `asset_unseen` | The 402 asks for an asset vet402 never paid this seller in on that chain. |
| `never_bought` | vet402 has no purchase from this seller (on the asked chain). |
| `stale` | vet402's newest purchase from this seller is more than 7 days old. |

`price_jump` and `asset_unseen` come from the seller's signed records (the newest 8 on that chain, those for the same URL first). With no record to compare with, neither is said.

Give the hook a policy to decide per reason:

```ts
const fetchWithPay = wrapFetchWithPayment(
  wrapFetchWithCheck(fetch, {
    policy: { paid_not_delivered: "block", payto_differs: "block", price_jump: "block", asset_unseen: "ask_human", never_bought: "warn" },
    askHuman: async (e) => confirmWithPerson(e.reasons), // true pays, anything else stops
  }),
  client,
);
```

- `block` throws a `CheckBlockedError` before the client signs; its `reasons` names what stopped it.
- `ask_human` calls `askHuman(event)` and pays only when it returns `true`. With no `askHuman`, it stops with a `CheckNeedsApprovalError` (a `CheckBlockedError`).
- `warn` and `allow` go on. A reason the policy leaves out is `allow`.
- `onCheck` gets `event.reasons` and `event.decision` (the action per reason and the strictest one) before any of this.
- Without `policy`, the hook decides exactly as in 0.1.2: `event.reasons` is filled, nothing else changes.
- When vet402's record cannot be read, `event.error` is set, there are no reasons, and the payment goes on, as in 0.1.2.

## Compare the 402 with what vet402 paid

```sh
npx -y @vet402/check https://api.xona-agent.com/token/pumpfun-trending --chain solana --amount 1000000 --asset EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
```

The answer adds `comparison`: the signed records read, the assets vet402 paid this seller in, the highest amount vet402 paid for this URL with its record and tx, and the ratio of the 402's amount to it. The hook makes the same comparison for every x402 offer in a 402.

## Diagnose a payment that brought no answer

```sh
npx -y @vet402/check diagnose <tx signature or hash> --url <seller URL> --status 500
```

From TypeScript: `diagnose({ tx, url, status }, new PublicData())`. As an MCP tool: `diagnose_failed_payment`.

1. Reads the payment from public RPC (Solana or Base; `SOLANA_RPC_URL` and `BASE_RPC_URL` point it at other RPCs): settled or not, the payTo, the amount, the asset, the time. Nothing is signed or sent.
2. Classifies the attempt with vet402's own fault rules (the same code rank.json is built with).
3. Lists vet402's own purchases from the same seller on the same chain within 24 hours of the payment, or the nearest ones when there are none. rank.json keeps the newest purchases per seller, so an older payment may have none in its window.

The answer is `fault` with `reasons[]`:

- `seller_side` only when all of these hold: the payment settled on chain, to a payTo vet402 paid this seller; the HTTP status is one vet402's rules put on the seller after a settled payment (5xx, 402 again); and vet402's own paid purchases from the seller within 24 hours also settled and came back with no answer, with none delivered.
- `buyer_side` only for a payment that failed on chain because the paying token account lacked the funds.
- `facilitator_side` only for a payment that failed on chain for another reason while vet402's own payments to the seller in the window also failed before settling.
- `undetermined` for everything else: the RPC could not be read, no such transaction, no status given, a 4xx, a payTo vet402 never paid, vet402 got an answer from the seller in the window, or vet402 has no purchase in the window. A seller is not named on less than the full test.

For `seller_side`, `evidence` holds a pack to hand to the seller, as JSON and as Markdown: the tx and its explorer link, payer, payTo, amount and asset, the status seen, vet402's rule, vet402's purchases in the window with their tx, and the signed records of those days. It is printed, not sent.

## Framework examples

`examples/` in this folder (not in the npm package): Coinbase AgentKit, OpenAI Agents SDK, Vercel AI SDK (TypeScript) and LangChain (Python). Each gives an agent one tool that fetches a paid x402 URL through the check, with a policy. `packages/check/test/examples.test.ts` runs each one with no network, with a local stand-in for the framework's tool function.

## Reading the answer

- **tried / settled / came back with an answer**: an answer is a 2xx with a non-empty body after the payment settled. vet402 does not check that the answer is what the listing promised.
- **Failures counted against the seller**: rules whose fault is the seller's in `rank.json`'s `method.faultRules` (for example `paid_not_delivered`: vet402's payment settled and the seller answered 5xx or nothing).
- **Not counted against the seller**: failures on vet402's or the facilitator's side, and failures whose cause cannot be told.
- **Grade**: as `rank.json` prints it. `measuring` means too few purchases for a grade.
- **Signed records**: published for DELIVERED purchases, and for other verdicts once vet402 has told the seller. A seller with purchases and no negative record may still have failures in `rank.json`.
- **as of**: the date of `rank.json` and the record days read. vet402 buys again on a schedule; a seller can change after the newest purchase.

## Why a record can be checked

Each record is signed by vet402's observation key (EIP-712). Each day's records form a Merkle tree, and its root is written in a Solana memo by vet402's anchor wallet, so a record cannot be added to or dropped from a day later without the root changing. `verify_record` checks that the bytes are the ones the records index lists, the key, the signature, that the verdict follows from the recorded checks, the Merkle proof, the payment on Solana, Base or Tempo over public RPC, and the memo. It uses the same code as `scripts/verify-receipt.ts` (`src/receipt/`). RPCs: `SOLANA_RPC_URL`, `BASE_RPC_URL`, `TEMPO_RPC_URL`, or the public endpoints.

## Other sources

`VET402_CHECK_RANK`, `VET402_CHECK_RECORDS_INDEX` and `VET402_CHECK_RECORDS_BASE` point the check at other copies (an https URL or a local path), for example a local build of the site.

## Tests

`npm test` runs `packages/check/test/check.test.ts` with no network, on fixtures cut from the public data by `packages/check/test/make-fixtures.ts`: a seller with seller-side failures and negative records, a seller that delivered, an unknown seller, chain and payTo filters, a shared host, record verification that passes, and records changed by one character, a Merkle proof and a memo from another wallet that fail.

`packages/check/test/v020.test.ts` covers diagnose (fixed RPC answers for Solana and Base: settled, failed on chain, not found, RPC down), the comparison of a 402 with vet402's payments, the reasons and the hook's policy with the real `@x402/fetch` and a spy signer, `--explain` and the MCP tool. `packages/check/test/examples.test.ts` runs the framework examples.

`packages/check/test/no-node.test.ts` runs the Python example and the Python and curl lines of use.html against `/v1/check`'s own handler on loopback. `packages/check/test/package.test.ts` builds the npm package (`scripts/build.mjs`) and runs it from a folder outside the repository.

Prior work: the placement of the hook under the payment wrapper follows [probe402-check](https://github.com/probe402/probe402-check), which checks a different public record (probe402's).
