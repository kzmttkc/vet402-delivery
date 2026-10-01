/**
 * The EVM lanes' daily root in DeliveryRoots (src/evm/roots.ts, scripts/evm-anchor.ts, scripts/evm-roots-deploy.ts):
 * public leaves, what is published and withheld, the bytecode, and the contract on a local chain (anvil).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, keccak256, parseAbi, stringToBytes, type Address, type Hex, type PublicClient } from "viem";
import { DELIVERY_ROOTS_ARTIFACT } from "../src/evm/delivery-roots-artifact.js";
import { buildAnchorTx, canonicalJson, dayNumber, recordDigest } from "../src/evm/evm-anchor.js";
import { ROOTS_POSTER_ADDRESS } from "../src/evm/key.js";
import {
  buildRootsFile,
  deliveryRootsReadAbi,
  deployData,
  expectedRegistry,
  lanesDayRoot,
  leafIsPublic,
  openRootDays,
  purchaseDays,
  registryCodeProblem,
  rootsFileProblems,
  ROOTS_REGISTRY,
  runtimeWithWriter,
  sha256Hex,
  type PublicLeaf,
  type SentDay,
} from "../src/evm/roots.js";
import { rootsSection } from "../src/evm/roots-site.js";
import { loadLanePublic } from "../src/evm/site.js";
import { blockingFindings, scanFileText } from "../src/daily/secret-gate.js";
import { verifyInclusion } from "../src/receipt/merkle.js";

const ROOT = new URL("..", import.meta.url).pathname;
const PAYER = getAddress("0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51");
const SELLER = getAddress("0xeF2a4B6756895aAf1374640dcFCD4947959442ab");
const TX = (b: string) => (`0x${b.repeat(64)}`.slice(0, 66)) as Hex;

/** A purchase line as scripts/evm-lane.ts writes it (results/evm/<lane>-purchases.jsonl). */
const purchase = (o: { at: string; host: string; delivered?: boolean; settled?: boolean; outcome?: string; body?: string; tx?: Hex | null }) =>
  JSON.stringify({
    lane: "arbitrum",
    chain: "eip155:42161",
    agentId: "payto:x",
    resource: `https://${o.host}/v1/price`,
    method: "GET",
    at: o.at,
    outcome: o.outcome ?? "sent",
    payer: PAYER,
    payTo: SELLER,
    priceUsdc: "0.001000",
    amountAtomic: "1000",
    response: { status: o.delivered === false ? 500 : 200, contentType: "application/json", bytes: (o.body ?? "{}").length, first300: o.body ?? "{}" },
    body: o.body ?? "{}",
    settlementTx: o.tx === undefined ? TX("a") : o.tx,
    settledOnChain: o.settled ?? true,
    delivered: o.delivered ?? true,
    settleResponse: { success: true },
    facilitator: null,
    predictedProblem: null,
  });

const DAY = "2026-09-30";
const LINES = [
  purchase({ at: `${DAY}T01:00:00.000Z`, host: "good.test", body: '{"answer":"the seller text that is never published"}' }),
  purchase({ at: `${DAY}T02:00:00.000Z`, host: "bad.test", delivered: false, settled: true, body: "Internal Server Error" }),
  purchase({ at: `${DAY}T03:00:00.000Z`, host: "nopay.test", delivered: false, settled: false, tx: null }),
  purchase({ at: `${DAY}T04:00:00.000Z`, host: "refused.test", outcome: "refused" }),
  purchase({ at: "2026-10-01T00:00:01.000Z", host: "good.test" }),
];
const AFTER = "2026-10-01T00:10:00.000Z";
let saltN = 0;
const mint = () => `0x${(++saltN).toString(16).padStart(64, "0")}`;

test("the registry is the DeliveryRoots key's nonce-0 address, the same on both chains", () => {
  assert.equal(expectedRegistry(ROOTS_POSTER_ADDRESS), ROOTS_REGISTRY);
  assert.notEqual(ROOTS_POSTER_ADDRESS, PAYER, "never the payer wallet");
});

