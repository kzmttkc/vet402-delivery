/**
 * Credential shapes the secret gate must stop, as generators over a random source. The tests run them with a
 * fixed seed (test/daily.test.ts); scripts/daily/gate-trial.ts runs them with fresh randomness many times.
 * Every shape here must be stopped every time (0 passes).
 */

export type Rand = () => number;

/** A seeded random source (mulberry32): the same seed gives the same values on every machine. */
export function seeded(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const B64URL = ALNUM + "-_";
const HEX = "0123456789abcdef";
const pick = (r: Rand, set: string, n: number) => Array.from({ length: n }, () => set[Math.floor(r() * set.length)]!).join("");
export const alnum = (r: Rand, n: number) => pick(r, ALNUM, n);
export const b64url = (r: Rand, n: number) => pick(r, B64URL, n);
export const hex = (r: Rand, n: number) => pick(r, HEX, n);
export const jwt = (r: Rand) => `eyJhbGciOiJIUzI1NiJ9.${b64url(r, 54)}.${b64url(r, 27)}`;

/** A result file with one seller response body, the way remeasure writes rows. */
export const withDetail = (detail: string, field = "detail") => JSON.stringify({ kind: "x", rows: [{ host: "s.example", [field]: detail }] }, null, 2);

export const GATE_SHAPES: [string, (r: Rand) => string][] = [
  ["session_id, random 33", (r) => withDetail(`{"session_id":"Zq8${b64url(r, 30)}","ok":true}`)],
  ["api_key, 32 alnum in a body", (r) => withDetail(`{"api_key":"${alnum(r, 32)}"}`)],
  ["key, 32 alnum", (r) => withDetail(`{"key":"${alnum(r, 32)}"}`)],
  ["no name, 36 alnum", (r) => withDetail(`{"data":"${alnum(r, 36)}"}`)],
  ["key, hex 64", (r) => withDetail(`{"key":"${hex(r, 64)}"}`)],
  ["api_key, hex 64", (r) => withDetail(`{"api_key":"${hex(r, 64)}"}`)],
  ["JWT wrapped in base64", (r) => withDetail(Buffer.from(jwt(r)).toString("base64"))],
  ["JWT fully percent-encoded", (r) => withDetail([...jwt(r)].map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0")).join(""))],
  ["JWT split over two strings", (r) => { const j = jwt(r); return JSON.stringify({ rows: [{ a: j.slice(0, 8), b: j.slice(8) }] }); }],
  ["JWT split by spaces every 30", (r) => withDetail(jwt(r).match(/.{1,30}/g)!.join(" "))],
  ["no name, random 39", (r) => withDetail(`{"ref":"${b64url(r, 39)}"}`)],
  ["no name, random 24", (r) => withDetail(`{"ref":"${alnum(r, 24)}"}`)],
  ["no name, 30 letters of both cases", (r) => withDetail(`{"ref":"${pick(r, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 30)}"}`)],
  ["Authorization with a unicode-escaped space", (r) => withDetail(`{"h":"Bearer\\u0020${alnum(r, 40)}"}`)],
  ["token field JSON-escaped in a body", (r) => withDetail(`{\\"token\\":\\"${alnum(r, 32)}\\"}`)],
  ["X-Api-Key header in a body", (r) => withDetail(`x-api-key: ${alnum(r, 28)}`)],
  ["apiKey camelCase in a query", (r) => withDetail(`https://api.example.com/v1?apiKey=${alnum(r, 20)}&q=1`)],
  ["password, short", (r) => withDetail(`{"password":"${alnum(r, 9)}"}`)],
  ["client_secret, hex 32", (r) => withDetail(`{"client_secret":"${hex(r, 32)}"}`)],
  ["cookie header", (r) => withDetail(`Set-Cookie: sid=${alnum(r, 26)}; Path=/`)],
  ["random with dashes", (r) => withDetail(`{"ref":"${alnum(r, 10)}-${alnum(r, 10)}_${alnum(r, 12)}"}`)],
];
