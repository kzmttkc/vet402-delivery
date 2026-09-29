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
import { classifyFailure } from "../src/rank/classify.js";
import { loadPublishedRecords } from "../src/receipt/publish.js";
import { recordsBySeller } from "../src/receipt/site.js";
import { escapeHtml, PUBLIC_LEAD, renderPublicSite, siteSlugs } from "../src/rank/html.js";
import { normalizeAlgorand } from "../src/rank/normalize.js";
import { buildReport, DELIVERED_LINE, MONEY_LINE, type RankReport } from "../src/rank/report.js";
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
  assert.equal(pages.size, 3 + siteSlugs(r).size);
  for (const [path, html] of pages) {
    assert.match(path, /^(index|algorand|method)\.html$|^seller\/[a-z0-9._-]+\.html$/, path);
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
  const graded = index.slice(0, index.indexOf('<h2 id="solana">'));
  const row = (html: string, host: string) => html.split("<tr>").find((x) => x.includes(`>${host}</a>`));
  assert.match(row(graded, "good.example")!, /^<td class="rk">1<\/td>/);
  assert.equal(row(graded, "oneday.example"), undefined, "one day: not in the graded table");
  assert.equal(row(graded, "few.example"), undefined, "too few: not in the graded table");
  const solana = index.slice(index.indexOf('<h2 id="solana">'));
  for (const h of ["good.example", "oneday.example", "few.example"]) assert.ok(row(solana, h), `${h} is listed, unfolded, in the Solana table`);
  assert.ok(!index.includes("<details>"), "nothing on the first page is folded");
  assert.ok(index.includes(escapeHtml(PUBLIC_LEAD)));
  assert.ok(index.includes("Not counted against any seller: <b>"), "not-counted failures are always shown");

  // The same rule on the published report, page by page.
  const pub = JSON.parse(readFileSync(join(ROOT, "site", "rank.json"), "utf8")) as RankReport;
  const algo = readFileSync(join(ROOT, "site", "algorand.html"), "utf8");
  const main = readFileSync(join(ROOT, "site", "index.html"), "utf8");
  for (const g of pub.groups) {
    for (const s of g.ranking) {
      if (s.rank !== null) assert.ok(s.counted >= MIN_COUNTED && s.days.length >= MIN_DAYS, s.key);
      const name = `>${s.key.replace(/&/g, "&amp;")}</a>`;
      if (g.id === "algorand") {
        const tr = algo.split("<tr>").find((x) => x.includes(name));
        assert.ok(tr, `Algorand row for ${s.key}`);
        assert.ok(tr.startsWith(`<td class="rk">${s.rank ?? ""}</td>`), `${s.key}: rank cell ${s.rank}`);
      } else {
        // every seller in the table of every chain it was bought on, with that chain's own numbers
        for (const [c, f] of Object.entries(s.chains)) {
          const part = main.slice(main.indexOf(`<h2 id="${c}">`));
          const tr = part.split("<tr>").find((x) => x.includes(name));
          assert.ok(tr, `${c} row for ${s.key}`);
          assert.match(tr, new RegExp(`<td class="num">${f!.tried}</td><td class="num">${f!.settled}</td><td class="num">${f!.delivered}</td>`), `${c} ${s.key}`);
        }
      }
    }
  }
});

test("method v3: each page is graded from its own chains only, on synthetic data and on the published report", () => {
  // One host bought on Algorand (enough for an A there) and once on Solana.
  const r = report([...series("both.example", 40).map((a) => ({ ...a, chain: "algorand" as const })), att({ host: "both.example" })]);
  const main = r.groups.find((g) => g.id === "main")!;
  const algo = r.groups.find((g) => g.id === "algorand")!;
  const m = main.ranking.find((s) => s.key === "both.example")!;
  const a = algo.ranking.find((s) => s.key === "both.example")!;
  assert.deepEqual([m.tried, m.grade, m.rank, Object.keys(m.chains)], [1, "measuring", null, ["solana"]]);
  assert.deepEqual([a.tried, a.grade, a.rank, Object.keys(a.chains)], [40, "A", 1, ["algorand"]]);
  const pages = renderPublicSite(r);
  assert.ok(!pages.get("index.html")!.includes('class="g gA"'), "the Algorand grade does not appear on the first page");
  assert.ok(pages.get("algorand.html")!.includes('<td class="rk">1</td><td class="gr"><span class="g gA"'), "it does on the Algorand page");
  const seller = pages.get("seller/both.example.html")!;
  assert.ok(seller.indexOf('<h2 id="main">') < seller.indexOf('<h2 id="algorand">'), "the seller page shows both parts, each on its own");

  const pub = JSON.parse(readFileSync(join(ROOT, "site", "rank.json"), "utf8")) as RankReport;
  assert.equal(pub.method.version, "v3");
  assert.deepEqual(pub.groups.map((g) => [g.id, g.chains]), [["main", ["solana", "tempo", "base"]], ["algorand", ["algorand"]]]);
  for (const g of pub.groups) {
    for (const s of g.ranking) {
      const seen = [...Object.keys(s.chains), ...s.recent.map((x) => x.chain), ...s.sellerFailures.map((x) => x.chain), ...(s.last ? [s.last.chain] : [])];
      for (const c of seen) assert.ok((g.chains as string[]).includes(c), `${g.id}: ${s.key} carries a ${c} purchase`);
    }
    // the page's totals are the sum of its chains, counted independently in report.chains
    const chains = pub.chains.filter((c) => (g.chains as string[]).includes(c.chain));
    const sum = (f: (c: (typeof chains)[number]) => number) => chains.reduce((n, c) => n + f(c), 0);
    assert.deepEqual([g.totals.tried, g.totals.settled, g.totals.delivered], [sum((c) => c.tried), sum((c) => c.settled), sum((c) => c.delivered)], g.id);
  }
});

