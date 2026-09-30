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
export const digits = (r: Rand, n: number) => pick(r, "0123456789", n);
export const bytes = (r: Rand, n: number) => Buffer.from(Array.from({ length: n }, () => Math.floor(r() * 256)));
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export const base58 = (b: Buffer) => {
  let n = BigInt("0x" + b.toString("hex"));
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  return s;
};
/** A result file with extra fields on the row itself (vet402's own format, not a body). */
export const onRow = (o: object) => JSON.stringify({ kind: "x", rows: [{ host: "s.example", ...o }] }, null, 2);

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

  // the second review's shapes (probe3)
  ["body: secret name over an array", (r) => withDetail(`{"token":["${alnum(r, 20)}"]}`)],
  ["body: secret name over an object", (r) => withDetail(`{"token":{"value":"${alnum(r, 20)}"}}`)],
  ["body: array of objects with a token", (r) => withDetail(`{"data":[{"token":"${alnum(r, 32)}"}]}`)],
  ["body: token as a bare number", (r) => withDetail(`{"token":${digits(r, 20)}}`)],
  ["body: token as a numeric string", (r) => withDetail(`{"token":"${digits(r, 20)}"}`)],
  ["row: token as a number", (r) => onRow({ token: Number(digits(r, 15)) })],
  ["row: token over an array", (r) => onRow({ token: [alnum(r, 20)] })],
  ["row: api_key over an object", (r) => onRow({ api_key: { v: alnum(r, 20) } })],
  ["body: TOKEN= upper case", (r) => withDetail(`TOKEN=${alnum(r, 20)}`)],
  ["body: unicode-escaped name", (r) => withDetail(`{"\\u0074oken":"${alnum(r, 20)}"}`)],
  ["body: base64url of a JWT", (r) => withDetail(Buffer.from(jwt(r)).toString("base64url"))],
  ["body: access_token in a query", (r) => withDetail(`https://x.example/cb?access_token=${alnum(r, 20)}&x=1`)],
  ["body: access_token in a fragment", (r) => withDetail(`https://x.example/cb#access_token=${alnum(r, 20)}&x=1`)],
  ["body: access_token 30 in a fragment", (r) => withDetail(`https://x.example/cb#access_token=${alnum(r, 30)}`)],
  ["body: a key split over two neutral names", (r) => withDetail(`{"a":"${alnum(r, 16)}","b":"${alnum(r, 16)}"}`)],
  ["body: name token2", (r) => withDetail(`{"token2":"${alnum(r, 20)}"}`)],
  ["body: name tokenValue", (r) => withDetail(`{"tokenValue":"${alnum(r, 20)}"}`)],
  ["body: name secret_value", (r) => withDetail(`{"secret_value":"${alnum(r, 20)}"}`)],
  ["body: name pk, hex 64", (r) => withDetail(`{"pk":"${hex(r, 64)}"}`)],
  ["body: name private, hex 64", (r) => withDetail(`{"private":"${hex(r, 64)}"}`)],
  ["body: name seed, hex 64", (r) => withDetail(`{"seed":"${hex(r, 64)}"}`)],
  ["body: name wallet, a 64-byte base58 secret key", (r) => withDetail(`{"wallet":"${base58(bytes(r, 64))}"}`)],
  ["body: no name, 64 bytes of base58", (r) => withDetail(base58(bytes(r, 64)))],
  ["body: no name, hex 64", (r) => withDetail(hex(r, 64))],
  ["body: no name, base64 of 32 bytes", (r) => withDetail(bytes(r, 32).toString("base64"))],
  ["body: no name, 20.20 random", (r) => withDetail(`${alnum(r, 20)}.${alnum(r, 20)}`)],
  ["body: no name, 20/20 random", (r) => withDetail(`${alnum(r, 20)}/${alnum(r, 20)}`)],
  ["body: no name, 23 alnum", (r) => withDetail(alnum(r, 23))],
  ["body: token = value (code)", (r) => withDetail(`token = ${alnum(r, 20)}`)],
  ["body: <token>value</token>", (r) => withDetail(`<token>${alnum(r, 20)}</token>`)],
  ["body: data-token attribute", (r) => withDetail(`<div data-token="${alnum(r, 20)}">`)],
  ["body: X-Auth-Token:value", (r) => withDetail(`X-Auth-Token:${alnum(r, 20)}`)],
  ["body: Authorization: Basic", (r) => withDetail(`Authorization: Basic ${Buffer.from("admin:" + alnum(r, 12)).toString("base64")}`)],
  ["body: user:password in a URL", (r) => withDetail(`https://admin:${alnum(r, 16)}@db.example.com/x`)],
  ["body: double-escaped token", (r) => withDetail(`{\\\\\\"token\\\\\\":\\\\\\"${alnum(r, 20)}\\\\\\"}`)],
  ["body: percent-encoded name", (r) => withDetail(`q=1&token%3D${alnum(r, 20)}`)],
  ["body: JWT percent-encoded twice", (r) => withDetail(encodeURIComponent(encodeURIComponent(jwt(r))))],
  ["body: JWT reversed", (r) => withDetail([...jwt(r)].reverse().join(""))],
  ["body: JWT as hex", (r) => withDetail(Buffer.from(jwt(r)).toString("hex"))],
  ["body: the first 12 characters of a JWT", (r) => withDetail(jwt(r).slice(0, 12))],
  ["body: lowercase bearer after a tab", (r) => withDetail(`authorization:\tbearer ${alnum(r, 20)}`)],
  ["body: YAML api_key", (r) => withDetail(`api_key: ${alnum(r, 20)}`)],
  ["body: name with a space", (r) => withDetail(`{"api key":"${alnum(r, 20)}"}`)],
  ["row: x-api-key", (r) => onRow({ "x-api-key": alnum(r, 20) })],
  ["row: otp, 12 digits", (r) => onRow({ otp: digits(r, 12) })],
  ["body: a name longer than 49 characters", (r) => withDetail(`{"${"a".repeat(50)}_token":"${alnum(r, 20)}"}`)],
  ["body: pk_live_", (r) => withDetail(`pk_live_${alnum(r, 24)}`)],
  ["body: sk_test_", (r) => withDetail(`sk_test_${alnum(r, 24)}`)],
  ["body: glpat-", (r) => withDetail(`glpat-${alnum(r, 20)}`)],
  ["body: npm_", (r) => withDetail(`npm_${alnum(r, 36)}`)],
];
