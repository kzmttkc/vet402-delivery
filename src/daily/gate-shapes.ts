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
export const lower = (r: Rand, n: number) => pick(r, "abcdefghijklmnopqrstuvwxyz", n);
export const upper = (r: Rand, n: number) => pick(r, "ABCDEFGHIJKLMNOPQRSTUVWXYZ", n);
export const b32 = (r: Rand, n: number) => pick(r, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", n);
const pem = (r: Rand) => bytes(r, 120).toString("base64").match(/.{1,64}/g)!.join("\n");
const entities = (s: string) => [...s].map((c) => `&#${c.charCodeAt(0)};`).join("");
const hexEscapes = (s: string) => [...s].map((c) => "\\x" + c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
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

  // the third review's shapes (probe4)
  ["body: YAML token", (r) => withDetail(`token: ${alnum(r, 20)}`)],
  ["body: YAML password, 7 mixed", (r) => withDetail(`password: ${alnum(r, 7)}`)],
  ["body: YAML password, 12 lowercase", (r) => withDetail(`password: ${lower(r, 12)}`)],
  ["body: YAML api_key, 30 lowercase", (r) => withDetail(`api_key: ${lower(r, 30)}`)],
  ["body: token value after a newline", (r) => withDetail(`{"token":\n  "${alnum(r, 20)}"}`)],
  ["body: YAML block token: |", (r) => withDetail(`token: |\n  ${alnum(r, 20)}\n`)],
  ["body: X-Api-Key in a code block", (r) => withDetail("```\nX-Api-Key: " + alnum(r, 24) + "\n```")],
  ["body: api_key name fully unicode-escaped", (r) => withDetail(`{"\\u0061\\u0070\\u0069\\u005f\\u006b\\u0065\\u0079":"${alnum(r, 20)}"}`)],
  ["body: base32 32 under a neutral name", (r) => withDetail(`{"v":"${b32(r, 32)}"}`)],
  ["body: base32 52 under a neutral name", (r) => withDetail(`{"v":"${b32(r, 52)}"}`)],
  ["body: Authorization: and five spaces", (r) => withDetail(`Authorization:     ${alnum(r, 24)}`)],
  ["body: Authorization: Token", (r) => withDetail(`Authorization: Token ${alnum(r, 16)}`)],
  ["body: Cookie sid", (r) => withDetail(`Cookie: sid=${alnum(r, 24)}; theme=dark`)],
  ["body: Cookie with a neutral name", (r) => withDetail(`Cookie: a=${alnum(r, 24)}`)],
  ["body: Set-Cookie __Host-, lowercase", (r) => withDetail(`Set-Cookie: __Host-x=${lower(r, 24)}; Path=/`)],
  ["body: ?sig= base64url", (r) => withDetail(`https://cdn.example/f.png?sig=${b64url(r, 40)}&exp=1`)],
  ["body: X-Amz-Signature", (r) => withDetail(`https://s3.example/o?X-Amz-Signature=${hex(r, 64)}`)],
  ["body: AWS access key id", (r) => withDetail(`AKIA${b32(r, 16)}`)],
  ["body: AWS secret key", (r) => withDetail(bytes(r, 30).toString("base64"))],
  ["body: PEM body lines", (r) => withDetail(pem(r))],
  ["body: one 40-character base64 line", (r) => withDetail(bytes(r, 30).toString("base64").slice(0, 40))],
  ["body: neutral name, 32 lowercase", (r) => withDetail(`{"v":"${lower(r, 32)}"}`)],
  ["body: neutral name, 24 digits", (r) => withDetail(`{"v":"${digits(r, 24)}"}`)],
  ["row: neutral field, 24 lowercase", (r) => onRow({ ref: lower(r, 24) })],
  ["row: neutral field, 30 uppercase", (r) => onRow({ ref: upper(r, 30) })],
  ["body: tоken (Cyrillic o), lowercase", (r) => withDetail(`{"tоken":"${lower(r, 20)}"}`)],
  ["body: tоken (Cyrillic o), alnum", (r) => withDetail(`{"tоken":"${alnum(r, 20)}"}`)],
  ["body: JWT as HTML character references", (r) => withDetail(entities(jwt(r)))],
  ["body: JWT as \\x escapes", (r) => withDetail(hexEscapes(jwt(r)))],
  ["body: JWT with zero-width joiners", (r) => withDetail(jwt(r).match(/.{1,10}/g)!.join("​"))],
  ["body: backtick-quoted token", (r) => withDetail("`token`: `" + alnum(r, 20) + "`")],
  ["body: Api Key with spaces", (r) => withDetail(`Api Key  :  ${alnum(r, 20)}`)],
  ["body: token=8 lowercase in a form", (r) => withDetail(`a=1&token=${lower(r, 8)}`)],
  ["body: unicode-escaped start of a JWT value", (r) => withDetail(`"\\u0065\\u0079\\u004a${jwt(r).slice(3)}"`)],
  ["body: base64 of token=", (r) => withDetail(Buffer.from(`token=${alnum(r, 20)}`).toString("base64"))],
  ["body: base64 of password:", (r) => withDetail(Buffer.from(`password: ${lower(r, 14)}`).toString("base64"))],
  ["body: slug of four random lowercase parts", (r) => withDetail(`{"v":"${lower(r, 8)}-${lower(r, 8)}-${lower(r, 8)}-${lower(r, 8)}"}`)],
  ["body: twelve BIP-39 words", () => withDetail(`{"v":"abandon ability able about above absent absorb abstract absurd abuse access accident"}`)],
];
