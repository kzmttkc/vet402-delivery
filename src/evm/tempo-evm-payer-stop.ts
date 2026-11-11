/**
 * When Tempo and EVM share one payer, Tempo stops block new EVM signatures until cleared.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PAYER_ADDRESS } from "../tempo/constants.js";
import { EXPECTED_ADDRESS } from "./key.js";
import { TEMPO_KEY_LEDGERS } from "../tempo/key-ledgers.js";

function sharesTempoPayer(): boolean {
  return PAYER_ADDRESS.toLowerCase() === EXPECTED_ADDRESS.toLowerCase();
}

const TEMPO_SIGN_BLOCK_REASONS = [
  "not_settled",
  "chain_spend_exceeds_ledger",
  "outcome_unknown",
  "tx_check_failed",
  "fee_over_reserve",
  "insufficient_balance",
] as const;

export function tempoStopBlocksSharedEvmSign(lastTempoStopReason: string | null | undefined): string | null {
  if (!sharesTempoPayer()) return null;
  const r = lastTempoStopReason?.trim();
  if (!r) return null;
  if (TEMPO_SIGN_BLOCK_REASONS.some((x) => r === x || r.startsWith(`${x}:`))) {
    return `Tempo is stopped (${r}); shared payer blocks new EVM EIP-3009 signatures`;
  }
  return null;
}

export function tempoHaltPayBlocksSharedEvmSign(haltPayBody: string | null | undefined): string | null {
  if (!sharesTempoPayer()) return null;
  const body = haltPayBody?.trim();
  if (!body) return null;
  return `HALT-pay is set (${body.split(/\n/)[0]?.slice(0, 120)}); shared payer blocks new EVM EIP-3009 signatures`;
}

export function readTempoHaltPayFile(stateDir: string): string | null {
  const p = join(stateDir, "HALT-pay");
  if (!existsSync(p)) return null;
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "unreadable";
  }
}

export function sharedEvmSignBlockedByTempo(input: {
  haltPayBody?: string | null;
  lastTempoStopReason?: string | null;
}): string | null {
  return tempoHaltPayBlocksSharedEvmSign(input.haltPayBody) ?? tempoStopBlocksSharedEvmSign(input.lastTempoStopReason);
}

export function defaultDailyPayHaltStateDir(): string {
  return process.env.VET402_DAILY_STATE ?? join(homedir(), ".local/state/vet402-daily");
}

/** Last non-null `stopped` from a Tempo remeasure / run JSON (`runs[].stopped` or top-level `stopped`). */
export function tempoStoppedReasonFromJson(text: string): string | null {
  try {
    const j = JSON.parse(text) as {
      stopped?: string | { reason?: string };
      runs?: { stopped?: string | null }[];
    };
    if (typeof j.stopped === "string" && j.stopped.trim()) return j.stopped.trim();
    if (j.stopped && typeof j.stopped === "object" && j.stopped.reason?.trim()) return j.stopped.reason.trim();
    if (Array.isArray(j.runs)) {
      for (let i = j.runs.length - 1; i >= 0; i--) {
        const s = j.runs[i]?.stopped;
        if (typeof s === "string" && s.trim()) return s.trim();
      }
    }
  } catch {
    /* unreadable */
  }
  return null;
}

function readNewestTempoStopInDir(dir: string): string | null {
  if (!existsSync(dir)) return null;
  let newest: { mtime: number; reason: string } | null = null;
  for (const name of readdirSync(dir)) {
    if (!/tempo.*\.json$/i.test(name) && !name.endsWith("-paid-run.json")) continue;
    const p = join(dir, name);
    try {
      const st = readFileSync(p, "utf8");
      const reason = tempoStoppedReasonFromJson(st);
      if (!reason) continue;
      const mtime = statSync(p).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { mtime, reason };
    } catch {
      /* skip */
    }
  }
  return newest?.reason ?? null;
}

/** Read HALT-pay and the latest Tempo `stopped` from disk (not env overrides). */
export function resolveSharedEvmTempoStop(input?: { dailyStateDir?: string; repoStateDir?: string; extraJsonPaths?: string[] }): {
  haltPayBody: string | null;
  lastTempoStopReason: string | null;
} {
  const daily = input?.dailyStateDir ?? defaultDailyPayHaltStateDir();
  const repo = input?.repoStateDir ?? join(homedir(), "vet402-solana/state");
  const haltDaily = readTempoHaltPayFile(daily);
  const haltRepo = readTempoHaltPayFile(repo);
  const haltPayBody = haltDaily ?? haltRepo;
  const dirs = [TEMPO_KEY_LEDGERS.remeasureDir, join(homedir(), "vet402-solana/results/remeasure")];
  const reasons: string[] = [];
  for (const d of dirs) {
    const r = readNewestTempoStopInDir(d);
    if (r) reasons.push(r);
  }
  for (const p of input?.extraJsonPaths ?? []) {
    if (!existsSync(p)) continue;
    const r = tempoStoppedReasonFromJson(readFileSync(p, "utf8"));
    if (r) reasons.push(r);
  }
  return { haltPayBody, lastTempoStopReason: reasons[0] ?? null };
}
