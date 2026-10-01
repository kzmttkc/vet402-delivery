# @vet402/check (command: vet402-check)

Look an x402 or MPP seller up in vet402's public record before an agent pays it.

This package reads the public record of vet402's own purchases (the vet402-delivery repository). It is separate from `@vet402/mcp-server`, the MCP tools for vet402's scoring API.

vet402 buys from x402 and MPP sellers with its own money on Solana, Tempo and Base (and Algorand, on its own page), checks each payment on chain, and publishes what came back: a ranking (`rank.json`) and signed records whose daily Merkle root is written into a Solana memo. vet402-check reads that record. It returns facts: how many purchases vet402 tried from the seller, how many settled, how many came back with an answer, the newest purchase and its tx, the failures counted against the seller and the ones that are not, the grade as `rank.json` prints it (`measuring` while there are too few purchases), and the signed records for that seller. When vet402 has never bought from the seller, the answer is "vet402 has no record of this seller". What to do with the facts is up to the caller.

Reads only public files: `rank.json` and `records/<id>.json` on the public site, and `data/records/index.json` in this repository. Verifying a record also reads public RPC. No key, no wallet, no payment, no write.

## Try it in 60 seconds

Node 22 or newer. The first run installs from GitHub (about 30 seconds on an empty npm cache); later runs start at once.

```sh
npx -y github:kzmttkc/vet402-delivery#main https://api.xona-agent.com/token/pumpfun-trending
```

Verify the newest signed record of that seller as well (signature, Merkle proof, payment on chain, Solana memo anchor):

```sh
npx -y github:kzmttkc/vet402-delivery#main https://api.xona-agent.com/token/pumpfun-trending --verify
```

As an MCP server in Claude Code (run the line above once first, so the install is cached before the client starts the server):

```sh
claude mcp add vet402-check -- npx -y github:kzmttkc/vet402-delivery#main --mcp
```

## Without Node: Python and curl

The same lookup over HTTP, free and with no key: `GET https://vet402-delivery.vercel.app/v1/check?url=<seller URL>` (optional `chain` and `payTo`). The answer starts with `verdict` and `why` ([what the verdict means](https://kzmttkc.github.io/vet402-delivery/use.html#verdict)).

- Python, standard library only: [`examples/python/check_before_paying.py`](https://github.com/kzmttkc/vet402-delivery/blob/main/examples/python/check_before_paying.py). A command, a `pay_after_check(url, pay)` function, and a hook for the x402 Python HTTP client (`x402HTTPClientSync(client).on_payment_required(vet402_on_payment_required)`) that looks up the requested URL on every 402, before the client signs.
- curl, one line each with jq and without: [use.html#curl](https://kzmttkc.github.io/vet402-delivery/use.html#curl).

## The command line

```
vet402-check <url> [--chain solana|tempo|base|algorand|<CAIP-2>] [--pay-to <address>] [--verify] [--offline] [--json]
vet402-check verify <record id | https URL | file> [--offline] [--json]
vet402-check --mcp
```

- `--chain` limits the answer to one chain (`eip155:8453` is Base, `eip155:4217` is Tempo).
- `--pay-to` compares the payTo in the 402 you hold with the payTo addresses vet402 recorded for that seller.
- `--json` prints the whole result: `sellers[]` (one per page the seller is on), `records`, `payTo`, `asOf`, `sources`.
- Exit 0 after a lookup, found or not; 1 when a record fails verification; 2 on bad input or unreadable data.

From a clone: `npm ci`, then `npm run check-before-paying -- <url>`.

## MCP tools

Two read-only tools (stdio, newline-delimited JSON-RPC):

| Tool | Input | Returns |
|---|---|---|
| `check_before_paying` | `url`, optional `chain`, `pay_to`, `verify_newest_record` | the facts above, as text and as `structuredContent` |
| `verify_record` | `record` (id or https URL), optional `offline` | `OK`, `OK_NOT_ANCHORED`, `OK_OFFLINE` or `FAIL`, one line per check |

Claude Desktop (`claude_desktop_config.json`):

```json
{ "mcpServers": { "vet402-check": { "command": "npx", "args": ["-y", "github:kzmttkc/vet402-delivery#main", "--mcp"] } } }
```

## At the payment: the x402 fetch hook

Wrap the fetch an x402 client pays through. Every 402 is looked up before the client signs:

```ts
import { wrapFetchWithPayment } from "@x402/fetch";
import { wrapFetchWithCheck } from "vet402-solana/check"; // npm install github:kzmttkc/vet402-delivery, run with tsx

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

`rank.json` and the records index are read once and kept in memory for 10 minutes (`new PublicData({ ttlMs })`), so a busy agent does not download them for every 402.

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

`packages/check/test/no-node.test.ts` runs the Python example and the Python and curl lines of use.html against `/v1/check`'s own handler on loopback. `packages/check/test/package.test.ts` builds the npm package (`scripts/build.mjs`) and runs it from a folder outside the repository.

Prior work: the placement of the hook under the payment wrapper follows [probe402-check](https://github.com/probe402/probe402-check), which checks a different public record (probe402's).
