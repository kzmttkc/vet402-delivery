/**
 * verify_record: re-check one published signed record without trusting vet402.
 *
 * The same checks as scripts/verify-receipt.ts, from the same code in src/receipt/: the signer is one of
 * vet402's published keys, the EIP-712 signature, the verdict follows from the recorded checks, the
 * Merkle proof leads to the day's root, the payment on chain (Solana, Base or Tempo, over public RPC),
 * and the root in a memo sent by vet402's anchor wallet on Solana. One more check here: the bytes read
 * are the bytes the records index lists (sha256), and the index names the same root for that day.
 */
import { createHash } from "node:crypto";
import { jsonRpc, type Rpc } from "../../../src/chain.js";
import { checkAnchorOnChain, checkPayment, DEFAULT_RPC, findDayAnchors, memoMatches } from "../../../src/receipt/chain.js";
import { VET402_OBSERVER_KEYS } from "../../../src/receipt/observers.js";
import type { Observation } from "../../../src/receipt/types.js";
import { verifyOffline } from "../../../src/receipt/verify.js";
import { readRecordsIndex } from "./check.js";
import { type PublicData, RECORD_ID } from "./sources.js";

export interface VerifyLine {
  check: "read" | "index" | "key" | "schema" | "signature" | "verdict" | "merkle" | "payment" | "anchor" | "response";
  /** true passed, false failed, null not decided here (skipped, or nothing to check yet). */
  ok: boolean | null;
  detail: string;
}

export interface VerifyResult {
  kind: "vet402-verify-record";
  version: 0;
  id: string | null;
  location: string;
  verdict: string | null;
  resourceUrl: string | null;
  network: string | null;
  tx: string | null;
  /** OK: every check passed and the day's root is on chain from vet402's anchor wallet. */
  result: "OK" | "OK_NOT_ANCHORED" | "OK_OFFLINE" | "FAIL";
  lines: VerifyLine[];
  /** What an OK_NOT_ANCHORED or OK_OFFLINE result leaves unproven. */
  unproven: string | null;
}

export interface VerifyOptions {
  /** Skip the payment and anchor reads (no RPC). */
  offline?: boolean;
  /** RPC per CAIP-2 network. Default: SOLANA_RPC_URL, BASE_RPC_URL, TEMPO_RPC_URL or the public endpoints. */
  rpcFor?: (network: string) => Rpc;
}

const UNPROVEN =
  "Until the day's root is on chain, this does not show that the record belongs to the day vet402 committed to, or that it existed at that time. The merkle line only shows that the proof and the root inside this record agree.";

const OFFLINE = "Offline: the payment and the day's root were not read from chain, so neither is shown here.";

function fail(location: string, detail: string, lines: VerifyLine[] = []): VerifyResult {
  return {
    kind: "vet402-verify-record",
    version: 0,
    id: null,
    location,
    verdict: null,
    resourceUrl: null,
    network: null,
    tx: null,
    result: "FAIL",
    lines: [...lines, { check: "read", ok: false, detail }],
    unproven: null,
  };
}

