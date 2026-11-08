/**
 * Robinhood Chain host run (scripts/evm-lane.ts --lane robinhood --hosts). Read-only here: catalogs and unpaid
 * 402s, nothing signed or paid.
 *
 * One purchase per host that lists an exact USDG accept on Robinhood Chain, EIP-3009 only, price in
 * [minAtomic, maxPerAtomic], at most maxCount purchases and maxTotalAtomic in total. The run keeps its own
 * ledger on top of the robinhood lane's ledger (RunBudget). Records are the lane's normal records.
 */
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { getAddress, type Address } from "viem";
import type { Listing } from "../discovery.js";
import type { Budget, Refusal } from "../guard.js";
import type { EvmChainSpec } from "./chains.js";
import { checkChainAccept, eqAddr, type ChainBuyEntry } from "./evm-buy.js";
import { declarationFrom, mergeDeclarations, repairLaneRequest, type LastPaid } from "./lane-input.js";
import { chainAccepts, hostOf, requestOf, type ListingOption, type Probe } from "./lane-plan.js";

export const HOSTS_RUN = { ledger: "robinhood-hosts-ledger.json", minAtomic: 4_400n, maxPerAtomic: 10_000n, maxTotalAtomic: 60_000n, maxCount: 10 } as const;

/** The first paying host run. Its ledger file and per-host keys keep the names written that day. */
export const LEGACY_HOST_RUN_DATE = "2026-11-08";

export function hostLedgerKey(host: string): string {
  return `robinhood-host:${host.toLowerCase()}`;
}

/** The run ledger file and the per-host ledger key for one host-run date. */
export function hostRunFiles(date: string): { ledger: string; key: (host: string) => string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`not a host run date: ${JSON.stringify(date)}`);
  if (date === LEGACY_HOST_RUN_DATE) return { ledger: HOSTS_RUN.ledger, key: hostLedgerKey };
  return { ledger: `robinhood-hosts-${date}-ledger.json`, key: (host) => `${hostLedgerKey(host)}:${date}` };
}

export interface HostGroup {
  host: string;
  listings: number;
  options: ListingOption[];
  /** Listings not bought because vet402 cannot fill their input (src/evm/lane-input.ts). */
  inputSkipped?: { resource: string; why: string }[];
}

/** Pure. One group per host on `spec`. An option only when minAtomic <= amount <= maxPerAtomic; `listings` counts every listing on the chain. */
export function groupByHost(
  catalog: Listing[],
  spec: EvmChainSpec,
  opts: { minAtomic: bigint; maxPerAtomic: bigint; ownHosts?: string[]; today?: string; lastPaid?: ReadonlyMap<string, LastPaid>; nowMs?: number },
): HostGroup[] {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const seen = new Set<string>();
  const groups = new Map<string, HostGroup>();
  for (const l of catalog) {
    if (!l.resource || seen.has(l.resource)) continue;
    seen.add(l.resource);
    const host = hostOf(l.resource);
    if (!host || (opts.ownHosts ?? []).some((o) => host === o || host.endsWith(`.${o}`))) continue;
    let counted = false;
    for (const a of chainAccepts(l, spec)) {
      if (!/^\d+$/.test(a.amount) || !a.payTo) continue;
      let payTo: Address;
      try {
        payTo = getAddress(a.payTo);
      } catch {
        continue;
      }
      const g = groups.get(host) ?? { host, listings: 0, options: [] };
      if (!counted) {
        g.listings++;
        counted = true;
      }
      const amount = BigInt(a.amount);
      if (amount >= opts.minAtomic && amount <= opts.maxPerAtomic) {
        // The request is filled the way the Solana and Tempo purchases are. One that cannot be is not bought, with or
        // without an earlier 4xx (repairLaneRequest: every fillParams failure, sends_message and commits_to_purchase
        // included); it is kept as an input skip with the reason, and never reaches confirmLiveHosts or a purchase.
        const req = requestOf(l);
        const fix = repairLaneRequest(l, { resource: l.resource, method: req.method, query: req.query, body: req.body }, today, opts.lastPaid?.get(l.resource) ?? null, opts.nowMs ?? Date.now());
        if (!fix.ok) (g.inputSkipped ??= []).push({ resource: l.resource, why: `input_unfillable: ${fix.reason.replace(/^input_unfillable:/, "")}${fix.param ? ` (${fix.param})` : ""}` });
        else g.options.push({ payTo, amount: a.amount, ...fix.request, simple: req.simple, listingResource: l.resource, inputDate: today, datedParams: fix.datedParams, declaration: declarationFrom(l, "catalog"), declaredParams: fix.declaredParams, ...(fix.changed ? { filled: fix.filled } : {}) });
      }
      groups.set(host, g);
    }
  }
  for (const g of groups.values()) {
    // Cheapest first, then a plain GET, then by URL so the plan does not depend on catalog order.
    g.options.sort((a, b) => cmpAtomic(a.amount, b.amount) || Number(b.simple) - Number(a.simple) || a.resource.localeCompare(b.resource));
  }
  return [...groups.values()].sort((a, b) => a.host.localeCompare(b.host));
}

