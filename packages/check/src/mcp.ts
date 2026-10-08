/**
 * MCP server over stdio: three read-only tools over the same functions the CLI runs.
 *   check_before_paying      what vet402's public record holds about a seller, before paying it
 *   verify_record            re-check one signed record: signature, Merkle proof, payment and Solana memo anchor
 *   diagnose_failed_payment  a payment that brought no answer, read from chain, next to vet402's purchases
 *
 * Newline-delimited JSON-RPC 2.0 on stdin and stdout (the MCP stdio transport). Nothing is written to
 * stdout except protocol messages. No dependency beyond the check itself.
 */
import { createInterface } from "node:readline";
import { checkBeforePaying } from "./check.js";
import { diagnose, formatDiagnose, type DiagnoseOptions } from "./diagnose.js";
import { PublicData } from "./sources.js";
import { verdictLine } from "./verdict.js";
import { verifyRecord, type VerifyOptions } from "./verify.js";

export const SERVER_NAME = "vet402-check";
export const SERVER_VERSION = "0.2.0"; // keep equal to packages/check/package.json (test/mcp-version.test.ts)
export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export const TOOLS = [
  {
    name: "check_before_paying",
    title: "Look an x402 or MPP seller up in vet402's public record",
    description:
      "Give the URL you are about to pay (and, if you have them, the chain and the payTo from the 402). Returns what vet402's " +
      "public record holds about that seller: how many purchases vet402 made with its own money on Solana, Tempo, Base or " +
      "Algorand, how many settled, how many came back with an answer, the newest purchase with its tx, the failures counted " +
      "against the seller and the ones that are not, the grade as vet402 prints it (measuring while there are too few purchases), " +
      "the signed records published for that seller, and whether the payTo matches one vet402 recorded. If vet402 has no record " +
      "of the seller, it says so. The answer starts with a verdict (pay, avoid or unknown) and one sentence of why, from the same " +
      "numbers: pay when vet402's paid purchases came back with an answer often enough, avoid when they mostly did not (only " +
      "failures on the seller's side count), unknown when there is too little to tell. Reads public files only: no key, no payment.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The resource URL about to be paid" },
        chain: { type: "string", description: "solana, tempo, base, algorand, or a CAIP-2 id such as eip155:8453" },
        pay_to: { type: "string", description: "The payTo (recipient) in the 402 you hold" },
        verify_newest_record: { type: "boolean", description: "Also verify the newest signed record of this seller (signature, Merkle proof, payment and anchor on chain)" },
        amount: { type: "string", description: "The amount in the 402, in atomic units; compared with what vet402 paid for this URL (reason price_jump)" },
        asset: { type: "string", description: "The asset in the 402 (mint or token address); compared with the assets vet402 paid this seller in (reason asset_unseen)" },
        explain: { type: "boolean", description: "Also list the purchases the answer rests on, with date and tx" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "verify_record",
    title: "Verify one vet402 signed record",
    description:
      "Give a record id (obs_YYYY-MM-DD_NNNNNN) or the https URL of a published record. Checks, without taking vet402's word for it: the " +
      "bytes are the ones the records index lists, the signer is a vet402 observation key, the EIP-712 signature, that the " +
      "verdict follows from the recorded checks, the Merkle proof to the day's root, the payment on chain over public RPC, " +
      "and the day's root in a Solana memo sent by vet402's anchor wallet. Result: OK, OK_NOT_ANCHORED, OK_OFFLINE or FAIL, " +
      "with one line per check.",
    inputSchema: {
      type: "object",
      properties: {
        record: { type: "string", description: "Record id (obs_2026-09-28_000164) or https URL of a record JSON" },
        offline: { type: "boolean", description: "Skip the reads from chain (payment and anchor)" },
      },
      required: ["record"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
  {
    name: "diagnose_failed_payment",
    title: "Diagnose an x402 payment that brought no answer",
    description:
      "Give the transaction of a payment you made (a Solana signature or a Base tx hash), the URL you paid and, if you have it, the " +
      "HTTP status the seller answered. Reads the payment from public RPC (settled or not, payTo, amount, asset, time) and puts it " +
      "next to vet402's own purchases from the same seller on the same chain within 24 hours. Returns fault: seller_side, " +
      "facilitator_side, buyer_side or undetermined, with reasons. seller_side needs a settled payment to a payTo vet402 paid this " +
      "seller, a status vet402's rules put on the seller, and vet402's own paid purchases in the window failing too with none " +
      "delivered; anything less is undetermined. For seller_side it adds an evidence pack (JSON and Markdown) to hand to the " +
      "seller; nothing is sent. Reads public data only: no key, no payment.",
    inputSchema: {
      type: "object",
      properties: {
        tx: { type: "string", description: "Solana transaction signature or Base tx hash of the payment" },
        url: { type: "string", description: "The URL that was paid" },
        chain: { type: "string", description: "solana or base (default: from the shape of tx)" },
        status: { type: "integer", description: "The HTTP status the seller answered after the payment" },
      },
      required: ["tx", "url"],
      additionalProperties: false,
    },
    annotations: READ_ONLY,
  },
] as const;

type Json = Record<string, unknown>;

export interface ServerOptions {
  data?: PublicData;
  verify?: VerifyOptions;
  diagnose?: DiagnoseOptions;
}

function text(t: string, structured: unknown, isError = false): Json {
  return { content: [{ type: "text", text: t }], structuredContent: structured, ...(isError ? { isError: true } : {}) };
}

async function callTool(name: string, args: Json, opts: Required<Pick<ServerOptions, "data">> & ServerOptions): Promise<Json> {
  const str = (k: string): string | undefined => (typeof args[k] === "string" && (args[k] as string).trim() ? (args[k] as string) : undefined);
  try {
    if (name === "check_before_paying") {
      const url = str("url");
      if (!url) return text("url is required", { error: "url is required" }, true);
      const result = await checkBeforePaying(
        {
          url,
          ...(str("chain") ? { chain: str("chain")! } : {}),
          ...(str("pay_to") ? { payTo: str("pay_to")! } : {}),
          ...(str("amount") ? { amount: str("amount")! } : {}),
          ...(str("asset") ? { asset: str("asset")! } : {}),
          ...(args.explain === true ? { explain: true } : {}),
        },
        opts.data,
      );
      let verified: unknown = null;
      let extra = "";
      if (args.verify_newest_record === true && result.records.newest[0]) {
        const v = await verifyRecord(result.records.newest[0].id, opts.data, opts.verify);
        verified = v;
        extra = ` Newest record ${v.id} verified: ${v.result}.`;
      }
      const out = verified ? { ...result, newestRecordVerified: verified } : result;
      const reasons = result.reasons.length ? `\nreasons: ${result.reasons.map((r) => `${r.reason} (${r.detail})`).join("; ")}` : "";
      return text(`${verdictLine(result)}\n${result.summary}${extra}${reasons}\n\n${JSON.stringify(out, null, 2)}`, out);
    }
    if (name === "diagnose_failed_payment") {
      const tx = str("tx");
      const url = str("url");
      if (!tx || !url) return text("tx and url are required", { error: "tx and url are required" }, true);
      const status = typeof args.status === "number" ? args.status : typeof args.status === "string" && /^\d{3}$/.test(args.status) ? Number(args.status) : undefined;
      const d = await diagnose({ tx, url, ...(str("chain") ? { chain: str("chain")! } : {}), ...(status !== undefined ? { status } : {}) }, opts.data, opts.diagnose);
      return text(formatDiagnose(d), d);
    }
    if (name === "verify_record") {
      const record = str("record");
      if (!record) return text("record is required", { error: "record is required" }, true);
      if (!/^obs_\d{4}-\d{2}-\d{2}_\d{6}$/.test(record) && !/^https:\/\//i.test(record)) return text("record must be a record id or an https URL", { error: "bad record" }, true);
      const v = await verifyRecord(record, opts.data, { ...opts.verify, ...(args.offline === true ? { offline: true } : {}) });
      const lines = v.lines.map((l) => `${l.ok === true ? "OK  " : l.ok === false ? "FAIL" : "--  "} ${l.check}: ${l.detail}`).join("\n");
      return text(`${v.id ?? record} ${v.verdict ?? ""}: ${v.result}\n${lines}${v.unproven ? `\n${v.unproven}` : ""}`, v, v.result === "FAIL");
    }
    return text(`unknown tool ${name}`, { error: "unknown tool" }, true);
  } catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    return text(`vet402-check could not answer: ${m}`, { error: m }, true);
  }
}

/** Answer one JSON-RPC message; null for notifications. */
export async function handleMessage(msg: unknown, opts: ServerOptions = {}): Promise<Json | null> {
  const data = opts.data ?? new PublicData();
  if (typeof msg !== "object" || msg === null || (msg as Json).jsonrpc !== "2.0") return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
  const m = msg as Json;
  const hasId = "id" in m && m.id !== undefined;
  const id = hasId ? m.id : null;
  const method = typeof m.method === "string" ? m.method : "";
  if (!hasId) return null; // notifications (notifications/initialized, cancelled, ...) need no answer
  const ok = (result: unknown): Json => ({ jsonrpc: "2.0", id, result });
  const params = (typeof m.params === "object" && m.params !== null ? m.params : {}) as Json;
  switch (method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions:
          "Call check_before_paying with the URL before paying an x402 or MPP endpoint. It returns facts from vet402's public record; the decision is yours. " +
          "After a payment that brought no answer, call diagnose_failed_payment with its transaction and the URL.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (typeof params.arguments === "object" && params.arguments !== null ? params.arguments : {}) as Json;
      return ok(await callTool(name, args, { ...opts, data }));
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

/** Serve on stdin and stdout until stdin closes. */
export async function serveStdio(opts: ServerOptions = {}): Promise<void> {
  const data = opts.data ?? new PublicData();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (m: Json): void => void process.stdout.write(`${JSON.stringify(m)}\n`);
  const pending: Promise<void>[] = [];
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    const p = handleMessage(msg, { ...opts, data }).then((r) => {
      if (r) write(r);
    });
    pending.push(p);
  }
  await Promise.all(pending);
}
