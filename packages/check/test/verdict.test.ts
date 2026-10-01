/**
 * The verdict (pay, avoid, unknown), the free endpoint /v1/check, the hook's `block: "avoid"` and the
 * site's form, with no network. The verdict fixtures are cut from this repository's own rank.json and
 * records index of 2026-10-01 by make-verdict-fixtures.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
import { CHECK_ENDPOINT } from "../../../src/rank/html.js";
import { lookup, PAID_SELLER_RULES, UNPAID_SELLER_RULES, type CheckResult } from "../src/check.js";
import { formatCheck } from "../src/cli.js";
import { CheckBlockedError, wrapFetchWithCheck } from "../src/hook.js";
import { checkBody, handleCheck, MAX_URL_LENGTH, USE_WAIT_MS, type CheckData, type OnUse } from "../src/http.js";
import { bearerOk, callerId, usageCounter } from "../../../src/usage/count.js";
import { handleMessage } from "../src/mcp.js";
import { PublicData } from "../src/sources.js";
import { VERDICTS, verdictFor } from "../src/verdict.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const FX = join(import.meta.dirname, "fixtures");
const RANK = join(FX, "verdict-rank.json");
const INDEX = join(FX, "verdict-records-index.json");
const LANES = ["arbitrum", "robinhood"].map((l) => join(FX, `verdict-lane-${l}.json`));
const rank = JSON.parse(readFileSync(RANK, "utf8")) as Record<string, any>;
const index = JSON.parse(readFileSync(INDEX, "utf8")) as unknown;
const lanes = LANES.map((f) => JSON.parse(readFileSync(f, "utf8")) as unknown);
const data: CheckData = { rank, recordsIndex: index, lanes };
const load = (): CheckData => data;

const XONA = "https://api.xona-agent.com/token/pumpfun-trending";
const BRASIL = "https://brasil-dados-api.onrender.com/cambio";
const DATAMANCER = "https://agents.datamancer.io/api/v1/paid/vin";
const UNKNOWN = "https://no-such-seller.example/api/x";
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

const get = (query: string, method = "GET"): Promise<Response> => handleCheck(new Request(`https://vet402-delivery.vercel.app/v1/check${query}`, { method }), load);
const q = (url: string, extra = ""): string => `?url=${encodeURIComponent(url)}${extra}`;
const body = async (res: Response | Promise<Response>) => (await (await res).json()) as ReturnType<typeof checkBody>;

// ---- 1. the four real examples ----

test("verdict, real data: XONA pumpfun-trending (paid 6 times, 0 answers, HTTP 500) is avoid", () => {
  const r = lookup(rank, index, { url: XONA });
  assert.equal(r.verdict, "avoid");
  assert.equal(r.basis?.seller, "api.xona-agent.com");
  assert.deepEqual([r.basis?.settled, r.basis?.counted, r.basis?.answered], [6, 6, 0]);
  assert.ok(r.basis!.upper < 0.5, `upper bound ${r.basis!.upper}`);
  assert.equal(r.why, "vet402 paid this seller 6 times on Solana over 4 days; 0 of the 6 that count came back with an answer (the newest failed one answered HTTP 500).");
});

test("verdict, real data: brasil-dados-api.onrender.com/cambio (paid 6 times, 6 answers) is pay", () => {
  const r = lookup(rank, index, { url: BRASIL });
  assert.equal(r.verdict, "pay");
  assert.deepEqual([r.basis?.settled, r.basis?.counted, r.basis?.answered], [6, 6, 6]);
  assert.ok(r.basis!.lower >= 0.5, `lower bound ${r.basis!.lower}`);
  assert.equal(r.why, "vet402 paid this seller 6 times on Solana over 4 days; 6 of the 6 that count came back with an answer.");
});

test("verdict, real data: a URL vet402 never bought from is unknown", () => {
  const r = lookup(rank, index, { url: UNKNOWN });
  assert.equal(r.verdict, "unknown");
  assert.equal(r.basis, null);
  assert.equal(r.why, "vet402 has not bought from this seller, so there is no record to go on.");
  const onTempo = lookup(rank, index, { url: BRASIL, chain: "tempo" });
  assert.equal(onTempo.verdict, "unknown", "bought on Solana only: nothing on Tempo");
  assert.match(onTempo.why, /not bought from this seller on Tempo/);
});

test("verdict, real data: datamancer vin, whose failures are not counted against it (404 after paying), is never avoid", () => {
  const r = lookup(rank, index, { url: DATAMANCER });
  const f = r.sellers[0]!;
  assert.deepEqual(f.sellerSideFailures, {}, "no failure on the seller's side");
  assert.equal(f.notCountedAgainstSeller.causeUnknown, 4);
  assert.notEqual(r.verdict, "avoid");
  assert.equal(r.verdict, "unknown");
  assert.equal(r.why, "vet402 paid this seller 6 times on Solana over 2 days; 2 of the 2 that count came back with an answer, too few to tell either way, and 4 other failures that may be on vet402's side are left out.");

  // The same seller with its two answers taken out: only failures that are not the seller's are left.
  const onlyNotCounted = structuredClone(rank);
  const s = onlyNotCounted.groups[0].ranking.find((x: any) => x.key === "agents.datamancer.io");
  Object.assign(s, { delivered: 0, counted: 0, days: [] });
  s.chains.solana = { ...s.chains.solana, delivered: 0, counted: 0 };
  const r2 = lookup(onlyNotCounted, index, { url: DATAMANCER });
  assert.equal(r2.verdict, "unknown");
  assert.match(r2.why, /0 of the 0 that count/);
});

test("BLOCK fix: a seller with no settled payment is never avoid (x402-mesh-gateway.fly.dev: 4 seller-side 5xx, none settled, 2 days)", () => {
  const r = lookup(rank, index, { url: "https://x402-mesh-gateway.fly.dev/v1/inference" });
  const f = r.sellers[0]!;
  assert.deepEqual([f.page, f.settled, f.counted, f.sellerSideFailures], ["algorand", 0, 4, { server_error_5xx: 4 }], "the shape that was wrongly avoid");
  assert.equal(r.verdict, "unknown");
  assert.equal(r.basis?.counted, 0, "a 5xx with no settlement is not a paid call");
  assert.equal(r.why, "vet402 tried to buy from this seller 4 times on Algorand, and none of its payments settled, so there is nothing to go on.");
  assert.ok(!/paid this seller 0 times/.test(r.why));
});

test("BLOCK fix, every seller in site/rank.json: avoid only with settled payments, and why never says paid more than settled", () => {
  const real = JSON.parse(readFileSync(join(ROOT, "site", "rank.json"), "utf8")) as { groups: { id: string; chains: string[]; ranking: { key: string; host: string; last: { url: string } | null; recent: { url: string }[]; chains: Record<string, unknown> }[] }[] };
  const realIndex = JSON.parse(readFileSync(join(ROOT, "data", "records", "index.json"), "utf8"));
  const dist: Record<string, number> = { pay: 0, avoid: 0, unknown: 0 };
  const avoids: string[] = [];
  for (const g of real.groups)
    for (const s of g.ranking)
      for (const chain of Object.keys(s.chains)) {
        const url = s.last?.url ?? s.recent[0]?.url ?? `https://${s.host}/`;
        const r = lookup(real, realIndex, { url, chain });
        const b = verdictFor(r).bases.find((x) => x.seller === s.key && x.page === g.id) ?? r.basis!;
        dist[b.verdict]!++;
        if (b.verdict === "avoid") {
          avoids.push(`${s.key} (${chain}): settled ${b.settled}, answered ${b.answered} of ${b.counted}`);
          assert.ok(b.settled > 0 && b.counted > 0 && b.counted <= b.settled, `${s.key}: avoid rests on settled payments`);
        }
        const m = /paid this seller (\d+|once)/.exec(r.why);
        if (m) assert.ok((m[1] === "once" ? 1 : Number(m[1])) <= (r.basis?.settled ?? 0), `${s.key}: ${r.why}`);
      }
  assert.equal(avoids.filter((a) => / settled 0,/.test(a)).length, 0);
  console.log(`rank.json scan, per seller and chain: ${JSON.stringify(dist)}; avoid: ${avoids.join("; ") || "none"}`);
});

test("per chain: days come from that chain's own listed purchases; no split, no verdict", () => {
  const solana = lookup(rank, index, { url: "https://scvd.store/api/buy/spot_check", chain: "solana" });
  const f = solana.sellers.find((x) => x.page === "main")!;
  assert.ok(Object.keys(f.byChain).length > 1, "scvd.store is on Solana and Base");
  assert.equal(solana.basis?.days, f.paid.byChain.solana!.days);
  assert.ok(solana.basis!.days <= f.days);
  const mixed = structuredClone(rank);
  const s = mixed.groups[0].ranking.find((x: any) => x.key === "scvd.store");
  s.failuresByRule = { ...s.failuresByRule, server_error_5xx: 1 };
  const r = lookup(mixed, index, { url: "https://scvd.store/api/buy/spot_check", chain: "solana" });
  assert.equal(r.verdict, "unknown");
  assert.equal(r.basis?.counted, 0, "a page with an unsettled seller-side failure cannot be split by chain");
});

test("every seller-side rule in rank.json is known as after-payment or no-payment", () => {
  const real = JSON.parse(readFileSync(join(ROOT, "site", "rank.json"), "utf8")) as { method: { faultRules: { id: string; fault: string }[] } };
  for (const r of real.method.faultRules.filter((x) => x.fault === "seller")) assert.ok(PAID_SELLER_RULES.has(r.id) || UNPAID_SELLER_RULES.has(r.id), r.id);
});

test("Arbitrum and Robinhood Chain: a host listed with the same payTo is the same seller", () => {
  const realRank = JSON.parse(readFileSync(join(ROOT, "site", "rank.json"), "utf8"));
  const realLanes = ["arbitrum", "robinhood"].map((l) => JSON.parse(readFileSync(join(ROOT, "data", "evm", `${l}.json`), "utf8")));
  const row = realLanes[0].rows.find((x: any) => x.status === "delivered" && x.hosts.length > 1)!;
  const other = (row.hosts as string[]).find((h) => h !== new URL(row.resource).hostname)!;
  const r = lookup(realRank, { kind: "vet402-observation-records", records: [], days: [] }, { url: `https://${other}/x`, chain: "arbitrum" }, [], realLanes);
  assert.ok(r.sellers.some((f) => f.page === "arbitrum" && f.delivered > 0), other);
});

test("verdict rule: rank.json's grade lines on the Wilson interval, 2+ days, MIN_COUNTED not required", () => {
  const facts = (delivered: number, counted: number, days: number) =>
    verdictFor({
      found: true,
      asked: { url: "https://x.example/a", host: "x.example", chain: null, payTo: null },
      payTo: null,
      sellers: [
        {
          key: "x.example", page: "main", pageLabel: "Solana, Tempo and Base", sellerPage: "", grade: "measuring", rank: null,
          tried: counted, settled: counted, delivered, counted, days,
          byChain: { solana: { tried: counted, settled: counted, counted, delivered, lastAt: null } },
          firstAt: null, lastAt: null, sellerSideFailures: {}, notCountedAgainstSeller: { vet402OrFacilitator: 0, causeUnknown: 0, byRule: {} },
          last: null, lastSellerSideFailure: null, sameUrlInRecent: { listed: 0, tried: 0, delivered: 0 }, payTos: [], payToChanged: false,
          paid: { counted, answered: delivered, days, byChain: { solana: { counted, answered: delivered, days } } },
        },
      ],
    }).verdict;
  assert.equal(facts(3, 3, 2), "unknown", "3 of 3: lower bound 0.44");
  assert.equal(facts(4, 4, 2), "pay", "4 of 4: lower bound 0.51");
  assert.equal(facts(0, 3, 2), "unknown", "0 of 3: upper bound 0.56");
  assert.equal(facts(0, 4, 2), "avoid", "0 of 4: upper bound 0.49");
  assert.equal(facts(0, 20, 1), "unknown", "one day only");
  assert.equal(facts(20, 20, 1), "unknown", "one day only");
  assert.equal(facts(10, 20, 3), "unknown", "half: neither line");
});

test("verdict: a payTo vet402 never paid turns pay into unknown; avoid stays", () => {
  const other = lookup(rank, index, { url: BRASIL, payTo: "11111111111111111111111111111111" });
  assert.equal(other.verdict, "unknown");
  assert.match(other.why, /another payTo than the one in this 402/);
  const same = lookup(rank, index, { url: BRASIL, payTo: "yUdt7ThMbP5mvtLtURiwK3wgnhexuFtbKC9LEgb1Q8e" });
  assert.equal(same.verdict, "pay");
  assert.equal(lookup(rank, index, { url: XONA, payTo: "11111111111111111111111111111111" }).verdict, "avoid");
});

// ---- 2. the endpoint: verdict and why first, why's numbers are the fields beside it ----

test("GET /v1/check: the answer starts with verdict and why, and every number in why is a field of the answer", async () => {
  for (const [url, verdict] of [[XONA, "avoid"], [BRASIL, "pay"], [DATAMANCER, "unknown"], [UNKNOWN, "unknown"]] as const) {
    const res = await get(q(url));
    assert.equal(res.status, 200);
    const b = await body(res);
    assert.deepEqual(Object.keys(b).slice(0, 2), ["verdict", "why"], url);
    assert.equal(b.verdict, verdict, url);
    if (url === UNKNOWN) {
      assert.deepEqual([b.tried, b.settled, b.answered, b.counted], [0, 0, 0, 0]);
      continue;
    }
    const m = /^vet402 paid this seller (\d+) times on (\w+) over (\d+) days; (\d+) of the (\d+) that count came back with an answer/.exec(b.why);
    assert.ok(m, b.why);
    assert.deepEqual([Number(m[1]), m[2]!.toLowerCase(), Number(m[3]), Number(m[4]), Number(m[5])], [b.settled, b.chains[0], b.days, b.answered, b.counted], url);
    const http = /HTTP (\d{3})/.exec(b.why);
    if (http) assert.equal(Number(http[1]), b.newest?.httpStatus);
    const left = /and (\d+) other failures? that may be on vet402's side/.exec(b.why);
    assert.equal(left ? Number(left[1]) : 0, b.notCounted, url);
    assert.ok(b.newest?.tx && b.newest.explorer?.startsWith("https://solscan.io/tx/"), "newest tx and its explorer link");
    assert.ok(b.records.published > 0 && b.records.newest[0]!.json.startsWith("https://"), "signed record links");
    assert.equal(b.asOf.rankDate, "2026-10-01");
  }
});

test("GET /v1/check: CORS, short cache, OPTIONS, HEAD, and a method that is not GET", async () => {
  const res = await get(q(XONA));
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.match(res.headers.get("cache-control") ?? "", /max-age=60\b/);
  assert.match(res.headers.get("content-type") ?? "", /^application\/json/);
  const pre = await get("", "OPTIONS");
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get("access-control-allow-methods") ?? "", /GET/);
  const head = await get(q(XONA), "HEAD");
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await get(q(XONA), "POST")).status, 405);
});

test("GET /v1/check: input checks (https only, length cap, chain, payTo, format) answer 400 in plain words", async () => {
  const bad: [string, RegExp][] = [
    ["", /Add the seller URL/],
    [q("http://api.xona-agent.com/token/pumpfun-trending"), /Only https URLs/],
    [q("ftp://x.example/a"), /Only https URLs/],
    [q("not a url"), /not a URL/],
    [q(`https://x.example/${"a".repeat(MAX_URL_LENGTH)}`), /longer than 2048/],
    [q("https://user:pw@x.example/a"), /user name or password/],
    [q(XONA, "&chain=eip155:1"), /chain must be/],
    [q(XONA, "&payTo=abc%3Cscript%3E"), /payTo must be/],
    [q(XONA, `&payTo=${"a".repeat(129)}`), /payTo must be/],
    [q(XONA, "&format=xml"), /format must be/],
  ];
  for (const [query, msg] of bad) {
    const res = await get(query);
    assert.equal(res.status, 400, query);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const b = (await res.json()) as { error: string; message: string };
    assert.equal(b.error, "bad_request");
    assert.match(b.message, msg, query);
  }
  const ok = await body(get(q(BRASIL, `&chain=${encodeURIComponent(SOLANA)}&payTo=yUdt7ThMbP5mvtLtURiwK3wgnhexuFtbKC9LEgb1Q8e`)));
  assert.deepEqual([ok.verdict, ok.chain, ok.payToRecorded], ["pay", "solana", true]);
});

test("GET /v1/check: unreadable data answers 503, not a verdict", async () => {
  const res = await handleCheck(new Request(`https://h.example/v1/check${q(XONA)}`), () => {
    throw new Error("ENOENT");
  });
  assert.equal(res.status, 503);
  assert.equal(((await res.json()) as { error: string }).error, "data_unavailable");
});

test("GET /v1/check on the files api/check.ts bundles (site/rank.json, data/records/index.json): answers, fast", async () => {
  const real: CheckData = {
    rank: JSON.parse(readFileSync(join(ROOT, "site", "rank.json"), "utf8")),
    recordsIndex: JSON.parse(readFileSync(join(ROOT, "data", "records", "index.json"), "utf8")),
    lanes: ["arbitrum", "robinhood"].map((l) => JSON.parse(readFileSync(join(ROOT, "data", "evm", `${l}.json`), "utf8"))),
  };
  const call = (url: string) => handleCheck(new Request(`https://h.example/v1/check${q(url)}`), () => real);
  const first = await body(call(XONA));
  assert.ok(VERDICTS.includes(first.verdict));
  const t0 = performance.now();
  const n = 20;
  for (let i = 0; i < n; i++) await (await call(i % 2 ? BRASIL : UNKNOWN)).text();
  const each = (performance.now() - t0) / n;
  assert.ok(each < 50, `a warm answer took ${each.toFixed(1)} ms`);
});

// ---- 3. the hook stops before signing ----

function x402Server(url: string, payTo: string): typeof fetch {
  const required = {
    x402Version: 2,
    resource: { url, description: "test", mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: SOLANA, amount: "1000", asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", payTo, maxTimeoutSeconds: 60, extra: { feePayer: "11111111111111111111111111111111" } }],
  };
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (h.has("payment-signature") || h.has("x-payment")) return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    return new Response("{}", { status: 402, headers: { "content-type": "application/json", "payment-required": Buffer.from(JSON.stringify(required)).toString("base64") } });
  }) as typeof fetch;
}

function spyClient(): { client: x402Client; signed: () => number } {
  let n = 0;
  // spendControls off: the test pays a made-up asset to a spy; nothing is signed or sent.
  const client = x402Client.fromConfig({
    spendControls: false,
    schemes: [
      {
        network: SOLANA,
        client: {
          scheme: "exact",
          createPaymentPayload: async (x402Version: number) => {
            n++;
            return { x402Version, payload: { transaction: "signed-by-the-spy" } };
          },
        },
      },
    ],
  });
  return { client, signed: () => n };
}

const verdictData = () => new PublicData({ sources: { rank: RANK, recordsIndex: INDEX, recordsBase: join(FX, "records"), lanes: LANES }, fetch: () => Promise.reject(new Error("no network in tests")) });

test('hook block: "avoid" stops XONA before the signer is called; pay and unknown sellers are paid (real @x402/fetch)', async () => {
  const xona = spyClient();
  const payXona = wrapFetchWithPayment(wrapFetchWithCheck(x402Server(XONA, "9VaDVp1Wb78G4Wm6VuTiMrpESjrUymXefQTHcJGRSTEA"), { block: "avoid", data: verdictData() }) as typeof fetch, xona.client);
  await assert.rejects(payXona(XONA), (e: unknown) => {
    assert.ok(e instanceof CheckBlockedError, String(e));
    assert.match(e.message, /^Stopped before paying: vet402's verdict for this seller is "avoid"\. vet402 paid this seller 6 times on Solana/);
    assert.equal(e.check.verdict, "avoid");
    return true;
  });
  assert.equal(xona.signed(), 0, "the signer was never called");

  for (const [url, payTo] of [[BRASIL, "yUdt7ThMbP5mvtLtURiwK3wgnhexuFtbKC9LEgb1Q8e"], [UNKNOWN, "11111111111111111111111111111111"]] as const) {
    const spy = spyClient();
    const seen: CheckResult[] = [];
    const pay = wrapFetchWithPayment(wrapFetchWithCheck(x402Server(url, payTo), { block: "avoid", data: verdictData(), onCheck: (e) => void seen.push(...e.checks) }) as typeof fetch, spy.client);
    const res = await pay(url);
    assert.equal(res.status, 200, url);
    assert.equal(spy.signed(), 1, `${url}: signed once`);
    assert.equal(seen[0]?.verdict, url === BRASIL ? "pay" : "unknown");
  }
});

test("hook: without block, onCheck alone still decides (the old use is unchanged); no option at all is an error", async () => {
  const spy = spyClient();
  let verdict = "";
  const pay = wrapFetchWithPayment(wrapFetchWithCheck(x402Server(XONA, "9VaDVp1Wb78G4Wm6VuTiMrpESjrUymXefQTHcJGRSTEA"), { data: verdictData(), onCheck: (e) => void (verdict = e.checks[0]!.verdict) }) as typeof fetch, spy.client);
  assert.equal((await pay(XONA)).status, 200);
  assert.equal(verdict, "avoid");
  assert.equal(spy.signed(), 1, "no block: the caller's onCheck let it through");
  assert.throws(() => wrapFetchWithCheck(fetch, {} as never), /give onCheck/);
  assert.throws(() => wrapFetchWithCheck(fetch, { block: "unknown" } as never), /block must be "avoid"/);
});

// ---- the CLI and MCP lead with the same line ----

test("CLI and MCP: the first line is the verdict and why from the same function", async () => {
  const r = lookup(rank, index, { url: XONA });
  assert.equal(formatCheck(r).split("\n")[0], `verdict: avoid. ${r.why}`);
  const call = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "check_before_paying", arguments: { url: BRASIL } } }, { data: verdictData() });
  const res = call!.result as { content: { text: string }[]; structuredContent: CheckResult };
  assert.equal(res.content[0]!.text.split("\n")[0], `verdict: pay. ${res.structuredContent.why}`);
  assert.equal(res.structuredContent.verdict, "pay");
});

// ---- 4. the site's form and the HTML answer ----

test("site/index.html has the form, sent to /v1/check?format=html with no script; the HTML answer shows verdict and why", async () => {
  const index = readFileSync(join(ROOT, "site", "index.html"), "utf8");
  assert.ok(index.includes(`<form id="check" class="checkbox" method="get" action="${CHECK_ENDPOINT}" aria-label="Check a seller before you pay">`));
  assert.ok(index.includes('<input id="check-url" name="url" type="url" required maxlength="2048"'));
  assert.ok(index.includes('<input type="hidden" name="format" value="html">'));
  assert.ok(!index.includes("<script"), "still no script on the first page");
  assert.ok(index.includes("script-src 'none'"));

  const res = await get(`${q(XONA)}&format=html`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy") ?? "", /script-src 'none'/);
  const html = await res.text();
  assert.ok(html.includes("avoid: vet402 paid this seller, and most of those payments got no usable answer"));
  assert.ok(html.includes("vet402 paid this seller 6 times on Solana over 4 days; 0 of the 6 that count came back with an answer"));
  assert.ok(html.includes(`value="${XONA}"`), "the answer page keeps the URL in the field");
  assert.ok(!html.includes("<script"));
  const err = await get(`${q("http://x.example/<script>")}&format=html`);
  assert.equal(err.status, 400);
  const errHtml = await err.text();
  assert.ok(errHtml.includes("Only https URLs can be checked."));
  assert.ok(!errHtml.includes("<script>"), "the input is shown escaped");
});

test("site/index.html: the two example answers are computed from the published data, and each runs the check", () => {
  const index = readFileSync(join(ROOT, "site", "index.html"), "utf8");
  const real = {
    rank: JSON.parse(readFileSync(join(ROOT, "site", "rank.json"), "utf8")),
    index: JSON.parse(readFileSync(join(ROOT, "data", "records", "index.json"), "utf8")),
    lanes: ["arbitrum", "robinhood"].map((l) => JSON.parse(readFileSync(join(ROOT, "data", "evm", `${l}.json`), "utf8"))),
  };
  for (const url of [XONA, BRASIL]) {
    const r = lookup(real.rank, real.index, { url }, [], real.lanes);
    const href = `${CHECK_ENDPOINT}?url=${encodeURIComponent(url)}&amp;format=html`;
    const short = url.replace(/^https:\/\//, "");
    assert.ok(index.includes(`<li><span class="v v-${r.verdict}">${r.verdict}</span> <a class="mono" href="${href}">${short}</a> ${r.basis!.answered} of ${r.basis!.settled} paid calls answered.</li>`), url);
  }
  assert.ok(index.indexOf('id="check"') < index.indexOf('class="plain examples"'), "right under the field");
});

// ---- 5. every chain vet402 buys on ----

test("verdict on every page's data: Tempo, Base, Algorand, Arbitrum, and a result held until the seller is told", async () => {
  const tempo = await body(get(q("https://api.exa.ai/search", "&chain=tempo")));
  assert.equal(tempo.verdict, "pay");
  assert.match(tempo.why, /^vet402 paid this seller 4 times on Tempo over 4 days; 4 of the 4/);

  const base = await body(get(q("https://scvd.store/api/buy/spot_check", "&chain=eip155:8453")));
  assert.equal(base.verdict, "unknown", "one purchase on Base");
  assert.deepEqual([base.chains, base.settled, base.days], [["base"], 1, 1]);
  assert.match(base.why, /^vet402 paid this seller once on Base on one day; 1 of the 1 that count came back with an answer, all on one day/);

  const algo = await body(get(q("https://algorandtracker.com/api/x", "&chain=algorand")));
  assert.equal(algo.verdict, "pay");
  assert.match(algo.why, /on Algorand over 2 days; 248 of the 248 that count/);

  const arb = await body(get(q("https://api.nativebtc.org/v1/mempool/stream-ticket")));
  assert.equal(arb.verdict, "unknown", "one purchase on Arbitrum");
  assert.deepEqual([arb.chains, arb.answered, arb.sellerPage], [["arbitrum"], 1, "https://kzmttkc.github.io/vet402-delivery/arbitrum.html"]);
  assert.match(arb.newest?.explorer ?? "", /^https:\/\/arbiscan\.io\/tx\/0x/);

  const held = await body(get(q("https://x402.quickintel.io/v1/scan/full")));
  assert.equal(held.verdict, "unknown");
  assert.equal(held.why, "vet402 bought from this seller on Arbitrum; results for this seller are held until the seller is told.");
  assert.deepEqual([held.tried, held.settled, held.answered, held.counted, held.held, held.newest], [0, 0, 0, 0, 1, null], "nothing about the held result leaks");
  const heldHtml = await (await get(q("https://x402.quickintel.io/v1/scan/full", "&format=html"))).text();
  assert.ok(heldHtml.includes("<tr><td>Held</td><td>1 purchase, shown after the seller is told</td></tr>"));
  assert.ok(!heldHtml.includes("Tried / settled"), "no 1 / 0 shown for a held seller");
  assert.ok(!JSON.stringify(held).includes("withheld"), "the raw status is not in the answer");

  const scvdAll = await body(get(q("https://scvd.store/api/buy/spot_check", "&chain=arbitrum")));
  assert.deepEqual([scvdAll.verdict, scvdAll.chains], ["unknown", ["arbitrum"]]);
});

// ---- 6. counting the calls never changes the answer ----

test("usage counting: a database that is down, throws or hangs never changes the answer or holds it up", async () => {
  const down = usageCounter("check", () => ({ query: () => Promise.reject(new Error("connect ECONNREFUSED")) }), "k".repeat(32));
  const hang = usageCounter("check", () => ({ query: () => new Promise(() => undefined) }), "k".repeat(32));
  const throws: OnUse = () => {
    throw new Error("boom");
  };
  for (const onUse of [down, hang, throws]) {
    const t0 = performance.now();
    const res = await handleCheck(new Request(`https://h.example/v1/check${q(XONA)}`), load, onUse);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { verdict: string }).verdict, "avoid");
    // Bounded: a counter that never answers is given up after USE_WAIT_MS (the slack is for a loaded test machine).
    assert.ok(performance.now() - t0 < USE_WAIT_MS + 2000, "not held up past the wait");
  }
});

test("usage counting: per day and hashed caller, no raw IP; vet402's own calls apart; the reader needs the alerts secret", async () => {
  const seen: unknown[][] = [];
  const db = { query: async (text: string, params?: unknown[]) => (seen.push([text, ...(params ?? [])]), { rows: [] }) };
  const count = usageCounter("check", () => db, "secret-key-of-32-characters-long", () => new Date("2026-10-01T12:00:00Z"));
  await count(new Request("https://h.example/v1/check", { headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.1", "user-agent": "curl/8" } }));
  await count(new Request("https://h.example/v1/check", { headers: { "x-forwarded-for": "203.0.113.7", "user-agent": "vet402-daily/1" } }));
  const inserts = seen.filter((x) => String(x[0]).startsWith("insert"));
  assert.equal(inserts.length, 2);
  assert.deepEqual(inserts.map((x) => [x[1], x[2], x[4]]), [["2026-10-01", "check", false], ["2026-10-01", "check", true]]);
  assert.ok(!JSON.stringify(seen).includes("203.0.113.7"), "the IP is never stored");
  assert.equal(inserts[0]![3], callerId("203.0.113.7", "2026-10-01", "secret-key-of-32-characters-long"));
  assert.notEqual(callerId("203.0.113.7", "2026-10-01", "k".repeat(32)), callerId("203.0.113.7", "2026-10-02", "k".repeat(32)), "another day, another id");
  const deletes = seen.filter((x) => String(x[0]).startsWith("delete"));
  assert.equal(deletes.length, 1, "old rows are deleted once a day per instance");
  assert.deepEqual(deletes[0]!.slice(1), ["2026-10-01", 90]);
  const none = usageCounter("check", () => null, "k".repeat(32));
  await none(new Request("https://h.example/"));
  assert.equal(bearerOk("Bearer " + "s".repeat(20), "s".repeat(20)), true);
  assert.equal(bearerOk("Bearer wrong", "s".repeat(20)), false);
  assert.equal(bearerOk("Bearer short", "short"), false, "a short secret never opens it");
});

// ---- public English ----

test("public English: verdict sentences, the HTML answer and the error messages: no first-person plural, no em dash, no Japanese, no advice words", async () => {
  const PLURAL = new RegExp(`\\b(${["w" + "e", "u" + "s", "o" + "ur", "o" + "urs"].join("|")})\\b`, "i");
  const ADVICE = /\b(safe|safer|unsafe|danger\w*|risk\w*|trust\w*|scam\w*|recommend\w*|should|reliable|legit\w*|fraud\w*)\b/i;
  const texts: string[] = [];
  for (const url of [XONA, BRASIL, DATAMANCER, UNKNOWN]) {
    for (const extra of ["", "&payTo=11111111111111111111111111111111", "&chain=tempo", "&format=html"]) texts.push(await (await get(q(url, extra))).text());
  }
  for (const query of ["", q("http://x.example/"), q("nope"), q(XONA, "&chain=x")]) texts.push(await (await get(query)).text(), await (await get(`${query}&format=html`)).text());
  for (const t of texts) {
    // The page's own words: no style, no meta tags (the CSP says 'unsafe-inline'), no URLs.
    const own = t
      .replace(/<style>[\s\S]*?<\/style>/g, " ")
      .replace(/<meta [^>]*>/g, " ")
      .replace(/https?:\/\/[^\s"<]+/g, "");
    assert.equal(PLURAL.exec(own)?.[0], undefined, own.slice(0, 200));
    assert.equal(ADVICE.exec(own)?.[0], undefined, own.slice(0, 200));
    assert.equal(own.includes(String.fromCharCode(0x2014)), false, "em dash");
    assert.equal(/[\u3040-\u30ff\u3400-\u9fff\uff00-\uffef]/.test(own), false, "Japanese");
  }
});
