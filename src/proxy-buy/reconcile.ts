/**
 * The reconciler: settles every purchase whose request stopped before it was over (a function that hit its time
 * limit or crashed, a settlement whose outcome was unknown, a seller payment not seen yet, a refund not confirmed),
 * by reading the chains. It decides only on proof:
 *   - the agent's payment landed (the receive wallet up by exactly the total) and vet402 never paid the seller, or
 *     vet402's payment to the seller is dead or failed on chain -> refund (once; a new refund attempt only after the
 *     previous one is proven dead, at most MAX_REFUND_ATTEMPTS, then "stuck" and reported);
 *   - the agent's payment is dead or failed -> no charge, closed;
 *   - vet402's payment to the seller landed -> closed, no refund;
 *   - anything that cannot be told yet stays as it is.
 * Every change is guarded by the state it was read in and its updated_at (a refund by the transaction it was read
 * with), so two reconcilers, or a reconciler and a request, never act twice on one purchase.
 * Actions starting with "ALERT" need a human (the cron logs them).
 */
import { CAPPED_RECHECK_MS, OPEN_ALERT_MS, RECONCILE_MAX_TX_READS, TEMPO_REFUND_FEE_BOUND_ATOMIC } from "./constants.js";
import { tempoTxFate, type Fate, type TempoFateFacts } from "./fate.js";
import { refundOwed, windowPatch, type Common } from "./flow.js";
import { redact } from "./reasons.js";
import { ACCOUNT_CREATION_WAIT } from "./refund.js";
import { REFUND_SOL_MIN_LAMPORTS, type SolanaSide } from "./solana.js";
import type { PurchaseRecord, PurchaseRow } from "./store.js";
import { KNOWN_TX_WINDOW_MS, type TempoSide } from "./tempo.js";

export interface ReconcileContext extends Common {
  solana?: SolanaSide;
  tempo?: TempoSide;
  /** At most this many purchases per run (the request gate uses a few; the cron and the script more). */
  limit?: number;
  /** Chain transaction reads for the whole run (default RECONCILE_MAX_TX_READS). */
  maxTxReads?: number;
  /** Closed purchases with a seller payment not seen yet, looked at per run (default 10). */
  sellerOpenLimit?: number;
  /** Read the payer wallets and report what would refuse new purchases (default true; the request gate skips it). */
  walletCheck?: boolean;
  /** Keep ALERTs in pb_alert and resolve the ones gone (default true). */
  recordAlerts?: boolean;
}

export interface ReconcileAction {
  id: string;
  chain: string;
  state: string;
  action: string;
}

