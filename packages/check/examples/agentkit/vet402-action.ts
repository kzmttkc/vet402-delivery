/**
 * Coinbase AgentKit: an action that fetches a paid x402 URL, with vet402's check before each payment.
 *
 *   npm install @coinbase/agentkit @x402/fetch @vet402/check zod
 *
 *   const agentkit = await AgentKit.from({ walletProvider, actionProviders: [vet402PaidFetchAction({ client })] });
 *
 * `client` is the x402Client the agent pays with (registered with the agent's signer). The check reads
 * vet402's public record only; it never sees the signer.
 */
import { customActionProvider } from "@coinbase/agentkit";
import { wrapFetchWithPayment, type x402Client } from "@x402/fetch";
import { CheckBlockedError, PublicData, wrapFetchWithCheck, type CheckEvent, type Policy } from "@vet402/check";
import { z } from "zod";

export const POLICY: Policy = {
  paid_not_delivered: "block",
  payto_differs: "block",
  price_jump: "block",
  asset_unseen: "ask_human",
  never_bought: "warn",
  stale: "warn",
};

export interface Vet402ActionOptions {
  client: x402Client;
  /** The fetch under the check (default: the global fetch). */
  fetch?: typeof fetch;
  /** vet402's public record (default: the public sources, kept in memory for 10 minutes). */
  data?: PublicData;
  /** Called for "ask_human" reasons; return true to pay. Without it those payments stop. */
  askHuman?: (event: CheckEvent) => boolean | Promise<boolean>;
}

export function vet402PaidFetchAction(o: Vet402ActionOptions) {
  const paidFetch = wrapFetchWithPayment(
    wrapFetchWithCheck(o.fetch ?? fetch, { block: "avoid", policy: POLICY, ...(o.data ? { data: o.data } : {}), ...(o.askHuman ? { askHuman: o.askHuman } : {}) }) as typeof fetch,
    o.client,
  );
  return customActionProvider({
    name: "fetch_paid_x402_url",
    description: "Fetch an x402 URL and pay for it. vet402's public record of the seller is checked before paying.",
    schema: z.object({ url: z.string().url().describe("The https URL to fetch") }),
    invoke: async (args: { url: string }) => {
      try {
        const res = await paidFetch(args.url);
        return `HTTP ${res.status}\n${(await res.text()).slice(0, 4000)}`;
      } catch (e) {
        if (e instanceof CheckBlockedError) return `Not paid. ${e.message}`;
        throw e;
      }
    },
  });
}