test("the committed bytecode is what forge builds from contracts/src/DeliveryRoots.sol", (t) => {
  if (spawnSync("forge", ["--version"]).status !== 0) return t.skip("forge is not installed");
  const out = mkdtempSync(join(tmpdir(), "roots-forge-"));
  const r = spawnSync("forge", ["build", "--out", join(out, "out"), "--cache-path", join(out, "cache")], { cwd: join(ROOT, "contracts"), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(readFileSync(join(out, "out", "DeliveryRoots.sol", "DeliveryRoots.json"), "utf8"));
  assert.equal(j.bytecode.object, DELIVERY_ROOTS_ARTIFACT.creation);
  assert.equal(j.deployedBytecode.object, DELIVERY_ROOTS_ARTIFACT.runtime);
  assert.deepEqual(Object.values(j.deployedBytecode.immutableReferences as Record<string, { start: number }[]>).flat().map((x) => x.start), [...DELIVERY_ROOTS_ARTIFACT.writerOffsets]);
  rmSync(out, { recursive: true });
});

test("leaves: public records with no seller text, sha256 of the body, a kept salt per line; refused and other days left out", () => {
  const { root: r, salts } = lanesDayRoot("arbitrum", DAY, LINES, AFTER, {}, mint);
  assert.equal(r.n, 3);
  const leaves = r.leaves;
  assert.ok(!JSON.stringify(leaves).includes("never published"), "no answer text in a leaf");
  assert.equal(leaves[0]!.bodyHash, `0x${sha256Hex('{"answer":"the seller text that is never published"}')}`);
  assert.deepEqual(leaves.slice(0, 2).map((l) => l.cause), ["delivered", "seller_config"]);
  assert.notEqual(leaves[2]!.cause, "seller_config", "a payment that did not settle is never the seller's fault");
  assert.equal(leaves[2]!.settlementTx, null);
  assert.equal(Object.keys(salts).length, 3);
  for (let i = 0; i < 3; i++) assert.ok(verifyInclusion(recordDigest(leaves[i]), r.proofs[i]!, r.root));
  // Kept salts give the same root; a new salt set gives another.
  assert.equal(lanesDayRoot("arbitrum", DAY, LINES, AFTER, salts, mint).root.root, r.root);
  assert.notEqual(lanesDayRoot("arbitrum", DAY, LINES, AFTER, {}, mint).root.root, r.root);
  assert.throws(() => lanesDayRoot("arbitrum", "2026-10-01", LINES, "2026-10-01T23:00:00Z", {}, mint), /not over/);
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: null }] }), '{"a":[2,{"c":null,"d":1}],"b":1}');
});

test("days: only closed UTC days with a sent purchase; a day is done once written and published", () => {
  assert.deepEqual(purchaseDays(LINES, "2026-10-01"), [DAY]);
  assert.deepEqual(purchaseDays(LINES, "2026-10-02"), [DAY, "2026-10-01"]);
  assert.deepEqual(purchaseDays([purchase({ at: `${DAY}T01:00:00Z`, host: "x.test", outcome: "refused" })], "2026-10-05"), [], "no purchase, no root");
  const days = ["2026-09-30", "2026-10-01", "2026-10-02"];
  const status = (d: string) => ({ "2026-09-30": "sent", "2026-10-01": "sent", "2026-10-02": "sending" })[d] ?? null;
  assert.deepEqual(openRootDays(days, status, new Set(["2026-09-30"])), ["2026-10-01", "2026-10-02"]);
});

function sentDay(notifiedFor: string[] = []): { sent: SentDay; leaves: PublicLeaf[]; notified: Set<string> } {
  const { root: r } = lanesDayRoot("arbitrum", DAY, LINES, AFTER, {}, mint);
  return { sent: { lane: "arbitrum", day: DAY, root: r.root, n: r.n, status: "sent", hash: TX("b"), block: "123", registry: ROOTS_REGISTRY, leaves: r.leaves }, leaves: r.leaves, notified: new Set(notifiedFor) };
}

