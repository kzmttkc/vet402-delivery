/**
 * The proof behind a feedback: a vet402 x402-observation record of the purchase. The record is the
 * feedback file; feedback_uri is its public URL and feedback_file_hash the sha256 of its bytes (the
 * same sha256 that data/records/index.json lists). Reads files and fetches the public URL; writes nothing.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Hex, publishedObserverKey, type LoadedRecords } from "../receipt/publish.js";
import type { Observation } from "../receipt/types.js";
import { verifyOffline } from "../receipt/verify.js";
import { recordUri } from "./plan.js";

export interface RecordFound {
  id: string;
  day: string;
  published: boolean;
  text: string;
  obs: Observation;
  sha256: string;
  /** sha256 listed in data/records/index.json (published records only). */
  indexSha256: string | null;
  uri: string;
}

/** The latest published record of any of these purchase txs. */
export function publishedRecordFor(loaded: LoadedRecords, txs: string[]): RecordFound | null {
  const want = new Set(txs);
  const hits = loaded.records.filter((r) => want.has(r.obs.payment.transaction)).sort((a, b) => b.entry.sequence - a.entry.sequence || b.entry.day.localeCompare(a.entry.day));
  const h = hits[0];
  if (!h) return null;
  return { id: h.entry.id, day: h.entry.day, published: true, text: h.text, obs: h.obs, sha256: sha256Hex(h.text), indexSha256: h.entry.sha256, uri: recordUri(h.entry.id) };
}

/**
 * The latest record of any of these txs in a local receipts build (results/receipts/<day>/obs_*.json),
 * published or not. Used to name the record that would have to be published, and for a simulation.
 */
export function localRecordFor(receiptsDir: string, txs: string[]): RecordFound | null {
  if (!existsSync(receiptsDir)) return null;
  const want = new Set(txs);
  let best: RecordFound | null = null;
  for (const day of readdirSync(receiptsDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()) {
    for (const f of readdirSync(join(receiptsDir, day)).filter((x) => /^obs_\d{4}-\d{2}-\d{2}_\d{6}\.json$/.test(x)).sort()) {
      const text = readFileSync(join(receiptsDir, day, f), "utf8");
      const obs = JSON.parse(text) as Observation;
      if (!want.has(obs.payment.transaction)) continue;
      best = { id: obs.id, day, published: false, text, obs, sha256: sha256Hex(text), indexSha256: null, uri: recordUri(obs.id) };
    }
  }
  return best;
}

export async function recordVerifies(obs: Observation): Promise<boolean> {
  const key = publishedObserverKey(obs.observer.address);
  if (!key) return false;
  const v = await verifyOffline(obs, { expectedSigner: key });
  return v.schema.ok && v.signature.ok && v.verdict.ok && v.merkle.ok === true;
}

export interface Fetched {
  ok: boolean;
  status: number | null;
  sha256: string | null;
  bytes: number | null;
  detail: string;
}

/** GET the public URI (redirects followed) and hash exactly the bytes that came back. */
export async function fetchRecord(uri: string, fetchImpl: typeof fetch = fetch): Promise<Fetched> {
  try {
    const res = await fetchImpl(uri, { redirect: "follow", signal: AbortSignal.timeout(20_000), headers: { "cache-control": "no-cache" } });
    const buf = Buffer.from(await res.arrayBuffer());
    if (res.status !== 200) return { ok: false, status: res.status, sha256: null, bytes: buf.length, detail: `HTTP ${res.status}` };
    return { ok: true, status: 200, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length, detail: "HTTP 200" };
  } catch (e) {
    return { ok: false, status: null, sha256: null, bytes: null, detail: e instanceof Error ? e.message.slice(0, 200) : String(e) };
  }
}
