/** Send the request unpaid and read what the 402 asks for. Never signs. */
import { OWN_HOSTS, PROBE_TIMEOUT_MS, USER_AGENT, atomicToUnits, tokenSymbol } from "./constants.js";
import { hasX402Offer, mppChallengesFromHeader, tempoChargeRequest, type MppChallenge } from "./challenge.js";
import type { FetchLike, PlannedRequest } from "./mercator.js";

export interface ProbeResult {
  httpStatus: number | null;
  error: string | null;
  challenges: MppChallenge[];
  x402AlsoOffered: boolean;
  /** the raw WWW-Authenticate header (kept so a later run can be compared) */
  wwwAuthenticate: string | null;
}

export function requestInit(req: PlannedRequest, extra: Record<string, string> = {}): RequestInit {
  const headers: Record<string, string> = { accept: "application/json, */*;q=0.5", "user-agent": USER_AGENT, ...extra };
  if (req.contentType) headers["content-type"] = req.contentType;
  return { method: req.method, headers, ...(req.body !== null ? { body: req.body } : {}) };
}

export function refuseUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "bad url";
  }
  if (u.protocol !== "https:") return "not https";
  const h = u.hostname.toLowerCase();
  if (OWN_HOSTS.some((o) => h === o || h.endsWith(`.${o}`))) return "own host";
  if (h === "localhost" || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.includes(":"))
    return "private address";
  return null;
}

export async function probeUnpaid(fetchImpl: FetchLike, req: PlannedRequest, timeoutMs = PROBE_TIMEOUT_MS): Promise<ProbeResult> {
  const bad = refuseUrl(req.url);
  if (bad) return { httpStatus: null, error: `refused: ${bad}`, challenges: [], x402AlsoOffered: false, wwwAuthenticate: null };
  try {
    const res = await fetchImpl(req.url, { ...requestInit(req), redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    const www = res.headers.get("www-authenticate");
    await res.body?.cancel().catch(() => undefined);
    return {
      httpStatus: res.status,
      error: null,
      challenges: mppChallengesFromHeader(www),
      x402AlsoOffered: hasX402Offer(res.headers),
      wwwAuthenticate: www,
    };
  } catch (e) {
    return { httpStatus: null, error: e instanceof Error ? e.message : String(e), challenges: [], x402AlsoOffered: false, wwwAuthenticate: null };
  }
}

/** One-line human summary of a challenge's price. */
export function priceLabel(ch: MppChallenge | null): string {
  const r = ch ? tempoChargeRequest(ch) : null;
  if (!r || !/^\d+$/.test(r.amount)) return "-";
  return `${atomicToUnits(r.amount)} ${tokenSymbol(r.currency)}`;
}
