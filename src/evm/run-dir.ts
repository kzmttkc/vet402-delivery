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
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { KEY_DIR } from "./key.js";
import type { LaneSpec } from "./chains.js";

export function payResultsDir(env: NodeJS.ProcessEnv = process.env, keyDir: string = KEY_DIR): string {
  return env.VET402_EVM_RESULTS_DIR ?? join(dirname(keyDir), "results", "evm");
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
