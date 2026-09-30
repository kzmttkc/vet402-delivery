/**
 * One gate-1 purchase: unpaid request -> record the 402 -> checks -> (sign -> read back -> send)
 * -> wait for settlement -> record the response.
 *
 * Every refusal happens before `createPayment` is called; that function is the only place a
 * signature can come from.
 */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { atomicToUsdc } from "./constants.js";
import { checkAccept, normalizeAccept, pickSolanaAccept, type Budget, type Refusal, type SolAccept } from "./guard.js";
import type { OnChain } from "./chain.js";
import type { TxCheck } from "./txcheck.js";

const parser = new x402HTTPClient(new x402Client());

/** Largest unpaid 402 body read by probe402. */
const PROBE_MAX_BODY_BYTES = 1_000_000;

export interface Probe402 {
  status: number | null;
  contentType: string | null;
  x402Version: number | null;
  accepts: SolAccept[];
  paymentRequired: PaymentRequired | null;
  error?: string;
}

function headerGetter(h: Headers) {
  return (n: string) => h.get(n);
}

export async function probe402(url: string, fetchImpl: typeof fetch): Promise<Probe402> {
  let res: Response;
  try {
    res = await fetchImpl(url, { method: "GET", headers: { accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    return { status: null, contentType: null, x402Version: null, accepts: [], paymentRequired: null, error: `fetch: ${(e as Error).message}`.slice(0, 200) };
  }
  const contentType = res.headers.get("content-type");
  if (res.status !== 402) {
    await res.body?.cancel().catch(() => {});
    return { status: res.status, contentType, x402Version: null, accepts: [], paymentRequired: null };
  }
  let body: unknown;
  try {
    // A 402 body is a few KB; one above PROBE_MAX_BODY_BYTES is not read further (only its headers count).
    const b = await readBody(res, PROBE_MAX_BODY_BYTES);
    body = b.truncated ? undefined : JSON.parse(new TextDecoder().decode(b.bytes));
  } catch {
    body = undefined;
  }
  try {
    const pr = parser.getPaymentRequiredResponse(headerGetter(res.headers), body);
    const accepts = (pr.accepts as unknown as Record<string, unknown>[]).map(normalizeAccept);
    return { status: 402, contentType, x402Version: pr.x402Version, accepts, paymentRequired: pr };
  } catch (e) {
    return { status: 402, contentType, x402Version: null, accepts: [], paymentRequired: null, error: `unparseable 402: ${(e as Error).message}`.slice(0, 200) };
  }
}

export interface PlanEntry {
  host: string;
  requestUrl: string;
  exampleInput: Record<string, string> | null;
  /** From the unpaid 402 recorded at plan time: the lock. */
  lock: { payTo: string; amount: string; asset: string; network: string; feePayer: string };
}

export interface CreatedPayment {
  headers: Record<string, string>;
  txBase64: string;
}

export interface PayDeps {
  fetch: typeof fetch;
  payer: string;
  budget: Budget;
  /** Builds and signs the x402 payment for exactly `accept`. The only signer entry point. */
  createPayment: (pr: PaymentRequired, accept: SolAccept) => Promise<CreatedPayment>;
  checkTx: (txBase64: string, accept: SolAccept, payer: string) => Promise<TxCheck>;
  readBalances: () => Promise<{ lamports: bigint; usdcAtomic: bigint }>;
  waitForSettlement: (signature: string | null, memo: string | null, payTo: string) => Promise<OnChain | null>;
  ownAddresses?: string[];
  /**
   * Dry run: build and read back the transaction (signed by `signerAddress`, a throwaway key),
   * then stop. Nothing is sent to the seller.
   */
  dryRun?: boolean;
  /** Address that signs the transaction (the payer when live; a throwaway key in a dry run). */
  signerAddress?: string;
  /**
   * Optional delivery judgement on the paid response (full body). When absent, delivered =
   * 2xx and a non-empty body (gate 1). Never affects whether or what is paid.
   */
  judge?: (d: { status: number; contentType: string | null; bodyText: string }) => DeliveryJudgementLike;
  /**
   * Optional, for a caller that hands the answer on (proxy buy): read at most this many bytes of the paid
   * answer (unset: the whole answer, as before), and receive them as read. Never affects whether or what is paid.
   */
  maxBodyBytes?: number;
  onBody?: (bytes: Uint8Array, truncated: boolean) => void;
}

export interface DeliveryJudgementLike {
  delivered: boolean;
  reason: string;
  summary: string;
  missingKeys: string[];
  note?: string;
}

export interface PurchaseRecord {
  host: string;
  requestUrl: string;
  probe: { status: number | null; x402Version: number | null; payTo: string | null; amount: string | null; asset: string | null; feePayer: string | null; error?: string };
  outcome: "refused" | "not_sent" | "would_pay" | "sent";
  refusal?: Refusal;
  priceUsdc?: string;
  memo?: string | null;
  settlementHeader?: { success?: boolean; transaction?: string; network?: string; errorReason?: string } | null;
  signature?: string | null;
  onChain?: OnChain | null;
  settled?: boolean;
  response?: { status: number | null; contentType: string | null; first300: string | null; error?: string };
  delivered?: boolean;
  judgement?: DeliveryJudgementLike;
  solBefore?: string;
  solAfter?: string;
  solDecreased?: boolean;
}

function refused(base: Omit<PurchaseRecord, "outcome">, r: Refusal): PurchaseRecord {
  return { ...base, outcome: "refused", refusal: r };
}

export async function payOne(entry: PlanEntry, deps: PayDeps): Promise<PurchaseRecord> {
  const p = await probe402(entry.requestUrl, deps.fetch);
  const accept = pickSolanaAccept(p.accepts, entry.lock.payTo);
  const base: Omit<PurchaseRecord, "outcome"> = {
    host: entry.host,
    requestUrl: entry.requestUrl,
    probe: {
      status: p.status,
      x402Version: p.x402Version,
      payTo: accept?.payTo ?? null,
      amount: accept?.amount ?? null,
      asset: accept?.asset ?? null,
      feePayer: typeof accept?.extra?.feePayer === "string" ? accept.extra.feePayer : null,
      ...(p.error ? { error: p.error } : {}),
    },
  };
  if (p.status !== 402 || !p.paymentRequired) {
    return refused(base, { refused: "no_solana_accept", detail: `unpaid request returned ${p.status ?? "no response"}${p.error ? `: ${p.error}` : ""}` });
  }
  const r = checkAccept(accept, {
    payer: deps.payer,
    lockedPayTo: entry.lock.payTo,
    lockedAmount: entry.lock.amount,
    ...(deps.ownAddresses ? { ownAddresses: deps.ownAddresses } : {}),
  });
  if (r) return refused(base, r);
  const a = accept!;
  if (a.extra?.feePayer !== entry.lock.feePayer) {
    // A different facilitator than the one recorded: still not vet402 (checked above), but note it.
    base.probe.error = `feePayer changed since plan: ${String(a.extra?.feePayer)} (plan ${entry.lock.feePayer})`;
  }

  let before: { lamports: bigint; usdcAtomic: bigint };
  try {
    before = await deps.readBalances();
  } catch (e) {
    return refused(base, { refused: "ledger_unreadable", detail: `cannot read balances: ${(e as Error).message}`.slice(0, 200) });
  }
  const res = deps.budget.reserve(BigInt(a.amount), entry.host, before.usdcAtomic);
  if ("refused" in res) return refused(base, res);

  // ---- from here a signature may exist ----
  let created: CreatedPayment;
  try {
    created = await deps.createPayment(p.paymentRequired, a);
  } catch (e) {
    deps.budget.release(res.id);
    return { ...base, outcome: "not_sent", refusal: { refused: "tx_check_failed", detail: `payload not created: ${(e as Error).message}`.slice(0, 300) } };
  }
  const tc = await deps.checkTx(created.txBase64, a, deps.signerAddress ?? deps.payer);
  if (!tc.ok) {
    deps.budget.release(res.id);
    return { ...base, outcome: "not_sent", refusal: { refused: "tx_check_failed", detail: tc.detail } };
  }
  if (deps.dryRun) {
    // Keep the reservation in the (in-memory) dry-run budget so the cumulative cap is simulated.
    deps.budget.commit(res.id);
    return { ...base, outcome: "would_pay", priceUsdc: atomicToUsdc(a.amount), memo: tc.facts.memo };
  }
  deps.budget.commit(res.id);

  const rec: PurchaseRecord = { ...base, outcome: "sent", priceUsdc: atomicToUsdc(a.amount), memo: tc.facts.memo, solBefore: before.lamports.toString() };
  let paid: Response | null = null;
  try {
    paid = await deps.fetch(entry.requestUrl, {
      method: "GET",
      headers: { accept: "application/json", ...created.headers },
      redirect: "manual",
      signal: AbortSignal.timeout(90_000),
    });
  } catch (e) {
    rec.response = { status: null, contentType: null, first300: null, error: `fetch: ${(e as Error).message}`.slice(0, 200) };
  }
  if (paid) {
    let text = "";
    try {
      const body = await readBody(paid, deps.maxBodyBytes);
      // The same UTF-8 decoding as Response.text(), from the bytes that were read.
      text = new TextDecoder().decode(body.bytes);
      try {
        deps.onBody?.(body.bytes, body.truncated);
      } catch {
        // a caller's hook must not change the record of a sent payment
      }
    } catch (e) {
      rec.response = { status: paid.status, contentType: paid.headers.get("content-type"), first300: null, error: `body: ${(e as Error).message}` };
    }
    rec.response ??= { status: paid.status, contentType: paid.headers.get("content-type"), first300: text.slice(0, 300) };
    try {
      const s = parser.getPaymentSettleResponse(headerGetter(paid.headers)) as { success?: boolean; transaction?: string; network?: string; errorReason?: string };
      rec.settlementHeader = { success: s.success, transaction: s.transaction, network: s.network, ...(s.errorReason ? { errorReason: s.errorReason } : {}) };
    } catch {
      rec.settlementHeader = null;
    }
    if (deps.judge && rec.response.first300 !== null) {
      rec.judgement = deps.judge({ status: paid.status, contentType: paid.headers.get("content-type"), bodyText: text });
      rec.delivered = rec.judgement.delivered;
    } else {
      rec.delivered = paid.status >= 200 && paid.status < 300 && text.trim().length > 0;
    }
  }
  const sigFromHeader = rec.settlementHeader?.transaction && /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(rec.settlementHeader.transaction) ? rec.settlementHeader.transaction : null;
  rec.onChain = await deps.waitForSettlement(sigFromHeader, tc.facts.memo, a.payTo);
  rec.signature = rec.onChain?.signature ?? sigFromHeader;
  rec.settled =
    !!rec.onChain?.found && rec.onChain.err === null && rec.onChain.payToDeltaAtomic === a.amount && rec.onChain.payerDeltaAtomic === `-${a.amount}`;
  try {
    const after = await deps.readBalances();
    rec.solAfter = after.lamports.toString();
    rec.solDecreased = after.lamports < before.lamports;
  } catch {
    /* recorded as unknown */
  }
  return rec;
}

/** The paid answer's bytes: all of them when `max` is unset (Response.arrayBuffer), else at most `max`. */
async function readBody(res: Response, max: number | undefined): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (max === undefined) return { bytes: new Uint8Array(await res.arrayBuffer()), truncated: false };
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.byteLength > max) {
      chunks.push(value.subarray(0, max - n));
      await reader.cancel().catch(() => undefined);
      return { bytes: Buffer.concat(chunks), truncated: true };
    }
    n += value.byteLength;
    chunks.push(value);
  }
  return { bytes: Buffer.concat(chunks), truncated: false };
}
