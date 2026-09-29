/**
 * 8004-solana feedback writer, against a fake chain and a fake site (no network, no real key):
 *  - the give_feedback bytes and the one-instruction transaction shape
 *  - which outcome is written, and which agent (owner = payTo, one agent or an operator pin)
 *  - every gate refuses on its own: record not public or hash changed, owner is not the payTo,
 *    purchase not a finalized USDC transfer from the writer, feedback already on chain or in the ledger
 *  - --send writes the ledger before the transaction leaves, and writes at most two per run
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSigner, getAddressEncoder, getBase58Decoder, address, type KeyPairSigner } from "@solana/kit";
import type { Rpc } from "../src/chain.js";
import { USDC_MINT } from "../src/constants.js";
import type { LoadedRecords } from "../src/receipt/publish.js";
import { chooseAgent, feedbackValues, groupByPayTo, MAX_WRITES_PER_RUN, normalizePurchases, outcomeOf, recordUri, refusals, type GateChecks, type Purchase } from "../src/solana-feedback/plan.js";
import {
  AGENT_ACCOUNT_DISCRIMINATOR,
  agentPda,
  argProblems,
  assertGiveFeedbackOnly,
  compileGiveFeedbackTx,
  decodeGiveFeedbackData,
  encodeGiveFeedbackData,
  MPL_CORE_PROGRAM,
  parseAgentAccount,
  REGISTRY_PROGRAM,
  type GiveFeedbackArgs,
} from "../src/solana-feedback/registry.js";
import { plan, send, type FeedbackDeps, type Ledger } from "../src/solana-feedback/run.js";

const enc = getAddressEncoder();
const b58 = getBase58Decoder();
const key = async () => (await generateKeyPairSigner()).address as string;

const ARGS: GiveFeedbackArgs = {
  value: 0n,
  valueDecimals: 0,
  score: 0,
  feedbackFileHash: new Uint8Array(32).fill(7),
  tag1: "x402-delivery",
  tag2: "paid-not-delivered",
  endpoint: "https://seller.example/api",
  feedbackUri: recordUri("obs_2026-09-29_000210"),
};

test("give_feedback data round-trips and matches the program's layout", () => {
  const data = encodeGiveFeedbackData(ARGS);
  assert.deepEqual([...data.subarray(0, 8)], [145, 136, 123, 3, 215, 165, 98, 41]);
  // 8 + 16 + 1 + 2 + 33 + (4+13) + (4+18) + (4+26) + (4+uri)
  const uriLen = new TextEncoder().encode(ARGS.feedbackUri).length;
  assert.equal(data.length, 8 + 16 + 1 + 2 + 33 + 17 + 22 + 30 + 4 + uriLen);
  const back = decodeGiveFeedbackData(data);
  assert.deepEqual({ ...back, feedbackFileHash: [...back.feedbackFileHash!] }, { ...ARGS, feedbackFileHash: [...ARGS.feedbackFileHash!] });
  const neg = decodeGiveFeedbackData(encodeGiveFeedbackData({ ...ARGS, value: -5n, score: null, feedbackFileHash: null }));
  assert.equal(neg.value, -5n);
  assert.equal(neg.score, null);
  assert.throws(() => decodeGiveFeedbackData(Uint8Array.of(...data, 0)), /trailing/);
});

test("arguments over the program's limits are refused before any transaction exists", () => {
  assert.deepEqual(argProblems(ARGS), []);
  assert.match(argProblems({ ...ARGS, feedbackUri: "https://x/" + "a".repeat(250) }).join(), /feedbackUri over 250/);
  assert.match(argProblems({ ...ARGS, tag2: "t".repeat(33) }).join(), /tag2 over 32/);
  assert.match(argProblems({ ...ARGS, score: 101 }).join(), /score/);
  assert.throws(() => encodeGiveFeedbackData({ ...ARGS, endpoint: "e".repeat(251) }), /refused/);
  assert.ok(new TextEncoder().encode(recordUri("obs_2026-09-29_000210")).length <= 250);
});

test("the transaction holds one give_feedback, only the payer signs, only payer and agent PDA are writable", async () => {
  const acc = { client: await key(), agentPda: await key(), asset: await key(), collection: await key() };
  const tx = compileGiveFeedbackTx(acc, ARGS);
  assertGiveFeedbackOnly(tx.messageBytes, acc, ARGS);
  assert.throws(() => assertGiveFeedbackOnly(tx.messageBytes, acc, { ...ARGS, score: 100 }), /instruction data differs/);
  assert.throws(() => assertGiveFeedbackOnly(tx.messageBytes, { ...acc, asset: acc.collection, collection: acc.asset }, ARGS), /instruction accounts/);
  assert.throws(() => assertGiveFeedbackOnly(tx.messageBytes, { ...acc, client: acc.asset }, ARGS), /fee payer/);
});

const day = (d: string, delivered: boolean, tx: string, payTo = "P"): Purchase => ({ source: "t", day: d, at: `${d}T08:00:00Z`, host: "seller.example", url: "https://seller.example/api", payTo, tx, settled: true, delivered, httpStatus: delivered ? 200 : 500 });

test("an outcome is written only when every settled purchase agrees, on two days or more", () => {
  assert.equal(outcomeOf([day("2026-09-28", false, "a"), day("2026-09-29", false, "b")]).outcome, "paid-not-delivered");
  assert.equal(outcomeOf([day("2026-09-28", true, "a"), day("2026-09-29", true, "b")]).outcome, "delivered");
  assert.equal(outcomeOf([day("2026-09-28", false, "a"), day("2026-09-29", true, "b")]).outcome, null);
  assert.equal(outcomeOf([day("2026-09-29", false, "a"), day("2026-09-29", false, "b")]).outcome, null);
  assert.equal(outcomeOf([{ ...day("2026-09-28", false, "a"), settled: false }, day("2026-09-29", false, "b")]).outcome, null);
  assert.deepEqual(feedbackValues("paid-not-delivered"), { value: 0n, valueDecimals: 0, score: 0, tag1: "x402-delivery", tag2: "paid-not-delivered" });
  // the same payment in two inputs counts once
  assert.equal(groupByPayTo([day("2026-09-28", false, "a"), day("2026-09-28", false, "a")]).get("P")!.length, 1);
});

test("inputs: only the payer's files, only purchases that were sent", () => {
  assert.throws(() => normalizePurchases({ kind: "census-live", payer: "X", rows: [] }, "c", "Y"), /payer/);
  const rows = normalizePurchases(
    {
      kind: "vet402-remeasure",
      payer: "Y",
      rows: [
        { at: "2026-09-29T08:00:00Z", url: "https://a.example/x", payTo: "P", tx: "t1", outcome: "sent", settled: true, delivered: false, httpStatus: 500 },
        { at: "2026-09-29T08:01:00Z", url: "https://a.example/x", payTo: "P", tx: "t2", outcome: "refused", settled: false, delivered: false },
      ],
    },
    "r",
    "Y",
  );
  assert.deepEqual(rows.map((r) => r.tx), ["t1"]);
});

test("the agent: the only one owned by the payTo, or an operator pin among several", () => {
  assert.equal(chooseAgent(["A"], undefined).asset, "A");
  assert.equal(chooseAgent(["A", "B"], undefined).asset, null);
  assert.match(chooseAgent(["A", "B"], undefined).detail, /owns 2 agents/);
  assert.equal(chooseAgent(["A", "B"], "B").asset, "B");
  assert.equal(chooseAgent(["A", "B"], "C").asset, null);
  assert.equal(chooseAgent([], undefined).asset, null);
});

const PASS: GateChecks = {
  client: "W",
  payTo: "P",
  outcome: "paid-not-delivered",
  agent: { asset: "A", pdaMatches: true, cachedOwner: "P", coreOwner: "P" },
  purchase: { tx: "T", finalized: true, err: null, clientSigned: true, clientDeltaAtomic: -1000n, payToDeltaAtomic: 1000n },
  record: { id: "obs_2026-09-29_000001", published: true, fetchedOk: true, fetchedSha256: "h", indexSha256: "h", hashToWrite: "h", paymentTx: "T", payer: "W", payTo: "P", verdict: "NOT_DELIVERED", verifiesOffline: true },
  args: { uri: recordUri("obs_2026-09-29_000001"), endpoint: "https://seller.example/api", tag1: "x402-delivery", tag2: "paid-not-delivered" },
  existingOnChain: 0,
  inLedger: false,
};

test("gates: all pass -> no refusal; any one missing -> refused", () => {
  assert.deepEqual(refusals(PASS), []);
  const cases: [string, GateChecks, RegExp][] = [
    ["record not public", { ...PASS, record: { ...PASS.record!, published: false } }, /not published/],
    ["URI not reachable", { ...PASS, record: { ...PASS.record!, fetchedOk: false } }, /could not be fetched/],
    ["public bytes changed", { ...PASS, record: { ...PASS.record!, fetchedSha256: "other" } }, /disagree/],
    ["record of another purchase", { ...PASS, record: { ...PASS.record!, paymentTx: "U" } }, /not about purchase/],
    ["record verdict does not back the outcome", { ...PASS, record: { ...PASS.record!, verdict: "DELIVERED" } }, /does not back/],
    ["record does not verify", { ...PASS, record: { ...PASS.record!, verifiesOffline: false } }, /verify offline/],
    ["no record", { ...PASS, record: null }, /no vet402 record/],
    ["owner is not the payTo", { ...PASS, agent: { ...PASS.agent!, coreOwner: "Q" } }, /Core asset owner Q/],
    ["owner not read", { ...PASS, agent: { ...PASS.agent!, coreOwner: null } }, /not read/],
    ["wrong PDA", { ...PASS, agent: { ...PASS.agent!, pdaMatches: false } }, /PDA/],
    ["writer owns the agent", { ...PASS, payTo: "W", agent: { ...PASS.agent!, coreOwner: "W", cachedOwner: "W" }, record: { ...PASS.record!, payTo: "W" } }, /writer owns/],
    ["purchase not finalized", { ...PASS, purchase: { ...PASS.purchase!, finalized: false } }, /not finalized/],
    ["purchase failed", { ...PASS, purchase: { ...PASS.purchase!, err: { InstructionError: [0, "x"] } } }, /failed on chain/],
    ["writer did not sign", { ...PASS, purchase: { ...PASS.purchase!, clientSigned: false } }, /did not sign/],
    ["no USDC to the payTo", { ...PASS, purchase: { ...PASS.purchase!, payToDeltaAtomic: 0n } }, /not a USDC transfer/],
    ["amounts differ", { ...PASS, purchase: { ...PASS.purchase!, payToDeltaAtomic: 999n } }, /not a USDC transfer/],
    ["already on chain", { ...PASS, existingOnChain: 1 }, /already wrote 1/],
    ["history unreadable", { ...PASS, existingOnChain: null }, /could not check/],
    ["already in the ledger", { ...PASS, inLedger: true }, /ledger already/],
    ["no outcome", { ...PASS, outcome: null }, /no single outcome/],
    ["URI too long", { ...PASS, args: { ...PASS.args!, uri: "x".repeat(251) } }, /251 bytes/],
  ];
  for (const [name, c, re] of cases) {
    const r = refusals(c);
    assert.ok(r.length > 0 && r.some((x) => re.test(x)), `${name}: ${r.join(" | ")}`);
  }
});

// ---------- the whole run against a fake chain ----------

interface World {
  signer: KeyPairSigner;
  payTo: string;
  asset: string;
  pda: string;
  collection: string;
  recordText: string;
  sha: string;
  sent: string[];
  ledgerAtSend: (Ledger | null)[];
  existing: boolean;
  publicText: string | null;
  coreOwner: string;
}

function agentBytes(w: World): Uint8Array {
  const d = new Uint8Array(8 + 32 * 4 + 2 + 1 + 32 + 8 + 40);
  d.set(AGENT_ACCOUNT_DISCRIMINATOR, 0);
  d.set(enc.encode(address(w.collection)), 8);
  d.set(enc.encode(address(w.payTo)), 40);
  d.set(enc.encode(address(w.payTo)), 72);
  d.set(enc.encode(address(w.asset)), 104);
  d[136] = 255;
  d[137] = 0;
  d[138] = 0;
  new DataView(d.buffer).setBigUint64(139 + 32, 5n, true);
  return d;
}

function fakeRpc(w: World, ledgerPath: string): Rpc {
  const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64");
  return async (method, params) => {
    const p = params as unknown[];
    switch (method) {
      case "getAccountInfo": {
        const k = p[0] as string;
        if (k === w.pda) return { value: { owner: REGISTRY_PROGRAM, data: [b64(agentBytes(w)), "base64"] } };
        if (k === w.asset) {
          const a = new Uint8Array(1 + 32 + 10);
          a[0] = 1;
          a.set(enc.encode(address(w.coreOwner)), 1);
          return { value: { owner: MPL_CORE_PROGRAM, data: [b64(a), "base64"] } };
        }
        return { value: null };
      }
      case "getTransaction": {
        const sig = p[0] as string;
        const opts = p[1] as { encoding: string };
        if (opts.encoding === "jsonParsed" && sig.startsWith("buy")) {
          const bal = (owner: string, amount: string) => ({ owner, mint: USDC_MINT, uiTokenAmount: { amount } });
          return {
            blockTime: 1,
            meta: { err: null, preTokenBalances: [bal(w.signer.address, "5000"), bal(w.payTo, "0")], postTokenBalances: [bal(w.signer.address, "4000"), bal(w.payTo, "1000")] },
            transaction: { message: { accountKeys: [{ pubkey: "facilitator", signer: true }, { pubkey: w.signer.address, signer: true }] } },
          };
        }
        if (sig === "earlier-feedback") {
          const data = b58.decode(encodeGiveFeedbackData(ARGS));
          return {
            meta: { err: null },
            transaction: { message: { accountKeys: [w.signer.address, w.pda, w.asset, w.collection, "11111111111111111111111111111111", REGISTRY_PROGRAM], instructions: [{ programIdIndex: 5, accounts: [0, 1, 2, 3, 4, 5, 5, 5, 5], data }] } },
          };
        }
        return null;
      }
      case "getSignaturesForAddress":
        return w.existing ? [{ signature: "earlier-feedback" }] : [{ signature: p[0] === w.pda ? "someone-else" : "buy-1" }];
      case "getLatestBlockhash":
        return { value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 100 } };
      case "simulateTransaction":
        return { value: { err: null, logs: ["Program log: Feedback #5 created"], unitsConsumed: 28000 } };
      case "getFeeForMessage":
        return { value: 5000 };
      case "getBalance":
        return { value: 1_000_000 };
      case "sendTransaction":
        w.sent.push(p[0] as string);
        w.ledgerAtSend.push(JSON.parse(readFileSync(ledgerPath, "utf8")) as Ledger);
        return "sig";
      case "getSignatureStatuses":
        return { value: [{ err: null, confirmationStatus: "confirmed" }] };
      case "getBlockHeight":
        return 50;
      default:
        throw new Error(`fake rpc: ${method}`);
    }
  };
}

async function world(over: Partial<World> = {}): Promise<World> {
  const signer = await generateKeyPairSigner();
  const payTo = await key();
  const asset = await key();
  const recordText = JSON.stringify({ id: "obs_2026-09-29_000210" }) + "\n";
  return {
    signer,
    payTo,
    asset,
    pda: await agentPda(asset),
    collection: await key(),
    recordText,
    sha: createHash("sha256").update(recordText).digest("hex"),
    sent: [],
    ledgerAtSend: [],
    existing: false,
    publicText: recordText,
    coreOwner: payTo,
    ...over,
  };
}

function deps(w: World, extra: Partial<FeedbackDeps> = {}): FeedbackDeps {
  const dir = mkdtempSync(join(tmpdir(), "solfb-"));
  const ledgerPath = join(dir, "ledger.json");
  const obs = {
    id: "obs_2026-09-29_000210",
    verdict: { code: "NOT_DELIVERED" },
    resourceUrl: "https://seller.example/api?x=1",
    observer: { address: "0x0" },
    payment: { transaction: "buy-2", payer: w.signer.address, payTo: w.payTo },
  };
  const published = {
    index: {},
    notified: { note: "", sellers: [] },
    records: [{ entry: { id: obs.id, day: "2026-09-29", sequence: 210, sha256: w.sha }, obs, text: w.recordText }],
  } as unknown as LoadedRecords;
  const fetchImpl = (async () => (w.publicText === null ? new Response("nope", { status: 404 }) : new Response(w.publicText, { status: 200 }))) as typeof fetch;
  return {
    rpc: fakeRpc(w, ledgerPath),
    fetchImpl,
    client: w.signer.address,
    purchases: [day("2026-09-28", false, "buy-1", w.payTo), day("2026-09-29", false, "buy-2", w.payTo)],
    published,
    receiptsDir: null,
    agentsOwnedBy: new Map([[w.payTo, [{ asset: w.asset, pda: w.pda }]]]),
    pins: new Map(),
    ledgerPath,
    verifyRecord: async () => true,
    loadSigner: async () => w.signer,
    sleep: async () => {},
    ...extra,
  };
}

test("run: every gate passes -> one write; the ledger names it before the transaction leaves", async () => {
  const w = await world();
  const d = deps(w);
  const items = await plan(d);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0]!.item.refusals, []);
  assert.equal(items[0]!.item.args!.feedbackUri, "https://kzmttkc.github.io/vet402-delivery/records/obs_2026-09-29_000210.json");
  assert.equal(items[0]!.item.args!.endpoint, "https://seller.example/api"); // no query string on chain
  const r = await send(d, items);
  assert.equal(r[0]!.sent, true);
  assert.equal(w.sent.length, 1);
  const before = w.ledgerAtSend[0]![w.asset]!;
  assert.equal(before.status, "sending");
  assert.equal(before.feedbackFileHash, w.sha);
  assert.equal((JSON.parse(readFileSync(d.ledgerPath, "utf8")) as Ledger)[w.asset]!.status, "confirmed");
  // a second run finds its own ledger entry and does not write again
  const again = await send(d, await plan(d));
  assert.equal(again[0]!.sent, false);
  assert.equal(w.sent.length, 1);
});

test("run: this wallet already wrote to the agent on chain -> nothing sent", async () => {
  const w = await world({ existing: true });
  const d = deps(w);
  const items = await plan(d);
  assert.match(items[0]!.item.refusals.join(), /already wrote 1/);
  const r = await send(d, items);
  assert.equal(r[0]!.sent, false);
  assert.equal(w.sent.length, 0);
});

test("run: record not public, or public bytes differ from the hash -> nothing sent", async () => {
  const w1 = await world({ publicText: null });
  const d1 = deps(w1);
  assert.match((await plan(d1))[0]!.item.refusals.join(), /could not be fetched/);
  assert.equal((await send(d1, await plan(d1)))[0]!.sent, false);
  const w2 = await world();
  w2.publicText = w2.recordText + " ";
  const d2 = deps(w2);
  assert.match((await plan(d2))[0]!.item.refusals.join(), /disagree/);
  assert.equal((await send(d2, await plan(d2)))[0]!.sent, false);
  assert.equal(w1.sent.length + w2.sent.length, 0);
});

test("run: the site changes between plan and send -> the send re-fetches and refuses", async () => {
  const w = await world();
  const d = deps(w);
  const items = await plan(d);
  w.publicText = "changed";
  assert.equal((await send(d, items))[0]!.sent, false);
  assert.equal(w.sent.length, 0);
});

test("run: the Core asset changed hands (owner is no longer the payTo) -> nothing sent", async () => {
  const w = await world();
  w.coreOwner = await key();
  const d = deps(w);
  const items = await plan(d);
  assert.match(items[0]!.item.refusals.join(), /Core asset owner/);
  assert.equal((await send(d, items))[0]!.sent, false);
});

test("run: the payTo owns several agents and no pin -> no agent, nothing sent", async () => {
  const w = await world();
  const d = deps(w, { agentsOwnedBy: new Map([[w.payTo, [{ asset: w.asset, pda: w.pda }, { asset: await key(), pda: await key() }]]]) });
  const items = await plan(d);
  assert.match(items[0]!.item.refusals.join(), /no agent chosen/);
  assert.equal((await send(d, items))[0]!.sent, false);
});

test("run: a key that is not the paying wallet is refused before signing", async () => {
  const w = await world();
  const other = await generateKeyPairSigner();
  const d = deps(w, { loadSigner: async () => other });
  await assert.rejects(send(d, await plan(d)), /not the paying wallet/);
  assert.equal(w.sent.length, 0);
});

test("run: at most two writes per run", async () => {
  assert.equal(MAX_WRITES_PER_RUN, 2);
  const signer = await generateKeyPairSigner();
  const ws = [await world({ signer }), await world({ signer }), await world({ signer })];
  const ds = ws.map((w) => deps(w));
  const items = (await Promise.all(ds.map((d) => plan(d)))).flat();
  // one deps object for all three: shared ledger and one counting rpc
  const d = ds[0]!;
  let sends = 0;
  const rpcs = new Map(ws.map((w, i) => [w.asset, ds[i]!.rpc]));
  const multi: Rpc = async (method, params) => {
    if (method === "sendTransaction") sends++;
    for (const w of ws) {
      const p = params as unknown[];
      if (p.includes(w.pda) || p.includes(w.asset)) return rpcs.get(w.asset)!(method, params);
    }
    if (method === "sendTransaction") return "sig";
    return ds[0]!.rpc(method, params);
  };
  writeFileSync(d.ledgerPath, "{}\n");
  const r = await send({ ...d, rpc: multi, fetchImpl: (async () => new Response(ws[0]!.recordText, { status: 200 })) as typeof fetch }, items);
  assert.equal(r.filter((x) => x.sent).length, 2);
  assert.match(r[2]!.status, /at most 2/);
  assert.equal(sends, 2);
});

test("AgentAccount parsing reads owner, asset and feedback count at the program's offsets", async () => {
  const w = await world();
  const a = parseAgentAccount(agentBytes(w));
  assert.equal(a.owner, w.payTo);
  assert.equal(a.asset, w.asset);
  assert.equal(a.collection, w.collection);
  assert.equal(a.agentWallet, null);
  assert.equal(a.feedbackCount, 5n);
});
