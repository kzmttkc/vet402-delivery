/**
 * Celo weekly DeliveryRoots: leaves from export.csv, week boundaries, plan/send guards.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { recordDigest } from "../src/evm/evm-anchor.js";
import { ROOTS_POSTER_ADDRESS } from "../src/evm/key.js";
import { runtimeWithWriter } from "../src/evm/roots.js";
import { verifyInclusion } from "../src/receipt/merkle.js";
import {
  amountFromExport,
  inWeek,
  lastClosedWeekSunday,
  parseCeloExport,
  publicLeafFromExport,
  rowsForWeek,
  saltFromCeloExport,
  weekRootFromRows,
  weekSundayOf,
  buildCeloRootsFile,
  celoRootsFileProblems,
  CELO_REGISTRY,
  type CeloSentWeek,
} from "../src/evm/celo-roots.js";
import { getAddress, type Hex } from "viem";

const ROOT = new URL("..", import.meta.url).pathname;
const FIXTURE = join(ROOT, "test/fixtures/celo-weekly-export.csv");
const TX = (b: string) => (`0x${b.repeat(64)}`.slice(0, 66)) as Hex;
const CLOSED = String(Date.parse("2026-11-09T00:00:01Z") / 1000);
const ZERO_ROOT = `0x${"0".repeat(64)}`;

/** A Celo JSON-RPC that is not forno. rootOf is the zero root, so a week looks open. */
function fakeCeloRpc(): Promise<{ url: string; calls: string[]; close: () => Promise<void> }> {
  const calls: string[] = [];
  const code = runtimeWithWriter(ROOTS_POSTER_ADDRESS);
  const server = createServer(async (req, res) => {
    const msg = JSON.parse(await readBody(req)) as { id?: number; method?: string } | { id?: number; method?: string }[];
    const one = (m: { id?: number; method?: string }) => {
      const method = m.method ?? "";
      calls.push(method);
      try {
        return { jsonrpc: "2.0", id: m.id ?? null, result: celoRpcResult(method, code) };
      } catch (err) {
        return { jsonrpc: "2.0", id: m.id ?? null, error: { code: -32601, message: (err as Error).message } };
      }
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(Array.isArray(msg) ? msg.map(one) : one(msg)));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve({ url, calls, close: () => closeServer(server) });
    });
  });
}

