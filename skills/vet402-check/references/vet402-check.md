# Checking an x402 seller with vet402

Look up what vet402 recorded the last time it paid this exact URL with its own wallet. **No authentication, no balance and no payment are needed.** Every request below is a free, public GET.

## Input Validation

Before building any command, validate the URL from the search result:

- **url**: must start with `https://` or `http://` and must not contain spaces, semicolons, pipes, backticks, `$`, `<` or `>`. Reject it otherwise.
- URL-encode it once for the `?q=` / `?query=` / `?url=` parameters (`:` → `%3A`, `/` → `%2F`, `?` → `%3F`, `&` → `%26`, `=` → `%3D`).
- Always wrap the full request URL in single quotes.

## Commands

### 1. Find the exact URL in vet402's observatory

```bash
curl -sL 'https://vet402.com/api/v1/resolve?q=<url-encoded url>'
```

Use `resource.observatory_id` **only if** `resource.canonical_url` is exactly the URL you are about to pay. Other URLs of the same seller (in `endpoints[]`) are not a record of this URL. If there is no such `resource`, go to step 4.

### 2. Read vet402's facts and purchases for it

```bash
curl -sL 'https://vet402.com/api/v1/observatory/endpoints/<observatory_id>/facts'
curl -sL 'https://vet402.com/api/v1/observatory/endpoints/<observatory_id>/purchases'
```

- `purchases[]` is newest first. Each row: `attemptedAt`, `status`, `txHash`, `httpStatusPaid`, `l2Schema`, `amountUnits`.
- `facts.l1.n_attempts / n_settled / n_delivered`: vet402's own paid attempts.
- `facts.settlement_30d_real`: settlements to this resource that vet402 counts on-chain over 30 days, wash and test excluded.

### 3. Read the Bazaar's own call count

If you already have the `awal x402 bazaar search --json` output, take `quality.l30DaysTotalCalls` from the matching resource. Otherwise:

```bash
curl -sL 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?query=<url-encoded url>&limit=5'
```

Use the item whose `resource` equals the URL exactly. **Gap** = `quality.l30DaysTotalCalls` − `facts.settlement_30d_real`. A large positive gap means the listing reports more calls than vet402 can see settle on-chain. Report the gap; do not decide on it alone.

### 4. Nothing settled on vet402.com: ask whether vet402 can buy it for you

```bash
curl -sL -o /dev/null -w '%{http_code}' 'https://vet402-algorand.vercel.app/v1/buy?url=<url-encoded url>'
```

This is an unpaid request, so nothing is charged. `402` means vet402 can buy this seller for you: it pays the seller only after checking it and hands back the seller's response. `422` (`no_supported_accept`) means it cannot.

Algorand sellers also appear on the free board `https://vet402-algorand.vercel.app/board/verdicts.json` (`class` `DELIVERED` / `MISMATCH`, `purchaseTx`).

## Decision Rules

Take the newest purchase with `status` `settled`, **skipping** rows whose `httpStatusPaid` is 4xx. vet402 counts a paid 4xx as inconclusive, because the request vet402 sent may have been what was wrong.

| That purchase | Verdict | Next |
| --- | --- | --- |
| `httpStatusPaid` 2xx | **delivered** | `npx awal@2.12.1 x402 pay '<url>' --max-amount <n>`. If `l2Schema` is `mismatch`, say the response did not match the seller's declared schema. |
| anything else (5xx, no response) | **not delivered** | Do not pay. Tell the user with the tx. |
| none (no record, never settled, or only 4xx) | **unverified** | If step 4 returned `402`: `npx awal@2.12.1 x402 pay 'https://vet402-algorand.vercel.app/v1/buy?url=<url-encoded url>' --max-amount <n>`. Otherwise do not pay automatically; ask the user. |

Always report these four things to the user: the verdict, the date and tx of the last delivery (`https://basescan.org/tx/<txHash>` on Base), the Bazaar call count against vet402's on-chain settlements (with the gap), and the next step.

## Examples

```bash
# 1. resolve
curl -sL 'https://vet402.com/api/v1/resolve?q=https%3A%2F%2Fapi.onesource.io%2Fapi%2Fchain%2Fblock-number'
# -> resource.observatory_id = f0a1f210-dc51-4ccf-b454-6c72025e3153

# 2. facts + purchases
curl -sL 'https://vet402.com/api/v1/observatory/endpoints/f0a1f210-dc51-4ccf-b454-6c72025e3153/facts'
curl -sL 'https://vet402.com/api/v1/observatory/endpoints/f0a1f210-dc51-4ccf-b454-6c72025e3153/purchases'
# -> newest settled: 2026-09-21, HTTP 200, l2 match, tx 0x6ddc6edd…9c147e; settlement_30d_real 899

# 3. Bazaar count
curl -sL 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?query=https%3A%2F%2Fapi.onesource.io%2Fapi%2Fchain%2Fblock-number&limit=5'
# -> quality.l30DaysTotalCalls 1072, so gap = 1072 - 899 = 173

# verdict: delivered -> pay
npx awal@2.12.1 x402 pay 'https://api.onesource.io/api/chain/block-number' --max-amount 10000
```

The same check as one command (reference implementation in this repository; output shape in `examples/check-*.json`):

```bash
npx tsx scripts/vet402-check.ts https://api.onesource.io/api/chain/block-number --max-amount 10000
```

## Error Handling

- `resolve` has no `resource` for the URL: vet402 has not listed it. The verdict is **unverified**; go to step 4.
- HTTP `429` from vet402.com: rate limited (resolve 60/min, facts and purchases 120/min). Wait for `Retry-After`. Do not treat this as "unverified".
- Any request fails or times out: say the check could not run. Do not pay on a failed check without asking the user.
