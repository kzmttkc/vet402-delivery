/**
 * The framework examples (packages/check/examples/), with no network. The frameworks are not dependencies of
 * this repository, so each TypeScript example is copied to a temporary folder with its imports pointed at a
 * stand-in for the framework's tool function (it returns the definition it is given), at this package's
 * source for "@vet402/check", and at the repository's own "@x402/fetch" and "zod". The tool is then called
 * as the framework would call it, over a 402 served in memory and a spy signer: a seller whose verdict is
 * avoid, and a 402 asking more than 10 times what vet402 paid, never reach the signer; another seller is paid.
 * The LangChain example runs its own Python tests against /v1/check's handler on loopback.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { tsImport } from "tsx/esm/api";
import { x402Client } from "@x402/fetch";
import { handleCheck, type CheckData } from "../src/http.js";
import { PublicData } from "../src/sources.js";

const PKG = join(import.meta.dirname, "..");
const ROOT = join(PKG, "..", "..");
const FX = join(import.meta.dirname, "fixtures");
const EX = join(PKG, "examples");
const require = createRequire(join(ROOT, "package.json"));
const SOLANA = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const XONA = "https://api.xona-agent.com/token/pumpfun-trending";
const XONA_PAYTO = "9VaDVp1Wb78G4Wm6VuTiMrpESjrUymXefQTHcJGRSTEA";
const AGENT402 = "https://agent402.tools/api/crypto-price";
const AGENT402_PAYTO = "J7aN3PLJnTCF5qpEnvJHJsnCjcGuqC2rYtEM8Gv3xwg";

const data = () =>
  new PublicData({
    sources: { rank: join(FX, "rank.json"), recordsIndex: join(FX, "records-index.json"), recordsBase: join(FX, "records"), lanes: [], notified: join(FX, "verdict-notified.json") },
    fetch: () => Promise.reject(new Error("no network in tests")),
  });

/** A seller that answers 402 until a payment header comes, then 200. Each URL has its own payTo and amount. */
function sellers(offers: Record<string, { payTo: string; amount: string }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const h = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (h.has("payment-signature") || h.has("x-payment")) return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
    const o = offers[url]!;
    const required = { x402Version: 2, resource: { url, description: "test", mimeType: "application/json" }, accepts: [{ scheme: "exact", network: SOLANA, amount: o.amount, asset: USDC, payTo: o.payTo, maxTimeoutSeconds: 60, extra: { feePayer: "11111111111111111111111111111111" } }] };
    return new Response("{}", { status: 402, headers: { "content-type": "application/json", "payment-required": Buffer.from(JSON.stringify(required)).toString("base64") } });
  }) as typeof fetch;
}

function spyClient(): { client: x402Client; signed: () => number } {
  let n = 0;
  const client = x402Client.fromConfig({
    spendControls: false,
    schemes: [{ network: SOLANA, client: { scheme: "exact", createPaymentPayload: async (x402Version: number) => (n++, { x402Version, payload: { transaction: "signed-by-the-spy" } }) } }],
  });
  return { client, signed: () => n };
}

