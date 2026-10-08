/**
 * Vercel AI SDK: a tool that fetches a paid x402 URL, with vet402's check before each payment.
 *
 *   npm install ai @x402/fetch @vet402/check zod
 *
 *   const result = await generateText({ model, tools: { fetchPaid: vet402PaidFetchTool({ client }) }, prompt: "..." });
 *
 * `client` is the x402Client the agent pays with. The check reads vet402's public record only.
 */
import { tool } from "ai";
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

export function vet402PaidFetchTool(o: { client: x402Client; fetch?: typeof fetch; data?: PublicData; askHuman?: (event: CheckEvent) => boolean | Promise<boolean> }) {
  const paidFetch = wrapFetchWithPayment(
    wrapFetchWithCheck(o.fetch ?? fetch, { block: "avoid", policy: POLICY, ...(o.data ? { data: o.data } : {}), ...(o.askHuman ? { askHuman: o.askHuman } : {}) }) as typeof fetch,
    o.client,
  );
  return tool({
    description: "Fetch an x402 URL and pay for it. vet402's public record of the seller is checked before paying.",
    inputSchema: z.object({ url: z.string().describe("The https URL to fetch") }),
    execute: async ({ url }: { url: string }) => {
      try {
        const res = await paidFetch(url);
        return { paid: true, status: res.status, body: (await res.text()).slice(0, 4000) };
      } catch (e) {
        if (e instanceof CheckBlockedError) return { paid: false, reasons: e.reasons.map((r) => r.reason), message: e.message };
        throw e;
      }
    },
  });
}
