/**
 * The check without Node: the Python example (examples/python/check_before_paying.py) and the Python and
 * curl lines on use.html, each run against /v1/check's own handler (http.ts) on loopback, on fixtures where
 * XONA is avoid. What is checked is the one thing they are for: on avoid, nothing pays.
 * Also the public English rule for the new text: no first person plural, no em dash, no Japanese.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { CHECK_ENDPOINT, CURL_LINES, PYTHON_SNIPPET } from "../../../src/rank/html.js";
import { handleCheck, type CheckData } from "../src/http.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const FX = join(import.meta.dirname, "fixtures");
const EXAMPLE = join(ROOT, "examples", "python", "check_before_paying.py");
const XONA = "https://api.xona-agent.com/token/pumpfun-trending";
const XONA_PAYTO = "9VaDVp1Wb78G4Wm6VuTiMrpESjrUymXefQTHcJGRSTEA";
const NOBODY = "https://nobody.example/paid?a=1&b=2";
const json = (f: string) => JSON.parse(readFileSync(join(FX, f), "utf8")) as unknown;
const data: CheckData = {
  rank: json("verdict-rank.json"),
  recordsIndex: json("verdict-records-index.json"),
  lanes: ["arbitrum", "robinhood"].map((l) => json(`verdict-lane-${l}.json`)),
  notified: json("verdict-notified.json"),
};

const has = (cmd: string, args: string[]) => spawnSync(cmd, args, { encoding: "utf8" }).status === 0;
const PYTHON = has("python3", ["--version"]);
const JQ = has("jq", ["--version"]);
const BASH = has("bash", ["--version"]) && has("curl", ["--version"]);

let server: Server;
let endpoint = "";
const seen: string[] = [];

before(async () => {
  server = createServer(async (req, res) => {
    const url = `http://127.0.0.1${req.url ?? "/"}`;
    seen.push(url);
    const r = await handleCheck(new Request(url, { method: req.method ?? "GET" }), () => data);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/check`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

/** Async: the server answers on this process's event loop, so a child must not block it (no spawnSync). */
function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d));
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status: number | null) => resolve({ status, stdout, stderr }));
  });
}

test("the handler on loopback: XONA is avoid on these fixtures, an unknown seller is unknown", async () => {
  const a = (await (await fetch(`${endpoint}?url=${encodeURIComponent(XONA)}`)).json()) as { verdict: string };
  const u = (await (await fetch(`${endpoint}?url=${encodeURIComponent(NOBODY)}`)).json()) as { verdict: string };
  assert.equal(a.verdict, "avoid");
  assert.equal(u.verdict, "unknown");
});

