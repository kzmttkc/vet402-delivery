/**
 * vet402-check: the command line.
 *
 *   vet402-check <url> [--chain <name|CAIP-2>] [--pay-to <address>] [--verify] [--offline] [--json]
 *   vet402-check verify <record id | https URL | file> [--offline] [--json]
 *   vet402-check --mcp
 *
 * Read-only: public files and public RPC only. Exit 0 after a lookup (found or not), 1 when a record
 * fails verification, 2 on bad input or when the public data cannot be read.
 */
import { checkBeforePaying, type CheckResult, type SellerFacts } from "./check.js";
import { serveStdio } from "./mcp.js";
import { PublicData } from "./sources.js";
import { formatVerify, verifyRecord } from "./verify.js";

const USAGE = `usage:
  vet402-check <url> [--chain solana|tempo|base|algorand|<CAIP-2>] [--pay-to <address>] [--verify] [--offline] [--json]
  vet402-check verify <record id | https URL | file> [--offline] [--json]
  vet402-check --mcp          (MCP server on stdio: check_before_paying, verify_record)

Reads vet402's public rank.json and signed records. No key, no wallet, no payment.`;

export function parseArgs(argv: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const withValue = new Set(["--chain", "--pay-to"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (withValue.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      flags.set(a, v);
      i++;
    } else if (a.startsWith("--")) flags.set(a, true);
    else positional.push(a);
  }
  return { positional, flags };
}

function sellerText(f: SellerFacts): string[] {
  const out = [`  ${f.key}  (${f.pageLabel} page, grade ${f.grade}${f.rank !== null ? `, rank ${f.rank}` : ""})`];
  out.push(`    tried ${f.tried}, settled ${f.settled}, came back with an answer ${f.delivered}, counted ${f.counted}`);
  for (const [c, v] of Object.entries(f.byChain)) out.push(`    ${c}: tried ${v.tried}, settled ${v.settled}, answered ${v.delivered}, last ${v.lastAt ?? "?"}`);
  const sf = Object.entries(f.sellerSideFailures).map(([k, n]) => `${k} ${n}`);
  out.push(`    counted against the seller: ${sf.length ? sf.join(", ") : "none"}`);
  const nc = f.notCountedAgainstSeller;
  out.push(`    not counted against the seller: vet402 or facilitator ${nc.vet402OrFacilitator}, cause unknown ${nc.causeUnknown}`);
  if (f.last) out.push(`    newest: ${f.last.at} ${f.last.chain} ${f.last.category}${f.last.httpStatus !== null ? ` HTTP ${f.last.httpStatus}` : ""} ${f.last.explorer ?? f.last.tx ?? "(no tx)"}`);
  if (f.lastSellerSideFailure && f.lastSellerSideFailure.at !== f.last?.at)
    out.push(`    newest seller-side failure: ${f.lastSellerSideFailure.at} ${f.lastSellerSideFailure.rule ?? ""} ${f.lastSellerSideFailure.explorer ?? ""}`.trimEnd());
  if (f.sameUrlInRecent.tried) out.push(`    this exact URL, among the ${f.sameUrlInRecent.listed} newest purchases: tried ${f.sameUrlInRecent.tried}, answered ${f.sameUrlInRecent.delivered}`);
  if (f.payTos.length) out.push(`    payTo recorded: ${f.payTos.join(", ")}${f.payToChanged ? " (changed)" : ""}`);
  out.push(`    page: ${f.sellerPage}`);
  return out;
}

export function formatCheck(r: CheckResult): string {
  const out = [r.summary, ""];
  if (r.found) {
    for (const f of r.sellers) out.push(...sellerText(f));
    if (r.records.published) {
      out.push(`  signed records: ${r.records.published} (${Object.entries(r.records.byVerdict).map(([k, n]) => `${k} ${n}`).join(", ")})`);
      for (const x of r.records.newest)
        out.push(`    ${x.id} ${x.verdict} ${x.resourceUrl}  ${x.json}${x.anchor?.status === "anchored" ? `  (root in Solana memo ${x.anchor.tx})` : ""}`);
    }
  }
  for (const n of r.notes) out.push(`  note: ${n}`);
  out.push(`  as of: rank.json ${r.asOf.rankDate ?? "?"} (generated ${r.asOf.rankGeneratedAt ?? "?"}), ${r.asOf.recordsPublished} signed records, days ${r.asOf.recordDays.join(", ") || "none"}`);
  return out.join("\n");
}

export async function main(argv: string[], data = new PublicData()): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  const { positional, flags } = args;
  if (flags.has("--help") || flags.has("-h")) {
    console.log(USAGE);
    return 0;
  }
  if (flags.has("--mcp") || positional[0] === "mcp") {
    await serveStdio({ data });
    return 0;
  }
  const json = flags.has("--json");
  const offline = flags.has("--offline");
  try {
    if (positional[0] === "verify") {
      const ref = positional[1];
      if (!ref) {
        console.error(USAGE);
        return 2;
      }
      const v = await verifyRecord(ref, data, { offline });
      console.log(json ? JSON.stringify(v, null, 2) : formatVerify(v));
      return v.result === "FAIL" ? 1 : 0;
    }
    const url = positional[0];
    if (!url || positional.length > 1) {
      console.error(USAGE);
      return 2;
    }
    const chain = flags.get("--chain");
    const payTo = flags.get("--pay-to");
    const r = await checkBeforePaying({ url, ...(typeof chain === "string" ? { chain } : {}), ...(typeof payTo === "string" ? { payTo } : {}) }, data);
    const newest = r.records.newest[0];
    const v = flags.has("--verify") && newest ? await verifyRecord(newest.id, data, { offline }) : null;
    if (json) console.log(JSON.stringify(v ? { ...r, newestRecordVerified: v } : r, null, 2));
    else {
      console.log(formatCheck(r));
      if (flags.has("--verify")) console.log(v ? `\nnewest signed record, verified:\n${formatVerify(v)}` : "\nno signed record to verify");
    }
    return v?.result === "FAIL" ? 1 : 0;
  } catch (e) {
    console.error(`vet402-check: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}
