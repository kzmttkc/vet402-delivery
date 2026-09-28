/**
 * Verification anyone can repeat without trusting vet402:
 *  1. schema: the record has the published shape
 *  2. signature: the EIP-712 signature recovers to the observer address the record names
 *     (and, if given, to the address the verifier expects from vet402's did:web document)
 *  3. verdict: the verdict word follows from the recorded checks by the published rule
 *  4. merkle: the record's digest is in the day's root by the attached proof
 *  5. chain (separate, needs RPC): the payment moved `amount` of `asset` from payer to payTo,
 *     and, once anchored, the root is in the anchor transaction's memo
 */
import { type Hex } from "viem";
import { decideVerdict } from "./build.js";
import { contentHash, observationDigest, recoverObserver } from "./eip712.js";
import { verifyInclusion } from "./merkle.js";
import { validateObservation } from "./schema.js";
import type { Observation } from "./types.js";

export interface OfflineResult {
  schema: { ok: boolean; errors: string[] };
  signature: { ok: boolean; recovered: string | null; detail: string };
  verdict: { ok: boolean; detail: string };
  merkle: { ok: boolean | null; detail: string };
  digest: Hex | null;
  contentHash: Hex | null;
}

export async function verifyOffline(obs: Observation, opts: { expectedSigner?: string } = {}): Promise<OfflineResult> {
  const errors = validateObservation(obs);
  const out: OfflineResult = {
    schema: { ok: errors.length === 0, errors },
    signature: { ok: false, recovered: null, detail: "" },
    verdict: { ok: false, detail: "" },
    merkle: { ok: null, detail: "" },
    digest: null,
    contentHash: null,
  };
  let digest: Hex | null = null;
  try {
    digest = observationDigest(obs);
    out.digest = digest;
    out.contentHash = contentHash(obs);
  } catch (e) {
    out.signature.detail = `cannot compute digest: ${e instanceof Error ? e.message : String(e)}`;
  }

  if (digest) {
    try {
      const rec = await recoverObserver(obs);
      out.signature.recovered = rec;
      const matchesField = rec.toLowerCase() === obs.observer.address.toLowerCase();
      const matchesExpected = opts.expectedSigner ? rec.toLowerCase() === opts.expectedSigner.toLowerCase() : null;
      out.signature.ok = matchesField && matchesExpected !== false;
      out.signature.detail = !matchesField
        ? `signature recovers to ${rec}, not the observer ${obs.observer.address} (record altered, or signed by another key)`
        : matchesExpected === false
          ? `signed by ${rec}, which is not the expected vet402 key ${opts.expectedSigner}`
          : matchesExpected === true
            ? `signed by ${rec} (the expected vet402 key)`
            : `signed by ${rec} (the observer the record names; key authorization not checked: pass --signer or --did)`;
    } catch (e) {
      out.signature.detail = `signature invalid: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  try {
    const c = obs.verdict.checks;
    const again = decideVerdict({
      paymentSettled: c.paymentSettled,
      httpStatus: c.httpStatus,
      bodyNonEmpty: c.bodyNonEmpty,
      declaredFormatMatched: c.declaredFormatMatched,
      sellerReceiptValid: c.sellerReceiptValid,
      responseHashMatchesSeller: c.responseHashMatchesSeller,
    });
    const statusAgrees = c.httpStatus === obs.response.status;
    out.verdict.ok = again.code === obs.verdict.code && statusAgrees;
    out.verdict.detail = !statusAgrees
      ? `checks.httpStatus ${c.httpStatus} differs from response.status ${obs.response.status}`
      : again.code === obs.verdict.code
        ? `${obs.verdict.code} follows from the recorded checks`
        : `the recorded checks give ${again.code}, but the record says ${obs.verdict.code}`;
  } catch (e) {
    out.verdict.detail = e instanceof Error ? e.message : String(e);
  }

  const a = obs.anchor;
  if (!a) out.merkle.detail = "not yet in a daily root";
  else if (!digest) out.merkle = { ok: false, detail: "no digest" };
  else {
    const inRoot = verifyInclusion(digest, a.proof as Hex[], a.root as Hex);
    const addrOk = a.observerAddress.toLowerCase() === obs.observer.address.toLowerCase();
    const dayOk = obs.id.slice(4, 14) === a.day;
    const seqOk = obs.observer.sequence >= a.sequenceRange[0] && obs.observer.sequence <= a.sequenceRange[1];
    out.merkle.ok = inRoot && addrOk && dayOk && seqOk;
    out.merkle.detail = !inRoot
      ? `the proof does not lead to root ${a.root}`
      : !addrOk
        ? "the root was made for a different observer key"
        : !dayOk
          ? `the record's day is not the root's day ${a.day}`
          : !seqOk
            ? "sequence outside the root's range"
            : `leaf ${a.leafIndex} of ${a.count} in the ${a.day} root (${a.status === "anchored" ? `anchored in ${a.tx}` : "root not yet written on chain"})`;
  }
  return out;
}
