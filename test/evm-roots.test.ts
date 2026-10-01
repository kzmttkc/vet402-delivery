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
  laneReadings,
  leafIsPublic,
  leafKey,
  verdictsOf,
  LEAF_RULE,
  type Verdict,
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
import { loadLanePublic, type LaneRow } from "../src/evm/site.js";
import { blockingFindings, scanFileText } from "../src/daily/secret-gate.js";
import { verifyInclusion } from "../src/receipt/merkle.js";

const ROOT = new URL("..", import.meta.url).pathname;
const PAYER = getAddress("0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51");
const SELLER = getAddress("0xeF2a4B6756895aAf1374640dcFCD4947959442ab");
const TX = (b: string) => (`0x${b.repeat(64)}`.slice(0, 66)) as Hex;

/** A purchase line as scripts/evm-lane.ts writes it (results/evm/<lane>-purchases.jsonl). */
const purchase = (o: { at: string; host: string; delivered?: boolean; settled?: boolean; outcome?: string; body?: string; tx?: Hex | null; check?: "no_transfer" | "transfer_found" | "pending" | null }) =>
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
    ...((o.check === undefined ? ((o.settled ?? true) ? "transfer_found" : null) : o.check) ? { chainCheck: { checkedAt: "2026-10-01T12:00:00.000Z", result: o.check ?? "transfer_found", by: (o.check ?? "transfer_found") === "transfer_found" ? "nonce" : null, tx: (o.check ?? "transfer_found") === "transfer_found" ? TX("e") : null, windowFrom: o.at, windowTo: o.at } } : {}),
  });

const DAY = "2026-09-30";
const LINES = [
  purchase({ at: `${DAY}T01:00:00.000Z`, host: "good.test", body: '{"answer":"the seller text that is never published"}' }),
  purchase({ at: `${DAY}T02:00:00.000Z`, host: "bad.test", delivered: false, settled: true, body: "Internal Server Error" }),
  purchase({ at: `${DAY}T03:00:00.000Z`, host: "nopay.test", delivered: false, settled: false, tx: null, check: "no_transfer" }),
  purchase({ at: `${DAY}T04:00:00.000Z`, host: "refused.test", outcome: "refused" }),
  purchase({ at: "2026-10-01T00:00:01.000Z", host: "good.test" }),
];
const AFTER = "2026-10-01T00:10:00.000Z";
const V = verdictsOf("arbitrum", laneReadings("arbitrum", LINES));
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

const FACT_KEYS = ["agentId", "amountAtomic", "asset", "at", "bodyHash", "chain", "chainCheck", "httpStatus", "kind", "lane", "method", "payTo", "payer", "resource", "responseBytes", "salt", "settlementTx", "version"];

test("leaves hold facts only: no verdict, no seller text, the chain's settlement, sha256 of the body, a kept salt per purchase", () => {
  const { root: r, salts } = lanesDayRoot("arbitrum", DAY, LINES, AFTER, {}, mint);
  assert.equal(r.n, 3);
  const leaves = r.leaves;
  for (const l of leaves) assert.deepEqual(Object.keys(l).sort(), FACT_KEYS, "facts only: no status, cause, rule, delivered or settledOnChain");
  assert.ok(!JSON.stringify(leaves).includes("never published"), "no answer text in a leaf");
  assert.equal(leaves[0]!.bodyHash, `0x${sha256Hex('{"answer":"the seller text that is never published"}')}`);
  assert.deepEqual(leaves.map((l) => [l.chainCheck, l.settlementTx]), [["transfer_found", TX("e")], ["transfer_found", TX("e")], ["no_transfer", null]], "the tx the chain check tied, not the one the seller named");
  // Today's verdicts are separate from the leaves.
  assert.deepEqual(leaves.map((l) => V.get(leafKey(l))?.status), ["delivered", "settled_no_answer", "not_settled"]);
  assert.equal(Object.keys(salts).length, 3);
  for (let i = 0; i < 3; i++) assert.ok(verifyInclusion(recordDigest(leaves[i]), r.proofs[i]!, r.root));
  // Kept salts give the same root; a new salt set gives another.
  assert.equal(lanesDayRoot("arbitrum", DAY, LINES, AFTER, salts, mint).root.root, r.root);
  assert.notEqual(lanesDayRoot("arbitrum", DAY, LINES, AFTER, {}, mint).root.root, r.root);
  assert.throws(() => lanesDayRoot("arbitrum", "2026-10-01", LINES, "2026-10-01T23:00:00Z", {}, mint), /not over/);
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: null }] }), '{"a":[2,{"c":null,"d":1}],"b":1}');
  // The escaping a third party must match: JSON.stringify's (non-ASCII and / as they are).
  assert.equal(canonicalJson({ s: 'é/"\\\n\u0001' }), '{"s":"é/\\"\\\\\\n\\u0001"}');
  assert.match(LEAF_RULE, /non-ASCII characters and \/ are not escaped/);
});