type Facts = Record<string, unknown>;
const obj = (v: unknown): Facts | null => (v && typeof v === "object" ? (v as Facts) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function fallbackRecord(row: PurchaseRow, now: Date): PurchaseRecord {
  // Defaults under whatever record the row has (a record written by an older step can lack fields).
  const d: PurchaseRecord = {
      id: row.id,
      chain: row.chain,
      at: now.toISOString(),
      target: "",
      seller: { host: row.seller_host, payTo: "", priceAtomic: row.seller_amount },
      feeAtomic: (BigInt(row.total) - BigInt(row.seller_amount)).toString(),
      totalAtomic: row.total,
      customer: { tx: null, payer: null, confirmed: false },
      sellerPayment: null,
      answer: null,
      outcome: "in_progress",
      reason: null,
      refund: "none",
  };
  return { ...d, ...(row.record ?? {}), customer: { ...d.customer, ...(row.record?.customer ?? {}) } };
}

/** One reconcile run: the chain reads it may still make, and what the current row's looks found. */
interface Run {
  budget: { reads: number };
  /** The run's read budget ran out: stop taking rows. */
  exhausted: boolean;
  /** This row's search was cut short for a reason of its own: look again only after CAPPED_RECHECK_MS. */
  capped: boolean;
  /** This row has nothing to do before this time (e.g. the next UTC day). */
  nextAt: Date | null;
}

/** Where a transaction's facts are kept, to add the slot its blockhash was first seen expired. */
type Keep = { key: "agent" | "seller" } | { refundTx: string | null };

async function txFate(ctx: ReconcileContext, run: Run, row: PurchaseRow, f: Facts | null, keep: Keep): Promise<Fate> {
  if (!f) return { fate: "pending" };
  if (row.chain === "solana" && ctx.solana) {
    const messageHash = str(f.messageHash);
    const blockhash = str(f.blockhash);
    const account = str(f.account);
    if (!messageHash || !blockhash || !account) return { fate: "pending" };
    const out = await ctx.solana.fate({
      messageHash,
      blockhash,
      account,
      ...(typeof f.since === "number" ? { since: f.since } : {}),
      ...(typeof f.minSlot === "number" ? { minSlot: f.minSlot } : {}),
      ...(typeof f.expiredSlot === "number" ? { expiredSlot: f.expiredSlot } : {}),
      ...(typeof f.lastValidBlockHeight === "number" ? { lastValidBlockHeight: f.lastValidBlockHeight } : {}),
      ...(str(f.cursor) ? { cursor: str(f.cursor)! } : {}),
      ...(typeof f.pastAnchorUntil === "number" ? { pastAnchorUntil: f.pastAnchorUntil } : {}),
      ...(typeof f.anchor === "string" || f.anchor === null ? { anchor: f.anchor as string | null } : {}),
      ...(str(f.signature) ? { signature: str(f.signature)! } : {}),
      deadline: ctx.deadline,
      budget: run.budget,
    });
    if (out.fate === "pending") {
      if (out.capped === "run_budget") run.exhausted = true;
      else if (out.capped) run.capped = true;
      const patch = windowPatch(f, out);
      if (patch) {
        if ("key" in keep) await ctx.store.mergeFacts(row.id, keep.key, patch);
        else await ctx.store.refundMergeFacts(row.id, keep.refundTx, patch);
      }
    }
    return out;
  }
  if (row.chain === "tempo" && ctx.tempo) {
    const facts = f as unknown as TempoFateFacts;
    const known = facts.sponsored ? await ctx.store.knownTxs("tempo", row.id, new Date(ctx.now().getTime() - KNOWN_TX_WINDOW_MS)) : [];
    const out = await tempoTxFate(ctx.tempo.reads, { ...facts, memo: facts.memo ?? null, known });
    if (out.fate === "pending" && out.capped) run.capped = true;
    return out;
  }
  return { fate: "pending" };
}

/** A "pending" whose search was cut short needs a human: said as an ALERT (a run out of reads just waits). */
const waiting = (what: string, f: Fate) =>
  f.fate === "pending" && f.capped && f.capped !== "run_budget" ? `ALERT waiting: ${what}; the chain search was cut short (${f.capped})` : `waiting: ${what}`;

/**
 * What would refuse every new purchase, said as an ALERT on every run while it lasts: the payer's balance below the
 * floor the books explain (chain_spend_exceeds_ledger), a floor that cannot cover one purchase's worst case
 * (insufficient_balance), and too little SOL for the refund fees and account rent of the open purchases plus one
 * (refund_fee_unavailable).
 */
async function walletAlerts(ctx: ReconcileContext): Promise<ReconcileAction[]> {
  const out: ReconcileAction[] = [];
  const say = (chain: string, action: string) => out.push({ id: `wallet:${chain}`, chain, state: "wallet", action });
  if (ctx.solana) {
    try {
      const bal = await ctx.solana.pay.readBalances();
      const w = await ctx.store.wallet("solana");
      const open = await ctx.store.openCount("solana");
      if (w && bal.usdcAtomic < w.floor) say("solana", `ALERT chain_spend_exceeds_ledger: payer balance ${bal.usdcAtomic} < floor ${w.floor}; money left the payer outside proxy buy, every purchase is refused`);
      if (w && w.floor < ctx.maxRefund) say("solana", `ALERT insufficient_balance: floor ${w.floor} < one purchase's worst case ${ctx.maxRefund}; top up the payer`);
      const needSol = REFUND_SOL_MIN_LAMPORTS * BigInt(open + 1);
      if (bal.lamports < needSol) say("solana", `ALERT refund_fee_unavailable: payer SOL ${bal.lamports} lamports < ${needSol} for ${open} open purchase(s) and one more`);
    } catch {
      say("solana", "wallet: the payer's balance could not be read this run");
    }
  }
  if (ctx.tempo) {
    try {
      const bal = await ctx.tempo.pay.balance();
      const w = await ctx.store.wallet("tempo");
      if (w && bal < w.floor) say("tempo", `ALERT chain_spend_exceeds_ledger: payer balance ${bal} < floor ${w.floor}; every purchase is refused`);
      if (w && w.floor < ctx.maxRefund + TEMPO_REFUND_FEE_BOUND_ATOMIC) say("tempo", `ALERT insufficient_balance: floor ${w.floor} < one purchase's worst case ${ctx.maxRefund + TEMPO_REFUND_FEE_BOUND_ATOMIC}; top up the payer`);
    } catch {
      say("tempo", "wallet: the payer's balance could not be read this run");
    }
  }
  return out;
}

const nextUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));

