/**
 * What the first-buyer mode publishes. The ledger file (results/first-buyer-ledger.json) is public
 * as written; this adds the buyer wallet list and a flat row view for pages. Pure.
 */
import { FB_BUYER_WALLETS, FB_NOTE } from "./constants.js";
import type { LedgerFile } from "./ledger.js";

export function walletsJson() {
  return {
    kind: "vet402-buyer-wallets",
    note: FB_NOTE,
    detail: "Every USDC payment from these wallets is a test purchase by vet402. Analysts may subtract them.",
    wallets: FB_BUYER_WALLETS,
  };
}

export interface PublicRow {
  payTo: string;
  at: string;
  host: string;
  tx: string | null;
  settled: boolean | null;
  delivered: boolean | null;
  failureReason: string | null;
  attempt: number;
  note: string;
  reciprocal: boolean;
}

/** One row per attempt, newest first. Pending attempts are shown as they are. */
export function publicRows(l: LedgerFile): PublicRow[] {
  const rows: PublicRow[] = [];
  for (const e of Object.values(l.sellers)) {
    e.attempts.forEach((a, i) => {
      rows.push({
        payTo: e.payTo,
        at: a.at,
        host: a.host,
        tx: a.tx,
        settled: a.state === "pending" ? null : a.settled,
        delivered: a.state === "pending" ? null : a.delivered,
        failureReason: a.state === "pending" ? "pending" : a.delivered ? null : (a.category ?? a.reason),
        attempt: i + 1,
        note: FB_NOTE,
        reciprocal: e.reciprocal.value,
      });
    });
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}
