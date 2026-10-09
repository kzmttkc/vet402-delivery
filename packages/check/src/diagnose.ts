/**
 * diagnose_failed_payment: a buyer's own x402 payment that did not bring an answer, read from chain and set
 * next to vet402's purchases from the same seller at about the same time.
 *
 *   1. Read the payment from public RPC (Solana or Base): did it settle, to which payTo, how much, which
 *      asset, when. Nothing is signed or sent.
 *   2. Classify the buyer's attempt with vet402's own fault rules (src/rank/classify.ts, imported, not copied).
 *   3. Put it next to vet402's purchases from the same seller on the same chain within 24 hours (rank.json
 *      lists the newest few per seller; when none fall in the window, the nearest are shown).
 *
 * The answer is seller_side only when every one of these holds: the payment settled on chain, to a payTo
 * vet402 paid this seller, in an asset vet402 paid it in and not below the least vet402 paid; the buyer got an
 * HTTP status that vet402's rules put on the seller after a settled payment; rank.json's list of the seller's
 * newest purchases reaches back past the start of the window; vet402's own paid purchases from the seller in
 * the window also came back with no answer, with none delivered; and no signed record of those days (other
 * than the payment itself) shows a delivered purchase. Anything less is undetermined, never seller_side: a seller is not named on a guess.
 * buyer_side only for a payment that failed on chain because the paying account lacked the funds.
 * facilitator_side only for a payment that failed on chain for another reason while vet402's purchases in the
 * window failed at the payment step too (rule payment_tx_rejected).
 *
 * For seller_side, an evidence pack (JSON and Markdown) the buyer can hand to the seller. It is not sent.
 */
import type { Rpc } from "../../../src/chain.js";
import { jsonRpc } from "../../../src/chain.js";
import { classifyFailure, ruleById } from "../../../src/rank/classify.js";
import type { Attempt as RankAttempt } from "../../../src/rank/types.js";
import { DEFAULT_RPC } from "../../../src/receipt/chain.js";
import { explorerFor, lookup, NETWORK_OF, PAID_SELLER_RULES, readRecordsIndex, recordedPayments } from "./check.js";
import { listedPurchases, type PurchaseRow } from "./reasons.js";
import { PUBLIC_SITE_URL, type PublicData } from "./sources.js";

export type DiagnoseFault = "seller_side" | "facilitator_side" | "buyer_side" | "undetermined";
export const DIAGNOSE_FAULTS: readonly DiagnoseFault[] = ["seller_side", "facilitator_side", "buyer_side", "undetermined"];

export interface DiagnoseInput {
  /** The payment's transaction: a Solana signature or a Base tx hash. */
  tx: string;
  /** The URL that was paid. */
  url: string;
  /** solana or base. Default: from the shape of tx. */
  chain?: string;
  /** The HTTP status the seller answered after the payment (500, 402, ...). Without it the answer is undetermined. */
  status?: number;
}

export interface DiagnoseOptions {
  /** RPC per CAIP-2 network. Default: SOLANA_RPC_URL, BASE_RPC_URL or the public endpoints. */
  rpcFor?: (network: string) => Rpc;
  /** Milliseconds since the epoch, for the evidence pack's date. Default: now. */
  now?: number;
}

export interface DiagnoseReason {
  code: string;
  detail: string;
}

export interface ChainPayment {
  chain: "solana" | "base";
  network: string;
  tx: string;
  explorer: string | null;
  /** ok: the transaction was read; not_found: the RPC has no such transaction; rpc_error: the RPC could not be read. */
  read: "ok" | "not_found" | "rpc_error";
  /** true: succeeded with a token transfer; false: failed on chain; null: not read or no transfer found. */
  settled: boolean | null;
  /** The on-chain error of a failed transaction, as the RPC gives it. */
  error: string | null;
  payer: string | null;
  payTo: string | null;
  amount: string | null;
  asset: string | null;
  /** Block time, ISO. */
  at: string | null;
  /** Other transfers in the same transaction (fees, splits). */
  otherTransfers: { from: string | null; to: string; amount: string; asset: string }[];
}

