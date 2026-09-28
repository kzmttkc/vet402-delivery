/**
 * Reading an MPP 402 without paying it.
 *
 * MPP puts each offer in a `WWW-Authenticate: Payment ...` challenge (https://mpp.dev).
 * A server may send several (one per method/intent); `Headers.get` joins repeated headers
 * with ", ", so the parser splits on scheme tokens rather than on commas.
 *
 * This file only parses. Deciding whether an offer may be paid is guard.ts.
 */
import { normAddr } from "./constants.js";

export interface TempoChargeRequest {
  amount: string;
  currency: string;
  recipient: string | null;
  chainId: number | null;
  /** true only when the challenge says the server sponsors the Tempo fee. */
  feePayer: boolean;
  splits: unknown[];
  supportedModes: string[];
  description: string | null;
}

export interface MppChallenge {
  scheme: string;
  params: Record<string, string>;
  id: string | null;
  realm: string | null;
  method: string | null;
  intent: string | null;
  expires: string | null;
  /** Decoded `request` (base64url JSON). null when absent or undecodable. */
  request: Record<string, unknown> | null;
  requestError: string | null;
}

const TCHAR = /[A-Za-z0-9!#$%&'*+.^_`|~-]/;

/** Split an RFC 9110 challenge list into challenges with their auth-params. */
export function parseWwwAuthenticate(header: string): { scheme: string; params: Record<string, string> }[] {
  const out: { scheme: string; params: Record<string, string> }[] = [];
  let i = 0;
  const n = header.length;
  const skip = () => {
    while (i < n && (header[i] === " " || header[i] === "\t" || header[i] === ",")) i++;
  };
  const readToken = (): string => {
    const s = i;
    while (i < n && TCHAR.test(header[i]!)) i++;
    return header.slice(s, i);
  };
  let cur: { scheme: string; params: Record<string, string> } | null = null;
  while (i < n) {
    skip();
    if (i >= n) break;
    const tok = readToken();
    if (!tok) {
      i++; // unexpected character: step over it
      continue;
    }
    let j = i;
    while (j < n && (header[j] === " " || header[j] === "\t")) j++;
    if (header[j] === "=") {
      // auth-param
      i = j + 1;
      while (i < n && (header[i] === " " || header[i] === "\t")) i++;
      let value = "";
      if (header[i] === '"') {
        i++;
        while (i < n && header[i] !== '"') {
          if (header[i] === "\\" && i + 1 < n) i++;
          value += header[i];
          i++;
        }
        i++; // closing quote
      } else {
        const s = i;
        while (i < n && header[i] !== "," && header[i] !== " " && header[i] !== "\t") i++;
        value = header.slice(s, i);
      }
      if (cur) cur.params[tok.toLowerCase()] = value;
    } else {
      cur = { scheme: tok, params: {} };
      out.push(cur);
    }
  }
  return out;
}

export function decodeBase64UrlJson(s: string): Record<string, unknown> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const text = Buffer.from(b64 + pad, "base64").toString("utf8");
  const v: unknown = JSON.parse(text);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("request is not a JSON object");
  return v as Record<string, unknown>;
}

/** All `Payment` challenges in a 402's WWW-Authenticate header(s). */
export function mppChallengesFromHeader(header: string | null): MppChallenge[] {
  if (!header) return [];
  return parseWwwAuthenticate(header)
    .filter((c) => c.scheme.toLowerCase() === "payment")
    .map((c) => {
      let request: Record<string, unknown> | null = null;
      let requestError: string | null = null;
      if (c.params.request) {
        try {
          request = decodeBase64UrlJson(c.params.request);
        } catch (e) {
          requestError = e instanceof Error ? e.message : String(e);
        }
      } else {
        requestError = "missing request";
      }
      return {
        scheme: c.scheme,
        params: c.params,
        id: c.params.id ?? null,
        realm: c.params.realm ?? null,
        method: c.params.method ?? null,
        intent: c.params.intent ?? null,
        expires: c.params.expires ?? null,
        request,
        requestError,
      };
    });
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * The charge request of a tempo challenge, normalised. Accepts both the wire shape
 * (`methodDetails.chainId`) and a flat shape (`chainId` at the top), as mppx does.
 */
export function tempoChargeRequest(ch: MppChallenge): TempoChargeRequest | null {
  const r = ch.request;
  if (!r) return null;
  const md = asRecord(r.methodDetails) ?? {};
  const chainRaw = md.chainId ?? r.chainId;
  const chainId = typeof chainRaw === "number" ? chainRaw : typeof chainRaw === "string" && /^\d+$/.test(chainRaw) ? Number(chainRaw) : null;
  const fp = md.feePayer ?? r.feePayer;
  const splits = Array.isArray(md.splits) ? md.splits : Array.isArray(r.splits) ? r.splits : [];
  const modes = Array.isArray(md.supportedModes) ? md.supportedModes : Array.isArray(r.supportedModes) ? r.supportedModes : [];
  return {
    amount: String(r.amount ?? ""),
    currency: normAddr(r.currency),
    recipient: typeof r.recipient === "string" ? r.recipient : null,
    chainId,
    // mppx folds feePayer the same way: true, or a non-null object (a sponsor account), means sponsored.
    feePayer: fp === true || (fp !== null && typeof fp === "object"),
    splits,
    supportedModes: modes.map(String),
    description: typeof r.description === "string" ? r.description : null,
  };
}

/** x402 offers ride in `payment-required` (v2) — recorded so the census can say "also x402", never paid here. */
export function hasX402Offer(headers: Headers): boolean {
  return headers.has("payment-required") || headers.has("x-payment-required");
}