export interface HostChoice {
  host: string;
  listings: number;
  /** The listing that will be bought, confirmed against its live 402; null when none still offers it. */
  chosen: (ListingOption & { liveAmount: string; raw402: string }) | null;
  tried: { resource: string; status: number | null; why: string }[];
}

/** Probe up to `maxTries` options per host until one's live 402 passes every accept check (dry). Output order is the input order. */
export async function confirmLiveHosts(
  groups: HostGroup[],
  spec: EvmChainSpec,
  probe: Probe,
  opts: { payer: string; minAtomic: bigint; maxPerAtomic: bigint; maxTries?: number; concurrency?: number },
): Promise<HostChoice[]> {
  const out: HostChoice[] = new Array(groups.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= groups.length) return;
      const g = groups[i]!;
      const c: HostChoice = { host: g.host, listings: g.listings, chosen: null, tried: (g.inputSkipped ?? []).map((x) => ({ resource: x.resource, status: null, why: x.why })) };
      for (const o of g.options.slice(0, opts.maxTries ?? 3)) {
        const p = await probe(o);
        if (p.status !== 402) {
          c.tried.push({ resource: o.resource, status: p.status, why: p.error ?? `HTTP ${p.status ?? "none"}` });
          continue;
        }
        // The option's own payTo and price, not the group's. Else the first accept on the chain, so the refusal says why.
        const a = p.accepts.find((x) => x.network === spec.caip2 && x.scheme === "exact" && eqAddr(x.payTo, o.payTo)) ?? p.accepts.find((x) => x.network === spec.caip2) ?? null;
        const r = checkChainAccept(spec, a, { payer: opts.payer, lockedPayTo: o.payTo, lockedAmount: o.amount, minAtomic: opts.minAtomic, maxPerAtomic: opts.maxPerAtomic });
        if (r) {
          c.tried.push({ resource: o.resource, status: 402, why: `${r.refused}: ${r.detail}` });
          continue;
        }
        // What the seller declares in the 402 it serves now (often more than the catalog: a required list).
        const declaration = mergeDeclarations([o.declaration, ...(p.docs ?? []).map((d) => declarationFrom(d, "402"))]);
        c.chosen = { ...o, declaration, liveAmount: a!.amount, raw402: p.raw };
        break;
      }
      out[i] = c;
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency ?? 6 }, worker));
  return out;
}