/** Verify one record: a record id (obs_YYYY-MM-DD_NNNNNN), an https URL of a record, or a local file. */
export async function verifyRecord(ref: string, data: PublicData, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const rpcFor = opts.rpcFor ?? ((n: string) => jsonRpc(DEFAULT_RPC[n] ?? ""));
  let location = ref;
  let text: string;
  try {
    ({ location, text } = await data.recordText(ref));
  } catch (e) {
    return fail(location, e instanceof Error ? e.message : String(e));
  }
  let obs: Observation;
  try {
    obs = JSON.parse(text) as Observation;
    if (typeof obs !== "object" || obs === null || typeof (obs as { id?: unknown }).id !== "string") throw new Error("not a record");
  } catch (e) {
    return fail(location, `not a record: ${e instanceof Error ? e.message : String(e)}`);
  }
  const lines: VerifyLine[] = [];

  // The published bytes against the records index.
  if (RECORD_ID.test(obs.id)) {
    try {
      const index = readRecordsIndex(await data.recordsIndex());
      const e = index.entries.find((x) => x.id === obs.id);
      const sha = createHash("sha256").update(text, "utf8").digest("hex");
      if (!e) lines.push({ check: "index", ok: null, detail: `${obs.id} is not listed in the records index (${data.sources.recordsIndex})` });
      else if (e.sha256 !== sha) lines.push({ check: "index", ok: false, detail: `sha256 ${sha} differs from the index's ${e.sha256}` });
      else {
        const d = index.days.get(e.day);
        const rootOk = !obs.anchor || !d || d.root.toLowerCase() === obs.anchor.root.toLowerCase();
        lines.push(
          rootOk
            ? { check: "index", ok: true, detail: `sha256 ${sha} is the one the records index lists${d ? `; the index names the same ${e.day} root` : ""}` }
            : { check: "index", ok: false, detail: `the index names root ${d!.root} for ${e.day}, the record ${obs.anchor!.root}` },
        );
      }
    } catch (e) {
      lines.push({ check: "index", ok: null, detail: `records index not read: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  const known = VET402_OBSERVER_KEYS.find((k) => k.toLowerCase() === String(obs.observer?.address).toLowerCase());
  lines.push(
    known
      ? { check: "key", ok: true, detail: `${known} is a vet402 observation key (src/receipt/observers.ts)` }
      : { check: "key", ok: false, detail: `${String(obs.observer?.address)} is not a vet402 observation key` },
  );
  let off: Awaited<ReturnType<typeof verifyOffline>>;
  try {
    off = await verifyOffline(obs, known ? { expectedSigner: known } : {});
  } catch (e) {
    return fail(location, `cannot check the record: ${e instanceof Error ? e.message : String(e)}`, lines);
  }
  lines.push({ check: "schema", ok: off.schema.ok, detail: off.schema.ok ? "matches x402-observation/v0" : off.schema.errors.join("; ") });
  lines.push({ check: "signature", ok: off.signature.ok, detail: off.signature.detail });
  lines.push({ check: "verdict", ok: off.verdict.ok, detail: off.verdict.detail });
  lines.push({ check: "merkle", ok: off.merkle.ok, detail: off.merkle.detail });

  let anchorOnChain = false;
  if (opts.offline) {
    lines.push({ check: "payment", ok: null, detail: "skipped (offline)" });
    lines.push({ check: "anchor", ok: null, detail: "skipped (offline)" });
  } else {
    try {
      const p = await checkPayment(obs, rpcFor);
      lines.push({ check: "payment", ok: p.ok, detail: `${obs.payment.network} ${obs.payment.transaction}: ${p.detail}` });
    } catch (e) {
      lines.push({ check: "payment", ok: false, detail: `could not read chain: ${e instanceof Error ? e.message : String(e)}` });
    }
    try {
      const a = await checkAnchorOnChain(obs, rpcFor);
      if (a) {
        lines.push({ check: "anchor", ok: a.ok, detail: a.detail });
        anchorOnChain = a.ok;
      } else if (obs.anchor && obs.anchor.network.startsWith("solana:")) {
        const anc = obs.anchor;
        const look = await findDayAnchors(rpcFor(anc.network), anc.day);
        const match = look.found.find((f) => memoMatches(f.memo, anc) === null);
        if (match) {
          lines.push({ check: "anchor", ok: true, detail: `the record says pending, but vet402's memo for ${anc.day} (${match.signature}) holds this root` });
          anchorOnChain = true;
        } else if (look.found.length) {
          lines.push({ check: "anchor", ok: false, detail: `vet402 wrote a different root for ${anc.day} (${look.found.map((f) => f.signature).join(", ")}): ${memoMatches(look.found[0]!.memo, anc)}` });
        } else {
          lines.push({
            check: "anchor",
            ok: null,
            detail: look.complete ? `no vet402 memo for ${anc.day} on chain yet (root not yet written)` : `vet402's memo history was not read back to ${anc.day}; could not tell whether the root is written`,
          });
        }
      } else {
        lines.push({ check: "anchor", ok: null, detail: "the record is not in a daily root" });
      }
    } catch (e) {
      lines.push({ check: "anchor", ok: false, detail: `could not read chain: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  lines.push({
    check: "response",
    ok: null,
    detail: obs.response?.responseHash
      ? `responseHash ${obs.response.responseHash}: recompute it from the body you hold (${obs.response.responseHashEncoding})`
      : `responseHash: ${obs.response?.responseHashNote ?? "not recorded"}`,
  });

  const failed = lines.some((l) => l.ok === false);
  const result: VerifyResult["result"] = failed ? "FAIL" : anchorOnChain ? "OK" : opts.offline ? "OK_OFFLINE" : "OK_NOT_ANCHORED";
  return {
    kind: "vet402-verify-record",
    version: 0,
    id: obs.id,
    location,
    verdict: obs.verdict?.code ?? null,
    resourceUrl: obs.resourceUrl ?? null,
    network: obs.payment?.network ?? null,
    tx: obs.payment?.transaction ?? null,
    result,
    lines,
    unproven: result === "OK_NOT_ANCHORED" ? UNPROVEN : result === "OK_OFFLINE" ? OFFLINE : null,
  };
}

/** The result as text lines, the same layout as scripts/verify-receipt.ts. */
export function formatVerify(r: VerifyResult): string {
  const out = [`${r.id ?? "?"}  ${r.verdict ?? "?"}  ${r.resourceUrl ?? r.location}`];
  for (const l of r.lines) out.push(`${l.ok === true ? "OK  " : l.ok === false ? "FAIL" : "--  "} ${l.check.padEnd(10)} ${l.detail}`);
  out.push(
    r.result === "FAIL"
      ? "RESULT: FAIL"
      : r.result === "OK"
        ? "RESULT: OK (every check passed; the day's root is on chain from vet402's anchor wallet)"
        : r.result === "OK_OFFLINE"
          ? "RESULT: OK (offline: payment and anchor not checked)"
          : "RESULT: OK (not yet anchored)",
  );
  if (r.unproven) out.push(r.unproven);
  return out.join("\n");
}
