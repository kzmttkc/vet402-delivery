/**
 * Which sellers proxy buy will pay: only a (chain, host, payTo) that vet402 itself already paid and
 * whose payment settled on chain, read from the committed purchase data in data/.
 *
 * A seller that is not on this list is refused before any 402 is issued, so the agent is never charged
 * for it. A seller that moved its payTo is refused too: the pair (host, payTo) must match.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ProxyChain = "solana" | "tempo";

export interface AllowEntry {
  chain: ProxyChain;
  host: string;
  /** Solana: base58 as written. Tempo: lower-case 0x address. */
  payTo: string;
  /** vet402 purchases from this pair whose payment settled. */
  settled: number;
  /** Of those, how many came back with an answer (2xx and a body). */
  delivered: number;
  /** Time of the latest settled purchase (ISO), when the data carries one. */
  lastAt: string | null;
}

export interface Allowlist {
  entries: AllowEntry[];
  find(chain: ProxyChain, host: string, payTo: string): AllowEntry | null;
}

export function normPayTo(chain: ProxyChain, payTo: string): string {
  return chain === "tempo" ? payTo.toLowerCase() : payTo;
}

function hostOf(u: unknown): string | null {
  try {
    return new URL(String(u)).host.toLowerCase();
  } catch {
    return null;
  }
}

interface Seen {
  chain: ProxyChain;
  host: string | null;
  payTo: unknown;
  settled: unknown;
  delivered: unknown;
  at?: unknown;
}

export function makeAllowlist(rows: Seen[]): Allowlist {
  const map = new Map<string, AllowEntry>();
  for (const r of rows) {
    if (r.settled !== true || !r.host || typeof r.payTo !== "string" || r.payTo === "") continue;
    const payTo = normPayTo(r.chain, r.payTo);
    const k = `${r.chain} ${r.host} ${payTo}`;
    const e = map.get(k) ?? { chain: r.chain, host: r.host, payTo, settled: 0, delivered: 0, lastAt: null };
    e.settled += 1;
    if (r.delivered === true) e.delivered += 1;
    const at = typeof r.at === "string" ? r.at : null;
    if (at && (!e.lastAt || at > e.lastAt)) e.lastAt = at;
    map.set(k, e);
  }
  const entries = [...map.values()].sort((a, b) => `${a.chain} ${a.host}`.localeCompare(`${b.chain} ${b.host}`));
  return {
    entries,
    find(chain, host, payTo) {
      return map.get(`${chain} ${host.toLowerCase()} ${normPayTo(chain, payTo)}`) ?? null;
    },
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Build the list from data/: the Solana census records, the Tempo census ledger, and every remeasure file.
 * Missing files are skipped; a file that exists but cannot be parsed throws (the server does not start).
 */
export function loadAllowlist(dataDir: string): Allowlist {
  const rows: Seen[] = [];

  const solCensus = join(dataDir, "solana");
  if (existsSync(solCensus)) {
    for (const f of readdirSync(solCensus).filter((n) => /^census-\d{4}-\d{2}-\d{2}\.json$/.test(n))) {
      const d = readJson(join(solCensus, f)) as { records?: { requestUrl?: string; settled?: unknown; delivered?: unknown; probe?: { payTo?: unknown } }[]; ranAt?: string };
      for (const r of d.records ?? []) {
        rows.push({ chain: "solana", host: hostOf(r.requestUrl), payTo: r.probe?.payTo, settled: r.settled, delivered: r.delivered, at: d.ranAt });
      }
    }
  }

  const tempoLedger = join(dataDir, "tempo", "ledger.json");
  if (existsSync(tempoLedger)) {
    const d = readJson(tempoLedger) as { entries?: { url?: string; recipient?: unknown; settled?: unknown; delivered?: unknown; reservedAt?: unknown }[] };
    for (const e of d.entries ?? []) {
      rows.push({ chain: "tempo", host: hostOf(e.url), payTo: e.recipient, settled: e.settled, delivered: e.delivered, at: e.reservedAt });
    }
  }

  const remeasure = join(dataDir, "remeasure");
  if (existsSync(remeasure)) {
    for (const f of readdirSync(remeasure).filter((n) => /^(solana|tempo)-\d{4}-\d{2}-\d{2}\.json$/.test(n))) {
      const chain: ProxyChain = f.startsWith("solana") ? "solana" : "tempo";
      const d = readJson(join(remeasure, f)) as { rows?: { requestUrl?: string; url?: string; payTo?: unknown; settled?: unknown; delivered?: unknown; at?: unknown }[] };
      for (const r of d.rows ?? []) {
        rows.push({ chain, host: hostOf(r.requestUrl ?? r.url), payTo: r.payTo, settled: r.settled, delivered: r.delivered, at: r.at });
      }
    }
  }
  return makeAllowlist(rows);
}
