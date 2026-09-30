/**
 * The reconciler: settles every purchase whose request stopped before it was over (a function that hit its
 * time limit or crashed, a settlement whose outcome was unknown, a seller payment not seen yet, a refund not
 * confirmed), by reading the chains. It decides only on proof:
 *   - the agent's payment landed (and moved exactly the total) and vet402 never paid the seller, or vet402's
 *     payment to the seller is dead or failed on chain -> refund (once; a new refund attempt only after the
 *     previous one is proven dead);
 *   - the agent's payment is dead or failed -> no charge, closed;
 *   - vet402's payment to the seller landed -> closed, no refund;
 *   - anything that cannot be told yet stays as it is (and keeps new paid requests waiting: Store.blocking).
 * Every change is a guarded state move, so two reconcilers (or a reconciler and a request) cannot both act.
 * Run by scripts/proxy-buy-reconcile.ts, and by the request gate when stale purchases block new ones.
 */
import type { Fate } from "./fate.js";
import { tempoTxFate, type TempoTxFacts } from "./fate.js";
import { refundOwed, type Common } from "./flow.js";
import type { SolanaSide } from "./solana.js";
import type { PurchaseRecord, PurchaseRow, Store } from "./store.js";
import type { TempoSide } from "./tempo.js";

export interface ReconcileContext extends Common {
  solana?: SolanaSide;
  tempo?: TempoSide;
  staleMs: number;
}

export interface ReconcileAction {
  id: string;
  chain: string;
  state: string;
  action: string;
}

type Facts = Record<string, unknown>;
const obj = (v: unknown): Facts | null => (v && typeof v === "object" ? (v as Facts) : null);

function fallbackRecord(row: PurchaseRow, now: Date): PurchaseRecord {
  return (
    row.record ?? {
      id: row.id,
      chain: row.chain,
      at: now.toISOString(),
      target: "",
      seller: { host: "", payTo: "", priceAtomic: row.seller_amount },
      feeAtomic: (BigInt(row.total) - BigInt(row.seller_amount)).toString(),
      totalAtomic: row.total,
      customer: { tx: null, payer: null, confirmed: false },
      sellerPayment: null,
      answer: null,
      outcome: "in_progress",
      reason: null,
      refund: "none",
    }
  );
}

async function txFate(ctx: ReconcileContext, chain: string, f: Facts | null): Promise<Fate> {
  if (!f) return { fate: "pending" };
  if (chain === "solana" && ctx.solana) {
    if (typeof f.messageHash !== "string" || typeof f.blockhash !== "string" || typeof f.account !== "string") return { fate: "pending" };
    return ctx.solana.fate({ messageHash: f.messageHash, blockhash: f.blockhash, account: f.account });
  }
  if (chain === "tempo" && ctx.tempo) return tempoTxFate(ctx.tempo.reads, f as unknown as TempoTxFacts & { search?: { recipient: string; amount: string; fromBlock: string } });
  return { fate: "pending" };
}

function agentAddress(row: PurchaseRow): string | null {
  const a = obj(row.facts.agent);
  if (!a) return null;
  const v = row.chain === "solana" ? a.authority : a.from;
  return typeof v === "string" ? v : null;
}

