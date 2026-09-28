/**
 * Why did vouch's Tempo MPP lane settle without delivering? Classifies rows of the public
 * ledger export (https://vet402.com/api/v1/observatory/export.csv, CC-BY-4.0).
 *
 * delivered = status settled AND paid HTTP 2xx (vouch src/lib/observatory/delivery.ts).
 * A settled row that is not delivered falls in exactly one bucket:
 *   vet402_request_shape  paid response 4xx. vouch's MPP catalog rows carry no declared input
 *                         (mpp-directory.ts: declaredSchema null), so POST sent `{}` and GET sent
 *                         no query. The seller refused a request vet402 could not form. (vouch
 *                         already holds these as inconclusive `settled_4xx`.)
 *   vet402_timeout        no HTTP status: vouch's L1 runner stopped waiting at 20 s (l1-runner.ts
 *                         timeoutMs = 20_000); the transfer settled, the response never arrived.
 *   seller_5xx            paid response 5xx: the seller's side failed after taking payment.
 */
export interface LedgerRow {
  attempted_at: string;
  resource_key: string;
  network: string;
  status: string;
  http_status_paid: string;
  latency_ms: string;
  request_body: string;
  tx_hash: string;
}

export type Bucket = "delivered" | "vet402_request_shape" | "vet402_timeout" | "seller_5xx" | "other";

export function bucketOf(r: LedgerRow): Bucket | null {
  if (r.status !== "settled") return null;
  const code = /^\d+$/.test(r.http_status_paid) ? Number(r.http_status_paid) : null;
  if (code === null) return "vet402_timeout";
  if (code >= 200 && code <= 299) return "delivered";
  if (code >= 400 && code <= 499) return "vet402_request_shape";
  if (code >= 500 && code <= 599) return "seller_5xx";
  return "other";
}

/** Minimal RFC 4180 CSV parser (quoted fields, doubled quotes). */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [head, ...body] = rows;
  if (!head) return [];
  return body.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]!])));
}

export function breakdown(rows: LedgerRow[], network = "eip155:4217") {
  const t = rows.filter((r) => r.network === network);
  const settled = t.filter((r) => r.status === "settled");
  const buckets: Record<string, number> = {};
  const byEndpoint: Record<string, Record<string, number>> = {};
  for (const r of settled) {
    const b = bucketOf(r)!;
    buckets[b] = (buckets[b] ?? 0) + 1;
    if (b !== "delivered") {
      const key = `${r.resource_key} ${r.http_status_paid || "no-http"}`;
      byEndpoint[b] ??= {};
      byEndpoint[b]![key] = (byEndpoint[b]![key] ?? 0) + 1;
    }
  }
  return { attempts: t.length, settled: settled.length, buckets, byEndpoint };
}