test("the chain check: every sent purchase needs one (also one settled on its receipt); the merged reading is the material; a re-check keeps the leaf", () => {
  // Settled on the receipt at purchase time, but not read by the chain check: refused all the same.
  const receiptOnly = purchase({ at: `${DAY}T05:00:00.000Z`, host: "late.test", settled: true, check: null });
  assert.throws(() => lanesDayRoot("arbitrum", DAY, laneReadings("arbitrum", [receiptOnly]), AFTER, {}, mint), /without a chain check; run npx tsx scripts\/evm-chaincheck\.ts/);
  assert.throws(() => lanesDayRoot("arbitrum", DAY, laneReadings("arbitrum", [purchase({ at: `${DAY}T05:00:00.000Z`, host: "p.test", delivered: false, settled: false, check: "pending" })]), AFTER, {}, mint), /without a chain check/);
  // The chain check found the settlement the seller's header did not name: the later reading replaces the first.
  const first = purchase({ at: `${DAY}T05:00:00.000Z`, host: "late.test", delivered: true, settled: false, tx: null, check: null });
  const checked = JSON.stringify({ ...JSON.parse(first), settledOnChain: true, settlementTx: TX("e"), chainCheck: { checkedAt: "2026-10-01T12:00:00.000Z", result: "transfer_found", by: "nonce", tx: TX("e"), windowFrom: "a", windowTo: "b" } });
  const lines = laneReadings("arbitrum", [first, "", checked]);
  assert.equal(lines.length, 1, "one record per purchase");
  const { root: r, salts } = lanesDayRoot("arbitrum", DAY, lines, AFTER, {}, mint);
  assert.equal(r.leaves[0]!.chainCheck, "transfer_found");
  assert.equal(r.leaves[0]!.settlementTx, TX("e"));
  assert.ok(!JSON.stringify(r.leaves).includes("checkedAt"), "a re-check alone does not change a leaf");
  const again = lanesDayRoot("arbitrum", DAY, laneReadings("arbitrum", [first, JSON.stringify({ ...JSON.parse(checked), chainCheck: { ...JSON.parse(checked).chainCheck, checkedAt: "2026-10-02T00:00:00.000Z" } })]), AFTER, salts, mint);
  assert.equal(again.root.root, r.root);
});