function celoRpcResult(method: string, code: string): string {
  switch (method) {
    case "eth_chainId":
      return "0xa4ec";
    case "eth_call":
      return ZERO_ROOT;
    case "eth_estimateGas":
      return "0x186a0";
    case "eth_gasPrice":
      return "0x5f5e100";
    case "eth_getBalance":
      return "0xde0b6b3a7640000";
    case "eth_getCode":
      return code;
    default:
      throw new Error(`${method} not served`);
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
}

/** Child env points the script at `rpc` and drops a parent CELO_RPC_URL so forno is not used. Async so the fake RPC can answer. */
function spawnRoot(args: string[], rpc: string, opts: { cwd?: string; anchorSend?: boolean } = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, VET402_CELO_RPC_URL: rpc, VET402_DAILY_NOW: CLOSED };
  delete env.CELO_RPC_URL;
  if (opts.anchorSend) env.VET402_ANCHOR_SEND = "celo";
  else delete env.VET402_ANCHOR_SEND;
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", join(ROOT, "scripts/celo-weekly-root.ts"), ...args], { cwd: opts.cwd ?? ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => { stdout += d; });
    child.stderr.on("data", (d: string) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("amountAtomic uses confirmed_units only when positive", () => {
  assert.equal(amountFromExport({ confirmed_units: "100", spent_units: "200" } as Parameters<typeof amountFromExport>[0]), "100");
  assert.equal(amountFromExport({ confirmed_units: "0", spent_units: "20000" } as Parameters<typeof amountFromExport>[0]), null);
  assert.equal(amountFromExport({ confirmed_units: "", spent_units: "500" } as Parameters<typeof amountFromExport>[0]), null);
});

test("week boundaries: Mon 00:00 through Sun 23:59:59 in week ending Sunday", () => {
  const sun = "2026-11-08";
  assert.equal(weekSundayOf("2026-11-03T10:00:00Z"), sun);
  assert.ok(inWeek("2026-11-02T00:00:00Z", sun));
  assert.ok(inWeek("2026-11-08T23:59:59Z", sun));
  assert.ok(!inWeek("2026-11-09T00:00:00Z", sun));
  assert.ok(!inWeek("2026-11-01T23:59:59Z", sun));
});

test("leaves and root are fixed by export.csv rows alone", () => {
  const rows = parseCeloExport(readFileSync(FIXTURE, "utf8"));
  const picked = rowsForWeek(rows, "2026-11-08");
  assert.equal(picked.length, 3);
  const a = weekRootFromRows("2026-11-08", picked, "2026-11-09T00:00:01Z");
  const b = weekRootFromRows("2026-11-08", picked, "2026-11-09T00:00:01Z");
  assert.equal(a.root.root, b.root.root);
  assert.equal(a.root.n, 3);
  assert.equal(a.salts[picked[0]!.purchase_id], saltFromCeloExport(picked[0]!));
  for (let i = 0; i < 3; i++) assert.ok(verifyInclusion(recordDigest(a.root.leaves[i]), a.root.proofs[i]!, a.root.root));
  const leaf0 = publicLeafFromExport(picked[0]!, saltFromCeloExport(picked[0]!));
  assert.equal(leaf0.method, "GET");
  assert.equal(leaf0.chainCheck, "transfer_found");
  assert.equal(publicLeafFromExport(picked[1]!, saltFromCeloExport(picked[1]!)).method, "POST");
  assert.equal(a.root.root, "0xbc4c6d156f8476aea9aae0300540fc62e2a85ac692234b417a7bd7fa252b0277");
});

test("open week is refused", () => {
  const rows = parseCeloExport(readFileSync(FIXTURE, "utf8"));
  const picked = rowsForWeek(rows, "2026-11-08");
  assert.throws(() => weekRootFromRows("2026-11-08", picked, "2026-11-08T12:00:00Z"), /not over/);
});

test("lastClosedWeekSunday matches fixture week", () => {
  assert.equal(lastClosedWeekSunday(new Date("2026-11-09T00:00:01Z")), "2026-11-08");
});

test("plan without --send writes plan and salts; --send without VET402_ANCHOR_SEND refuses", async () => {
  const fake = await fakeCeloRpc();
  const dir = mkdtempSync(join(tmpdir(), "celo-plan-"));
  try {
    const anchors = join(dir, "anchors");
    const r1 = await spawnRoot(["--csv", FIXTURE, "--week", "2026-11-08", "--anchors-dir", anchors], fake.url);
    assert.equal(r1.status, 0, r1.stderr);
    const plan = JSON.parse(r1.stdout);
    assert.equal(plan.n, 3);
    assert.equal(plan.state, "open");
    assert.ok(plan.quote);
    assert.ok(fake.calls.includes("eth_call"));
    assert.ok(!fake.calls.some((m) => m === "eth_sendRawTransaction" || m === "eth_sendTransaction"));
    assert.ok(existsSync(join(anchors, "celo-week-2026-11-08.plan.json")));
    assert.ok(existsSync(join(anchors, "celo-week-2026-11-08.salts.json")));
    const r2 = await spawnRoot(["--csv", FIXTURE, "--week", "2026-11-08", "--send", "--anchors-dir", anchors], fake.url);
    assert.match(r2.stderr + r2.stdout, /VET402_ANCHOR_SEND=celo/);
  } finally {
    rmSync(dir, { recursive: true });
    await fake.close();
  }
});

test("double send is refused when sent.json is already sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "celo-sent-"));
  const anchors = join(dir, "results", "evm", "anchors");
  mkdirSync(anchors, { recursive: true });
  writeFileSync(
    join(anchors, "celo-week-2026-11-08.sent.json"),
    JSON.stringify({
      lane: "celo",
      week: "2026-11-08",
      root: "0x" + "aa".repeat(32),
      n: 1,
      status: "sent",
      hash: TX("f"),
      registry: CELO_REGISTRY,
      leaves: [],
    }) + "\n",
    { mode: 0o600 },
  );
  chmodSync(join(anchors, "celo-week-2026-11-08.sent.json"), 0o600);
  const fake = await fakeCeloRpc();
  try {
    const r = await spawnRoot(["--csv", FIXTURE, "--week", "2026-11-08", "--send"], fake.url, { cwd: dir, anchorSend: true });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /already sent/);
    assert.deepEqual(fake.calls, []);
  } finally {
    rmSync(dir, { recursive: true });
    await fake.close();
  }
});

test("--send rejects --csv", async () => {
  const fake = await fakeCeloRpc();
  const dir = mkdtempSync(join(tmpdir(), "celo-csv-"));
  try {
    const r = await spawnRoot(["--csv", FIXTURE, "--week", "2026-11-08", "--send"], fake.url, { cwd: dir, anchorSend: true });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /omit --csv/);
    assert.deepEqual(fake.calls, []);
  } finally {
    rmSync(dir, { recursive: true });
    await fake.close();
  }
});

test("buildCeloRootsFile validates proofs", () => {
  const rows = parseCeloExport(readFileSync(FIXTURE, "utf8"));
  const { root } = weekRootFromRows("2026-11-08", rowsForWeek(rows, "2026-11-08"), "2026-11-09T00:00:01Z");
  const sent: CeloSentWeek = {
    lane: "celo",
    week: "2026-11-08",
    root: root.root,
    n: root.n,
    status: "sent",
    hash: TX("e"),
    block: "1",
    registry: getAddress(CELO_REGISTRY),
    leaves: root.leaves,
  };
  const f = buildCeloRootsFile([sent], null);
  assert.equal(celoRootsFileProblems(f).length, 0);
  assert.equal(f.days[0]!.published, 3);
});
