/** Same stop wording family as Tempo pay (chain_spend_exceeds_ledger). Pure. */
export function evmOutflowExceedsLedger(ledgerCommitted: bigint, chainSpent: bigint): string | null {
  if (chainSpent > ledgerCommitted) {
    return `chain_spend_exceeds_ledger: on-chain outflow ${chainSpent} > ledger ${ledgerCommitted}`;
  }
  return null;
}
