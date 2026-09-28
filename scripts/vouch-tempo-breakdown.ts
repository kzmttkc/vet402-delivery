/**
 * Re-derive the Tempo L1 breakdown from vet402's public ledger export.
 *   npx tsx scripts/vouch-tempo-breakdown.ts [--days 30]
 */
import { breakdown, parseCsv, type LedgerRow } from "../src/tempo/l1-breakdown.js";

const i = process.argv.indexOf("--days");
const days = i >= 0 ? Number(process.argv[i + 1]) : 30;
const url = `https://vet402.com/api/v1/observatory/export.csv?days=${days}`;
const res = await fetch(url, { headers: { "user-agent": "vet402-tempo-census/0.1" } });
if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
const rows = parseCsv(await res.text()) as unknown as LedgerRow[];
const b = breakdown(rows);
console.log(JSON.stringify({ source: url, retrievedAt: res.headers.get("x-vet402-retrieved-at"), ...b }, null, 2));
