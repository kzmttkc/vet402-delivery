/**
 * 3.11 Polygon: the stops on the real entry, scripts/evm-lane.ts --lane polygon --hosts --pay.
 *
 * Every case runs the script itself as a child process against a local JSON-RPC (Polygon, chain 137) and a local
 * seller that answers 402. HOME, the key directory, the results directory, the wallet registry, the daily state and
 * the gate files are all inside a temporary root. The key directory holds evm.pub only (the public address), never
 * evm.json: if a stop did not hold, the run would fail at reading the key, and the seller counts every request that
 * carries a payment header. Nothing is signed or sent, and no real key, registry or ledger is read.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { getAddress, hashDomain, pad, toHex } from "viem";

const PAYER = getAddress("0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51");
const SELLER = getAddress("0x50ab2018c06c6E4eAA9BA52057Eb55eD284912fc");
const OTHER = getAddress("0x1111111111111111111111111111111111111111");
const USDC = getAddress("0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359");
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
/** Above any start block the lane may scan from; the fake chain's head. */
const HEAD = 97_100_000n;
const PRICE = "5000";

const DOMAIN_SEPARATOR = hashDomain({
  domain: { name: "USD Coin", version: "2", chainId: 137n, verifyingContract: USDC },
  types: { EIP712Domain: [{ name: "name", type: "string" }, { name: "version", type: "string" }, { name: "chainId", type: "uint256" }, { name: "verifyingContract", type: "address" }] },
});

interface ChainState {
  balance: bigint;
  /** USDC Transfer logs out of the payer, by block. */
  outflows: { block: bigint; amount: bigint }[];
  /** The payer's Polygon nonce (transactions it has sent), and those that are mined, by hash. */
  nonce: bigint;
  txs: Record<string, { nonce: bigint; gasUsed: bigint; gasPrice: bigint; value: bigint }>;
  calls: string[];
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

async function body(req: IncomingMessage): Promise<string> {
  let s = "";
  for await (const c of req) s += c;
  return s;
}

function rpcResult(chain: ChainState, method: string, params: unknown[]): unknown {
  chain.calls.push(method);
  switch (method) {
    case "eth_chainId":
      return "0x89";
    case "eth_blockNumber":
      return toHex(HEAD);
    case "eth_getBalance":
      return toHex(10n ** 18n);
    case "eth_getTransactionCount":
      return toHex(chain.nonce);
    case "eth_getTransactionByHash":
    case "eth_getTransactionReceipt": {
      const hash = String(params[0]).toLowerCase();
      const t = chain.txs[hash];
      if (!t) return null;
      const common = { hash, transactionHash: hash, blockHash: pad(toHex(HEAD - 5n), { size: 32 }), blockNumber: toHex(HEAD - 5n), transactionIndex: "0x0", from: PAYER.toLowerCase(), to: OTHER.toLowerCase() };
      if (method === "eth_getTransactionReceipt") {
        return { ...common, cumulativeGasUsed: toHex(t.gasUsed), gasUsed: toHex(t.gasUsed), effectiveGasPrice: toHex(t.gasPrice), contractAddress: null, logs: [], logsBloom: pad("0x0", { size: 256 }), status: "0x1", type: "0x2" };
      }
      return { ...common, nonce: toHex(t.nonce), value: toHex(t.value), gas: toHex(t.gasUsed), gasPrice: toHex(t.gasPrice), maxFeePerGas: toHex(t.gasPrice), maxPriorityFeePerGas: "0x0", input: "0x", type: "0x2", chainId: "0x89", v: "0x0", r: pad("0x1", { size: 32 }), s: pad("0x1", { size: 32 }), yParity: "0x0", accessList: [] };
    }
    case "eth_call": {
      const data = String((params[0] as { data?: string; input?: string }).data ?? (params[0] as { input?: string }).input ?? "");
      if (data.startsWith("0x3644e515")) return DOMAIN_SEPARATOR;
      if (data.startsWith("0x70a08231")) return pad(toHex(chain.balance), { size: 32 });
      throw new Error(`eth_call ${data.slice(0, 10)} not served`);
    }
    case "eth_getLogs": {
      const f = params[0] as { address?: string; fromBlock: string; toBlock: string; topics?: (string | null)[] };
      const from = BigInt(f.fromBlock);
      const to = f.toBlock === "latest" ? HEAD : BigInt(f.toBlock);
      if (to - from + 1n > 2_000n) throw new Error("invalid block range params");
      const wantFrom = f.topics?.[1]?.toLowerCase();
      if (f.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC || wantFrom !== pad(PAYER.toLowerCase() as `0x${string}`, { size: 32 })) return [];
      return chain.outflows
        .filter((o) => o.block >= from && o.block <= to)
        .map((o, i) => ({
          address: USDC.toLowerCase(),
          topics: [TRANSFER_TOPIC, pad(PAYER.toLowerCase() as `0x${string}`, { size: 32 }), pad(OTHER.toLowerCase() as `0x${string}`, { size: 32 })],
          data: pad(toHex(o.amount), { size: 32 }),
          blockNumber: toHex(o.block),
          blockHash: pad(toHex(o.block), { size: 32 }),
          transactionHash: pad(toHex(o.block * 1000n + BigInt(i)), { size: 32 }),
          transactionIndex: "0x0",
          logIndex: toHex(i),
          removed: false,
        }));
    }
    default:
      throw new Error(`${method} not served`);
  }
}

async function fakeChain(chain: ChainState) {
  return listen(async (req, res) => {
    const msg = JSON.parse(await body(req)) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
    const one = (m: { id: number; method: string; params: unknown[] }) => {
      try {
        return { jsonrpc: "2.0", id: m.id, result: rpcResult(chain, m.method, m.params ?? []) };
      } catch (err) {
        return { jsonrpc: "2.0", id: m.id, error: { code: -32000, message: (err as Error).message } };
      }
    };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(Array.isArray(msg) ? msg.map(one) : one(msg)));
  });
}

