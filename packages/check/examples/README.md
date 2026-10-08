# Examples: a check before each x402 payment, inside an agent framework

Each example wraps the fetch an x402 client pays through with `wrapFetchWithCheck` from `@vet402/check`, under `wrapFetchWithPayment` from `@x402/fetch`, and hands the agent one tool that fetches a paid URL. Every 402 is looked up in vet402's public record before the client signs; the policy below decides per reason.

| Folder | Framework | Tool definition |
|---|---|---|
| `agentkit/` | Coinbase AgentKit (TypeScript) | `customActionProvider({ name, description, schema, invoke })` |
| `openai-agents/` | OpenAI Agents SDK (TypeScript) | `tool({ name, description, parameters, execute })` |
| `vercel-ai/` | Vercel AI SDK (TypeScript) | `tool({ description, inputSchema, execute })` |
| `langchain-python/` | LangChain (Python) | `@tool` from `langchain_core.tools`, over `GET /v1/check` |

The examples are not in the npm package. `packages/check/test/examples.test.ts` runs each one with no network: a local stand-in for the framework's tool function (the frameworks are not dependencies of this repository), a 402 served in memory, a spy signer, and vet402's record from the test fixtures. What it checks: a seller whose verdict is avoid, or a 402 asking more than 10 times what vet402 paid for the URL, never reaches the signer; another seller is paid.

The policy used in the TypeScript examples:

```ts
const POLICY = {
  paid_not_delivered: "block",
  payto_differs: "block",
  price_jump: "block",
  asset_unseen: "ask_human",
  never_bought: "warn",
  stale: "warn",
} as const;
```
