/**
 * The public site (site/) and its inputs (data/):
 *  - seller-controlled strings are escaped on every page
 *  - a rank number only goes to sellers with MIN_COUNTED counted purchases on MIN_DAYS days
 *  - npm run rank -- --data data reproduces site/rank.json (apart from generatedAt)
 *  - data/ and site/ hold no secrets
 *  - the pages' own wording: no we/us/our, no Japanese, no em dash
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PUBLIC_LEAD, renderPublicSite } from "../src/rank/html.js";
import { buildReport, type RankReport } from "../src/rank/report.js";
import { MIN_COUNTED, MIN_DAYS } from "../src/rank/score.js";
import type { Attempt } from "../src/rank/types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOL_SIG = "5t3ZLiqDAE8GLrhCGkJnEwTftj73yhZxEWMT3LqVVxqTHUjGG31X8DYmBMHMNLTypK1b1kYZZ8vTWhemgECkJq6u";
const DAY1 = "2026-09-27T04:00:00.000Z";
const DAY2 = "2026-09-28T04:00:00.000Z";

function att(over: Partial<Attempt>): Attempt {
  return {
    chain: "solana",
    source: "t",
    host: "h.example",
    service: null,
    url: "https://h.example/x",
    payTo: "P",
    expectedPayTo: null,
    at: DAY2,
    tried: true,
    settled: true,
    delivered: true,
    category: "delivered",
    rawReason: "delivered",
    detail: null,
    tx: SOL_SIG,
    priceUsdc: "0.001000",
    httpStatus: 200,
    declaredMatch: null,
    bodyChecked: true,
    feedbackTx: null,
    ...over,
  };
}
const fail = (over: Partial<Attempt>) => att({ delivered: false, category: "settled_error_status", settled: true, httpStatus: 500, rawReason: "http_error", ...over });
const series = (host: string, n: number, days = [DAY1, DAY2]): Attempt[] => Array.from({ length: n }, (_, i) => att({ host, at: days[i % days.length]! }));

function report(attempts: Attempt[]): RankReport {
  return buildReport({ date: "2026-09-28", generatedAt: "2026-09-28T00:00:00.000Z", attempts, excludeHosts: [], cdp: null, mercator: null, inputs: [] });
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

/** The text a reader sees, without tags and without strings that came from sellers (hosts, URLs, runner output). */
function ownWording(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>/g, " ")
    .replace(/<a [^>]*href="(?:seller\/|\.\.\/|https:\/\/[^"]*\/tx\/)[^"]*"[^>]*>[\s\S]*?<\/a>/g, " ")
    .replace(/<(h1|span|div|b)[^>]*class="[^"]*\b(mono)\b[^"]*"[^>]*>[\s\S]*?<\/\1>/g, " ")
    .replace(/<h1>[\s\S]*?<\/h1>/, (h) => (h.includes("vet402") || h.includes("How") ? h : " "))
    .replace(/<title>[\s\S]*?<\/title>/, " ")
    .replace(/<meta name="description"[^>]*>/, " ")
    .replace(/<[^>]+>/g, " ");
}

test("site: a seller name with <script> is shown as text on every page", () => {
  const evil = `<script>alert(1)</script>`;
  const evilHost = `x.example"><script>alert(1)</script>`;
  const r = report([
    ...series(evilHost, 12).map((a) => ({ ...a, url: `https://x.example/${evil}` })),
    fail({ host: evilHost, url: `https://x.example/${evil}`, rawReason: evil, detail: `{"e":"${evil}"}`, tx: `x${evil}`, at: DAY1 }),
    att({ host: `m.example${evil}`, at: DAY1 }),
  ]);
  const pages = renderPublicSite(r);
  assert.equal(pages.size, 2 + r.ranking.length);
  for (const [path, html] of pages) {
    assert.match(path, /^(index|method)\.html$|^seller\/[a-z0-9._-]+\.html$/, path);
    assert.ok(!html.includes("<script"), `${path}: no script tag survives`);
    assert.ok(!html.includes('example"><'), `${path}: no attribute breakout`);
    assert.ok(html.includes("script-src 'none'"), `${path}: CSP forbids scripts`);
  }
  const index = pages.get("index.html")!;
  assert.ok(index.includes("x.example&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"), "escaped name is visible");
  const sellerPage = [...pages].find(([p, h]) => p.startsWith("seller/") && h.includes("&lt;script&gt;alert(1)&lt;/script&gt;</span>"));
  assert.ok(sellerPage, "runner text is shown escaped on the seller page");
});

