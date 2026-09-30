/**
 * Check before paying, at the one place an MPP client has picked a challenge but not yet signed:
 * mppx's `preparePayment` (mppx 0.11: "Selects a payment challenge without creating its credential").
 *
 *     const prepared = await preparePaymentWithCheck(mppx, response, {
 *       url, request,
 *       check: (input) => checkBeforePaying(input, data),   // packages/check (vet402-check)
 *       onCheck: (e) => { if (e.check?.payTo && !e.check.payTo.sameAsRecorded) throw new Error("payTo changed") },
 *     });
 *     const credential = await prepared.createCredential();  // only reached when onCheck returned
 *
 * The check is read-only and sees what will be signed: the challenge preparePayment selected (method,
 * chain, recipient, amount, currency), not the whole 402. It never sees a key and creates no credential.
 * Whether to go on is the caller's: throw from `onCheck` to stop, return to go on. A check that could not
 * be read is reported (`error`), not decided here.
 *
 * `check` has the shape of packages/check's `checkBeforePaying(input, data)` with `data` bound; only the
 * fields named below are read, so this file does not import packages/check.
 */

/** The input of packages/check checkBeforePaying. */
export interface CheckInputLike {
  url: string;
  chain?: string;
  payTo?: string;
}

/** The fields of packages/check CheckResult this adapter passes on; the full result is passed through untouched. */
export interface CheckResultLike {
  found: boolean;
  summary: string;
  payTo?: { asked: string; recordedByVet402: string[]; sameAsRecorded: boolean } | null;
}

export type CheckFn<R extends CheckResultLike = CheckResultLike> = (input: CheckInputLike) => Promise<R>;

/** What mppx's PreparedPayment exposes before signing (Mppx.d.ts, PreparedPayment). */
export interface PreparedLike {
  challenge: { id?: string; method: string; intent: string; request: unknown; expires?: string | undefined };
  createCredential: (...args: never[]) => Promise<string>;
}

export interface PreparerLike<P extends PreparedLike> {
  preparePayment: (response: Response, options?: { request?: RequestInit | undefined }) => Promise<P>;
}

export interface PaymentCheckEvent<R extends CheckResultLike = CheckResultLike> {
  url: string;
  /** The selected challenge, as it will be signed. */
  method: string;
  intent: string;
  challengeId: string | null;
  /** rank.json's chain name ("tempo" for Tempo mainnet), or null when vet402 does not buy on that chain. */
  chain: string | null;
  chainId: number | null;
  payTo: string | null;
  amount: string | null;
  currency: string | null;
  check: R | null;
  /** Set when the check could not be read (network, parse). */
  error: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : typeof v === "number" ? String(v) : null);

/** The selected challenge's payment facts. Tempo mainnet (chainId 4217) maps to "tempo". */
export function offerOf(challenge: PreparedLike["challenge"]): Pick<PaymentCheckEvent, "method" | "intent" | "challengeId" | "chain" | "chainId" | "payTo" | "amount" | "currency"> {
  const req = (typeof challenge.request === "object" && challenge.request !== null ? challenge.request : {}) as Record<string, unknown>;
  const md = (typeof req.methodDetails === "object" && req.methodDetails !== null ? req.methodDetails : {}) as Record<string, unknown>;
  const chainId = typeof md.chainId === "number" ? md.chainId : typeof md.chainId === "string" && /^\d+$/.test(md.chainId) ? Number(md.chainId) : null;
  const chain = challenge.method === "tempo" && chainId === 4217 ? "tempo" : null;
  return {
    method: challenge.method,
    intent: challenge.intent,
    challengeId: str(challenge.id),
    chain,
    chainId,
    payTo: str(req.recipient),
    amount: str(req.amount),
    currency: str(req.currency),
  };
}

/**
 * preparePayment, then the check on the selected challenge, then `onCheck`. Returns the prepared payment
 * (no credential created) when `onCheck` returns; rejects with what `onCheck` threw otherwise.
 */
export async function preparePaymentWithCheck<P extends PreparedLike, R extends CheckResultLike>(
  mppx: PreparerLike<P>,
  response: Response,
  opts: { url: string; request?: RequestInit; check: CheckFn<R>; onCheck: (e: PaymentCheckEvent<R>) => void | Promise<void> },
): Promise<P> {
  const prepared = await mppx.preparePayment(response, opts.request ? { request: opts.request } : undefined);
  const offer = offerOf(prepared.challenge);
  const event: PaymentCheckEvent<R> = { url: opts.url, ...offer, check: null, error: null };
  try {
    event.check = await opts.check({ url: opts.url, ...(offer.chain ? { chain: offer.chain } : {}), ...(offer.payTo ? { payTo: offer.payTo } : {}) });
  } catch (e) {
    event.error = e instanceof Error ? e.message : String(e);
  }
  await opts.onCheck(event);
  return prepared;
}