test("today's verdict decides what is shown: free and vet402's own input are shown, a negative one is not; no reading, no record", () => {
  const leaf = sentDay().leaves[0]!;
  const v = (status: Verdict["status"], cause: Verdict["cause"], rule: string): Verdict => ({ status, cause, rule });
  assert.ok(leafIsPublic(leaf, v("free_delivered", "seller_free", "seller_said_free:first_call_free"), new Set()));
  assert.ok(leafIsPublic(leaf, v("settled_vet402_input", "vet402", "input:path_slot:settled"), new Set()));
  assert.ok(!leafIsPublic(leaf, v("settled_no_answer", "seller_config", "settled_then_500"), new Set()));
  assert.ok(!leafIsPublic(leaf, v("not_settled", "not_settled", "x"), new Set()));
  assert.ok(!leafIsPublic(leaf, null, new Set()), "not judged today: not shown");
  assert.ok(leafIsPublic(leaf, v("settled_no_answer", "seller_config", "settled_then_500"), new Set(["good.test"])), "told");
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

test("published file: a purchase judged fine today with its record, proof and verdict; a negative one only as an index until its seller is told", () => {
  const { sent, notified } = sentDay();
  const f = buildRootsFile("arbitrum", [sent, { ...sent, day: "2026-09-29", status: "sending" }], TX("c"), notified, V);
  assert.equal(f.days.length, 1, "a day still sending is not published");
  const d = f.days[0]!;
  assert.equal(d.dayNumber, dayNumber(DAY));
  assert.equal(d.published, 1);
  assert.deepEqual((d.leaves[0] as { verdict: Verdict }).verdict, { status: "delivered", cause: "delivered", rule: "delivered" });
  assert.deepEqual(d.leaves.slice(1), [{ leafIndex: 1, withheld: true }, { leafIndex: 2, withheld: true }]);
  assert.ok(!JSON.stringify(f).includes("bad.test") && !JSON.stringify(f).includes("nopay.test"), "no withheld seller is named");
  assert.deepEqual(rootsFileProblems(f, "arbitrum", notified, { verdicts: V }), []);
  // Told: published.
  const told = buildRootsFile("arbitrum", [sent], null, new Set(["bad.test"]), V);
  assert.equal(told.days[0]!.published, 2);
  assert.match(rootsFileProblems(told, "arbitrum", new Set(), {}).join(), /not in notified/);
  const tampered = structuredClone(f);
  (tampered.days[0]!.leaves[0] as { record: PublicLeaf }).record.httpStatus = 500;
  assert.match(rootsFileProblems(tampered, "arbitrum", notified, {}).join(), /does not prove/);
  assert.throws(() => buildRootsFile("arbitrum", [{ ...sent, leaves: sent.leaves.slice(1) }], null, notified, V), /do not make the root/);
  assert.throws(() => buildRootsFile("robinhood", [sent], null, notified, V), /lane arbitrum/);
});

test("a rule change: the root and the leaves stay, today's verdict withholds what it now holds against the seller, and a stale file is refused", () => {
  const { sent, notified } = sentDay();
  const before = buildRootsFile("arbitrum", [sent], null, notified, V);
  // Today's rules call the delivered purchase a seller failure.
  const key = leafKey(sent.leaves[0]!);
  const today = new Map(V);
  today.set(key, { status: "settled_no_answer", cause: "seller_config", rule: "a_new_rule" });
  const problems = rootsFileProblems(before, "arbitrum", notified, { verdicts: today }).join();
  assert.match(problems, /the verdict is not today's/);
  assert.match(problems, /today's rules withhold it/);
  const after = buildRootsFile("arbitrum", [sent], null, notified, today);
  assert.equal(after.days[0]!.root, before.days[0]!.root, "the root on chain still holds: leaves are facts");
  assert.equal(after.days[0]!.published, 0);
  assert.deepEqual(rootsFileProblems(after, "arbitrum", notified, { verdicts: today }), []);
  // At site build, today's judgment is the lane page's rows: a purchase withheld there makes the roots file stale.
  const leaf = sent.leaves[0]!;
  const row = { payTo: leaf.payTo!, hosts: ["good.test"], catalogListings: 1, resource: leaf.resource, livePrice: "1000", status: "withheld", cause: null, settlementTx: null, paidRequestMs: null, relayer: null, facilitatorLead: null, skipped: null } as LaneRow;
  assert.match(rootsFileProblems(before, "arbitrum", notified, { rows: [row] }).join(), /stale roots file/);
  assert.deepEqual(rootsFileProblems(before, "arbitrum", notified, { rows: [{ ...row, status: "delivered" }] }), []);
  assert.deepEqual(rootsFileProblems(before, "arbitrum", notified, { rows: [{ ...row, purchases: 2 }] }), [], "a row of several purchases does not stand for this one");
});

test("secret gate: the published roots file passes; a salt anywhere else is still a finding", () => {
  const { sent, notified } = sentDay();
  // Random-looking salts, not the counting ones above.
  let k = 0;
  const { root } = lanesDayRoot("arbitrum", DAY, LINES, AFTER, {}, () => `0x${sha256Hex(`salt-${++k}`)}`);
  const f = buildRootsFile("arbitrum", [{ ...sent, root: root.root, leaves: root.leaves }], TX("c"), notified, verdictsOf("arbitrum", laneReadings("arbitrum", LINES)));
  const leaves = root.leaves;
  const text = JSON.stringify(f, null, 2) + "\n";
  assert.deepEqual(blockingFindings(scanFileText(text, "data/evm/roots/arbitrum.json"), []), []);
  const elsewhere = JSON.stringify({ salt: leaves[0]!.salt }, null, 2);
  assert.ok(blockingFindings(scanFileText(elsewhere, "data/x.json"), []).length > 0, "only the exact path is vouched for");
});

test("site: the daily-record section links the contract and each day's transaction; with no day written it says so", () => {
  const { sent, notified } = sentDay();
  const f = buildRootsFile("arbitrum", [sent], TX("c"), notified, V);
  const html = rootsSection("arbitrum", f);
  assert.match(html, /The root holds facts, not verdicts/);
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
  const f = buildRootsFile("arbitrum", [sent], null, notified, V);
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

const recordAbi = parseAbi(["function record(uint32 day, bytes32 root, uint32 n)", "error NotWriter()", "error EmptyRoot()", "error AlreadyRecorded(uint32 day)"]);

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
    const f = buildRootsFile("arbitrum", [{ lane: "arbitrum", day: DAY, root: r.root, n: r.n, status: "sent", hash: h1, block: "1", registry: ROOTS_REGISTRY, leaves: r.leaves }], null, new Set(["bad.test", "nopay.test"]), V);
    for (const l of f.days[0]!.leaves) {
      assert.ok("record" in l);
      const digest = keccak256(stringToBytes(canonicalJson(l.record)));
      assert.equal(await client.readContract({ address: nonce0, abi: deliveryRootsReadAbi, functionName: "verify", args: [dayNumber(DAY), digest, l.proof] }), true);
      assert.equal(await client.readContract({ address: nonce0, abi: deliveryRootsReadAbi, functionName: "verify", args: [dayNumber(DAY) + 1, digest, l.proof] }), false, "not on another day");
    }

    const reverts = async (p: Promise<unknown>, re: RegExp) => assert.match(String(await p.then(() => "no revert", (e: Error) => e.message)), re);
    await reverts(client.simulateContract({ account: writer!, address: nonce0, abi: recordAbi, functionName: "record", args: [dayNumber(DAY), r.root, r.n] }), /AlreadyRecorded/);
    await reverts(client.simulateContract({ account: writer!, address: nonce0, abi: recordAbi, functionName: "record", args: [dayNumber(DAY), TX("d"), 1] }), /AlreadyRecorded/);
    await reverts(client.simulateContract({ account: stranger!, address: nonce0, abi: recordAbi, functionName: "record", args: [dayNumber(DAY) + 1, r.root, r.n] }), /NotWriter/);
    await reverts(client.simulateContract({ account: writer!, address: nonce0, abi: recordAbi, functionName: "record", args: [dayNumber(DAY) + 1, `0x${"0".repeat(64)}`, 1] }), /EmptyRoot/);
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
