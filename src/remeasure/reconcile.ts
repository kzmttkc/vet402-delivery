/**
 * A purchase the ledger holds but no result file shows: the run ended (crash, kill) after the ledger
 * write and before the result row, so a payment may have been signed and sent. The next --pay run,
 * holding the run lock, adds one row for it with outcome "unknown_after_sign" before buying anything.
 * The ledger entry stays as it is, so the same key is still refused (already_bought): nothing is paid twice.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atomicToUsdc } from "../constants.js";
import { atomicToUnits, normAddr } from "../tempo/constants.js";
import { Ledger } from "../tempo/ledger.js";
import { RM_TEMPO_MAX_PER_RUN_ATOMIC, type RemeasureChain } from "./constants.js";
import { readResultFile, resultPath, writeJsonAtomic, type RemeasureRow, type ResultFile } from "./results.js";
import { selectSlots, type Target } from "./targets.js";
import { DAY_LEDGER } from "./tempo.js";

const KEY = /^(\d{4}-\d{2}-\d{2})\|([^|]+)\|(\d+)$/;

function parseKey(key: string, where: string): { date: string; payTo: string; slot: number } {
  const m = KEY.exec(key);
  if (!m) throw new Error(`${where}: ledger key "${key}" is not <date>|<payTo>|<slot>`);
  return { date: m[1]!, payTo: m[2]!, slot: Number(m[3]) };
}

/** The resource selectSlots gives this payTo and slot, from the same inputs. */
function targetFor(targets: readonly Target[], payTo: string, slot: number, url: string | null): Target | null {
  const mine = targets.filter((t) => t.payTo === payTo);
  if (url) return mine.find((t) => t.requestUrl === url || t.url === url) ?? null;
  if (mine.length === 0) return null;
  return selectSlots(mine, slot + 1).slots.find((s) => s.slot === slot)?.target ?? null;
}

function note(at: string, extra = ""): string {
  return `reserved ${at}${extra}; the run ended before its result was written, so a payment may have been signed and sent. Not paid again.`;
}

class ResultFiles {
  private readonly open = new Map<string, ResultFile>();
  readonly added: RemeasureRow[] = [];
  constructor(
    private readonly dir: string,
    private readonly chain: RemeasureChain,
    private readonly payer: string,
  ) {}
  private file(date: string): ResultFile {
    let f = this.open.get(date);
    if (!f) {
      f = readResultFile(resultPath(this.dir, this.chain, date), this.chain, date, this.payer);
      this.open.set(date, f);
    }
    return f;
  }
  has(date: string, key: string): boolean {
    return this.file(date).rows.some((r) => r.key === key);
  }
  add(date: string, row: RemeasureRow): void {
    this.file(date).rows.push(row);
    this.added.push(row);
  }
  save(): void {
    for (const [date, f] of this.open) if (f.rows.some((r) => this.added.includes(r))) writeJsonAtomic(resultPath(this.dir, this.chain, date), f);
  }
}

/** Solana: every reservation in the month budget file without a result row. */
export function reconcileSolana(budgetFile: string, dir: string, targets: readonly Target[], payer: string): RemeasureRow[] {
  if (!existsSync(budgetFile)) return [];
  const b = JSON.parse(readFileSync(budgetFile, "utf8")) as { purchases?: { key: string; amount: string; at: string }[] };
  if (!Array.isArray(b.purchases)) throw new Error(`${budgetFile}: no purchases list; refusing to pay`);
  const files = new ResultFiles(dir, "solana", payer);
  for (const p of b.purchases) {
    const k = parseKey(p.key, budgetFile);
    if (files.has(k.date, p.key)) continue;
    const t = targetFor(targets, k.payTo, k.slot, null);
    if (!t) throw new Error(`${budgetFile}: reservation ${p.key} has no result and its payTo is not in the inputs; add its row by hand after checking the chain`);
    files.add(k.date, {
      at: p.at, chain: "solana", host: t.host, service: null, url: t.url, requestUrl: t.requestUrl, payTo: null, expectedPayTo: k.payTo,
      outcome: "unknown_after_sign", reason: "unknown_after_sign", detail: note(p.at), settled: null, delivered: null, httpStatus: null,
      bodyBytes: null, tx: null, priceUsdc: /^\d+$/.test(p.amount) ? atomicToUsdc(p.amount) : null, slot: k.slot, key: p.key,
    });
  }
  files.save();
  return files.added;
}

/** Tempo: every day ledger entry in `dir` that may have moved money and has no result row. */
export function reconcileTempo(dir: string, targets: readonly Target[], payer: string): RemeasureRow[] {
  if (!existsSync(dir)) return [];
  const files = new ResultFiles(dir, "tempo", payer);
  for (const name of readdirSync(dir).sort()) {
    if (!DAY_LEDGER.test(name)) continue;
    const path = join(dir, name);
    for (const e of new Ledger(path, payer, RM_TEMPO_MAX_PER_RUN_ATOMIC).entries()) {
      if (e.status === "refused_before_sign") continue;
      const k = parseKey(e.key, path);
      if (files.has(k.date, e.key)) continue;
      const t = targetFor(targets, normAddr(k.payTo), k.slot, e.url);
      if (!t) throw new Error(`${path}: entry ${e.key} has no result and ${e.url} is not in the inputs; add its row by hand after checking the chain`);
      files.add(k.date, {
        at: e.reservedAt, chain: "tempo", host: t.host, service: t.service, url: t.url, requestUrl: t.requestUrl, payTo: normAddr(e.recipient),
        expectedPayTo: t.payTo, outcome: "unknown_after_sign", reason: "unknown_after_sign",
        detail: note(e.reservedAt, `, ledger status ${e.status}${e.settled === true ? ", settled on chain" : ""}`),
        settled: null, delivered: null, httpStatus: e.httpStatus ?? null, bodyBytes: null, tx: e.txHash ?? null,
        priceUsdc: atomicToUnits(e.amount), slot: k.slot, key: e.key,
      });
    }
  }
  files.save();
  return files.added;
}
