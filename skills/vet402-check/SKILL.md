---
name: vet402-check
description: "Check an x402 seller before paying it: did vet402 already pay this exact URL, was it delivered, what is the settlement tx, and how does the Bazaar's own call count compare with the settlements vet402 can see on-chain. Use between `awal x402 bazaar search` and `awal x402 pay`, whenever the agent is about to pay an x402 endpoint it has not paid before. Read-only: free GETs, no wallet, no payment."
user-invocable: true
disable-model-invocation: false
allowed-tools: ["Bash(curl *)", "Bash(npx awal@2.12.1 x402 bazaar *)", "Bash(npx awal@2.12.1 x402 details *)"]
---

# vet402 check

Search, then **check**, then pay. This skill is the middle step for the Coinbase `agentic-wallet` skill:

```
npx awal@2.12.1 x402 bazaar search <query> --json   # references/x402-search.md
→ vet402 check <url>                               # this skill
→ npx awal@2.12.1 x402 pay <url>                   # references/x402-pay.md, only if the check says so
```

vet402 buys x402 endpoints with its own wallet and records what came back, with the settlement tx. This skill looks that record up. It never pays and never needs `awal` to be signed in.

## Plugging into agentic-wallet

Add one row to the routing table in `skills/agentic-wallet/SKILL.md`, and one line to `references/x402-pay.md` under Prerequisites:

| Task | Reference |
| --- | --- |
| Before paying an x402 endpoint for the first time: was it delivered, tx, Bazaar gap | `vet402-check` skill (`references/vet402-check.md`) |

> - Before the first payment to an endpoint, run the vet402 check (`vet402-check` skill) and follow its `next` step.

Read `references/vet402-check.md` for the commands and the decision rules.