export interface EvidencePack {
  kind: "vet402-diagnose-evidence";
  version: 0;
  preparedAt: string;
  seller: { url: string; host: string; sellerPage: string | null };
  payment: { chain: string; tx: string; explorer: string | null; payer: string | null; payTo: string | null; amount: string | null; asset: string | null; at: string | null };
  /** The HTTP status the buyer reported (not observed by vet402). */
  answerSeen: { httpStatus: number | null };
  rule: { id: string; text: string } | null;
  vet402Purchases: { at: string; chain: string; url: string; result: string; httpStatus: number | null; tx: string | null; explorer: string | null }[];
  vet402Records: { id: string; verdict: string; json: string; page: string }[];
  readFrom: string[];
  note: string;
}

export interface DiagnoseResult {
  kind: "vet402-diagnose";
  version: 0;
  fault: DiagnoseFault;
  /** Why, in order: each a code and one English sentence. */
  reasons: DiagnoseReason[];
  asked: { tx: string; url: string; host: string; chain: string | null; status: number | null };
  payment: ChainPayment | null;
  /** vet402's fault rule for the buyer's attempt (src/rank/classify.ts), when the payment settled and a status was given. */
  rule: { id: string; fault: string; text: string } | null;
  seller: { keys: string[]; payTosRecorded: string[]; payToRecorded: boolean | null; sellerPage: string | null };
  vet402: {
    window: { from: string; to: string } | null;
    /** vet402's purchases from the seller on the same chain within 24 hours of the payment (the payment itself left out). */
    inWindow: PurchaseRow[];
    /** When none are in the window: the nearest ones rank.json lists. */
    nearest: PurchaseRow[];
    records: { id: string; day: string; verdict: string; json: string; page: string }[];
  };
  evidence: { json: EvidencePack; markdown: string } | null;
  notes: string[];
}