/** Pure. Cheapest confirmed host first. The lock takes the live price when it is lower, never higher. A host that would cross the total is left out and a later one may still fit. */
export function pickHostEntries(choices: HostChoice[], opts: { maxTotalAtomic: bigint; maxCount: number; runDate?: string }): { entries: ChainBuyEntry[]; totalAtomic: bigint; left: { host: string; why: string }[] } {
  const ranked = choices.flatMap((c) => {
    if (!c.chosen) return [];
    const amount = BigInt(c.chosen.liveAmount) < BigInt(c.chosen.amount) ? c.chosen.liveAmount : c.chosen.amount;
    return [{ host: c.host, chosen: c.chosen, amount }];
  });
  ranked.sort((a, b) => cmpAtomic(a.amount, b.amount) || a.host.localeCompare(b.host));
  const entries: ChainBuyEntry[] = [];
  const left: { host: string; why: string }[] = [];
  let totalAtomic = 0n;
  for (const c of ranked) {
    const n = BigInt(c.amount);
    if (entries.length >= opts.maxCount) {
      left.push({ host: c.host, why: "over_run_count" });
      continue;
    }
    if (totalAtomic + n > opts.maxTotalAtomic) {
      left.push({ host: c.host, why: "over_run_total" });
      continue;
    }
    totalAtomic += n;
    const o = c.chosen;
    entries.push({
      agentId: `host:${c.host}`,
      resource: o.resource,
      method: o.method,
      query: o.query,
      body: o.body,
      listingResource: o.listingResource,
      inputDate: o.inputDate,
      ...(o.datedParams.length ? { datedParams: o.datedParams } : {}),
      ...(o.declaredParams.length || o.declaration.declared.length ? { declaredParams: [...new Set([...o.declaredParams, ...o.declaration.declared])] } : {}),
      ...(o.declaration.required.length ? { requiredParams: o.declaration.required } : {}),
      ...(o.declaration.from.length ? { declaredFrom: o.declaration.from } : {}),
      ...(o.declaration.requiredFrom.length ? { requiredFrom: o.declaration.requiredFrom } : {}),
      ledgerKey: hostRunFiles(opts.runDate ?? LEGACY_HOST_RUN_DATE).key(c.host),
      lock: { payTo: o.payTo, amount: c.amount },
    });
  }
  for (const c of choices) if (!c.chosen) left.push({ host: c.host, why: "no_live_402" });
  return { entries, totalAtomic, left };
}

/**
 * The host run's ledger in front of the robinhood lane's. A purchase has to fit both. If the lane refuses,
 * the run reservation is given back, so a host the lane already bought does not use up the run.
 */
export class RunBudget {
  private readonly ids = new Map<string, { run: string; lane: string }>();
  private seq = 0;

  constructor(
    private readonly run: Budget,
    private readonly lane: Budget,
  ) {}

  get spent(): bigint {
    return this.run.spent;
  }
  get count(): number {
    return this.run.count;
  }

  setBaselineIfMissing(balanceAtomic: bigint): void {
    this.run.setBaselineIfMissing(balanceAtomic);
    this.lane.setBaselineIfMissing(balanceAtomic);
  }

  reserve(amount: bigint, key: string, currentBalanceAtomic: bigint | null = null): Refusal | { ok: true; id: string } {
    const runRes = this.run.reserve(amount, key, currentBalanceAtomic);
    if ("refused" in runRes) return runRes;
    const laneRes = this.lane.reserve(amount, key, currentBalanceAtomic);
    if ("refused" in laneRes) {
      this.run.release(runRes.id);
      return laneRes;
    }
    const id = `h${++this.seq}`;
    this.ids.set(id, { run: runRes.id, lane: laneRes.id });
    return { ok: true, id };
  }

  release(id: string): void {
    const both = this.ids.get(id);
    if (!both) return;
    this.ids.delete(id);
    this.run.release(both.run);
    this.lane.release(both.lane);
  }

  commit(id: string): void {
    const both = this.ids.get(id);
    if (!both) return;
    this.ids.delete(id);
    this.run.commit(both.run);
    this.lane.commit(both.lane);
  }
}

export interface PlanRow {
  host: string;
  resource: string;
  method: string;
  payTo: string;
  amountAtomic: string;
}

/**
 * Pure. A paying run plans again from live 402s; it buys only the entries equal to a row of the plan that was sent
 * before paying (the dry run's robinhoodHosts.plan): same host, resource, method, payTo and amount. Anything else is
 * dropped with the reason, never bought.
 */
