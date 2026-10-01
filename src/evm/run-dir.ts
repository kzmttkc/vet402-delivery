/**
 * Where a paying EVM lane run keeps what money depends on: the lane ledgers (src/guard.ts Budget: each seller once),
 * the purchase records, the paid run's plan. It is fixed to the same root as the key (src/evm/key.ts KEY_DIR,
 * ~/vet402-solana/.keys by default): <that root>/results/evm. A paying run started from another working tree
 * therefore reads and writes the production ledger, never an empty one beside it. Only VET402_EVM_RESULTS_DIR,
 * set explicitly, puts it elsewhere.
 *
 * Read-only and dry runs keep using results/evm under the working directory (the daily records run works in the
 * production checkout, so both are the same there).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { KEY_DIR } from "./key.js";
import type { LaneSpec } from "./chains.js";

export function payResultsDir(env: NodeJS.ProcessEnv = process.env, keyDir: string = KEY_DIR): string {
  return env.VET402_EVM_RESULTS_DIR ?? join(dirname(keyDir), "results", "evm");
}

/**
 * Why VET402_EVM_RESULTS_DIR cannot be used for a paying run, or null (unset is fine: the key's root is used). An
 * empty value, a relative path (it would follow the working directory again) and a directory that does not exist
 * are refused: a paying run with any of them would start on a ledger that is not the production one.
 */
export function payResultsDirProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.VET402_EVM_RESULTS_DIR;
  if (v === undefined) return null;
  const why =
    v === "" ? "is set but empty" : !isAbsolute(v) ? `is a relative path (${v})` : !existsSync(v) ? `names a directory that does not exist (${v})` : !statSync(v).isDirectory() ? `names a file, not a directory (${v})` : null;
  return why ? `ALERT VET402_EVM_RESULTS_DIR ${why}: --pay stops before any purchase (unset it to use the key's root, or give an existing absolute path)` : null;
}

/**
 * With VET402_EVM_RESULTS_DIR set, every lane of the run must already have its ledger there: an override is for
 * pointing at an existing production ledger, never for starting a new one. A first purchase (no ledger yet) is run
 * with the variable unset, on the key's root. Returns the ALERT, or null.
 */
export function overrideLedgerProblem(lanes: readonly Pick<LaneSpec, "ledger">[], env: NodeJS.ProcessEnv = process.env): string | null {
  const v = env.VET402_EVM_RESULTS_DIR;
  if (v === undefined) return null;
  const missing = lanes.map((l) => laneLedgerPath(l, v)).filter((f) => !existsSync(f));
  return missing.length
    ? `ALERT VET402_EVM_RESULTS_DIR is set, but ${missing.join(", ")} does not exist: --pay stops before any purchase. A first purchase that creates a ledger is run with VET402_EVM_RESULTS_DIR unset (the key's root).`
    : null;
}

/** The ledger file of a lane inside a results directory. */
export function laneLedgerPath(lane: Pick<LaneSpec, "ledger">, dir: string): string {
  return join(dir, basename(lane.ledger));
}

/**
 * Pure apart from reading files. Why a paying run must stop before any purchase, or null: a lane whose purchase
 * records show purchases sent, but whose ledger is missing or holds fewer purchases than the records sent. A run
 * on such a ledger would buy the same sellers again.
 */
export function ledgerBehindRecords(lanes: readonly Pick<LaneSpec, "id" | "ledger">[], dir: string): string | null {
  const out: string[] = [];
  for (const lane of lanes) {
    const rec = join(dir, `${lane.id}-purchases.jsonl`);
    if (!existsSync(rec)) continue;
    let sent = 0;
    for (const l of readFileSync(rec, "utf8").split("\n")) {
      if (!l.trim()) continue;
      try {
        if ((JSON.parse(l) as { outcome?: string }).outcome === "sent") sent++;
      } catch {
        sent++; // an unreadable line may be a purchase: count it, so a short ledger still stops the run
      }
    }
    if (!sent) continue;
    const ledger = laneLedgerPath(lane, dir);
    if (!existsSync(ledger)) {
      out.push(`ALERT ${rec} has ${sent} purchase(s) sent, but ${ledger} does not exist`);
      continue;
    }
    let held = -1;
    try {
      const j = JSON.parse(readFileSync(ledger, "utf8")) as { purchases?: unknown[] };
      held = Array.isArray(j.purchases) ? j.purchases.length : -1;
    } catch {
      held = -1;
    }
    if (held < sent) out.push(`ALERT ${ledger} holds ${held < 0 ? "no readable" : held} purchase(s), fewer than the ${sent} sent in ${rec}`);
  }
  return out.length ? `${out.join("\n")}\nALERT --pay stops before any purchase: the ledger would let the same sellers be bought again` : null;
}