test("published file: a delivered purchase with its record and proof; a negative one only as an index until its seller is told", () => {
  const { sent, notified } = sentDay();
  const f = buildRootsFile("arbitrum", [sent, { ...sent, day: "2026-09-29", status: "sending" }], TX("c"), notified);
  assert.equal(f.days.length, 1, "a day still sending is not published");
  const d = f.days[0]!;
  assert.equal(d.dayNumber, dayNumber(DAY));
  assert.equal(d.published, 1);
  assert.deepEqual(d.leaves.slice(1), [{ leafIndex: 1, withheld: true }, { leafIndex: 2, withheld: true }]);
  assert.ok(!JSON.stringify(f).includes("bad.test") && !JSON.stringify(f).includes("nopay.test"), "no withheld seller is named");
  assert.deepEqual(rootsFileProblems(f, "arbitrum", notified), []);
  // Told: published.
  const told = buildRootsFile("arbitrum", [sent], null, new Set(["bad.test"]));
  assert.equal(told.days[0]!.published, 2);
  // A told file read with an empty notified list is refused; so is a record changed after the fact.
  assert.match(rootsFileProblems(told, "arbitrum", new Set()).join(), /not in notified/);
  const tampered = structuredClone(f);
  (tampered.days[0]!.leaves[0] as { record: PublicLeaf }).record.delivered = false;
  assert.match(rootsFileProblems(tampered, "arbitrum", notified).join(), /does not prove/);
  assert.throws(() => buildRootsFile("arbitrum", [{ ...sent, leaves: sent.leaves.slice(1) }], null, notified), /do not make the root/);
  assert.throws(() => buildRootsFile("robinhood", [sent], null, notified), /lane arbitrum/);
  assert.ok(leafIsPublic(sent.leaves[0]!, new Set()) && !leafIsPublic(sent.leaves[1]!, new Set()));
});

test("secret gate: the published roots file passes; a salt anywhere else is still a finding", () => {
  const { sent, notified } = sentDay();
  // A real random salt, not the counting ones above.
  const leaves = sent.leaves.map((l) => ({ ...l, salt: `0x${sha256Hex(`salt-${l.at}`)}` }));
  const digests = leaves.map(recordDigest);
  const { root } = lanesDayRoot("arbitrum", DAY, LINES, AFTER, Object.fromEntries(LINES.slice(0, 3).map((l, i) => [sha256Hex(l), leaves[i]!.salt])));
  assert.deepEqual(root.digests, digests);
  const f = buildRootsFile("arbitrum", [{ ...sent, root: root.root, leaves }], TX("c"), notified);
  const text = JSON.stringify(f, null, 2) + "\n";
  assert.deepEqual(blockingFindings(scanFileText(text, "data/evm/roots/arbitrum.json"), []), []);
  const elsewhere = JSON.stringify({ salt: leaves[0]!.salt }, null, 2);
  assert.ok(blockingFindings(scanFileText(elsewhere, "data/x.json"), []).length > 0, "only the exact path is vouched for");
});

test("site: the daily-record section links the contract and each day's transaction; with no day written it says so", () => {
  const { sent, notified } = sentDay();
  const f = buildRootsFile("arbitrum", [sent], TX("c"), notified);
  const html = rootsSection("arbitrum", f);
  assert.ok(html.includes(`https://arbiscan.io/address/${ROOTS_REGISTRY}`));
  assert.ok(html.includes(`https://arbiscan.io/tx/${TX("b")}`));
  assert.ok(html.includes("data/evm/roots/arbitrum.json"));
  const none = rootsSection("robinhood", undefined);
  assert.match(none, /No day has been written on Robinhood Chain yet/);
  assert.ok(!none.includes("/address/") && !none.includes("/blob/main/data/evm/roots/"), "no contract or file link before a day is written");
  for (const h of [html, none]) {
    const text = h.replace(/<[^>]+>/g, " ");
    assert.ok(!/\b(we|us|our)\b/i.test(text) && !text.includes("—"), "English, no first person plural, no em dash");
  }
});

test("site: build-site refuses a roots file whose record does not prove into its root", () => {
  const dir = mkdtempSync(join(tmpdir(), "roots-site-"));
  mkdirSync(join(dir, "evm", "roots"), { recursive: true });
  mkdirSync(join(dir, "records"), { recursive: true });
  writeFileSync(join(dir, "records", "notified.json"), JSON.stringify({ sellers: [] }));
  writeFileSync(join(dir, "evm", "arbitrum.json"), readFileSync(join(ROOT, "data", "evm", "arbitrum.json")));
  const { sent, notified } = sentDay();
  const f = buildRootsFile("arbitrum", [sent], null, notified);
  writeFileSync(join(dir, "evm", "roots", "arbitrum.json"), JSON.stringify(f));
  assert.equal(loadLanePublic(dir).arbitrum?.roots?.days.length, 1);
  (f.days[0]!.leaves[0] as { record: PublicLeaf }).record.httpStatus = 404;
  writeFileSync(join(dir, "evm", "roots", "arbitrum.json"), JSON.stringify(f));
  assert.throws(() => loadLanePublic(dir), /does not prove/);
  rmSync(dir, { recursive: true });
});

