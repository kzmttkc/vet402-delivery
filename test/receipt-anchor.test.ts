/**
 * The daily anchor, against a fake chain (no network, no real key):
 *  - an anchor counts only when vet402's anchor wallet paid for and signed the memo (#7)
 *  - no send when the chain already has a memo for the day; nothing signed on the simulate path (#6)
 *  - an interrupted send ("sending") is resumed from what the chain says (#6)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSigner, getSignatureFromTransaction, getTransactionDecoder, type KeyPairSigner } from "@solana/kit";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import type { Rpc } from "../src/chain.js";
import { MEMO_PROGRAM } from "../src/constants.js";
import { dayRoot, plan, resume, send, SOLANA_GENESIS, type AnchorDeps, type SentFile } from "../src/receipt/anchor-run.js";
import { assemble, type Facts } from "../src/receipt/build.js";
import { checkAnchorOnChain, findDayAnchors } from "../src/receipt/chain.js";
import { observationDigest, signObservation } from "../src/receipt/eip712.js";
import { anchorMemo, buildTree } from "../src/receipt/merkle.js";
import { VET402_ANCHOR_SIGNERS } from "../src/receipt/observers.js";
import { PAYER_ADDRESS } from "../src/constants.js";
import type { Observation } from "../src/receipt/types.js";
import { verifyOffline } from "../src/receipt/verify.js";

const DAY = "2026-09-28";
const AFTER_DAY = Date.parse("2026-09-29T01:00:00Z") / 1000;
const account = privateKeyToAccount(generatePrivateKey());

function facts(i: number): Facts {
  return {
    dataset: "test",
    row: `rows[${i}]`,
    observedAt: `${DAY}T07:14:5${i}.000Z`,
    requestUrl: `https://s${i}.example/x`,
    method: "GET",
    requestTs: null,
    payment: {
      network: "eip155:8453",
      scheme: "x402-exact",
      transaction: `0x${String(i).repeat(64)}`,
      payer: "0x9B59aBF3dc92E7f60A6eeB7c1dEDC6dEB0bB4E51",
      payTo: "0xaBF4FAbd7c416fB67202E5f9002389Fc75e2a9D0",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      amount: "1000",
      decimals: 6,
      assetSymbol: "USDC",
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

/** A receipts folder with one day of three signed, rooted, pending records. */
async function dayFolder(): Promise<{ dir: string; dayDir: string; memo: string; root: Hex; obs: Observation[] }> {
  const dir = mkdtempSync(join(tmpdir(), "vet402-anchor-"));
  const dayDir = join(dir, DAY);
  mkdirSync(dayDir);
  const obs: Observation[] = [];
  for (let i = 1; i <= 3; i++) obs.push(await signObservation(assemble(facts(i), i, { id: "did:web:vet402.com#t", address: account.address }, `0x${"11".repeat(32)}`, 1790000000), account));
  const tree = buildTree(obs.map((o) => observationDigest(o)));
  const rooted = obs.map((o, i) => ({
    ...o,
    anchor: { status: "pending" as const, day: DAY, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", tx: null, root: tree.root, leafIndex: i, proof: tree.proofs[i]!, count: 3, sequenceRange: [1, 3] as [number, number], observerAddress: account.address, anchoredAt: null },
  }));
  for (const o of rooted) writeFileSync(join(dayDir, `${o.id}.json`), `${JSON.stringify(o, null, 2)}\n`);
  const memo = anchorMemo({ day: DAY, root: tree.root, count: 3, sequenceRange: [1, 3], observerAddress: account.address });
  return { dir, dayDir, memo, root: tree.root, obs: rooted };
}

interface ChainTx {
  feePayer: string;
  memo: string;
  err?: unknown;
  blockTime?: number;
}

/** A fake Solana RPC. `history` is the anchor wallet's signature list, newest first. */
function fakeChain(opts: { wallet: string; history?: { signature: string; memo: string | null; err?: unknown; blockTime: number }[]; txs?: Record<string, ChainTx>; height?: number; landOnSend?: boolean }) {
  const history = [...(opts.history ?? [])];
  const txs: Record<string, ChainTx> = { ...(opts.txs ?? {}) };
  const statuses: Record<string, { err: unknown; confirmationStatus: string }> = {};
  for (const [sig, t] of Object.entries(txs)) statuses[sig] = { err: t.err ?? null, confirmationStatus: "finalized" };
  const calls: string[] = [];
  const sent: string[] = [];
  let sentFileAtSend: boolean | null = null;
  let checkSentFile: (() => boolean) | null = null;
  const rpc: Rpc = async (method, params) => {
    calls.push(method);
    switch (method) {
      case "getGenesisHash":
        return SOLANA_GENESIS;
      case "getLatestBlockhash":
        return { value: { blockhash: "EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N", lastValidBlockHeight: 1000 } };
      case "simulateTransaction":
        return { value: { err: null, logs: ["ok"], unitsConsumed: 62927 } };
      case "getFeeForMessage":
        return { value: 5000 };
      case "getBalance":
        return { value: 100_000_000 };
      case "getBlockHeight":
        return opts.height ?? 900;
      case "getSignaturesForAddress": {
        const [addr, cfg] = params as [string, { before?: string }];
        if (addr !== opts.wallet) return [];
        const start = cfg.before ? history.findIndex((h) => h.signature === cfg.before) + 1 : 0;
        return history.slice(start, start + 1000).map((h) => ({ signature: h.signature, err: h.err ?? null, memo: h.memo ? `[${h.memo.length}] ${h.memo}` : null, blockTime: h.blockTime }));
      }
      case "getSignatureStatuses": {
        const [[sig]] = params as [[string]];
        return { value: [statuses[sig!] ?? null] };
      }
      case "getTransaction": {
        const [sig, cfg] = params as [string, { encoding: string }];
        const t = txs[sig];
        if (!t) return null;
        if (cfg.encoding === "json") return { blockTime: t.blockTime ?? AFTER_DAY };
        return {
          blockTime: t.blockTime ?? AFTER_DAY,
          meta: { err: t.err ?? null },
          transaction: { message: { accountKeys: [{ pubkey: t.feePayer, signer: true }, { pubkey: MEMO_PROGRAM, signer: false }], instructions: [{ programId: MEMO_PROGRAM, parsed: t.memo }] } },
        };
      }
      case "sendTransaction": {
        const [wire] = params as [string];
        sent.push(wire);
        sentFileAtSend = checkSentFile ? checkSentFile() : null;
        if (opts.landOnSend) {
          const decoded = getTransactionDecoder().decode(Buffer.from(wire, "base64"));
          const sig = getSignatureFromTransaction(decoded);
          const memo = Buffer.from(wire, "base64").toString("latin1").match(/x402-observation\/v0 [^\x00-\x1f]*?observer=0x[0-9a-fA-F]{40}/)![0];
          txs[sig] = { feePayer: opts.wallet, memo };
          statuses[sig] = { err: null, confirmationStatus: "confirmed" };
          history.unshift({ signature: sig, memo, blockTime: AFTER_DAY });
        }
        return "sig";
      }
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  return {
    rpc,
    calls,
    sent,
    txs,
    statuses,
    history,
    sentFileWasThere: () => sentFileAtSend,
    watchSentFile: (f: () => boolean) => {
      checkSentFile = f;
    },
  };
}

async function deps(dayDir: string, rpc: Rpc, signer: KeyPairSigner, onLoad?: () => void): Promise<AnchorDeps> {
  return {
    rpc,
    dayDir,
    day: DAY,
    feePayer: signer.address,
    anchorSigners: [signer.address],
    loadSigner: async () => {
      onLoad?.();
      return signer;
    },
    sleep: async () => {},
    pollTries: 3,
  };
}

const sentFile = (dayDir: string) => join(dayDir, "anchor-sent.json");

// ---------- #7: whose memo counts ----------

test("the anchor wallet constant is vet402's Solana payer", () => {
  assert.deepEqual([...VET402_ANCHOR_SIGNERS], [PAYER_ADDRESS]);
});

test("#7 checkAnchorOnChain: a memo from another wallet is not an anchor, even with the right root", async () => {
  const f = await dayFolder();
  try {
    const vet = await generateKeyPairSigner();
    const stranger = await generateKeyPairSigner();
    const chain = fakeChain({
      wallet: vet.address,
      txs: {
        good: { feePayer: vet.address, memo: f.memo },
        forged: { feePayer: stranger.address, memo: f.memo },
        failed: { feePayer: vet.address, memo: f.memo, err: { InstructionError: [0, "x"] } },
        wrongCount: { feePayer: vet.address, memo: f.memo.replace("n=3", "n=4") },
      },
    });
    const withTx = (tx: string): Observation => ({ ...f.obs[0]!, anchor: { ...f.obs[0]!.anchor!, status: "anchored", tx, anchoredAt: "2026-09-29T01:00:00.000Z" } });
    const rpcFor = () => chain.rpc;
    assert.equal((await checkAnchorOnChain(withTx("good"), rpcFor, [vet.address]))?.ok, true);
    const forged = await checkAnchorOnChain(withTx("forged"), rpcFor, [vet.address]);
    assert.equal(forged?.ok, false);
    assert.match(forged!.detail, /not by vet402's anchor wallet/);
    assert.equal((await checkAnchorOnChain(withTx("failed"), rpcFor, [vet.address]))?.ok, false);
    assert.match((await checkAnchorOnChain(withTx("wrongCount"), rpcFor, [vet.address]))!.detail, /n=4/);
    // with the published constant, the test wallet itself is "another wallet"
    assert.equal((await checkAnchorOnChain(withTx("good"), rpcFor))?.ok, false);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("#7 findDayAnchors: a stranger's memo that shows up in the wallet's history is ignored", async () => {
  const f = await dayFolder();
  try {
    const vet = await generateKeyPairSigner();
    const stranger = await generateKeyPairSigner();
    const chain = fakeChain({
      wallet: vet.address,
      history: [
        { signature: "strangers", memo: f.memo, blockTime: AFTER_DAY }, // a tx that merely names vet402's wallet
        { signature: "payment", memo: "1eeb655cd2f05d58d4ab214f97266009", blockTime: AFTER_DAY - 86400 },
      ],
      txs: { strangers: { feePayer: stranger.address, memo: f.memo } },
    });
    const look = await findDayAnchors(chain.rpc, DAY, vet.address);
    assert.deepEqual(look.found, []);
    assert.equal(look.complete, true);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("#7 findDayAnchors: says incomplete when the history is longer than it may read", async () => {
  const vet = await generateKeyPairSigner();
  const history = Array.from({ length: 2500 }, (_, i) => ({ signature: `s${i}`, memo: null, blockTime: AFTER_DAY + 10_000 - i }));
  const look = await findDayAnchors(fakeChain({ wallet: vet.address, history }).rpc, DAY, vet.address, 2);
  assert.equal(look.complete, false);
});

test("#6 findDayAnchors: a memo naming the day that the RPC cannot return yet makes the lookup incomplete", async () => {
  const f = await dayFolder();
  try {
    const vet = await generateKeyPairSigner();
    const chain = fakeChain({ wallet: vet.address, history: [{ signature: "lagging", memo: f.memo, blockTime: AFTER_DAY }], txs: {} });
    const look = await findDayAnchors(chain.rpc, DAY, vet.address);
    assert.equal(look.complete, false);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// ---------- #6: never twice ----------

test("#6 simulate path: nothing is signed and nothing is sent", async () => {
  const f = await dayFolder();
  try {
    const vet = await generateKeyPairSigner();
    const chain = fakeChain({ wallet: vet.address });
    let loaded = 0;
    const p = await plan(await deps(f.dayDir, chain.rpc, vet, () => loaded++));
    assert.equal(p.plan.simulation.ok, true);
    assert.equal(p.plan.memo, f.memo);
    assert.equal(loaded, 0);
    assert.ok(!chain.calls.includes("sendTransaction"));
    assert.ok(!existsSync(sentFile(f.dayDir)));
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("#6 send: a memo for the same day already on chain from the anchor wallet stops the send before the key is read", async () => {
  const f = await dayFolder();
  try {
    const vet = await generateKeyPairSigner();
    const otherRootMemo = f.memo.replace(/root=0x[0-9a-f]{64}/, `root=0x${"ee".repeat(32)}`);
    const chain = fakeChain({
      wallet: vet.address,
      history: [{ signature: "earlier", memo: otherRootMemo, blockTime: AFTER_DAY }],
      txs: { earlier: { feePayer: vet.address, memo: otherRootMemo } },
    });
    let loaded = 0;
    await assert.rejects(send(await deps(f.dayDir, chain.rpc, vet, () => loaded++)), /already has a memo on chain.*earlier/);
    assert.equal(loaded, 0);
    assert.ok(!chain.calls.includes("sendTransaction"));
    assert.ok(!existsSync(sentFile(f.dayDir)));
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("#6 send: an existing anchor-sent.json stops the send", async () => {
  const f = await dayFolder();
  try {
    const vet = await generateKeyPairSigner();
    writeFileSync(sentFile(f.dayDir), "{}");
    const chain = fakeChain({ wallet: vet.address });
    await assert.rejects(send(await deps(f.dayDir, chain.rpc, vet)), /Run --resume/);
    assert.ok(!chain.calls.includes("sendTransaction"));
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("#6 send: writes anchor-sent.json before sending, then marks every record once it lands", async () => {
  const f = await dayFolder();
  try {
    const vet = await generateKeyPairSigner();
    const chain = fakeChain({ wallet: vet.address, landOnSend: true });
    chain.watchSentFile(() => existsSync(sentFile(f.dayDir)));
    const r = await send(await deps(f.dayDir, chain.rpc, vet));
    assert.equal(r.status, "sent");
    assert.equal(chain.sent.length, 1);
    assert.equal(chain.sentFileWasThere(), true);
    const file = JSON.parse(readFileSync(sentFile(f.dayDir), "utf8")) as SentFile;
    assert.equal(file.status, "sent");
    assert.equal(file.signature, r.signature);
    for (const name of readdirSync(f.dayDir).filter((n) => n.startsWith("obs_"))) {
      const o = JSON.parse(readFileSync(join(f.dayDir, name), "utf8")) as Observation;
      assert.equal(o.anchor!.status, "anchored");
      assert.equal(o.anchor!.tx, r.signature);
      const v = await verifyOffline(o, { expectedSigner: account.address });
      assert.ok(v.signature.ok && v.merkle.ok, "marking does not touch the signed part");
    }
    // a second send for the day is refused twice over: the local file and the chain
    await assert.rejects(send(await deps(f.dayDir, chain.rpc, vet)), /exists/);
    rmSync(sentFile(f.dayDir));
    await assert.rejects(send(await deps(f.dayDir, chain.rpc, vet)), /already anchored|already has a memo/);
    assert.equal(chain.sent.length, 1);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

// ---------- #6: --resume ----------

function sending(dayDir: string, memo: string, root: string, signature: string, lastValidBlockHeight = 1000): void {
  const file: SentFile = { day: DAY, root, memo, signature, status: "sending", lastValidBlockHeight, wire: "AAAA", at: "2026-09-29T01:00:00.000Z" };
  writeFileSync(sentFile(dayDir), `${JSON.stringify(file, null, 2)}\n`);
}

test("#6 resume: a send that landed after the run was cut off becomes 'sent' and the records are marked", async () => {
  const f = await dayFolder();
  try {
    const vet = await generateKeyPairSigner();
    sending(f.dayDir, f.memo, f.root, "landedSig");
    const chain = fakeChain({ wallet: vet.address, history: [{ signature: "landedSig", memo: f.memo, blockTime: AFTER_DAY }], txs: { landedSig: { feePayer: vet.address, memo: f.memo } } });
    const r = await resume(await deps(f.dayDir, chain.rpc, vet), { send: false });
    assert.deepEqual(r, { status: "sent", signature: "landedSig" });
    assert.equal((JSON.parse(readFileSync(sentFile(f.dayDir), "utf8")) as SentFile).status, "sent");
    const o = JSON.parse(readFileSync(join(f.dayDir, `${f.obs[0]!.id}.json`), "utf8")) as Observation;
    assert.equal(o.anchor!.tx, "landedSig");
    assert.ok(!chain.calls.includes("sendTransaction"));
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("#6 resume: still inside its blockhash window, without --send it waits and sends nothing", async () => {
  const f = await dayFolder();
  try {
    const vet = await generateKeyPairSigner();
    sending(f.dayDir, f.memo, f.root, "inFlight", 1000);
    const chain = fakeChain({ wallet: vet.address, height: 990 });
    const r = await resume(await deps(f.dayDir, chain.rpc, vet), { send: false });
    assert.equal(r.status, "waiting");
    assert.ok(!chain.calls.includes("sendTransaction"));
    assert.equal((JSON.parse(readFileSync(sentFile(f.dayDir), "utf8")) as SentFile).status, "sending");
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("#6 resume: expired with no memo on chain is cleared; --resume --send then writes the root once", async () => {
  const f = await dayFolder();
  try {
    const vet = await generateKeyPairSigner();
    sending(f.dayDir, f.memo, f.root, "lost", 1000);
    const chain = fakeChain({ wallet: vet.address, height: 1200, landOnSend: true });
    const cleared = await resume(await deps(f.dayDir, chain.rpc, vet), { send: false });
    assert.equal(cleared.status, "cleared");
    assert.ok(!existsSync(sentFile(f.dayDir)));
    assert.equal(readdirSync(f.dayDir).filter((n) => n.startsWith("anchor-sent.expired-")).length, 1);
    assert.ok(!chain.calls.includes("sendTransaction"));

    sending(f.dayDir, f.memo, f.root, "lost2", 1000);
    const again = await resume(await deps(f.dayDir, chain.rpc, vet), { send: true });
    assert.equal(again.status, "sent");
    assert.equal(chain.sent.length, 1);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("#6 resume: a memo for the day with a different root on chain stops everything", async () => {
  const f = await dayFolder();
  try {
    const vet = await generateKeyPairSigner();
    sending(f.dayDir, f.memo, f.root, "lost", 1000);
    const other = f.memo.replace(/root=0x[0-9a-f]{64}/, `root=0x${"ee".repeat(32)}`);
    const chain = fakeChain({ wallet: vet.address, height: 1200, history: [{ signature: "odd", memo: other, blockTime: AFTER_DAY }], txs: { odd: { feePayer: vet.address, memo: other } } });
    await assert.rejects(resume(await deps(f.dayDir, chain.rpc, vet), { send: true }), /different root/);
    assert.equal((JSON.parse(readFileSync(sentFile(f.dayDir), "utf8")) as SentFile).status, "sending");
    assert.ok(!chain.calls.includes("sendTransaction"));
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("#6 resume: a matching memo on chain with no local file is recorded, not sent again", async () => {
  const f = await dayFolder();
  try {
    const vet = await generateKeyPairSigner();
    const chain = fakeChain({ wallet: vet.address, history: [{ signature: "onlyOnChain", memo: f.memo, blockTime: AFTER_DAY }], txs: { onlyOnChain: { feePayer: vet.address, memo: f.memo } } });
    const r = await resume(await deps(f.dayDir, chain.rpc, vet), { send: true });
    assert.deepEqual(r, { status: "sent", signature: "onlyOnChain" });
    assert.ok(!chain.calls.includes("sendTransaction"));
    assert.equal(dayRoot({ dayDir: f.dayDir, day: DAY } as AnchorDeps, f.obs).root, f.root);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("#4 the CLI refuses --send and --resume from any folder but the fixed receipts folder", () => {
  for (const flag of ["--send", "--resume"]) {
    const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/anchor-receipts.ts", "--day", DAY, "--from", tmpdir(), flag], { cwd: join(import.meta.dirname, ".."), encoding: "utf8" });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /only use .*vet402-solana-receipt\/results\/receipts.*--other-receipts-dir/);
  }
});
