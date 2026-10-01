/**
 * Tempo, three additions (no network, no real key):
 *  - the day's root also written as a TIP-20 memo, through the same gates as the Solana anchor
 *  - the check before paying, at mppx's preparePayment (before any signature)
 *  - the purchase key as an AccountKeychain access key (on-chain limit and expiry)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, custom, decodeFunctionData, encodeFunctionData, keccak256, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { tempo as tempoChain } from "viem/chains";
import { Abis, Account, Transaction } from "viem/tempo";
import { Mppx, tempo as mppxTempo } from "mppx/client";
import type { Rpc } from "../src/chain.js";
import { assemble, type Facts } from "../src/receipt/build.js";
import { observationDigest, signObservation } from "../src/receipt/eip712.js";
import { buildTree } from "../src/receipt/merkle.js";
import { tempoAnchorOfDay } from "../src/receipt/publish.js";
import { validateAgainst } from "../src/receipt/schema.js";
import { plan, resume, send, type TempoAnchorDeps, type TempoAnchorSigner } from "../src/receipt/anchor-tempo-run.js";
import {
  anchorCall,
  anchorTxProblem,
  checkTempoDayAnchor,
  MAX_TEMPO_ANCHOR_FEE_ATOMIC,
  readTempoAnchorTx,
  TEMPO_ANCHOR_NETWORK,
  TRANSFER_WITH_MEMO_TOPIC,
  tempoAnchorFromIndex,
  tempoDayAnchorShape,
} from "../src/receipt/tempo-anchor.js";
import { VET402_TEMPO_ANCHOR_RECIPIENT, VET402_TEMPO_ANCHOR_SENDERS } from "../src/receipt/observers.js";
import type { Observation } from "../src/receipt/types.js";
import { verifyOffline } from "../src/receipt/verify.js";
import {
  ACCESS_KEY_EXPIRY,
  ACCESS_KEY_FILE_KIND,
  ACCOUNT_KEYCHAIN,
  accessKeyConfig,
  accessKeyIdOf,
  accessSigner,
  authorizeKeyData,
  authorizeTxProblem,
  keychainProblem,
  keyProblem,
  signerPlan,
  TEMPO_ACCESS_KEY_ID,
  TEMPO_ACCESS_KEYS,
  isListedAccessKey,
  type KeyState,
} from "../src/tempo/access-key.js";
import { loadSigner } from "../src/tempo/chain.js";
import { PAYER_ADDRESS, USDC_E } from "../src/tempo/constants.js";
import { checkSignedTransfer } from "../src/tempo/txcheck.js";
import { offerOf, preparePaymentWithCheck, type CheckResultLike, type PaymentCheckEvent } from "../src/tempo/prepare-check.js";

const DAY = "2026-09-29";
const AFTER_DAY = Date.parse("2026-09-30T00:10:00Z") / 1000;
const observer = privateKeyToAccount(generatePrivateKey());
const anchorKey = privateKeyToAccount(generatePrivateKey());
const SENDERS = [anchorKey.address];
const RECIPIENT = observer.address;
const topicAddr = (a: string) => `0x${a.toLowerCase().slice(2).padStart(64, "0")}`;

function facts(i: number): Facts {
  return {
    dataset: "test",
    row: `rows[${i}]`,
    observedAt: `${DAY}T07:14:5${i}.000Z`,
    requestUrl: `https://s${i}.example/x`,
    method: "GET",
    requestTs: null,
    payment: {
      network: "eip155:4217",
      scheme: "mpp-charge",
      transaction: `0x${String(i).repeat(64)}`,
      payer: PAYER_ADDRESS,
      payTo: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0",
      asset: USDC_E,
      amount: "1000",
      decimals: 6,
      assetSymbol: "USDC.e",
    },
    paymentSettled: true,
    httpStatus: 200,
    contentType: "application/json",
    bytes: 10,
    bodyNonEmpty: true,
    receivedAt: `${DAY}T07:14:5${i}.000Z`,
    declaredFormatMatched: null,
    notRecorded: [],
  };
}

/** One day of three signed, rooted records, already anchored on Solana. */
async function dayFolder(): Promise<{ dir: string; dayDir: string; root: string }> {
  const dir = mkdtempSync(join(tmpdir(), "vet402-tempo-anchor-"));
  const dayDir = join(dir, DAY);
  mkdirSync(dayDir);
  const obs: Observation[] = [];
  for (let i = 1; i <= 3; i++) obs.push(await signObservation(assemble(facts(i), i, { id: "did:web:vet402.com#t", address: observer.address }, `0x${"11".repeat(32)}`, 1790000000), observer));
  const tree = buildTree(obs.map((o) => observationDigest(o)));
  for (const [i, o] of obs.entries()) {
    const r = {
      ...o,
      anchor: { status: "anchored" as const, day: DAY, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", tx: "5olana", root: tree.root, leafIndex: i, proof: tree.proofs[i]!, count: 3, sequenceRange: [1, 3] as [number, number], observerAddress: observer.address, anchoredAt: "2026-09-30T00:06:00.000Z" },
    };
    writeFileSync(join(dayDir, `${o.id}.json`), `${JSON.stringify(r, null, 2)}\n`);
  }
  return { dir, dayDir, root: tree.root.toLowerCase() };
}

interface FakeReceipt {
  status: string;
  from: string;
  blockNumber: string;
  logs: { address: string; topics: string[]; data: string; transactionHash: string; blockNumber: string }[];
}

/** A Tempo mainnet that holds what was sent to it. */
function fakeTempo(o: { balance?: bigint; gas?: bigint; drop?: number; blockTime?: number } = {}) {
  const receipts = new Map<string, FakeReceipt>();
  const sent: string[] = [];
  let nonce = 0;
  let drop = o.drop ?? 0;
  const calls: string[] = [];
  const land = (raw: string, from: string, memoRoot: string, to = RECIPIENT, status = "0x1") => {
    const hash = keccak256(raw as Hex).toLowerCase();
    receipts.set(hash, {
      status,
      from,
      blockNumber: "0x2800000",
      logs: [{ address: USDC_E, topics: [TRANSFER_WITH_MEMO_TOPIC, topicAddr(from), topicAddr(to), memoRoot], data: "0x1", transactionHash: hash, blockNumber: "0x2800000" }],
    });
    nonce++;
    return hash;
  };
  const rpc: Rpc = async (method, params) => {
    calls.push(method);
    switch (method) {
      case "eth_chainId":
        return "0x1079";
      case "eth_blockNumber":
        return "0x2800010";
      case "eth_getTransactionCount":
        return `0x${nonce.toString(16)}`;
      case "eth_call": {
        const p = params[0] as { data: string; from?: string };
        if (p.data.startsWith("0x70a08231")) return `0x${(o.balance ?? 50_000n).toString(16)}`;
        if ((o.balance ?? 50_000n) === 0n) throw new Error("rpc eth_call: execution reverted: InsufficientBalance");
        return "0x";
      }
      case "eth_estimateGas":
        return `0x${(o.gas ?? 540_000n).toString(16)}`;
      case "eth_sendRawTransaction": {
        const raw = params[0] as string;
        sent.push(raw);
        if (drop > 0) {
          drop--;
          return keccak256(raw as Hex);
        }
        const tx = Transaction.deserialize(raw as `0x76${string}`) as unknown as { from: string; calls: { data: Hex }[] };
        const d = decodeFunctionData({ abi: Abis.tip20, data: tx.calls[0]!.data });
        return land(raw, tx.from, String(d.args![2]).toLowerCase());
      }
      case "eth_getTransactionReceipt":
        return receipts.get(String(params[0]).toLowerCase()) ?? null;
      case "eth_getBlockByNumber":
        return { timestamp: `0x${(o.blockTime ?? AFTER_DAY).toString(16)}` };
      case "eth_getLogs": {
        const f = params[0] as { topics: string[] };
        return [...receipts.values()].flatMap((r) => r.logs).filter((l) => f.topics.every((t, i) => !t || l.topics[i]?.toLowerCase() === t.toLowerCase()));
      }
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  return { rpc, sent, calls, receipts, land, setNonce: (n: number) => (nonce = n) };
}

let signs = 0;
const signer: TempoAnchorSigner = {
  address: anchorKey.address,
  signTransaction: (tx) => {
    signs++;
    return anchorKey.signTransaction(tx as never, { serializer: Transaction.serialize as never });
  },
};
const deps = (chain: ReturnType<typeof fakeTempo>, dayDir: string, over: Partial<TempoAnchorDeps> = {}): TempoAnchorDeps => ({
  rpc: chain.rpc,
  dayDir,
  day: DAY,
  sender: anchorKey.address,
  senders: SENDERS,
  recipient: RECIPIENT,
  loadSigner: async () => signer,
  sleep: async () => undefined,
  pollTries: 2,
  pollMs: 0,
  ...over,
});
const readObs = (dayDir: string) =>
  ["000001", "000002", "000003"].map((s) => JSON.parse(readFileSync(join(dayDir, `obs_${DAY}_${s}.json`), "utf8")) as Observation);

// ---------- the Tempo anchor ----------

test("tempo anchor: the observer address is the recipient and the anchor key is not the payer", () => {
  assert.equal(VET402_TEMPO_ANCHOR_RECIPIENT, "0x6232335B5264f7aa62a51f8ACc4676D22511Ff3C");
  assert.ok(VET402_TEMPO_ANCHOR_SENDERS.every((s) => s.toLowerCase() !== PAYER_ADDRESS.toLowerCase()));
  const c = anchorCall(`0x${"ab".repeat(32)}`);
  const d = decodeFunctionData({ abi: Abis.tip20, data: c.data });
  assert.equal(c.to, USDC_E);
  assert.equal(d.functionName, "transferWithMemo");
  assert.deepEqual([String(d.args![0]).toLowerCase(), d.args![1], d.args![2]], [VET402_TEMPO_ANCHOR_RECIPIENT.toLowerCase(), 1n, `0x${"ab".repeat(32)}`]);
});

test("tempo anchor plan: recomputes the root from the records, simulates, bounds the fee, signs nothing", async () => {
  const { dir, dayDir, root } = await dayFolder();
  const chain = fakeTempo();
  const before = signs;
  const p = await plan(deps(chain, dayDir, { loadSigner: async () => assert.fail("plan must not load the key") }));
  assert.equal(p.plan.root, root);
  assert.equal(p.plan.count, 3);
  assert.equal(p.plan.simulation.ok, true);
  assert.equal(p.plan.feeBoundAtomic, "8100"); // 675,000 gas x 12e9 / 1e12
  assert.equal(signs, before);
  assert.ok(!chain.calls.includes("eth_sendRawTransaction"));
  rmSync(dir, { recursive: true });
});

test("tempo anchor plan: an unfunded anchor key does not simulate; --simulate-from is refused by send", async () => {
  const { dir, dayDir } = await dayFolder();
  const p = await plan(deps(fakeTempo({ balance: 0n }), dayDir));
  assert.equal(p.plan.simulation.ok, false);
  await assert.rejects(send(deps(fakeTempo({ balance: 0n }), dayDir)), /simulation failed/);
  await assert.rejects(send(deps(fakeTempo(), dayDir, { simulateFrom: PAYER_ADDRESS })), /plan only/);
  assert.ok(!existsSync(join(dayDir, "anchor-tempo-sent.json")));
  rmSync(dir, { recursive: true });
});

const OLD_SCHEMA = JSON.parse(readFileSync(new URL("./fixtures/observation.schema.v0-before-tempo.json", import.meta.url), "utf8")) as Record<string, unknown>;
const recordBytes = (dayDir: string) => readdirSync(dayDir).filter((f) => f.startsWith("obs_")).sort().map((f) => [f, createHash("sha256").update(readFileSync(join(dayDir, f))).digest("hex")]);

test("tempo anchor send: one transferWithMemo; the records are not touched (same bytes, same sha256, old schema passes); the sent file holds tx, memo, block", async () => {
  const { dir, dayDir, root } = await dayFolder();
  const before = recordBytes(dayDir);
  const chain = fakeTempo();
  const r = await send(deps(chain, dayDir));
  assert.equal(chain.sent.length, 1);
  assert.equal(anchorTxProblem(chain.sent[0]!, { sender: anchorKey.address, root, recipient: RECIPIENT }), null);
  assert.deepEqual(recordBytes(dayDir), before, "no record rewritten");
  const sentFile = JSON.parse(readFileSync(join(dayDir, "anchor-tempo-sent.json"), "utf8")) as { status: string; tx: string; memo: string; block: number };
  assert.deepEqual([sentFile.status, sentFile.tx, sentFile.memo, sentFile.block], ["sent", r.tx, root, 0x2800000]);
  assert.deepEqual(tempoAnchorOfDay(dayDir, root), { tx: r.tx, memo: root, block: 0x2800000 });
  for (const o of readObs(dayDir)) {
    assert.deepEqual(validateAgainst(OLD_SCHEMA, o), [], "the schema before the Tempo anchor accepts the record");
    assert.ok(!("alsoAnchored" in o.anchor!));
    const off = await verifyOffline(o, { expectedSigner: observer.address });
    assert.ok(off.schema.ok && off.signature.ok && off.merkle.ok, JSON.stringify(off));
  }
  assert.equal((await checkTempoDayAnchor({ tx: r.tx, memo: root, block: 0x2800000 }, { day: DAY, root }, chain.rpc, SENDERS, RECIPIENT)).ok, true);
  // Twice: refused before anything is signed.
  const n = signs;
  await assert.rejects(send(deps(chain, dayDir)), /exists/);
  assert.equal(signs, n);
  rmSync(dir, { recursive: true });
});

test("tempo anchor: the schema is the v0 published before the Tempo anchor, byte for byte", () => {
  const now = readFileSync(new URL("../src/receipt/observation.schema.json", import.meta.url));
  const old = readFileSync(new URL("./fixtures/observation.schema.v0-before-tempo.json", import.meta.url));
  assert.equal(createHash("sha256").update(now).digest("hex"), createHash("sha256").update(old).digest("hex"));
  assert.equal(createHash("sha256").update(old).digest("hex"), "1f3973c4d1190ca56fd24c22b91f82cb36bc5e9baab9c761eb831f2b6bad846e");
});

test("tempo anchor send: refused when a Tempo memo already holds the root (no local file); --resume records it", async () => {
  const { dir, dayDir, root } = await dayFolder();
  const chain = fakeTempo();
  const other = await anchorKey.signTransaction({ type: "tempo", chainId: 4217, calls: [anchorCall(root, RECIPIENT)], nonce: 0, gas: 600_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, feeToken: USDC_E } as never, { serializer: Transaction.serialize as never });
  const tx = chain.land(other, anchorKey.address, root);
  const n = signs;
  await assert.rejects(send(deps(chain, dayDir)), /already in a Tempo memo/);
  assert.equal(signs, n);
  const r = await resume(deps(chain, dayDir), { send: false });
  assert.deepEqual(r, { status: "sent", tx });
  assert.equal(tempoAnchorOfDay(dayDir, root)!.tx, tx);
  rmSync(dir, { recursive: true });
});

test("tempo anchor resume: a send with no receipt waits; --send rebroadcasts the same bytes (same nonce), which land once", async () => {
  const { dir, dayDir } = await dayFolder();
  const chain = fakeTempo({ drop: 1 });
  await assert.rejects(send(deps(chain, dayDir)), /no receipt yet/);
  const file = JSON.parse(readFileSync(join(dayDir, "anchor-tempo-sent.json"), "utf8")) as { status: string; raw: string; tx: string; nonce: number };
  assert.equal(file.status, "sending");
  assert.equal((await resume(deps(chain, dayDir), { send: false })).status, "waiting");
  const r = await resume(deps(chain, dayDir), { send: true });
  assert.deepEqual(r, { status: "sent", tx: file.tx });
  assert.equal(chain.sent.length, 2);
  assert.equal(chain.sent[1], chain.sent[0], "the same signed bytes");
  rmSync(dir, { recursive: true });
});

test("tempo anchor resume: the nonce used by something else and no memo for the root: stop and look", async () => {
  const { dir, dayDir } = await dayFolder();
  const chain = fakeTempo({ drop: 1 });
  await assert.rejects(send(deps(chain, dayDir)));
  chain.setNonce(1);
  await assert.rejects(resume(deps(chain, dayDir), { send: true }), /stop and look/);
  rmSync(dir, { recursive: true });
});

test("tempo anchor: a fee bound over the cap is refused before signing", async () => {
  const { dir, dayDir } = await dayFolder();
  const n = signs;
  await assert.rejects(send(deps(fakeTempo({ gas: 5_000_000n, balance: 10_000_000n }), dayDir)), new RegExp(`over ${MAX_TEMPO_ANCHOR_FEE_ATOMIC}`));
  assert.equal(signs, n);
  rmSync(dir, { recursive: true });
});

test("tempo anchor: the signed-tx check refuses anything but the anchor", async () => {
  const root = `0x${"cd".repeat(32)}`;
  const sign = (over: Record<string, unknown> = {}, who = anchorKey) =>
    who.signTransaction({ type: "tempo", chainId: 4217, calls: [anchorCall(root, RECIPIENT)], nonce: 3, gas: 600_000n, maxFeePerGas: 12_000_000_000n, maxPriorityFeePerGas: 0n, feeToken: USDC_E, ...over } as never, { serializer: Transaction.serialize as never });
  const exp = { sender: anchorKey.address, root, recipient: RECIPIENT, nonce: 3 };
  assert.equal(anchorTxProblem(await sign(), exp), null);
  assert.match(anchorTxProblem(await sign(), { ...exp, root: `0x${"ce".repeat(32)}` })!, /memo/);
  assert.match(anchorTxProblem(await sign({}, privateKeyToAccount(generatePrivateKey())), exp)!, /not the anchor key/);
  assert.match(anchorTxProblem(await sign({ calls: [anchorCall(root, PAYER_ADDRESS)] }), exp)!, /recipient/);
  const two = encodeFunctionData({ abi: Abis.tip20, functionName: "transferWithMemo", args: [RECIPIENT, 2n, root as Hex] });
  assert.match(anchorTxProblem(await sign({ calls: [{ to: USDC_E, data: two }] }), exp)!, /amount 2/);
  const plain = encodeFunctionData({ abi: Abis.tip20, functionName: "transfer", args: [RECIPIENT, 1n] });
  assert.match(anchorTxProblem(await sign({ calls: [{ to: USDC_E, data: plain }] }), exp)!, /not transferWithMemo/);
  assert.match(anchorTxProblem(await sign({ calls: [anchorCall(root, RECIPIENT), anchorCall(root, RECIPIENT)] }), exp)!, /expected 1 call/);
  assert.match(anchorTxProblem(await sign({ gas: 5_000_000n }), exp)!, /fee bound/);
  assert.match(anchorTxProblem(await sign({ nonce: 4 }), exp)!, /nonce/);
  assert.match(anchorTxProblem(await sign({ chainId: 42431 }), exp)!, /chainId/);
});

test("tempo anchor read: another sender's memo, a memo written before the day ended, another root or another block is not vet402's anchor", async () => {
  const { dir, root } = await dayFolder();
  const chain = fakeTempo();
  const raw = await anchorKey.signTransaction({ type: "tempo", chainId: 4217, calls: [anchorCall(root, RECIPIENT)], nonce: 0, gas: 600_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n, feeToken: USDC_E } as never, { serializer: Transaction.serialize as never });
  const day = { day: DAY, root };
  const stranger = privateKeyToAccount(generatePrivateKey()).address;
  const bad = chain.land(raw, stranger, root);
  assert.match((await readTempoAnchorTx(chain.rpc, bad, SENDERS, RECIPIENT)).detail, /not by vet402's Tempo anchor key/);
  assert.equal((await checkTempoDayAnchor({ tx: bad, memo: root, block: 0x2800000 }, day, chain.rpc, SENDERS, RECIPIENT)).ok, false);
  const early = fakeTempo({ blockTime: AFTER_DAY - 3600 });
  const t2 = early.land(raw, anchorKey.address, root);
  assert.match((await checkTempoDayAnchor({ tx: t2, memo: root, block: 0x2800000 }, day, early.rpc, SENDERS, RECIPIENT)).detail, /before 2026-09-29 ended/);
  const t3 = chain.land(`${raw}00`, anchorKey.address, `0x${"99".repeat(32)}`);
  assert.match((await checkTempoDayAnchor({ tx: t3, memo: root, block: 0x2800000 }, day, chain.rpc, SENDERS, RECIPIENT)).detail, /is not the record's root/);
  const t4 = chain.land(`${raw}01`, anchorKey.address, root);
  assert.match((await checkTempoDayAnchor({ tx: t4, memo: root, block: 7 }, day, chain.rpc, SENDERS, RECIPIENT)).detail, /block 41943040, the index says 7/);
  assert.equal((await checkTempoDayAnchor({ tx: t4, memo: root, block: 0x2800000 }, day, chain.rpc, SENDERS, RECIPIENT)).ok, true);
  rmSync(dir, { recursive: true });
});

test("tempo anchor index: days[].tempoAnchor is read for the record's day; another root or a bad entry fails; none means nothing to check", () => {
  const root = `0x${"ab".repeat(32)}`;
  const rec = { anchor: { day: DAY, root } };
  const entry = { tx: `0x${"12".repeat(32)}`, memo: root, block: 42 };
  const idx = (days: unknown[]) => ({ kind: "vet402-observation-records", version: 0, days, records: [] });
  assert.deepEqual(tempoAnchorFromIndex(idx([{ day: DAY, root, tempoAnchor: entry }]), rec), { entry, problem: null });
  assert.deepEqual(tempoAnchorFromIndex(idx([{ day: DAY, root }]), rec), { entry: null, problem: null });
  assert.deepEqual(tempoAnchorFromIndex(idx([{ day: "2026-09-28", root: "0x00", tempoAnchor: entry }]), rec), { entry: null, problem: null });
  assert.match(tempoAnchorFromIndex(idx([{ day: DAY, root: `0x${"cd".repeat(32)}`, tempoAnchor: entry }]), rec).problem!, /names root/);
  assert.match(tempoAnchorFromIndex(idx([{ day: DAY, root, tempoAnchor: { ...entry, memo: `0x${"cd".repeat(32)}` } }]), rec).problem!, /memo is not the day's root/);
  assert.match(tempoAnchorFromIndex(idx([{ day: DAY, root, tempoAnchor: { ...entry, extra: 1 } }]), rec).problem!, /unknown fields extra/);
  assert.match(tempoAnchorFromIndex({ kind: "other" }, rec).problem!, /not a vet402 records index/);
  assert.deepEqual(tempoDayAnchorShape(entry, root), []);
});

test("tempo anchor index: a sent file that is not \"sent\" names nothing; one for another root is refused", async () => {
  const { dir, dayDir, root } = await dayFolder();
  assert.equal(tempoAnchorOfDay(dayDir, root), null);
  writeFileSync(join(dayDir, "anchor-tempo-sent.json"), JSON.stringify({ status: "sending", tx: `0x${"12".repeat(32)}` }));
  assert.equal(tempoAnchorOfDay(dayDir, root), null);
  writeFileSync(join(dayDir, "anchor-tempo-sent.json"), JSON.stringify({ status: "sent", tx: `0x${"12".repeat(32)}`, memo: `0x${"cd".repeat(32)}`, block: 5 }));
  assert.throws(() => tempoAnchorOfDay(dayDir, root), /memo is not the day's root/);
  rmSync(dir, { recursive: true });
});

// ---------- the check at preparePayment ----------

const SELLER = "0x060b0fB0Be9d90557577B3AEE480711067149Ff0";
const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const challenge402 = (md: Record<string, unknown> = { chainId: 4217 }) =>
  new Response("{}", {
    status: 402,
    headers: { "www-authenticate": `Payment id="abc", realm="svc.example", method="tempo", intent="charge", request="${b64url({ amount: "6000", currency: USDC_E, recipient: SELLER, methodDetails: md })}", expires="2099-01-01T00:00:00Z"` },
  });
function countingRpc() {
  const seen: string[] = [];
  const transport = custom({
    async request({ method }: { method: string }) {
      seen.push(method);
      switch (method) {
        case "eth_chainId":
          return "0x1079";
        case "eth_getTransactionCount":
          return "0x0";
        case "eth_estimateGas":
          return "0xc350";
        case "eth_maxPriorityFeePerGas":
          return "0x0";
        case "eth_getBlockByNumber":
          return { baseFeePerGas: "0x23c34600", number: "0x1", timestamp: "0x6a", hash: `0x${"00".repeat(32)}`, transactions: [] };
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  });
  return { seen, transport };
}
function mppxWith(account: ReturnType<typeof privateKeyToAccount>, transport: ReturnType<typeof custom>) {
  let signed = 0;
  const counted = { ...account, signTransaction: (...a: Parameters<typeof account.signTransaction>) => (signed++, account.signTransaction(...a)) };
  const m = Mppx.create({
    polyfill: false,
    methods: [mppxTempo.charge({ account: counted as never, mode: "pull", expectedChainId: 4217, allowedChainIds: [4217], getClient: () => createClient({ chain: tempoChain, transport }) })],
  });
  return { m, signed: () => signed };
}
const found = (payTo: string): CheckResultLike => ({ found: true, summary: "vet402 bought here", payTo: { asked: payTo, recordedByVet402: [SELLER], sameAsRecorded: payTo.toLowerCase() === SELLER.toLowerCase() } });

test("check at preparePayment: the check sees the selected challenge (tempo, payTo) and nothing is signed before onCheck returns", async () => {
  const payer = privateKeyToAccount(generatePrivateKey());
  const { transport } = countingRpc();
  const { m, signed } = mppxWith(payer, transport);
  const asked: unknown[] = [];
  const events: PaymentCheckEvent[] = [];
  const prepared = await preparePaymentWithCheck(m as never, challenge402(), {
    url: "https://svc.example/x",
    check: async (input) => (asked.push(input), found(input.payTo!)),
    onCheck: (e) => {
      events.push(e);
      assert.equal(signed(), 0, "no signature before the caller decides");
    },
  });
  assert.deepEqual(asked, [{ url: "https://svc.example/x", chain: "tempo", payTo: SELLER }]);
  assert.equal(events[0]!.amount, "6000");
  assert.equal(events[0]!.check!.payTo!.sameAsRecorded, true);
  const credential = await (prepared as unknown as { createCredential: () => Promise<string> }).createCredential();
  assert.equal(signed(), 1);
  const { Credential } = await import("mppx");
  const tx = Credential.deserialize<{ signature: string }>(credential).payload.signature;
  assert.equal(checkSignedTransfer(tx, { payer: payer.address, recipient: SELLER, amount: 6000n, sponsored: false }), null);
});

test("check at preparePayment: onCheck throws -> rejected, no credential, no signature, no RPC", async () => {
  const payer = privateKeyToAccount(generatePrivateKey());
  const { transport, seen } = countingRpc();
  const { m, signed } = mppxWith(payer, transport);
  await assert.rejects(
    preparePaymentWithCheck(m as never, challenge402(), {
      url: "https://svc.example/x",
      check: async (i) => ({ ...found(i.payTo!), payTo: { asked: i.payTo!, recordedByVet402: ["0x1111111111111111111111111111111111111111"], sameAsRecorded: false } }),
      onCheck: (e) => {
        if (e.check?.payTo && !e.check.payTo.sameAsRecorded) throw new Error("payTo differs from vet402's record");
      },
    }),
    /payTo differs/,
  );
  assert.equal(signed(), 0);
  assert.deepEqual(seen, []);
});

test("check at preparePayment: a check that cannot be read is reported, and the caller decides", async () => {
  const { transport } = countingRpc();
  const { m } = mppxWith(privateKeyToAccount(generatePrivateKey()), transport);
  let ev: PaymentCheckEvent | null = null;
  await preparePaymentWithCheck(m as never, challenge402(), { url: "https://svc.example/x", check: async () => Promise.reject(new Error("offline")), onCheck: (e) => void (ev = e) });
  assert.equal(ev!.error, "offline");
  assert.equal(ev!.check, null);
  assert.equal(offerOf({ method: "tempo", intent: "charge", request: { recipient: SELLER, methodDetails: { chainId: 42431 } } }).chain, null, "testnet is not a chain vet402 records");
});

// ---------- the access key ----------

test("access key: authorizeKey calldata carries one USDC.e limit of 1.00 per day, expiry 2026-12-31 end of day UTC (the newest key), transfer/transferWithMemo only", () => {
  const data = authorizeKeyData(TEMPO_ACCESS_KEY_ID);
  assert.equal(data.slice(0, 10), "0x980a6025");
  const fn = (Abis.accountKeychain as unknown as readonly { name?: string; inputs?: { type: string }[] }[]).filter((f) => f.name === "authorizeKey" && f.inputs?.length === 3 && f.inputs[2]!.type === "tuple");
  const d = decodeFunctionData({ abi: fn as never, data }) as unknown as { args: [string, number, { expiry: bigint; enforceLimits: boolean; limits: { token: string; amount: bigint; period: bigint }[]; allowAnyCalls: boolean; allowedCalls: { target: string; selectorRules: { selector: string; recipients: string[] }[] }[] }] };
  const [keyId, sigType, cfg] = d.args;
  assert.equal(keyId.toLowerCase(), TEMPO_ACCESS_KEY_ID.toLowerCase());
  assert.equal(sigType, 0);
  assert.equal(cfg.expiry, ACCESS_KEY_EXPIRY);
  assert.equal(new Date(Number(cfg.expiry) * 1000).toISOString(), "2026-12-31T23:59:59.000Z");
  // The key list: the 2026-09-30 key stays listed until its expiry (no gap while the env file still names it); the new one is the one authorized.
  assert.deepEqual(TEMPO_ACCESS_KEYS.map((k) => [k.id, new Date(Number(k.expiry) * 1000).toISOString(), k.file]), [
    ["0x1e9AadDc86f9132DFBA8B4287978aDE1ceC93c4b", "2026-10-09T23:59:59.000Z", "tempo-access.json"],
    ["0xf480276572D3f8b1c67Cb2469c7bF1a83c3b464d", "2026-12-31T23:59:59.000Z", "tempo-access-2026-12.json"],
  ]);
  assert.equal(TEMPO_ACCESS_KEY_ID, TEMPO_ACCESS_KEYS[1]!.id);
  assert.equal(ACCESS_KEY_EXPIRY, TEMPO_ACCESS_KEYS[1]!.expiry);
  // Both may sign (the chain's state decides whether one still can); any other key may not.
  assert.ok(isListedAccessKey("0x1e9aaddc86f9132dfba8b4287978ade1cec93c4b") && isListedAccessKey("0xF480276572D3F8B1C67CB2469C7BF1A83C3B464D"));
  assert.ok(!isListedAccessKey("0x1111111111111111111111111111111111111111"));
  assert.equal(cfg.enforceLimits, true);
  assert.deepEqual(cfg.limits.map((l) => [l.token.toLowerCase(), l.amount, l.period]), [[USDC_E, 1_000_000n, 86_400n]]);
  assert.equal(cfg.allowAnyCalls, false);
  assert.deepEqual(cfg.allowedCalls.map((c) => [c.target.toLowerCase(), c.selectorRules.map((r) => [r.selector, r.recipients.length])]), [[USDC_E, [["0xa9059cbb", 0], ["0x95777d59", 0]]]]);
  const two = accessKeyConfig();
  two.limits.push({ token: USDC_E as Hex, amount: 30_000_000n, period: 2_592_000n });
  assert.throws(() => authorizeKeyData(TEMPO_ACCESS_KEY_ID, two), /one USDC.e limit only/);
});

const USDC_SCOPE = { isScoped: true, scopes: [{ target: USDC_E, selectors: ["0xa9059cbb", "0x95777d59"], recipients: [[], []] }] };
const state = (over: Partial<KeyState> = {}): KeyState => ({ registered: true, keyId: TEMPO_ACCESS_KEY_ID, expiry: ACCESS_KEY_EXPIRY, enforceLimits: true, isRevoked: false, signatureType: 0, remaining: 1_000_000n, periodEnd: 1790800000n, allowedCalls: USDC_SCOPE, ...over });
/** getAllowedCalls as the precompile returns it (selectors as bytes4). */
const onChainScope = (targets: { target: string; selectors: string[] }[], isScoped = true) => [isScoped, targets.map((t) => ({ target: t.target, selectorRules: t.selectors.map((x) => ({ selector: x, recipients: [] })) }))];
const fakeKeyReader = (keyId: string, remaining: bigint, scope: unknown = onChainScope([{ target: USDC_E, selectors: ["0xa9059cbb", "0x95777d59"] }]), reads: string[] = []) => ({
  readContract: async (a: { functionName: string }) => {
    reads.push(a.functionName);
    if (a.functionName === "getKey") return { signatureType: 0, keyId, expiry: ACCESS_KEY_EXPIRY, enforceLimits: true, isRevoked: false };
    if (a.functionName === "getAllowedCalls") return scope;
    return [remaining, 1790800000n];
  },
});
const NOW = BigInt(Date.parse("2026-10-01T01:17:00Z") / 1000);

test("access key: the key's on-chain state must allow the payment before anything is signed", () => {
  assert.equal(keyProblem(state(), TEMPO_ACCESS_KEY_ID, 6000n, NOW), null);
  assert.match(keyProblem(state({ registered: false, expiry: 0n }), TEMPO_ACCESS_KEY_ID, 6000n, NOW)!, /not authorized/);
  assert.match(keyProblem(state({ isRevoked: true }), TEMPO_ACCESS_KEY_ID, 6000n, NOW)!, /revoked/);
  assert.match(keyProblem(state({ enforceLimits: false }), TEMPO_ACCESS_KEY_ID, 6000n, NOW)!, /no spending limit/);
  assert.match(keyProblem(state({ expiry: NOW + 60n }), TEMPO_ACCESS_KEY_ID, 6000n, NOW)!, /expires/);
  assert.match(keyProblem(state({ remaining: 5999n }), TEMPO_ACCESS_KEY_ID, 6000n, NOW)!, /limit left 5999/);
  assert.match(keyProblem(state({ keyId: "0x1111111111111111111111111111111111111111" }), TEMPO_ACCESS_KEY_ID, 6000n, NOW)!, /getKey returned/);
  // getAllowedCalls read back: only USDC.e transfer and transferWithMemo.
  const other = "0x2222222222222222222222222222222222222222";
  assert.match(keyProblem(state({ allowedCalls: { isScoped: false, scopes: [] } }), TEMPO_ACCESS_KEY_ID, 6000n, NOW)!, /not scoped/);
  assert.match(keyProblem(state({ allowedCalls: { isScoped: true, scopes: [] } }), TEMPO_ACCESS_KEY_ID, 6000n, NOW)!, /deny-all/);
  assert.match(keyProblem(state({ allowedCalls: { isScoped: true, scopes: [...USDC_SCOPE.scopes, { target: other, selectors: ["0xa9059cbb"], recipients: [[]] }] } }), TEMPO_ACCESS_KEY_ID, 6000n, NOW)!, /may call 0x2222/);
  assert.match(keyProblem(state({ allowedCalls: { isScoped: true, scopes: [{ target: USDC_E, selectors: ["0xa9059cbb", "0x095ea7b3"], recipients: [[], []] }] } }), TEMPO_ACCESS_KEY_ID, 6000n, NOW)!, /may call 0x095ea7b3 on USDC.e/);
  assert.equal(keyProblem(state({ allowedCalls: { isScoped: true, scopes: [{ target: USDC_E, selectors: ["0xa9059cbb"], recipients: [[]] }] } }), TEMPO_ACCESS_KEY_ID, 6000n, NOW), null, "a subset is fine");
});

test("signer plan (the daily dry run): a root key needs no read; an access key is read back, warned three days before its expiry, and refused six hours before it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "vet402-signer-plan-"));
  const rootFile = join(dir, "evm.json");
  writeFileSync(rootFile, JSON.stringify({ privateKey: generatePrivateKey() }));
  const f = accessFileFor(generatePrivateKey());
  const keyId = accessKeyIdOf(f);
  const accessFile = join(dir, "tempo-access.json");
  writeFileSync(accessFile, JSON.stringify(f));
  const reads: string[] = [];
  const OCT9 = BigInt(Date.parse("2026-10-09T23:59:59Z") / 1000); // a key with the first key's expiry
  const reader = (over: Partial<{ expiry: bigint; isRevoked: boolean }> = {}) => ({
    readContract: async (a: { functionName: string }) => {
      reads.push(a.functionName);
      if (a.functionName === "getKey") return { signatureType: 0, keyId, expiry: over.expiry ?? OCT9, enforceLimits: true, isRevoked: over.isRevoked ?? false };
      if (a.functionName === "getAllowedCalls") return onChainScope([{ target: USDC_E, selectors: ["0xa9059cbb", "0x95777d59"] }]);
      return [0n, 1790800000n]; // the day's limit used up: the plan does not look at the amount (signature time does)
    },
  });
  const at = (iso: string) => BigInt(Date.parse(iso) / 1000);
  const root = await signerPlan(rootFile, reader(), at("2026-10-01T01:17:00Z"), { keyId });
  assert.deepEqual(root, { kind: "root", problem: null, warn: null });
  assert.equal(reads.length, 0, "a root key file reads nothing on chain");
  const ok = await signerPlan(accessFile, reader(), at("2026-10-01T01:17:00Z"), { keyId });
  assert.deepEqual(ok, { kind: "access-key", keyId, expiresAt: "2026-10-09T23:59:59.000Z", problem: null, warn: null });
  assert.ok(!JSON.stringify(ok).includes(f.accessKey.slice(2)), "the key is never in the plan");
  const warn = await signerPlan(accessFile, reader(), at("2026-10-07T01:17:00Z"), { keyId });
  assert.equal(warn.problem, null);
  assert.match(warn.warn!, /expires at 2026-10-09T23:59:59\.000Z; renew it/);
  assert.equal((await signerPlan(accessFile, reader(), at("2026-10-06T23:59:58Z"), { keyId })).warn, null, "more than three days left");
  const late = await signerPlan(accessFile, reader(), at("2026-10-09T18:00:00Z"), { keyId });
  assert.match(late.problem!, /access key expires at 1791590399 .*\(expiry 2026-10-09T23:59:59\.000Z\)/, "less than six hours left: the run that follows could outlive it");
  assert.equal((await signerPlan(accessFile, reader(), at("2026-10-09T17:59:58Z"), { keyId })).problem, null);
  assert.match((await signerPlan(accessFile, reader(), at("2026-10-10T01:17:00Z"), { keyId })).problem!, /expires at/);
  assert.match((await signerPlan(accessFile, reader({ isRevoked: true }), at("2026-10-01T01:17:00Z"), { keyId })).problem!, /revoked/);
  assert.match((await signerPlan(accessFile, reader({ expiry: 0n }), at("2026-10-01T01:17:00Z"), { keyId })).problem!, /not authorized/);
  // the file's key is not one of TEMPO_ACCESS_KEYS (the default), or the file is missing
  assert.match((await signerPlan(accessFile, reader(), at("2026-10-01T01:17:00Z"))).problem!, /is not a registered key/);
  assert.match((await signerPlan(join(dir, "missing.json"), reader(), at("2026-10-01T01:17:00Z"))).problem!, /unreadable key file/);
  rmSync(dir, { recursive: true });
});

function accessFileFor(pk: Hex) {
  return { kind: ACCESS_KEY_FILE_KIND, accessKey: pk, account: PAYER_ADDRESS } as const;
}

test("access key signer: signs the approved transfer through a keychain envelope for the payer; the purchase check still passes", async () => {
  const f = accessFileFor(generatePrivateKey());
  const keyId = accessKeyIdOf(f);
  const { transport } = countingRpc();
  const reads: string[] = [];
  const read = fakeKeyReader(keyId, 1_000_000n, undefined, reads);
  const s = accessSigner(f, transport, { keyId, read, now: () => new Date("2026-10-01T01:17:00Z") });
  assert.equal(s.address.toLowerCase(), PAYER_ADDRESS.toLowerCase());
  for (const md of [{ chainId: 4217 }, { chainId: 4217, feePayer: true }]) {
    const out = await s.credentialFor(challenge402(md), "abc", SELLER);
    assert.equal(checkSignedTransfer(out.serializedTx, { payer: PAYER_ADDRESS, recipient: SELLER, amount: 6000n, sponsored: "feePayer" in md }), null);
    assert.equal(keychainProblem(out.serializedTx, PAYER_ADDRESS), null);
  }
  assert.deepEqual(reads.slice(0, 3), ["getKey", "getRemainingLimitWithPeriod", "getAllowedCalls"]);
});

test("access key signer: a key the chain does not allow signs nothing; a key other than the registered one is refused at load", async () => {
  const f = accessFileFor(generatePrivateKey());
  const keyId = accessKeyIdOf(f);
  const { transport, seen } = countingRpc();
  const s = accessSigner(f, transport, { keyId, read: fakeKeyReader(keyId, 100n), now: () => new Date("2026-10-01T01:17:00Z") });
  await assert.rejects(s.credentialFor(challenge402(), "abc", SELLER), /limit left 100 < 6000/);
  const wide = accessSigner(f, transport, { keyId, read: fakeKeyReader(keyId, 1_000_000n, onChainScope([{ target: USDC_E, selectors: ["0xa9059cbb"] }], false)), now: () => new Date("2026-10-01T01:17:00Z") });
  await assert.rejects(wide.credentialFor(challenge402(), "abc", SELLER), /not scoped/);
  assert.deepEqual(seen, [], "no RPC for signing");
  assert.throws(() => accessSigner(f, transport), /is not a registered key/);
  assert.throws(() => accessSigner({ ...f, account: "0x1111111111111111111111111111111111111111" }, transport, { keyId }), /another account/);
  // loadSigner routes an access key file to the access signer (and so refuses a key other than the registered one).
  const dir = mkdtempSync(join(tmpdir(), "vet402-ak-"));
  writeFileSync(join(dir, "k.json"), JSON.stringify(f));
  assert.throws(() => loadSigner(join(dir, "k.json")), /is not a registered key/);
  rmSync(dir, { recursive: true });
});

test("access key: a root-key signature is not a keychain signature", async () => {
  const root = privateKeyToAccount(generatePrivateKey());
  const raw = await root.signTransaction({ type: "tempo", chainId: 4217, calls: [anchorCall(`0x${"ab".repeat(32)}`)], nonce: 0, gas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n } as never, { serializer: Transaction.serialize as never });
  assert.match(keychainProblem(raw, root.address)!, /not keychain/);
});

test("access key registration: signed by the root, one authorizeKey call, the fee paid by another account", async () => {
  const rootPk = generatePrivateKey();
  const root = Account.fromSecp256k1(rootPk);
  const payer = Account.fromSecp256k1(generatePrivateKey());
  const keyId = TEMPO_ACCESS_KEY_ID;
  const base = { type: "tempo", chainId: 4217, nonce: 7, gas: 3_000_000n, maxFeePerGas: 12_000_000_000n, maxPriorityFeePerGas: 0n, feeToken: USDC_E };
  const sign = (over: Record<string, unknown>) => root.signTransaction({ ...base, calls: [{ to: ACCOUNT_KEYCHAIN, data: authorizeKeyData(keyId) }], ...over } as never, { serializer: Transaction.serialize as never });
  const exp = { account: root.address, keyId, feePayer: payer.address, nonce: 7 };
  assert.equal(authorizeTxProblem(await sign({ feePayer: payer }), exp), null);
  assert.match(authorizeTxProblem(await sign({}), exp)!, /no fee payer signature/);
  assert.match(authorizeTxProblem(await sign({ feePayer: payer }), { ...exp, feePayer: root.address })!, /fee payer is the payer/);
  const otherKey = authorizeKeyData("0x1111111111111111111111111111111111111111");
  assert.match(authorizeTxProblem(await sign({ feePayer: payer, calls: [{ to: ACCOUNT_KEYCHAIN, data: otherKey }] }), exp)!, /not authorizeKey for the access key/);
  assert.match(authorizeTxProblem(await sign({ feePayer: payer, gas: 10_000_000n }), exp)!, /fee bound/);
});