export async function reconcile(ctx: ReconcileContext): Promise<ReconcileAction[]> {
  const { store } = ctx;
  const out: ReconcileAction[] = [];
  const budget = { reads: ctx.maxTxReads ?? RECONCILE_MAX_TX_READS };
  await store.pruneCounters(new Date(ctx.now().getTime() - 2 * 86_400_000)).catch(() => undefined);
  /** Everything looked at this run (purchase ids, `wallet:<chain>`): its ALERTs are kept, the ones gone are resolved. */
  const looked = new Map<string, string>();
  if (ctx.walletCheck !== false) {
    out.push(...(await walletAlerts(ctx)));
    if (ctx.solana) looked.set("wallet:solana", "solana");
    if (ctx.tempo) looked.set("wallet:tempo", "tempo");
  }
  const rows = await store.stale(ctx.now(), ctx.staleMs, ctx.limit ?? 50);
  let exhausted = false;
  for (const row of rows) {
    if (Date.now() >= ctx.deadline || exhausted) break;
    const note = (action: string) => out.push({ id: row.id, chain: row.chain, state: row.state, action });
    const run: Run = { budget, exhausted: false, capped: false, nextAt: null };
    looked.set(row.id, row.chain);
    let last = "";
    try {
      await one(ctx, run, row, (a) => {
        last = a;
        note(a);
      });
    } catch (e) {
      last = "error";
      note(`error, will retry: ${redact(String((e as Error).message ?? e), 120)}`);
    }
    exhausted = run.exhausted;
    // A look this run could not finish (its read budget ran out) says nothing about the alerts: they stay as they are.
    if (run.exhausted) looked.delete(row.id);
    // Looked at: to the back of the queue; a search cut short is looked at again only after a while.
    const next = run.capped ? new Date(ctx.now().getTime() + CAPPED_RECHECK_MS) : (run.nextAt ?? ctx.now());
    await store.touch(row.id, next).catch(() => undefined);
    // Still open long after it started: a human looks.
    const age = ctx.now().getTime() - Date.parse(row.created_at);
    if (age > OPEN_ALERT_MS && !last.startsWith("ALERT") && (await store.get(row.id).catch(() => null))?.state !== "done" && !/^released/.test(last)) {
      note(`ALERT open for ${Math.floor(age / 60_000)} minutes (${row.state}): needs a human if it does not close`);
    }
  }
  // Closed purchases whose payment to the seller was not seen on chain yet: once it is (landed or dead), it no
  // longer holds back the wallet floor.
  if (!exhausted && Date.now() < ctx.deadline) {
    for (const row of await store.sellerOpen(ctx.sellerOpenLimit ?? 10)) {
      if (Date.now() >= ctx.deadline) break;
      const run: Run = { budget, exhausted: false, capped: false, nextAt: null };
      looked.set(row.id, row.chain);
      const seller = obj(row.facts.seller);
      const f: Fate = seller ? await txFate(ctx, run, row, seller, { key: "seller" }) : { fate: "dead" };
      const note = (action: string) => out.push({ id: row.id, chain: row.chain, state: row.state, action });
      if (f.fate === "pending") {
        // Long unseen, or a search that cannot finish: a human looks (with the reason when there is one).
        const age = ctx.now().getTime() - Date.parse(row.updated_at);
        const what = "a delivered purchase's seller payment is not seen on chain yet";
        note(
          f.capped || age <= OPEN_ALERT_MS
            ? waiting(what, f)
            : `ALERT waiting: ${what}; closed ${Math.floor(age / 60_000)} minutes ago (it holds back the wallet floor until seen)`,
        );
        if (run.exhausted) {
          looked.delete(row.id);
          break;
        }
        continue;
      }
      const rec = row.record ? { ...row.record, sellerPayment: f.fate === "landed" ? { tx: f.tx, settled: true } : { tx: null, settled: false } } : null;
      if (f.fate === "landed" && !(await store.bindTx(row.chain, f.tx, row.id, "seller", ctx.now()))) {
        note(`ALERT seller transaction ${f.tx} is bound to another purchase: needs a human`);
        continue;
      }
      await store.sellerSeen(row.id, rec);
      note(`seller payment seen: ${f.fate}`);
    }
  }
  if (ctx.recordAlerts !== false) await keepAlerts(ctx, out, looked).catch(() => undefined);
  // A full run (the cron's, the script's; not a request's short turn): the runner on the operator's machine reports
  // when this gets old (the cron stopped).
  if (ctx.walletCheck !== false) await store.markRan(RECONCILE_RAN_KEY, ctx.now()).catch(() => undefined);
  return out;
}

/** pb_state key of the last full reconcile run. */
export const RECONCILE_RAN_KEY = "reconcile";