export async function reconcile(ctx: ReconcileContext): Promise<ReconcileAction[]> {
  const { store } = ctx;
  const out: ReconcileAction[] = [];
  const rows = await store.stale(ctx.now(), ctx.staleMs);
  for (const row of rows) {
    if (Date.now() >= ctx.deadline) break;
    const note = (action: string) => out.push({ id: row.id, chain: row.chain, state: row.state, action });
    const side = row.chain === "solana" ? ctx.solana : ctx.tempo;
    if (!side) {
      note("skipped: chain not configured");
      continue;
    }
    const base = fallbackRecord(row, ctx.now());
    const total = BigInt(row.total);
    const day = row.day ?? ctx.now().toISOString().slice(0, 10);
    const to = agentAddress(row);
    const headers: Record<string, string> = {};

    if (row.state === "claimed" || row.state === "admitted") {
      await store.release(row.id);
      note("released: stopped before settlement, nothing charged");
      continue;
    }

    if (row.state === "settling") {
      const agent = obj(row.facts.agent);
      const settleTx = typeof row.facts.settleTx === "string" && row.facts.settleTx ? row.facts.settleTx : null;
      const f: Fate = settleTx ? { fate: "landed", tx: settleTx } : await txFate(ctx, row.chain, agent);
      if (f.fate === "pending") {
        note("waiting: the agent's payment can still land");
        continue;
      }
      if (f.fate === "dead" || f.fate === "failed") {
        await store.finish(row.id, ["settling"], { record: { ...base, outcome: "no_charge", reason: `agent_payment_${f.fate}` }, spent: 0n, now: ctx.now() });
        note(`closed: agent payment ${f.fate}, no charge`);
        continue;
      }
      if (!to) {
        note("waiting: agent address unknown");
        continue;
      }
      const conf = await side.confirmCustomer(f.tx, to, total).catch(() => ({ ok: false as const, detail: "confirm_error", definite: false }));
      if (!conf.ok) {
        if (conf.definite) {
          await store.finish(row.id, ["settling"], { record: { ...base, outcome: "no_charge", reason: conf.detail }, spent: 0n, now: ctx.now() });
          note("closed: agent payment did not move the total");
        } else note("waiting: agent payment not confirmed");
        continue;
      }
      const paid: PurchaseRecord = { ...base, customer: { tx: f.tx, payer: to, confirmed: true } };
      if (!(await store.useCustomerTx(row.id, row.chain, f.tx, { facts: { customerTx: f.tx }, record: paid, now: ctx.now() }))) {
        await store.finish(row.id, ["settling"], { record: { ...paid, outcome: "duplicate_customer_tx" }, spent: 0n, now: ctx.now() });
        note("closed: the agent's payment already paid for another purchase");
        continue;
      }
      const r = await refundOwed(ctx, { id: row.id, chain: row.chain, day, from: ["in_progress"], base: paid, reason: "stopped_before_seller_payment", to, total, send: side.refund, headers });
      note(`refund: ${JSON.stringify((r.body as { refund?: { status?: string } }).refund?.status ?? null)}`);
      continue;
    }

    if (row.state === "in_progress" || row.state === "seller_unsettled") {
      const seller = obj(row.facts.seller);
      const f: Fate = seller ? await txFate(ctx, row.chain, seller) : { fate: "dead" }; // never handed over
      if (f.fate === "pending") {
        note("waiting: vet402's payment to the seller can still land");
        continue;
      }
      if (f.fate === "landed") {
        const r: PurchaseRecord = {
          ...base,
          sellerPayment: { tx: f.tx, settled: true },
          outcome: base.answer?.delivered ? "delivered" : "not_delivered",
          reason: base.answer?.delivered ? null : "vet402's payment to the seller settled; the answer did not reach the agent",
        };
        await store.finish(row.id, [row.state], { record: r, spent: BigInt(row.seller_amount) + BigInt(row.fee_reserve), now: ctx.now() });
        note("closed: seller paid, no refund");
        continue;
      }
      const r = await refundOwed(ctx, { id: row.id, chain: row.chain, day, from: [row.state], base, reason: seller ? `seller_payment_${f.fate}` : "stopped_before_seller_payment", to, total, send: side.refund, headers });
      note(`refund: ${JSON.stringify((r.body as { refund?: { status?: string } }).refund?.status ?? null)}`);
      continue;
    }

    if (row.state === "refund_pending") {
      const rf = await store.getRefund(row.id);
      if (rf && rf.status === "sent") {
        await store.finish(row.id, ["refund_pending"], { record: { ...base, refund: { status: "sent", to: rf.to_addr, amountAtomic: rf.amount, tx: rf.tx, reason: null } }, spent: total, now: ctx.now() });
        note("closed: refund sent");
        continue;
      }
      if (rf && (rf.status === "sending" || rf.status === "unknown")) {
        const f = await txFate(ctx, row.chain, rf.facts);
        if (f.fate === "pending") {
          note("waiting: the refund can still land");
          continue;
        }
        if (f.fate === "landed") {
          await store.refundSet(row.id, ["sending", "unknown"], "sent", { now: ctx.now() });
          await store.finish(row.id, ["refund_pending"], { record: { ...base, refund: { status: "sent", to: rf.to_addr, amountAtomic: rf.amount, tx: f.tx, reason: null } }, spent: total, now: ctx.now() });
          note("closed: refund landed");
          continue;
        }
        await store.refundSet(row.id, ["sending", "unknown"], "dead", { reason: `refund_${f.fate}`, now: ctx.now() });
      }
      const again = await refundOwed(ctx, { id: row.id, chain: row.chain, day, from: [], base, reason: base.reason ?? "seller_not_paid", to: rf?.to_addr ?? to, total, send: side.refund, headers, retry: !!rf });
      note(`refund ${rf ? "retried" : "started"}: ${JSON.stringify((again.body as { refund?: { status?: string } }).refund?.status ?? null)}`);
      continue;
    }
    note("skipped");
  }
  return out;
}