test("site/ and README: the money and delivered wording (method v3), and no old sentence left", () => {
  const pages = walk(join(ROOT, "site")).filter((p) => p.endsWith(".html") || p.endsWith(".json"));
  const texts = [...pages, join(ROOT, "README.md"), join(ROOT, "src", "rank", "README.md")].map((p) => [p, readFileSync(p, "utf8")] as const);
  const old = [/takes no money/i, /no money from sellers/i, /once each/i, /listing promised, with/i, /paid tries/i, /\barrives? 90%/i];
  for (const [p, t] of texts) for (const re of old) assert.ok(!re.test(t), `${p.slice(ROOT.length + 1)}: ${re.source}`);
  for (const f of ["index.html", "algorand.html", "method.html"]) {
    const html = readFileSync(join(ROOT, "site", f), "utf8");
    assert.ok(html.includes(escapeHtml(MONEY_LINE)), `${f}: money line`);
  }
  for (const f of ["index.html", "algorand.html"]) assert.ok(readFileSync(join(ROOT, "site", f), "utf8").includes(escapeHtml(DELIVERED_LINE)), `${f}: delivered line`);
  for (const f of ["README.md", join("src", "rank", "README.md")]) assert.ok(readFileSync(join(ROOT, f), "utf8").includes(MONEY_LINE), `${f}: money line`);
});

test("site/: Algorand 'settled' is a settlement receipt, not 'on chain'; the Tempo body note matches the data", () => {
  const pub = JSON.parse(readFileSync(join(ROOT, "site", "rank.json"), "utf8")) as RankReport;
  const algoPage = readFileSync(join(ROOT, "site", "algorand.html"), "utf8");
  assert.ok(!/settled on chain/i.test(algoPage), "algorand.html never says settled on chain");
  assert.ok(algoPage.includes("with a settlement receipt (tx id)"));
  for (const p of walk(join(ROOT, "site", "seller"))) {
    const html = readFileSync(p, "utf8");
    const algoPart = html.includes('<h2 id="algorand">') ? html.slice(html.indexOf('<h2 id="algorand">')) : "";
    // The page's own words only: runner output quoted verbatim (class="mono") keeps what the runner wrote.
    assert.ok(!/settled on chain/i.test(ownWording(algoPart.slice(0, algoPart.indexOf('<h2 id="appeal">')))), `${p}: Algorand part`);
  }
  const method = readFileSync(join(ROOT, "site", "method.html"), "utf8");
  assert.ok(method.includes(escapeHtml(pub.method.settled)), "method defines settled per chain");
  assert.deepEqual(
    pub.chains.map((c) => [c.chain, c.settledOnChain]),
    [["algorand", false], ["solana", true], ["tempo", true], ["base", true]],
  );
  const tempo = pub.chains.find((c) => c.chain === "tempo")!;
  assert.ok(tempo.bodyUnchecked > 0 && tempo.bodyUnchecked < tempo.tried, "only part of Tempo has no body test");
  const main = readFileSync(join(ROOT, "site", "index.html"), "utf8");
  assert.ok(main.includes(`for ${tempo.bodyUnchecked} of these ${tempo.tried} the runner kept no body`), "first page says how many");
  assert.ok(method.includes(`<td>${tempo.tried - tempo.bodyUnchecked} of ${tempo.tried}</td></tr>`), "method table: body test count");
});

test("data/: every file matches the manifest sha256, and rank --data reproduces site/rank.json", async () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "data", "manifest.json"), "utf8")) as { date: string; files: { path: string; sha256: string }[] };
  const listed = new Set(manifest.files.map((f) => f.path));
  for (const p of walk(join(ROOT, "data"))) {
    const rel = p.slice(join(ROOT, "data").length + 1);
    if (rel === "manifest.json" || rel.startsWith("records/")) continue; // records/ lists its own sha256s (test/receipt-records.test.ts)
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
    const pages = renderPublicSite(fresh, { records: recordsBySeller(await loadPublishedRecords(join(ROOT, "data", "records"))) });
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

test("algorand correction (vet402-algorand 127addc): paid on chain, answered 402, delivered nothing counts on the seller side", () => {
  const tx = "E4IQN3GHQ6AHYKKRIS5D6DD5GE4OXCA3G6ZILCA7YDAHPU5WKSTA";
  const [a] = normalizeAlgorand(
    {
      mode: "census",
      rows: [
        {
          at: DAY1, url: "https://g.example/x", host: "g.example", method: "GET", input: "", payTo: "P", priceUsdc: "0.001000", declared: {},
          verdict: "REFUSE", reason: "payment_failed", paid: true, tx,
          detail: `status 402, Transaction simulation failed: transaction already in ledger: X · settled on chain: vet402's transfer ${tx} (same group, round 1); no delivery`,
        },
      ],
    },
    "algorand/t",
  );
  assert.equal(a!.tried, true);
  assert.equal(a!.settled, true);
  assert.equal(a!.delivered, false);
  assert.equal(a!.httpStatus, 402);
  assert.equal(a!.tx, tx);
  assert.deepEqual(classifyFailure(a!), { fault: "seller", rule: "settled_not_delivered" });
});