/** One kind of ALERT per purchase: the text with its numbers taken out (minutes, amounts change between runs). */
export const alertKey = (id: string, action: string) => `${id}:${action.replace(/\d+/g, "#").slice(0, 160)}`;

/**
 * ALERTs go to pb_alert as well as to the log: one row per purchase and kind, with when it was first and last seen.
 * An open alert of something looked at this run that did not say it again is resolved. The Mac's runner reads the
 * open ones through api/alerts.ts.
 */
async function keepAlerts(ctx: ReconcileContext, out: ReconcileAction[], looked: Map<string, string>): Promise<void> {
  const now = ctx.now();
  for (const [id, chain] of looked) {
    const keys: string[] = [];
    for (const a of out) {
      if (a.id !== id || !a.action.startsWith("ALERT")) continue;
      const key = alertKey(id, a.action);
      if (keys.includes(key)) continue;
      keys.push(key);
      await ctx.store.alertSeen({ key, purchaseId: id, chain, reason: a.action, now });
    }
    await ctx.store.alertsResolve(id, keys, now);
  }
}

async function one(ctx: ReconcileContext, run: Run, row: PurchaseRow, note: (a: string) => void): Promise<void> {
  const { store } = ctx;
  const side = row.chain === "solana" ? ctx.solana : ctx.tempo;
  if (!side) return note("skipped: chain not configured");
  const base = fallbackRecord(row, ctx.now());
  const total = BigInt(row.total);
  const day = row.day ?? ctx.now().toISOString().slice(0, 10);
  const pin = { updatedAt: row.updated_at };
  const agent = obj(row.facts.agent);
  const signer = row.chain === "solana" ? str(agent?.authority) : str(agent?.from);
  const refundTo = str(row.facts.refundTo) ?? str(base.customer.payer) ?? signer;
  const headers: Record<string, string> = {};
  const refundNote = (r: { body: Record<string, unknown> }) => {
    const rf = (r.body.refund ?? {}) as { status?: string; reason?: string };
    if (rf.status === "failed" && rf.reason === ACCOUNT_CREATION_WAIT) {
      run.nextAt = nextUtcDay(ctx.now());
      return "waiting: the refund needs the agent's USDC account created; the day's creations are used up (next UTC day)";
    }
    return rf.status === "sent" ? 'refund: "sent"' : `ALERT refund ${rf.status ?? "?"}: ${rf.reason ?? ""}`;
  };

  if (row.state === "claimed" || row.state === "admitted") {
    await store.release(row.id);
    return note("released: stopped before settlement, nothing charged");
  }

  if (row.state === "settling") {
    // The settled transaction the facilitator named, if any; if the chain does not confirm it, the agent's own
    // transaction (by its message) decides, so a signature that never lands cannot keep the purchase open forever.
    let paidTx: string | null = null;
    let payer: string | null = null;
    const settleTx = str(row.facts.settleTx);
    if (settleTx && signer) {
      const c = await side.confirmCustomer(settleTx, signer, total, str(agent?.messageHash) ?? "").catch(() => ({ ok: false as const, detail: "confirm_error", definite: false }));
      if (c.ok) {
        paidTx = settleTx;
        payer = "payer" in c && typeof c.payer === "string" ? c.payer : signer;
      }
    }
    if (!paidTx) {
      const f = await txFate(ctx, run, row, agent, { key: "agent" });
      if (f.fate === "pending") return note(waiting("the agent's payment can still land", f));
      if (f.fate === "dead" || f.fate === "failed") {
        await store.finish(row.id, ["settling"], { record: { ...base, outcome: "no_charge", reason: `agent_payment_${f.fate}` }, spent: 0n, ...pin, now: ctx.now() });
        return note(`closed: agent payment ${f.fate}, no charge`);
      }
      if (!signer) return note("ALERT agent address unknown");
      const c = await side.confirmCustomer(f.tx, signer, total, str(agent?.messageHash) ?? "").catch(() => ({ ok: false as const, detail: "confirm_error", definite: false }));
      if (!c.ok) {
        if (c.definite) {
          await store.finish(row.id, ["settling"], { record: { ...base, outcome: "no_charge", reason: c.detail }, spent: 0n, ...pin, now: ctx.now() });
          return note("closed: agent payment did not bring in the total");
        }
        return note("waiting: agent payment not confirmed");
      }
      paidTx = f.tx;
      payer = "payer" in c && typeof c.payer === "string" ? c.payer : signer;
    }
    const paid: PurchaseRecord = { ...base, customer: { tx: paidTx, payer, confirmed: true } };
    if (!(await store.useCustomerTx(row.id, row.chain, paidTx, { facts: { customerTx: paidTx, refundTo: payer }, record: paid, ...pin, now: ctx.now() }).catch(() => false))) {
      const cur = await store.get(row.id);
      if (cur && cur.state === "settling" && cur.updated_at === row.updated_at) {
        await store.finish(row.id, ["settling"], { record: { ...paid, outcome: "duplicate_customer_tx" }, spent: 0n, ...pin, now: ctx.now() });
        return note("closed: the agent's payment already paid for another purchase");
      }
      return note("skipped: moved by another run");
    }
    const r = await refundOwed(ctx, { id: row.id, chain: row.chain, day, from: ["in_progress"], base: paid, reason: "stopped_before_seller_payment", to: payer, total, send: side.refund, headers });
    return note(refundNote(r as { body: Record<string, unknown> }));
  }

  if (row.state === "in_progress" || row.state === "seller_unsettled") {
    const seller = obj(row.facts.seller);
    const f: Fate = seller ? await txFate(ctx, run, row, seller, { key: "seller" }) : { fate: "dead" }; // never handed over
    if (f.fate === "pending") return note(waiting("vet402's payment to the seller can still land", f));
    if (f.fate === "landed") {
      if (!(await store.bindTx(row.chain, f.tx, row.id, "seller", ctx.now()))) return note(`ALERT seller transaction ${f.tx} is bound to another purchase: needs a human`);
      const r: PurchaseRecord = {
        ...base,
        sellerPayment: { tx: f.tx, settled: true },
        outcome: base.answer?.delivered ? "delivered" : "not_delivered",
        reason: base.answer?.delivered ? null : "vet402's payment to the seller settled; the answer did not reach the agent",
      };
      const okClosed = await store.finish(row.id, [row.state], { record: r, spent: BigInt(row.seller_amount) + BigInt(row.fee_reserve), ...pin, now: ctx.now() });
      return note(okClosed ? "closed: seller paid, no refund" : "skipped: moved by another run");
    }
    // Move first (pinned), so only one run goes on to refund.
    if (!(await store.move(row.id, [row.state], "refund_pending", { ...pin, now: ctx.now() }))) return note("skipped: moved by another run");
    const r = await refundOwed(ctx, { id: row.id, chain: row.chain, day, from: [], base, reason: seller ? `seller_payment_${f.fate}` : "stopped_before_seller_payment", to: refundTo, total, send: side.refund, headers });
    return note(refundNote(r as { body: Record<string, unknown> }));
  }

  if (row.state === "refund_pending") {
    const rf = await store.getRefund(row.id);
    if (rf && rf.status === "stuck") return note(`ALERT refund stuck after ${rf.attempt} attempts: needs a human`);
    if (rf && rf.status === "sent") {
      await store.finish(row.id, ["refund_pending"], { record: { ...base, refund: { status: "sent", to: rf.to_addr, amountAtomic: rf.amount, tx: rf.tx, reason: null } }, spent: total, ...pin, now: ctx.now() });
      return note("closed: refund sent");
    }
    if (rf && (rf.status === "sending" || rf.status === "unknown")) {
      const f = await txFate(ctx, run, row, rf.facts, { refundTx: rf.tx });
      if (f.fate === "pending") return note(waiting("the refund can still land", f));
      if (f.fate === "landed") {
        if (!(await store.bindTx(row.chain, f.tx, row.id, "refund", ctx.now()))) return note(`ALERT refund transaction ${f.tx} is bound to another purchase: needs a human`);
        if (!(await store.refundSet(row.id, ["sending", "unknown"], "sent", { tx: rf.tx, now: ctx.now() }))) return note("skipped: refund moved by another run");
        await store.finish(row.id, ["refund_pending"], { record: { ...base, refund: { status: "sent", to: rf.to_addr, amountAtomic: rf.amount, tx: f.tx, reason: null } }, spent: total, ...pin, now: ctx.now() });
        return note("closed: refund landed");
      }
      // Proven dead: only the run that marks this very transaction dead may send the next attempt.
      if (!(await store.refundSet(row.id, ["sending", "unknown"], "dead", { reason: `refund_${f.fate}`, tx: rf.tx, now: ctx.now() }))) return note("skipped: refund moved by another run");
    }
    const again = await refundOwed(ctx, { id: row.id, chain: row.chain, day, from: [], base, reason: base.reason ?? "seller_not_paid", to: rf?.to_addr ?? refundTo, total, send: side.refund, headers, retry: !!rf });
    return note(refundNote(again as { body: Record<string, unknown> }).replace('refund: "sent"', `refund ${rf ? "retried" : "started"}: "sent"`));
  }
  note("skipped");
}
