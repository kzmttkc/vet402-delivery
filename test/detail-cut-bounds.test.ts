/**
 * The rank's 200-character cut, against the secret gate's scan of the tree, at every position near the cut: a mark in
 * a JSON body under a secret name, in a query, at the end of a body, and the site's HTML around the cut text. The cut
 * text must scan as clean as the whole text does, in data/'s JSON and in the site's HTML (src/rank/html.ts).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockingFindings, POSTAL_ADDRESS_REDACTION, scanFileText, SELLER_TOKEN_REDACTION, UNCLEAR_VALUE_REDACTION } from "../src/daily/secret-gate.js";
import { normalizeRemeasure } from "../src/remeasure/normalize.js";
import { escapeHtml } from "../src/rank/html.js";

const remeasure = (detail: string) =>
  normalizeRemeasure(
    {
      kind: "vet402-remeasure", version: 1, chain: "solana", date: "2026-10-16", payer: "", note: "", runs: [],
      rows: [{ at: "2026-10-16T01:17:00.000Z", chain: "solana", host: "s.example", service: null, url: "https://s.example/a", requestUrl: "https://s.example/a", payTo: null, expectedPayTo: "69aiAKU3uJMxMLRkUEGFNt6nQ43PiVimE4ZbErJ7VSM1", outcome: "sent", reason: "sent", detail, settled: true, delivered: false, httpStatus: 500, bodyBytes: null, tx: null, priceUsdc: "0.001000", slot: 0, key: "k" }],
    },
    "x",
  )[0]!.detail!;
const asJson = (d: string) => blockingFindings(scanFileText(JSON.stringify({ rows: [{ detail: d }] }, null, 2), "x.json"), []).map((f) => `${f.kind} ${f.shape}`);
const asHtml = (d: string) =>
  blockingFindings(scanFileText(`<li><div class="meta">runner said: <span class="mono">http_error</span> · <span class="mono">${escapeHtml(d)}</span></div></li>\n<li>next</li>\n`, "x.html"), []).map((f) => `${f.kind} ${f.shape}`);

test("rank: at every place a mark can stand near the 200-character cut, the cut text scans as clean as the whole text (JSON and the site's HTML)", () => {
  const contexts: [string, string][] = [
    [`{"api_key":"`, `","ok":true}`],
    [`{"next":"https://x.example/cb?access_token=`, `&page=2"}`],
    [`{"session":"`, `"}`],
    [`{"id_token":"`, `"}`],
    [`<a data-token="`, `">x</a>`],
    [`token: `, ` and more text after it`],
  ];
  let tried = 0;
  for (const mark of [UNCLEAR_VALUE_REDACTION, SELLER_TOKEN_REDACTION, POSTAL_ADDRESS_REDACTION]) {
    for (const [head, tail] of contexts) {
      const whole = `${head}${mark}${tail}`;
      const cleanJson = asJson(whole).length === 0;
      const cleanHtml = asHtml(whole).length === 0;
      if (!cleanJson && !cleanHtml) continue;
      for (let start = 150; start <= 205; start++) {
        if (start < head.length) continue;
        const detail = `${"x ".repeat(200).slice(0, start - head.length)}${whole}${" more".repeat(20)}`;
        const cut = remeasure(detail);
        tried++;
        if (cleanJson) assert.deepEqual(asJson(cut), [], `json ${head} ${mark.slice(0, 12)} at ${start}: ${cut.slice(-60)}`);
        if (cleanHtml) assert.deepEqual(asHtml(cut), [], `html ${head} ${mark.slice(0, 12)} at ${start}: ${cut.slice(-60)}`);
        assert.ok(cut.length <= 201 + mark.length + tail.length, `${cut.length}`);
      }
    }
  }
  assert.ok(tried > 500, `${tried}`);
});

test("rank: the cut's HTML escaping is the site's own (escapeHtml in src/rank/html.ts)", async () => {
  const { siteHtmlEscape } = await import("../src/daily/detail-cut.js");
  for (const s of [`<a href="x?a=1&b='2'">\`q\`</a>`, "plain", `{"api_key":"[redacted:unclear-seller-value]"}`]) assert.equal(siteHtmlEscape(s), escapeHtml(s));
});