function accept(resource: string) {
  return { scheme: "exact", network: "eip155:137", amount: PRICE, asset: USDC, payTo: SELLER, maxTimeoutSeconds: 300, extra: { name: "USD Coin", version: "2" }, resource };
}

/** A seller that answers 402 on Polygon. `paid` counts requests that carry a payment. */
async function fakeSeller(seen: { paid: number; unpaid: number }) {
  let base = "";
  const s = await listen((req, res) => {
    if (req.headers["payment-signature"] || req.headers["x-payment"]) {
      seen.paid++;
      res.statusCode = 500;
      res.end("a payment reached the seller");
      return;
    }
    seen.unpaid++;
    const url = `${base}${req.url}`;
    const pr = { x402Version: 2, error: "Payment required", resource: { url, description: "test data", mimeType: "application/json" }, accepts: [accept(url)] };
    res.statusCode = 402;
    res.setHeader("payment-required", Buffer.from(JSON.stringify(pr)).toString("base64"));
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  base = s.url;
  return s;
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd: string, env: Record<string, string | undefined>): Promise<Run> {
  const script = new URL("../scripts/evm-lane.ts", import.meta.url).pathname;
  const tsx = new URL("../node_modules/.bin/tsx", import.meta.url).pathname;
  return new Promise((resolve) => {
    const p = spawn(tsx, [script, ...args], { cwd, env: env as NodeJS.ProcessEnv });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    const t = setTimeout(() => p.kill("SIGKILL"), 120_000);
    p.on("close", (status) => {
      clearTimeout(t);
      resolve({ status, stdout, stderr });
    });
  });
}

const LEGAL = "legal-check polygon 3.11: trial host run on eip155:137, no custody of user funds\nreviewed 2026-11-11";
const SHIP = "SHIP\nindependent review of the Polygon eip155:137 host run, 3.11";

/**
 * A temporary production-like root with every pay gate met: owner approval of the planned total, legal-check and
 * independent SHIP (copy and canonical), eip155:137 in the wallet registry, no HALT-pay, no Tempo stop. Each test
 * then breaks exactly one thing.
 */
async function harness(
  t: { after: (fn: () => void) => void },
  opts: { outflows?: { block: bigint; amount: bigint }[]; balance?: bigint; registryChains?: string[]; nonce?: bigint; txs?: ChainState["txs"] } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "vet402-311-entry-"));
  const chain: ChainState = { balance: opts.balance ?? 100_000n, outflows: opts.outflows ?? [], nonce: opts.nonce ?? 0n, txs: opts.txs ?? {}, calls: [] };
  const seen = { paid: 0, unpaid: 0 };
  const rpc = await fakeChain(chain);
  const seller = await fakeSeller(seen);
  t.after(() => {
    rpc.server.close();
    seller.server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const home = join(root, "home");
  const keys = join(home, "vet402-solana", ".keys");
  const results = join(home, "vet402-solana", "results", "evm");
  const independent = join(root, "review");
  const catalogs = join(root, "catalogs");
  const cwd = join(root, "tree");
  for (const d of [keys, results, independent, catalogs, cwd, join(root, "daily"), join(root, "state")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(keys, "evm.pub"), `${PAYER}\n`); // the public address only: there is no evm.json to sign with
  const resource = `${seller.url}/data`;
  writeFileSync(join(catalogs, "catalog_cdp.json"), JSON.stringify({ items: [{ resource, method: "GET", x402Version: 2, accepts: [accept(resource)] }] }));
  writeFileSync(join(catalogs, "catalog_dexter.json"), JSON.stringify({ items: [] }));
  writeFileSync(join(catalogs, "catalog_payai.json"), JSON.stringify({ items: [] }));
  writeFileSync(join(root, "registry.json"), JSON.stringify({ chains: Object.fromEntries((opts.registryChains ?? ["eip155:137", "eip155:8453"]).map((c) => [c, { addresses: [PAYER] }])) }));
  writeFileSync(join(results, "polygon-owner-approval.json"), JSON.stringify({ kind: "vet402-evm-polygon-owner-approval", approvedTotalAtomic: PRICE, approvedAt: "2026-11-11T00:00:00.000Z" }));
  for (const [name, text] of [["polygon-legal-check.memo", LEGAL], ["polygon-review-ship.txt", SHIP]] as const) {
    writeFileSync(join(results, name), text);
    writeFileSync(join(independent, name), text);
  }
  // The balance baseline the earlier lane read: the balance has not moved since, whatever left the payer.
  writeFileSync(join(results, "evm-payer-usdc-baseline.json"), JSON.stringify({ baselineAtomic: chain.balance.toString(), recordedAt: "2026-11-10T00:00:00.000Z" }));
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    EVM_KEY_DIR: keys,
    VET402_WALLET_REGISTRY: join(root, "registry.json"),
    VET402_REVIEW_DIR: independent,
    VET402_DAILY_STATE: join(root, "daily"),
    VET402_STATE_DIR: join(root, "state"),
    POLYGON_RPC_URL: rpc.url,
    POLYGON_RECEIPT_RPC_URL: rpc.url,
    POLYGON_LOGS_RPC_URL: rpc.url,
  };
  delete env.VET402_EVM_RESULTS_DIR;
  delete env.VET402_EVM_PAY;
  delete env.VET402_EVM_OWNER_APPROVED_TOTAL;
  const today = new Date().toISOString().slice(0, 10);
  const dry = () => run(["--lane", "polygon", "--hosts", "--catalogs", catalogs, "--dry-run"], cwd, env);
  const planFile = () => {
    const dir = join(cwd, "results", "evm");
    const f = readdirSync(dir).find((n) => /^polygon-hosts-.*dryrun\.json$/.test(n));
    assert.ok(f, `no dry-run plan in ${dir}`);
    return join(dir, f!);
  };
  const pay = (extraEnv: Record<string, string> = {}) =>
    run(["--lane", "polygon", "--hosts", "--catalogs", catalogs, "--pay", "--run-date", today, "--plan", planFile()], cwd, { ...env, VET402_EVM_PAY: "polygon", ...extraEnv });
  return { root, chain, seen, results, independent, home, dry, pay, env, cwd };
}

/** The run stopped before the key: the key file was never opened and no payment reached the seller. */
function assertNothingSigned(r: Run, seen: { paid: number }) {
  assert.equal(seen.paid, 0, "a payment reached the seller");
  assert.doesNotMatch(r.stderr, /evm\.json|ENOENT/, `the run went on to read the key:\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /\[pay\] lane polygon/, `the run reached the pay preflight:\n${r.stderr}`);
}

test("3.11-3 entry: the dry run plans the cheapest Polygon host and its total, with no signature and no payment", async (t) => {
  const h = await harness(t);
  const r = await h.dry();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^total\t5000$/m, "the total is printed before any signature");
  const plan = JSON.parse(readFileSync(join(h.cwd, "results", "evm", readdirSync(join(h.cwd, "results", "evm")).find((n) => n.includes("dryrun"))!), "utf8")) as { polygonHosts: { plan: { amountAtomic: string }[]; planTotalAtomic: string } };
  assert.equal(plan.polygonHosts.plan.length, 1);
  assert.equal(plan.polygonHosts.planTotalAtomic, PRICE);
  assert.equal(h.seen.paid, 0);
  assert.ok(h.seen.unpaid >= 1, "the live 402 was read");
});

test("3.11-6 entry: with every other gate met, no daily-root path on Polygon stops --pay before the key (control: the stops below are the gates, not the harness)", async (t) => {
  const h = await harness(t);
  assert.equal((await h.dry()).status, 0);
  const r = await h.pay();
  assert.equal(r.status, 8, r.stderr);
  assert.match(r.stderr, /no daily-root path on Polygon: DeliveryRoots is not a Polygon roots lane yet, .*; nothing signed/);
  assertNothingSigned(r, h.seen);
  assert.ok(h.chain.calls.includes("eth_getTransactionCount"), "the payer's Polygon transactions were read against the POL ledger");
});

const ROOT_TX = `0x${"ab".repeat(32)}`;

test("3.11-6 entry: a Polygon transaction from the payer that is not on the POL ledger stops --pay before the key (chain_spend_exceeds_ledger)", async (t) => {
  // The payer sent one transaction on Polygon (a daily-root fee in POL), and the POL ledger has no entry for it.
  const h = await harness(t, { nonce: 1n, txs: { [ROOT_TX]: { nonce: 0n, gasUsed: 24_000n, gasPrice: 200_000_000_000n, value: 0n } } });
  assert.equal((await h.dry()).status, 0);
  const r = await h.pay();
  assert.equal(r.status, 8, r.stderr);
  assert.match(r.stderr, /chain_spend_exceeds_ledger: 1 Polygon transaction\(s\) from the payer are not on the POL ledger.*; nothing signed/);
  assertNothingSigned(r, h.seen);
});

test("3.11-6 entry: a POL fee above what the POL ledger holds stops --pay before the key; one within it is not a stop", async (t) => {
  const tx = { nonce: 0n, gasUsed: 24_000n, gasPrice: 200_000_000_000n, value: 0n }; // 4.8e15 wei
  const h = await harness(t, { nonce: 1n, txs: { [ROOT_TX]: tx } });
  assert.equal((await h.dry()).status, 0);
  writeFileSync(join(h.results, "polygon-pol-ledger.json"), JSON.stringify({ entries: [{ tx: ROOT_TX, nonce: 0, boundWei: "4000000000000000" }] }));
  const over = await h.pay();
  assert.equal(over.status, 8, over.stderr);
  assert.match(over.stderr, /chain_spend_exceeds_ledger: Polygon POL outflow 4800000000000000 wei > POL ledger 4000000000000000 wei/);
  assertNothingSigned(over, h.seen);
  writeFileSync(join(h.results, "polygon-pol-ledger.json"), JSON.stringify({ entries: [{ tx: ROOT_TX, nonce: 0, boundWei: "12000000000000000" }] }));
  const within = await h.pay();
  assert.equal(within.status, 8, within.stderr);
  assert.doesNotMatch(within.stderr, /chain_spend_exceeds_ledger/);
  assert.match(within.stderr, /no daily-root path on Polygon/, within.stderr);
  assertNothingSigned(within, h.seen);
  assert.ok(h.chain.calls.includes("eth_getTransactionReceipt"), "the ledger's transaction was read back from its receipt");
});

test("3.11-6 entry: an unreadable POL ledger stops --pay before the key", async (t) => {
  const h = await harness(t);
  assert.equal((await h.dry()).status, 0);
  writeFileSync(join(h.results, "polygon-pol-ledger.json"), "{ not json");
  const r = await h.pay();
  assert.equal(r.status, 8, r.stderr);
  assert.match(r.stderr, /Polygon POL outflow unreadable/);
  assertNothingSigned(r, h.seen);
});

test("3.11-6 entry: USDC that left the payer on Polygon beyond the Polygon ledger stops --pay before the key, even when the balance did not move", async (t) => {
  // 5000 left the payer after the lane's start block, and 5000 came in: the balance equals the old baseline.
  const h = await harness(t, { outflows: [{ block: HEAD - 10n, amount: 5000n }] });
  assert.equal((await h.dry()).status, 0);
  const r = await h.pay();
  assert.match(r.stderr, /chain_spend_exceeds_ledger: on-chain outflow 5000 > ledger 0/, r.stderr);
  assert.match(r.stderr, /nothing signed/);
  assert.equal(r.status, 8, r.stderr);
  assertNothingSigned(r, h.seen);
  assert.ok(h.chain.calls.includes("eth_getLogs"), "the outflow is read from the Transfer logs");
});

test("3.11-6 entry: the outflow is read from the logs, not from a file: deleting or rewriting the balance baseline does not clear the stop", async (t) => {
  const h = await harness(t, { outflows: [{ block: HEAD - 10n, amount: 5000n }] });
  assert.equal((await h.dry()).status, 0);
  writeFileSync(join(h.results, "evm-payer-usdc-baseline.json"), JSON.stringify({ baselineAtomic: "0", recordedAt: "2026-11-11T00:00:00.000Z" }));
  const r = await h.pay();
  assert.equal(r.status, 8, r.stderr);
  assert.match(r.stderr, /chain_spend_exceeds_ledger/);
  assertNothingSigned(r, h.seen);
});

test("3.11-6 entry: an outflow the Polygon ledger accounts for is not a stop (the run reaches the last gate, the daily-root path)", async (t) => {
  const h = await harness(t, { outflows: [{ block: HEAD - 10n, amount: 5000n }] });
  writeFileSync(join(h.results, "polygon-ledger.json"), JSON.stringify({ baselineAtomic: null, spentAtomic: "5000", purchases: [{ key: "polygon-host:earlier", amount: "5000", at: "2026-11-11T00:00:00.000Z" }] }));
  // The earlier purchase is not part of this plan's ledger of the day, and the lane cap still has room.
  assert.equal((await h.dry()).status, 0);
  const r = await h.pay();
  assert.doesNotMatch(r.stderr, /chain_spend_exceeds_ledger/);
  assert.match(r.stderr, /no daily-root path on Polygon/, r.stderr);
  assertNothingSigned(r, h.seen);
});

test("3.11-6 entry: Robinhood USDG on another ledger does not cover Polygon outflow (the lanes are not summed)", async (t) => {
  const h = await harness(t, { outflows: [{ block: HEAD - 10n, amount: 5000n }] });
  writeFileSync(join(h.results, "robinhood-ledger.json"), JSON.stringify({ baselineAtomic: null, spentAtomic: "900000", purchases: [{ key: "robinhood-payto:0x1", amount: "900000", at: "2026-11-08T00:00:00.000Z" }] }));
  assert.equal((await h.dry()).status, 0);
  const r = await h.pay();
  assert.equal(r.status, 8, r.stderr);
  assert.match(r.stderr, /chain_spend_exceeds_ledger: on-chain outflow 5000 > ledger 0/);
  assertNothingSigned(r, h.seen);
});

test("3.11-4 entry: no eip155:137 in wallet_registry.json stops --pay before the key", async (t) => {
  const h = await harness(t, { registryChains: ["eip155:4663", "eip155:8453"] });
  assert.equal((await h.dry()).status, 0);
  const r = await h.pay();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /wallet_registry\.json has no eip155:137/);
  assertNothingSigned(r, h.seen);
});

test("3.11-3 entry: the owner approval is the record on disk; the environment variable alone stops --pay before the key", async (t) => {
  const h = await harness(t);
  assert.equal((await h.dry()).status, 0);
  rmSync(join(h.results, "polygon-owner-approval.json"));
  const r = await h.pay({ VET402_EVM_OWNER_APPROVED_TOTAL: PRICE });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /owner approval record missing/);
  assertNothingSigned(r, h.seen);
});

test("3.11-3 entry: a self-written SHIP that is not the independent review on disk stops --pay before the key", async (t) => {
  const h = await harness(t);
  assert.equal((await h.dry()).status, 0);
  rmSync(join(h.independent, "polygon-review-ship.txt"));
  const r = await h.pay();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /independent review artifact on disk/);
  assertNothingSigned(r, h.seen);
});

test("3.11-3 entry: a legal-check memo written only beside the results (no independent memo on disk) stops --pay before the key", async (t) => {
  const h = await harness(t);
  assert.equal((await h.dry()).status, 0);
  rmSync(join(h.independent, "polygon-legal-check.memo"));
  const r = await h.pay();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /independent legal-check memo on disk/);
  assertNothingSigned(r, h.seen);
});

test("3.11-3 entry: a self-written two-line SHIP that differs from the independent review on disk stops --pay before the key", async (t) => {
  const h = await harness(t);
  assert.equal((await h.dry()).status, 0);
  writeFileSync(join(h.results, "polygon-review-ship.txt"), "SHIP\nself-check of the Polygon eip155:137 run");
  const r = await h.pay();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /must match the independent review artifact on disk/);
  assertNothingSigned(r, h.seen);
});

test("3.11-3 entry: the daily HALT-pay (shared payer with Tempo) stops --pay before the key", async (t) => {
  const h = await harness(t);
  assert.equal((await h.dry()).status, 0);
  writeFileSync(join(h.root, "daily", "HALT-pay"), "not_settled on tempo 2026-11-10\n");
  const r = await h.pay();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /HALT-pay is set/);
  assertNothingSigned(r, h.seen);
});

test("3.11-6 entry: Tempo's last run stopped (not_settled) stops --pay before the key", async (t) => {
  const h = await harness(t);
  assert.equal((await h.dry()).status, 0);
  const remeasure = join(h.home, "vet402-solana", "results", "remeasure");
  mkdirSync(remeasure, { recursive: true });
  writeFileSync(join(remeasure, "tempo-2026-11-10.json"), JSON.stringify({ runs: [{ stopped: null }, { stopped: "not_settled" }] }));
  const r = await h.pay();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Tempo is stopped \(not_settled\)/);
  assertNothingSigned(r, h.seen);
});

test("3.11-1 entry: --lane monad stops with the 3.11.0 FAIL reason before anything is read, with or without --pay", async (t) => {
  const h = await harness(t);
  for (const extra of [["--dry-run"], ["--pay"]]) {
    const r = await run(["--lane", "monad", "--hosts", ...extra], h.cwd, { ...h.env, VET402_EVM_PAY: "monad,polygon" });
    assert.equal(r.status, 7, r.stderr);
    assert.match(r.stderr, /3\.11\.0 is FAIL: no purchase lane on eip155:143/);
    assert.equal(h.chain.calls.length, 0, "no RPC call");
    assert.equal(h.seen.unpaid + h.seen.paid, 0, "no seller request");
  }
});

test("3.11-4 entry: the dry run's funding line for Polygon says whether a deposit may be asked (registry), and never for Monad", async (t) => {
  const h = await harness(t, { registryChains: ["eip155:4663", "eip155:8453"], balance: 0n });
  const r = await h.dry();
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { funding: Record<string, { chain: string; depositRequest?: string }> };
  assert.equal(out.funding.polygon?.chain, "eip155:137");
  assert.match(out.funding.polygon?.depositRequest ?? "", /wallet_registry\.json has no eip155:137; do not request a deposit/);
  assert.equal(Object.values(out.funding).some((f) => f.chain === "eip155:143"), false);
});