const WINDOW_MS = 24 * 3600_000;
const SOLANA_SIG = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** solana or base, from the input or the shape of the tx. */
export function chainOfTx(tx: string, chain?: string): "solana" | "base" {
  const c = chain?.trim().toLowerCase();
  if (c) {
    if (c === "solana" || c === NETWORK_OF.solana!.toLowerCase()) {
      if (!SOLANA_SIG.test(tx)) throw new Error(`${tx}: not a Solana transaction signature`);
      return "solana";
    }
    if (c === "base" || c === "eip155:8453") {
      if (!EVM_HASH.test(tx)) throw new Error(`${tx}: not a Base transaction hash (0x and 64 hex digits)`);
      return "base";
    }
    throw new Error(`${chain}: diagnose reads Solana and Base; use solana or base`);
  }
  if (EVM_HASH.test(tx)) return "base";
  if (SOLANA_SIG.test(tx)) return "solana";
  throw new Error(`${tx}: neither a Solana signature nor a Base tx hash`);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function emptyPayment(chain: "solana" | "base", tx: string, read: ChainPayment["read"]): ChainPayment {
  return { chain, network: NETWORK_OF[chain]!, tx, explorer: explorerFor(chain, tx), read, settled: null, error: null, payer: null, payTo: null, amount: null, asset: null, at: null, otherTransfers: [] };
}

/** Read a Solana payment: token balance changes per owner and mint, the error, the block time. */
export async function readSolanaPayment(rpc: Rpc, tx: string): Promise<ChainPayment> {
  const raw = await rpc("getTransaction", [tx, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" }]);
  if (!isObj(raw)) return emptyPayment("solana", tx, "not_found");
  const out = emptyPayment("solana", tx, "ok");
  const meta = isObj(raw.meta) ? raw.meta : {};
  out.at = typeof raw.blockTime === "number" ? new Date(raw.blockTime * 1000).toISOString() : null;
  if (meta.err !== null && meta.err !== undefined) {
    out.settled = false;
    out.error = JSON.stringify(meta.err);
    return out;
  }
  const delta = new Map<string, bigint>();
  const add = (list: unknown, sign: bigint) => {
    for (const b of arr(list)) {
      if (!isObj(b) || !str(b.owner) || !str(b.mint) || !isObj(b.uiTokenAmount) || !/^\d+$/.test(String(b.uiTokenAmount.amount))) continue;
      const k = `${b.owner}|${b.mint}`;
      delta.set(k, (delta.get(k) ?? 0n) + sign * BigInt(String(b.uiTokenAmount.amount)));
    }
  };
  add(meta.postTokenBalances, 1n);
  add(meta.preTokenBalances, -1n);
  const moves = [...delta].map(([k, d]) => ({ owner: k.split("|")[0]!, mint: k.split("|")[1]!, d }));
  const received = moves.filter((m) => m.d > 0n).sort((a, b) => (b.d > a.d ? 1 : b.d < a.d ? -1 : 0));
  if (!received.length) {
    out.settled = null;
    return out;
  }
  const top = received[0]!;
  const sender = moves.filter((m) => m.mint === top.mint && m.d < 0n).sort((a, b) => (a.d < b.d ? -1 : 1))[0];
  out.settled = true;
  out.payTo = top.owner;
  out.amount = top.d.toString();
  out.asset = top.mint;
  out.payer = sender?.owner ?? null;
  out.otherTransfers = received.slice(1).map((m) => ({ from: null, to: m.owner, amount: m.d.toString(), asset: m.mint }));
  return out;
}

/** Was a failed Solana payment short of funds? SPL Token error 1 (insufficient funds) on a token instruction. */
export function solanaInsufficientFunds(raw: unknown, error: string | null): boolean {
  if (!error) return false;
  try {
    const e = JSON.parse(error) as unknown;
    if (!isObj(e) || !Array.isArray(e.InstructionError)) return false;
    const [idx, detail] = e.InstructionError as [number, unknown];
    if (!isObj(detail) || detail.Custom !== 1) return false;
    const ix = isObj(raw) && isObj(raw.transaction) && isObj(raw.transaction.message) ? arr(raw.transaction.message.instructions)[idx] : undefined;
    return isObj(ix) && TOKEN_PROGRAMS.has(str(ix.programId) ?? "");
  } catch {
    return false;
  }
}

const topicAddress = (t: unknown): string | null => (typeof t === "string" && /^0x[0-9a-fA-F]{64}$/.test(t) ? `0x${t.slice(26)}`.toLowerCase() : null);

/** Read a Base payment: the receipt's ERC-20 Transfer logs and the block time. */
export async function readBasePayment(rpc: Rpc, tx: string): Promise<ChainPayment> {
  const receipt = await rpc("eth_getTransactionReceipt", [tx]);
  if (!isObj(receipt)) return emptyPayment("base", tx, "not_found");
  const out = emptyPayment("base", tx, "ok");
  const block = str(receipt.blockNumber);
  if (block) {
    try {
      const b = await rpc("eth_getBlockByNumber", [block, false]);
      if (isObj(b) && str(b.timestamp)) out.at = new Date(Number(BigInt(b.timestamp as string)) * 1000).toISOString();
    } catch {
      // the time stays unknown; the window cannot be set
    }
  }
  if (receipt.status !== "0x1") {
    out.settled = false;
    out.error = `receipt status ${String(receipt.status)}`;
    return out;
  }
  const transfers = arr(receipt.logs)
    .filter(isObj)
    .filter((l) => arr(l.topics)[0] === TRANSFER_TOPIC && arr(l.topics).length === 3 && /^0x[0-9a-fA-F]*$/.test(str(l.data) ?? ""))
    .map((l) => ({ from: topicAddress(arr(l.topics)[1]), to: topicAddress(arr(l.topics)[2]) ?? "", amount: BigInt((l.data as string) === "0x" ? "0" : (l.data as string)), asset: (str(l.address) ?? "").toLowerCase() }))
    .filter((t) => t.amount > 0n && t.to)
    .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
  if (!transfers.length) return out;
  const top = transfers[0]!;
  out.settled = true;
  out.payTo = top.to;
  out.payer = top.from;
  out.amount = top.amount.toString();
  out.asset = top.asset;
  out.otherTransfers = transfers.slice(1).map((t) => ({ from: t.from, to: t.to, amount: t.amount.toString(), asset: t.asset }));
  return out;
}

/** The same transaction: Base hashes compared without case, Solana signatures exactly. */
const sameTx = (a: string | null, b: string): boolean => a !== null && (EVM_HASH.test(a) && EVM_HASH.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b);
const sameAddress = (a: string, b: string): boolean => (/^0x[0-9a-f]{40}$/i.test(a) && /^0x[0-9a-f]{40}$/i.test(b) ? a.toLowerCase() === b.toLowerCase() : a === b);
const dayOf = (iso: string): string => iso.slice(0, 10);

function rankAttempt(p: ChainPayment, url: string, status: number): RankAttempt {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    // parsed earlier
  }
  return {
    chain: p.chain,
    source: "diagnose",
    host,
    service: null,
    url,
    payTo: p.payTo,
    expectedPayTo: null,
    at: p.at ?? "",
    tried: true,
    settled: true,
    delivered: false,
    category: "settled_error_status",
    rawReason: `http ${status}`,
    detail: null,
    tx: p.tx,
    priceUsdc: null,
    httpStatus: status,
    declaredMatch: null,
    bodyChecked: false,
    feedbackTx: null,
  };
}

/** Diagnose one failed payment. Reads public RPC and vet402's public record; never throws for chain or record trouble. */
export async function diagnose(input: DiagnoseInput, data: PublicData, opts: DiagnoseOptions = {}): Promise<DiagnoseResult> {
  const tx = input.tx.trim();
  const chain = chainOfTx(tx, input.chain);
  const network = NETWORK_OF[chain]!;
  const u = new URL(input.url.trim());
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${input.url}: not an http(s) URL`);
  const status = input.status ?? null;
  if (status !== null && (!Number.isInteger(status) || status < 100 || status > 599)) throw new Error(`${input.status}: an HTTP status is a number from 100 to 599`);
  const reasons: DiagnoseReason[] = [];
  const notes: string[] = [];
  const say = (code: string, detail: string) => void reasons.push({ code, detail });

  // 1. The payment, from chain.
  const rpcFor = opts.rpcFor ?? ((n: string) => jsonRpc(DEFAULT_RPC[n] ?? ""));
  let payment: ChainPayment;
  let rawSolana: unknown = null;
  try {
    const rpc = rpcFor(network);
    if (chain === "solana") {
      const capture: Rpc = async (m, p) => {
        const r = await rpc(m, p);
        if (m === "getTransaction") rawSolana = r;
        return r;
      };
      payment = await readSolanaPayment(capture, tx);
    } else payment = await readBasePayment(rpc, tx);
  } catch (e) {
    payment = emptyPayment(chain, tx, "rpc_error");
    notes.push(`The ${chain} RPC could not be read: ${e instanceof Error ? e.message.replace(/https?:\/\/\S+/g, "<rpc>") : "error"}`);
  }

  // 2. vet402's record of the seller.
  let keys: string[] = [];
  let payTosRecorded: string[] = [];
  let sellerPage: string | null = null;
  let purchases: PurchaseRow[] = [];
  let indexRaw: unknown = null;
  /** How far back rank.json's `recent` lists reach for this seller on this chain: before it, purchases may be left out. */
  let oldestRecent: string | null = null;
  try {
    const [rankRaw, idx] = await Promise.all([data.rank(), data.recordsIndex()]);
    indexRaw = idx;
    const r = lookup(rankRaw, idx, { url: u.href, chain }, [], [], null);
    keys = r.sellers.map((f) => f.key);
    payTosRecorded = [...new Set(r.sellers.flatMap((f) => f.payTos))];
    sellerPage = r.sellers[0]?.sellerPage ?? null;
    purchases = listedPurchases(rankRaw, new Set(keys)).filter((p) => p.chain === chain && !sameTx(p.tx, tx));
    oldestRecent = oldestRecentAt(rankRaw, new Set(keys), chain);
  } catch (e) {
    notes.push(`vet402's public record could not be read: ${e instanceof Error ? e.message : String(e)}`);
  }
  const payToRecorded = payment.payTo && payTosRecorded.length ? payTosRecorded.some((p) => sameAddress(p, payment.payTo!)) : null;

  const txTime = payment.at ? Date.parse(payment.at) : NaN;
  const window = Number.isFinite(txTime) ? { from: new Date(txTime - WINDOW_MS).toISOString(), to: new Date(txTime + WINDOW_MS).toISOString() } : null;
  const inWindow = window ? purchases.filter((p) => Math.abs(Date.parse(p.at) - txTime) <= WINDOW_MS) : [];
  const nearest = inWindow.length
    ? []
    : Number.isFinite(txTime)
      ? [...purchases].sort((a, b) => Math.abs(Date.parse(a.at) - txTime) - Math.abs(Date.parse(b.at) - txTime)).slice(0, 3)
      : purchases.slice(0, 3);
  const windowDays = window ? new Set([dayOf(window.from), dayOf(payment.at!), dayOf(window.to)]) : new Set<string>();
  let records: DiagnoseResult["vet402"]["records"] = [];
  try {
    if (indexRaw && keys.length) {
      const days = readRecordsIndex(indexRaw).entries.filter((e) => keys.includes(e.seller) && e.network === network && windowDays.has(e.day));
      // The payment being diagnosed is left out when it is one of vet402's own (a record whose payment is this tx).
      // A record that cannot be read stays in: it may be the one that shows a delivery.
      const own = await Promise.all(
        days.map(async (e) => {
          try {
            const raw = (await data.recordJson(e.id)) as { payment?: { transaction?: unknown } };
            return typeof raw?.payment?.transaction === "string" && sameTx(raw.payment.transaction, tx);
          } catch {
            return false;
          }
        }),
      );
      records = days
        .filter((_, i) => !own[i])
        .map((e) => ({ id: e.id, day: e.day, verdict: e.verdict, json: `${PUBLIC_SITE_URL}/records/${e.id}.json`, page: `${PUBLIC_SITE_URL}/records/${e.id}.html` }));
    }
  } catch {
    records = [];
  }
  // What vet402 paid this seller on this chain (signed records, this URL first), for the asset and amount test.
  let paidBefore: Awaited<ReturnType<typeof recordedPayments>>["payments"] = [];
  try {
    if (indexRaw && keys.length) paidBefore = (await recordedPayments(data, indexRaw, new Set(keys), chain, u.href)).payments.filter((p) => !sameTx(p.tx, tx));
  } catch {
    paidBefore = [];
  }

  // 3. The decision. Anything short of the full seller_side test is undetermined.
  let fault: DiagnoseFault = "undetermined";
  let rule: DiagnoseResult["rule"] = null;
  const below = payment.settled === true ? amountBelow(paidBefore, payment, u.href) : null;
  const delivered = inWindow.filter((p) => p.result === "delivered");
  const paidFailed = inWindow.filter((p) => p.fault === "seller" && PAID_SELLER_RULES.has(p.result));
  if (payment.read === "rpc_error") say("tx_not_read", `The ${chain} RPC could not be read, so whether the payment settled is not known.`);
  else if (payment.read === "not_found") say("tx_not_found", `The ${chain} RPC has no transaction ${tx} (not sent, not yet confirmed, or another chain).`);
  else if (payment.settled === false) {
    if (chain === "solana" && solanaInsufficientFunds(rawSolana, payment.error)) {
      fault = "buyer_side";
      say("insufficient_funds", `The payment failed on chain: the paying token account did not hold enough (SPL Token error 1, ${payment.error}). Nothing was paid.`);
    } else if (inWindow.some((p) => p.result === "payment_tx_rejected")) {
      fault = "facilitator_side";
      say("payment_failed_on_chain", `The payment failed on chain (${payment.error}). Nothing was paid.`);
      say("vet402_payment_step_failed_in_window", `vet402's payments to this seller within 24 hours also failed before settling (payment_tx_rejected), the rule vet402 puts on its own side or the facilitator's.`);
    } else say("payment_failed_on_chain", `The payment failed on chain (${payment.error}). Nothing was paid; the cause is not told apart here.`);
  } else if (payment.settled !== true) say("no_transfer_found", "The transaction succeeded but moved no token, so it is not a payment this can read.");
  else if (payToRecorded === false)
    say("payto_differs", `The payment went to ${payment.payTo}, not to a payTo vet402 paid this seller (${payTosRecorded.join(", ")}). Whether it reached this seller cannot be told.`);
  else if (paidBefore.length && payment.asset && !paidBefore.some((p) => sameAddress(p.asset, payment.asset!)))
    say("asset_unseen", `The payment was made in ${payment.asset}, not in an asset vet402 paid this seller in on ${chain} (${[...new Set(paidBefore.map((p) => p.asset))].join(", ")}). Whether it was the payment the seller asked for cannot be told.`);
  else if (below)
    say("amount_below_recorded", `The payment was ${payment.amount}, less than the least vet402 paid for ${below.scope} (${below.min}). The seller may have answered for a payment short of its price.`);
  else if (status === null) say("status_not_given", "The payment settled. Without the HTTP status the seller answered (--status), the failure is not classified.");
  else if (status >= 200 && status <= 299) say("answered_2xx", `The seller answered HTTP ${status}. Whether the body was empty is not known here.`);
  else {
    const c = classifyFailure(rankAttempt(payment, u.href, status));
    const fr = ruleById(c.rule);
    rule = { id: c.rule, fault: c.fault, text: fr?.when ?? "" };
    if (c.fault !== "seller") say(c.rule, `vet402's rule for a settled payment followed by HTTP ${status} is ${c.rule}, not counted against the seller: ${fr?.when ?? ""}`);
    else {
      say(c.rule, `The payment settled on chain${payment.at ? ` at ${payment.at}` : ""} and the seller answered HTTP ${status}: vet402's rule ${c.rule}.`);
      if (payToRecorded === null) say("payto_unknown", "vet402 has no payTo recorded for this seller, so the payee cannot be matched to it.");
      else if (!window) say("time_unknown", "The block time of the payment was not read, so no window of vet402 purchases can be set.");
      else if (delivered.length)
        say(
          "vet402_delivered_in_window",
          `vet402's purchases from this seller within 24 hours came back with an answer ${delivered.length} time${delivered.length === 1 ? "" : "s"} (${delivered.map((p) => p.at).join(", ")}). The failure may be particular to this request.`,
        );
      else if (records.some((r) => r.verdict === "DELIVERED"))
        say(
          "vet402_delivered_record_in_window_days",
          `vet402's signed records of the same days hold a delivered purchase from this seller on ${chain} (${records.filter((r) => r.verdict === "DELIVERED").map((r) => r.id).join(", ")}). The failure may be particular to this request.`,
        );
      else if (oldestRecent === null || Date.parse(window.from) < Date.parse(oldestRecent))
        say(
          "vet402_list_does_not_cover_window",
          `rank.json lists vet402's newest purchases from this seller back to ${oldestRecent ?? "no date"}; the window starts at ${window.from}, so a purchase in it may be left out of the list.`,
        );
      else if (!paidFailed.length)
        say(
          inWindow.length ? "vet402_window_not_paid_failure" : "no_vet402_purchase_in_window",
          inWindow.length
            ? "vet402's purchases from this seller within 24 hours did not settle and fail on the seller's side, so they neither confirm nor rule out the seller."
            : `vet402 lists no purchase from this seller on ${chain} within 24 hours of the payment${nearest[0] ? `; the nearest is ${nearest[0].at} (${nearest[0].result})` : ""}.`,
        );
      else if (payToRecorded === true) {
        fault = "seller_side";
        say(
          "vet402_same_failure_in_window",
          `vet402's own paid purchases from this seller within 24 hours also settled and came back with no answer (${paidFailed.length}: ${paidFailed.map((p) => `${p.at} HTTP ${p.httpStatus ?? "none"}`).join(", ")}), and none was delivered.`,
        );
      }
    }
  }

  const result: DiagnoseResult = {
    kind: "vet402-diagnose",
    version: 0,
    fault,
    reasons,
    asked: { tx, url: u.href, host: u.hostname.toLowerCase(), chain, status },
    payment,
    rule,
    seller: { keys, payTosRecorded, payToRecorded, sellerPage },
    vet402: { window, inWindow, nearest, records },
    evidence: null,
    notes,
  };
  if (fault === "seller_side") result.evidence = evidencePack(result, opts.now ?? Date.now());
  return result;
}

/**
 * How far back rank.json's `recent` lists reach for the seller on this chain. Only the pages (groups) whose
 * chains include it and where the seller was bought on it count: rank.json keeps the newest few purchases per
 * seller per page, so another page's list (Algorand, say) says nothing about this chain. Per page, the oldest
 * purchase listed; across pages, the newest of those (the narrowest reach). Null when no page qualifies.
 */
function oldestRecentAt(rankRaw: unknown, keys: ReadonlySet<string>, chain: string): string | null {
  let reach: string | null = null;
  if (!isObj(rankRaw)) return null;
  for (const g of arr(rankRaw.groups)) {
    if (!isObj(g)) continue;
    const pageChains = arr(g.chains).map(str);
    for (const s of arr(g.ranking)) {
      if (!isObj(s) || !keys.has(str(s.key) ?? "")) continue;
      const recent = arr(s.recent).filter(isObj);
      const boughtHere = (isObj(s.chains) && chain in s.chains) || recent.some((r) => str(r.chain) === chain);
      if (!boughtHere || (pageChains.length && !pageChains.includes(chain) && !recent.some((r) => str(r.chain) === chain))) continue;
      let oldest: string | null = null;
      for (const r of recent) {
        const at = str(r.at);
        if (at && (oldest === null || at < oldest)) oldest = at;
      }
      if (oldest === null) return null; // a page that sells on this chain and lists nothing: the reach is unknown
      if (reach === null || oldest > reach) reach = oldest;
    }
  }
  return reach;
}

/** The least vet402 paid in the payment's asset (for this URL when there are such records, else for the seller), when the payment is below it. */
function amountBelow(paid: { url: string; asset: string; amount: string }[], p: ChainPayment, url: string): { min: string; scope: string } | null {
  if (!p.asset || !p.amount || !/^\d+$/.test(p.amount)) return null;
  const same = paid.filter((x) => sameAddress(x.asset, p.asset!) && /^\d+$/.test(x.amount));
  const forUrl = same.filter((x) => x.url === url);
  const ref = forUrl.length ? forUrl : same;
  if (!ref.length) return null;
  const min = ref.reduce((m, x) => (BigInt(x.amount) < m ? BigInt(x.amount) : m), BigInt(ref[0]!.amount));
  return BigInt(p.amount) < min ? { min: min.toString(), scope: forUrl.length ? "this URL" : "this seller" } : null;
}

/** vet402's rule text, said of the buyer's payment instead of vet402's. */
function buyerRuleText(text: string): string {
  return text.replace(/vet402's payment/g, "the buyer's payment").replace(/^the /, "The ");
}

function evidencePack(r: DiagnoseResult, now: number): { json: EvidencePack; markdown: string } {
  const p = r.payment!;
  const json: EvidencePack = {
    kind: "vet402-diagnose-evidence",
    version: 0,
    preparedAt: new Date(now).toISOString(),
    seller: { url: r.asked.url, host: r.asked.host, sellerPage: r.seller.sellerPage },
    payment: { chain: p.chain, tx: p.tx, explorer: p.explorer, payer: p.payer, payTo: p.payTo, amount: p.amount, asset: p.asset, at: p.at },
    answerSeen: { httpStatus: r.asked.status },
    rule: r.rule ? { id: r.rule.id, text: buyerRuleText(r.rule.text) } : null,
    vet402Purchases: r.vet402.inWindow.map((x) => ({ at: x.at, chain: x.chain, url: x.url, result: x.result, httpStatus: x.httpStatus, tx: x.tx, explorer: x.explorer })),
    vet402Records: r.vet402.records.map((x) => ({ id: x.id, verdict: x.verdict, json: x.json, page: x.page })),
    readFrom: [`${p.chain} RPC (public chain data)`, `${PUBLIC_SITE_URL}/rank.json`],
    note: "Prepared by vet402-check from public chain data and vet402's public record. Nothing was sent to anyone.",
  };
  const line = (x: EvidencePack["vet402Purchases"][number]) => `| ${x.at} | ${x.result} | ${x.httpStatus ?? ""} | ${x.explorer ? `[tx](${x.explorer})` : x.tx ?? ""} |`;
  const markdown = [
    `# Paid x402 call with no answer: ${r.asked.host}`,
    "",
    `- URL: ${r.asked.url}`,
    `- Payment: ${p.explorer ?? p.tx} (${p.chain}), settled ${p.at ?? "at an unknown time"}`,
    `- Paid ${p.amount ?? "?"} (atomic units of ${p.asset ?? "?"}) from ${p.payer ?? "?"} to ${p.payTo ?? "?"}`,
    `- HTTP status reported by the buyer: ${r.asked.status ?? "?"}`,
    json.rule ? `- vet402's rule for this case (${json.rule.id}), said of this payment: ${json.rule.text}` : "",
    "",
    "## vet402's own purchases from this seller within 24 hours",
    "",
    "| Time (UTC) | Result | HTTP | Transaction |",
    "|---|---|---|---|",
    ...json.vet402Purchases.map(line),
    "",
    json.vet402Records.length ? `Signed records of those days: ${json.vet402Records.map((x) => `[${x.id}](${x.page}) (${x.verdict})`).join(", ")}` : "",
    r.seller.sellerPage ? `Every purchase vet402 made from this seller: ${r.seller.sellerPage}` : "",
    "",
    json.note,
    "",
  ]
    .filter((l, i, a) => l !== "" || a[i - 1] !== "")
    .join("\n");
  return { json, markdown };
}

/** The diagnosis as text lines for the command line and the MCP tool. */
export function formatDiagnose(r: DiagnoseResult): string {
  const p = r.payment;
  const out = [`fault: ${r.fault}`];
  for (const x of r.reasons) out.push(`  ${x.code}: ${x.detail}`);
  out.push("");
  if (p)
    out.push(
      `payment: ${p.chain} ${p.tx} read ${p.read}${p.settled === true ? ", settled" : p.settled === false ? ", failed on chain" : ""}${p.at ? ` at ${p.at}` : ""}`,
      ...(p.payTo ? [`  ${p.amount} of ${p.asset} from ${p.payer ?? "?"} to ${p.payTo}${r.seller.payToRecorded === true ? " (a payTo vet402 paid this seller)" : r.seller.payToRecorded === false ? " (not a payTo vet402 paid this seller)" : ""}`] : []),
      ...(p.explorer ? [`  ${p.explorer}`] : []),
    );
  out.push(`seller: ${r.seller.keys.join(", ") || "not in vet402's record"}${r.seller.sellerPage ? `  ${r.seller.sellerPage}` : ""}`);
  if (r.vet402.window) out.push(`vet402 purchases on ${r.asked.chain} from ${r.vet402.window.from} to ${r.vet402.window.to}: ${r.vet402.inWindow.length}`);
  for (const x of r.vet402.inWindow) out.push(`  ${x.at} ${x.result}${x.httpStatus !== null ? ` HTTP ${x.httpStatus}` : ""} ${x.explorer ?? x.tx ?? ""}`.trimEnd());
  if (r.vet402.nearest.length) out.push("nearest vet402 purchases (outside the window):", ...r.vet402.nearest.map((x) => `  ${x.at} ${x.result}${x.httpStatus !== null ? ` HTTP ${x.httpStatus}` : ""} ${x.explorer ?? x.tx ?? ""}`.trimEnd()));
  for (const x of r.vet402.records) out.push(`  signed record ${x.id} ${x.verdict} ${x.page}`);
  for (const n of r.notes) out.push(`note: ${n}`);
  if (r.evidence) out.push("", "evidence for the seller (not sent):", "", r.evidence.markdown);
  return out.join("\n");
}