test("site: rank numbers only for sellers with enough counted purchases on enough days", () => {
  const r = report([
    ...series("good.example", 40),
    ...series("oneday.example", 20, [DAY2]), // enough purchases, one day
    ...series("few.example", MIN_COUNTED - 1), // two days, too few
  ]);
  const index = renderPublicSite(r).get("index.html")!;
  const row = (host: string) => index.split("<tr>").find((x) => x.includes(`>${host}</a>`))!;
  assert.match(row("good.example"), /^<td class="rk">1<\/td>/);
  assert.match(row("oneday.example"), /^<td class="rk"><\/td>/, "one day: no number");
  assert.match(row("few.example"), /^<td class="rk"><\/td>/, "too few: no number");
  assert.ok(index.indexOf(">oneday.example<") > index.indexOf("<summary>Measuring"), "measuring sellers are folded");
  assert.ok(index.includes(PUBLIC_LEAD));
  assert.ok(index.includes("Not counted: <b>"), "not-counted failures are always shown");

  // The same rule on the published report.
  const pub = JSON.parse(readFileSync(join(ROOT, "site", "rank.json"), "utf8")) as RankReport;
  const html = readFileSync(join(ROOT, "site", "index.html"), "utf8");
  for (const s of pub.ranking) {
    if (s.rank !== null) assert.ok(s.counted >= MIN_COUNTED && s.days.length >= MIN_DAYS, s.key);
    const tr = html.split("<tr>").find((x) => x.includes(`>${s.key.replace(/&/g, "&amp;")}</a>`));
    assert.ok(tr, `row for ${s.key}`);
    assert.ok(tr.startsWith(`<td class="rk">${s.rank ?? ""}</td>`), `${s.key}: rank cell ${s.rank}`);
  }
});

test("data/: every file matches the manifest sha256, and rank --data reproduces site/rank.json", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "data", "manifest.json"), "utf8")) as { date: string; files: { path: string; sha256: string }[] };
  const listed = new Set(manifest.files.map((f) => f.path));
  for (const p of walk(join(ROOT, "data"))) {
    const rel = p.slice(join(ROOT, "data").length + 1);
    if (rel === "manifest.json") continue;
    assert.ok(listed.has(rel), `${rel} is in the manifest`);
  }
  for (const f of manifest.files) {
    const got = createHash("sha256").update(readFileSync(join(ROOT, "data", f.path), "utf8")).digest("hex");
    assert.equal(got, f.sha256, f.path);
  }
  const out = mkdtempSync(join(tmpdir(), "vet402-rank-"));
  try {
    execFileSync(process.execPath, ["--import", "tsx", join(ROOT, "scripts", "rank.ts"), "--data", join(ROOT, "data"), "--offline", "--out", out], { cwd: ROOT, stdio: "pipe" });
    const fresh = JSON.parse(readFileSync(join(out, `rank-${manifest.date}.json`), "utf8")) as RankReport;
    const pub = JSON.parse(readFileSync(join(ROOT, "site", "rank.json"), "utf8")) as RankReport;
    const strip = (r: RankReport) => ({ ...r, generatedAt: "" });
    assert.deepEqual(strip(fresh), strip(pub));
    for (const i of fresh.inputs) assert.ok(i.location.startsWith("data/"), `${i.label} read from data/`);
    const pages = renderPublicSite(fresh);
    for (const [rel, html] of pages) assert.equal(html, readFileSync(join(ROOT, "site", rel), "utf8"), `site/${rel} is up to date`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

/**
 * Credential shapes. Two strings in data/ match a shape but are public examples that sellers put in their
 * own listings (vet402 filled them in as the declared example input): the jwt.io sample token and
 * "password=test123". They are allowed by exact value, nothing else.
 */
const SECRET_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-(?:proj-|ant-)?[A-Za-z0-9_]{20,}/,
  /\bsk_live_[A-Za-z0-9]{8,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /"(?:private_?key|secret_?key|secret|mnemonic|seed_?phrase|api_?key|apikey|password|passphrase|access_?token|auth_?token|client_?secret)"\s*:\s*"[^"]{6,}"/i,
  /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/, // a 64-byte array (Solana keypair file)
  /\b(?:(?:[a-z]{3,8})\s+){11}[a-z]{3,8}\b(?=[^a-z]*(?:mnemonic|seed))/i,
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT
  /[?&](?:password|secret|api_?key|apikey|access_token)=[^&"\s\\]{3,}/i,
];
const PUBLIC_EXAMPLES = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fw",
  "?password=test123",
];

test("data/ and site/: no credential-shaped strings besides the two known public examples", () => {
  const hits: string[] = [];
  for (const dir of ["data", "site"]) {
    for (const p of walk(join(ROOT, dir))) {
      let text = readFileSync(p, "utf8");
      for (const ok of PUBLIC_EXAMPLES) text = text.split(ok).join("");
      for (const re of SECRET_SHAPES) {
        const m = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g").exec(text);
        if (m) hits.push(`${p.slice(ROOT.length + 1)}: ${re.source.slice(0, 30)}`);
      }
    }
  }
  assert.deepEqual(hits, []);
  assert.ok(!walk(join(ROOT, "data")).some((p) => /(^|\/)\.(env|keys)|\.pem$|payer\.json$|evm\.json$/.test(p)), "no key or env files");
});

test("site/: the pages' own wording has no we/us/our, no Japanese, no em dash", () => {
  for (const p of walk(join(ROOT, "site")).filter((x) => x.endsWith(".html"))) {
    const words = ownWording(readFileSync(p, "utf8"));
    assert.ok(!/\b(we|us|our|ours|ourselves)\b/i.test(words), `${p}: ${/.{0,40}\b(we|us|our)\b.{0,40}/i.exec(words)?.[0]}`);
    assert.ok(!/[぀-ヿ一-鿿]/.test(words), `${p}: Japanese`);
    assert.ok(!words.includes("—"), `${p}: em dash`);
  }
  const readme = readFileSync(join(ROOT, "src", "rank", "README.md"), "utf8");
  assert.ok(!/\b(we|us|our)\b/i.test(readme) && !readme.includes("—"), "src/rank/README.md");
});