test("scripts: keys only after every refusal; --send needs its own variable; the payer wallet never signs a root", () => {
  const deploy = readFileSync(join(ROOT, "scripts", "evm-roots-deploy.ts"), "utf8");
  assert.match(deploy, /if \(send && process\.env\.VET402_ROOTS_DEPLOY !== lane\) throw/);
  assert.equal(deploy.match(/loadRootsPoster\(\)/g)?.length, 1);
  for (const before of ["if (!send) process.exit(0)", "if (nonce !== 0) throw", "anchorFees(", "if (existsSync(out)) throw"]) assert.ok(deploy.indexOf(before) < deploy.indexOf("loadRootsPoster()"), before);
  assert.match(deploy, /sendTransaction\(\{[^}]*nonce: 0, gas: limits\.gas/);
  const anchor = readFileSync(join(ROOT, "scripts", "evm-anchor.ts"), "utf8");
  for (const before of ["if (!send)", "if (state !== \"open\") throw", "the input or the rules changed", "anchorFees("]) assert.ok(anchor.indexOf(before) < anchor.indexOf("loadRootsPoster()"), before);
  assert.ok(!/loadEvmAccount|PAYER|evm\.json/.test(anchor + deploy));
});

// ---------- the contract on a local chain ----------

async function anvil(t: { skip: (m: string) => void }): Promise<{ url: string; proc: ChildProcess } | null> {
  if (spawnSync("anvil", ["--version"]).status !== 0) {
    t.skip("anvil is not installed");
    return null;
  }
  const port = 20000 + Math.floor(Math.random() * 20000);
  const proc = spawn("anvil", ["--port", String(port), "--silent", "--chain-id", "42161"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) return { url, proc };
    } catch {}
    await new Promise((res) => setTimeout(res, 100));
  }
  proc.kill();
  throw new Error("anvil did not start");
}

const recordAbi = parseAbi(["function record(uint32 day, bytes32 root, uint32 n)"]);