const tmp = mkdtempSync(join(tmpdir(), "vet402-check-examples-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** Copy an example with its imports pointed at the stand-in, this package's source and the repository's modules. */
async function loadExample(file: string, sdk: string, stub: string): Promise<Record<string, any>> {
  const stubPath = join(tmp, `${sdk.replace(/[^a-z]/gi, "_")}.mjs`);
  writeFileSync(stubPath, stub);
  const src = readFileSync(join(EX, file), "utf8");
  for (const spec of [sdk, "@vet402/check", "@x402/fetch", "zod"]) assert.ok(src.includes(`from "${spec}"`), `${file} imports ${spec}`);
  const out = src
    .replace(`from "${sdk}"`, `from "${pathToFileURL(stubPath).href}"`)
    .replace(`from "@vet402/check"`, `from "${pathToFileURL(join(PKG, "src", "index.ts")).href}"`)
    .replace(`from "@x402/fetch"`, `from "${pathToFileURL(require.resolve("@x402/fetch")).href}"`)
    .replace(`from "zod"`, `from "${pathToFileURL(require.resolve("zod")).href}"`);
  const path = join(tmp, file.replace(/\//g, "_"));
  writeFileSync(path, out);
  return (await tsImport(pathToFileURL(path).href, import.meta.url)) as Record<string, any>;
}

const OFFERS = {
  [XONA]: { payTo: XONA_PAYTO, amount: "100000" },
  [AGENT402]: { payTo: AGENT402_PAYTO, amount: "1000" },
};

const TS_EXAMPLES: { file: string; sdk: string; stub: string; call: (def: any, url: string) => Promise<unknown>; make: (m: Record<string, any>, o: object) => any }[] = [
  {
    file: "agentkit/vet402-action.ts",
    sdk: "@coinbase/agentkit",
    stub: "export function customActionProvider(def) { return { kind: 'custom-action-provider', def }; }\n",
    make: (m, o) => m.vet402PaidFetchAction(o),
    call: (p, url) => {
      assert.equal(p.kind, "custom-action-provider");
      assert.deepEqual(Object.keys(p.def).sort(), ["description", "invoke", "name", "schema"]);
      assert.equal(p.def.schema.parse({ url }).url, url);
      return p.def.invoke({ url });
    },
  },
  {
    file: "openai-agents/vet402-tool.ts",
    sdk: "@openai/agents",
    stub: "export function tool(def) { return { kind: 'openai-agents-tool', def }; }\n",
    make: (m, o) => m.vet402PaidFetchTool(o),
    call: (t, url) => {
      assert.equal(t.kind, "openai-agents-tool");
      assert.deepEqual(Object.keys(t.def).sort(), ["description", "execute", "name", "parameters"]);
      return t.def.execute(t.def.parameters.parse({ url }));
    },
  },
  {
    file: "vercel-ai/vet402-tool.ts",
    sdk: "ai",
    stub: "export function tool(def) { return { kind: 'ai-sdk-tool', def }; }\n",
    make: (m, o) => m.vet402PaidFetchTool(o),
    call: (t, url) => {
      assert.equal(t.kind, "ai-sdk-tool");
      assert.deepEqual(Object.keys(t.def).sort(), ["description", "execute", "inputSchema"]);
      return t.def.execute(t.def.inputSchema.parse({ url }));
    },
  },
];

for (const ex of TS_EXAMPLES) {
  test(`example ${ex.file}: avoid and a 10x+ price never reach the signer; another seller is paid`, async () => {
    const m = await loadExample(ex.file, ex.sdk, ex.stub);
    assert.deepEqual(m.POLICY, { paid_not_delivered: "block", payto_differs: "block", price_jump: "block", asset_unseen: "ask_human", never_bought: "warn", stale: "warn" });
    const spy = spyClient();
    const def = ex.make(m, { client: spy.client, fetch: sellers(OFFERS), data: data() });
    const blocked = await ex.call(def, XONA);
    assert.match(JSON.stringify(blocked), /Stopped before paying/);
    assert.equal(spy.signed(), 0, "XONA (avoid, paid and not delivered) is not signed");
    const paid = await ex.call(def, AGENT402);
    assert.match(JSON.stringify(paid), /200/);
    assert.equal(spy.signed(), 1, "agent402.tools is paid");
    // A price 1000 times what vet402 paid for agent402.tools' crypto-price (1000 in obs_2026-09-28_000002).
    const spy2 = spyClient();
    const def2 = ex.make(m, { client: spy2.client, fetch: sellers({ [AGENT402]: { payTo: AGENT402_PAYTO, amount: "1000000" } }), data: data() });
    const jumped = await ex.call(def2, AGENT402);
    assert.match(JSON.stringify(jumped), /price_jump/);
    assert.equal(spy2.signed(), 0, "price_jump is not signed");
  });
}

// ---- LangChain (Python) on loopback ----

const json = (f: string) => JSON.parse(readFileSync(join(FX, f), "utf8")) as unknown;
const checkData: CheckData = {
  rank: json("verdict-rank.json"),
  recordsIndex: json("verdict-records-index.json"),
  lanes: ["arbitrum", "robinhood"].map((l) => json(`verdict-lane-${l}.json`)),
  notified: json("verdict-notified.json"),
};
const PYTHON = spawnSync("python3", ["--version"]).status === 0;
let server: Server;
let endpoint = "";
before(async () => {
  server = createServer(async (req, res) => {
    const r = await handleCheck(new Request(`http://127.0.0.1${req.url ?? "/"}`, { method: req.method ?? "GET" }), () => checkData);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/check`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

function run(cmd: string, args: string[], env: Record<string, string>): Promise<{ status: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env } });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d));
    child.stdout.resume();
    child.on("error", reject);
    child.on("close", (status: number | null) => resolve({ status, stderr }));
  });
}

test("example langchain-python: its tests pass on loopback, without langchain-core and with a stand-in for its @tool", { skip: !PYTHON && "no python3" }, async () => {
  const dir = join(EX, "langchain-python");
  const plain = await run("python3", ["-B", "-m", "unittest", "discover", "-s", dir, "-p", "test_*.py"], { VET402_CHECK_ENDPOINT: endpoint, PYTHONPATH: "" });
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stderr, /Ran 3 tests[\s\S]*\nOK\n/);
  // A stand-in langchain_core.tools.tool with the attributes a LangChain tool has (name, func).
  const stub = join(tmp, "py");
  spawnSync("mkdir", ["-p", join(stub, "langchain_core")]);
  writeFileSync(join(stub, "langchain_core", "__init__.py"), "");
  writeFileSync(
    join(stub, "langchain_core", "tools.py"),
    "class _Tool:\n    def __init__(self, fn):\n        self.func = fn\n        self.name = fn.__name__\n        self.description = fn.__doc__\n\n\ndef tool(fn):\n    return _Tool(fn)\n",
  );
  const wrapped = await run("python3", ["-B", "-m", "unittest", "discover", "-s", dir, "-p", "test_*.py"], { VET402_CHECK_ENDPOINT: endpoint, PYTHONPATH: stub, EXPECT_LANGCHAIN_STUB: "1" });
  assert.equal(wrapped.status, 0, wrapped.stderr);
});