test("Python example: its own tests pass (python3, standard library, a mock of /v1/check)", { skip: !PYTHON && "no python3" }, async () => {
  const r = await run("python3", ["-B", "-m", "unittest", "discover", "-s", join(ROOT, "examples", "python"), "-p", "test_*.py"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /Ran 12 tests[\s\S]*\nOK( \(skipped=2\))?\n/, "12 tests; the 2 with the real x402 client run where x402 is installed");
});

test("Python example against the real handler: avoid exits 1 and says why; unknown goes on; chain and payTo reach the query", { skip: !PYTHON && "no python3" }, async () => {
  const env = { VET402_CHECK_ENDPOINT: endpoint };
  const avoid = await run("python3", ["-B", EXAMPLE, XONA], env);
  assert.equal(avoid.status, 1, avoid.stderr);
  assert.match(avoid.stdout, /^vet402: avoid\. vet402 paid this seller /);
  seen.length = 0;
  const scoped = await run("python3", ["-B", EXAMPLE, XONA, "--chain", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "--pay-to", XONA_PAYTO], env);
  assert.equal(scoped.status, 1, scoped.stderr);
  const q = new URL(seen[0]!).searchParams;
  assert.deepEqual([q.get("url"), q.get("chain"), q.get("payTo")], [XONA, "solana", XONA_PAYTO]);
  const unknown = await run("python3", ["-B", EXAMPLE, NOBODY, "--chain", "eip155:137"], env);
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.match(unknown.stdout, /^vet402: unknown\./);
  assert.equal(new URL(seen.at(-1)!).searchParams.get("chain"), null, "a chain /v1/check does not know is not sent");
});

test("use.html's Python lines: on avoid pay is never called; on unknown it is; with no answer it is not", { skip: !PYTHON && "no python3" }, async () => {
  assert.ok(PYTHON_SNIPPET.includes(CHECK_ENDPOINT));
  const program = (ep: string) => `import sys\nseller_url = sys.argv[1]\npaid = []\ndef pay(u):\n    paid.append(u)\n\n${PYTHON_SNIPPET.replace(CHECK_ENDPOINT, ep)}\nprint("paid" if paid else "not paid")\n`;
  const avoid = await run("python3", ["-B", "-c", program(endpoint), XONA]);
  assert.equal(avoid.stdout, "not paid\n", avoid.stderr);
  const unknown = await run("python3", ["-B", "-c", program(endpoint), NOBODY]);
  assert.equal(unknown.stdout, "paid\n", unknown.stderr);
  const down = await run("python3", ["-B", "-c", program("http://127.0.0.1:9/v1/check"), NOBODY]);
  assert.notEqual(down.status, 0);
  assert.ok(!down.stdout.includes("paid"));
});

test("use.html's curl lines: pay runs only when the answer is not avoid, with jq and without", { skip: !BASH && "no bash or curl" }, async () => {
  assert.ok(CURL_LINES[2].includes("jq") && !CURL_LINES[4].includes("jq"));
  const lines = (ep: string, url: string, which: 2 | 4) =>
    [`pay() { echo "paid $1"; }`, `URL='${url}'`, CURL_LINES[which].replace(CHECK_ENDPOINT, ep), `echo done`].join("\n");
  for (const which of JQ ? ([2, 4] as const) : ([4] as const)) {
    const avoid = await run("bash", ["-c", lines(endpoint, XONA, which)]);
    assert.equal(avoid.stdout, "done\n", `${which}: ${avoid.stderr}`);
    const unknown = await run("bash", ["-c", lines(endpoint, NOBODY, which)]);
    assert.equal(unknown.stdout, `paid ${NOBODY}\ndone\n`, `${which}: ${unknown.stderr}`);
    assert.equal(new URL(seen.at(-1)!).searchParams.get("url"), NOBODY, "the query string of the seller URL arrives intact");
    const down = await run("bash", ["-c", lines("http://127.0.0.1:9/v1/check", NOBODY, which)]);
    assert.equal(down.stdout, "done\n", `${which}: no answer, no payment`);
  }
  assert.equal(CURL_LINES[0], `URL='${XONA}'`);
});

// Built from parts so this file does not match itself (check.test.ts scans every file of the package).
const PLURAL = new RegExp(`\\b(${["w" + "e", "u" + "s", "o" + "ur", "o" + "urs"].join("|")})\\b`, "i");
const JAPANESE = new RegExp("[" + ([[0x3040, 0x30ff], [0x3400, 0x9fff], [0xff00, 0xffef]] as [number, number][]).map(([a, b]) => String.fromCharCode(a) + "-" + String.fromCharCode(b)).join("") + "]");

test("public English in the new text: no first person plural, no em dash, no Japanese", () => {
  const use = readFileSync(join(ROOT, "site", "use.html"), "utf8");
  const sections = use.slice(use.indexOf('<h2 id="python">'), use.indexOf('<h2 id="hook">'));
  assert.ok(sections.length > 500);
  const texts: [string, string][] = [
    ["use.html Python and curl", sections.replace(/<[^>]+>/g, " ")],
    ["use.html", use.slice(use.indexOf("<main>"), use.indexOf("</main>")).replace(/<[^>]+>/g, " ")],
    ["PYTHON_SNIPPET", PYTHON_SNIPPET],
    ["CURL_LINES", CURL_LINES.join("\n")],
    ["examples/python/check_before_paying.py", readFileSync(EXAMPLE, "utf8")],
    ["examples/python/test_check_before_paying.py", readFileSync(join(ROOT, "examples", "python", "test_check_before_paying.py"), "utf8")],
    ["packages/check/README.md", readFileSync(join(ROOT, "packages", "check", "README.md"), "utf8")],
    ["packages/check/package.json", readFileSync(join(ROOT, "packages", "check", "package.json"), "utf8")],
    ["packages/check/scripts/build.mjs", readFileSync(join(ROOT, "packages", "check", "scripts", "build.mjs"), "utf8")],
  ];
  for (const [name, t] of texts) {
    assert.ok(!JAPANESE.test(t), `${name}: Japanese`);
    assert.ok(!t.includes(String.fromCharCode(0x2014)), `${name}: em dash`);
    assert.ok(!PLURAL.test(t), `${name}: first person plural`);
  }
});