export function keepPlanned(entries: ChainBuyEntry[], plan: readonly PlanRow[]): { entries: ChainBuyEntry[]; dropped: { host: string; why: string }[] } {
  const kept: ChainBuyEntry[] = [];
  const dropped: { host: string; why: string }[] = [];
  for (const e of entries) {
    const host = e.agentId.startsWith("host:") ? e.agentId.slice(5) : e.agentId;
    const row = plan.find((p) => p.host === host);
    if (!row) {
      dropped.push({ host, why: "not_in_plan" });
      continue;
    }
    const diff: string[] = [];
    if (row.resource !== e.resource) diff.push(`resource ${e.resource} != plan ${row.resource}`);
    if (row.method !== e.method) diff.push(`method ${e.method} != plan ${row.method}`);
    if (!eqAddr(row.payTo, e.lock.payTo)) diff.push(`payTo ${e.lock.payTo} != plan ${row.payTo}`);
    if (row.amountAtomic !== e.lock.amount) diff.push(`amount ${e.lock.amount} != plan ${row.amountAtomic}`);
    if (diff.length) dropped.push({ host, why: `differs_from_plan: ${diff.join("; ")}` });
    else kept.push(e);
  }
  return { entries: kept, dropped };
}

/** Purchase cap of the lane ledger during a host run: the purchases it already holds, plus this run's own count. */
export function laneCountCapForHostRun(laneHeld: number): number {
  return laneHeld + HOSTS_RUN.maxCount;
}

/**
 * Pure read of `dir`. Why a paying host run for `date` must not start, or null: the lane's records hold more sent
 * host purchases for that date (agentId `host:`, inputDate equal to it; a line that does not parse still counts)
 * than that date's run ledger, or the ledger is missing while they hold any. A row with no inputDate belongs to
 * the first run. A run ledger that was deleted or moved would otherwise give the run its whole total and count back.
 */
export function hostRunLedgerProblem(dir: string, date: string = LEGACY_HOST_RUN_DATE): string | null {
  const rec = join(dir, "robinhood-purchases.jsonl");
  if (!existsSync(rec)) return null;
  let sent = 0;
  for (const l of readFileSync(rec, "utf8").split("\n")) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l) as { agentId?: string; outcome?: string; inputDate?: string | null };
      const hostSent = r.outcome === "sent" && typeof r.agentId === "string" && r.agentId.startsWith("host:");
      // A row with no inputDate is the first run, before the date was written on it.
      if (hostSent && (r.inputDate === date || (r.inputDate == null && date === LEGACY_HOST_RUN_DATE))) sent++;
    } catch {
      sent++; // an unreadable line may be a host purchase: count it, so a short run ledger still stops the run
    }
  }
  if (!sent) return null;
  const ledger = join(dir, hostRunFiles(date).ledger);
  if (!existsSync(ledger)) return `ALERT ${rec} has ${sent} host-run purchase(s) sent, but ${ledger} does not exist`;
  let held = -1;
  try {
    const j = JSON.parse(readFileSync(ledger, "utf8")) as { purchases?: unknown[] };
    held = Array.isArray(j.purchases) ? j.purchases.length : -1;
  } catch {
    held = -1;
  }
  return held < sent ? `ALERT ${ledger} holds ${held < 0 ? "an unreadable list of" : held} purchase(s), fewer than the ${sent} host-run purchase(s) sent in ${rec}` : null;
}

/** One paying host run at a time: the run ledger has no file lock of its own. Throws when another run holds it. */
export function acquireHostRunLock(dir: string): () => void {
  const file = join(dir, "robinhood-hosts.lock");
  let fd: number;
  try {
    fd = openSync(file, "wx");
  } catch {
    throw new Error(`another host run holds ${file}; remove it only when no such run is alive`);
  }
  writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
  closeSync(fd);
  return () => rmSync(file, { force: true });
}

function cmpAtomic(a: string, b: string): number {
  const d = BigInt(a) - BigInt(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
}
