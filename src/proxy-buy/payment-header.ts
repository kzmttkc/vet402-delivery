/**
 * Does a request carry a payment? The one test, for the handler (which path a request takes, and which rate
 * limit counts it) and for usage counting (src/usage/count.ts: only free quotes are counted).
 *   x402 (Solana): the PAYMENT-SIGNATURE header when it is present, else X-PAYMENT. A present but empty
 *   PAYMENT-SIGNATURE counts as no payment and X-PAYMENT is then not read.
 *   MPP (Tempo): Authorization: Payment ...
 */
export function paymentOf(h: Headers): { chain: "solana" | "tempo"; header: string } | null {
  const x402 = h.get("payment-signature") ?? h.get("x-payment");
  if (x402) return { chain: "solana", header: x402 };
  const auth = h.get("authorization");
  if (auth && /^Payment\s/i.test(auth)) return { chain: "tempo", header: auth };
  return null;
}