test("local chain: deploy, write a day once, refuse a second write, a stranger and an empty root; verify() proves each published record", async (t) => {
  const a = await anvil(t);
  if (!a) return;
  try {
    const client = createPublicClient({ transport: http(a.url) }) as PublicClient;
    const [writer, stranger] = (await client.request({ method: "eth_accounts" } as never)) as Address[];
    const w = createWalletClient({ account: writer!, transport: http(a.url) });
    const s = createWalletClient({ account: stranger!, transport: http(a.url) });
    // Before deployment: record() is quoted with the code put at the address (what evm-anchor --sample does).
    const nonce0 = expectedRegistry(getAddress(writer!));
    const { root: r } = lanesDayRoot("arbitrum", DAY, LINES, AFTER, {}, mint);
    const tx = buildAnchorTx(r, getAddress(writer!), nonce0);
    const quoted = await client.estimateGas({ account: writer!, to: nonce0, data: tx.data, stateOverride: [{ address: nonce0, code: runtimeWithWriter(getAddress(writer!)) }] });
    assert.ok(quoted > 50_000n && quoted < 150_000n, `record() quote ${quoted}`);

    const hash = await w.sendTransaction({ chain: null, data: deployData(getAddress(writer!)) });
    const rc = await client.waitForTransactionReceipt({ hash });
    assert.equal(getAddress(rc.contractAddress!), nonce0, "lands at the writer's nonce-0 address");
    assert.equal(registryCodeProblem(await client.getCode({ address: nonce0 }), getAddress(writer!)), null);
    assert.match(registryCodeProblem(await client.getCode({ address: nonce0 }), ROOTS_POSTER_ADDRESS) ?? "", /not DeliveryRoots with this writer/);
    assert.equal(await client.readContract({ address: nonce0, abi: deliveryRootsReadAbi, functionName: "writer" }), getAddress(writer!));

    const h1 = await w.sendTransaction({ chain: null, to: tx.to, data: tx.data });
    const rc1 = await client.waitForTransactionReceipt({ hash: h1 });
    assert.equal(rc1.status, "success");
    assert.ok(rc1.gasUsed <= quoted, `used ${rc1.gasUsed} <= quoted ${quoted}`);
    assert.equal(await client.readContract({ address: nonce0, abi: deliveryRootsReadAbi, functionName: "rootOf", args: [dayNumber(DAY)] }), r.root);
    assert.equal(await client.readContract({ address: nonce0, abi: deliveryRootsReadAbi, functionName: "countOf", args: [dayNumber(DAY)] }), r.n);
    const logs = await client.getContractEvents({ address: nonce0, abi: deliveryRootsReadAbi, eventName: "RootRecorded", args: { day: dayNumber(DAY) }, fromBlock: 0n, strict: true });
    assert.equal(logs[0]?.transactionHash, h1, "the RootRecorded log names the transaction (how --send completes a 'sending' day)");

    // Every record in the published file verifies on chain, in one call each.
    const f = buildRootsFile("arbitrum", [{ lane: "arbitrum", day: DAY, root: r.root, n: r.n, status: "sent", hash: h1, block: "1", registry: ROOTS_REGISTRY, leaves: r.leaves }], null, new Set(["bad.test", "nopay.test"]));
    for (const l of f.days[0]!.leaves) {
      assert.ok("record" in l);
      const digest = keccak256(stringToBytes(canonicalJson(l.record)));
      assert.equal(await client.readContract({ address: nonce0, abi: deliveryRootsReadAbi, functionName: "verify", args: [dayNumber(DAY), digest, l.proof] }), true);
      assert.equal(await client.readContract({ address: nonce0, abi: deliveryRootsReadAbi, functionName: "verify", args: [dayNumber(DAY) + 1, digest, l.proof] }), false, "not on another day");
    }

    const reverts = async (p: Promise<unknown>, re: RegExp) => assert.match(String(await p.then(() => "no revert", (e: Error) => e.message)), re);
    await reverts(client.simulateContract({ account: writer!, address: nonce0, abi: recordAbi, functionName: "record", args: [dayNumber(DAY), r.root, r.n] }), /AlreadyRecorded|revert/);
    await reverts(client.simulateContract({ account: writer!, address: nonce0, abi: recordAbi, functionName: "record", args: [dayNumber(DAY), TX("d"), 1] }), /AlreadyRecorded|revert/);
    await reverts(client.simulateContract({ account: stranger!, address: nonce0, abi: recordAbi, functionName: "record", args: [dayNumber(DAY) + 1, r.root, r.n] }), /NotWriter|revert/);
    await reverts(client.simulateContract({ account: writer!, address: nonce0, abi: recordAbi, functionName: "record", args: [dayNumber(DAY) + 1, `0x${"0".repeat(64)}`, 1] }), /EmptyRoot|revert/);
    // A sent transaction from a stranger fails on chain and changes nothing.
    const hs = await s.sendTransaction({ chain: null, to: nonce0, data: encodeFunctionData({ abi: recordAbi, functionName: "record", args: [dayNumber(DAY) + 1, r.root, r.n] }), gas: 100_000n });
    assert.equal((await client.waitForTransactionReceipt({ hash: hs })).status, "reverted");
    assert.equal(await client.readContract({ address: nonce0, abi: deliveryRootsReadAbi, functionName: "rootOf", args: [dayNumber(DAY) + 1] }), `0x${"0".repeat(64)}`);
  } finally {
    a.proc.kill();
  }
});

test("local chain: the deploy script's simulation on a chain-id-42161 node leaves exactly the artifact's runtime; evm-anchor quotes record() before deployment", async (t) => {
  const a = await anvil(t);
  if (!a) return;
  try {
    const env = { ...process.env, ARBITRUM_RPC_URL: a.url };
    const tsx = join(ROOT, "node_modules", ".bin", "tsx");
    const d = spawnSync(tsx, ["scripts/evm-roots-deploy.ts", "--chain", "arbitrum"], { cwd: ROOT, env, encoding: "utf8" });
    assert.equal(d.status, 0, d.stderr);
    const plan = JSON.parse(d.stdout);
    assert.equal(plan.runtimeMatchesArtifact, true);
    assert.equal(plan.nonce, 0);
    assert.equal(plan.registry, ROOTS_REGISTRY);
    const q = spawnSync(tsx, ["scripts/evm-anchor.ts", "--lane", "arbitrum", "--sample", "70"], { cwd: ROOT, env, encoding: "utf8" });
    assert.equal(q.status, 0, q.stderr);
    const quote = JSON.parse(q.stdout);
    assert.equal(quote.state, "not_deployed");
    assert.ok(Number(quote.quote.gas) > 50_000, q.stdout);
    // --send without its variable is refused before anything else.
    const refused = spawnSync(tsx, ["scripts/evm-roots-deploy.ts", "--chain", "arbitrum", "--send"], { cwd: ROOT, env, encoding: "utf8" });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /VET402_ROOTS_DEPLOY=arbitrum/);
  } finally {
    a.proc.kill();
  }
});
