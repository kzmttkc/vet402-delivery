/**
 * The rank keeps a detail to its first 200 characters (src/remeasure/normalize.ts, src/rank/normalize.ts). A cut in
 * the middle of a redaction mark left "[redacted:unclear-se…" on the site, and the secret gate's scan of the tree
 * reads that piece after "access_token=" as a value under a secret name (url-query-secret), which halts the
 * publish. The cut now goes on to the end of a mark it would split.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { blockingFindings, POSTAL_ADDRESS_REDACTION, scanFileText, SELLER_TOKEN_REDACTION, UNCLEAR_VALUE_REDACTION } from "../src/daily/secret-gate.js";
import { normalizeRemeasure } from "../src/remeasure/normalize.js";
import { normalizeSolanaGate1 } from "../src/rank/normalize.js";

const row = (detail: string) => ({
  at: "2026-10-16T01:17:00.000Z", chain: "solana", host: "s.example", service: null, url: "https://s.example/a", requestUrl: "https://s.example/a",
  payTo: "69aiAKU3uJMxMLRkUEGFNt6nQ43PiVimE4ZbErJ7VSM1", expectedPayTo: "69aiAKU3uJMxMLRkUEGFNt6nQ43PiVimE4ZbErJ7VSM1", outcome: "sent", reason: "sent",
  detail, settled: true, delivered: false, httpStatus: 500, bodyBytes: null, tx: null, priceUsdc: "0.001000", slot: 0, key: "2026-10-16|69aiAKU3uJMxMLRkUEGFNt6nQ43PiVimE4ZbErJ7VSM1|0",
});
const remeasure = (detail: string) => normalizeRemeasure({ kind: "vet402-remeasure", version: 1, chain: "solana", date: "2026-10-16", payer: "", note: "", runs: [], rows: [row(detail)] }, "x")[0]!.detail!;
const gate1 = (detail: string) =>
  normalizeSolanaGate1({ kind: "gate1-live", ranAt: "2026-09-27T00:00:00Z", records: [{ outcome: "sent", requestUrl: "https://s.example/a", host: "s.example", settled: true, delivered: false, response: { status: 500, first300: detail } }] }, "x")[0]!.detail!;

test("rank: a detail cut at 200 characters never ends inside a redaction mark, and the cut text passes the secret gate", () => {
  // each mark where the gate writes it: an unclear value in a query or a JSON body, a seller token in a JSON body
  const cases: [string, string, string][] = [
    [UNCLEAR_VALUE_REDACTION, `{"next":"https://x.example/cb?access_token=`, `&page=2"}`],
    [UNCLEAR_VALUE_REDACTION, `{"session":"`, `","ok":true}`],
    [SELLER_TOKEN_REDACTION, `{"id_token":"`, `","ok":true}`],
    [POSTAL_ADDRESS_REDACTION, `{"formattedAddress":"`, `","city":"Anytown"}`],
  ];
  for (const [mark, head, tail] of cases) {
    // uncut, the text passes the gate
    assert.deepEqual(blockingFindings(scanFileText(JSON.stringify({ rows: [{ detail: `${head}${mark}${tail}` }] }), "x.json"), []), [], head);
    for (let at = 200 - mark.length + 1; at < 200; at++) {
      const detail = `${" ".repeat(at - head.length)}${head}${mark}${tail}`.padEnd(260, " ");
      for (const [name, cut] of [["remeasure", remeasure(detail)], ["gate1", gate1(detail)]] as const) {
        assert.ok(cut.length <= 200 + mark.length + 1, `${name}: ${cut.length}`);
        assert.ok(cut.endsWith("…"));
        const body = cut.slice(0, -1);
        // the mark is there whole or not at all
        assert.ok(!body.includes("[redacted") || body.includes(mark), `${name} at ${at}: ${body.slice(-40)}`);
        assert.deepEqual(blockingFindings(scanFileText(JSON.stringify({ rows: [{ detail: cut }] }), "x.json"), []).map((f) => f.kind), [], `${name} at ${at}`);
      }
    }
  }
  // a short detail, and a long one with nothing for the gate at the cut, are cut as before
  assert.equal(remeasure("ok"), "ok");
  assert.equal(remeasure("ab ".repeat(90)), `${"ab ".repeat(90).slice(0, 200)}…`);
  // a random-looking run cut at 200 is cut as before (pages already public hold such pieces, src/daily/detail-cut.ts)
  assert.equal(remeasure("b".repeat(250)), `${"b".repeat(200)}…`);
});
